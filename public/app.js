/* ════════════════════════════════════════════════════════════
   SwiftDrop — App JS
   Wires all 5 screens to the real REST API.
   Design: navy #1a1f2e · orange #f5a623 · teal #10b981
════════════════════════════════════════════════════════════ */

// ─── Helpers ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
let toastTimer;
const SESSION_KEY = "swiftdrop_session_v1";
const THEME_KEY = "swiftdrop_theme_v1";
const TOKEN_KEY = "swiftdrop_token_v1";
const rawFetch = window.fetch.bind(window);

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (state.role === "driver" && state.driverId) headers.set("x-driver-id", state.driverId);
  return rawFetch(url, { ...options, headers });
}
window.fetch = apiFetch;

function setTheme(mode) {
  const next = mode === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(THEME_KEY, next);
  const btn = $("profile-theme-btn");
  if (btn) btn.textContent = next === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") {
    setTheme(saved);
    return;
  }
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(prefersDark ? "dark" : "light");
}

function toast(msg, ms = 3200) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

function renderNotifications() {
  const list = $("notif-list");
  const badge = $("notif-badge");
  const panel = $("notif-panel");
  if (!list || !badge || !panel) return;

  if (!state.notifications.length) {
    list.innerHTML = `<div class="notif-empty">No notifications yet.</div>`;
  } else {
    list.innerHTML = state.notifications.map((n) => `
      <div class="notif-item">
        <div class="notif-item-title">${n.message}</div>
        <div class="notif-item-time">${new Date(n.at).toLocaleTimeString()}</div>
      </div>
    `).join("");
  }

  badge.textContent = String(Math.min(99, state.unread));
  badge.classList.toggle("hidden", state.unread <= 0);
}

function addNotification(message) {
  state.notifications.unshift({ message, at: Date.now() });
  state.notifications = state.notifications.slice(0, 30);
  if ($("notif-panel").classList.contains("hidden")) {
    state.unread += 1;
  }
  renderNotifications();
}

function openNotifications() {
  state.unread = 0;
  $("notif-panel").classList.remove("hidden");
  renderNotifications();
}

function isBankFormFocused() {
  const active = document.activeElement;
  const ids = new Set(["bank-holder-name", "bank-name", "bank-iban", "bank-swift"]);
  return active && ids.has(active.id);
}

function renderBankDetails(bankDetails = {}) {
  if (isBankFormFocused()) return;
  $("bank-holder-name").value = bankDetails.holderName || "";
  $("bank-name").value = bankDetails.bankName || "";
  $("bank-iban").value = bankDetails.iban || "";
  $("bank-swift").value = bankDetails.swiftBic || "";
}

async function saveBankDetails() {
  const payload = {
    holderName: $("bank-holder-name").value.trim(),
    bankName: $("bank-name").value.trim(),
    iban: $("bank-iban").value.trim(),
    swiftBic: $("bank-swift").value.trim()
  };

  const btn = $("bank-save-btn");
  const meta = $("bank-save-meta");
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    const res = await fetch(`/api/drivers/${state.driverId}/bank-details`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      meta.textContent = data.error || "Could not save bank details.";
      return;
    }
    meta.textContent = `Saved at ${new Date().toLocaleTimeString()}`;
    addNotification("Driver payout bank details saved.");
    toast("Bank details saved.");
    loadDriverDashboard();
  } catch {
    meta.textContent = "Network error while saving bank details.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Save bank details";
  }
}

function renderPayoutHistory(requests = []) {
  $("payout-history").innerHTML = requests.length
    ? requests.map((r) => `<div class="payout-item">€${Number(r.amount || 0).toFixed(2)} · ${r.status} · ${new Date(r.requested_at).toLocaleString()}</div>`).join("")
    : "<div class='payout-item'>No payout requests yet.</div>";
}

function renderDocuments(docs = []) {
  $("doc-list").innerHTML = docs.length
    ? docs.map((d) => `<div class="doc-item">${String(d.doc_type).toUpperCase()} · ${d.status} · ${new Date(d.uploaded_at).toLocaleString()}</div>`).join("")
    : "<div class='doc-item'>No documents uploaded yet.</div>";
}

async function requestPayout() {
  const amount = Number($("payout-amount").value || 0);
  if (!amount) return toast("Enter payout amount.");
  const res = await fetch(`/api/drivers/${state.driverId}/payout-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount })
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "Payout request failed.");
  $("payout-meta").textContent = `Requested €${amount.toFixed(2)} at ${new Date().toLocaleTimeString()}`;
  addNotification(`Payout requested: €${amount.toFixed(2)}.`);
  loadDriverDashboard();
}

async function uploadDocument() {
  const file = $("doc-file").files?.[0];
  if (!file) return toast("Select a document file.");
  const form = new FormData();
  form.append("file", file);
  form.append("docType", $("doc-type").value);
  const res = await fetch(`/api/drivers/${state.driverId}/documents`, {
    method: "POST",
    body: form
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "Upload failed.");
  $("doc-meta").textContent = `Uploaded ${String(data.doc_type).toUpperCase()} document.`;
  addNotification("Driver document uploaded for review.");
  $("doc-file").value = "";
  loadDriverDashboard();
}

async function loadChat() {
  if (!state.activeId) return;
  const res = await fetch(`/api/chat/${state.activeId}`);
  const rows = await res.json();
  $("chat-feed").innerHTML = (rows || []).slice(-20).map((m) => {
    const who = `${String(m.sender_role || "user").toUpperCase()} ${m.sender_name || ""}`.trim();
    return `<div class="chat-row"><b>${who}:</b> ${m.message}</div>`;
  }).join("") || "<div class='chat-row'>No chat yet.</div>";
}

async function sendChat() {
  if (!state.activeId) return toast("Open a tracked delivery first.");
  const message = $("chat-input").value.trim();
  if (!message) return;
  const res = await fetch(`/api/chat/${state.activeId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      senderRole: state.role || "sender",
      senderName: state.user?.name || "User"
    })
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "Message send failed.");
  $("chat-input").value = "";
  loadChat();
}

async function savePod() {
  if (!state.activeId) return toast("No active delivery selected.");
  const form = new FormData();
  const note = $("pod-note").value.trim();
  const signature = $("pod-signature").value.trim();
  const photo = $("pod-photo").files?.[0];
  if (note) form.append("note", note);
  if (signature) form.append("signature", signature);
  if (photo) form.append("photo", photo);
  const res = await fetch(`/api/deliveries/${state.activeId}/pod`, {
    method: "POST",
    body: form
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "Could not save proof.");
  toast("Proof of delivery saved.");
  addNotification(`POD saved for ${state.activeId}.`);
  $("pod-photo").value = "";
  loadHistory();
}

async function loadSupportTickets() {
  const res = await fetch("/api/support/tickets");
  const rows = await res.json();
  $("support-ticket-list").innerHTML = rows.length
    ? rows.slice(0, 12).map((t) => `<div class="support-item">${t.status} · ${t.severity} · ${t.title}</div>`).join("")
    : "<div class='support-item'>No support tickets yet.</div>";
}

async function reviewPayout(id, status) {
  const res = await fetch(`/api/admin/payout-requests/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status })
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "Payout review failed.");
  loadHistory();
}

async function reviewDocument(id, status) {
  const res = await fetch(`/api/admin/driver-documents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status })
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "Document review failed.");
  loadHistory();
}

