const { admin, json, requireAdmin } = require("./_lib");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  var u = await requireAdmin(event);
  if (!u.ok) return json(u.statusCode, { error: u.error });

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "bad_json" });
  }
  var id = String(body.withdrawalId || "");
  var reason = String(body.reason || "");
  if (!id) return json(400, { error: "withdrawalId_required" });

  var db = admin.firestore();
  var wdRef = db.collection("withdrawals").doc(id);

  await db.runTransaction(async function (tx) {
    var snap = await tx.get(wdRef);
    if (!snap.exists) throw new Error("not_found");
    var d = snap.data() || {};
    if (d.status !== "pending") return;

    var amt = Number(d.amountGross || 0);
    var userId = String(d.userId || "");
    if (!userId || !(amt > 0)) throw new Error("bad_doc");

    tx.update(wdRef, {
      status: "rejected",
      rejectReason: reason || "rejected",
      decidedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      decidedBy: u.uid,
    });

    // Reverse hold back to available balance.
    tx.update(db.collection("users").doc(userId), {
      balance: admin.firestore.FieldValue.increment(amt),
      heldBalance: admin.firestore.FieldValue.increment(-amt),
    });

    tx.set(db.collection("adminAudit").doc(), {
      kind: "withdrawal_reject",
      withdrawalId: id,
      userId: userId,
      amountGross: amt,
      reason: reason || "",
      adminUid: u.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return json(200, { ok: true });
};

