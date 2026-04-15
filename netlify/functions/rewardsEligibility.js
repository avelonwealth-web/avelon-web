const { admin, json, requireUser, preflight, corsHeaders } = require("./_lib");

function uniqueIds(arr) {
  var seen = {};
  var out = [];
  (arr || []).forEach(function (x) {
    var v = String(x || "").trim();
    if (!v || seen[v]) return;
    seen[v] = 1;
    out.push(v);
  });
  return out;
}

function amountForTarget(cfg, target) {
  if (!cfg || typeof cfg !== "object") return null;
  var key = String(target);
  if (cfg.amounts && cfg.amounts[key] != null) return Number(cfg.amounts[key] || 0);
  var alt = cfg["m" + key];
  if (alt != null) return Number(alt || 0);
  return null;
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

  var gate = await requireUser(event);
  if (!gate.ok) return json(gate.statusCode, { error: gate.error });
  var uid = gate.uid;
  var db = admin.firestore();

  try {
    var directIds = [];
    var edgeSnap = await db.collection("users").doc(uid).collection("downlines").get();
    edgeSnap.forEach(function (d) {
      var row = d.data() || {};
      var childUid = String(row.childUid || d.id || "").trim();
      if (childUid) directIds.push(childUid);
    });

    if (!directIds.length) {
      var q = await db.collection("users").where("uplineId", "==", uid).limit(1000).get();
      q.forEach(function (d) {
        directIds.push(String(d.id || "").trim());
      });
    }

    directIds = uniqueIds(directIds);

    var directDepositedCount = 0;
    for (var i = 0; i < directIds.length; i += 10) {
      var chunk = directIds.slice(i, i + 10);
      if (!chunk.length) continue;
      var snap = await db
        .collection("users")
        .where(admin.firestore.FieldPath.documentId(), "in", chunk)
        .get();
      snap.forEach(function (d) {
        var u = d.data() || {};
        if (Number(u.depositCount || 0) > 0 || Number(u.totalDeposits || 0) > 0) {
          directDepositedCount += 1;
        }
      });
    }

    var cfgSnap = await db.collection("systemConfig").doc("rewardMilestones").get();
    var cfg = cfgSnap.exists ? cfgSnap.data() || {} : {};
    var targets = [5, 10, 15, 20, 30, 40, 50];
    var milestones = targets.map(function (t) {
      var amount = amountForTarget(cfg, t);
      return {
        target: t,
        reached: directDepositedCount >= t,
        amount: amount != null && isFinite(amount) && amount > 0 ? amount : null,
      };
    });

    return json(200, {
      ok: true,
      directReferralCount: directIds.length,
      directDepositedCount: directDepositedCount,
      milestones: milestones,
      adminControlled: true,
    });
  } catch (e) {
    return json(500, { error: "rewards_eligibility_failed", detail: String((e && e.message) || e) });
  }
};
