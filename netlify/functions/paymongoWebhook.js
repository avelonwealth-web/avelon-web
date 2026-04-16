/**
 * PayMongo → Firebase (deposits, referrals). Netlify: POST only.
 *
 * Env: PAYMONGO_WEBHOOK_SECRET (whsk_…), FIREBASE_SERVICE_ACCOUNT_JSON
 * Dashboard URL (example): https://avelon.site/.netlify/functions/paymongoWebhook
 *
 * Signature: https://developers.paymongo.com/docs/creating-webhook — Paymongo-Signature: t=…,te=…,li=…
 */
const crypto = require("crypto");
const { admin, initAdminPaymongoWebhook, json, preflight, corsHeaders } = require("./_lib");

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

/** PayMongo sends separate `li` (live) and `te` (test) signatures — try both vs one MAC. https://developers.paymongo.com/docs/creating-webhook */
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

/** PayMongo event envelope: data.attributes.data is the nested resource (e.g. payment). */
function getEmbeddedPaymentResource(payload) {
  try {
    var d = payload && payload.data && payload.data.attributes && payload.data.attributes.data;
    if (!d || typeof d !== "object") return { id: "", attributes: {} };
    var id = String(d.id || "").trim();
    var attrs = d.attributes && typeof d.attributes === "object" ? d.attributes : {};
    return { id: id, attributes: attrs };
  } catch (e) {
    return { id: "", attributes: {} };
  }
}

/**
 * PayMongo Checkout fires `checkout_session.payment.paid` with nested checkout_session + payments[].
 * Direct payments use `payment.paid` with nested payment. See:
 * https://developers.paymongo.com/docs/checkout-implementation
 */
function resolvePaidPaymentFromWebhook(payload, evType) {
  var inner = (payload && payload.data && payload.data.attributes && payload.data.attributes.data) || null;
  if (!inner || typeof inner !== "object") return null;
  var innerType = String(inner.type || "").toLowerCase();

  if (evType === "payment.paid" && innerType === "payment") {
    var attrs = inner.attributes || {};
    return {
      paymentId: String(inner.id || "").trim(),
      paymentAttrs: attrs,
      checkoutSessionId: null,
    };
  }

  if (evType === "checkout_session.payment.paid" && innerType === "checkout_session") {
    var a = inner.attributes || {};
    var payments = Array.isArray(a.payments) ? a.payments : [];
    var i;
    for (i = 0; i < payments.length; i++) {
      var p = payments[i] || {};
      var pid = String(p.id || "").trim();
      var pa = p.attributes || {};
      var st = String(pa.status || "").toLowerCase();
      if (pid.indexOf("pay_") === 0 && st === "paid") {
        return {
          paymentId: pid,
          paymentAttrs: pa,
          checkoutSessionId: String(inner.id || "").trim() || null,
        };
      }
    }
    for (i = 0; i < payments.length; i++) {
      var p2 = payments[i] || {};
      var pid2 = String(p2.id || "").trim();
      if (pid2.indexOf("pay_") === 0) {
        return {
          paymentId: pid2,
          paymentAttrs: p2.attributes || {},
          checkoutSessionId: String(inner.id || "").trim() || null,
        };
      }
    }
    return null;
  }

  if (evType === "link.payment.paid" && innerType === "link") {
    var la = inner.attributes || {};
    var linkPayId = deepFindPaymentId(payload, 0);
    if (!linkPayId) linkPayId = String(inner.id || "").trim();
    return {
      paymentId: linkPayId,
      paymentAttrs: la,
      checkoutSessionId: null,
    };
  }

  return null;
}

function firestoreTimestampFromPaymongoTime(v) {
  if (v == null) return null;
  try {
    if (typeof v === "number" && isFinite(v) && v > 0) {
      if (v > 1e12) return admin.firestore.Timestamp.fromMillis(Math.round(v));
      return admin.firestore.Timestamp.fromMillis(Math.round(v * 1000));
    }
    if (typeof v === "string" && String(v).trim()) {
      var asNum = Number(v);
      if (isFinite(asNum) && asNum > 1e12) return admin.firestore.Timestamp.fromMillis(Math.round(asNum));
      if (isFinite(asNum) && asNum > 0) return admin.firestore.Timestamp.fromMillis(Math.round(asNum * 1000));
      var ms = Date.parse(v);
      if (!isNaN(ms)) return admin.firestore.Timestamp.fromMillis(ms);
    }
  } catch (e) {}
  return null;
}

/** PayMongo metadata / API amounts: metadata.amountPhp is pesos (e.g. "5"); payment.attributes.amount is centavos (e.g. 500). */
function parsePositivePhpAmount(v) {
  var n = Number(String(v == null ? "" : v).replace(/,/g, "").trim());
  return isFinite(n) && n > 0 ? n : 0;
}

function amountPhpFromPaymentCentavos(attrs) {
  if (!attrs || typeof attrs !== "object") return 0;
  var c = String(attrs.currency || "").toUpperCase();
  var raw = Number(attrs.amount);
  if (!isFinite(raw) || raw <= 0) return 0;
  if (!c || c === "PHP") return raw / 100;
  return 0;
}

