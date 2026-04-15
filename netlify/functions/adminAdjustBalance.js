const { admin, json, requireAdmin, preflight, corsHeaders } = require("./_lib");

/**
 * Admin-only balance adjustments with explicit accounting bucket.
 * POST JSON: { targetUid, amount, mode, vipLevel? }
 * - mode "add_deposit": credits balance + depositPrincipal + totalDeposits (like a deposit)
 * - mode "add_earning": credits balance + totalEarnings (withdrawable-style credit)
 * - mode "deduct": debits balance; reduces depositPrincipal by min(principal, amount) first
 * amount must be > 0 for balance modes. vipLevel optional 1–15 (updates even if amount 0).
 */
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

  var u = await requireAdmin(event);
  if (!u.ok) return json(u.statusCode, { error: u.error });

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "bad_json" });
  }

  var targetUid = String(body.targetUid || "").trim();
  var amount = Number(body.amount || 0);
  var mode = String(body.mode || "").trim();
  var vipLevel = body.vipLevel != null ? Number(body.vipLevel) : null;

  if (!targetUid) return json(400, { error: "target_required" });
  if (vipLevel != null && (isNaN(vipLevel) || vipLevel < 1 || vipLevel > 15)) {
    return json(400, { error: "vip_invalid" });
  }

  if (amount > 0 && !["add_deposit", "add_earning", "deduct"].includes(mode)) {
    return json(400, { error: "mode_invalid" });
  }

  if (!(amount > 0) && vipLevel == null) {
    return json(400, { error: "nothing_to_apply" });
  }

  var db = admin.firestore();
  var userRef = db.collection("users").doc(targetUid);
  var adminUid = u.uid;

  try {
    await db.runTransaction(async function (tx) {
      var snap = await tx.get(userRef);
      if (!snap.exists) throw new Error("no_user");
      var d = snap.data() || {};
      var updates = {};

      if (vipLevel != null) {
        updates.vipLevel = vipLevel;
        updates.vipPurchased = true;
      }

      if (amount > 0 && mode === "add_deposit") {
        updates.balance = admin.firestore.FieldValue.increment(amount);
        updates.depositPrincipal = admin.firestore.FieldValue.increment(amount);
        updates.totalDeposits = admin.firestore.FieldValue.increment(amount);
      } else if (amount > 0 && mode === "add_earning") {
        updates.balance = admin.firestore.FieldValue.increment(amount);
        updates.totalEarnings = admin.firestore.FieldValue.increment(amount);
      } else if (amount > 0 && mode === "deduct") {
        var bal = Number(d.balance || 0);
        var pr = Number(d.depositPrincipal || 0);
        if (bal < amount) throw new Error("insufficient_balance");
        var prDec = Math.min(pr, amount);
        updates.balance = admin.firestore.FieldValue.increment(-amount);
        updates.depositPrincipal = admin.firestore.FieldValue.increment(-prDec);
      }

      if (Object.keys(updates).length) {
        updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        tx.update(userRef, updates);
      }

      if (amount > 0) {
        tx.set(userRef.collection("transactions").doc(), {
          type: "admin_" + mode,
          amount: mode === "deduct" ? -amount : amount,
          status: "posted",
          referenceId: "ADM-" + Date.now(),
          userId: targetUid,
          adminUid: adminUid,
          meta: { mode: mode },
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
        tx.set(userRef.collection("history").doc(), {
          kind: "admin_adjust",
          message: "Admin " + mode + " " + (mode === "deduct" ? "-" : "+") + amount,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      tx.set(db.collection("adminAudit").doc(), {
        kind: "admin_adjust_balance",
        targetUid: targetUid,
        mode: mode || null,
        amount: amount > 0 ? amount : null,
        vipLevel: vipLevel != null ? vipLevel : null,
        adminUid: adminUid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    var msg = String((err && err.message) || err);
    if (msg === "insufficient_balance") return json(400, { error: "insufficient_balance" });
    if (msg === "no_user") return json(404, { error: "user_not_found" });
    return json(500, { error: "adjust_failed", detail: msg });
  }

  return json(200, { ok: true });
};
