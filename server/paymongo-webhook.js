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

function logNetlifyResult(result) {
  var body = result && result.body;
  var sc = Number(result && result.statusCode) || 500;
  if (!result) {
    console.warn("[paymongoWebhook]", JSON.stringify({ step: "empty_handler_result" }));
    return;
  }
  if (sc >= 500) {
    try {
      console.warn(
        "[paymongoWebhook]",
        JSON.stringify({ step: "handler_error_coerced_200", statusCode: sc, bodyPreview: String(body || "").slice(0, 400) })
      );
    } catch (e) {}
    return;
  }
  try {
    console.log(
      "[paymongoWebhook]",
      JSON.stringify({ step: "express_response", statusCode: sc, bodyPreview: String(body || "").slice(0, 200) })
    );
  } catch (e2) {}
}

/**
 * Express handler: verify signature → parehong Netlify webhook handler (lahat ng event types).
 */
async function handlePaymongoWebhookExpress(req, res) {
  var rawBody = "";
  var eventId = null;
  var evType = null;
  try {
    rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
    var secret = normalizeWebhookSecret(process.env.PAYMONGO_WEBHOOK_SECRET || "");
    if (!secret) {
      console.error("[paymongoWebhook]", JSON.stringify({ step: "missing_secret" }));
      return;
    }
    var sigHeader =
      req.headers["paymongo-signature"] ||
      req.headers["Paymongo-Signature"] ||
      req.headers["PayMongo-Signature"] ||
      "";
    if (!verifyPaymongoSignature(rawBody, sigHeader, secret)) {
      console.warn("[paymongoWebhook]", JSON.stringify({ step: "invalid_signature" }));
      return;
    }

    var payload;
    try {
      payload = JSON.parse(rawBody || "{}");
    } catch (e) {
      console.warn("[paymongoWebhook]", JSON.stringify({ step: "bad_json", detail: String((e && e.message) || e) }));
      return;
    }

    evType = "";
    try {
      evType = String((payload.data && payload.data.attributes && payload.data.attributes.type) || "").toLowerCase();
      eventId = String((payload.data && payload.data.id) || "").trim() || null;
    } catch (e2) {}
    var paidEventTypes = {
      "payment.paid": true,
      "checkout_session.payment.paid": true,
      "link.payment.paid": true,
      "checkout_session.created": true,
      "checkout.created": true,
    };
    if (!paidEventTypes[evType]) {
      console.log(
        "[paymongoWebhook]",
        JSON.stringify({ step: "unsupported_event_type", eventId: eventId, evType: evType || null })
      );
      return;
    }

    var event = {
      httpMethod: "POST",
      path: String(req.path || "/webhook/paymongo"),
      headers: headersFromReq(req),
      body: rawBody,
      isBase64Encoded: false,
    };

    console.log(
      "[paymongoWebhook]",
      JSON.stringify({ step: "delegate_start", eventId: eventId, evType: evType || null })
    );
    // Wait for delegated handler to finish all async work (incl. Firestore tx + idempotency checks)
    // before responding in finally.
    var netlifyResult = await paymongoHandler.handler(event);
    logNetlifyResult(netlifyResult);
  } catch (e) {
    console.error(
      "[paymongoWebhook]",
      JSON.stringify({
        step: "unhandled_error",
        eventId: eventId,
        evType: evType,
        detail: String((e && e.message) || e),
      })
    );
  } finally {
    console.log("[paymongoWebhook]", JSON.stringify({ step: "response_200", eventId: eventId, evType: evType }));
    if (!res.headersSent) res.sendStatus(200);
  }
}

module.exports = {
  handlePaymongoWebhookExpress,
  verifyPaymongoSignature,
  parseSignatureHeader,
};
