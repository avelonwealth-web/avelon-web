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

app.use(
  express.json({
    limit: "256kb",
    verify: function (req, _res, buf) {
      req.rawBody = buf ? buf.toString("utf8") : "";
    },
  })
);

function parsePaymongoSignatureHeader(header) {
  var out = { t: "", te: "", li: "" };
  String(header || "")
    .split(",")
    .forEach(function (part) {
      var i = part.indexOf("=");
      if (i < 0) return;
      var k = part.slice(0, i).trim();
      var v = part.slice(i + 1).trim();
      if (k === "t") out.t = v;
      if (k === "te") out.te = v;
      if (k === "li") out.li = v;
    });
  return out;
}

function verifyPaymongoSignature(rawBody, sigHeader, secret) {
  if (!secret) return false;
  var p = parsePaymongoSignatureHeader(sigHeader);
  if (!p.t || !rawBody) return false;
  var sig = p.li || p.te || "";
  if (!sig) return false;
  var nowSec = Math.floor(Date.now() / 1000);
  var ts = Number(p.t);
  // Reject stale payloads beyond 5 minutes.
  if (!isFinite(ts) || Math.abs(nowSec - ts) > 300) return false;
  var expected = crypto.createHmac("sha256", secret).update(p.t + "." + rawBody, "utf8").digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
  } catch (e) {
    return false;
  }
}

function toTimestampFromUnixSeconds(sec) {
  var n = Number(sec || 0);
  if (!(n > 0)) return null;
  try {
    return admin.firestore.Timestamp.fromMillis(Math.round(n * 1000));
  } catch (e) {
    return null;
  }
}

function getPath(obj, path, fallback) {
  var cur = obj;
  for (var i = 0; i < path.length; i++) {
    if (!cur || typeof cur !== "object") return fallback;
    cur = cur[path[i]];
  }
  return cur == null ? fallback : cur;
}

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

app.post("/webhook/paymongo", async function (req, res) {
  var a = getAdminApp();
  if (!a) {
    res.status(503).json({ error: "firebase_not_configured" });
    return;
  }

  var webhookSecret = String(process.env.PAYMONGO_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) {
    res.status(503).json({ error: "missing_PAYMONGO_WEBHOOK_SECRET" });
    return;
  }

  var sigHeader =
    req.headers["paymongo-signature"] || req.headers["Paymongo-Signature"] || req.headers["PayMongo-Signature"] || "";
  var rawBody = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.body || {});
  if (!verifyPaymongoSignature(rawBody, sigHeader, webhookSecret)) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  var payload = req.body || {};
  var eventId = String(getPath(payload, ["data", "id"], "") || "");
  var eventType = String(getPath(payload, ["data", "attributes", "type"], "") || "").toLowerCase();
  var payment = getPath(payload, ["data", "attributes", "data", "attributes"], {});
  var paymentId = String(getPath(payload, ["data", "attributes", "data", "id"], "") || "");
  var paymentStatus = String(payment.status || "").toLowerCase();
  var metadata = (payment && payment.metadata) || {};
  var userId = String(metadata.userId || metadata.uid || "");
  var depositId = String(metadata.depositId || "");
  var amountCentavos = Number(payment.amount || 0);
  var amountPhp = amountCentavos > 0 ? Math.round(amountCentavos) / 100 : 0;
  var createdAtTs = toTimestampFromUnixSeconds(payment.created_at);
  var paidAtTs = toTimestampFromUnixSeconds(payment.paid_at);
  var retryHeader = Number(req.headers["x-paymongo-retry"] || req.headers["paymongo-retry"] || 0);

  console.log(
    "[paymongo-webhook] received",
    JSON.stringify({
      eventId: eventId || null,
      type: eventType || null,
      paymentId: paymentId || null,
      status: paymentStatus || null,
      amountCentavos: amountCentavos || 0,
      amountPhp: amountPhp || 0,
      userId: userId || null,
      depositId: depositId || null,
      retry: retryHeader || 0,
    })
  );

  // We acknowledge non-payment.paid events to prevent provider retry storms.
  if (eventType !== "payment.paid") {
    res.status(200).json({ ok: true, ignored: true, reason: "unsupported_event_type" });
    return;
  }
  if (!eventId || !paymentId) {
    res.status(400).json({ error: "missing_event_or_payment_id" });
    return;
  }

  var db = a.firestore();
  var eventRef = db.collection("paymentWebhookEvents").doc("paymongo_" + eventId);
  var paymentRef = db.collection("payments").doc(paymentId);

  try {
    await db.runTransaction(async function (tx) {
      var existingEvt = await tx.get(eventRef);
      if (existingEvt.exists) {
        // Idempotency: do not duplicate records when PayMongo retries.
        tx.set(
          eventRef,
          {
            attempts: admin.firestore.FieldValue.increment(1),
            lastReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return;
      }

      tx.set(
        paymentRef,
        {
          paymentId: paymentId,
          userId: userId || null,
          depositId: depositId || null,
          amountPhp: amountPhp,
          amountCentavos: amountCentavos > 0 ? Math.round(amountCentavos) : 0,
          status: paymentStatus === "paid" ? "paid" : "failed",
          created_at: createdAtTs || admin.firestore.FieldValue.serverTimestamp(),
          paid_at: paidAtTs || admin.firestore.FieldValue.serverTimestamp(),
          provider: "paymongo",
          providerEventId: eventId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      tx.set(
        eventRef,
        {
          provider: "paymongo",
          eventId: eventId,
          eventType: eventType,
          paymentId: paymentId,
          retries: retryHeader > 0 ? retryHeader : 0,
          attempts: 1,
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          payloadSummary: {
            status: paymentStatus,
            amountCentavos: amountCentavos > 0 ? Math.round(amountCentavos) : 0,
            amountPhp: amountPhp,
            userId: userId || null,
            depositId: depositId || null,
          },
        },
        { merge: true }
      );
    });

    // Firestore write triggers realtime listeners immediately on subscribed clients.
    res.status(200).json({ ok: true, eventId: eventId, paymentId: paymentId });
  } catch (e) {
    var msg = String((e && e.message) || e);
    console.error("[paymongo-webhook] failed", { eventId: eventId, paymentId: paymentId, error: msg });
    res.status(500).json({ error: "webhook_processing_failed", detail: msg });
  }
});

app.get("/webhook/paymongo/health", function (_req, res) {
  var configured = {
    firebaseAdmin: !!getAdminApp(),
    paymongoWebhookSecret: !!String(process.env.PAYMONGO_WEBHOOK_SECRET || "").trim(),
  };
  res.status(200).json({
    ok: true,
    service: "paymongo-webhook",
    configured: configured,
    now: new Date().toISOString(),
  });
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