/**
 * Prefer explicit PHP from metadata; else PayMongo charge amount in centavos; else deep-search centavos guess.
 */
function resolveAmountPhpForCredit(meta, paymentAttrs, amountCentavosGuess) {
  var md = (paymentAttrs && paymentAttrs.metadata) || {};
  var fromPaymentMeta = parsePositivePhpAmount(md.amountPhp);
  if (fromPaymentMeta > 0) return fromPaymentMeta;
  var fromDeepMeta = meta && parsePositivePhpAmount(meta.amountPhp);
  if (fromDeepMeta > 0) return fromDeepMeta;
  var fromCentavos = amountPhpFromPaymentCentavos(paymentAttrs);
  if (fromCentavos > 0) return fromCentavos;
  if (amountCentavosGuess > 0) return amountCentavosGuess / 100;
  return 0;
}

function deepFindMeta(obj, depth) {
  if (!obj || typeof obj !== "object" || depth > 12) return null;
  var md = obj.metadata;
  if (md && (md.userId || md.uid)) {
    return {
      userId: String(md.userId || md.uid || ""),
      depositId: md.depositId ? String(md.depositId) : null,
      amountPhp: parsePositivePhpAmount(md.amountPhp),
    };
  }
  if (obj.userId || obj.uid) {
    return {
      userId: String(obj.userId || obj.uid || ""),
      depositId: obj.depositId ? String(obj.depositId) : null,
      amountPhp: parsePositivePhpAmount(obj.amountPhp),
    };
  }
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    var found = deepFindMeta(obj[k], depth + 1);
    if (found && found.userId) return found;
  }
  return null;
}

function deepFindCheckoutSessionId(obj, depth) {
  if (!obj || typeof obj !== "object" || depth > 12) return "";
  var direct =
    obj.checkout_session_id ||
    obj.checkoutSessionId ||
    obj.checkout_session ||
    obj.checkoutSession;
  if (direct) return String(direct).trim();
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    var found = deepFindCheckoutSessionId(obj[k], depth + 1);
    if (found) return found;
  }
  return "";
}

function deepFindPaymentId(obj, depth) {
  if (!obj || typeof obj !== "object" || depth > 12) return "";
  var id = String(obj.id || "").trim();
  if (id && id.indexOf("pay_") === 0) return id;
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    var found = deepFindPaymentId(obj[k], depth + 1);
    if (found) return found;
  }
  return "";
}

function deepFindAmountCentavos(obj, depth) {
  if (!obj || typeof obj !== "object" || depth > 12) return 0;
  var a = Number(obj.amount || 0);
  var c = String(obj.currency || "").toUpperCase();
  if (a > 0 && (!c || c === "PHP")) return a;
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    var found = deepFindAmountCentavos(obj[k], depth + 1);
    if (found > 0) return found;
  }
  return 0;
}

function deepFindCreatedAt(obj, depth) {
  if (!obj || typeof obj !== "object" || depth > 12) return "";
  var c = obj.created_at || obj.createdAt || "";
  if (c) return String(c).trim();
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    var found = deepFindCreatedAt(obj[k], depth + 1);
    if (found) return found;
  }
  return "";
}

function deepFindDescription(obj, depth) {
  if (!obj || typeof obj !== "object" || depth > 12) return "";
  var d = obj.description || "";
  if (d) return String(d).trim();
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    var found = deepFindDescription(obj[k], depth + 1);
    if (found) return found;
  }
  return "";
}

function extractDepositIdFromText(txt) {
  var s = String(txt || "");
  var m = /dep_[a-z0-9]{10,}/i.exec(s);
  return m ? String(m[0]) : "";
}

async function findPendingDepositByAmount(db, amountPhp) {
  if (!(amountPhp > 0)) return null;
  var docs = [];
  try {
    var q = await db
      .collection("deposits")
      .where("status", "in", ["created", "checkout_created"])
      .where("amountPhp", "==", amountPhp)
      .orderBy("createdAt", "desc")
      .limit(3)
      .get();
    docs = q.docs.slice();
  } catch (e) {
    // Avoid hard dependency on composite indexes during incident recovery.
    var qBasic = await db.collection("deposits").where("amountPhp", "==", amountPhp).limit(20).get();
    docs = qBasic.docs.slice();
  }
  if (!docs.length) return null;
  var unresolved = [];
  for (var i = 0; i < docs.length; i++) {
    var row = docs[i].data() || {};
    var st = String(row.status || "").toLowerCase();
    if (st === "created" || st === "checkout_created" || st === "pending") {
      unresolved.push({ id: docs[i].id, data: row });
    }
  }
  if (unresolved.length === 1) return unresolved[0];
  return null;
}

