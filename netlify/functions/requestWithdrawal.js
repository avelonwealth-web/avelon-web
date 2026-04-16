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

  try {
    await db.runTransaction(async function (tx) {
      var snap = await tx.get(userRef);
      if (!snap.exists) throw new Error("no_profile");
      var d = snap.data() || {};

      var bal = Number(d.balance || 0);
      var principal = Number(d.depositPrincipal || 0);
      var baseWithdrawable = Math.max(0, bal - principal);
      var vipPurchased = d.vipPurchased === true || Number(d.vipLevel || 0) >= 1;
      var bonusLocked = vipPurchased ? 0 : Math.max(0, Number(d.signupBonusLocked || 0));
      var withdrawable = Math.max(0, baseWithdrawable - bonusLocked);
      if (!(Number(d.totalDeposits || 0) > 0)) throw new Error("deposit_required");

      // Trading earnings guardrails:
      // - trade profits (CALL/PUT) are withdrawable only when user has deposit history (checked above)
      // - requires VIP 4+ for trading-earnings withdrawals
      var vipLevel = Number(d.vipLevel || 0);
      var tradeQ = userRef.collection("transactions").where("type", "==", "trade").where("amount", ">", 0).limit(120);
      var tradeSnap = await tx.get(tradeQ);
      var tradingEarnings = 0;
      tradeSnap.forEach(function (t) {
        var td = t.data() || {};
        tradingEarnings += Number(td.amount || 0);
      });
      if (tradingEarnings > 0 && vipLevel < 4) throw new Error("vip4_required_for_trade_withdraw");

      // Commission source threshold rule: invite + daily VIP commissions require minimum 500.
      var cmQ = userRef
        .collection("transactions")
        .where("type", "in", ["referral_commission_l1", "referral_commission_l2", "referral_commission_l3", "vip_daily_commission"])
        .where("amount", ">", 0)
        .limit(120);
      var cmSnap = await tx.get(cmQ);
      var commissionBucket = 0;
      cmSnap.forEach(function (c) {
        var cd = c.data() || {};
        commissionBucket += Number(cd.amount || 0);
      });
      if (commissionBucket > 0 && amount < 500) throw new Error("min_withdraw_500_for_commissions");

      if (amount > withdrawable && bonusLocked > 0 && amount <= baseWithdrawable) {
        throw new Error("vip_required_for_signup_bonus");
      }
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
  } catch (err) {
    var msg = String((err && err.message) || err);
    if (msg === "no_profile") return json(400, { error: "no_profile" });
    if (msg === "deposit_required") return json(400, { error: "deposit_required" });
    if (msg === "vip4_required_for_trade_withdraw") return json(400, { error: "vip4_required_for_trade_withdraw" });
    if (msg === "min_withdraw_500_for_commissions") return json(400, { error: "min_withdraw_500_for_commissions" });
    if (msg === "vip_required_for_signup_bonus") return json(400, { error: "vip_required_for_signup_bonus" });
    if (msg === "insufficient_withdrawable") return json(400, { error: "insufficient_withdrawable" });
    return json(500, { error: "withdraw_failed", detail: msg });
  }

  return json(200, { ok: true, withdrawalId: wdRef.id });
};

