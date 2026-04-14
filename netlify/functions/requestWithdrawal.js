const { admin, json, requireUser, preflight, corsHeaders } = require("./_lib");

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

  var amount = Number(body.amount || 0);
  var method = String(body.method || "");
  var accountName = String(body.accountName || "");
  var accountNumber = String(body.accountNumber || "");

  if (!(amount > 0)) return json(400, { error: "amount_required" });
  if (!method || !accountName || !accountNumber) return json(400, { error: "payout_details_required" });

  var fee = Math.round(amount * 0.1 * 100) / 100;
  var net = Math.round((amount - fee) * 100) / 100;

  var db = admin.firestore();
  var userRef = db.collection("users").doc(u.uid);
  var wdRef = db.collection("withdrawals").doc();

  await db.runTransaction(async function (tx) {
    var snap = await tx.get(userRef);
    if (!snap.exists) throw new Error("no_profile");
    var d = snap.data() || {};

    var bal = Number(d.balance || 0);
    var principal = Number(d.depositPrincipal || 0);
    var withdrawable = Math.max(0, bal - principal);

    if (!(Number(d.totalDeposits || 0) > 0)) throw new Error("deposit_required");
    if (amount > withdrawable) throw new Error("insufficient_withdrawable");

    tx.update(userRef, {
      balance: admin.firestore.FieldValue.increment(-amount),
      heldBalance: admin.firestore.FieldValue.increment(amount),
    });

    tx.set(wdRef, {
      userId: u.uid,
      amountGross: amount,
      handlingFee: fee,
      amountNet: net,
      method: method,
      accountName: accountName,
      accountNumber: accountNumber,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.set(userRef.collection("transactions").doc(), {
      type: "withdraw_request",
      amount: -amount,
      status: "pending",
      referenceId: "WD-" + wdRef.id.slice(0, 10).toUpperCase(),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      userId: u.uid,
      note: "10% fee · net " + net.toFixed(2),
    });
    tx.set(userRef.collection("history").doc(), {
      kind: "withdrawal",
      message: "Withdrawal requested",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(userRef.collection("logs").doc(), {
      level: "info",
      message: "Withdrawal requested",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return json(200, { ok: true, withdrawalId: wdRef.id });
};

