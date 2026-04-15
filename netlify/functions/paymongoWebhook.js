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
  if (obj.userId || obj.uid) {
    return {
      userId: String(obj.userId || obj.uid || ""),
      depositId: obj.depositId ? String(obj.depositId) : null,
      amountPhp: Number(obj.amountPhp || obj.amount || 0),
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

async function findPendingDepositByAmount(db, amountPhp) {
  if (!(amountPhp > 0)) return null;
  var q = await db
    .collection("deposits")
    .where("status", "in", ["created", "checkout_created"])
    .where("amountPhp", "==", amountPhp)
    .orderBy("createdAt", "desc")
    .limit(3)
    .get();
  if (q.size === 1) {
    var d = q.docs[0];
    return { id: d.id, data: d.data() || {} };
  }
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

  var paymentId = deepFindPaymentId(payload, 0);
  var amountCentavosGuess = deepFindAmountCentavos(payload, 0);
  var meta = deepFindMeta(payload, 0);
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
      var pending = await findPendingDepositByAmount(admin.firestore(), amountGuessPhp);
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
    return json(200, { ok: true, ignored: true, reason: "no_user_metadata" });
  }

  var userId = meta.userId;
  var depositId = meta.depositId;
  var amountPhp = Number(meta.amountPhp || 0);
  var paymentMethod = extractPaymentMethod(payload);
  if (!(amountPhp > 0) && amountCentavosGuess > 0) amountPhp = amountCentavosGuess / 100;
  if (!(amountPhp > 0) && depositId) {
    try {
      var depSnap0 = await admin.firestore().collection("deposits").doc(String(depositId)).get();
      if (depSnap0.exists) {
        var dep0 = depSnap0.data() || {};
        amountPhp = Number(dep0.amountPhp || 0);
      }
    } catch (e) {}
  }
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
            providerPaymentId: paymentId || null,
            credited: true,
            creditedVia: "webhook",
            creditedAt: admin.firestore.FieldValue.serverTimestamp(),
            paymentMethod: paymentMethod || admin.firestore.FieldValue.delete(),
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

      var upl1 = resolveUplineId(u);
      var upl2 = "";
      var upl3 = "";
      var amt1 = Math.round(amountPhp * 0.1 * 100) / 100;
      var amt2 = Math.round(amountPhp * 0.04 * 100) / 100;
      var amt3 = Math.round(amountPhp * 0.01 * 100) / 100;

      if (upl1) {
        var up1SnapForChain = await tx.get(db.collection("users").doc(upl1));
        if (up1SnapForChain.exists) {
          var up1ForChain = up1SnapForChain.data() || {};
          upl2 = resolveUplineId(up1ForChain);
        }
      }
      if (upl2) {
        var up2SnapForChain = await tx.get(db.collection("users").doc(upl2));
        if (up2SnapForChain.exists) {
          var up2ForChain = up2SnapForChain.data() || {};
          upl3 = resolveUplineId(up2ForChain);
        }
      }

      function logDownlineDeposit(uplineUid, level) {
        if (!uplineUid || !(level >= 1 && level <= 3)) return;
        var upRef = db.collection("users").doc(uplineUid);
        tx.set(upRef.collection("downlineDeposits").doc(), {
          fromUid: String(userId),
          fromMasked: depositorMasked,
          level: level,
          depositAmount: amountPhp,
          referenceId: refId,
          source: "paymongo",
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

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
      logDownlineDeposit(upl1, 1);
      logDownlineDeposit(upl2, 2);
      logDownlineDeposit(upl3, 3);

      if (isFirstDeposit && upl1) {
        creditCommission(upl1, amt1, 1);
      }
      if (isFirstDeposit && upl2) {
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