async function loadAdminReviewQueues() {
  if (state.role !== "admin") {
    $("admin-review-wrap").classList.add("hidden");
    return;
  }
  $("admin-review-wrap").classList.remove("hidden");
  const [payoutRes, docRes] = await Promise.all([
    fetch("/api/admin/payout-requests"),
    fetch("/api/admin/driver-documents")
  ]);
  const payouts = payoutRes.ok ? await payoutRes.json() : [];
  const docs = docRes.ok ? await docRes.json() : [];

  $("admin-payout-list").innerHTML = payouts.length
    ? payouts.slice(0, 10).map((p) => `<div class="support-item">
        ${p.driver_id} · €${Number(p.amount).toFixed(2)} · ${p.status}
        ${p.status === "pending" ? `<div class="admin-review-action"><button class="ok" data-pay-ok="${p.id}">Approve</button><button class="bad" data-pay-bad="${p.id}">Reject</button></div>` : ""}
      </div>`).join("")
    : "<div class='support-item'>No payout requests.</div>";
  $("admin-doc-review-list").innerHTML = docs.length
    ? docs.slice(0, 12).map((d) => `<div class="support-item">
        ${d.driver_id} · ${String(d.doc_type).toUpperCase()} · ${d.status}
        ${d.status === "pending" ? `<div class="admin-review-action"><button class="ok" data-doc-ok="${d.id}">Approve</button><button class="bad" data-doc-bad="${d.id}">Reject</button></div>` : ""}
      </div>`).join("")
    : "<div class='support-item'>No driver documents.</div>";

  document.querySelectorAll("[data-pay-ok]").forEach((btn) => btn.addEventListener("click", () => reviewPayout(btn.dataset.payOk, "approved")));
  document.querySelectorAll("[data-pay-bad]").forEach((btn) => btn.addEventListener("click", () => reviewPayout(btn.dataset.payBad, "rejected")));
  document.querySelectorAll("[data-doc-ok]").forEach((btn) => btn.addEventListener("click", () => reviewDocument(btn.dataset.docOk, "approved")));
  document.querySelectorAll("[data-doc-bad]").forEach((btn) => btn.addEventListener("click", () => reviewDocument(btn.dataset.docBad, "rejected")));
}

async function createSupportTicket() {
  const title = $("support-title").value.trim();
  const description = $("support-description").value.trim();
  if (!title || !description) return toast("Support title and description are required.");
  const res = await fetch("/api/support/tickets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deliveryId: state.activeId || "",
      createdByRole: state.role || "sender",
      category: $("support-category").value,
      severity: $("support-severity").value,
      title,
      description
    })
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "Support ticket creation failed.");
  $("support-title").value = "";
  $("support-description").value = "";
  toast("Support ticket created.");
  loadSupportTickets();
}

async function loadSurgeZones() {
  const res = await fetch("/api/admin/surge-zones");
  const rows = await res.json();
  $("surge-zone-list").innerHTML = rows.length
    ? rows.map((z) => `<div class="surge-item">${z.name} · x${Number(z.multiplier || 1).toFixed(2)} · ${z.keywords.join(", ")}</div>`).join("")
    : "<div class='surge-item'>No surge zones configured.</div>";
}

async function addSurgeZone() {
  const name = $("surge-name").value.trim();
  const keywords = $("surge-keywords").value.split(",").map((k) => k.trim()).filter(Boolean);
  const multiplier = Number($("surge-multiplier").value || 1);
  if (!name || !keywords.length) return toast("Add surge name and keywords.");
  const res = await fetch("/api/admin/surge-zones", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, keywords, multiplier })
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "Could not add surge zone. (Admin token required)");
  $("surge-name").value = "";
  $("surge-keywords").value = "";
  $("surge-multiplier").value = "";
  loadSurgeZones();
}

async function loadAnalytics() {
  const res = await fetch("/api/analytics/overview");
  const data = await res.json();
  const summary = data.summary || {};
  $("analytics-summary").innerHTML = `
    <div class="analytics-item">Orders: ${summary.totalOrders || 0}</div>
    <div class="analytics-item">Completed: ${summary.completedOrders || 0}</div>
    <div class="analytics-item">Cancelled: ${summary.cancelledOrders || 0}</div>
    <div class="analytics-item">Payouts: €${Number(summary.payoutTotals || 0).toFixed(2)}</div>
  `;
  $("analytics-daily").innerHTML = (data.weekly || []).map((d) => `<div class="analytics-item">${d.day}: ${d.orders} orders · ${d.completionRatePct}% complete · ETA ${d.avgEtaMinutes}m</div>`).join("");
}

function parseStopAddresses() {
  return ($("input-stop-addresses")?.value || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── Screen router ────────────────────────────────────────
const screens = ["home", "booking", "tracking", "history", "profile"];

function showScreen(name) {
  if (state.role === "driver" && name === "home") name = "profile";
  if (state.role === "admin" && name === "home") name = "history";
  screens.forEach((s) => {
    const el = $(`screen-${s}`);
    if (el) {
      el.classList.toggle("active", s === name);
      el.classList.toggle("hidden", s !== name);
    }
  });
  if (name === "history") loadHistory();
  if (name === "profile") loadDriverDashboard();
}

// Nav buttons (all screens share the pattern)
document.querySelectorAll("[data-screen]").forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.screen));
});

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.back));
});

async function loadDemoUsers() {
  try {
    const res = await fetch("/api/auth/demo-users");
    const users = await res.json();
    $("auth-demo-users").innerHTML = users
      .map((u) => `${u.role}: ${u.email} / ${u.password}`)
      .join("<br/>");
  } catch {
    $("auth-demo-users").textContent = "Unable to load demo users.";
  }
}

function showAuthLayer(layer) {
  $("start-screen").classList.add("hidden");
  $("auth-screen").classList.add("hidden");
  $("signup-screen").classList.add("hidden");
  $(layer).classList.remove("hidden");
}

function completeAuth(user) {
  state.user = user;
  state.role = user.role;
  $("home-username").textContent = user.name;
  $("start-screen").classList.add("hidden");
  $("auth-screen").classList.add("hidden");
  $("signup-screen").classList.add("hidden");
  $("profile-menu-wrap").classList.remove("hidden");
  $("profile-menu-name").textContent = user.name;
  $("profile-menu-role").textContent = String(user.role || "sender").toUpperCase();
  $("profile-dropdown").classList.add("hidden");
  $("notif-panel").classList.add("hidden");
  state.unread = 0;
  renderNotifications();
  applyRoleUI();
  addNotification(`Signed in as ${String(user.role || "sender").toUpperCase()}.`);
  connectSocket();
  registerPushDemoToken();
  if (state.socket?.connected) {
    if (state.activeId) state.socket.emit("join:delivery", state.activeId);
    if (state.role === "admin") state.socket.emit("join:admin");
  }

  if (state.role === "driver") showScreen("profile");
  else if (state.role === "admin") showScreen("history");
  else showScreen("home");
}

function logout() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(TOKEN_KEY);
  state.user = null;
  state.role = null;
  state.token = "";
  state.activeId = null;
  clearInterval(state.pollTimer);
  stopDriverGpsTracking();
  if (state.socket) {
    try {
      state.socket.disconnect();
    } catch {
      /* ignore */
    }
    state.socket = null;
  }
  $("profile-menu-wrap").classList.add("hidden");
  $("profile-dropdown").classList.add("hidden");
  $("notif-panel").classList.add("hidden");
  state.notifications = [];
  state.unread = 0;
  renderNotifications();
  $("auth-remember").checked = false;
  showAuthLayer("start-screen");
  toast("Logged out.");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

