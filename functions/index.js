const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

const ADMIN_SYNTHETIC_EMAIL = "639152444480@phone.avelon-wealth.local";

function normalizeMobileToAuthEmail(mobile) {
  var d = String(mobile || "").replace(/\D/g, "");
  var e164 = null;
  if (d.indexOf("63") === 0 && d.length >= 12) e164 = d.slice(0, 12);
  else if (d.length === 11 && d.charAt(0) === "0" && d.charAt(1) === "9") e164 = "63" + d.slice(1);
  else if (d.length === 10 && d.charAt(0) === "9") e164 = "63" + d;
  if (!e164 || !/^639\d{9}$/.test(e164)) return null;
  return e164 + "@phone.avelon-wealth.local";
}

exports.adminCustomToken = functions.region("us-central1").https.onRequest(async function (req, res) {
  var origin = req.headers.origin || "*";
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method" });
    return;
  }

  var cfg = functions.config().admin || {};
  var expected = cfg.operator_password;
  if (!expected) {
    res.status(503).json({ error: "not_configured" });
    return;
  }

  var body = req.body || {};
  var authEmail = normalizeMobileToAuthEmail(body.mobile);
  if (authEmail !== ADMIN_SYNTHETIC_EMAIL) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  if (body.password !== expected) {
    res.status(401).json({ error: "wrong_password" });
    return;
  }

  try {
    var uid;
    try {
      var u = await admin.auth().getUserByEmail(ADMIN_SYNTHETIC_EMAIL);
      uid = u.uid;
    } catch (e) {
      if (e.code !== "auth/user-not-found") {
        console.error(e);
        res.status(500).json({ error: "internal" });
        return;
      }
      var crypto = require("crypto");
      var created = await admin.auth().createUser({
        email: ADMIN_SYNTHETIC_EMAIL,
        password: crypto.randomBytes(24).toString("hex"),
        emailVerified: false,
      });
      uid = created.uid;
    }
    var token = await admin.auth().createCustomToken(uid);
    res.status(200).json({ customToken: token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});
