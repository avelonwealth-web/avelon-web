const { admin, json, requireUser, preflight, corsHeaders } = require("./_lib");

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

function toMillis(ts) {
  try {
    if (ts && typeof ts.toMillis === "function") return ts.toMillis();
  } catch (e) {}
  return 0;
}

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

async function edgeChildren(db, parentIds) {
  var parents = uniqueIds(parentIds);
  if (!parents.length) return [];
  var out = [];
  for (var i = 0; i < parents.length; i++) {
    var q = await db.collection("users").doc(parents[i]).collection("downlines").limit(500).get();
    q.forEach(function (d) {
      var row = d.data() || {};
      var child = String(row.childUid || d.id || "").trim();
      if (child) out.push(child);
    });
  }
  return uniqueIds(out);
}

async function fallbackL1ByField(db, uid) {
  var q = await db.collection("users").where("uplineId", "==", uid).limit(500).get();
  var ids = [];
  q.forEach(function (d) {
    ids.push(d.id);
  });
  return uniqueIds(ids);
}

async function fetchUsersByIds(db, ids) {
  var out = {};
  var list = uniqueIds(ids);
  for (var i = 0; i < list.length; i += 10) {
    var chunk = list.slice(i, i + 10);
    if (!chunk.length) continue;
    var q = await db
      .collection("users")
      .where(admin.firestore.FieldPath.documentId(), "in", chunk)
      .get();
    q.forEach(function (d) {
      out[d.id] = d.data() || {};
    });
  }
  return out;
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
    var l1Ids = await edgeChildren(db, [uid]);
    if (!l1Ids.length) l1Ids = await fallbackL1ByField(db, uid);
    var l2Ids = await edgeChildren(db, l1Ids);
    var l3Ids = await edgeChildren(db, l2Ids);
    l1Ids = uniqueIds(l1Ids.filter(function (x) { return x !== uid; }));
    l2Ids = uniqueIds(l2Ids.filter(function (x) { return x !== uid && l1Ids.indexOf(x) === -1; }));
    l3Ids = uniqueIds(
      l3Ids.filter(function (x) {
        return x !== uid && l1Ids.indexOf(x) === -1 && l2Ids.indexOf(x) === -1;
      })
    );

    var userMap = await fetchUsersByIds(db, l1Ids.concat(l2Ids).concat(l3Ids));

    var depSnap = await db
      .collection("users")
      .doc(uid)
      .collection("downlineDeposits")
      .orderBy("timestamp", "desc")
      .limit(400)
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

    function mapLevel(ids, level) {
      var mapped = (ids || []).map(function (id) {
        var key = String(level) + ":" + id;
        var dep = latestByLevelUid[key] || null;
        var data = userMap[id] || {};
        return {
          uid: id,
          masked: maskFromUserDoc(data, id),
          createdAt: data && data.createdAt ? data.createdAt : null,
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
      l1: mapLevel(l1Ids, 1),
      l2: mapLevel(l2Ids, 2),
      l3: mapLevel(l3Ids, 3),
    };
    return json(200, {
      ok: true,
      levels: levels,
      counts: { l1: levels.l1.length, l2: levels.l2.length, l3: levels.l3.length },
      diagnostics: {
        usersTotal: Object.keys(userMap).length,
        edgeL1: l1Ids.length,
        edgeL2: l2Ids.length,
        edgeL3: l3Ids.length,
      },
    });
  } catch (e) {
    return json(500, { error: "downline_summary_failed", detail: String((e && e.message) || e) });
  }
};