function passwordStrength(password) {
  const p = String(password || "");
  let score = 0;
  if (p.length >= 8) score += 1;
  if (/[A-Z]/.test(p)) score += 1;
  if (/[a-z]/.test(p)) score += 1;
  if (/\d/.test(p)) score += 1;
  if (/[^A-Za-z0-9]/.test(p)) score += 1;
  return score;
}

function renderPasswordStrength(password) {
  const score = passwordStrength(password);
  const fill = $("signup-strength-fill");
  const text = $("signup-strength-text");
  const pct = Math.max(10, score * 20);
  fill.style.width = `${pct}%`;
  if (score <= 2) {
    fill.style.background = "#ef4444";
    text.textContent = "Password strength: weak";
  } else if (score <= 3) {
    fill.style.background = "#f59e0b";
    text.textContent = "Password strength: medium";
  } else {
    fill.style.background = "#10b981";
    text.textContent = "Password strength: strong";
  }
}

async function login() {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value.trim();
  if (!email || !password) return toast("Enter email and password.");
  if (!isValidEmail(email)) return toast("Enter a valid email address.");

  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "Login failed.");
  state.token = data.token || "";
  if ($("auth-remember").checked) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data.user));
    localStorage.setItem(TOKEN_KEY, state.token);
  } else {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(TOKEN_KEY);
  }
  completeAuth(data.user);
}

$("auth-login-btn").addEventListener("click", login);

async function signup() {
  const name = $("signup-name").value.trim();
  const email = $("signup-email").value.trim();
  const password = $("signup-password").value.trim();
  const role = $("signup-role").value;
  if (!name || !email || !password) return toast("Please fill all signup fields.");
  if (!isValidEmail(email)) return toast("Enter a valid email address.");
  if (password.length < 8) return toast("Password must be at least 8 characters.");
  if (passwordStrength(password) < 3) return toast("Use a stronger password (mix letters/numbers/symbols).");

  const res = await fetch("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password, role })
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "Signup failed.");
  toast("Account created.");
  state.token = data.token || "";
  localStorage.setItem(SESSION_KEY, JSON.stringify(data.user));
  localStorage.setItem(TOKEN_KEY, state.token);
  completeAuth(data.user);
}

$("signup-submit-btn").addEventListener("click", signup);
$("start-login-btn").addEventListener("click", () => showAuthLayer("auth-screen"));
$("start-signup-btn").addEventListener("click", () => showAuthLayer("signup-screen"));
$("auth-back-btn").addEventListener("click", () => showAuthLayer("start-screen"));
$("signup-back-btn").addEventListener("click", () => showAuthLayer("start-screen"));
$("signup-password").addEventListener("input", (e) => renderPasswordStrength(e.target.value));
$("profile-menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("profile-dropdown").classList.toggle("hidden");
});
$("notif-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const panel = $("notif-panel");
  if (panel.classList.contains("hidden")) openNotifications();
  else panel.classList.add("hidden");
});
$("notif-clear-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  state.notifications = [];
  state.unread = 0;
  renderNotifications();
});
$("bank-save-btn").addEventListener("click", saveBankDetails);
$("payout-request-btn").addEventListener("click", requestPayout);
$("doc-upload-btn").addEventListener("click", uploadDocument);
$("chat-send-btn").addEventListener("click", sendChat);
$("pod-save-btn").addEventListener("click", savePod);
$("support-create-btn").addEventListener("click", createSupportTicket);
$("surge-add-btn").addEventListener("click", addSurgeZone);
$("profile-theme-btn").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  setTheme(current === "dark" ? "light" : "dark");
});
$("profile-logout-btn").addEventListener("click", logout);
document.addEventListener("click", (e) => {
  const menu = $("profile-menu-wrap");
  if (!menu.classList.contains("hidden") && !menu.contains(e.target)) {
    $("profile-dropdown").classList.add("hidden");
  }
  const panel = $("notif-panel");
  const bell = $("notif-btn");
  if (!panel.classList.contains("hidden") && !panel.contains(e.target) && !bell.contains(e.target)) {
    panel.classList.add("hidden");
  }
});

// ─── State ────────────────────────────────────────────────
const state = {
  itemCategory: "Parcel",
  courierType:  "bike",
  courierPrice: 3.5,
  paymentType:  "card",
  deliveryMode: "asap",
  urgent:       false,
  activeId:     null,
  driverId:     "d1",
  driverOnline: true,
  offerTimers:  {},
  pollTimer:    null,
  pricingPreview: null,
  user: null,
  role: null,
  token: "",
  notifications: [],
  unread: 0,
  socket: null,
  stripeCard: null,
  _driverLocTimer: null,
  _gpsWatchId: null,
  _gpsToggleWired: false,
  lastLiveGpsAt: 0
};

function applyRoleUI() {
  const role = (state.role || "sender").toUpperCase();
  $("role-chip").textContent = role;
  const surgeEditor = $("surge-editor");
  if (surgeEditor) surgeEditor.classList.toggle("hidden", (state.role || "sender") !== "admin");
  const adminLive = $("admin-live-wrap");
  if (adminLive) adminLive.classList.toggle("hidden", (state.role || "sender") !== "admin");
  const fcmTest = $("fcm-admin-test");
  if (fcmTest) fcmTest.classList.toggle("hidden", (state.role || "sender") !== "admin");
}

function projectLatLng(lat, lng) {
  const minLat = 54.64;
  const maxLat = 54.72;
  const minLng = 25.18;
  const maxLng = 25.32;
  const x = 44 + ((lng - minLng) / (maxLng - minLng)) * 252;
  const y = 148 - ((lat - minLat) / (maxLat - minLat)) * 118;
  return { x, y };
}

function connectSocket() {
  if (typeof io === "undefined") return;
  if (state.socket && state.socket.connected) return;
  if (state.socket) {
    try {
      state.socket.disconnect();
    } catch {
      /* ignore */
    }
  }
  state.socket = io({ transports: ["websocket", "polling"] });
  state.socket.on("connect", () => {
    if (state.activeId) state.socket.emit("join:delivery", state.activeId);
    if (state.role === "admin") state.socket.emit("join:admin");
  });
  state.socket.on("driver:location", (payload) => {
    if (!payload || !Number.isFinite(payload.lat)) return;
    if (payload.deliveryId && state.activeId && payload.deliveryId !== state.activeId) return;
    const marker = $("courier-marker");
    if (marker) {
      const { x, y } = projectLatLng(payload.lat, payload.lng);
      marker.setAttribute("transform", `translate(${x},${y})`);
    }
    const live = $("driver-live-pos");
    if (live) {
      const acc = payload.accuracy != null ? ` ±${Math.round(payload.accuracy)}m` : "";
      live.textContent = `Live GPS · ${payload.lat.toFixed(5)}, ${payload.lng.toFixed(5)}${acc}`;
    }
    const updated = $("map-updated-at");
    if (updated) updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    state.lastLiveGpsAt = Date.now();
  });
}

function stopDriverGpsTracking() {
  clearInterval(state._driverLocTimer);
  state._driverLocTimer = null;
  if (state._gpsWatchId != null && typeof navigator !== "undefined" && navigator.geolocation?.clearWatch) {
    try {
      navigator.geolocation.clearWatch(state._gpsWatchId);
    } catch {
      /* ignore */
    }
  }
  state._gpsWatchId = null;
}

