const { admin, json, requireAdmin, preflight } = require("./_lib");

/**
 * Admin-only: remove a member account (Auth + Firestore profile subtree).
 * POST JSON: { targetUid }
 * - Refuses admin targets and self-delete.
 * - Removes upline downline edge + decrements upline downlineCount (floored at 0).
 * - Deletes referralLookup entry when it maps to this uid.
 * - Deletes withdrawal queue rows for this user.
 */
exports.handler = async function (event) {
  var opt = preflight(event);
  if (opt) return opt;
  if (event.httpMethod !== "POST") {
    return json(405, { error: "method" });
  }

  var gate = await requireAdmin(event);
  if (!gate.ok) return json(gate.statusCode, { error: gate.error });

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "bad_json" });
  }

  var targetUid = String(body.targetUid || "").trim();
  if (!targetUid) return json(400, { error: "target_required" });
  if (targetUid === gate.uid) return json(400, { error: "cannot_delete_self" });

  var db = admin.firestore();
  var userRef = db.collection("users").doc(targetUid);

  try {
    var pre = await userRef.get();
    if (!pre.exists) return json(404, { error: "user_not_found" });
    var prof = pre.data() || {};
    if (prof.role === "admin") return json(403, { error: "cannot_delete_admin" });

    var uplineId = String(prof.uplineId || "").trim();
    var refCode = String(prof.referralCode || "").trim().toUpperCase();

    await db.runTransaction(async function (tx) {
      var snap = await tx.get(userRef);
      if (!snap.exists) throw new Error("no_user");
      var d = snap.data() || {};
      if (d.role === "admin") throw new Error("cannot_delete_admin");

      var up = String(d.uplineId || "").trim();
      if (up) {
        var uplineRef = db.collection("users").doc(up);
        var uplineSnap = await tx.get(uplineRef);
        if (uplineSnap.exists) {
          var ud = uplineSnap.data() || {};
          var c = Number(ud.downlineCount || 0);
          tx.update(uplineRef, { downlineCount: Math.max(0, c - 1) });
        }
        tx.delete(uplineRef.collection("downlines").doc(targetUid));
      }
    });

    if (refCode) {
      var lkRef = db.collection("referralLookup").doc(refCode);
      var lk = await lkRef.get();
      if (lk.exists) {
        var lu = String((lk.data() || {}).uid || "").trim();
        if (lu === targetUid) await lkRef.delete();
      }
    }

    for (;;) {
      var wdSnap = await db.collection("withdrawals").where("userId", "==", targetUid).limit(400).get();
      if (wdSnap.empty) break;
      var batch = db.batch();
      wdSnap.forEach(function (doc) {
        batch.delete(doc.ref);
      });
      await batch.commit();
    }

    await db.recursiveDelete(userRef);

    try {
      await admin.auth().deleteUser(targetUid);
    } catch (e) {
      if (e && e.code !== "auth/user-not-found") throw e;
    }

    await db.collection("adminAudit").add({
      kind: "admin_delete_user",
      targetUid: targetUid,
      adminUid: gate.uid,
      uplineId: uplineId || null,
      referralCode: refCode || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return json(200, { ok: true });
  } catch (err) {
    var msg = String((err && err.message) || err);
    if (msg === "no_user") return json(404, { error: "user_not_found" });
    if (msg === "cannot_delete_admin") return json(403, { error: "cannot_delete_admin" });
    return json(500, { error: "delete_failed", detail: msg });
  }
};
