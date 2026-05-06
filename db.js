const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");

const DB_PATH = path.join(__dirname, "swiftdrop.sqlite");
const db = new DatabaseSync(DB_PATH);

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}

function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function initSchema() {
  run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  run(`CREATE TABLE IF NOT EXISTS drivers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    vehicle TEXT NOT NULL,
    courier_type TEXT NOT NULL,
    rating REAL NOT NULL,
    online INTEGER NOT NULL,
    distance_km REAL NOT NULL,
    wallet_balance REAL NOT NULL,
    completed_jobs INTEGER NOT NULL,
    offers_seen INTEGER NOT NULL,
    offers_accepted INTEGER NOT NULL,
    current_workload INTEGER NOT NULL DEFAULT 0,
    bank_holder_name TEXT NOT NULL DEFAULT '',
    bank_name TEXT NOT NULL DEFAULT '',
    iban TEXT NOT NULL DEFAULT '',
    swift_bic TEXT NOT NULL DEFAULT ''
  )`);

  run(`CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    sender_name TEXT NOT NULL,
    pickup_address TEXT NOT NULL,
    dropoff_address TEXT NOT NULL,
    item_category TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    size TEXT NOT NULL,
    courier_type TEXT NOT NULL,
    delivery_mode TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    stop_count INTEGER NOT NULL,
    stop_addresses_json TEXT NOT NULL,
    urgent INTEGER NOT NULL,
    payment_type TEXT NOT NULL,
    promo_code TEXT NOT NULL,
    distance_km REAL NOT NULL,
    fare_breakdown_json TEXT NOT NULL,
    fare REAL NOT NULL,
    driver_id TEXT,
    matching_radius_km INTEGER,
    status TEXT NOT NULL,
    security_pin TEXT NOT NULL,
    pin_verified INTEGER NOT NULL,
    pin_attempts INTEGER NOT NULL,
    payout_credited INTEGER NOT NULL,
    history_json TEXT NOT NULL,
    pod_photo_path TEXT NOT NULL DEFAULT '',
    pod_signature TEXT NOT NULL DEFAULT '',
    pod_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  run(`CREATE TABLE IF NOT EXISTS delivery_offers (
    delivery_id TEXT PRIMARY KEY,
    radius_index INTEGER NOT NULL,
    candidate_driver_ids_json TEXT NOT NULL,
    declined_driver_ids_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);

  run(`CREATE TABLE IF NOT EXISTS payout_requests (
    id TEXT PRIMARY KEY,
    driver_id TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    reviewed_at TEXT NOT NULL DEFAULT '',
    admin_note TEXT NOT NULL DEFAULT ''
  )`);

  run(`CREATE TABLE IF NOT EXISTS driver_documents (
    id TEXT PRIMARY KEY,
    driver_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    status TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    reviewed_at TEXT NOT NULL DEFAULT '',
    review_note TEXT NOT NULL DEFAULT ''
  )`);

  run(`CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL,
    sender_role TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  run(`CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL,
    created_by_role TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT NOT NULL DEFAULT ''
  )`);

  run(`CREATE TABLE IF NOT EXISTS support_messages (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL,
    sender_role TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  run(`CREATE TABLE IF NOT EXISTS surge_zones (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    keywords_json TEXT NOT NULL,
    multiplier REAL NOT NULL
  )`);

  run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_role TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

function seedDefaults() {
  const usersCount = get("SELECT COUNT(*) AS c FROM users").c;
  if (!usersCount) {
    const defaults = [
      { id: "u_sender", email: "sender@swiftdrop.app", password: "demo123", role: "sender", name: "Precious" },
      { id: "u_driver", email: "driver@swiftdrop.app", password: "demo123", role: "driver", name: "Andrius K." },
      { id: "u_admin", email: "admin@swiftdrop.app", password: "demo123", role: "admin", name: "Ops Admin" }
    ];
    defaults.forEach((u) => {
      run(
        "INSERT INTO users (id,email,password_hash,role,name,created_at) VALUES (?,?,?,?,?,?)",
        u.id,
        u.email,
        bcrypt.hashSync(u.password, 10),
        u.role,
        u.name,
        nowIso()
      );
    });
  }

  const driversCount = get("SELECT COUNT(*) AS c FROM drivers").c;
  if (!driversCount) {
    const defaults = [
      { id: "d1", name: "Alex M.", vehicle: "Bike", courierType: "bike", rating: 4.9, online: 1, distanceKm: 1.3 },
      { id: "d2", name: "Tina K.", vehicle: "Car", courierType: "car", rating: 4.8, online: 1, distanceKm: 3.7 },
      { id: "d3", name: "Rashid O.", vehicle: "Scooter", courierType: "bike", rating: 4.7, online: 1, distanceKm: 6.4 },
      { id: "d4", name: "Marta L.", vehicle: "Van", courierType: "van", rating: 4.95, online: 1, distanceKm: 8.9 },
      { id: "d5", name: "Jon P.", vehicle: "Truck", courierType: "truck", rating: 4.85, online: 1, distanceKm: 9.8 }
    ];
    defaults.forEach((d) => {
      run(
        `INSERT INTO drivers (
          id,name,vehicle,courier_type,rating,online,distance_km,wallet_balance,completed_jobs,offers_seen,offers_accepted,current_workload
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        d.id,
        d.name,
        d.vehicle,
        d.courierType,
        d.rating,
        d.online,
        d.distanceKm,
        0,
        0,
        0,
        0,
        0
      );
    });
  }

  const zonesCount = get("SELECT COUNT(*) AS c FROM surge_zones").c;
  if (!zonesCount) {
    const zones = [
      { id: "z1", name: "City Center", keywords: ["gedimino", "senamiestis", "old town", "centras"], multiplier: 1.2 },
      { id: "z2", name: "Business District", keywords: ["ozo", "konstitucijos", "europa"], multiplier: 1.15 },
      { id: "z3", name: "Airport Area", keywords: ["airport", "oro uostas", "rodunios"], multiplier: 1.25 }
    ];
    zones.forEach((z) => {
      run(
        "INSERT INTO surge_zones (id,name,keywords_json,multiplier) VALUES (?,?,?,?)",
        z.id,
        z.name,
        JSON.stringify(z.keywords),
        z.multiplier
      );
    });
  }
}

function mapDriver(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    vehicle: row.vehicle,
    courierType: row.courier_type,
    rating: row.rating,
    online: Boolean(row.online),
    distanceKm: row.distance_km,
    walletBalance: row.wallet_balance,
    completedJobs: row.completed_jobs,
    offersSeen: row.offers_seen,
    offersAccepted: row.offers_accepted,
    currentWorkload: row.current_workload,
    bankDetails: {
      holderName: row.bank_holder_name || "",
      bankName: row.bank_name || "",
      iban: row.iban || "",
      swiftBic: row.swift_bic || ""
    }
  };
}

function mapDelivery(row, driversById = {}) {
  if (!row) return null;
  return {
    id: row.id,
    senderName: row.sender_name,
    pickupAddress: row.pickup_address,
    dropoffAddress: row.dropoff_address,
    itemCategory: row.item_category,
    recipientName: row.recipient_name,
    size: row.size,
    courierType: row.courier_type,
    deliveryMode: row.delivery_mode,
    scheduledAt: row.scheduled_at,
    stopCount: row.stop_count,
    stopAddresses: parseJson(row.stop_addresses_json, []),
    urgent: Boolean(row.urgent),
    paymentType: row.payment_type,
    promoCode: row.promo_code,
    distanceKm: row.distance_km,
    fareBreakdown: parseJson(row.fare_breakdown_json, {}),
    fare: row.fare,
    driver: row.driver_id ? driversById[row.driver_id] || null : null,
    matchingRadiusKm: row.matching_radius_km,
    status: row.status,
    securityPin: row.security_pin,
    pinVerified: Boolean(row.pin_verified),
    pinAttempts: row.pin_attempts,
    payoutCredited: Boolean(row.payout_credited),
    history: parseJson(row.history_json, []),
    podPhotoPath: row.pod_photo_path || "",
    podSignature: row.pod_signature || "",
    podNote: row.pod_note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getDriversById() {
  const drivers = all("SELECT * FROM drivers");
  return drivers.reduce((acc, row) => {
    const d = mapDriver(row);
    acc[d.id] = d;
    return acc;
  }, {});
}

function ensureUploadsDir() {
  const dir = path.join(__dirname, "uploads");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

initSchema();
seedDefaults();
ensureUploadsDir();

module.exports = {
  db,
  run,
  get,
  all,
  nowIso,
  parseJson,
  mapDriver,
  mapDelivery,
  getDriversById
};