function startDriverLocationTracking(job, forceSim = false) {
  stopDriverGpsTracking();
  if (!job || state.role !== "driver" || !state.driverOnline) return;

  const storedPref = localStorage.getItem("swiftdrop_use_real_gps");
  const checkboxPref = $("driver-use-real-gps")?.checked !== false;
  const useReal = !forceSim && checkboxPref && storedPref !== "0";

  const emit = (lat, lng, extra = {}) => {
    if (typeof io === "undefined") return;
    if (!state.socket?.connected) connectSocket();
    state.socket.emit("driver:location", {
      driverId: state.driverId,
      deliveryId: job.id,
      lat,
      lng,
      ...extra
    });
  };

  const runSimulation = () => {
    state._driverLocTimer = setInterval(() => {
      const t = (Date.now() % 80000) / 80000;
      const lat = 54.67 + t * 0.04;
      const lng = 25.22 + Math.sin(t * Math.PI * 2) * 0.03;
      emit(lat, lng, { source: "sim" });
    }, 2500);
  };

  if (!useReal) {
    runSimulation();
    return;
  }

  if (typeof navigator === "undefined" || !navigator.geolocation) {
    toast("This browser has no geolocation API — using simulated movement.");
    runSimulation();
    return;
  }

  state._gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      emit(pos.coords.latitude, pos.coords.longitude, {
        accuracy: pos.coords.accuracy,
        source: "gps"
      });
    },
    (err) => {
      toast(`GPS unavailable (${err.code === 1 ? "permission denied" : err.message}) — using simulation.`);
      startDriverLocationTracking(job, true);
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
  );
}

async function registerPushDemoToken() {
  if (!state.token) return;
  const k = "swiftdrop_push_demo";
  let t = localStorage.getItem(k);
  if (!t) {
    t = `demo-fcm-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
    localStorage.setItem(k, t);
  }
  try {
    await fetch("/api/push/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: t, platform: "web-demo" })
    });
  } catch {
    /* optional */
  }
}

async function loadHandoffQr(deliveryId) {
  const img = $("handoff-qr");
  if (!img || !deliveryId) return;
  try {
    const res = await fetch(`/api/deliveries/${deliveryId}/handoff-qr`);
    const data = await res.json();
    if (res.ok && data.qrDataUrl) {
      img.src = data.qrDataUrl;
      img.classList.remove("hidden");
    }
  } catch {
    /* ignore */
  }
}

async function loadIntegrationsMeta() {
  const el = $("integrations-meta");
  if (!el) return;
  try {
    const res = await fetch("/api/integrations/status");
    const s = await res.json();
    el.innerHTML = `<span class="meta-chip">Stripe: ${s.stripe ? "configured" : "off"}</span> <span class="meta-chip">Twilio SMS: ${s.twilio ? "on" : "off"}</span> <span class="meta-chip">Socket.IO: live</span> <span class="meta-chip">FCM (Admin SDK): ${s.fcm ? "ready" : "off"}</span>${s.firebaseLegacyKey ? ` <span class="meta-chip">Legacy FCM key env: set</span>` : ""}`;
  } catch {
    el.textContent = "";
  }
}

async function loadLiveMap() {
  if (state.role !== "admin") return;
  const map = $("admin-live-map");
  const meta = $("admin-live-meta");
  if (!map || !meta) return;
  try {
    const res = await fetch("/api/admin/live-positions");
    const data = await res.json();
    if (!res.ok) return;
    map.innerHTML = "";
    const pos = data.positions || {};
    Object.entries(pos).forEach(([id, p]) => {
      const dot = document.createElement("div");
      dot.className = "live-dot";
      const lng = Number(p.lng);
      const lat = Number(p.lat);
      dot.style.left = `${12 + ((lng - 25.18) / 0.14) * 76}%`;
      dot.style.top = `${8 + (1 - (lat - 54.64) / 0.08) * 84}%`;
      dot.title = `${id} · ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      map.appendChild(dot);
    });
    meta.textContent = `${Object.keys(pos).length} driver(s) reporting live GPS (simulated or real).`;
  } catch {
    meta.textContent = "Could not load live positions.";
  }
}

async function renderRatingsPanel(d) {
  const card = $("ratings-card");
  const body = $("ratings-body");
  if (!card || !body) return;
  if (d.status !== "Delivered") {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  let rows = [];
  try {
    const res = await fetch(`/api/deliveries/${d.id}/ratings`);
    rows = await res.json();
  } catch {
    rows = [];
  }
  const hasDriverRating = rows.some((r) => r.target === "driver");
  const hasSenderRating = rows.some((r) => r.target === "sender");
  const role = state.role || "sender";
  let controls = "";
  if (role === "sender" && !hasDriverRating && state.token) {
    controls += `<div class="rating-row"><span>Rate driver</span>
      <select id="rate-driver-score"><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select>
      <button type="button" id="rate-driver-btn" class="bank-save-btn">Submit</button></div>`;
  }
  if (role === "driver" && !hasSenderRating && state.token) {
    controls += `<div class="rating-row"><span>Rate sender</span>
      <select id="rate-sender-score"><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select>
      <button type="button" id="rate-sender-btn" class="bank-save-btn">Submit</button></div>`;
  }
  body.innerHTML = `
    <div class="bank-save-meta">${rows.length ? rows.map((r) => `<div>${r.from_role} → ${r.target}: ${r.score}★</div>`).join("") : "No ratings yet."}</div>
    ${controls}
  `;
  $("rate-driver-btn")?.addEventListener("click", async () => {
    const score = Number($("rate-driver-score")?.value || 5);
    const res = await fetch(`/api/deliveries/${d.id}/ratings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "driver", score })
    });
    const err = await res.json().catch(() => ({}));
    if (!res.ok) return toast(err.error || "Could not save rating.");
    toast("Thanks — driver rated.");
    const list = await fetch("/api/deliveries").then((r) => r.json());
    const nd = list.find((x) => x.id === d.id);
    if (nd) await renderRatingsPanel(nd);
  });
  $("rate-sender-btn")?.addEventListener("click", async () => {
    const score = Number($("rate-sender-score")?.value || 5);
    const res = await fetch(`/api/deliveries/${d.id}/ratings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "sender", score, driverId: state.driverId })
    });
    const err = await res.json().catch(() => ({}));
    if (!res.ok) return toast(err.error || "Could not save rating.");
    toast("Thanks — sender rated.");
    const all = await fetch("/api/deliveries").then((r) => r.json());
    renderRatingsPanel(all.find((x) => x.id === d.id) || d);
  });
}

function renderOnboarding(driver, docs = []) {
  const ol = $("onboard-steps");
  if (!ol) return;
  const ibanOk = Boolean(driver.bankDetails?.iban);
  const docOk = (docs || []).some((x) => x.status === "approved");
  const steps = [
    { ok: ibanOk, label: "Add bank details for payouts" },
    { ok: docOk, label: "Documents approved by admin" },
    { ok: driver.online, label: "Stay online to receive jobs" }
  ];
  ol.innerHTML = steps.map((s) => `<li style="color:${s.ok ? "var(--teal)" : "var(--text2)"}">${s.ok ? "✓" : "○"} ${s.label}</li>`).join("");
}

// ─── HOME ─────────────────────────────────────────────────

