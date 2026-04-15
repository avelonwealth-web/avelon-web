const { admin, json, requireAdmin, preflight } = require("./_lib");

function isSafeDocId(v) {
  var s = String(v || "").trim();
  return !!s && s.length <= 128 && s.indexOf("/") < 0;
}

async function deleteCollectionTree(ref, batchSize) {
  var size = Math.max(50, Number(batchSize || 300));
  for (;;) {
    var snap = await ref.limit(size).get();
    if (snap.empty) break;
    var batch = ref.firestore.batch();
    snap.docs.forEach(function (d) {
      batch.delete(d.ref);
    });
    await batch.commit();
  }
}

async function deleteUserTree(db, userRef) {
  // Prefer SDK recursive delete when present, fallback to explicit per-subcollection cleanup.
  if (typeof db.recursiveDelete === "function") {
    await db.recursiveDelete(userRef);
    return;
  }
  var subs = await userRef.listCollections();
  for (var i = 0; i < subs.length; i++) {
    await deleteCollectionTree(subs[i], 300);
  }
  await userRef.delete();
}

function isQuotaErr(e) {
  var msg = String((e && (e.message || e.code)) || "").toLowerCase();
  return msg.indexOf("resource_exhausted") >= 0 || msg.indexOf("quota") >= 0 || msg.indexOf("8 resource_exhausted") >= 0;
}

async function deleteAuthOnly(targetUid) {
  var uid = String(targetUid || "").trim();
  if (!uid) return false;
  try {
    await admin.auth().deleteUser(uid);
    return true;
  } catch (e) {
    if (e && e.code === "auth/user-not-found") return true;
    return false;
  }
}

/**
 * Admin-only: remove a member account (Auth + Firestore profile subtree).
 * POST JSON: { targetUid }
 * - Refuses admin targets and self-delete.
 * - Removes upline downline edge + decrements upline downlineCount (floored at 0).
 * - Deletes referralLookup entry when it maps to this uid.
 * - Deletes withdrawal queue rows for this user.
 * - Deletes Auth user by uid, and by synthetic mobile email fallback when needed.
 */
exports.handler = async function (event) {
  try {
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
    if (!isSafeDocId(targetUid)) return json(400, { error: "target_invalid" });
    if (targetUid === gate.uid) return json(400, { error: "cannot_delete_self" });

    var db = admin.firestore();
    var userRef = db.collection("users").doc(targetUid);
    var pre = await userRef.get();
    if (!pre.exists) return json(404, { error: "user_not_found" });
    var prof = pre.data() || {};
    if (prof.role === "admin") return json(403, { error: "cannot_delete_admin" });

    var uplineId = String(prof.uplineId || "").trim();
    var refCode = String(prof.referralCode || "").trim().toUpperCase();
    var authDeleted = false;

    // Priority: delete Auth first so same mobile can register again immediately.
    try {
      await admin.auth().deleteUser(targetUid);
      authDeleted = true;
    } catch (e) {
      if (e && e.code !== "auth/user-not-found") throw e;
      if (e && e.code === "auth/user-not-found") authDeleted = true;
      var authEmail = String(prof.email || "").trim().toLowerCase();
      if (/^\d{12}@phone\.avelon-wealth\.local$/.test(authEmail)) {
        try {
          var byEmail = await admin.auth().getUserByEmail(authEmail);
          await admin.auth().deleteUser(byEmail.uid);
          authDeleted = true;
          if (byEmail.uid && byEmail.uid !== targetUid) {
            try {
              await deleteUserTree(db, db.collection("users").doc(byEmail.uid));
            } catch (ignoreOtherDocDelete) {}
          }
        } catch (ee) {
          if (!(ee && ee.code === "auth/user-not-found")) throw ee;
          authDeleted = true;
        }
      }
    }

    // Best-effort relationship cleanup after auth deletion.
    try {
      await db.runTransaction(async function (tx) {
        var snap = await tx.get(userRef);
        if (!snap.exists) return;
        var d = snap.data() || {};
        if (d.role === "admin") return;
        var up = String(d.uplineId || "").trim();
        if (isSafeDocId(up)) {
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
    } catch (eTx) {
      if (!isQuotaErr(eTx)) throw eTx;
    }

    if (refCode) {
      try {
        var lkRef = db.collection("referralLookup").doc(refCode);
        var lk = await lkRef.get();
        if (lk.exists) {
          var lu = String((lk.data() || {}).uid || "").trim();
          if (lu === targetUid) await lkRef.delete();
        }
      } catch (eLk) {
        if (!isQuotaErr(eLk)) throw eLk;
      }
    }

    // Best-effort cleanup: do not fail successful Auth delete on quota limits.
    try {
      var wdSnap = await db.collection("withdrawals").where("userId", "==", targetUid).limit(100).get();
      if (!wdSnap.empty) {
        var batch = db.batch();
        wdSnap.forEach(function (doc) {
          batch.delete(doc.ref);
        });
        await batch.commit();
      }
    } catch (eWd) {
      if (!isQuotaErr(eWd)) throw eWd;
    }

    try {
      await deleteUserTree(db, userRef);
    } catch (eDelTree) {
      if (!isQuotaErr(eDelTree)) throw eDelTree;
      try {
        await userRef.set(
          {
            deleted: true,
            deletedAt: admin.firestore.FieldValue.serverTimestamp(),
            role: "deleted",
            email: null,
            mobile: null,
            mobileNumber: null,
          },
          { merge: true }
        );
      } catch (ignoreMark) {}
    }

    try {
      await db.collection("adminAudit").add({
        kind: "admin_delete_user",
        targetUid: targetUid,
        adminUid: gate.uid,
        uplineId: uplineId || null,
        referralCode: refCode || null,
        authDeleted: !!authDeleted,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (eAudit) {}

    return json(200, { ok: true, authDeleted: !!authDeleted });
  } catch (err) {
    var msg = String((err && err.message) || err);
    if (msg === "no_user") return json(404, { error: "user_not_found" });
    if (msg === "cannot_delete_admin") return json(403, { error: "cannot_delete_admin" });
    if (isQuotaErr(err)) {
      // Firestore quota fallback: still attempt Auth delete so mobile can register again.
      try {
        var authOnlyDeleted = await deleteAuthOnly(targetUid);
        if (authOnlyDeleted) {
          return json(200, { ok: true, authDeleted: true, partial: true, note: "auth_only_delete_due_to_quota" });
        }
      } catch (ignoreAuthOnly) {}
      return json(503, { error: "quota_exhausted_try_later", detail: msg });
    }
    return json(500, { error: "delete_failed", detail: msg });
  }
};
