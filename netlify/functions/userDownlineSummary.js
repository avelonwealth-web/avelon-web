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

function chunk(arr, size) {
  var out = [];
  for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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

async function fetchDownlineIdsFromEdges(db, parentIds) {
  var roots = uniqueIds(parentIds);
  if (!roots.length) return [];
  var out = [];
  for (var i = 0; i < roots.length; i++) {
    var q = await db.collection("users").doc(roots[i]).collection("downlines").get();
    q.forEach(function (d) {
      var row = d.data() || {};
      var child = String(row.childUid || d.id || "").trim();
      if (child) out.push(child);
    });
  }
  return uniqueIds(out);
}

async function fetchUsersByIds(db, ids) {
  var uids = uniqueIds(ids);
  if (!uids.length) return [];
  var out = [];
  var batches = chunk(uids, 200);
  for (var i = 0; i < batches.length; i++) {
    var refs = batches[i].map(function (id) {
      return db.collection("users").doc(id);
    });
    var snaps = await db.getAll.apply(db, refs);
    snaps.forEach(function (snap) {
      if (!snap.exists) return;
      out.push({ id: snap.id, data: snap.data() || {} });
    });
  }
  return out;
}

async function fetchUsersByUplineFallback(db, uplineIds) {
  var ids = uniqueIds(uplineIds);
  if (!ids.length) return [];
  var chunks = chunk(ids, 10);
  var byId = {};
  var fields = ["uplineId", "upline", "sponsorUid"];
  for (var i = 0; i < chunks.length; i++) {
    var idChunk = chunks[i];
    for (var f = 0; f < fields.length; f++) {
      var q = await db.collection("users").where(fields[f], "in", idChunk).get();
      q.forEach(function (d) {
        byId[d.id] = { id: d.id, data: d.data() || {} };
      });
    }
  }
  return Object.keys(byId).map(function (id) {
    return byId[id];
  });
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
    var l1Ids = await fetchDownlineIdsFromEdges(db, [uid]);
    var l2Ids = await fetchDownlineIdsFromEdges(db, l1Ids);
    var l3Ids = await fetchDownlineIdsFromEdges(db, l2Ids);

    var l1 = await fetchUsersByIds(db, l1Ids);
    var l2 = await fetchUsersByIds(db, l2Ids);
    var l3 = await fetchUsersByIds(db, l3Ids);

    // Fallback for legacy data that may not have downlines edges.
    if (!l1.length) {
      l1 = await fetchUsersByUplineFallback(db, [uid]);
      l1Ids = l1.map(function (x) {
        return x.id;
      });
    }
    if (!l2.length && l1Ids.length) {
      l2 = await fetchUsersByUplineFallback(db, l1Ids);
      l2Ids = l2.map(function (x) {
        return x.id;
      });
    }
    if (!l3.length && l2Ids.length) {
      l3 = await fetchUsersByUplineFallback(db, l2Ids);
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
      l1: mapLevel(l1, 1),
      l2: mapLevel(l2, 2),
      l3: mapLevel(l3, 3),
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

