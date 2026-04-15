(function () {
  function loginErrorMessage(err) {
    var c = err && err.code ? err.code : "";
    if (c === "auth/user-not-found" || c === "auth/invalid-email")
      return "No Firebase account for this mobile. Operators: add the admin user in Firebase Console (see README). Members: register with a referral first.";
    if (c === "auth/wrong-password" || c === "auth/invalid-credential" || c === "auth/missing-password") {
      try {
        var h = window.location.hostname || "";
        if (h === "127.0.0.1" || h === "localhost") {
          return "Wrong password, or Live Server is running — use npm start from the project folder (needs .secrets/serviceAccount.json).";
        }
      } catch (e) {}
      return "Wrong password — check mobile/password and try again.";
    }
    if (c === "auth/too-many-requests") return "Too many tries — wait a minute.";
    if (c === "auth/operation-not-allowed")
      return "Enable Email/Password in Firebase Authentication → Sign-in method.";
    if (c === "auth/unauthorized-domain")
      return "Add this site URL to Firebase → Auth → Settings → Authorized domains (e.g. 127.0.0.1).";
    if (c === "auth/configuration-not-found")
      return "Firebase Auth is not enabled for this project. Console → Build → Authentication → Get started, then enable Email/Password. In Google Cloud → APIs, ensure Identity Toolkit API is enabled.";
    if (c === "auth/invalid-login-credentials") return "Mobile or password not recognized.";
    if (c === "admin_token_failed")
      return "Admin login backend unavailable. Check Netlify function env and redeploy.";
    return c ? "Login failed (" + c + ")" : "Login failed — check mobile and password";
  }

  function dashHref() {
    var base = window.avPath ? window.avPath("dashboard.html") : "dashboard.html";
    return base + "#home";
  }

  function forceHomeTabPreference() {
    try {
      localStorage.setItem("avelon_active_tab", "home");
    } catch (e) {}
  }

  function operatorSignInNetlifyToken(mobile, password) {
    var url = window.location.origin + "/.netlify/functions/adminCustomToken";
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mobile: mobile, password: password }),
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = {};
        try {
          j = t ? JSON.parse(t) : {};
        } catch (e) {}
        if (!r.ok || !j.customToken) {
          var err = new Error((j && j.error) || "admin_token_failed");
          err.code = (j && j.error) || "admin_token_failed";
          throw err;
        }
        return window.AvelonAuth.signInWithCustomToken(j.customToken);
      });
    });
  }

  function operatorEmailFallbackSignIn(authEmail, password) {
    return window.AvelonAuth.signInEmail(authEmail, password);
  }

  function isCanonicalOperatorAuthEmail(authEmail) {
    return authEmail === window.AvelonPhoneAuth.syntheticEmailForCanonicalAdmin();
  }

  function finishLogin(user) {
    var adminSyntheticEmail = window.AvelonPhoneAuth.syntheticEmailForCanonicalAdmin();
    var looksAdminAuth =
      user.uid === "avelon_admin_operator" || window.AvelonPhoneAuth.isAdminAuthEmail(user.email || "");
    var adminEmailArg = user.email || adminSyntheticEmail;

    var afterSnap = function (snap) {
      if (window.AvelonAuth.profileAllowsAppAccess(snap)) return Promise.resolve(true);
      if (!snap.exists && looksAdminAuth) {
        return window.AvelonAuth.ensureAdminProfile(user.uid, adminEmailArg).then(function () {
          return window.AvelonDb.userDoc(user.uid).get();
        }).then(afterSnap);
      }
      return firebase.auth().signOut().then(function () {
        window.AvelonUI.toast(
          snap.exists
            ? "Members must register with a referral before signing in. Admins use the operator mobile only."
            : "Sign up first on the registration page — a valid referral code is required."
        );
        return false;
      });
    };

    var p = Promise.resolve();
    if (looksAdminAuth) {
      p = p.then(function () {
        return window.AvelonAuth.ensureAdminProfile(user.uid, adminEmailArg);
      });
    }
    return p
      .then(function () {
        return window.AvelonDb.userDoc(user.uid).get();
      })
      .then(afterSnap);
  }

  document.addEventListener("DOMContentLoaded", function () {
    window.AvelonAuth.init();

    window.AvelonAuth.onAuth(function (user) {
      if (!user) return;
      finishLogin(user).then(function (ok) {
        if (ok) {
          forceHomeTabPreference();
          window.location.href = dashHref();
        }
      });
    });

    var regLink = document.getElementById("register-link");
    if (regLink) {
      try {
        var sp = new URLSearchParams(window.location.search);
        var ref = sp.get("ref") || sp.get("referralCode");
        var base = window.avPath ? window.avPath("register.html") : "register.html";
        if (ref) {
          regLink.href = base + (base.indexOf("?") >= 0 ? "&" : "?") + "ref=" + encodeURIComponent(ref);
        } else {
          regLink.href = base;
        }
      } catch (e) {}
    }

    var form = document.getElementById("login-form");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var mobile = document.getElementById("mobile").value.trim();
      var password = document.getElementById("password").value;
      var authEmail = window.AvelonPhoneAuth.authEmailFromInput(mobile);
      if (!authEmail) {
        window.AvelonUI.toast("Enter a valid PH mobile (09…, +63…, or 9…)");
        return;
      }

      var promise;
      if (isCanonicalOperatorAuthEmail(authEmail)) {
        promise = operatorSignInNetlifyToken(mobile, password)
          .catch(function () {
            // Local fallback only (dev helper endpoint or direct email auth)
            var h = window.location.hostname || "";
            if (h === "127.0.0.1" || h === "localhost") {
              return operatorEmailFallbackSignIn(authEmail, password);
            }
            var e = new Error("admin_token_failed");
            e.code = "admin_token_failed";
            throw e;
          })
          .then(function (cred) {
            return finishLogin(cred.user);
          });
      } else {
        promise = window.AvelonAuth.signInEmail(authEmail, password).then(function (cred) {
          return finishLogin(cred.user);
        });
      }

      promise
        .then(function (ok) {
          if (ok) {
            forceHomeTabPreference();
            window.location.href = dashHref();
          }
        })
        .catch(function (err) {
          console.warn(err);
          window.AvelonUI.toast(loginErrorMessage(err));
        });
    });
  });
})();
