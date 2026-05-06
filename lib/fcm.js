/**
 * Firebase Cloud Messaging (FCM) helper via firebase-admin.
 *
 * Configure one of:
 *   FIREBASE_SERVICE_ACCOUNT_PATH — absolute or relative path to service account JSON
 *   FIREBASE_SERVICE_ACCOUNT_JSON — full JSON string (escape carefully in .env)
 *   GOOGLE_APPLICATION_CREDENTIALS — Google standard env (path to JSON)
 */

const fs = require("fs");
const path = require("path");
const { all } = require("../db");

let messaging = null;
let initAttempted = false;

function loadServiceAccount() {
  const explicit = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (e) {
      console.warn("[fcm] FIREBASE_SERVICE_ACCOUNT_JSON parse error:", e.message);
      return null;
    }
  }
  const p = explicit || gac;
  if (!p) return null;
  const resolved = path.isAbsolute(p) ? p : path.join(__dirname, "..", p);
  if (!fs.existsSync(resolved)) {
    console.warn("[fcm] Service account file not found:", resolved);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (e) {
    console.warn("[fcm] Could not read service account:", e.message);
    return null;
  }
}

function ensureInit() {
  if (messaging) return;
  if (initAttempted) return;
  initAttempted = true;

  const account = loadServiceAccount();
  if (!account) return;

  try {
    const admin = require("firebase-admin");
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(account)
      });
    }
    messaging = admin.messaging();
  } catch (e) {
    console.warn("[fcm] firebase-admin init failed:", e.message);
  }
}

function isReady() {
  ensureInit();
  return Boolean(messaging);
}

/**
 * @param {string[]} tokens — FCM registration tokens
 * @param {{ title?: string, body?: string, data?: Record<string,string|number|boolean> }} payload
 */
async function sendToTokens(tokens, { title = "SwiftDrop", body = "", data = {} } = {}) {
  ensureInit();
  const uniq = [...new Set((tokens || []).filter(Boolean))];
  if (!messaging || !uniq.length) {
    return {
      ok: false,
      error: !messaging ? "FCM not configured (set service account env)" : "No device tokens",
      successCount: 0,
      failureCount: 0
    };
  }

  const dataStr = {};
  for (const [k, v] of Object.entries(data || {})) {
    dataStr[k] = String(v ?? "");
  }

  try {
    const res = await messaging.sendEachForMulticast({
      tokens: uniq,
      notification: { title, body },
      data: dataStr
    });
    return {
      ok: true,
      successCount: res.successCount,
      failureCount: res.failureCount,
      errors: res.responses
        ?.map((r, i) => (r.success ? null : { index: i, code: r.error?.code, message: r.error?.message }))
        .filter(Boolean)
    };
  } catch (e) {
    return { ok: false, error: e.message, successCount: 0, failureCount: uniq.length };
  }
}

async function sendToUser(userId, payload) {
  const rows = all("SELECT token FROM push_tokens WHERE user_id = ?", userId);
  const tokens = rows.map((r) => r.token);
  return sendToTokens(tokens, payload);
}

module.exports = {
  ensureInit,
  isReady,
  sendToTokens,
  sendToUser
};
