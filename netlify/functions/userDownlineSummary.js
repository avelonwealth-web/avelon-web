const { admin, json, requireUser, preflight, corsHeaders } = require("./_lib");

function maskFromUserDoc(d, uid) {
  var mobile = String((d && (d.mobileNumber || d.mobile)) || "").replace(/\D/g, "");
  if (mobile) {
    if (mobile.length <= 4) return mobile.charAt(0) + "***";
    return mobile.slice(0, 4) + "*****" + mobile.slice(-2);
  }
  var email = String((d && d.email) || "").trim();
  if (email) {
    var local = email.split("@")[0] || "";
    if (local.length <= 4) return local.charAt(0) + "***";
    return local.slice(0, 2) + "***" + local.slice(-1);
  }
  var tail = String(uid || "").replace(/[^A-Za-z0-9]/g, "").slice(-6);
  return tail ? "Member · " + tail : "***";
}

function toMillis(ts) {
  try {
    if (ts && typeof ts.toMillis === "function") return ts.toMillis();
  } catch (e) {}
  return 0;
}

function uniqueIds(ids) {
  var seen = {};
  var out = [];
  (ids || []).forEach(function (id) {
    var v = String(id || "").trim();
    if (!v || seen[v]) return;
    seen[v] = 1;
    out.push(v);
  });
  return out;
}

async function edgeChildren(db, parentIds) {
  var parents = uniqueIds(parentIds);
  if (!parents.length) return [];
  var out = [];
  for (var i = 0; i < parents.length; i++) {
    var q = await db.collection("users").doc(parents[i]).collection("downlines").get();
    q.forEach(function (d) {
      var row = d.data() || {};
      var child = String(row.childUid || d.id || "").trim();
      if (child) out.push(child);
    });
  }
  return uniqueIds(out);
}

function parentUid(d) {
  return String((d && (d.uplineId || d.upline || d.sponsorUid)) || "").trim();
}

function usedRefCode(d) {
  var c = String(
    (d && (d.usedReferralCode || d.referralCodeUsed || d.refCodeUsed || d.sponsorCode || d.uplineCode)) || ""
  )
    .trim()
    .toUpperCase();
  return c;
}

