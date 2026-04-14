"use strict";

try {
  require("dotenv").config({ path: require("path").join(__dirname, ".env") });
} catch (e) {
  /* optional */
}

try {
  require("child_process").execSync("node netlify/scripts/inject-firebase-config.cjs", {
    cwd: __dirname,
    stdio: "inherit",
    env: process.env,
  });
} catch (e) {
  console.warn(
    "[dev-server] Firebase config inject skipped (set FIREBASE_WEB_API_KEY in .env — see .env.example)"
  );
}

/**
 * Local dev: one process for static files + POST /adminCustomToken (operator login).
 * Do not use VS Code Live Server for this project — it cannot serve /adminCustomToken.
 *
 * 1. Firebase Console → Project settings → Service accounts → Generate new private key
 * 2. Save JSON as: .secrets/serviceAccount.json  (folder is gitignored)
 * 3. npm install && npm start
 * 4. Open http://127.0.0.1:5500/login.html
 *
 * Password defaults to Matt@5494@ or set ADMIN_OPERATOR_PASSWORD.
 */
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT) || 5500;
const publicDir = path.join(__dirname, "public");

const ADMIN_SYNTHETIC_EMAIL = "639152444480@phone.avelon-wealth.local";
const expectedPw = process.env.ADMIN_OPERATOR_PASSWORD || "Matt@5494@";

function normalizeMobileToAuthEmail(mobile) {
  var d = String(mobile || "").replace(/\D/g, "");
  var e164 = null;
  if (d.indexOf("63") === 0 && d.length >= 12) e164 = d.slice(0, 12);
  else if (d.length === 11 && d.charAt(0) === "0" && d.charAt(1) === "9") e164 = "63" + d.slice(1);
  else if (d.length === 10 && d.charAt(0) === "9") e164 = "63" + d;
  if (!e164 || !/^639\d{9}$/.test(e164)) return null;
  return e164 + "@phone.avelon-wealth.local";
}

function loadServiceAccountJson() {
  var env = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (env) {
    try {
      return JSON.parse(env);
    } catch (e) {
      console.error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
      return null;
    }
  }
  var p = path.join(__dirname, ".secrets", "serviceAccount.json");
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      console.error("Could not read .secrets/serviceAccount.json:", e.message);
      return null;
    }
  }
  return null;
}

const admin = require("firebase-admin");

function getAdminApp() {
  if (admin.apps.length) return admin;
  var json = loadServiceAccountJson();
  if (!json) return null;
  admin.initializeApp({ credential: admin.credential.cert(json) });
  return admin;
}

app.use(express.json({ limit: "32kb" }));

function cors(res, req) {
  var origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

app.options("/adminCustomToken", function (req, res) {
  cors(res, req);
  res.sendStatus(204);
});

app.post("/adminCustomToken", async function (req, res) {
  cors(res, req);
  var a = getAdminApp();
  if (!a) {
    res.status(503).json({ error: "not_configured" });
    return;
  }
  try {
    var authEmail = normalizeMobileToAuthEmail(req.body && req.body.mobile);
    if (authEmail !== ADMIN_SYNTHETIC_EMAIL) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (!req.body || req.body.password !== expectedPw) {
      res.status(401).json({ error: "wrong_password" });
      return;
    }
    var uid;
    try {
      var u = await a.auth().getUserByEmail(ADMIN_SYNTHETIC_EMAIL);
      uid = u.uid;
    } catch (e) {
      if (e.code !== "auth/user-not-found") throw e;
      var created = await a.auth().createUser({
        email: ADMIN_SYNTHETIC_EMAIL,
        password: crypto.randomBytes(24).toString("hex"),
        emailVerified: false,
      });
      uid = created.uid;
    }
    var token = await a.auth().createCustomToken(uid);
    res.status(200).json({ customToken: token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.use(express.static(publicDir));

app.listen(PORT, "127.0.0.1", function () {
  console.log("");
  console.log(" AVELON — http://127.0.0.1:" + PORT + "/login.html");
  if (!loadServiceAccountJson()) {
    console.log("");
    console.log("  Operator login needs a service account JSON:");
    console.log("    Save it as .secrets/serviceAccount.json");
    console.log("    (Firebase Console → Project settings → Service accounts → Generate key)");
    console.log("");
  } else {
    getAdminApp();
  }
  console.log("  Operator password:", expectedPw === "Matt@5494@" ? "Matt@5494@ (default)" : "(from ADMIN_OPERATOR_PASSWORD)");
  console.log("");
});