// category tiles → pre-select item type
document.querySelectorAll(".cat-tile[data-cat]").forEach((tile) => {
  tile.addEventListener("click", () => {
    state.itemCategory = tile.dataset.cat;
    // highlight selected item chip on booking screen
    document.querySelectorAll(".item-chip").forEach((c) => {
      c.classList.toggle("selected", c.dataset.item === state.itemCategory);
    });
    showScreen("booking");
  });
});

// ─── BOOKING SCREEN ───────────────────────────────────────

// Item chips
document.querySelectorAll(".item-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (chip.dataset.item === "urgent-flag") {
      state.urgent = !state.urgent;
      chip.classList.toggle("selected", state.urgent);
      return;
    }
    document.querySelectorAll(".item-chip:not(.urgent-chip)").forEach((c) => c.classList.remove("selected"));
    chip.classList.add("selected");
    state.itemCategory = chip.dataset.item;
  });
});

// Vehicle cards
document.querySelectorAll(".veh-card").forEach((card) => {
  card.addEventListener("click", () => {
    document.querySelectorAll(".veh-card").forEach((c) => c.classList.remove("selected"));
    card.classList.add("selected");
    state.courierType  = card.dataset.type;
    state.courierPrice = parseFloat(card.dataset.price);
    updateFarePreview();
  });
});

// Payment
document.querySelectorAll(".pay-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".pay-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    state.paymentType = btn.dataset.pay;
  });
});

// Delivery mode
document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    state.deliveryMode = btn.dataset.mode;
    $("sched-wrap").classList.toggle("hidden", state.deliveryMode !== "scheduled");
    updateFarePreview();
  });
});

// Address inputs → live fare update
$("input-pickup").addEventListener("input",  updateFarePreview);
$("input-dropoff").addEventListener("input", updateFarePreview);
$("input-promo").addEventListener("input", updateFarePreview);
$("input-stops").addEventListener("input", updateFarePreview);
$("input-stop-addresses").addEventListener("input", updateFarePreview);

$("optimize-stops-btn").addEventListener("click", async () => {
  const pickupAddress = $("input-pickup").value.trim();
  const dropoffAddress = $("input-dropoff").value.trim();
  const stopAddresses = parseStopAddresses();
  if (!pickupAddress || !dropoffAddress || !stopAddresses.length) {
    return toast("Add pickup, drop-off, and at least one extra stop.");
  }

  const res = await fetch("/api/route/optimize-stops", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pickupAddress, dropoffAddress, stopAddresses })
  });
  const data = await res.json();
  const optimized = data.optimizedStops || [];
  $("input-stop-addresses").value = optimized.join("\n");
  $("input-stops").value = String(Math.max(1, optimized.length));
  $("optimized-route-preview").innerHTML = (data.routePreview || [])
    .map((a, idx) => `<div>${idx + 1}. ${a}</div>`)
    .join("");
  toast("Stops optimized for route flow.");
  updateFarePreview();
});

const multipliers = { bike: 1, car: 1.25, van: 1.55, truck: 1.95 };

function estimateDist(pickup, dropoff) {
  if (!pickup || !dropoff) return 3;
  let h = 0;
  for (const c of pickup + dropoff) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return Number(((h % 180) / 20 + 1.5).toFixed(1));
}

async function updateFarePreview() {
  const pickup = $("input-pickup").value;
  const dropoff = $("input-dropoff").value;
  const d = estimateDist(pickup, dropoff);
  const stopCount = Number($("input-stops").value || 1);
  const stopAddresses = parseStopAddresses();
  const promoCode = $("input-promo").value.trim();

  try {
    const res = await fetch("/api/pricing/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        size: "small",
        courierType: state.courierType,
        deliveryMode: state.deliveryMode,
        stopCount,
        stopAddresses,
        urgent: state.urgent,
        distanceKm: d,
        pickupAddress: pickup,
        promoCode
      })
    });
    const data = await res.json();
    state.pricingPreview = data;
    $("fare-preview").textContent = `€${Number(data.total || 0).toFixed(2)}`;
    $("surge-chip").textContent = `Zone: ${data.surgeZone || "Standard"} x${Number(data.surgeMultiplier || 1).toFixed(2)}`;
    $("promo-chip").textContent = data.promoDiscount > 0
      ? `Promo ${data.promoCode}: -€${Number(data.promoDiscount).toFixed(2)}`
      : "Promo: none";
  } catch {
    $("fare-preview").textContent = "€--";
  }
}

// Confirm / Book
$("confirm-btn").addEventListener("click", async () => {
  const pickup  = $("input-pickup").value.trim();
  const dropoff = $("input-dropoff").value.trim();
  if (!pickup || !dropoff) {
    toast("Enter pickup and drop-off addresses.");
    return;
  }

  $("confirm-btn").disabled = true;
  $("confirm-btn").textContent = "Booking…";

  const distKm = estimateDist(pickup, dropoff);
  const stopCount = Math.max(1, Number($("input-stops").value || 1));
  const stopAddresses = parseStopAddresses();
  const promoCode = $("input-promo").value.trim();
  const recipientName = $("input-recipient").value.trim();
  const recipientPhone = ($("input-recipient-phone") && $("input-recipient-phone").value.trim()) || "";

  try {
    const res = await fetch("/api/deliveries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        senderName: state.user?.name || "Precious",
        pickupAddress: pickup,
        dropoffAddress: dropoff,
        itemCategory: state.itemCategory,
        size: "small",
        courierType: state.courierType,
        deliveryMode: state.deliveryMode,
        scheduledAt: $("input-scheduled").value || "",
        stopCount,
        stopAddresses,
        urgent: state.urgent,
        paymentType: state.paymentType,
        distanceKm: distKm,
        promoCode,
        recipientName,
        recipientPhone
      })
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || "Booking failed."); return; }

    state.activeId = data.id;
    showScreen("tracking");
    initTracking(data);
    addRecentCard(data);
    addNotification(`Delivery ${data.id} booked successfully.`);
    toast(`Booking confirmed! Share PIN ${data.securityPin} with recipient.`);
  } catch {
    toast("Network error. Try again.");
  } finally {
    $("confirm-btn").disabled = false;
    const total = Number(state.pricingPreview?.total || 0);
    $("confirm-btn").innerHTML = `Confirm · est. <span id="fare-preview">€${total.toFixed(2)}</span>`;
  }
});

// ─── HOME — RECENT LIST ───────────────────────────────────
const catIcon = { Parcel:"📦", Documents:"📄", Food:"🍔", Medicine:"💊", Electronics:"💻", Other:"📦" };
const catClass = { Documents:"doc", Medicine:"doc" };

function addRecentCard(delivery) {
  const list = $("recent-list");
  const emp  = list.querySelector(".recent-empty");
  if (emp) emp.remove();

  const status = delivery.status === "Delivered" ? "Done" : delivery.status;
  const bc =
    delivery.status === "Delivered" ? "badge-done" :
    delivery.status === "Cancelled" ? "badge-cancelled" :
    delivery.status === "Matching"  ? "badge-matching" : "badge-active";

  const card = document.createElement("div");
  card.className = "recent-card";
  card.innerHTML = `
    <span class="recent-icon ${catClass[delivery.itemCategory] || ""}">
      ${catIcon[delivery.itemCategory] || "📦"}
    </span>
    <div class="recent-body">
      <div class="recent-addr">${delivery.dropoffAddress}</div>
      <div class="recent-meta">${delivery.itemCategory} · €${delivery.fare.toFixed(2)}</div>
    </div>
    <span class="recent-badge ${bc}">${status}</span>
  `;
  card.addEventListener("click", () => {
    state.activeId = delivery.id;
    showScreen("tracking");
    pollOnce(delivery.id);
  });
  list.prepend(card);
}

