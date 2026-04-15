const { admin, json, requireAdmin, preflight, corsHeaders } = require("./_lib");

function toMillis(ts) {
  if (!ts) return 0;
  try {
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (ts.seconds) return Number(ts.seconds) * 1000;
    var n = Number(ts);
    if (isFinite(n) && n > 0) return n;
    var p = Date.parse(String(ts));
    return isFinite(p) && p > 0 ? p : 0;
  } catch (e) {
    return 0;
  }
}

function mapDoc(doc) {
  return Object.assign({ id: doc.id }, doc.data() || {});
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

  var gate = await requireAdmin(event);
  if (!gate.ok) return json(gate.statusCode, { error: gate.error });

  var body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {}
  var usersLimit = Math.max(50, Math.min(1200, Number((body && body.usersLimit) || 800)));
  var depositsLimit = Math.max(20, Math.min(500, Number((body && body.depositsLimit) || 250)));
  var withdrawalsLimit = Math.max(20, Math.min(500, Number((body && body.withdrawalsLimit) || 250)));

  var db = admin.firestore();
  try {
    var usersSnap = await db.collection("users").limit(usersLimit).get();
    var users = usersSnap.docs.map(mapDoc);
    users.sort(function (a, b) {
      return toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt);
    });

    var wdDocs = [];
    try {
      var wdSnap = await db.collection("withdrawals").orderBy("createdAt", "desc").limit(withdrawalsLimit).get();
      wdDocs = wdSnap.docs.slice();
    } catch (eWd) {
      var wdBasic = await db.collection("withdrawals").limit(Math.max(80, withdrawalsLimit)).get();
      wdDocs = wdBasic.docs.slice();
      wdDocs.sort(function (a, b) {
        return toMillis((b.data() || {}).createdAt) - toMillis((a.data() || {}).createdAt);
      });
      wdDocs = wdDocs.slice(0, withdrawalsLimit);
    }
    var withdrawals = wdDocs.map(mapDoc);

    var depDocs = [];
    try {
      var depSnap = await db.collection("deposits").orderBy("createdAt", "desc").limit(depositsLimit).get();
      depDocs = depSnap.docs.slice();
    } catch (eDep) {
      var depBasic = await db.collection("deposits").limit(Math.max(100, depositsLimit)).get();
      depDocs = depBasic.docs.slice();
      depDocs.sort(function (a, b) {
        return toMillis((b.data() || {}).createdAt) - toMillis((a.data() || {}).createdAt);
      });
      depDocs = depDocs.slice(0, depositsLimit);
    }
    var deposits = depDocs.map(mapDoc);

    return json(200, {
      ok: true,
      users: users,
      withdrawals: withdrawals,
      deposits: deposits,
      serverTime: Date.now(),
    });
  } catch (e) {
    return json(500, { error: "live_data_failed", detail: String((e && e.message) || e) });
  }
};

