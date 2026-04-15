/**
 * PayMongo → Firebase (deposits, referrals). Netlify: POST only.
 *
 * Env: PAYMONGO_WEBHOOK_SECRET (whsk_…), FIREBASE_SERVICE_ACCOUNT_JSON
 * Dashboard URL (example): https://avelon.site/.netlify/functions/paymongoWebhook
 *
 * Signature: https://developers.paymongo.com/docs/creating-webhook — Paymongo-Signature: t=…,te=…,li=…
 */
const crypto = require("crypto");
const { admin, initAdmin, json, preflight, corsHeaders } = require("./_lib");

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

function verifyPaymongoSignature(rawBody, header, secret) {
  if (!secret) return false;
  var p = parseSignatureHeader(header);
  if (!p.t || !rawBody) return false;
  var sigLive = p.li && p.li.length ? p.li : "";
  var sigTest = p.te && p.te.length ? p.te : "";
  var sigHex = sigLive || sigTest;
  if (!sigHex) return false;
  var maxSkewSec = 300;
  var ts = Number(p.t);
  if (!isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > maxSkewSec) return false;
  var mac = crypto.createHmac("sha256", secret).update(p.t + "." + rawBody, "utf8").digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(sigHex, "hex"));
  } catch (e) {
    return false;
  }
}

function deepFindMeta(obj, depth) {
  if (!obj || typeof obj !== "object" || depth > 12) return null;
  var md = obj.metadata;
  if (md && (md.userId || md.uid)) {
    return {
      userId: String(md.userId || md.uid || ""),
      depositId: md.depositId ? String(md.depositId) : null,
      amountPhp: Number(md.amountPhp || md.amount || 0),
    };
  }
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    var found = deepFindMeta(obj[k], depth + 1);
    if (found && found.userId) return found;
  }
  return null;
}