// ─── TRACKING SCREEN ──────────────────────────────────────
const FLOW = ["Requested","Matching","Matched","Picked Up","In Transit","Delivered"];
const PROGRESS = { Requested:5, Matching:20, Matched:42, "Picked Up":62, "In Transit":83, Delivered:100 };
const STATUS_TEXT = {
  Requested: "Placing order…",
  Matching:  "Finding your driver…",
  Matched:   "Driver on the way",
  "Picked Up": "Item collected!",
  "In Transit": "En route to you",
  Delivered: "Delivered! 🎉"
};
const ETAS = { Matched:"~4 min", "Picked Up":"~7 min", "In Transit":"Tracking…" };

function initTracking(delivery) {
  connectSocket();
  renderTracking(delivery);
  loadChat();
  loadHandoffQr(delivery.id);
  if (state.socket?.connected && delivery.id) state.socket.emit("join:delivery", delivery.id);
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => pollOnce(state.activeId), 2500);
}

async function pollOnce(id) {
  try {
    const res  = await fetch("/api/deliveries");
    const list = await res.json();
    const d    = list.find((x) => x.id === id);
    if (d) renderTracking(d);
    if (d?.status === "Delivered" || d?.status === "Cancelled") clearInterval(state.pollTimer);
  } catch { /* silent */ }
}

function renderTracking(d) {
  const badge = $("track-badge");
  badge.textContent = d.status;
  badge.style.background = d.status === "Delivered"
    ? "rgba(16,185,129,.15)" : d.status === "Cancelled"
    ? "rgba(239,68,68,.15)"  : "rgba(16,185,129,.15)";

  const progressPct = PROGRESS[d.status] || 5;
  $("track-progress").style.width = `${progressPct}%`;
  $("track-eta").textContent  = d.etaMinutes > 0 ? `${d.etaMinutes} min` : ETAS[d.status] || (d.status === "Delivered" ? "Done" : "…");
  $("track-dist").textContent = d.distanceKm ? `${d.distanceKm} km` : "—";

  if (d.driver) {
    const initials = d.driver.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
    $("track-ava").textContent         = initials;
    $("track-driver-name").textContent = d.driver.name;
    $("track-plate").textContent       = `${d.driver.vehicle} · ${d.itemCategory || "Package"}`;
    $("driver-info-card").classList.remove("hidden");
  } else {
    $("driver-info-card").classList.add("hidden");
  }

  const routePath = $("route-path");
  const courierMarker = $("courier-marker");
  const usePathFallback = !state.lastLiveGpsAt || Date.now() - state.lastLiveGpsAt > 12000;
  if (usePathFallback && routePath && courierMarker && typeof routePath.getTotalLength === "function") {
    const pathLen = routePath.getTotalLength();
    const clamped = Math.max(0.05, Math.min(1, progressPct / 100));
    const point = routePath.getPointAtLength(pathLen * clamped);
    courierMarker.setAttribute("transform", `translate(${point.x},${point.y})`);
  }

  if (!d.driver) {
    $("driver-live-pos").textContent = "Driver location: searching nearby couriers";
  } else if (d.status === "Matched") {
    $("driver-live-pos").textContent = `Driver location: heading to pickup (${d.driver.name})`;
  } else if (d.status === "Picked Up" || d.status === "In Transit") {
    $("driver-live-pos").textContent = "Driver location: package in transit";
  } else if (d.status === "Delivered") {
    $("driver-live-pos").textContent = "Driver location: delivery completed";
  } else {
    $("driver-live-pos").textContent = "Driver location: route initializing";
  }
  $("map-updated-at").textContent = `Updated ${new Date().toLocaleTimeString()}`;

  const hist = $("track-history");
  hist.innerHTML = (d.history || []).slice(-6).reverse().map((h) => {
    const done = FLOW.indexOf(h.status.split(" (")[0]) <= FLOW.indexOf(d.status);
    return `<div class="th-row">
      <span class="th-dot ${done ? "done" : ""}"></span>
      <span>${h.status} · ${new Date(h.at).toLocaleTimeString()}</span>
    </div>`;
  }).join("");

  $("track-pin-input").placeholder = d.pinVerified
    ? "PIN verified"
    : `Recipient PIN required (${d.securityPin || "----"})`;
  $("track-pin-btn").disabled = Boolean(d.pinVerified);

  const pickedUpEntry = (d.history || []).find((h) => h.status === "Picked Up");
  const deliveredEntry = (d.history || []).find((h) => h.status === "Delivered");
  $("mile-pickedup-time").textContent = pickedUpEntry ? new Date(pickedUpEntry.at).toLocaleTimeString() : "Pending";
  $("mile-delivered-time").textContent = deliveredEntry ? new Date(deliveredEntry.at).toLocaleTimeString() : "Pending";
  $("mile-pickedup-card").classList.toggle("complete", Boolean(pickedUpEntry));
  $("mile-delivered-card").classList.toggle("complete", Boolean(deliveredEntry));

  const pay = $("payment-status-line");
  if (pay) pay.textContent = `Payment: ${d.paymentStatus || "unpaid"}`;
  void renderRatingsPanel(d);
}

$("new-delivery-btn").addEventListener("click", () => {
  clearInterval(state.pollTimer);
  state.activeId = null;
  $("input-pickup").value  = "";
  $("input-dropoff").value = "";
  showScreen("home");
});

