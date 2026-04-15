const { admin, json, requireUser, preflight, corsHeaders } = require("./_lib");

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

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    body = {};
  }
  var depositId = String((body && body.depositId) || "").trim();

  var db = admin.firestore();
  try {
    if (depositId) {
      var depSnap = await db.collection("deposits").doc(depositId).get();
      if (depSnap.exists) {
        var dep = depSnap.data() || {};
        if (String(dep.userId || "") !== u.uid) return json(403, { error: "forbidden" });
        return json(200, {
          ok: true,
          status: String(dep.status || ""),
          amountPhp: Number(dep.amountPhp || 0),
          updatedAt: dep.updatedAt || dep.createdAt || null,
          depositId: depositId,
        });
      }
    }
    var q = await db
      .collection("deposits")
      .where("userId", "==", u.uid)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    if (q.empty) return json(200, { ok: true, status: "none" });
    var d = q.docs[0].data() || {};
    return json(200, {
      ok: true,
      status: String(d.status || ""),
      amountPhp: Number(d.amountPhp || 0),
      updatedAt: d.updatedAt || d.createdAt || null,
      depositId: q.docs[0].id,
    });
  } catch (e) {
    return json(500, { error: "status_failed", detail: String((e && e.message) || e) });
  }
};