async function findPendingDepositByAmountAndTime(db, amountPhp, createdAtIso) {
  if (!(amountPhp > 0)) return null;
  var createdAtMs = Date.parse(String(createdAtIso || ""));
  var q = await db.collection("deposits").where("amountPhp", "==", amountPhp).limit(30).get();
  if (q.empty) return null;
  var candidates = [];
  q.forEach(function (d) {
    var row = d.data() || {};
    var st = String(row.status || "").toLowerCase();
    if (!(st === "created" || st === "checkout_created" || st === "pending")) return;
    var ts = row.createdAt && typeof row.createdAt.toMillis === "function" ? row.createdAt.toMillis() : 0;
    if (!createdAtMs || !ts) {
      candidates.push({ id: d.id, data: row, dist: Number.MAX_SAFE_INTEGER });
      return;
    }
    var dist = Math.abs(ts - createdAtMs);
    // 6 hours window for delayed webhook delivery.
    if (dist <= 6 * 60 * 60 * 1000) {
      candidates.push({ id: d.id, data: row, dist: dist });
    }
  });
  if (!candidates.length) return null;
  candidates.sort(function (a, b) {
    return a.dist - b.dist;
  });
  // Use candidate only when clearly nearest.
  if (candidates.length === 1) return { id: candidates[0].id, data: candidates[0].data };
  if (candidates[0].dist < candidates[1].dist * 0.6) return { id: candidates[0].id, data: candidates[0].data };
  return null;
}

function extractPaymentMethod(payload) {
  try {
    var d = payload && payload.data && payload.data.attributes && payload.data.attributes.data;
    var a = (d && d.attributes) || {};
    var sourceType = (a.source && a.source.type) || "";
    var pmType = (a.payment_method && a.payment_method.type) || "";
    if (sourceType) return String(sourceType).toLowerCase();
    if (pmType) return String(pmType).toLowerCase();
  } catch (e) {}
  return "";
}

function maskMobileForLogs(v) {
  var d = String(v || "").replace(/\D/g, "");
  if (!d) return "***";
  if (d.length <= 4) return d[0] + "***";
  return d.slice(0, 4) + "*****" + d.slice(-2);
}

function resolveUplineId(d) {
  if (!d || typeof d !== "object") return "";
  return String(
    d.uplineId ||
      d.upline ||
      d.sponsorUid ||
      d.uplineUid ||
      d.sponsorId ||
      d.parentUid ||
      d.referrerUid ||
      d.referrerId ||
      d.invitedByUid ||
      ""
  ).trim();
}

function commissionRateForUplineLevel(level) {
  var n = Math.floor(Number(level || 0));
  if (n === 1) return 0.1;
  if (n === 2) return 0.04;
  if (n === 3) return 0.01;
  return 0;
}

