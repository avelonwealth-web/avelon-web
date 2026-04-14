const admin = require("firebase-admin");

function decodeMaybeBase64(s) {
  var v = String(s || "").trim();
  if (!v) return "";
  try {
    if (/^[A-Za-z0-9+/=]+$/.test(v) && v.length % 4 === 0) {
      var d = Buffer.from(v, "base64").toString("utf8");
      if (d.indexOf("BEGIN PRIVATE KEY") >= 0 || d.indexOf("{") === 0) return d;
    }
  } catch (e) {}
  return v;
}

function normalizePrivateKey(v) {
  var key = decodeMaybeBase64(v);
  key = key.replace(/^"|"$/g, "").replace(/\\n/g, "\n").trim();
  return key;
}

function serviceAccountFromEnv() {
  var raw = decodeMaybeBase64(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "");
  if (raw) {
    return JSON.parse(raw);
  }
  var projectId = String(process.env.FIREBASE_PROJECT_ID || "").trim();
  var clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  var privateKey = normalizePrivateKey(
    process.env.FIREBASE_PRIVATE_KEY || process.env.FIREBASE_PRIVATE_KEY_B64 || ""
  );
  if (projectId && clientEmail && privateKey) {
    return { project_id: projectId, client_email: clientEmail, private_key: privateKey };
  }
  throw new Error("Missing Firebase admin credentials");
}

function initAdmin() {
  if (admin.apps.length) return;
  var sa = serviceAccountFromEnv();
  admin.initializeApp({
    credential: admin.credential.cert(sa),
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
  serviceAccountFromEnv,
  json,
  corsHeaders,
  preflight,
  requireUser,
  requireAdmin,
};

