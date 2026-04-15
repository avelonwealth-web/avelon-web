const { admin, json, requireAdmin, preflight, initAdmin } = require("./_lib");

function formatPh09FromE164(e164) {
  if (!e164 || !/^639\d{9}$/.test(String(e164))) return "";
  return "0" + String(e164).slice(2);
}

function mobileFromSyntheticEmail(email) {
  var m = /^(\d{12})@phone\.avelon-wealth\.local$/i.exec(String(email || ""));
  if (!m) return "";
  return formatPh09FromE164(m[1]);
}

function computeDisplay(docId, d, authRec) {
  var data = d || {};
  var auth = authRec || {};

  var name = String(data.userName || data.displayName || data.name || data.username || data.fullName || "").trim();
  if (!name) name = String(auth.displayName || "").trim();
  if (!name && auth.email) {
    var local = auth.email.split("@")[0];
    if (/^639\d{9}$/.test(local)) {
      var tail = String(docId || "").replace(/[^A-Za-z0-9]/g, "").slice(-6);
      name = tail ? "Member · " + tail : "Member";
    } else if (local) name = local;
  }
  if (!name) name = "User";

  var mobile = String(
    data.mobileNumber || data.mobile || data.phoneNumber || data.telephone || data.cellphone || data.phone || ""
  ).trim();
  if (!mobile) mobile = String(auth.phoneNumber || "").trim();
  if (!mobile && auth.email) mobile = mobileFromSyntheticEmail(auth.email) || "";
  if (!mobile && data.email) mobile = mobileFromSyntheticEmail(data.email) || "";

  return { adminDisplayName: name, adminDisplayMobile: mobile };
}

function looksLikeValidUid(uid) {
  var v = String(uid || "").trim();
  if (!v) return false;
  if (v.length > 128) return false;
  if (v.indexOf("/") >= 0) return false;
  return true;
}

/**
 * Admin-only: all Firestore users merged with Firebase Auth (name + mobile for console).
 * POST {} — no body.
 */
exports.handler = async function (event) {
  var opt = preflight(event);
  if (opt) return opt;
  if (event.httpMethod !== "POST") {
    return json(405, { error: "method" });
  }

  var gate = await requireAdmin(event);
  if (!gate.ok) return json(gate.statusCode, { error: gate.error });

  initAdmin();
  var db = admin.firestore();

  try {
    var snap = await db.collection("users").get();
    var docs = [];
    snap.forEach(function (d) {
      docs.push({ id: d.id, data: d.data() || {} });
    });

    var authByUid = {};
    for (var off = 0; off < docs.length; off += 100) {
      var slice = docs.slice(off, off + 100);
      var identifiers = slice
        .map(function (x) {
          return String(x.id || "").trim();
        })
        .filter(looksLikeValidUid)
        .map(function (uid) {
          return { uid: uid };
        });
      if (!identifiers.length) continue;
      try {
        var res = await admin.auth().getUsers(identifiers);
        res.users.forEach(function (rec) {
          authByUid[rec.uid] = {
            email: rec.email || "",
            displayName: rec.displayName || "",
            phoneNumber: rec.phoneNumber || "",
          };
        });
      } catch (batchErr) {
        // Fallback path: isolate bad/legacy auth records without breaking entire admin page.
        for (var i = 0; i < identifiers.length; i++) {
          var uid = identifiers[i].uid;
          try {
            var rec = await admin.auth().getUser(uid);
            authByUid[uid] = {
              email: rec.email || "",
              displayName: rec.displayName || "",
              phoneNumber: rec.phoneNumber || "",
            };
          } catch (singleErr) {}
        }
      }
    }

    var users = docs.map(function (row) {
      var auth = authByUid[row.id] || {};
      var disp = computeDisplay(row.id, row.data, auth);
      return Object.assign({ id: row.id }, row.data, {
        adminDisplayName: disp.adminDisplayName,
        adminDisplayMobile: disp.adminDisplayMobile,
      });
    });

    return json(200, { users: users });
  } catch (e) {
    return json(500, { error: "list_failed", detail: String((e && e.message) || e) });
  }
};
