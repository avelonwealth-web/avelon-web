const { admin, json, requireUser, preflight, corsHeaders } = require("./_lib");
const https = require("https");

function paymongoGet(path, secretKey) {
  var token = Buffer.from(String(secretKey || "") + ":", "utf8").toString("base64");
  return new Promise(function (resolve, reject) {
    var req = https.request(
      {
        hostname: "api.paymongo.com",
        path: path,
        method: "GET",
        headers: { Authorization: "Basic " + token, Accept: "application/json" },
      },
      function (res) {
        var data = "";
        res.on("data", function (c) {
          data += c;
        });
        res.on("end", function () {
          resolve({ status: res.statusCode, body: data });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function looksPaidCheckout(j) {
  try {
    var a = (j && j.data && j.data.attributes) || {};
    var st = String(a.status || "").toLowerCase();
    if (st === "paid") return true;
    var p = a.payments;
    if (Array.isArray(p)) {
      for (var i = 0; i < p.length; i++) {
        var ps = String((p[i] && p[i].attributes && p[i].attributes.status) || "").toLowerCase();
        if (ps === "paid") return true;
      }
    }
  } catch (e) {}
  return false;
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

async function alreadyCredited(db, uid, refId) {
  if (!refId) return false;
  var q = await db
    .collection("users")
    .doc(String(uid))
    .collection("transactions")
    .where("referenceId", "==", String(refId))
    .limit(1)
    .get();
  return !q.empty;
}

async function creditDepositFromFallback(db, depId, depData) {
  var uid = String(depData.userId || "");
  var amountPhp = Number(depData.amountPhp || 0);
  if (!uid || !(amountPhp > 0)) return false;

  var refId = String(depData.referenceId || "PM-SYNC-" + depId);
  if (await alreadyCredited(db, uid, refId)) {
    await db.collection("deposits").doc(depId).set(
      {
        status: "paid",
        credited: true,
        referenceId: refId,
        creditedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  }

  var userRef = db.collection("users").doc(uid);
  await db.runTransaction(async function (tx) {
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
    tx.set(
      db.collection("deposits").doc(depId),
      {
        status: "paid",
        provider: "paymongo",
        referenceId: refId,
        credited: true,
        creditedVia: "sync_status_fallback",
        creditedAt: admin.firestore.FieldValue.serverTimestamp(),
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
      userId: uid,
    });
    tx.set(userRef.collection("history").doc(), {
      kind: "deposit",
      message: "Deposit credited (sync fallback)",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    var upl1 = resolveUplineId(u);
    var upl2 = "";
    var upl3 = "";
    var amt1 = Math.round(amountPhp * 0.1 * 100) / 100;
    var amt2 = Math.round(amountPhp * 0.04 * 100) / 100;
    var amt3 = Math.round(amountPhp * 0.01 * 100) / 100;
    if (upl1) {
      var up1 = await tx.get(db.collection("users").doc(upl1));
      if (up1.exists) upl2 = resolveUplineId(up1.data() || {});
      else upl1 = "";
    }
    if (upl2) {
      var up2 = await tx.get(db.collection("users").doc(upl2));
      if (up2.exists) upl3 = resolveUplineId(up2.data() || {});
      else upl2 = "";
    }
    if (upl3) {
      var up3 = await tx.get(db.collection("users").doc(upl3));
      if (!up3.exists) upl3 = "";
    }
    function logDownlineDeposit(uplineUid, level) {
      if (!uplineUid || !(level >= 1 && level <= 3)) return;
      tx.set(db.collection("users").doc(uplineUid).collection("downlineDeposits").doc(), {
        fromUid: uid,
        fromMasked: depositorMasked,
        level: level,
        depositAmount: amountPhp,
        referenceId: refId,
        source: "deposit_sync_status",
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
        meta: { fromUid: uid, fromMasked: depositorMasked, level: level, source: "deposit", depositAmount: amountPhp },
      });
    }
    logDownlineDeposit(upl1, 1);
    logDownlineDeposit(upl2, 2);
    logDownlineDeposit(upl3, 3);
    if (isFirstDeposit && upl1) creditCommission(upl1, amt1, 1);
    if (isFirstDeposit && upl2) creditCommission(upl2, amt2, 2);
    if (isFirstDeposit && upl3) creditCommission(upl3, amt3, 3);
  });
  return true;
}

async function tryReconcileDeposit(db, depId, depData, secretKey) {
  var dep = depData || {};
  var statusNow = String(dep.status || "");
  if (statusNow === "paid") return { changed: false, status: "paid" };
  if (!dep.checkoutSessionId || !secretKey) return { changed: false, status: statusNow || "none" };
  try {
    var resp = await paymongoGet(
      "/v1/checkout_sessions/" + encodeURIComponent(String(dep.checkoutSessionId)),
      secretKey
    );
    if (resp.status >= 200 && resp.status < 300) {
      var pj = JSON.parse(resp.body || "{}");
      if (looksPaidCheckout(pj)) {
        await creditDepositFromFallback(db, depId, dep);
        var re = await db.collection("deposits").doc(depId).get();
        var d2 = re.exists ? re.data() || {} : dep;
        return { changed: true, status: String(d2.status || "") };
      }
    }
  } catch (e) {}
  return { changed: false, status: statusNow || "none" };
}

exports.handler = async function (event) {
  var opt = preflight(event);
  if (opt) return opt;
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, corsHeaders()),
      body: "Method Not Allowed",
    };
  }

  var u = await requireUser(event);
  if (!u.ok) return json(u.statusCode, { error: u.error });

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    body = {};
  }
  var depositId = String((body && body.depositId) || "").trim();

  var db = admin.firestore();
  try {
    if (depositId) {
      var depSnap = await db.collection("deposits").doc(depositId).get();
      if (depSnap.exists) {
        var dep = depSnap.data() || {};
        if (String(dep.userId || "") !== u.uid) return json(403, { error: "forbidden" });
        var statusNow = String(dep.status || "");
        if (statusNow !== "paid") {
          var rec = await tryReconcileDeposit(db, depositId, dep, process.env.PAYMONGO_SECRET_KEY || "");
          statusNow = String(rec.status || statusNow);
        }
        return json(200, {
          ok: true,
          status: statusNow,
          amountPhp: Number(dep.amountPhp || 0),
          updatedAt: dep.updatedAt || dep.createdAt || null,
          depositId: depositId,
        });
      }
    }
    var q = await db
      .collection("deposits")
      .where("userId", "==", u.uid)
      .orderBy("createdAt", "desc")
      .limit(8)
      .get();
    if (q.empty) return json(200, { ok: true, status: "none" });

    var docs = q.docs.slice();
    var paidDoc = null;
    for (var i = 0; i < docs.length; i++) {
      var row = docs[i].data() || {};
      if (String(row.status || "") === "paid") {
        paidDoc = { id: docs[i].id, data: row };
        break;
      }
    }
    if (!paidDoc) {
      for (var j = 0; j < docs.length; j++) {
        var d0 = docs[j].data() || {};
        var st0 = String(d0.status || "");
        if (st0 === "paid") {
          paidDoc = { id: docs[j].id, data: d0 };
          break;
        }
        // Reconcile unresolved recent deposits (created/checkout_created/pending) against PayMongo.
        if (!d0.checkoutSessionId) continue;
        var rec2 = await tryReconcileDeposit(db, docs[j].id, d0, process.env.PAYMONGO_SECRET_KEY || "");
        if (String(rec2.status || "") === "paid") {
          var re2 = await db.collection("deposits").doc(docs[j].id).get();
          paidDoc = { id: docs[j].id, data: re2.exists ? re2.data() || d0 : d0 };
          break;
        }
      }
    }

    var latestDoc = paidDoc || { id: docs[0].id, data: docs[0].data() || {} };
    var d = latestDoc.data || {};
    var latestStatus = String(d.status || "");
    return json(200, {
      ok: true,
      status: latestStatus,
      amountPhp: Number(d.amountPhp || 0),
      updatedAt: d.updatedAt || d.createdAt || null,
      depositId: latestDoc.id,
    });
  } catch (e) {
    return json(500, { error: "status_failed", detail: String((e && e.message) || e) });
  }
};

