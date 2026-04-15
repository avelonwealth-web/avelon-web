const { admin, initAdmin, json, preflight, corsHeaders } = require("./_lib");

const VIP_DAILY = {
  1: 25,
  2: 78,
  3: 192.5,
  4: 435,
  5: 900,
  6: 1240,
  7: 1600,
  8: 1980,
  9: 2720,
  10: 3500,
  11: 5250,
  12: 7500,
  13: 9500,
  14: 11500,
  15: 15000,
};

function phDateKey(d) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d || new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function num(v) {
  var n = Number(v || 0);
  return isFinite(n) ? n : 0;
}

function vipDailyForUser(u) {
  var level = Math.max(1, Math.min(15, Math.floor(num(u && u.vipLevel))));
  if (!(u && u.vipPurchased === true)) return 0;
  return num(VIP_DAILY[level]);
}

async function creditOneUser(db, uid, dateKey) {
  var refId = "VIPDAY-" + String(dateKey || "");
  var uref = db.collection("users").doc(String(uid));
  var credited = false;
  await db.runTransaction(async function (tx) {
    var snap = await tx.get(uref);
    if (!snap.exists) return;
    var u = snap.data() || {};
    var daily = vipDailyForUser(u);
    if (!(daily > 0)) return;

    var existing = await tx.get(uref.collection("transactions").where("referenceId", "==", refId).limit(1));
    if (!existing.empty) return;

    tx.update(uref, {
      balance: admin.firestore.FieldValue.increment(daily),
      totalEarnings: admin.firestore.FieldValue.increment(daily),
      vipDailyEarningsTotal: admin.firestore.FieldValue.increment(daily),
      lastVipDailyCommissionAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.set(uref.collection("transactions").doc(), {
      type: "vip_daily_commission",
      amount: daily,
      status: "posted",
      referenceId: refId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      userId: String(uid),
      note: "VIP daily commission auto-posted",
      meta: {
        source: "vip_daily_cron",
        dateKey: String(dateKey || ""),
        vipLevel: Math.max(1, Math.min(15, Math.floor(num(u.vipLevel)))),
      },
    });

    tx.set(uref.collection("history").doc(), {
      kind: "vip_commission",
      message: "VIP daily commission credited",
      amount: daily,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.set(uref.collection("notifications").doc(), {
      kind: "vip_daily_commission",
      title: "VIP commission credited",
      message: "You earned " + daily.toFixed(2) + " from daily VIP commission.",
      amount: daily,
      referenceId: refId,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      dateKey: String(dateKey || ""),
    });
    credited = true;
  });
  return credited;
}

exports.handler = async function (event) {
  var opt = preflight(event);
  if (opt) return opt;
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, corsHeaders()),
      body: "Method Not Allowed",
    };
  }

  try {
    initAdmin();
  } catch (eInit) {
    return json(500, { error: "admin_init_failed" });
  }

  var db = admin.firestore();
  var dateKey = phDateKey(new Date());
  var jobRef = db.collection("systemJobs").doc("vipDailyCommission");

  try {
    await jobRef.set(
      {
        lastStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastDateKey: String(dateKey),
      },
      { merge: true }
    );

    var paid = 0;
    var scanned = 0;
    var lastDoc = null;
    while (true) {
      var q = db.collection("users").where("vipPurchased", "==", true).limit(200);
      if (lastDoc) q = q.startAfter(lastDoc);
      var snap = await q.get();
      if (snap.empty) break;

      for (var i = 0; i < snap.docs.length; i++) {
        var d = snap.docs[i];
        scanned += 1;
        try {
          var did = await creditOneUser(db, d.id, dateKey);
          if (did) paid += 1;
        } catch (eOne) {}
      }
      lastDoc = snap.docs[snap.docs.length - 1];
      if (snap.size < 200) break;
    }

    await jobRef.set(
      {
        lastCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastDateKey: String(dateKey),
        lastScanned: scanned,
        lastProcessed: paid,
      },
      { merge: true }
    );

    return json(200, { ok: true, dateKey: dateKey, scanned: scanned, processed: paid });
  } catch (e) {
    return json(500, { error: "vip_daily_commission_failed", detail: String((e && e.message) || e) });
  }
};

