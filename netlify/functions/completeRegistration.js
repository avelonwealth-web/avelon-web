const { admin, json, requireUser, preflight } = require("./_lib");

function genReferralCode(uid, salt) {
  var letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  var digits = "23456789";
  var all = letters + digits;
  var out = "";
  var seed = String(uid || "") + "\0" + String(salt != null ? salt : 0);
  var h = 0;
  for (var j = 0; j < seed.length; j++) h = (h * 33 + seed.charCodeAt(j)) | 0;
  for (var i = 0; i < 8; i++) {
    h = (h * 1103515245 + 12345) | 0;
    var idx = Math.abs(h) % all.length;
    out += all.charAt(idx);
  }
  out = letters.charAt(Math.abs(h) % letters.length) + letters.charAt(Math.abs(h >> 3) % letters.length) + out.slice(2);
  out = out.slice(0, 6);
  if (!/[A-Z]/.test(out)) out = "A" + out.slice(1);
  if (!/[0-9]/.test(out)) out = out.slice(0, 5) + digits.charAt(Math.abs(h >> 5) % digits.length);
  return out;
}

async function makeUniqueReferralCode(db, uid) {
  for (var attempt = 0; attempt < 128; attempt++) {
    var c = genReferralCode(uid, attempt);
    var snap = await db.collection("referralLookup").doc(c).get();
    if (!snap.exists) return c;
  }
  throw new Error("ref_code_exhausted");
}

exports.handler = async function (event) {
  var opt = preflight(event);
  if (opt) return opt;
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  var gate = await requireUser(event);
  if (!gate.ok) return json(gate.statusCode, { error: gate.error });

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    body = {};
  }
  var uid = gate.uid;
  var referralCode = String((body && body.referralCode) || "")
    .trim()
    .toUpperCase();
  var userName = String((body && body.userName) || "").trim();
  var mobileNumber = String((body && body.mobileNumber) || "").trim();

  if (!referralCode) return json(400, { error: "missing_referral_code" });
  if (userName.length < 2) return json(400, { error: "invalid_username" });

  var db = admin.firestore();
  var userRef = db.collection("users").doc(uid);

  try {
    var userSnap = await userRef.get();
    if (userSnap.exists && String((userSnap.data() || {}).role || "").toLowerCase() === "admin") {
      return json(403, { error: "admin_cannot_use_member_registration" });
    }

    var lookupSnap = await db.collection("referralLookup").doc(referralCode).get();
    if (!lookupSnap.exists) return json(400, { error: "invalid_referral_code" });
    var uplineId = String(((lookupSnap.data() || {}).uid) || "").trim();
    if (!uplineId) return json(400, { error: "invalid_referral_code" });

    var authUser = await admin.auth().getUser(uid);
    var authEmail = String(authUser.email || "").trim();
    var myCode = userSnap.exists ? String((userSnap.data() || {}).referralCode || "").trim().toUpperCase() : "";
    if (!myCode) myCode = await makeUniqueReferralCode(db, uid);

    await db.runTransaction(async function (tx) {
      var us = await tx.get(userRef);
      var uData = us.exists ? us.data() || {} : {};
      var existingRole = String(uData.role || "").toLowerCase();
      if (existingRole && existingRole !== "user" && existingRole !== "member") throw new Error("invalid_role");

      var base = {
        uid: uid,
        userName: String(uData.userName || userName),
        displayName: String(uData.displayName || userName),
        email: String(uData.email || authEmail || ""),
        mobileNumber: String(uData.mobileNumber || uData.mobile || mobileNumber || ""),
        mobile: String(uData.mobile || uData.mobileNumber || mobileNumber || ""),
        role: "user",
        heldBalance: Number(uData.heldBalance || 0),
        depositPrincipal: Number(uData.depositPrincipal || 0),
        totalDeposits: Number(uData.totalDeposits || 0),
        depositCount: Number(uData.depositCount || 0),
        vipLevel: Number(uData.vipLevel || 0),
        vipPurchased: !!uData.vipPurchased,
        signupBonusTotal: Number(uData.signupBonusTotal || 300),
        signupBonusLocked: Number(uData.signupBonusLocked || 300),
        uplineId: String(uData.uplineId || uplineId),
        usedReferralCode: String(uData.usedReferralCode || referralCode),
        referralCode: String(uData.referralCode || myCode),
        downlineCount: Number(uData.downlineCount || 0),
        totalEarnings: Number(uData.totalEarnings || 0),
        prefs: uData.prefs || { activeTab: "home" },
      };

      var hadBonus = Number(uData.signupBonusTotal || 0) >= 300 || Number(uData.balance || 0) >= 300;
      var nextBalance = Number(uData.balance || 0);
      if (!hadBonus) nextBalance += 300;
      base.balance = nextBalance;

      if (!us.exists) base.createdAt = admin.firestore.FieldValue.serverTimestamp();
      base.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      tx.set(userRef, base, { merge: true });

      tx.set(
        db.collection("referralLookup").doc(base.referralCode),
        {
          uid: uid,
          seed: "user-registration",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      tx.set(
        db.collection("users").doc(base.uplineId).collection("downlines").doc(uid),
        {
          childUid: uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      if (!hadBonus) {
        tx.set(userRef.collection("transactions").doc(), {
          type: "signup_bonus",
          amount: 300,
          status: "posted",
          referenceId: "SIGNUP-" + uid.slice(0, 8).toUpperCase(),
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          userId: uid,
          note: "Welcome credit — locked until first VIP purchase",
        });
      }
    });

    try {
      await admin.auth().updateUser(uid, { displayName: userName });
    } catch (e) {}

    return json(200, { ok: true });
  } catch (e) {
    var msg = String((e && e.message) || e);
    if (msg === "invalid_role") return json(400, { error: "invalid_profile_role" });
    if (msg === "invalid_referral_code") return json(400, { error: "invalid_referral_code" });
    return json(500, { error: "complete_registration_failed", detail: msg });
  }
};
