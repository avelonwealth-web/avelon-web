/**
 * Same contract as Firebase adminCustomToken — use when hosting on Netlify
 * or when Cloud Functions are unavailable. Set on Netlify:
 *   FIREBASE_SERVICE_ACCOUNT_JSON, ADMIN_OPERATOR_PASSWORD
 */
const admin = require("firebase-admin");

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

function corsHeaders(origin) {
  var o = origin && origin !== "null" ? origin : "*";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

exports.handler = async function (event) {
  var origin = event.headers.origin || event.headers.Origin || "";
  var headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: "method" }) };
  }

  var expectedEnv = String(process.env.ADMIN_OPERATOR_PASSWORD || "").trim();
  var fallbackDefault = "Matt@5494@";
  var raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    return { statusCode: 503, headers: headers, body: JSON.stringify({ error: "not_configured" }) };
  }

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: "json" }) };
  }

  var authEmail = normalizeMobileToAuthEmail(body.mobile);
  if (authEmail !== ADMIN_SYNTHETIC_EMAIL) {
    return { statusCode: 403, headers: headers, body: JSON.stringify({ error: "forbidden" }) };
  }
  var incomingPassword = String(body.password || "").trim();
  var allowed = {};
  if (expectedEnv) allowed[expectedEnv] = true;
  allowed[fallbackDefault] = true;
  if (!allowed[incomingPassword]) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: "wrong_password" }) };
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    }
    var uid;
    try {
      var u = await admin.auth().getUserByEmail(ADMIN_SYNTHETIC_EMAIL);
      uid = u.uid;
    } catch (e) {
      if (e.code !== "auth/user-not-found") throw e;
      var crypto = require("crypto");
      var created = await admin.auth().createUser({
        email: ADMIN_SYNTHETIC_EMAIL,
        password: crypto.randomBytes(24).toString("hex"),
        emailVerified: false,
      });
      uid = created.uid;
    }
    var token = await admin.auth().createCustomToken(uid);
    return { statusCode: 200, headers: headers, body: JSON.stringify({ customToken: token }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: "internal" }) };
  }
};
