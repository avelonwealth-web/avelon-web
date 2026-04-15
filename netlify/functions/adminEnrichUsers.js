const { admin, json, requireAdmin, preflight } = require("./_lib");

/**
 * Admin-only: return Auth record fields for many UIDs (for admin console display).
 * POST JSON: { uids: string[] } — max 300 per request (batched internally).
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

  var raw = Array.isArray(body.uids) ? body.uids : [];
  var uids = [];
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    var id = String(raw[i] || "").trim();
    if (!id || seen[id]) continue;
    seen[id] = 1;
    uids.push(id);
    if (uids.length >= 300) break;
  }

  if (!uids.length) {
    return json(200, { profiles: {} });
  }

  var profiles = {};
  for (var off = 0; off < uids.length; off += 100) {
    var chunk = uids.slice(off, off + 100);
    var identifiers = chunk.map(function (uid) {
      return { uid: uid };
    });
    try {
      var res = await admin.auth().getUsers(identifiers);
      res.users.forEach(function (rec) {
        profiles[rec.uid] = {
          email: rec.email || "",
          displayName: rec.displayName || "",
          phoneNumber: rec.phoneNumber || "",
        };
      });
    } catch (e) {
      return json(500, { error: "auth_lookup_failed", detail: String((e && e.message) || e) });
    }
  }

  return json(200, { profiles: profiles });
};
