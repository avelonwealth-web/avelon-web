const { admin, json, requireUser, preflight, corsHeaders } = require("./_lib");

const VIPS = [
  { level: 1, deposit: 500 },
  { level: 2, deposit: 1500 },
  { level: 3, deposit: 3500 },
  { level: 4, deposit: 7500 },
  { level: 5, deposit: 15000 },
  { level: 6, deposit: 20000 },
  { level: 7, deposit: 25000 },
  { level: 8, deposit: 30000 },
  { level: 9, deposit: 40000 },
  { level: 10, deposit: 50000 },
  { level: 11, deposit: 75000 },
  { level: 12, deposit: 100000 },
  { level: 13, deposit: 125000 },
  { level: 14, deposit: 150000 },
  { level: 15, deposit: 200000 },
];

exports.handler = async function (event) {
  var opt = preflight(event);
  if (opt) return opt;
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, corsHeaders()), body: "Method Not Allowed" };
  }
  var u = await requireUser(event);
  if (!u.ok) return json(u.statusCode, { error: u.error });

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "bad_json" });
  }
  var target = Number(body.vipLevel || 0);
  var tier = VIPS.find(function (x) {
    return x.level === target;
  });
  if (!tier) return json(400, { error: "vip_invalid" });

  var db = admin.firestore();
  var uref = db.collection("users").doc(u.uid);

  await db.runTransaction(async function (tx) {
    var snap = await tx.get(uref);
    if (!snap.exists) throw new Error("user_not_found");
    var d = snap.data() || {};
    var curVip = Number(d.vipLevel || 1);
    if (target <= curVip) throw new Error("vip_already_owned");
    if (!(Number(d.totalDeposits || 0) > 0)) throw new Error("deposit_required");
    var bal = Number(d.balance || 0);
    var cost = Number(tier.deposit || 0);
    if (bal < cost) throw new Error("insufficient_balance");

    tx.update(uref, {
      balance: admin.firestore.FieldValue.increment(-cost),
      vipLevel: target,
      vipPurchased: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.set(uref.collection("transactions").doc(), {
      type: "vip_purchase",
      amount: -cost,
      status: "posted",
      referenceId: "VIP-" + target + "-" + Date.now(),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      userId: u.uid,
      note: "VIP " + target + " purchased",
    });
    tx.set(uref.collection("history").doc(), {
      kind: "vip",
      message: "VIP " + target + " activated",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(uref.collection("logs").doc(), {
      level: "info",
      message: "VIP " + target + " purchase completed",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return json(200, { ok: true, vipLevel: target });
};

