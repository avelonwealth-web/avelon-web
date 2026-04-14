const admin = require("firebase-admin");

function initAdmin() {
  if (admin.apps.length) return;
  var raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders(), extraHeaders || {}),
    body: JSON.stringify(body),
  };
}

/** Browser preflight for authenticated POST calls (cross-origin / localhost dev). */
function preflight(event) {
  if (!event || event.httpMethod !== "OPTIONS") return null;
  return { statusCode: 204, headers: Object.assign({ "Content-Length": "0" }, corsHeaders()) };
}

async function requireUser(event) {
  initAdmin();
  var h = event.headers || {};
  var auth = h.authorization || h.Authorization || "";
  var m = /^Bearer\s+(.+)$/i.exec(String(auth || ""));
  if (!m) return { ok: false, statusCode: 401, error: "missing_auth" };
  try {
    var decoded = await admin.auth().verifyIdToken(m[1]);
    return { ok: true, uid: decoded.uid, decoded };
  } catch (e) {
    return { ok: false, statusCode: 401, error: "bad_token" };
  }
}

async function requireAdmin(event) {
  var u = await requireUser(event);
  if (!u.ok) return u;
  var db = admin.firestore();
  var snap = await db.collection("users").doc(u.uid).get();
  var d = snap.exists ? snap.data() : null;
  if (!d || d.role !== "admin") return { ok: false, statusCode: 403, error: "admin_only" };
  return u;
}

module.exports = {
  admin,
  initAdmin,
  json,
  corsHeaders,
  preflight,
  requireUser,
  requireAdmin,
};