exports.handler = async function (event) {
  var opt = preflight(event);
  if (opt) return opt;
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders()),
      body: JSON.stringify({ error: "method_not_allowed" }),
    };
  }

  var rawBody = "";
  if (typeof event.body === "string") {
    rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  } else {
    rawBody = JSON.stringify(event.body || {});
  }

  try {
    initAdminPaymongoWebhook();
  } catch (e) {
    var initMsg = String((e && e.message) || e);
    console.error("[paymongoWebhook] admin_init_failed", initMsg);
    console.log("[paymongoWebhook]", JSON.stringify({ step: "response_200", reason: "admin_init_failed" }));
    return json(200, { ok: false, error: "admin_init_failed", detail: initMsg });
  }

  var secret = normalizeWebhookSecret(process.env.PAYMONGO_WEBHOOK_SECRET || "");
  if (!secret) {
    return json(503, { error: "missing_PAYMONGO_WEBHOOK_SECRET" });
  }
  var sigHeader =
    event.headers["paymongo-signature"] ||
    event.headers["Paymongo-Signature"] ||
    event.headers["PayMongo-Signature"] ||
    "";

  if (!verifyPaymongoSignature(rawBody, sigHeader, secret)) {
    console.warn(
      "[paymongoWebhook] invalid_signature — copy Signing secret (whsk_…) for THIS webhook into PAYMONGO_WEBHOOK_SECRET on the API server (Render). Optional PAYMONGO_WEBHOOK_SECRET_ALT during rotation."
    );
    return json(401, { error: "invalid_signature" });
  }

  var payload;
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch (e) {
    return json(400, { error: "bad_json" });
  }

  var earlyEventId = "";
  try {
    earlyEventId = String((payload.data && payload.data.id) || "").trim();
  } catch (e) {}

  var evType = "";
  try {
    evType = String((payload.data && payload.data.attributes && payload.data.attributes.type) || "").toLowerCase();
  } catch (e) {}
  var paidEventTypes = {
    "payment.paid": true,
    "checkout_session.payment.paid": true,
  };
  var checkoutCreatedEventTypes = {
    "checkout_session.created": true,
    "checkout.created": true,
  };
  if (!paidEventTypes[evType] && !checkoutCreatedEventTypes[evType]) {
    console.log(
      "[paymongoWebhook]",
      JSON.stringify({
        step: "event_in",
        eventId: earlyEventId || null,
        evType: evType || null,
        ignored: true,
        reason: "unsupported_event_type",
      })
    );
    console.log(
      "[paymongoWebhook]",
      JSON.stringify({ step: "response_200", reason: "unsupported_event_type", eventType: evType || null })
    );
    return json(200, { ok: true, ignored: true, reason: "unsupported_event_type", eventType: evType || null });
  }

  var eventId = earlyEventId || String((payload.data && payload.data.id) || "").trim();
  if (!eventId) {
    console.warn("[paymongoWebhook]", JSON.stringify({ warn: "missing_event_id", evType: evType }));
    console.log("[paymongoWebhook]", JSON.stringify({ step: "response_200", reason: "missing_event_id" }));
    return json(200, { ok: true, ignored: true, reason: "missing_event_id" });
  }

  console.log(
    "[paymongoWebhook]",
    JSON.stringify({
      step: "event_in",
      eventId: eventId,
      evType: evType,
      note: "payment.paid | checkout_session.payment.paid | link.payment.paid",
    })
  );

  var hdr = event.headers || {};
  var webhookRetryCount = 0;
  (function () {
    var n = Number(
      hdr["x-paymongo-retry"] || hdr["X-Paymongo-Retry"] || hdr["paymongo-retry"] || hdr["Paymongo-Retry"] || 0
    );
    webhookRetryCount = isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  })();

  if (checkoutCreatedEventTypes[evType]) {
    try {
      var createdMeta = deepFindMeta(payload, 0) || {};
      var createdDesc = deepFindDescription(payload, 0);
      var createdDepId =
        (createdMeta && createdMeta.depositId && String(createdMeta.depositId).trim()) ||
        extractDepositIdFromText(createdDesc);
      var createdUserId = createdMeta && createdMeta.userId ? String(createdMeta.userId).trim() : "";
      var createdAmountPhp = Number(createdMeta && createdMeta.amountPhp ? createdMeta.amountPhp : 0);
      var createdCheckoutId = deepFindCheckoutSessionId(payload, 0) || "";
      var createdPaymentId = deepFindPaymentId(payload, 0) || "";
      var dbCreated = admin.firestore();
      var createdEvtRef = dbCreated.collection("paymentWebhookEvents").doc("paymongo_" + eventId);
      var createdDepRef = createdDepId ? dbCreated.collection("deposits").doc(String(createdDepId)) : null;
      var createdPaymentRef = createdPaymentId ? dbCreated.collection("payments").doc(String(createdPaymentId)) : null;
      var createdUserRef = createdUserId ? dbCreated.collection("users").doc(String(createdUserId)) : null;
      var createdOutcome = "checkout_created";

      await dbCreated.runTransaction(async function (tx) {
        var existingEvt = await tx.get(createdEvtRef);
        if (existingEvt.exists) {
          createdOutcome = "duplicate_event";
          return;
        }

        var existingDep = null;
        if (createdDepRef) existingDep = await tx.get(createdDepRef);
        var existingUser = null;
        if (createdUserRef) existingUser = await tx.get(createdUserRef);

        var sourceType = "";
        if (existingDep && existingDep.exists) {
          var ed = existingDep.data() || {};
          sourceType = String(ed.sourceType || ed.source || ed.provider || "").toLowerCase();
        }
        if (!sourceType) sourceType = String((createdMeta && createdMeta.sourceType) || "").toLowerCase();
        if (!sourceType) sourceType = String((createdMeta && createdMeta.source) || "").toLowerCase();
        var isBinanceTrade = sourceType === "binance" || sourceType === "trade" || sourceType === "call_put";

        if (createdDepRef) {
          var depPayload = {
            userId: createdUserId || null,
            depositId: String(createdDepId),
            amountPhp: createdAmountPhp > 0 ? createdAmountPhp : null,
            status: "checkout_created",
            credited: false,
            checkoutSessionId: createdCheckoutId || null,
            providerPaymentId: createdPaymentId || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          if (isBinanceTrade) {
            depPayload.credited = true;
            depPayload.status = "paid";
            depPayload.creditedAt = admin.firestore.FieldValue.serverTimestamp();
          }
          tx.set(createdDepRef, depPayload, { merge: true });
        }

        if (createdPaymentRef) {
          tx.set(
            createdPaymentRef,
            {
              userId: createdUserId || null,
              depositId: createdDepId || null,
              amountPhp: createdAmountPhp > 0 ? createdAmountPhp : null,
              status: isBinanceTrade ? "paid" : "checkout_created",
              provider: "paymongo",
              providerEventId: eventId,
              providerPaymentId: createdPaymentId,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        if (
          isBinanceTrade &&
          createdUserRef &&
          existingUser &&
          existingUser.exists &&
          !(existingDep && existingDep.exists && existingDep.data() && existingDep.data().credited === true)
        ) {
          tx.update(createdUserRef, {
            balance: admin.firestore.FieldValue.increment(createdAmountPhp),
            depositPrincipal: admin.firestore.FieldValue.increment(createdAmountPhp),
            totalDeposits: admin.firestore.FieldValue.increment(createdAmountPhp),
            depositCount: admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.Timestamp.now(),
          });
          createdOutcome = "checkout_created_binance_credited";
        }

        tx.set(
          createdEvtRef,
          {
            provider: "paymongo",
            providerEventId: eventId,
            eventType: evType,
            outcome: createdOutcome,
            paymentId: createdPaymentId || null,
            depositId: createdDepId || null,
            userId: createdUserId || null,
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      });

      console.log(
        "[paymongoWebhook]",
        JSON.stringify({
          step: "checkout_created_write",
          eventId: eventId,
          evType: evType,
          depositId: createdDepId || null,
          userId: createdUserId || null,
          paymentId: createdPaymentId || null,
          outcome: createdOutcome,
        })
      );
      console.log(
        "[paymongoWebhook]",
        JSON.stringify({ step: "response_200", reason: "checkout_created", eventId: eventId })
      );
      return json(200, { ok: true, status: "checkout_created", eventId: eventId, depositId: createdDepId || null });
    } catch (eCreated) {
      console.error(
        "[paymongoWebhook]",
        JSON.stringify({
          step: "checkout_created_error",
          eventId: eventId,
          detail: String((eCreated && eCreated.message) || eCreated),
        })
      );
      console.log(
        "[paymongoWebhook]",
        JSON.stringify({ step: "response_200", reason: "checkout_created_error", eventId: eventId })
      );
      return json(200, { ok: false, error: "checkout_created_error", eventId: eventId });
    }
  }

  var resolvedPaid = resolvePaidPaymentFromWebhook(payload, evType);
  var paymentId = (resolvedPaid && resolvedPaid.paymentId) || deepFindPaymentId(payload, 0) || "";
  var embeddedPay = resolvedPaid
    ? { id: resolvedPaid.paymentId, attributes: resolvedPaid.paymentAttrs || {} }
    : getEmbeddedPaymentResource(payload);
  if (!paymentId && embeddedPay.id && String(embeddedPay.id).indexOf("pay_") === 0) {
    paymentId = String(embeddedPay.id).trim();
  }
  var amountCentavosGuess = deepFindAmountCentavos(payload, 0);
  var createdAtGuess = deepFindCreatedAt(payload, 0);
  var descriptionGuess = deepFindDescription(payload, 0);
  var meta = deepFindMeta(payload, 0);
  var explicitMetaDepositId =
    meta && meta.depositId ? String(meta.depositId).trim() : extractDepositIdFromText(descriptionGuess);
  if (explicitMetaDepositId) {
    try {
      var depById = await admin.firestore().collection("deposits").doc(explicitMetaDepositId).get();
      if (depById.exists) {
        var depByIdData = depById.data() || {};
        meta = {
          userId: String(depByIdData.userId || (meta && meta.userId) || ""),
          depositId: depById.id,
          amountPhp: Number(depByIdData.amountPhp || (meta && meta.amountPhp) || 0),
        };
      }
    } catch (e0) {}
  }
  var directDepIdFromDesc = extractDepositIdFromText(descriptionGuess);
  if ((!meta || !meta.userId) && directDepIdFromDesc) {
    try {
      var depByDesc = await admin.firestore().collection("deposits").doc(directDepIdFromDesc).get();
      if (depByDesc.exists) {
        var depDescData = depByDesc.data() || {};
        meta = {
          userId: String(depDescData.userId || ""),
          depositId: depByDesc.id,
          amountPhp: Number(depDescData.amountPhp || 0),
        };
      }
    } catch (e) {}
  }
  if (!meta || !meta.userId) {
    var checkoutSessionId = deepFindCheckoutSessionId(payload, 0);
    if (checkoutSessionId) {
      try {
        var byCheckout = await admin.firestore().collection("deposits").where("checkoutSessionId", "==", checkoutSessionId).limit(1).get();
        if (!byCheckout.empty) {
          var depDoc = byCheckout.docs[0];
          var depData = depDoc.data() || {};
          meta = {
            userId: String(depData.userId || ""),
            depositId: depDoc.id,
            amountPhp: Number(depData.amountPhp || 0),
          };
        }
      } catch (e) {}
    }
  }
  if ((!meta || !meta.userId) && amountCentavosGuess > 0) {
    try {
      var amountGuessPhp = amountCentavosGuess / 100;
      var pending =
        (await findPendingDepositByAmountAndTime(admin.firestore(), amountGuessPhp, createdAtGuess)) ||
        (await findPendingDepositByAmount(admin.firestore(), amountGuessPhp));
      if (pending && pending.data && pending.data.userId) {
        meta = {
          userId: String(pending.data.userId || ""),
          depositId: pending.id,
          amountPhp: Number(pending.data.amountPhp || amountGuessPhp),
        };
      }
    } catch (e) {}
  }
  if (!meta || !meta.userId) {
    console.warn(
      "[paymongoWebhook]",
      JSON.stringify({ ignored: true, reason: "no_user_metadata", eventId: eventId, evType: evType })
    );
    console.log("[paymongoWebhook]", JSON.stringify({ step: "response_200", reason: "no_user_metadata", eventId: eventId }));
    return json(200, { ok: true, ignored: true, reason: "no_user_metadata", eventId: eventId });
  }

  var userId = meta.userId;
  var depositId = meta.depositId;
  var paymentAttrs = embeddedPay.attributes || {};
  var amountPhp = resolveAmountPhpForCredit(meta, paymentAttrs, amountCentavosGuess);
  var paymentMethod = extractPaymentMethod(payload);
  if (!(amountPhp > 0) && depositId) {
    try {
      var depSnap0 = await admin.firestore().collection("deposits").doc(String(depositId)).get();
      if (depSnap0.exists) {
        var dep0 = depSnap0.data() || {};
        amountPhp = Number(dep0.amountPhp || 0);
      }
    } catch (e) {}
  }
  if (String(userId) && !depositId) {
    var csidFb = deepFindCheckoutSessionId(payload, 0);
    if (csidFb) {
      try {
        var csSnap = await admin
          .firestore()
          .collection("deposits")
          .where("checkoutSessionId", "==", csidFb)
          .limit(1)
          .get();
        if (!csSnap.empty) {
          depositId = csSnap.docs[0].id;
        }
      } catch (eCs) {}
    }
  }
  if (String(userId) && !depositId && amountCentavosGuess > 0) {
    try {
      var amtGs = amountCentavosGuess / 100;
      var pendFb =
        (await findPendingDepositByAmountAndTime(admin.firestore(), amtGs, createdAtGuess)) ||
        (await findPendingDepositByAmount(admin.firestore(), amtGs));
      if (pendFb && pendFb.data && String(pendFb.data.userId || "") === String(userId)) {
        depositId = pendFb.id;
      }
    } catch (ePb) {}
  }
  if (!(amountPhp > 0)) {
    console.warn(
      "[paymongoWebhook]",
      JSON.stringify({ ignored: true, reason: "no_amount", eventId: eventId, evType: evType, userId: userId })
    );
    console.log("[paymongoWebhook]", JSON.stringify({ step: "response_200", reason: "no_amount", eventId: eventId }));
    return json(200, { ok: true, ignored: true, reason: "no_amount", eventId: eventId });
  }

  if (!String(paymentId || "").trim()) {
    console.warn(
      "[paymongoWebhook]",
      JSON.stringify({ warn: "missing_payment_id", eventId: eventId, evType: evType, retryCount: webhookRetryCount })
    );
    console.log("[paymongoWebhook]", JSON.stringify({ step: "response_200", reason: "missing_payment_id", eventId: eventId }));
    return json(200, { ok: true, ignored: true, reason: "missing_payment_id", eventId: eventId });
  }
  paymentId = String(paymentId).trim();

  console.log(
    "[paymongoWebhook]",
    JSON.stringify({
      step: "metadata_resolved",
      eventId: eventId,
      evType: evType,
      userId: String(userId),
      depositId: depositId ? String(depositId) : null,
      amountPhp: amountPhp,
      paymentId: paymentId,
      webhookRetryCount: webhookRetryCount,
    })
  );

  var innerStatus = String((embeddedPay.attributes && embeddedPay.attributes.status) || "paid").toLowerCase();
  var paymentRecordStatus = innerStatus === "failed" ? "failed" : "paid";
  var payCreatedAt = firestoreTimestampFromPaymongoTime(embeddedPay.attributes && embeddedPay.attributes.created_at);
  var payPaidAt = firestoreTimestampFromPaymongoTime(embeddedPay.attributes && embeddedPay.attributes.paid_at);

  var db = admin.firestore();
  var userRef = db.collection("users").doc(String(userId));
  var refId = "PM-" + (paymentId || eventId || String(Date.now()));
  var evtRef = db.collection("paymentWebhookEvents").doc("paymongo_" + eventId);
  var paymentRef = db.collection("payments").doc(paymentId);

  var txOutcome = "credited";
  try {
    console.log(
      "[paymongoWebhook]",
      JSON.stringify({ step: "firestore_tx_begin", eventId: eventId, paymentId: paymentId, userId: String(userId) })
    );
    await db.runTransaction(async function (tx) {
      // --- Phase 1: ALL reads (Firestore requires reads before any writes in a transaction) ---
      var evtSnap = await tx.get(evtRef);
      if (evtSnap.exists) throw new Error("duplicate_event");

      var depWriteRef = null;
      var depSnap = null;
      if (depositId) {
        depWriteRef = db.collection("deposits").doc(String(depositId));
        depSnap = await tx.get(depWriteRef);
      }

      var snap = await tx.get(userRef);
      if (!snap.exists) throw new Error("user_not_found");
      var u = snap.data() || {};
      var directUplineId = String(u.uplineId || "").trim();
      var directUplineLevel = Math.floor(Number(u.uplineLevel || 1));
      var directUplineRef = directUplineId ? db.collection("users").doc(directUplineId) : null;
      var directUplineSnap = null;
      if (directUplineRef) {
        directUplineSnap = await tx.get(directUplineRef);
        if (!directUplineSnap.exists) {
          directUplineRef = null;
          directUplineId = "";
          directUplineLevel = 0;
        }
      }

      var duplicateDeposit = false;
      if (depositId && depSnap && depSnap.exists) {
        var dupD = depSnap.data() || {};
        if (dupD.credited === true || String(dupD.status || "").toLowerCase() === "paid") {
          duplicateDeposit = true;
        }
      }

      console.log(
        "[paymongoWebhook]",
        JSON.stringify({
          step: "tx_reads_done",
          eventId: eventId,
          evType: evType,
          duplicateDeposit: duplicateDeposit,
          hasDepositDoc: !!(depositId && depSnap && depSnap.exists),
        })
      );

      // --- Phase 2: ALL writes (no tx.get after this point) ---
      console.log("[paymongoWebhook]", JSON.stringify({ step: "tx_writes_begin", eventId: eventId }));
      if (duplicateDeposit) {
        tx.set(evtRef, {
          provider: "paymongo",
          providerEventId: eventId,
          paymentId: paymentId,
          outcome: "duplicate_deposit",
          userId: String(userId),
          depositId: String(depositId),
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(
          "[paymongoWebhook]",
          JSON.stringify({
            step: "tx_writes_duplicate_deposit",
            eventId: eventId,
            paymentId: paymentId,
            depositId: String(depositId),
          })
        );
        txOutcome = "duplicate_deposit";
        return;
      }

      var uplineCommissionRate = 0;
      var uplineCommissionAmount = 0;
      if (directUplineRef) {
        uplineCommissionRate = commissionRateForUplineLevel(directUplineLevel);
        uplineCommissionAmount = Math.round(amountPhp * uplineCommissionRate * 100) / 100;
      }
      console.log(
        "[commissionLogic]",
        JSON.stringify({
          step: "commission_compute",
          userId: String(userId),
          uplineId: directUplineId || null,
          uplineLevel: directUplineLevel || null,
          amountPhp: amountPhp,
          commissionRate: uplineCommissionRate,
          commissionAmount: uplineCommissionAmount,
        })
      );

      console.log(
        "[paymongoWebhook]",
        JSON.stringify({
          step: "user_update",
          path: "users/" + String(userId),
          increments: {
            balance: amountPhp,
            depositPrincipal: amountPhp,
            totalDeposits: amountPhp,
            totalDeposit: amountPhp,
            depositCount: 1,
          },
          updatedAt: "Timestamp.now()",
          eventId: eventId,
          paymentId: paymentId,
        })
      );
      tx.update(userRef, {
        balance: admin.firestore.FieldValue.increment(amountPhp),
        depositPrincipal: admin.firestore.FieldValue.increment(amountPhp),
        totalDeposits: admin.firestore.FieldValue.increment(amountPhp),
        totalDeposit: admin.firestore.FieldValue.increment(amountPhp),
        depositCount: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.Timestamp.now(),
      });

      if (directUplineRef) {
        console.log(
          "[paymongoWebhook]",
          JSON.stringify({
            step: "upline_credit",
            path: "users/" + String(directUplineId),
            fromUid: String(userId),
            amountPhp: amountPhp,
            commissionRate: uplineCommissionRate,
            commissionAmount: uplineCommissionAmount,
          })
        );
        tx.update(directUplineRef, {
          balance: admin.firestore.FieldValue.increment(amountPhp),
          totalDownlineDeposits: admin.firestore.FieldValue.increment(amountPhp),
          commissionEarnings: admin.firestore.FieldValue.increment(uplineCommissionAmount),
          updatedAt: admin.firestore.Timestamp.now(),
        });
        console.log(
          "[commissionLogic]",
          JSON.stringify({
            step: "commission_credit_applied",
            uplineId: String(directUplineId),
            fromUid: String(userId),
            amountPhp: amountPhp,
            commissionAmount: uplineCommissionAmount,
            uplineLevel: directUplineLevel || null,
          })
        );
        tx.set(directUplineRef.collection("downlineDeposits").doc(), {
          fromUid: String(userId),
          level: directUplineLevel || 1,
          depositAmount: amountPhp,
          referenceId: refId,
          source: "paymongo",
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(
          "[commissionLogic]",
          JSON.stringify({
            step: "downline_deposit_log_write",
            uplineId: String(directUplineId),
            fromUid: String(userId),
            level: directUplineLevel || 1,
            depositAmount: amountPhp,
          })
        );
        tx.set(directUplineRef.collection("transactions").doc(), {
          type: "referral_commission_l" + String(directUplineLevel || 1),
          amount: uplineCommissionAmount,
          status: "posted",
          referenceId: refId,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          userId: String(directUplineId),
          meta: {
            fromUid: String(userId),
            baseAmountPhp: amountPhp,
            commissionRate: uplineCommissionRate,
            commissionType: "invite",
          },
        });
      }

      if (depositId && depWriteRef) {
        var depWrite = {
          userId: String(userId),
          depositId: String(depositId),
          amountPhp: Number(amountPhp),
          status: "paid",
          credited: true,
          createdAt: admin.firestore.Timestamp.now(),
          provider: "paymongo",
          referenceId: refId,
          providerPaymentId: paymentId || null,
          creditedVia: "webhook",
          creditedAt: admin.firestore.FieldValue.serverTimestamp(),
          paymentMethod: paymentMethod || admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        console.log(
          "[paymongoWebhook]",
          JSON.stringify({
            step: "deposit_write",
            path: "deposits/" + String(depositId),
            merge: true,
            amountPhp: amountPhp,
            eventId: eventId,
          })
        );
        tx.set(depWriteRef, depWrite, { merge: true });
      } else {
        console.log(
          "[paymongoWebhook]",
          JSON.stringify({
            step: "deposit_write_skipped",
            reason: "no_depositId",
            eventId: eventId,
            paymentId: paymentId,
            userId: String(userId),
          })
        );
      }

      tx.set(
        paymentRef,
        {
          userId: String(userId),
          depositId: depositId ? String(depositId) : null,
          amountPhp: amountPhp,
          status: paymentRecordStatus,
          created_at: payCreatedAt || admin.firestore.FieldValue.serverTimestamp(),
          paid_at: payPaidAt || admin.firestore.FieldValue.serverTimestamp(),
          provider: "paymongo",
          providerEventId: eventId,
          providerPaymentId: paymentId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      tx.set(userRef.collection("transactions").doc(), {
        type: "deposit",
        amount: amountPhp,
        status: "posted",
        referenceId: refId,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        userId: String(userId),
      });
      tx.set(userRef.collection("history").doc(), {
        kind: "deposit",
        message: "Deposit credited (PayMongo)",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(userRef.collection("logs").doc(), {
        level: "info",
        message: "PayMongo webhook processed",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.set(evtRef, {
        provider: "paymongo",
        providerEventId: eventId,
        paymentId: paymentId,
        userId: String(userId),
        depositId: depositId || null,
        amountPhp: amountPhp,
        webhookRetryCount: webhookRetryCount,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    console.log(
      "[paymongoWebhook]",
      JSON.stringify({
        step: "firestore_tx_commit",
        eventId: eventId,
        paymentId: paymentId,
        outcome: txOutcome,
      })
    );
    if (txOutcome === "duplicate_deposit") {
      console.log(
        "[paymongoWebhook]",
        JSON.stringify({ step: "response_200", reason: "duplicate_deposit", eventId: eventId })
      );
      return json(200, { ok: true, duplicate: true, reason: "duplicate_deposit" });
    }
  } catch (e) {
    if (String((e && e.message) || "") === "duplicate_event") {
      console.log(
        "[paymongoWebhook]",
        JSON.stringify({
          duplicate: true,
          eventId: eventId,
          paymentId: paymentId,
          status: paymentRecordStatus,
          retryCount: webhookRetryCount,
          amountPhp: amountPhp,
          userId: userId,
          depositId: depositId || null,
        })
      );
      console.log("[paymongoWebhook]", JSON.stringify({ step: "response_200", reason: "duplicate_event", eventId: eventId }));
      return json(200, { ok: true, duplicate: true });
    }
    if (String((e && e.message) || "") === "user_not_found") {
      console.warn(
        "[paymongoWebhook]",
        JSON.stringify({ error: "webhook_user_not_found", eventId: eventId, userId: String(userId || "") })
      );
      console.log(
        "[paymongoWebhook]",
        JSON.stringify({ step: "response_200", reason: "webhook_user_not_found", eventId: eventId })
      );
      return json(200, { ok: false, error: "webhook_user_not_found", detail: String(userId || "") });
    }
    console.error(
      "[paymongoWebhook]",
      JSON.stringify({
        error: "webhook_processing_failed",
        eventId: eventId,
        paymentId: paymentId,
        detail: String((e && e.message) || e),
      })
    );
    console.log(
      "[paymongoWebhook]",
      JSON.stringify({ step: "response_200", reason: "webhook_processing_failed", eventId: eventId })
    );
    return json(200, { ok: false, error: "webhook_processing_failed", detail: String((e && e.message) || e) });
  }

  console.log(
    "[paymongoWebhook]",
    JSON.stringify({
      credited: true,
      eventId: eventId,
      paymentId: paymentId,
      status: paymentRecordStatus,
      retryCount: webhookRetryCount,
      amountPhp: amountPhp,
      userId: userId,
      depositId: depositId || null,
    })
  );
  console.log(
    "[paymongoWebhook]",
    JSON.stringify({ step: "response_200", reason: "credited", eventId: eventId, paymentId: paymentId, statusCode: 200 })
  );

  return json(200, { ok: true, credited: true });
};
