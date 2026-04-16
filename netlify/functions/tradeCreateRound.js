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

  var side = String(body.side || "");
  var stake = Number(body.stake || 0);
  var symbol = String(body.symbol || "BTC");
  if (!(stake > 0)) return json(400, { error: "stake_required" });
  if (side !== "CALL" && side !== "PUT") return json(400, { error: "side_required" });

  var db = admin.firestore();
  var userRef = db.collection("users").doc(u.uid);
  var roundRef = db.collection("tradeRounds").doc();

  var tradeResult = { willWin: false, pnl: 0 };

  try {
    await db.runTransaction(async function (tx) {
    var snap = await tx.get(userRef);
    if (!snap.exists) throw new Error("no_profile");
    var d = snap.data() || {};
    var bal = Number(d.balance || 0);
    if (stake > bal) throw new Error("insufficient_balance");

    // Fair outcome: independent random round result.
    var seq = Number(d.tradeSeq || 0);
    var willWin = Math.random() < 0.5;
    var pnl = willWin ? Math.round(stake * 0.72 * 100) / 100 : -stake;
    tradeResult.willWin = willWin;
    tradeResult.pnl = pnl;

    tx.update(userRef, {
      tradeSeq: seq + 1,
      balance: admin.firestore.FieldValue.increment(pnl),
      totalEarnings: admin.firestore.FieldValue.increment(Math.max(0, pnl)),
      tradeCommissionEarnings: admin.firestore.FieldValue.increment(Math.max(0, pnl)),
    });

    tx.set(roundRef, {
      userId: u.uid,
      side: side,
      symbol: symbol,
      stake: stake,
      win: willWin,
      pnl: pnl,
      status: "closed",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.set(userRef.collection("trades").doc(roundRef.id), {
      side: side,
      symbol: symbol,
      stake: stake,
      win: willWin,
      pnl: pnl,
      status: "closed",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.set(userRef.collection("transactions").doc(), {
      type: "trade",
      amount: pnl,
      status: "posted",
      referenceId: "TR-" + roundRef.id.slice(0, 10).toUpperCase(),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      userId: u.uid,
      meta: { side: side, symbol: symbol, win: willWin },
    });

    tx.set(userRef.collection("history").doc(), {
      kind: "trade",
      message: side + " " + symbol + " " + (willWin ? "WIN" : "LOSS"),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  } catch (err) {
    var msg = String((err && err.message) || err || "trade_failed");
    if (msg === "insufficient_balance") return json(400, { error: "insufficient_balance" });
    if (msg === "no_profile") return json(400, { error: "no_profile" });
    return json(500, { error: "trade_failed", detail: msg });
  }

  return json(200, { ok: true, roundId: roundRef.id, win: tradeResult.willWin, pnl: tradeResult.pnl });
};

