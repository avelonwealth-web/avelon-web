const { admin, json, requireUser, preflight } = require("./_lib");

function displayMobileFromSyntheticEmail(email) {
  var m = /^(\d{12})@phone\.avelon-wealth\.local$/i.exec(String(email || ""));
  if (!m) return "";
  var e164 = m[1];
  if (!/^639\d{9}$/.test(e164)) return "";
  return "0" + e164.slice(2);
}

/**
 * Signed-in member: fill missing Firestore profile fields from Firebase Auth (Admin SDK).
 * POST (no body). Safe idempotent merge — never overwrites non-empty name/mobile/email.
 */
exports.handler = async function (event) {
  var opt = preflight(event);
  if (opt) return opt;
  if (event.httpMethod !== "POST") {
    return json(405, { error: "method" });
  }

  var gate = await requireUser(event);
  if (!gate.ok) return json(gate.statusCode, { error: gate.error });

  var uid = gate.uid;

  try {
    var db = admin.firestore();
    var ref = db.collection("users").doc(uid);
    var snap = await ref.get();
    if (!snap.exists) {
      return json(200, { ok: true, skipped: true, reason: "no_profile" });
    }

    var d = snap.data() || {};
    if (d.role === "admin") {
      return json(200, { ok: true, skipped: true, reason: "admin" });
    }

    var authUser = await admin.auth().getUser(uid);
    var patch = {};

    var un = String(d.userName || "").trim();
    var dn = String(d.displayName || "").trim();
    var authDn = String(authUser.displayName || "").trim();

    if (!dn && un) {
      patch.displayName = un;
    } else if (!un && dn) {
      patch.userName = dn;
    } else if (!un && !dn && authDn) {
      patch.userName = authDn;
      patch.displayName = authDn;
    }

    var mob = String(d.mobileNumber || d.mobile || "").trim();
    if (!mob && authUser.email) {
      var dm = displayMobileFromSyntheticEmail(authUser.email);
      if (dm) {
        patch.mobileNumber = dm;
        patch.mobile = dm;
      }
    }

    if (!String(d.email || "").trim() && authUser.email) {
      patch.email = authUser.email;
    }

    var authLabelFs = String(d.userName || d.displayName || "").trim();
    var authUpdated = false;
    if (!String(authUser.displayName || "").trim() && authLabelFs) {
      await admin.auth().updateUser(uid, { displayName: authLabelFs });
      authUpdated = true;
    }

    if (!Object.keys(patch).length) {
      return json(200, { ok: true, updated: authUpdated, firestore: false, auth: authUpdated });
    }

    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await ref.set(patch, { merge: true });
    return json(200, {
      ok: true,
      updated: true,
      firestore: true,
      auth: authUpdated,
      fields: Object.keys(patch).filter(function (k) {
        return k !== "updatedAt";
      }),
    });
  } catch (e) {
    return json(500, { error: "sync_failed", detail: String((e && e.message) || e) });
  }
};
