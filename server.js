const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const { run, get, all, nowIso, parseJson, mapDriver, mapDelivery, getDriversById } = require("./db");
const { JWT_SECRET, optionalAuth, requireAuth } = require("./middleware/auth");
const { requireRole } = require("./middleware/roles");
const fcm = require("./lib/fcm");

let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  }
} catch (e) {
  console.warn("Stripe not available:", e.message);
}

let twilioClient = null;
try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
} catch (e) {
  console.warn("Twilio not available:", e.message);
}

const app = express();
const port = process.env.PORT || 3000;
const sseClients = new Set();
let io;

/** Last reported GPS per driver (demo / mobile simulator). */
const livePositions = new Map();
const matchRadii = [2, 5, 10];
const offerTtlSeconds = 15;
const platformFeePct = 0.2;
const payoutMinAmount = 20;

const uploadsDir = path.join(__dirname, "uploads");
const docsDir = path.join(uploadsDir, "driver-docs");
const podDir = path.join(uploadsDir, "pod");
const pickupDir = path.join(uploadsDir, "pickup");
fs.mkdirSync(docsDir, { recursive: true });
fs.mkdirSync(podDir, { recursive: true });
fs.mkdirSync(pickupDir, { recursive: true });

const uploadDocs = multer({ dest: docsDir });
const uploadPod = multer({ dest: podDir });
const uploadPickup = multer({ dest: pickupDir });

if (stripe && process.env.STRIPE_WEBHOOK_SECRET) {
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;
      const deliveryId = pi.metadata?.deliveryId;
      if (deliveryId) {
        const d = fetchDelivery(deliveryId);
        if (d) {
          d.paymentStatus = "captured";
          d.stripePaymentIntentId = pi.id;
          saveDelivery(d);
          broadcastEvent("delivery.updated", { delivery: { id: d.id, paymentStatus: "captured" } });
        }
      }
    }
    return res.json({ received: true });
  });
}

app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));
app.use(optionalAuth);

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

