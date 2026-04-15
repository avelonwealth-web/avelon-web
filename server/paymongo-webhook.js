"use strict";

/**
 * Render Express entry for PayMongo webhooks (raw body + HMAC verification).
 *
 * Lahat ng paid events (kasama `payment.paid` at `checkout_session.payment.paid`)
 * ay ipinapasa sa netlify/functions/paymongoWebhook.js — doon naka-resolve ang metadata
 * mula sa checkout session, deposit lookup, at centavos → PHP.
 *
 * Huwag mag-intercept ng `payment.paid` lang sa Express: madalas walang `metadata`
 * sa payment object kahit naka-set sa checkout session, kaya dapat isang code path lang.
 *
 * HTTP 200: PayMongo ay huwag i-disable; 5xx mula sa handler ay binabaluktot sa 200 + JSON.
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
  var sigPayload = p.t + "." + rawBody;
  function verifyOne(sec) {
    sec = normalizeWebhookSecret(sec);
    if (!sec) return false;
    var mac = crypto.createHmac("sha256", sec).update(sigPayload, "utf8").digest("hex");
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
    expressRes.status(200).json({ ok: false, error: "empty_handler_result" });
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
  if (sc >= 500) {
    var parsed = {};
    try {
      parsed = typeof body === "string" ? JSON.parse(body || "{}") : {};
    } catch (e) {}
    console.warn("[paymongo-webhook] handler_error_coerced_200", sc, String(body || "").slice(0, 400));
    expressRes.status(200).json(Object.assign({ ok: false, proxiedStatus: sc }, parsed));
    return;
  }
  if (typeof body === "string") {
    expressRes.status(200).send(body);
    return;
  }
  expressRes.status(200).json(body != null ? body : {});
}

/**
 * Express handler: verify signature → parehong Netlify webhook handler (lahat ng event types).
 */
async function handlePaymongoWebhookExpress(req, res) {
  try {
    var rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
    var secret = normalizeWebhookSecret(process.env.PAYMONGO_WEBHOOK_SECRET || "");
    if (!secret) {
      console.error("[paymongo-webhook] missing_PAYMONGO_WEBHOOK_SECRET");
      return res.status(200).json({ ok: false, error: "missing_PAYMONGO_WEBHOOK_SECRET" });
    }
    var sigHeader =
      req.headers["paymongo-signature"] ||
      req.headers["Paymongo-Signature"] ||
      req.headers["PayMongo-Signature"] ||
      "";
    if (!verifyPaymongoSignature(rawBody, sigHeader, secret)) {
      console.warn("[paymongo-webhook] invalid_signature");
      return res.status(200).json({ ok: false, error: "invalid_signature" });
    }

    var payload;
    try {
      payload = JSON.parse(rawBody || "{}");
    } catch (e) {
      console.warn("[paymongo-webhook] bad_json", String((e && e.message) || e));
      return res.status(200).json({ ok: false, error: "bad_json" });
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
      return res.status(200).json({ ok: true, ignored: true, reason: "unsupported_event_type", eventType: evType || null });
    }

    var event = {
      httpMethod: "POST",
      path: String(req.path || "/webhook/paymongo"),
      headers: headersFromReq(req),
      body: rawBody,
      isBase64Encoded: false,
    };

    var netlifyResult = await paymongoHandler.handler(event);
    sendNetlifyResult(res, netlifyResult);
  } catch (e) {
    console.error("[paymongo-webhook] unhandled", String((e && e.message) || e));
    if (!res.headersSent) res.sendStatus(200);
  }
}

module.exports = {
  handlePaymongoWebhookExpress,
  verifyPaymongoSignature,
  parseSignatureHeader,
};