async function healEdgesAndCount(db, parentUid, childIds) {
  var parent = String(parentUid || "").trim();
  var kids = uniqueIds(childIds);
  if (!parent || !kids.length) return;
  var batch = db.batch();
  var parentRef = db.collection("users").doc(parent);
  kids.forEach(function (childUid) {
    batch.set(
      parentRef.collection("downlines").doc(childUid),
      { childUid: childUid, repairedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  });
  batch.set(parentRef, { downlineCount: kids.length, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await batch.commit();
}

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

  var u = await requireUser(event);
  if (!u.ok) return json(u.statusCode, { error: u.error });

  var db = admin.firestore();
  var uid = u.uid;

  try {
    var usersSnap = await db.collection("users").get();
    var usersById = {};
    usersSnap.forEach(function (d) {
      usersById[d.id] = { id: d.id, data: d.data() || {} };
    });
    var me = usersById[uid] ? usersById[uid].data : {};

    var myCodes = {};
    var meCode = String((me && me.referralCode) || "").trim().toUpperCase();
    if (meCode) myCodes[meCode] = 1;
    var rlSnap = await db.collection("referralLookup").where("uid", "==", uid).limit(50).get();
    rlSnap.forEach(function (d) {
      myCodes[String(d.id || "").trim().toUpperCase()] = 1;
    });

    var childByParent = {};
    Object.keys(usersById).forEach(function (id) {
      var d = usersById[id].data;
      var p = parentUid(d);
      if (!p) return;
      if (!childByParent[p]) childByParent[p] = [];
      childByParent[p].push(id);
    });

    function setFromArray(arr) {
      var out = {};
      (arr || []).forEach(function (x) {
        var v = String(x || "").trim();
        if (v) out[v] = 1;
      });
      return out;
    }
    function keys(setObj) {
      return Object.keys(setObj || {});
    }
    function mergeInto(target, arr) {
      (arr || []).forEach(function (x) {
        var v = String(x || "").trim();
        if (v) target[v] = 1;
      });
    }

    var l1 = {};
    mergeInto(l1, childByParent[uid] || []);
    var edgeL1 = await edgeChildren(db, [uid]);
    mergeInto(l1, edgeL1);

    var codeVals = Object.keys(myCodes);
    if (codeVals.length) {
      Object.keys(usersById).forEach(function (id) {
        if (id === uid) return;
        var c = usedRefCode(usersById[id].data);
        if (c && myCodes[c]) l1[id] = 1;
      });
    }

    var l2 = {};
    keys(l1).forEach(function (p) {
      mergeInto(l2, childByParent[p] || []);
    });
    var edgeL2 = await edgeChildren(db, keys(l1));
    mergeInto(l2, edgeL2);

    var l3 = {};
    keys(l2).forEach(function (p) {
      mergeInto(l3, childByParent[p] || []);
    });
    var edgeL3 = await edgeChildren(db, keys(l2));
    mergeInto(l3, edgeL3);

    // Enforce level uniqueness and remove self.
    delete l1[uid];
    delete l2[uid];
    delete l3[uid];
    keys(l1).forEach(function (id) {
      if (l2[id]) delete l2[id];
      if (l3[id]) delete l3[id];
    });
    keys(l2).forEach(function (id) {
      if (l3[id]) delete l3[id];
    });

    var l1Ids = keys(l1);
    var l2Ids = keys(l2);
    var l3Ids = keys(l3);

    var l1Rows = l1Ids.map(function (id) {
      return usersById[id] || { id: id, data: {} };
    });
    var l2Rows = l2Ids.map(function (id) {
      return usersById[id] || { id: id, data: {} };
    });
    var l3Rows = l3Ids.map(function (id) {
      return usersById[id] || { id: id, data: {} };
    });

    if (l1Ids.length) {
      try {
        await healEdgesAndCount(db, uid, l1Ids);
      } catch (e) {}
    }

    var depSnap = await db
      .collection("users")
      .doc(uid)
      .collection("downlineDeposits")
      .orderBy("timestamp", "desc")
      .limit(1200)
      .get();
    var latestByLevelUid = {};
    depSnap.forEach(function (d) {
      var row = d.data() || {};
      var lvl = Number(row.level || 0);
      var fromUid = String(row.fromUid || "").trim();
      if (!(lvl >= 1 && lvl <= 3) || !fromUid) return;
      var key = String(lvl) + ":" + fromUid;
      if (!latestByLevelUid[key]) latestByLevelUid[key] = row;
    });

    function mapLevel(rows, level) {
      var mapped = rows.map(function (r) {
        var key = String(level) + ":" + r.id;
        var dep = latestByLevelUid[key] || null;
        return {
          uid: r.id,
          masked: maskFromUserDoc(r.data, r.id),
          createdAt: r.data && r.data.createdAt ? r.data.createdAt : null,
          hasDeposit: !!dep,
          depositAmount: dep ? Number(dep.depositAmount || 0) : 0,
          depositAt: dep && dep.timestamp ? dep.timestamp : null,
        };
      });
      mapped.sort(function (a, b) {
        var ta = toMillis(a.createdAt);
        var tb = toMillis(b.createdAt);
        return tb - ta;
      });
      return mapped;
    }

    var levels = {
      l1: mapLevel(l1Rows, 1),
      l2: mapLevel(l2Rows, 2),
      l3: mapLevel(l3Rows, 3),
    };
    return json(200, {
      ok: true,
      levels: levels,
      counts: { l1: levels.l1.length, l2: levels.l2.length, l3: levels.l3.length },
    });
  } catch (e) {
    return json(500, { error: "downline_summary_failed", detail: String((e && e.message) || e) });
  }
};

