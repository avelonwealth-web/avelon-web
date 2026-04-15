"use strict";

/**
 * Express entry for PayMongo webhooks on Render (raw body + shared Netlify handler).
 * Verifies Paymongo-Signature (HMAC-SHA256, timestamp skew) before invoking
 * netlify/functions/paymongoWebhook.js (Firestore: payments/, deposits/, idempotency).
 */

const crypto = require("crypto");
const path = require("path");
const paymongoHandler = require(path.join(__dirname, "..", "netlify", "functions", "paymongoWebhook.js"));

function parseSignatureHeader(header) {
  var out = { t: "", te: "", li: "" };
  String(header || "")
    .split(",")
    .forEach(function (part) {
      var i = part.indexOf("=");
      if (i === -1) return;
      var k = part.slice(0, i).trim();
      var v = part.slice(i + 1).trim();
      if (k === "t") out.t = v;
      if (k === "te") out.te = v;
      if (k === "li") out.li = v;
    });
  return out;
}

function normalizeWebhookSecret(s) {
  return String(s || "")
    .replace(/^\ufeff/, "")
    .trim();
}

function hmacHexEquals(macHex, sigHex) {
  if (!sigHex || !macHex) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(macHex, "hex"), Buffer.from(String(sigHex).trim(), "hex"));
  } catch (e) {
    return false;
  }
}

/** Try `li` and `te` (PayMongo live vs test sigs) and optional alt secret — see https://developers.paymongo.com/docs/creating-webhook */
function verifyPaymongoSignature(rawBody, header, secret) {
  secret = normalizeWebhookSecret(secret);
  if (!secret) return false;
  var p = parseSignatureHeader(header);
  if (!p.t || !rawBody) return false;
  var maxSkewSec = Number(process.env.PAYMONGO_SIGNATURE_MAX_SKEW_SEC);
  if (!isFinite(maxSkewSec) || maxSkewSec <= 0) maxSkewSec = 3600;
  if (maxSkewSec > 86400) maxSkewSec = 86400;
  var ts = Number(p.t);
  if (!isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > maxSkewSec) return false;
  var payload = p.t + "." + rawBody;
  function verifyOne(sec) {
    sec = normalizeWebhookSecret(sec);
    if (!sec) return false;
    var mac = crypto.createHmac("sha256", sec).update(payload, "utf8").digest("hex");
    if (p.li && hmacHexEquals(mac, p.li)) return true;
    if (p.te && hmacHexEquals(mac, p.te)) return true;
    return false;
  }
  if (verifyOne(secret)) return true;
  var alt = normalizeWebhookSecret(process.env.PAYMONGO_WEBHOOK_SECRET_ALT || process.env.PAYMONGO_WEBHOOK_SECRET_LEGACY);
  if (alt && alt !== secret && verifyOne(alt)) return true;
  return false;
}

function headersFromReq(req) {
  var h = {};
  Object.keys(req.headers || {}).forEach(function (k) {
    h[k] = req.headers[k];
  });
  return h;
}

function sendNetlifyResult(expressRes, result) {
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

function handlePaymongoWebhookExpress(req, res) {
  var rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
  var secret = normalizeWebhookSecret(process.env.PAYMONGO_WEBHOOK_SECRET || "");
  if (!secret) {
    res.status(503).json({ error: "missing_PAYMONGO_WEBHOOK_SECRET" });
    return;
  }
  var sigHeader =
    req.headers["paymongo-signature"] ||
    req.headers["Paymongo-Signature"] ||
    req.headers["PayMongo-Signature"] ||
    "";
  if (!verifyPaymongoSignature(rawBody, sigHeader, secret)) {
    console.warn(
      "[paymongo-webhook] invalid_signature (check Render PAYMONGO_WEBHOOK_SECRET matches this webhook signing secret; try PAYMONGO_WEBHOOK_SECRET_ALT if rotating)"
    );
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  var payload;
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch (e) {
    res.status(400).json({ error: "bad_json" });
    return;
  }

  var evType = "";
  try {
    evType = String((payload.data && payload.data.attributes && payload.data.attributes.type) || "").toLowerCase();
  } catch (e2) {}
  var paidEventTypes = {
    "payment.paid": true,
    "checkout_session.payment.paid": true,
    "link.payment.paid": true,
  };
  if (!paidEventTypes[evType]) {
    res.status(200).json({ ok: true, ignored: true, reason: "unsupported_event_type", eventType: evType || null });
    return;
  }

  var event = {
    httpMethod: "POST",
    path: String(req.path || "/webhook/paymongo"),
    headers: headersFromReq(req),
    body: rawBody,
    isBase64Encoded: false,
  };

  paymongoHandler
    .handler(event)
    .then(function (result) {
      sendNetlifyResult(res, result);
    })
    .catch(function (e) {
      res.status(500).json({ error: "webhook_invoke_failed", detail: String((e && e.message) || e) });
    });
}

module.exports = {
  handlePaymongoWebhookExpress,
  verifyPaymongoSignature,
  parseSignatureHeader,
};
