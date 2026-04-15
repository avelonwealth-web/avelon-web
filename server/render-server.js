"use strict";

/**
 * Render.com web service: runs the same Netlify function handlers for API + PayMongo webhook.
 *
 * Env (same as Netlify): PAYMONGO_WEBHOOK_SECRET, PAYMONGO_SECRET_KEY, FIREBASE_*, etc.
 *
 * Routes:
 *   POST /webhook/paymongo          — raw JSON body (signature verification)
 *   POST /functions/paymongoWebhook — alias for PayMongo dashboard compatibility
 *   POST|GET /api/:functionName     — JSON API (Bearer Firebase ID token when required)
 *
 * Frontend: set AVELON_FUNCTIONS_BASE at build time to https://YOUR-SERVICE.onrender.com/api
 */

try {
  require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
} catch (e) {}

const express = require("express");
const path = require("path");

const functionsDir = path.join(__dirname, "..", "netlify", "functions");

/** Handlers we expose (exclude _lib, scripts, and webhook on generic JSON path). */
var ALLOWED = new Set([
  "adminAdjustBalance",
  "adminApproveWithdrawal",
  "adminCustomToken",
  "adminDeleteUser",
  "adminListUsersMerged",
  "adminLiveData",
  "adminReconcileUserDeposits",
  "adminRejectWithdrawal",
  "buyVip",
  "completeRegistration",
  "createCheckout",
  "depositSyncStatus",
  "requestWithdrawal",
  "rewardsEligibility",
  "syncProfileFromAuth",
  "tradeCreateRound",
  "userDownlineSummary",
  "vipDailyCommissionCron",
]);

var app = express();
// Render injects PORT; must listen on 0.0.0.0 (all interfaces), not localhost only.
var PORT = Number(process.env.PORT);
if (!isFinite(PORT) || PORT <= 0) PORT = 3000;
var HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";

function corsHeaders(req, res, next) {
  var allow = String(process.env.CORS_ORIGIN || "*").trim() || "*";
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Paymongo-Signature, paymongo-signature, X-Avelon-Public-Origin"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

app.use(corsHeaders);

function wrapNetlifyResponse(expressRes, result) {
  if (!result) {
    expressRes.status(500).json({ error: "empty_handler_result" });
    return;
  }
  var sc = Number(result.statusCode) || 500;
  var headers = result.headers || {};
  Object.keys(headers).forEach(function (k) {
    try {
      expressRes.setHeader(k, headers[k]);
    } catch (e) {}
  });
  var body = result.body;
  if (typeof body === "string") {
    expressRes.status(sc).send(body);
    return;
  }
  expressRes.status(sc).json(body != null ? body : {});
}

function invokeHandler(name, event) {
  var mod = require(path.join(functionsDir, name + ".js"));
  if (!mod || typeof mod.handler !== "function") {
    return Promise.reject(new Error("no_handler"));
  }
  return mod.handler(event);
}

function headersFromReq(req) {
  var h = {};
  Object.keys(req.headers || {}).forEach(function (k) {
    h[k] = req.headers[k];
  });
  return h;
}

/** PayMongo: preserve raw bytes for HMAC verification. */
var rawParser = express.raw({
  type: function () {
    return true;
  },
  limit: "512kb",
});

app.get("/health", function (_req, res) {
  res.status(200).json({
    ok: true,
    service: "avelon-render-api",
    time: new Date().toISOString(),
  });
});

app.get("/", function (_req, res) {
  res.status(200).json({ ok: true, service: "avelon-render-api", health: "/health", api: "/api/:functionName" });
});

function handlePaymongoWebhook(req, res, next) {
  var rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
  var event = {
    httpMethod: "POST",
    path: req.path,
    headers: headersFromReq(req),
    body: rawBody,
    isBase64Encoded: false,
  };
  invokeHandler("paymongoWebhook", event)
    .then(function (result) {
      wrapNetlifyResponse(res, result);
    })
    .catch(function (e) {
      res.status(500).json({ error: "webhook_invoke_failed", detail: String((e && e.message) || e) });
    });
}

app.post("/webhook/paymongo", rawParser, handlePaymongoWebhook);
app.post("/functions/paymongoWebhook", rawParser, handlePaymongoWebhook);

app.use(express.json({ limit: "1mb" }));

app.all("/api/:name", function (req, res) {
  var name = String(req.params.name || "").trim();
  if (!ALLOWED.has(name)) {
    res.status(404).json({ error: "unknown_function", name: name });
    return;
  }
  var bodyStr = "";
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      bodyStr = JSON.stringify(req.body && typeof req.body === "object" ? req.body : {});
    } catch (e) {
      bodyStr = "{}";
    }
  }
  var event = {
    httpMethod: req.method,
    path: req.path,
    headers: headersFromReq(req),
    body: bodyStr,
    isBase64Encoded: false,
    queryStringParameters: req.query,
  };
  invokeHandler(name, event)
    .then(function (result) {
      wrapNetlifyResponse(res, result);
    })
    .catch(function (e) {
      res.status(500).json({ error: "invoke_failed", detail: String((e && e.message) || e) });
    });
});

app.use(function (_req, res) {
  res.status(404).json({ error: "not_found" });
});

app.listen(PORT, HOST, function () {
  console.log("[render-server] listening on http://" + HOST + ":" + PORT);
});
