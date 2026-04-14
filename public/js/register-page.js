(function () {
  function qs(name) {
    var p = new URLSearchParams(window.location.search);
    return p.get(name);
  }

  function genReferralCode(uid) {
    var letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    var digits = "23456789";
    var all = letters + digits;
    var out = "";
    var seed = (uid || "") + "_" + Date.now() + "_" + Math.random();
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

  function makeUniqueReferralCode(db, uid, attempt) {
    attempt = attempt || 0;
    var candidate = genReferralCode(uid + "_" + attempt + "_" + Date.now());
    return db
      .collection("referralLookup")
      .doc(candidate)
      .get()
      .then(function (snap) {
        if (!snap.exists) return candidate;
        return makeUniqueReferralCode(db, uid, attempt + 1);
      });
  }

  document.addEventListener("DOMContentLoaded", function () {
    window.AvelonAuth.init();

    var refInput = document.getElementById("ref");
    var fromUrl = qs("ref") || qs("referralCode") || "";
    if (fromUrl) {
      refInput.value = fromUrl;
      refInput.setAttribute("readonly", "readonly");
      refInput.addEventListener("dblclick", function () {
        refInput.removeAttribute("readonly");
        window.AvelonUI.toast("Referral field unlocked");
      });
    }

    window.AvelonAuth.onAuth(function (user) {
      if (user) window.location.href = window.avPath ? window.avPath("dashboard.html") : "dashboard.html";
    });

    document.getElementById("reg-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var referralCode = document.getElementById("ref").value.trim();
      var fullName = document.getElementById("name").value.trim();
      var mobileRaw = document.getElementById("mobile").value.trim();
      var password = document.getElementById("password").value;
      var confirmPassword = document.getElementById("confirm-password").value;
      var authEmail = window.AvelonPhoneAuth.authEmailFromInput(mobileRaw);
      var displayMobile = window.AvelonPhoneAuth.displayFromInput(mobileRaw);

      if (!authEmail) {
        window.AvelonUI.toast("Enter a valid PH mobile (09…, +63…, or 9…)");
        return;
      }

      if (!referralCode) {
        window.AvelonUI.toast("Referral code is required");
        return;
      }
      if (password !== confirmPassword) {
        window.AvelonUI.toast("Passwords do not match");
        return;
      }

      window.AvelonDb
        .referralLookup(referralCode)
        .get()
        .then(function (snap) {
          if (!snap.exists) {
            window.AvelonUI.toast("Invalid referral code");
            throw new Error("invalid_ref");
          }
          var uplineId = snap.data().uid;
          if (!uplineId) {
            window.AvelonUI.toast("Invalid referral code");
            throw new Error("invalid_ref");
          }
          return window.AvelonAuth.auth().createUserWithEmailAndPassword(authEmail, password).then(function (cred) {
            var uid = cred.user.uid;
            var db = firebase.firestore();
            return makeUniqueReferralCode(db, uid).then(function (myCode) {
            var batch = db.batch();
            var userRef = db.collection("users").doc(uid);
            var uplineRef = db.collection("users").doc(uplineId);
            var myLookup = db.collection("referralLookup").doc(myCode);

            batch.set(
              userRef,
              {
                displayName: fullName,
                email: authEmail,
                mobileNumber: displayMobile,
                role: "user",
                balance: 300,
                heldBalance: 0,
                depositPrincipal: 0,
                totalDeposits: 0,
                depositCount: 0,
                vipLevel: 1,
                uplineId: uplineId,
                referralCode: myCode,
                downlineCount: 0,
                totalEarnings: 0,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                prefs: { activeTab: "home" },
              },
              { merge: false }
            );

            batch.set(myLookup, { uid: uid, seed: "admin-root-linked", createdAt: firebase.firestore.FieldValue.serverTimestamp() });
            var txRef = userRef.collection("transactions").doc();
            batch.set(
              txRef,
              {
                type: "signup_bonus",
                amount: 300,
                status: "posted",
                referenceId: "SIGNUP-" + uid.slice(0, 8).toUpperCase(),
                timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                userId: uid,
                note: "Welcome credit — withdrawals require deposit history",
              },
              { merge: false }
            );
            var hxRef = userRef.collection("history").doc();
            batch.set(
              hxRef,
              {
                kind: "signup",
                message: "Account created under referral network",
                timestamp: firebase.firestore.FieldValue.serverTimestamp(),
              },
              { merge: false }
            );
            var lgRef = userRef.collection("logs").doc();
            batch.set(
              lgRef,
              {
                level: "info",
                message: "Registration completed",
                timestamp: firebase.firestore.FieldValue.serverTimestamp(),
              },
              { merge: false }
            );

            var edgeRef = uplineRef.collection("downlines").doc(uid);
            batch.set(
              edgeRef,
              {
                childUid: uid,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
              },
              { merge: false }
            );
            batch.update(uplineRef, {
              downlineCount: firebase.firestore.FieldValue.increment(1),
            });

            return batch.commit().catch(function (err) {
              console.error(err);
              window.AvelonUI.toast("Profile write failed — check Firestore rules");
            });
            });
          });
        })
        .then(function () {
          window.AvelonUI.toast("Account created — redirecting");
          setTimeout(function () {
            window.location.href = window.avPath ? window.avPath("dashboard.html") : "dashboard.html";
          }, 600);
        })
        .catch(function (err) {
          if (err && err.code === "auth/email-already-in-use") {
            window.AvelonUI.toast("Mobile number already registered");
          } else if (err && err.message !== "invalid_ref") {
            window.AvelonUI.toast("Registration failed");
          }
        });
    });
  });
})();
