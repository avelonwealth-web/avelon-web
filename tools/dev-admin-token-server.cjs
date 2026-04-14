/**
 * Local helper for operator login while using Live Server (127.0.0.1).
 * Uses the Admin SDK to mint the same custom token as Cloud / Netlify.
 *
 *   cd "d:\Avelon Wealth"
 *   $env:FIREBASE_SERVICE_ACCOUNT_JSON = Get-Content path\to\serviceAccount.json -Raw
 *   $env:ADMIN_OPERATOR_PASSWORD = "Matt@5494@"
 *   node tools/dev-admin-token-server.cjs
 *
 * Then open login from Live Server; the app tries http://127.0.0.1:8799/adminCustomToken first.
 */
const http = require("http");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const ADMIN_SYNTHETIC_EMAIL = "639152444480@phone.avelon-wealth.local";
const PORT = Number(process.env.PORT) || 8799;
const expectedPw = process.env.ADMIN_OPERATOR_PASSWORD || "Matt@5494@";
const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

function normalizeMobileToAuthEmail(mobile) {
  var d = String(mobile || "").replace(/\D/g, "");
  var e164 = null;
  if (d.indexOf("63") === 0 && d.length >= 12) e164 = d.slice(0, 12);
  else if (d.length === 11 && d.charAt(0) === "0" && d.charAt(1) === "9") e164 = "63" + d.slice(1);
  else if (d.length === 10 && d.charAt(0) === "9") e164 = "63" + d;
  if (!e164 || !/^639\d{9}$/.test(e164)) return null;
  return e164 + "@phone.avelon-wealth.local";
}

if (!raw) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT_JSON.");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });

const server = http.createServer(async function (req, res) {
  var origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "POST" || req.url !== "/adminCustomToken") {
    res.writeHead(req.method === "POST" ? 404 : 405);
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  var chunks = [];
  req.on("data", function (c) {
    chunks.push(c);
  });
  req.on("end", async function () {
    try {
      var body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      var authEmail = normalizeMobileToAuthEmail(body.mobile);
      if (authEmail !== ADMIN_SYNTHETIC_EMAIL) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      if (body.password !== expectedPw) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "wrong_password" }));
        return;
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ customToken: token }));
    } catch (e) {
      console.error(e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    }
  });
});

server.listen(PORT, "127.0.0.1", function () {
  console.log("Admin token helper: http://127.0.0.1:" + PORT + "/adminCustomToken");
});