function maskMobileForLogs(v) {
  var d = String(v || "").replace(/\D/g, "");
  if (!d) return "***";
  if (d.length <= 4) return d[0] + "***";
  return d.slice(0, 4) + "*****" + d.slice(-2);
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

  var rawBody = typeof event.body === "string" ? event.body : JSON.stringify(event.body || {});

  try {
    initAdmin();
  } catch (e) {
    return json(500, { error: "admin_init_failed" });
  }

  var secret = process.env.PAYMONGO_WEBHOOK_SECRET || "";
  if (!secret) {
    return json(503, { error: "missing_PAYMONGO_WEBHOOK_SECRET" });
  }
  var sigHeader =
    event.headers["paymongo-signature"] ||
    event.headers["Paymongo-Signature"] ||
    event.headers["PayMongo-Signature"] ||
    "";

  if (!verifyPaymongoSignature(rawBody, sigHeader, secret)) {
    return json(401, { error: "invalid_signature" });
  }

  var payload;
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch (e) {
    return json(400, { error: "bad_json" });
  }

  var evType = "";
  try {
    evType = String((payload.data && payload.data.attributes && payload.data.attributes.type) || "").toLowerCase();
  } catch (e) {}
  var blob = JSON.stringify(payload).toLowerCase();
  var looksPaid =
    evType.indexOf("paid") >= 0 ||
    (blob.indexOf("checkout_session") >= 0 && blob.indexOf("paid") >= 0) ||
    blob.indexOf("payment.paid") >= 0;
  if (!looksPaid) {
    return json(200, { ok: true, ignored: true, reason: "not_paid_event" });
  }

  var meta = deepFindMeta(payload, 0);
  if (!meta || !meta.userId) {
    return json(200, { ok: true, ignored: true, reason: "no_user_metadata" });
  }

  var userId = meta.userId;
  var depositId = meta.depositId;
  var amountPhp = Number(meta.amountPhp || 0);
  if (!(amountPhp > 0)) {
    return json(200, { ok: true, ignored: true, reason: "no_amount" });
  }

  var db = admin.firestore();
  var userRef = db.collection("users").doc(String(userId));
  var providerEventId = String((payload && payload.data && payload.data.id) || "");
  var refId = "PM-" + (providerEventId || String(Date.now()));
  var evtRef = providerEventId ? db.collection("paymentWebhookEvents").doc("paymongo_" + providerEventId) : null;

  try {
    await db.runTransaction(async function (tx) {
      if (evtRef) {
        var evtSnap = await tx.get(evtRef);
        if (evtSnap.exists) throw new Error("duplicate_event");
      }
      var snap = await tx.get(userRef);
      if (!snap.exists) return;
      var u = snap.data() || {};
      var prevTotalDeposits = Number(u.totalDeposits || 0);
      var prevDepositCount = Number(u.depositCount || 0);
      var isFirstDeposit = prevTotalDeposits <= 0 && prevDepositCount <= 0;
      var depositorMasked = maskMobileForLogs(u.mobileNumber || u.mobile || u.email || "");
      tx.update(userRef, {
        balance: admin.firestore.FieldValue.increment(amountPhp),
        depositPrincipal: admin.firestore.FieldValue.increment(amountPhp),
        totalDeposits: admin.firestore.FieldValue.increment(amountPhp),
        depositCount: admin.firestore.FieldValue.increment(1),
      });
      if (depositId) {
        tx.set(
          db.collection("deposits").doc(String(depositId)),
          {
            userId: String(userId),
            amountPhp: amountPhp,
            status: "paid",
            provider: "paymongo",
            referenceId: refId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
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

      var upl1 = u.uplineId ? String(u.uplineId) : "";
      var upl2 = "";
      var upl3 = "";
      var amt1 = Math.round(amountPhp * 0.1 * 100) / 100;
      var amt2 = Math.round(amountPhp * 0.04 * 100) / 100;
      var amt3 = Math.round(amountPhp * 0.01 * 100) / 100;

      function creditCommission(uplineUid, amount, level) {
        if (!uplineUid || !(amount > 0)) return;
        var upRef = db.collection("users").doc(uplineUid);
        tx.update(upRef, {
          balance: admin.firestore.FieldValue.increment(amount),
          totalEarnings: admin.firestore.FieldValue.increment(amount),
        });
        tx.set(upRef.collection("transactions").doc(), {
          type: "referral_commission_l" + level,
          amount: amount,
          status: "posted",
          referenceId: refId,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          userId: String(uplineUid),
          meta: {
            fromUid: String(userId),
            fromMasked: depositorMasked,
            level: level,
            source: "deposit",
            depositAmount: amountPhp,
          },
        });
        tx.set(upRef.collection("history").doc(), {
          kind: "referral",
          message: "Referral commission L" + level + " credited",
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      if (isFirstDeposit && upl1) {
        var up1Snap = await tx.get(db.collection("users").doc(upl1));
        if (up1Snap.exists) {
          var up1 = up1Snap.data() || {};
          upl2 = up1.uplineId ? String(up1.uplineId) : "";
        }
        creditCommission(upl1, amt1, 1);
      }
      if (isFirstDeposit && upl2) {
        var up2Snap = await tx.get(db.collection("users").doc(upl2));
        if (up2Snap.exists) {
          var up2 = up2Snap.data() || {};
          upl3 = up2.uplineId ? String(up2.uplineId) : "";
        }
        creditCommission(upl2, amt2, 2);
      }
      if (isFirstDeposit && upl3) {
        creditCommission(upl3, amt3, 3);
      }
      if (evtRef) {
        tx.set(evtRef, {
          provider: "paymongo",
          providerEventId: providerEventId,
          userId: String(userId),
          depositId: depositId,
          amountPhp: amountPhp,
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });
  } catch (e) {
    if (String((e && e.message) || "") === "duplicate_event") {
      return json(200, { ok: true, duplicate: true });
    }
    return json(500, { error: "webhook_processing_failed" });
  }

  return json(200, { ok: true, credited: true });
};
