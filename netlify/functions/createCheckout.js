/**
 * Creates a PayMongo Checkout Session / Link (server-side).
 *
 * Required Netlify environment variables:
 * - PAYMONGO_SECRET_KEY (sk_live_... or sk_test_...)
 *
 * Optional:
 * - PUBLIC_SITE_URL (defaults to https://avelon.site)
 */
const https = require("https");
const crypto = require("crypto");
const { admin, json, requireUser, preflight, corsHeaders } = require("./_lib");

function paymongoPost(path, secretKey, payload) {
  const body = JSON.stringify(payload);
  const token = Buffer.from(secretKey + ":", "utf8").toString("base64");
  return new Promise(function (resolve, reject) {
    const req = https.request(
      {
        hostname: "api.paymongo.com",
        path: path,
        method: "POST",
        headers: {
          Authorization: "Basic " + token,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      function (res) {
        var data = "";
        res.on("data", function (c) {
          data += c;
        });
        res.on("end", function () {
          resolve({ status: res.statusCode, body: data });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async function (event) {
  var opt = preflight(event);
  if (opt) return opt;
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, corsHeaders()), body: "Method Not Allowed" };
  }

  var u = await requireUser(event);
  if (!u.ok) return json(u.statusCode, { error: u.error });

  var secret = process.env.PAYMONGO_SECRET_KEY || "";
  if (!secret) {
    return json(503, { error: "Missing PAYMONGO_SECRET_KEY in Netlify environment variables." });
  }

  var parsed;
  try {
    parsed = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  var amount = Number(parsed.amount || 0);
  if (!(amount > 0)) {
    return json(400, { error: "amount is required" });
  }
  var uid = u.uid;

  // PayMongo amounts are in centavos for PHP
  var centavos = Math.round(amount * 100);

  var hdr = event.headers || {};
  var reqHost = String(hdr["x-forwarded-host"] || hdr["X-Forwarded-Host"] || hdr.host || hdr.Host || "").trim();
  var reqProto = String(hdr["x-forwarded-proto"] || hdr["X-Forwarded-Proto"] || "https").trim() || "https";
  var inferredSite = reqHost ? reqProto + "://" + reqHost : "";
  var site = process.env.PUBLIC_SITE_URL || inferredSite || "https://avelon.site";
  var db = admin.firestore();
  var depositId = "dep_" + crypto.randomBytes(10).toString("hex");
  await db.collection("deposits").doc(depositId).set({
    userId: uid,
    amountPhp: amount,
    status: "created",
    provider: "paymongo",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Checkout Sessions API (preferred). If your PayMongo account uses Links API only, adapt here.
  var payload = {
    data: {
      attributes: {
        line_items: [
          {
            currency: "PHP",
            amount: centavos,
            name: "AVELON Wallet Top-up",
            quantity: 1,
          },
        ],
        payment_method_types: ["qrph", "gcash", "paymaya", "card"],
        success_url: site + "/dashboard.html?paid=1&depositId=" + encodeURIComponent(depositId),
        cancel_url: site + "/dashboard.html?paid=0",
        description: "AVELON deposit " + depositId,
        metadata: {
          userId: uid,
          depositId: depositId,
          email: String(parsed.email || ""),
          mobile: String(parsed.mobile || ""),
          amountPhp: String(amount),
        },
      },
    },
  };

  var resp = await paymongoPost("/v1/checkout_sessions", secret, payload);
  var pmJson;
  try {
    pmJson = JSON.parse(resp.body);
  } catch (e) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "PayMongo non-JSON response", raw: String(resp.body).slice(0, 500) }),
    };
  }

  if (resp.status < 200 || resp.status >= 300) {
    await db.collection("deposits").doc(depositId).set(
      {
        status: "provider_error",
        providerResponse: pmJson,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return json(502, { error: "PayMongo error", details: pmJson });
  }

  var checkoutUrl =
    pmJson &&
    pmJson.data &&
    pmJson.data.attributes &&
    (pmJson.data.attributes.checkout_url || pmJson.data.attributes.redirect?.checkout_url);

  await db.collection("deposits").doc(depositId).set(
    {
      status: "checkout_created",
      checkoutSessionId: pmJson && pmJson.data && pmJson.data.id ? String(pmJson.data.id) : null,
      checkoutUrl: checkoutUrl || null,
      providerCheckout: pmJson,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return json(200, { checkoutUrl: checkoutUrl || null, depositId: depositId });
};