$("track-pin-btn").addEventListener("click", async () => {
  if (!state.activeId) return;
  const pin = $("track-pin-input").value.trim();
  if (!pin) return toast("Enter recipient PIN first.");
  const res = await fetch(`/api/deliveries/${state.activeId}/verify-pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin })
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "PIN verification failed.");
  toast("PIN verified successfully.");
  pollOnce(state.activeId);
});

$("payment-hold-btn")?.addEventListener("click", async () => {
  if (!state.activeId) return toast("Open a delivery first.");
  if (!state.token) return toast("Log in to authorize payment.");
  const res = await fetch("/api/payments/create-intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deliveryId: state.activeId })
  });
  const data = await res.json();
  if (!res.ok) return toast(data.error || "Payment intent failed.");
  if (data.mock) {
    toast(data.message || "Demo payment authorized.");
    pollOnce(state.activeId);
    return;
  }
  if (!data.clientSecret || !data.publishableKey) return toast("Add STRIPE_PUBLISHABLE_KEY for the card form.");
  if (typeof Stripe === "undefined") return toast("Stripe.js not loaded.");
  const stripe = Stripe(data.publishableKey);
  const cardWrap = $("card-element");
  if (cardWrap) cardWrap.classList.remove("hidden");
  if (!state.stripeCard) {
    const elements = stripe.elements();
    state.stripeCard = elements.create("card");
    state.stripeCard.mount("#card-element");
  }
  const { error } = await stripe.confirmCardPayment(data.clientSecret, { payment_method: { card: state.stripeCard } });
  if (error) return toast(error.message);
  toast("Payment authorized.");
  pollOnce(state.activeId);
});

$("pickup-save-btn")?.addEventListener("click", async () => {
  if (!state.activeId) return;
  const input = $("pickup-photo");
  if (!input || !input.files || !input.files.length) return toast("Choose a pickup photo first.");
  const fd = new FormData();
  fd.append("photo", input.files[0]);
  const res = await fetch(`/api/deliveries/${state.activeId}/pickup-proof`, { method: "POST", body: fd });
  const err = await res.json().catch(() => ({}));
  if (!res.ok) return toast(err.error || "Upload failed.");
  toast("Pickup proof saved.");
  pollOnce(state.activeId);
});

$("fcm-send-test")?.addEventListener("click", async () => {
  const userId = $("fcm-target-user")?.value?.trim();
  if (!userId) return toast("Enter target user id (e.g. u_sender).");
  const res = await fetch("/api/admin/push-test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId,
      title: "SwiftDrop",
      body: "Test push from admin console."
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || "FCM test failed.");
  toast(`FCM: ${data.successCount ?? 0} ok · ${data.failureCount ?? 0} failed`);
});

// ─── HISTORY SCREEN ───────────────────────────────────────
const pillColour = (s) => ({
  Matching:    "badge-matching",
  Matched:     "badge-active",
  "Picked Up": "badge-active",
  "In Transit":"badge-active",
  Delivered:   "badge-done",
  Cancelled:   "badge-cancelled"
}[s] || "badge-active");

async function loadHistory() {
  const [dr, sr, hr] = await Promise.all([fetch("/api/deliveries"), fetch("/api/stats"), fetch("/api/dispatch/heatmap")]);
  const [deliveries, stats, heatmap] = await Promise.all([dr.json(), sr.json(), hr.json()]);
  loadAnalytics();
  loadSupportTickets();
  loadSurgeZones();
  loadAdminReviewQueues();
  loadIntegrationsMeta();
  loadLiveMap();
  $("surge-editor").classList.toggle("hidden", state.role !== "admin");

  $("ops-stats").innerHTML = `
    <div class="ops-stat"><span>Active</span><strong>${stats.active}</strong></div>
    <div class="ops-stat"><span>Delivered</span><strong>${stats.completed}</strong></div>
    <div class="ops-stat"><span>Revenue</span><strong>€${stats.grossRevenue.toFixed(2)}</strong></div>
    <div class="ops-stat"><span>Platform</span><strong>€${stats.platformRevenue.toFixed(2)}</strong></div>
  `;

  const matching = deliveries.filter((d) => d.status === "Matching").slice(0, 4);
  const inProgress = deliveries.filter((d) => ["Matched", "Picked Up", "In Transit"].includes(d.status)).slice(0, 4);
  const completed = deliveries.filter((d) => d.status === "Delivered").slice(0, 4);
  $("admin-matching").innerHTML = matching.length
    ? matching.map((d) => `<div class="admin-item">${d.itemCategory} · ${d.pickupAddress}</div>`).join("")
    : "<div class='admin-item'>No active matching</div>";
  $("admin-progress").innerHTML = inProgress.length
    ? inProgress.map((d) => `<div class="admin-item">${d.status} · ${d.dropoffAddress}</div>`).join("")
    : "<div class='admin-item'>No active jobs</div>";
  $("admin-complete").innerHTML = completed.length
    ? completed.map((d) => `<div class="admin-item">€${d.fare.toFixed(2)} · ${d.dropoffAddress}</div>`).join("")
    : "<div class='admin-item'>No completed jobs</div>";

  const zones = heatmap?.zones || [];
  $("heatmap-list").innerHTML = zones.length
    ? zones
        .map(
          (z) =>
            `<div class="heatmap-item"><span>${z.zone}: ${z.activeOrders} orders / ${z.onlineDrivers} drivers</span><span class="pressure-chip pressure-${z.pressure}">${z.pressure}</span></div>`
        )
        .join("")
    : "<div class='heatmap-item'>No zone data</div>";

  const feed = $("history-feed");
  if (!deliveries.length) {
    feed.innerHTML = "<p style='color:#5a6478;font-size:.85rem;'>No deliveries yet.</p>";
    return;
  }

  const statusFlow = ["Matched","Picked Up","In Transit","Delivered"];
  feed.innerHTML = deliveries.map((d) => {
    const idx  = statusFlow.indexOf(d.status);
    const next = idx > -1 && idx < statusFlow.length - 1 ? statusFlow[idx + 1] : null;
    const pc   = pillColour(d.status);
    return `
      <div class="hcard">
        <div class="hcard-top">
          <span class="hcard-id">${d.id}</span>
          <span class="recent-badge ${pc}">${d.status}</span>
        </div>
        <p><b>${d.pickupAddress}</b> → ${d.dropoffAddress}</p>
        <p><b>${d.itemCategory}</b> · ${d.courierType?.toUpperCase()} · €${d.fare.toFixed(2)} · ETA ${d.etaMinutes ?? "-"}m</p>
        <p>Stops: ${(d.stopAddresses && d.stopAddresses.length) || d.stopCount || 1}</p>
        <p>Driver: ${d.driver ? d.driver.name : "Awaiting driver"}</p>
        <button class="hcard-advance" data-id="${d.id}" data-next="${next}" ${next ? "" : "disabled"}>
          ${next ? `→ Mark as ${next}` : "Complete"}
        </button>
      </div>
    `;
  }).join("");

  feed.querySelectorAll(".hcard-advance:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.dataset.next === "Delivered") {
        const pin = window.prompt("Enter recipient PIN to complete delivery:");
        if (!pin) return;
        const verify = await fetch(`/api/deliveries/${btn.dataset.id}/verify-pin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin })
        });
        if (!verify.ok) {
          const v = await verify.json();
          return toast(v.error || "PIN verification failed.");
        }
      }
      await fetch(`/api/deliveries/${btn.dataset.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: btn.dataset.next })
      });
      loadHistory();
    });
  });
}

// ─── DRIVER DASHBOARD ─────────────────────────────────────
async function loadDriverDashboard() {
  const res = await fetch(`/api/drivers/${state.driverId}/dashboard`);
  if (!res.ok) return;
  const { driver, wallet, payout, offers, activeJob } = await res.json();

  // header
  $("driver-name-top").textContent  = driver.name;
  $("dstat-earnings").textContent   = `€${wallet.balance.toFixed(2)}`;
  $("dstat-trips").textContent      = wallet.completedJobs;
  $("dstat-rating").textContent     = Number(driver.rating || 4.9).toFixed(1);

  const pill = $("online-pill");
  pill.textContent = driver.online ? "Online" : "Offline";
  pill.classList.toggle("offline", !driver.online);
  state.driverOnline = driver.online;

  const gpsCb = $("driver-use-real-gps");
  if (gpsCb) {
    gpsCb.checked = localStorage.getItem("swiftdrop_use_real_gps") !== "0";
    if (!state._gpsToggleWired) {
      state._gpsToggleWired = true;
      gpsCb.addEventListener("change", (e) => {
        localStorage.setItem("swiftdrop_use_real_gps", e.target.checked ? "1" : "0");
        loadDriverDashboard();
      });
    }
  }

  renderBankDetails(driver.bankDetails || {});
  $("bank-save-meta").textContent = driver.bankDetails?.iban
    ? "Bank details on file for payout."
    : "Fill details to receive payouts.";
  const reqs = Array.isArray(payout?.lastRequests) ? payout.lastRequests : [];
  renderPayoutHistory(reqs);
  $("payout-meta").textContent = `Minimum payout: €${Number(payout?.minAmount || 20).toFixed(2)}`;
  const docsRes = await fetch(`/api/drivers/${state.driverId}/documents`);
  const docs = await docsRes.json();
  renderDocuments(docs || []);
  renderOnboarding(driver, docs || []);

  // offer section
  const offerSec = $("offer-section");
  const noMsg    = $("no-offer-msg");

  // clear old timers
  Object.values(state.offerTimers).forEach(clearInterval);
  state.offerTimers = {};

  if (!offers.length) {
    offerSec.innerHTML = `<p class="no-offer-msg">Waiting for delivery requests…</p>`;
    // show active job if any
    renderActiveJob(activeJob);
    return;
  }

  const offer = offers[0]; // show top offer prominently
  offerSec.innerHTML = `
    <div class="offer-title">
      New delivery request
      <span class="offer-earnings">+€${offer.fare.toFixed(2)}</span>
    </div>
    <div class="offer-route">
      <div class="offer-stop">
        <span class="dot orange-dot"></span>
        ${offer.pickupAddress} · ${offer.distanceKm}km away
      </div>
      <div class="offer-stop">
        <span class="dot green-dot"></span>
        ${offer.dropoffAddress} · total ${(offer.distanceKm * 1.4).toFixed(1)}km
      </div>
    </div>
    <div class="offer-btns">
      <button class="btn-accept" id="do-accept">Accept</button>
      <button class="btn-decline" id="do-decline">Decline</button>
    </div>
    <div class="offer-timer" id="offer-timer">${offer.expiresInSeconds}s remaining</div>
  `;

  // countdown
  let secs = offer.expiresInSeconds;
  state.offerTimers["main"] = setInterval(() => {
    secs -= 1;
    const el = $("offer-timer");
    if (el) el.textContent = `${Math.max(0, secs)}s remaining`;
    if (secs <= 0) { clearInterval(state.offerTimers["main"]); loadDriverDashboard(); }
  }, 1000);

  $("do-accept").addEventListener("click", async () => {
    clearInterval(state.offerTimers["main"]);
    await fetch(`/api/drivers/${state.driverId}/offers/${offer.deliveryId}/accept`, { method: "POST" });
    toast("Job accepted!");
    loadDriverDashboard();
  });

  $("do-decline").addEventListener("click", async () => {
    clearInterval(state.offerTimers["main"]);
    await fetch(`/api/drivers/${state.driverId}/offers/${offer.deliveryId}/decline`, { method: "POST" });
    loadDriverDashboard();
  });

  renderActiveJob(activeJob);
}

function renderActiveJob(job) {
  const lastLabel = $("last-label");
  const lastJobs  = $("last-jobs");

  if (!job) {
    lastLabel.style.display = "none";
    lastJobs.innerHTML = "";
    stopDriverGpsTracking();
    return;
  }

  lastLabel.style.display = "block";

  const statusFlow = ["Matched", "Picked Up", "In Transit", "Delivered"];
  const idx  = statusFlow.indexOf(job.status);
  const next = idx > -1 && idx < statusFlow.length - 1 ? statusFlow[idx + 1] : null;

  lastJobs.innerHTML = `
    <div class="last-job-card">
      <div class="lj-icon">${catIcon[job.itemCategory] || "📦"}</div>
      <div class="lj-body">
        <div class="lj-title">${job.itemCategory} · ${job.dropoffAddress}</div>
        <div class="lj-meta">${job.status}</div>
      </div>
      <span class="lj-earn">€${job.fare.toFixed(2)}</span>
    </div>
    ${next ? `<button class="hcard-advance" id="job-advance" style="margin-top:6px">→ Mark as ${next}</button>` : ""}
  `;

  if (job && state.role === "driver" && state.driverOnline) {
    startDriverLocationTracking(job);
  } else {
    stopDriverGpsTracking();
  }

  const adv = $("job-advance");
  if (adv) {
    adv.addEventListener("click", async () => {
      if (next === "Delivered") {
        const pin = window.prompt("Enter recipient PIN to complete delivery:");
        if (!pin) return;
        const verify = await fetch(`/api/deliveries/${job.id}/verify-pin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin })
        });
        if (!verify.ok) {
          const v = await verify.json();
          return toast(v.error || "PIN verification failed.");
        }
      }
      await fetch(`/api/deliveries/${job.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next })
      });
      loadDriverDashboard();
    });
  }
}

// Online toggle
$("online-pill").addEventListener("click", async () => {
  const next = !state.driverOnline;
  await fetch(`/api/drivers/${state.driverId}/online`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ online: next })
  });
  toast(next ? "You are now online" : "You are now offline");
  loadDriverDashboard();
});

// Auto-refresh driver panel
setInterval(() => {
  if ($("screen-profile").classList.contains("active")) loadDriverDashboard();
  if ($("screen-history").classList.contains("active")) loadHistory();
}, 6000);

function connectLiveEvents() {
  try {
    const events = new EventSource("/api/events");
    const refresh = () => {
      if ($("screen-history").classList.contains("active")) loadHistory();
      if ($("screen-profile").classList.contains("active")) loadDriverDashboard();
      if (state.activeId) pollOnce(state.activeId);
    };
    events.addEventListener("delivery.created", (e) => {
      refresh();
      try {
        const payload = JSON.parse(e.data || "{}");
        if (payload.id) addNotification(`New delivery request created (${payload.id}).`);
      } catch {
        addNotification("New delivery request created.");
      }
    });
    events.addEventListener("delivery.updated", (e) => {
      refresh();
      try {
        const payload = JSON.parse(e.data || "{}");
        const d = payload.delivery || payload;
        if (d?.id && d?.status) {
          addNotification(`Delivery ${d.id}: ${d.status}.`);
        }
      } catch {
        addNotification("A delivery was updated.");
      }
    });
    events.addEventListener("driver.updated", (e) => {
      refresh();
      try {
        const payload = JSON.parse(e.data || "{}");
        const driverRef = payload.driverId || payload.id;
        if (driverRef) {
          if (payload.bankDetailsUpdated) {
            addNotification(`Driver ${driverRef} bank details updated.`);
          } else {
            addNotification(`Driver ${driverRef} availability changed.`);
          }
        }
      } catch {
        addNotification("Driver status updated.");
      }
    });
    events.addEventListener("chat.updated", (e) => {
      try {
        const payload = JSON.parse(e.data || "{}");
        if (payload.deliveryId === state.activeId) loadChat();
        addNotification("New chat message on order.");
      } catch {
        addNotification("Chat updated.");
      }
    });
  } catch {
    // Keep polling fallback.
  }
}

// ─── Boot ─────────────────────────────────────────────────
updateFarePreview();
initTheme();
connectSocket();
connectLiveEvents();
showScreen("home");
loadDemoUsers();
$("auth-email").value = "sender@swiftdrop.app";
$("auth-password").value = "demo123";
renderPasswordStrength("");
renderNotifications();
const savedSession = localStorage.getItem(SESSION_KEY);
const savedToken = localStorage.getItem(TOKEN_KEY) || "";
if (savedSession) {
  try {
    const parsed = JSON.parse(savedSession);
    if (parsed?.role && parsed?.name) {
      state.token = savedToken;
      completeAuth(parsed);
    } else {
      showAuthLayer("start-screen");
    }
  } catch {
    showAuthLayer("start-screen");
  }
} else {
  showAuthLayer("start-screen");
  $("profile-menu-wrap").classList.add("hidden");
}