function auditLog(req, action, targetType, targetId, metadata = {}) {
  const actor = req.user || { role: "anonymous", id: "anon" };
  run(
    "INSERT INTO audit_logs (id,actor_role,actor_id,action,target_type,target_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
    `al_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    actor.role || "anonymous",
    actor.id || "anon",
    action,
    targetType,
    targetId,
    JSON.stringify(metadata),
    nowIso()
  );
}

function broadcastEvent(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach((res) => res.write(data));
  if (io) io.emit(type, payload);
}

function fetchDrivers() {
  return all("SELECT * FROM drivers").map(mapDriver);
}

function fetchDeliveries() {
  const driversById = getDriversById();
  return all("SELECT * FROM deliveries ORDER BY created_at DESC").map((row) => mapDelivery(row, driversById));
}

function fetchDelivery(id) {
  const driversById = getDriversById();
  const row = get("SELECT * FROM deliveries WHERE id = ?", id);
  return mapDelivery(row, driversById);
}

function saveDelivery(delivery) {
  run(
    `UPDATE deliveries SET
      driver_id=?, matching_radius_km=?, status=?, pin_verified=?, pin_attempts=?, payout_credited=?, history_json=?,
      pod_photo_path=?, pod_signature=?, pod_note=?, pickup_photo_path=?, recipient_phone=?, payment_status=?, stripe_payment_intent_id=?, updated_at=?
    WHERE id=?`,
    delivery.driver?.id || null,
    delivery.matchingRadiusKm ?? null,
    delivery.status,
    delivery.pinVerified ? 1 : 0,
    delivery.pinAttempts || 0,
    delivery.payoutCredited ? 1 : 0,
    JSON.stringify(delivery.history || []),
    delivery.podPhotoPath || "",
    delivery.podSignature || "",
    delivery.podNote || "",
    delivery.pickupPhotoPath || "",
    delivery.recipientPhone || "",
    delivery.paymentStatus || "unpaid",
    delivery.stripePaymentIntentId || "",
    nowIso(),
    delivery.id
  );
}

function sendRecipientSms(delivery, template) {
  const to = String(delivery.recipientPhone || "").replace(/\s+/g, "");
  if (!to || !twilioClient || !process.env.TWILIO_FROM_NUMBER) return Promise.resolve({ skipped: true });
  const body =
    template === "matched"
      ? `SwiftDrop: courier assigned for order ${delivery.id}. PIN for handoff: ${delivery.securityPin}. Track in the app.`
      : template === "delivered"
        ? `SwiftDrop: order ${delivery.id} was delivered. Thanks for using SwiftDrop.`
        : `SwiftDrop update for order ${delivery.id}: ${String(delivery.status)}.`;
  return twilioClient.messages.create({
    from: process.env.TWILIO_FROM_NUMBER,
    to,
    body
  });
}

function recomputeDriverRating(driverId) {
  if (!driverId) return;
  const row = get(
    `SELECT AVG(r.score) AS avgScore, COUNT(*) AS c FROM delivery_ratings r
     JOIN deliveries d ON d.id = r.delivery_id
     WHERE r.target = 'driver' AND d.driver_id = ?`,
    driverId
  );
  if (!row || !row.c) return;
  const r = Number(Number(row.avgScore).toFixed(2));
  run("UPDATE drivers SET rating=? WHERE id=?", r, driverId);
  broadcastEvent("driver.updated", { id: driverId, rating: r });
}

function getOffer(deliveryId) {
  const row = get("SELECT * FROM delivery_offers WHERE delivery_id = ?", deliveryId);
  if (!row) return null;
  return {
    deliveryId: row.delivery_id,
    radiusIndex: row.radius_index,
    candidateDriverIds: parseJson(row.candidate_driver_ids_json, []),
    declinedDriverIds: parseJson(row.declined_driver_ids_json, []),
    expiresAt: row.expires_at
  };
}

function setOffer(offer) {
  run(
    `INSERT INTO delivery_offers (delivery_id,radius_index,candidate_driver_ids_json,declined_driver_ids_json,expires_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(delivery_id) DO UPDATE SET
      radius_index=excluded.radius_index,
      candidate_driver_ids_json=excluded.candidate_driver_ids_json,
      declined_driver_ids_json=excluded.declined_driver_ids_json,
      expires_at=excluded.expires_at`,
    offer.deliveryId,
    offer.radiusIndex,
    JSON.stringify(offer.candidateDriverIds),
    JSON.stringify(offer.declinedDriverIds),
    offer.expiresAt
  );
}

function deleteOffer(deliveryId) {
  run("DELETE FROM delivery_offers WHERE delivery_id = ?", deliveryId);
}

function resolveSurge(pickupAddress = "") {
  const lower = String(pickupAddress).toLowerCase();
  const zones = all("SELECT * FROM surge_zones").map((z) => ({
    name: z.name,
    keywords: parseJson(z.keywords_json, []),
    multiplier: z.multiplier
  }));
  const zone = zones.find((z) => z.keywords.some((kw) => lower.includes(String(kw).toLowerCase())));
  if (!zone) return { zone: "Standard", multiplier: 1 };
  return { zone: zone.name, multiplier: zone.multiplier };
}

function applyPromo(totalBeforePromo, promoCode = "") {
  const promoCodes = {
    WELCOME10: { type: "percent", value: 10 },
    FAST5: { type: "flat", value: 5 },
    VILNIUS15: { type: "percent", value: 15 }
  };
  if (!promoCode) return { promoCode: "", promoDiscount: 0 };
  const code = String(promoCode).toUpperCase().trim();
  const promo = promoCodes[code];
  if (!promo) return { promoCode: code, promoDiscount: 0 };
  const rawDiscount = promo.type === "percent" ? (totalBeforePromo * promo.value) / 100 : promo.value;
  const promoDiscount = Number(Math.min(rawDiscount, totalBeforePromo - 2).toFixed(2));
  return { promoCode: code, promoDiscount: Math.max(0, promoDiscount) };
}

function estimateFare({ distanceKm, size, urgent, courierType, stopCount, deliveryMode, pickupAddress, promoCode }) {
  const courierTypeMultiplier = { bike: 1, car: 1.25, van: 1.55, truck: 1.95 };
  const base = 4;
  const distancePart = Number(distanceKm || 3) * 1.6;
  const sizeMultiplier = size === "large" ? 1.4 : size === "medium" ? 1.15 : 1;
  const courierMultiplier = courierTypeMultiplier[courierType] || 1;
  const urgentFee = urgent ? 2.5 : 0;
  const stopFee = Math.max(0, Number(stopCount || 1) - 1) * 1.2;
  const scheduledDiscount = deliveryMode === "scheduled" ? -1.25 : 0;
  const surge = resolveSurge(pickupAddress);
  const distanceWithMultipliers = distancePart * sizeMultiplier * courierMultiplier * surge.multiplier;
  const totalBeforePromo = Number(Math.max(3.5, base + distanceWithMultipliers + urgentFee + stopFee + scheduledDiscount).toFixed(2));
  const promo = applyPromo(totalBeforePromo, promoCode);
  const total = Number(Math.max(2.5, totalBeforePromo - promo.promoDiscount).toFixed(2));
  return {
    base,
    distancePart: Number(distanceWithMultipliers.toFixed(2)),
    urgentFee,
    stopFee: Number(stopFee.toFixed(2)),
    scheduledDiscount: Number(scheduledDiscount.toFixed(2)),
    surgeZone: surge.zone,
    surgeMultiplier: surge.multiplier,
    promoCode: promo.promoCode,
    promoDiscount: promo.promoDiscount,
    totalBeforePromo,
    total
  };
}

function estimateEtaMinutes(delivery) {
  const baseByStatus = {
    Requested: 18,
    Matching: 15,
    Matched: 12,
    "Picked Up": 9,
    "In Transit": 6,
    Delivered: 0,
    Cancelled: 0
  };
  const vehicleFactor = { bike: 1, car: 0.9, van: 1.05, truck: 1.2 };
  const stopPenalty = Math.max(0, Number(delivery.stopCount || 1) - 1) * 2;
  const distPenalty = Number(delivery.distanceKm || 0) * 0.4;
  const statusBase = baseByStatus[delivery.status] ?? 10;
  const eta = Math.round((statusBase + stopPenalty + distPenalty) * (vehicleFactor[delivery.courierType] || 1));
  return Math.max(0, eta);
}

function keywordScore(text, keywordList) {
  const lower = String(text || "").toLowerCase();
  return keywordList.reduce((acc, kw) => acc + (lower.includes(kw) ? 1 : 0), 0);
}

function optimizeStops(pickupAddress, dropoffAddress, stopAddresses = []) {
  const points = stopAddresses
    .filter(Boolean)
    .map((address) => ({
      address,
      score:
        keywordScore(address, ["gedimino", "senamiestis", "old town"]) * 3 +
        keywordScore(address, ["ozo", "konstitucijos", "europa"]) * 2 +
        keywordScore(address, ["airport", "oro uostas", "rodunios"]) * 1
    }))
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))
    .map((p) => p.address);
  return {
    pickupAddress,
    optimizedStops: points,
    dropoffAddress,
    routePreview: [pickupAddress, ...points, dropoffAddress].filter(Boolean)
  };
}

function buildHeatmap() {
  const zones = all("SELECT * FROM surge_zones");
  const deliveries = fetchDeliveries();
  const drivers = fetchDrivers();
  const fallbackOnline = drivers.filter((d) => d.online).length || 1;
  return zones.map((zone) => {
    const keywords = parseJson(zone.keywords_json, []);
    const activeOrders = deliveries.filter(
      (d) => !["Delivered", "Cancelled"].includes(d.status) && keywords.some((kw) => String(d.pickupAddress || "").toLowerCase().includes(String(kw).toLowerCase()))
    ).length;
    const onlineDrivers = drivers.filter((d) => d.online && keywords.some((kw) => String(d.vehicle || "").toLowerCase().includes(String(kw).toLowerCase()))).length;
    return {
      zone: zone.name,
      activeOrders,
      onlineDrivers: onlineDrivers || fallbackOnline,
      pressure: activeOrders > (onlineDrivers || fallbackOnline) ? "high" : activeOrders > 0 ? "medium" : "low"
    };
  });
}

function scoreDriverForDelivery(driver, delivery) {
  const acceptanceRate = driver.offersSeen ? driver.offersAccepted / driver.offersSeen : 0.6;
  const etaEstimate = Math.max(1, Number(driver.distanceKm || 1) * 3);
  return (
    100 -
    etaEstimate * 3 +
    Number(driver.rating || 0) * 10 +
    acceptanceRate * 15 -
    Number(driver.currentWorkload || 0) * 6
  );
}

function updateDriverCounters(driverId, updates = {}) {
  const row = get("SELECT * FROM drivers WHERE id = ?", driverId);
  if (!row) return;
  run(
    `UPDATE drivers SET
      online=?, wallet_balance=?, completed_jobs=?, offers_seen=?, offers_accepted=?, current_workload=?,
      bank_holder_name=?, bank_name=?, iban=?, swift_bic=?
     WHERE id=?`,
    updates.online ?? row.online,
    updates.walletBalance ?? row.wallet_balance,
    updates.completedJobs ?? row.completed_jobs,
    updates.offersSeen ?? row.offers_seen,
    updates.offersAccepted ?? row.offers_accepted,
    updates.currentWorkload ?? row.current_workload,
    updates.bankHolderName ?? row.bank_holder_name,
    updates.bankName ?? row.bank_name,
    updates.iban ?? row.iban,
    updates.swiftBic ?? row.swift_bic,
    driverId
  );
}

function createOffer(delivery, startRadiusIndex = 0, excludedDriverIds = []) {
  const drivers = fetchDrivers();
  let radiusIndex = startRadiusIndex;
  while (radiusIndex < matchRadii.length) {
    const radius = matchRadii[radiusIndex];
    const candidates = drivers
      .filter(
        (d) =>
          d.online &&
          d.courierType === delivery.courierType &&
          d.distanceKm <= radius &&
          !excludedDriverIds.includes(d.id)
      )
      .sort((a, b) => scoreDriverForDelivery(b, delivery) - scoreDriverForDelivery(a, delivery));
    if (candidates.length) {
      candidates.forEach((driver) => {
        updateDriverCounters(driver.id, { offersSeen: driver.offersSeen + 1 });
      });
      setOffer({
        deliveryId: delivery.id,
        radiusIndex,
        candidateDriverIds: candidates.map((d) => d.id),
        declinedDriverIds: [],
        expiresAt: Date.now() + offerTtlSeconds * 1000
      });
      delivery.status = "Matching";
      delivery.matchingRadiusKm = radius;
      delivery.history.push({ status: `Matching (${radius}km radius)`, at: nowIso() });
      saveDelivery(delivery);
      broadcastEvent("delivery.updated", { delivery: { id: delivery.id, status: delivery.status } });
      return true;
    }
    radiusIndex += 1;
  }
  delivery.status = "Cancelled";
  delivery.history.push({ status: "Cancelled (no driver available)", at: nowIso() });
  saveDelivery(delivery);
  broadcastEvent("delivery.updated", { delivery: { id: delivery.id, status: delivery.status } });
  return false;
}

function advanceExpiredOffer(deliveryId) {
  const offer = getOffer(deliveryId);
  if (!offer) return;
  if (Date.now() <= offer.expiresAt) return;
  const delivery = fetchDelivery(deliveryId);
  if (!delivery || delivery.status !== "Matching") {
    deleteOffer(deliveryId);
    return;
  }
  const excluded = [...new Set([...offer.candidateDriverIds, ...offer.declinedDriverIds])];
  deleteOffer(deliveryId);
  createOffer(delivery, offer.radiusIndex + 1, excluded);
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/login", authLimiter, (req, res) => {
  const { email = "", password = "" } = req.body || {};
  const user = get("SELECT * FROM users WHERE lower(email) = ?", String(email).toLowerCase().trim());
  if (!user) return res.status(401).json({ error: "Invalid credentials." });
  if (!bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ error: "Invalid credentials." });
  }
  const token = jwt.sign({ id: user.id, role: user.role, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "2d" });
  return res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
});

app.get("/api/auth/demo-users", (_req, res) => {
  res.json([
    { email: "sender@swiftdrop.app", password: "demo123", role: "sender" },
    { email: "driver@swiftdrop.app", password: "demo123", role: "driver" },
    { email: "admin@swiftdrop.app", password: "demo123", role: "admin" }
  ]);
});

app.post("/api/auth/signup", authLimiter, (req, res) => {
  const { name = "", email = "", password = "", role = "sender" } = req.body || {};
  const cleanEmail = String(email).toLowerCase().trim();
  const cleanName = String(name).trim();
  const cleanPassword = String(password).trim();
  const allowedRoles = new Set(["sender", "driver", "admin"]);
  if (!cleanName || !cleanEmail || !cleanPassword) return res.status(400).json({ error: "Name, email, and password are required." });
  if (!allowedRoles.has(role)) return res.status(400).json({ error: "Invalid role selected." });
  if (get("SELECT id FROM users WHERE lower(email)=?", cleanEmail)) return res.status(409).json({ error: "Email already exists." });
  const id = `u_${Date.now()}`;
  run("INSERT INTO users (id,email,password_hash,role,name,created_at) VALUES (?,?,?,?,?,?)", id, cleanEmail, bcrypt.hashSync(cleanPassword, 10), role, cleanName, nowIso());
  if (role === "driver") {
    const driverId = `d_${Date.now()}`;
    run(
      "INSERT INTO drivers (id,name,vehicle,courier_type,rating,online,distance_km,wallet_balance,completed_jobs,offers_seen,offers_accepted,current_workload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      driverId,
      cleanName,
      "Bike",
      "bike",
      4.8,
      1,
      4.5,
      0,
      0,
      0,
      0,
      0
    );
  }
  const token = jwt.sign({ id, role, email: cleanEmail, name: cleanName }, JWT_SECRET, { expiresIn: "2d" });
  return res.status(201).json({ token, user: { id, email: cleanEmail, role, name: cleanName } });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  sseClients.add(res);
  res.write(`event: connected\ndata: {"ok":true}\n\n`);
  req.on("close", () => {
    sseClients.delete(res);
    res.end();
  });
});

app.get("/api/drivers", (_req, res) => {
  res.json(fetchDrivers());
});

app.get("/api/deliveries", (_req, res) => {
  const deliveries = fetchDeliveries().map((d) => ({ ...d, etaMinutes: estimateEtaMinutes(d) }));
  res.json(deliveries);
});

app.get("/api/stats", (_req, res) => {
  fetchDeliveries().forEach((d) => advanceExpiredOffer(d.id));
  const deliveries = fetchDeliveries();
  const active = deliveries.filter((d) => !["Delivered", "Cancelled"].includes(d.status)).length;
  const completed = deliveries.filter((d) => d.status === "Delivered").length;
  const urgent = deliveries.filter((d) => d.urgent).length;
  const avgFare = deliveries.length ? Number((deliveries.reduce((sum, d) => sum + d.fare, 0) / deliveries.length).toFixed(2)) : 0;
  const grossRevenue = Number(deliveries.filter((d) => d.status === "Delivered").reduce((sum, d) => sum + d.fare, 0).toFixed(2));
  const platformRevenue = Number((grossRevenue * platformFeePct).toFixed(2));
  res.json({ active, completed, urgent, total: deliveries.length, avgFare, grossRevenue, platformRevenue });
});

app.post("/api/route/optimize-stops", (req, res) => {
  const { pickupAddress = "", dropoffAddress = "", stopAddresses = [] } = req.body || {};
  return res.json(optimizeStops(pickupAddress, dropoffAddress, stopAddresses));
});

app.get("/api/dispatch/heatmap", (_req, res) => {
  res.json({ zones: buildHeatmap(), generatedAt: nowIso() });
});

app.post("/api/pricing/preview", (req, res) => {
  const { size = "small", courierType = "bike", deliveryMode = "asap", stopCount = 1, stopAddresses = [], urgent = false, distanceKm = 3, pickupAddress = "", promoCode = "" } = req.body || {};
  const fareBreakdown = estimateFare({
    distanceKm,
    size,
    urgent,
    courierType,
    stopCount: Array.isArray(stopAddresses) && stopAddresses.length ? stopAddresses.length : stopCount,
    deliveryMode,
    pickupAddress,
    promoCode
  });
  res.json(fareBreakdown);
});

app.post("/api/deliveries", (req, res) => {
  const {
    senderName,
    pickupAddress,
    dropoffAddress,
    itemCategory,
    recipientName = "",
    recipientPhone = "",
    size = "small",
    courierType = "bike",
    deliveryMode = "asap",
    scheduledAt = "",
    stopCount = 1,
    stopAddresses = [],
    urgent = false,
    paymentType = "card",
    distanceKm = 3,
    promoCode = ""
  } = req.body || {};
  if (!senderName || !pickupAddress || !dropoffAddress || !itemCategory) return res.status(400).json({ error: "Missing required fields." });
  const fareBreakdown = estimateFare({
    distanceKm,
    size,
    urgent,
    courierType,
    stopCount: Array.isArray(stopAddresses) && stopAddresses.length ? stopAddresses.length : stopCount,
    deliveryMode,
    pickupAddress,
    promoCode
  });
  const id = `sd-${Date.now()}`;
  const createdAt = nowIso();
  const securityPin = String(Math.floor(1000 + Math.random() * 9000));
  const history = [{ status: "Requested", at: createdAt }];
  const cleanPhone = String(recipientPhone).trim();
  run(
    `INSERT INTO deliveries (
      id,sender_name,pickup_address,dropoff_address,item_category,recipient_name,size,courier_type,delivery_mode,scheduled_at,
      stop_count,stop_addresses_json,urgent,payment_type,promo_code,distance_km,fare_breakdown_json,fare,driver_id,matching_radius_km,status,
      security_pin,pin_verified,pin_attempts,payout_credited,history_json,created_at,updated_at,recipient_phone
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    senderName,
    pickupAddress,
    dropoffAddress,
    itemCategory,
    recipientName,
    size,
    courierType,
    deliveryMode,
    deliveryMode === "scheduled" ? scheduledAt : "",
    Number(Array.isArray(stopAddresses) && stopAddresses.length ? stopAddresses.length : stopCount),
    JSON.stringify(Array.isArray(stopAddresses) ? stopAddresses.filter(Boolean) : []),
    urgent ? 1 : 0,
    paymentType,
    fareBreakdown.promoCode || "",
    Number(distanceKm),
    JSON.stringify(fareBreakdown),
    fareBreakdown.total,
    null,
    null,
    "Requested",
    securityPin,
    0,
    0,
    0,
    JSON.stringify(history),
    createdAt,
    createdAt,
    cleanPhone
  );
  const delivery = fetchDelivery(id);
  createOffer(delivery, 0, []);
  broadcastEvent("delivery.created", { id, status: "Matching" });
  return res.status(201).json(fetchDelivery(id));
});

app.get("/api/drivers/:driverId/dashboard", (req, res) => {
  const { driverId } = req.params;
  const driver = mapDriver(get("SELECT * FROM drivers WHERE id = ?", driverId));
  if (!driver) return res.status(404).json({ error: "Driver not found." });
  fetchDeliveries().forEach((delivery) => advanceExpiredOffer(delivery.id));
  const activeJob = fetchDeliveries().find((d) => d.driver?.id === driverId && !["Delivered", "Cancelled"].includes(d.status));
  const offers = fetchDeliveries()
    .filter((d) => d.status === "Matching")
    .map((delivery) => {
      const offer = getOffer(delivery.id);
      if (!offer) return null;
      if (!offer.candidateDriverIds.includes(driverId) || offer.declinedDriverIds.includes(driverId)) return null;
      return {
        deliveryId: delivery.id,
        senderName: delivery.senderName,
        pickupAddress: delivery.pickupAddress,
        dropoffAddress: delivery.dropoffAddress,
        fare: delivery.fare,
        itemCategory: delivery.itemCategory,
        courierType: delivery.courierType,
        distanceKm: delivery.distanceKm,
        expiresInSeconds: Math.max(0, Math.ceil((offer.expiresAt - Date.now()) / 1000))
      };
    })
    .filter(Boolean);
  const acceptanceRate = driver.offersSeen ? Number(((driver.offersAccepted / driver.offersSeen) * 100).toFixed(1)) : 0;
  const payouts = all("SELECT * FROM payout_requests WHERE driver_id = ? ORDER BY requested_at DESC LIMIT 5", driverId);
  return res.json({
    driver,
    wallet: {
      balance: Number(driver.walletBalance.toFixed(2)),
      completedJobs: driver.completedJobs,
      acceptanceRate,
      estimatedPlatformFeePct: platformFeePct * 100
    },
    payout: {
      minAmount: payoutMinAmount,
      lastRequests: payouts
    },
    activeJob: activeJob ? { ...activeJob, etaMinutes: estimateEtaMinutes(activeJob) } : null,
    offers
  });
});

app.get("/api/drivers/:driverId/bank-details", (req, res) => {
  const driver = mapDriver(get("SELECT * FROM drivers WHERE id = ?", req.params.driverId));
  if (!driver) return res.status(404).json({ error: "Driver not found." });
  return res.json({ driverId: driver.id, bankDetails: driver.bankDetails });
});

app.patch("/api/drivers/:driverId/bank-details", (req, res) => {
  const driver = mapDriver(get("SELECT * FROM drivers WHERE id = ?", req.params.driverId));
  if (!driver) return res.status(404).json({ error: "Driver not found." });
  const { holderName = "", bankName = "", iban = "", swiftBic = "" } = req.body || {};
  const clean = {
    holderName: String(holderName).trim(),
    bankName: String(bankName).trim(),
    iban: String(iban).trim().toUpperCase(),
    swiftBic: String(swiftBic).trim().toUpperCase()
  };
  if (!clean.holderName || !clean.bankName || !clean.iban) return res.status(400).json({ error: "Account holder, bank name, and IBAN are required." });
  if (clean.iban.length < 12 || clean.iban.length > 34) return res.status(400).json({ error: "IBAN length looks invalid." });
  if (clean.swiftBic && (clean.swiftBic.length < 8 || clean.swiftBic.length > 11)) return res.status(400).json({ error: "SWIFT/BIC must be 8 to 11 characters." });
  updateDriverCounters(driver.id, {
    bankHolderName: clean.holderName,
    bankName: clean.bankName,
    iban: clean.iban,
    swiftBic: clean.swiftBic
  });
  broadcastEvent("driver.updated", { id: driver.id, bankDetailsUpdated: true });
  return res.json({ ok: true, driverId: driver.id, bankDetails: clean });
});

app.post("/api/drivers/:driverId/payout-requests", (req, res) => {
  const driver = mapDriver(get("SELECT * FROM drivers WHERE id = ?", req.params.driverId));
  if (!driver) return res.status(404).json({ error: "Driver not found." });
  if (!driver.bankDetails.iban) return res.status(400).json({ error: "Add bank details before requesting payout." });
  const pending = get("SELECT id FROM payout_requests WHERE driver_id=? AND status='pending'", driver.id);
  if (pending) return res.status(409).json({ error: "Pending payout request already exists." });
  const amount = Number(req.body?.amount || driver.walletBalance);
  if (amount < payoutMinAmount) return res.status(400).json({ error: `Minimum payout is €${payoutMinAmount}.` });
  if (amount > driver.walletBalance) return res.status(400).json({ error: "Requested amount exceeds wallet balance." });
  const id = `po_${Date.now()}`;
  run("INSERT INTO payout_requests (id,driver_id,amount,status,requested_at,reviewed_at,admin_note) VALUES (?,?,?,?,?,?,?)", id, driver.id, amount, "pending", nowIso(), "", "");
  auditLog(req, "payout.requested", "payout", id, { driverId: driver.id, amount });
  broadcastEvent("driver.updated", { id: driver.id, payoutRequested: true });
  return res.status(201).json({ id, driverId: driver.id, amount, status: "pending" });
});

app.get("/api/drivers/:driverId/payout-requests", (req, res) => {
  const rows = all("SELECT * FROM payout_requests WHERE driver_id=? ORDER BY requested_at DESC", req.params.driverId);
  res.json(rows);
});

app.get("/api/admin/payout-requests", requireAuth, requireRole("admin"), (_req, res) => {
  res.json(all("SELECT * FROM payout_requests ORDER BY requested_at DESC"));
});

app.patch("/api/admin/payout-requests/:id", requireAuth, requireRole("admin"), (req, res) => {
  const row = get("SELECT * FROM payout_requests WHERE id = ?", req.params.id);
  if (!row) return res.status(404).json({ error: "Payout request not found." });
  if (row.status !== "pending") return res.status(409).json({ error: "Payout request already reviewed." });
  const { status, note = "" } = req.body || {};
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid payout status." });
  run("UPDATE payout_requests SET status=?, reviewed_at=?, admin_note=? WHERE id=?", status, nowIso(), String(note), row.id);
  if (status === "approved") {
    const driver = mapDriver(get("SELECT * FROM drivers WHERE id = ?", row.driver_id));
    updateDriverCounters(driver.id, { walletBalance: Math.max(0, Number((driver.walletBalance - row.amount).toFixed(2))) });
  }
  auditLog(req, "payout.reviewed", "payout", row.id, { status, note });
  return res.json(get("SELECT * FROM payout_requests WHERE id = ?", row.id));
});

app.post("/api/drivers/:driverId/documents", uploadDocs.single("file"), (req, res) => {
  const driver = mapDriver(get("SELECT * FROM drivers WHERE id = ?", req.params.driverId));
  if (!driver) return res.status(404).json({ error: "Driver not found." });
  if (!req.file) return res.status(400).json({ error: "Document file is required." });
  const docType = String(req.body?.docType || "other").trim().toLowerCase();
  const id = `doc_${Date.now()}`;
  run(
    "INSERT INTO driver_documents (id,driver_id,doc_type,file_path,status,uploaded_at,reviewed_at,review_note) VALUES (?,?,?,?,?,?,?,?)",
    id,
    driver.id,
    docType,
    `/uploads/driver-docs/${path.basename(req.file.path)}`,
    "pending",
    nowIso(),
    "",
    ""
  );
  auditLog(req, "driver.document.uploaded", "driver_document", id, { driverId: driver.id, docType });
  return res.status(201).json(get("SELECT * FROM driver_documents WHERE id=?", id));
});

app.get("/api/drivers/:driverId/documents", (req, res) => {
  res.json(all("SELECT * FROM driver_documents WHERE driver_id=? ORDER BY uploaded_at DESC", req.params.driverId));
});

app.get("/api/admin/driver-documents", requireAuth, requireRole("admin"), (_req, res) => {
  res.json(all("SELECT * FROM driver_documents ORDER BY uploaded_at DESC"));
});

app.patch("/api/admin/driver-documents/:id", requireAuth, requireRole("admin"), (req, res) => {
  const row = get("SELECT * FROM driver_documents WHERE id=?", req.params.id);
  if (!row) return res.status(404).json({ error: "Document not found." });
  const { status, note = "" } = req.body || {};
  if (!["approved", "rejected", "pending"].includes(status)) return res.status(400).json({ error: "Invalid status." });
  run("UPDATE driver_documents SET status=?, reviewed_at=?, review_note=? WHERE id=?", status, nowIso(), String(note), row.id);
  auditLog(req, "driver.document.reviewed", "driver_document", row.id, { status, note });
  return res.json(get("SELECT * FROM driver_documents WHERE id=?", row.id));
});

app.post("/api/deliveries/:id/pod", uploadPod.single("photo"), (req, res) => {
  const delivery = fetchDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  const signature = String(req.body?.signature || "").trim();
  const note = String(req.body?.note || "").trim();
  if (!req.file && !signature && !note) return res.status(400).json({ error: "At least photo, signature, or note is required." });
  delivery.podPhotoPath = req.file ? `/uploads/pod/${path.basename(req.file.path)}` : delivery.podPhotoPath;
  delivery.podSignature = signature || delivery.podSignature;
  delivery.podNote = note || delivery.podNote;
  delivery.history.push({ status: "Proof of delivery captured", at: nowIso() });
  saveDelivery(delivery);
  broadcastEvent("delivery.updated", { delivery: { id: delivery.id, status: delivery.status, podCaptured: true } });
  return res.json(fetchDelivery(delivery.id));
});

app.post("/api/deliveries/:id/verify-pin", (req, res) => {
  const delivery = fetchDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  if (!["Matched", "Picked Up", "In Transit"].includes(delivery.status)) return res.status(409).json({ error: "PIN verification not available at this stage." });
  const pin = String(req.body?.pin || "").trim();
  delivery.pinAttempts += 1;
  if (pin !== String(delivery.securityPin)) {
    delivery.history.push({ status: "PIN verification failed", at: nowIso() });
    saveDelivery(delivery);
    return res.status(400).json({ error: "Invalid PIN.", pinVerified: false, pinAttempts: delivery.pinAttempts });
  }
  delivery.pinVerified = true;
  delivery.history.push({ status: "Recipient PIN verified", at: nowIso() });
  saveDelivery(delivery);
  broadcastEvent("delivery.updated", { delivery: { id: delivery.id, status: delivery.status, pinVerified: true } });
  return res.json({ ok: true, pinVerified: true });
});

app.patch("/api/drivers/:driverId/online", (req, res) => {
  const driver = mapDriver(get("SELECT * FROM drivers WHERE id = ?", req.params.driverId));
  if (!driver) return res.status(404).json({ error: "Driver not found." });
  const online = Boolean(req.body?.online);
  updateDriverCounters(driver.id, { online: online ? 1 : 0 });
  broadcastEvent("driver.updated", { id: driver.id, online });
  return res.json(mapDriver(get("SELECT * FROM drivers WHERE id = ?", driver.id)));
});

app.post("/api/drivers/:driverId/offers/:deliveryId/accept", (req, res) => {
  const driver = mapDriver(get("SELECT * FROM drivers WHERE id = ?", req.params.driverId));
  if (!driver) return res.status(404).json({ error: "Driver not found." });
  if (!driver.online) return res.status(400).json({ error: "Driver is offline." });
  advanceExpiredOffer(req.params.deliveryId);
  const delivery = fetchDelivery(req.params.deliveryId);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  if (delivery.status !== "Matching") return res.status(409).json({ error: "Offer is no longer active." });
  const offer = getOffer(delivery.id);
  if (!offer) return res.status(409).json({ error: "Offer expired." });
  if (!offer.candidateDriverIds.includes(driver.id) || offer.declinedDriverIds.includes(driver.id)) {
    return res.status(403).json({ error: "This offer is not available for this driver." });
  }
  delivery.driver = driver;
  delivery.status = "Matched";
  delivery.history.push({ status: `Matched by ${driver.name}`, at: nowIso() });
  saveDelivery(delivery);
  deleteOffer(delivery.id);
  updateDriverCounters(driver.id, {
    offersAccepted: driver.offersAccepted + 1,
    currentWorkload: driver.currentWorkload + 1
  });
  broadcastEvent("delivery.updated", { delivery: { id: delivery.id, status: delivery.status } });
  const fresh = fetchDelivery(delivery.id);
  sendRecipientSms(fresh, "matched").catch(() => {});
  return res.json(fetchDelivery(delivery.id));
});

app.post("/api/drivers/:driverId/offers/:deliveryId/decline", (req, res) => {
  const driver = mapDriver(get("SELECT * FROM drivers WHERE id = ?", req.params.driverId));
  if (!driver) return res.status(404).json({ error: "Driver not found." });
  advanceExpiredOffer(req.params.deliveryId);
  const delivery = fetchDelivery(req.params.deliveryId);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  if (delivery.status !== "Matching") return res.status(409).json({ error: "Offer is no longer active." });
  const offer = getOffer(delivery.id);
  if (!offer) return res.status(409).json({ error: "Offer expired." });
  if (!offer.candidateDriverIds.includes(driver.id)) return res.status(403).json({ error: "This offer is not available for this driver." });
  if (!offer.declinedDriverIds.includes(driver.id)) offer.declinedDriverIds.push(driver.id);
  const everyoneDeclined = offer.candidateDriverIds.every((id) => offer.declinedDriverIds.includes(id));
  if (everyoneDeclined) {
    deleteOffer(delivery.id);
    createOffer(delivery, offer.radiusIndex + 1, [...new Set([...offer.candidateDriverIds, ...offer.declinedDriverIds])]);
  } else {
    setOffer(offer);
  }
  broadcastEvent("delivery.updated", { delivery: { id: delivery.id, status: delivery.status } });
  return res.json({ ok: true });
});

app.patch("/api/deliveries/:id/status", (req, res) => {
  const delivery = fetchDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  const status = String(req.body?.status || "");
  const allowed = ["Requested", "Matched", "Picked Up", "In Transit", "Delivered", "Cancelled"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status value." });
  if (status === "Delivered" && !delivery.pinVerified) {
    return res.status(409).json({ error: "Recipient PIN must be verified before Delivered status." });
  }
  delivery.status = status;
  delivery.history.push({ status, at: nowIso() });
  if (status === "Delivered" && delivery.driver?.id && !delivery.payoutCredited) {
    const payout = Number((delivery.fare * (1 - platformFeePct)).toFixed(2));
    const driver = mapDriver(get("SELECT * FROM drivers WHERE id = ?", delivery.driver.id));
    if (driver) {
      updateDriverCounters(driver.id, {
        walletBalance: Number((driver.walletBalance + payout).toFixed(2)),
        completedJobs: driver.completedJobs + 1,
        currentWorkload: Math.max(0, driver.currentWorkload - 1)
      });
      delivery.history.push({ status: `Driver payout credited: €${payout.toFixed(2)}`, at: nowIso() });
    }
    delivery.payoutCredited = true;
  }
  saveDelivery(delivery);
  broadcastEvent("delivery.updated", { delivery: { id: delivery.id, status: delivery.status } });
  if (status === "Delivered") {
    sendRecipientSms(fetchDelivery(delivery.id), "delivered").catch(() => {});
  }
  return res.json(fetchDelivery(delivery.id));
});

app.get("/api/chat/:deliveryId", (req, res) => {
  const rows = all("SELECT * FROM chat_messages WHERE delivery_id = ? ORDER BY created_at ASC", req.params.deliveryId);
  res.json(rows);
});

app.post("/api/chat/:deliveryId", (req, res) => {
  const delivery = fetchDelivery(req.params.deliveryId);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  const message = String(req.body?.message || "").trim();
  const senderRole = String(req.body?.senderRole || "sender");
  const senderName = String(req.body?.senderName || "User");
  if (!message) return res.status(400).json({ error: "Message is required." });
  const id = `cm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  run("INSERT INTO chat_messages (id,delivery_id,sender_role,sender_name,message,created_at) VALUES (?,?,?,?,?,?)", id, delivery.id, senderRole, senderName, message, nowIso());
  const row = get("SELECT * FROM chat_messages WHERE id = ?", id);
  broadcastEvent("chat.updated", { deliveryId: delivery.id, message: row });
  return res.status(201).json(row);
});

app.get("/api/support/tickets", (req, res) => {
  const rows = all("SELECT * FROM support_tickets ORDER BY created_at DESC");
  res.json(rows);
});

app.post("/api/support/tickets", (req, res) => {
  const { deliveryId = "", createdByRole = "sender", category = "general", severity = "medium", title = "", description = "" } = req.body || {};
  if (!title || !description) return res.status(400).json({ error: "Title and description are required." });
  const id = `st_${Date.now()}`;
  run(
    "INSERT INTO support_tickets (id,delivery_id,created_by_role,category,severity,status,title,description,created_at,resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    id,
    deliveryId,
    createdByRole,
    category,
    severity,
    "open",
    title,
    description,
    nowIso(),
    ""
  );
  auditLog(req, "support.ticket.created", "support_ticket", id, { category, severity });
  return res.status(201).json(get("SELECT * FROM support_tickets WHERE id=?", id));
});

app.get("/api/support/tickets/:id/messages", (req, res) => {
  res.json(all("SELECT * FROM support_messages WHERE ticket_id=? ORDER BY created_at ASC", req.params.id));
});

app.post("/api/support/tickets/:id/messages", (req, res) => {
  const ticket = get("SELECT * FROM support_tickets WHERE id=?", req.params.id);
  if (!ticket) return res.status(404).json({ error: "Support ticket not found." });
  const message = String(req.body?.message || "").trim();
  const senderRole = String(req.body?.senderRole || "sender");
  if (!message) return res.status(400).json({ error: "Message is required." });
  const id = `sm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  run("INSERT INTO support_messages (id,ticket_id,sender_role,message,created_at) VALUES (?,?,?,?,?)", id, ticket.id, senderRole, message, nowIso());
  return res.status(201).json(get("SELECT * FROM support_messages WHERE id=?", id));
});

app.patch("/api/support/tickets/:id", (req, res) => {
  const ticket = get("SELECT * FROM support_tickets WHERE id=?", req.params.id);
  if (!ticket) return res.status(404).json({ error: "Support ticket not found." });
  const status = String(req.body?.status || ticket.status);
  if (!["open", "in_progress", "resolved"].includes(status)) return res.status(400).json({ error: "Invalid ticket status." });
  const resolvedAt = status === "resolved" ? nowIso() : "";
  run("UPDATE support_tickets SET status=?, resolved_at=? WHERE id=?", status, resolvedAt, ticket.id);
  return res.json(get("SELECT * FROM support_tickets WHERE id=?", ticket.id));
});

app.get("/api/admin/surge-zones", (req, res) => {
  const zones = all("SELECT * FROM surge_zones").map((z) => ({
    id: z.id,
    name: z.name,
    keywords: parseJson(z.keywords_json, []),
    multiplier: z.multiplier
  }));
  res.json(zones);
});

app.post("/api/admin/surge-zones", requireAuth, requireRole("admin"), (req, res) => {
  const { name = "", keywords = [], multiplier = 1 } = req.body || {};
  if (!name || !Array.isArray(keywords) || !keywords.length) return res.status(400).json({ error: "Name and keywords are required." });
  const id = `z_${Date.now()}`;
  run("INSERT INTO surge_zones (id,name,keywords_json,multiplier) VALUES (?,?,?,?)", id, String(name).trim(), JSON.stringify(keywords), Number(multiplier || 1));
  auditLog(req, "surge_zone.created", "surge_zone", id, { name, multiplier });
  return res.status(201).json({ id, name: String(name).trim(), keywords, multiplier: Number(multiplier || 1) });
});

app.patch("/api/admin/surge-zones/:id", requireAuth, requireRole("admin"), (req, res) => {
  const zone = get("SELECT * FROM surge_zones WHERE id=?", req.params.id);
  if (!zone) return res.status(404).json({ error: "Surge zone not found." });
  const name = String(req.body?.name || zone.name).trim();
  const keywords = Array.isArray(req.body?.keywords) ? req.body.keywords : parseJson(zone.keywords_json, []);
  const multiplier = Number(req.body?.multiplier ?? zone.multiplier);
  run("UPDATE surge_zones SET name=?, keywords_json=?, multiplier=? WHERE id=?", name, JSON.stringify(keywords), multiplier, zone.id);
  auditLog(req, "surge_zone.updated", "surge_zone", zone.id, { name, multiplier });
  return res.json({ id: zone.id, name, keywords, multiplier });
});

app.delete("/api/admin/surge-zones/:id", requireAuth, requireRole("admin"), (req, res) => {
  const zone = get("SELECT * FROM surge_zones WHERE id=?", req.params.id);
  if (!zone) return res.status(404).json({ error: "Surge zone not found." });
  run("DELETE FROM surge_zones WHERE id=?", zone.id);
  auditLog(req, "surge_zone.deleted", "surge_zone", zone.id, {});
  return res.json({ ok: true });
});

app.get("/api/analytics/overview", (_req, res) => {
  const deliveries = fetchDeliveries();
  const payouts = all("SELECT * FROM payout_requests");
  const byDay = {};
  deliveries.forEach((d) => {
    const day = String(d.createdAt || nowIso()).slice(0, 10);
    if (!byDay[day]) byDay[day] = { day, orders: 0, completed: 0, cancelled: 0, etaTotal: 0, etaCount: 0 };
    byDay[day].orders += 1;
    if (d.status === "Delivered") byDay[day].completed += 1;
    if (d.status === "Cancelled") byDay[day].cancelled += 1;
    const eta = estimateEtaMinutes(d);
    if (eta > 0) {
      byDay[day].etaTotal += eta;
      byDay[day].etaCount += 1;
    }
  });
  const daily = Object.values(byDay)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({
      day: d.day,
      orders: d.orders,
      completionRatePct: d.orders ? Number(((d.completed / d.orders) * 100).toFixed(1)) : 0,
      cancellationRatePct: d.orders ? Number(((d.cancelled / d.orders) * 100).toFixed(1)) : 0,
      avgEtaMinutes: d.etaCount ? Number((d.etaTotal / d.etaCount).toFixed(1)) : 0
    }));
  const weekly = daily.slice(-7);
  const payoutTotals = payouts
    .filter((p) => p.status === "approved")
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  res.json({
    summary: {
      totalOrders: deliveries.length,
      completedOrders: deliveries.filter((d) => d.status === "Delivered").length,
      cancelledOrders: deliveries.filter((d) => d.status === "Cancelled").length,
      payoutTotals: Number(payoutTotals.toFixed(2))
    },
    daily,
    weekly
  });
});

app.get("/api/admin/audit-logs", requireAuth, requireRole("admin"), (_req, res) => {
  res.json(all("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500"));
});

app.get("/api/integrations/status", (_req, res) => {
  res.json({
    stripe: Boolean(stripe && process.env.STRIPE_SECRET_KEY),
    stripeWebhook: Boolean(stripe && process.env.STRIPE_WEBHOOK_SECRET),
    twilio: Boolean(twilioClient && process.env.TWILIO_FROM_NUMBER),
    socketIo: true,
    fcm: fcm.isReady(),
    firebaseLegacyKey: Boolean(process.env.FIREBASE_SERVER_KEY)
  });
});

app.get("/api/deliveries/:id/handoff-qr", async (req, res) => {
  const delivery = fetchDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  const payload = JSON.stringify({ v: 1, id: delivery.id, pin: delivery.securityPin });
  try {
    const qrDataUrl = await QRCode.toDataURL(payload, { margin: 1, width: 240, errorCorrectionLevel: "M" });
    return res.json({
      qrDataUrl,
      handoff: { deliveryId: delivery.id, pin: delivery.securityPin },
      hint: "QR encodes JSON with delivery id and recipient PIN for handoff."
    });
  } catch (e) {
    return res.status(500).json({ error: "QR generation failed." });
  }
});

app.post("/api/deliveries/:id/pickup-proof", uploadPickup.single("photo"), (req, res) => {
  const delivery = fetchDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  if (!req.file) return res.status(400).json({ error: "Pickup photo is required." });
  delivery.pickupPhotoPath = `/uploads/pickup/${path.basename(req.file.path)}`;
  delivery.history.push({ status: "Pickup photo captured", at: nowIso() });
  saveDelivery(delivery);
  broadcastEvent("delivery.updated", { delivery: { id: delivery.id, pickupPhoto: true } });
  return res.json(fetchDelivery(delivery.id));
});

app.get("/api/deliveries/:id/ratings", (req, res) => {
  res.json(all("SELECT * FROM delivery_ratings WHERE delivery_id = ? ORDER BY created_at ASC", req.params.id));
});

app.post("/api/deliveries/:id/ratings", requireAuth, (req, res) => {
  const delivery = fetchDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  const { target, score, comment = "" } = req.body || {};
  const bodyDriverId = String(req.body?.driverId || "").trim();
  const headerDriverId = String(req.headers["x-driver-id"] || "").trim();
  const effectiveDriverId = bodyDriverId || headerDriverId;
  if (!["driver", "sender"].includes(target)) return res.status(400).json({ error: "target must be driver or sender." });
  const s = Number(score);
  if (!Number.isFinite(s) || s < 1 || s > 5) return res.status(400).json({ error: "score must be 1-5." });

  if (target === "driver") {
    if (req.user.role !== "sender") return res.status(403).json({ error: "Only senders rate drivers here." });
  } else {
    if (req.user.role !== "driver") return res.status(403).json({ error: "Only drivers rate senders here." });
    if (!effectiveDriverId || effectiveDriverId !== delivery.driver?.id) {
      return res.status(403).json({ error: "Must be the assigned driver (send x-driver-id header)." });
    }
  }

  const uid = req.user.id;
  const rid = `rt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  try {
    run(
      "INSERT INTO delivery_ratings (id,delivery_id,from_user_id,from_role,target,score,comment,created_at) VALUES (?,?,?,?,?,?,?,?)",
      rid,
      delivery.id,
      uid,
      req.user.role,
      target,
      Math.round(s),
      String(comment).slice(0, 500),
      nowIso()
    );
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "You already submitted this rating." });
    throw e;
  }

  if (target === "driver" && delivery.driver?.id) recomputeDriverRating(delivery.driver.id);
  broadcastEvent("delivery.updated", { delivery: { id: delivery.id, rated: true } });
  return res.status(201).json(get("SELECT * FROM delivery_ratings WHERE id=?", rid));
});

app.post("/api/payments/create-intent", requireAuth, async (req, res) => {
  const { deliveryId } = req.body || {};
  const delivery = fetchDelivery(deliveryId);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  const amountCents = Math.max(50, Math.round(Number(delivery.fare) * 100));
  if (!stripe) {
    const d = fetchDelivery(deliveryId);
    d.paymentStatus = "authorized";
    saveDelivery(d);
    auditLog(req, "payment.mock_authorized", "delivery", delivery.id, {});
    return res.json({
      mock: true,
      publishableKey: "",
      clientSecret: null,
      status: d.paymentStatus,
      message: "Stripe not configured — payment marked authorized for demo."
    });
  }
  try {
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "eur",
      automatic_payment_methods: { enabled: true },
      metadata: { deliveryId: delivery.id }
    });
    const d = fetchDelivery(deliveryId);
    d.stripePaymentIntentId = pi.id;
    d.paymentStatus = pi.status;
    saveDelivery(d);
    auditLog(req, "payment.intent_created", "delivery", delivery.id, { paymentIntentId: pi.id });
    return res.json({
      mock: false,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
      clientSecret: pi.client_secret,
      status: pi.status
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Stripe error" });
  }
});

app.post("/api/push/register", requireAuth, (req, res) => {
  const token = String(req.body?.token || "").trim();
  const platform = String(req.body?.platform || "web").trim();
  if (!token) return res.status(400).json({ error: "token is required." });
  const id = `pt_${Date.now()}`;
  try {
    run("INSERT INTO push_tokens (id,user_id,token,platform,created_at) VALUES (?,?,?,?,?)", id, req.user.id, token, platform, nowIso());
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return res.json({ ok: true, duplicate: true });
    throw e;
  }
  auditLog(req, "push.token_registered", "user", req.user.id, { platform });
  return res.status(201).json({ ok: true, id });
});

app.post("/api/admin/push-test", requireAuth, requireRole("admin"), async (req, res) => {
  const userId = String(req.body?.userId || "").trim();
  const title = String(req.body?.title || "SwiftDrop test").trim();
  const body = String(req.body?.body || "Push pipeline is working.").trim();
  if (!userId) return res.status(400).json({ error: "userId is required (JWT subject from a logged-in user)." });
  if (!fcm.isReady()) return res.status(503).json({ error: "FCM not configured. Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON." });
  try {
    const result = await fcm.sendToUser(userId, {
      title,
      body,
      data: { type: "admin_test", ts: String(Date.now()) }
    });
    auditLog(req, "push.admin_test", "user", userId, { successCount: result.successCount });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message || "FCM send failed" });
  }
});

app.get("/api/admin/live-positions", requireAuth, requireRole("admin"), (_req, res) => {
  const positions = Object.fromEntries(livePositions);
  const drivers = fetchDrivers().map((d) => ({
    id: d.id,
    name: d.name,
    online: d.online,
    position: positions[d.id] || null
  }));
  res.json({ positions, drivers, updatedAt: nowIso() });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);
io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  socket.on("join:delivery", (deliveryId) => {
    if (deliveryId) socket.join(`delivery:${deliveryId}`);
  });
  socket.on("join:admin", () => {
    socket.join("admin");
  });
  socket.on("driver:location", (payload) => {
    if (!payload || !payload.driverId) return;
    const lat = Number(payload.lat);
    const lng = Number(payload.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    livePositions.set(payload.driverId, {
      lat,
      lng,
      deliveryId: payload.deliveryId || "",
      at: Date.now()
    });
    const out = {
      driverId: payload.driverId,
      lat,
      lng,
      deliveryId: payload.deliveryId,
      accuracy: payload.accuracy != null ? Number(payload.accuracy) : undefined,
      source: payload.source
    };
    if (payload.deliveryId) io.to(`delivery:${payload.deliveryId}`).emit("driver:location", out);
    io.to("admin").emit("driver:location", out);
    io.emit("positions:refresh", { driverId: payload.driverId, lat, lng });
  });
});

server.listen(port, () => {
  console.log(`SwiftDrop MVP running at http://localhost:${port} (HTTP + Socket.IO)`);
});
