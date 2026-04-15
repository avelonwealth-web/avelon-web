const https = require("https");
const { admin, json, requireAdmin, preflight, corsHeaders } = require("./_lib");

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

function toMillis(ts) {
  if (!ts) return 0;
  try {
    if (typeof ts.toMillis === "function") return ts.toMillis();
    var n = Number(ts);
    if (isFinite(n) && n > 0) return n;
    var p = Date.parse(String(ts));
    return isFinite(p) && p > 0 ? p : 0;
  } catch (e) {
    return 0;
  }
}

async function listRecentDepositsForUser(db, uid, limitCount) {
  var limitN = Number(limitCount || 30);
  try {
    var qIndexed = await db
      .collection("deposits")
      .where("userId", "==", String(uid))
      .orderBy("createdAt", "desc")
      .limit(limitN)
      .get();
    return qIndexed.docs.slice();
  } catch (e) {
    // Fallback when composite index is missing.
    var qBasic = await db.collection("deposits").where("userId", "==", String(uid)).limit(Math.max(80, limitN)).get();
    var docs = qBasic.docs.slice();
    docs.sort(function (a, b) {
      return toMillis((b.data() || {}).createdAt) - toMillis((a.data() || {}).createdAt);
    });
    return docs.slice(0, limitN);
  }
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

async function creditDeposit(db, depId, depData) {
  var uid = String(depData.userId || "");
  var amountPhp = Number(depData.amountPhp || 0);
  if (!uid || !(amountPhp > 0)) return false;

  var refId = String(depData.referenceId || "PM-ADM-REC-" + depId);
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
        creditedVia: "admin_reconcile",
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
      message: "Deposit credited (admin reconcile)",
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
        source: "admin_reconcile",
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

  var gate = await requireAdmin(event);
  if (!gate.ok) return json(gate.statusCode, { error: gate.error });

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    body = {};
  }
  var targetUid = String((body && body.targetUid) || "").trim();
  if (!targetUid) return json(400, { error: "target_required" });

  var secret = process.env.PAYMONGO_SECRET_KEY || "";
  if (!secret) return json(503, { error: "missing_PAYMONGO_SECRET_KEY" });

  var db = admin.firestore();
  try {
    var docs = await listRecentDepositsForUser(db, targetUid, 30);
    if (!docs.length) return json(200, { ok: true, checked: 0, credited: 0 });

    var checked = 0;
    var credited = 0;
    for (var i = 0; i < docs.length; i++) {
      var doc = docs[i];
      var d = doc.data() || {};
      var st = String(d.status || "").toLowerCase();
      if (st === "paid") continue;
      if (!d.checkoutSessionId) continue;
      checked += 1;
      try {
        var resp = await paymongoGet(
          "/v1/checkout_sessions/" + encodeURIComponent(String(d.checkoutSessionId)),
          secret
        );
        if (resp.status >= 200 && resp.status < 300) {
          var pj = JSON.parse(resp.body || "{}");
          if (looksPaidCheckout(pj)) {
            var done = await creditDeposit(db, doc.id, d);
            if (done) credited += 1;
          }
        }
      } catch (eOne) {}
    }

    await db.collection("adminAudit").add({
      kind: "admin_reconcile_user_deposits",
      adminUid: gate.uid,
      targetUid: targetUid,
      checked: checked,
      credited: credited,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return json(200, { ok: true, checked: checked, credited: credited });
  } catch (e) {
    return json(500, { error: "reconcile_failed", detail: String((e && e.message) || e) });
  }
};
