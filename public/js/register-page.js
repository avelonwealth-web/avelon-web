(function () {
  function dashHomeHref() {
    var base = window.avPath ? window.avPath("dashboard.html") : "dashboard.html";
    return base + "#home";
  }

  function forceHomeTabPreference() {
    try {
      localStorage.setItem("avelon_active_tab", "home");
    } catch (e) {}
  }

  function qs(name) {
    var p = new URLSearchParams(window.location.search);
    return p.get(name);
  }

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

  function makeUniqueReferralCode(db, uid, attempt) {
    attempt = attempt || 0;
    var candidate = genReferralCode(uid, attempt);
    return db
      .collection("referralLookup")
      .doc(candidate)
      .get()
      .then(function (snap) {
        if (!snap.exists) return candidate;
        return makeUniqueReferralCode(db, uid, attempt + 1);
      });
  }

  function waitMs(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function callCompleteRegistration(payload, triesLeft) {
    var remaining = Number(triesLeft || 0);
    return window.AvelonApi.call("completeRegistration", payload).catch(function (err) {
      var code = String((err && err.message) || "");
      if (remaining <= 1) throw err;
      if (code === "invalid_referral_code" || code === "missing_referral_code" || code === "invalid_username") throw err;
      return waitMs(450).then(function () {
        return callCompleteRegistration(payload, remaining - 1);
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    window.AvelonAuth.init();
    var registerInFlight = false;

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
      if (registerInFlight) return;
      if (user) {
        forceHomeTabPreference();
        window.location.href = dashHomeHref();
      }
    });

    document.getElementById("reg-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var referralCode = document.getElementById("ref").value.trim().toUpperCase();
      var userName = document.getElementById("name").value.trim();
      var mobileRaw = document.getElementById("mobile").value.trim();
      var password = document.getElementById("password").value;
      var confirmPassword = document.getElementById("confirm-password").value;
      var authEmail = window.AvelonPhoneAuth.authEmailFromInput(mobileRaw);
      var displayMobile = window.AvelonPhoneAuth.displayFromInput(mobileRaw);

      if (!userName || userName.length < 2) {
        window.AvelonUI.toast("Username is required (at least 2 characters)");
        return;
      }
      if (!mobileRaw) {
        window.AvelonUI.toast("Mobile number is required");
        return;
      }
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
          var completePayload = {
            referralCode: referralCode,
            userName: userName,
            mobileNumber: displayMobile,
            uplineId: uplineId,
          };
          registerInFlight = true;
          return window.AvelonAuth.auth().createUserWithEmailAndPassword(authEmail, password).then(function () {
            return callCompleteRegistration(completePayload, 4);
          });
        })
        .then(function () {
          window.AvelonUI.toast("Account created — redirecting");
          setTimeout(function () {
            forceHomeTabPreference();
            window.location.href = dashHomeHref();
          }, 600);
        })
        .catch(function (err) {
          registerInFlight = false;
          if (err && err.code === "auth/email-already-in-use") {
            // Recovery path: account may exist in Auth but profile finalization may have failed previously.
            window.AvelonAuth
              .signInEmail(authEmail, password)
              .then(function () {
                var recoverPayload = {
                  referralCode: referralCode,
                  userName: userName,
                  mobileNumber: displayMobile,
                };
                return callCompleteRegistration(recoverPayload, 4);
              })
              .then(function () {
                window.AvelonUI.toast("Account recovered — redirecting");
                forceHomeTabPreference();
                window.location.href = dashHomeHref();
              })
              .catch(function () {
                window.AvelonUI.toast("Mobile number already registered");
              });
          } else if (err && err.message !== "invalid_ref") {
            if (String((err && err.message) || "") === "invalid_referral_code") {
              window.AvelonUI.toast("Invalid referral code");
            } else {
              window.AvelonUI.toast("Registration failed");
            }
          }
        });
    });
  });
})();
