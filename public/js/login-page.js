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
    return c ? "Login failed (" + c + ")" : "Login failed — check mobile and password";
  }

  function dashHref() {
    return window.avPath ? window.avPath("dashboard.html") : "dashboard.html";
  }

  /** Try override → local dev server → Netlify same origin → Cloud Functions (requires Blaze). */
  function adminCustomTokenUrlCandidates() {
    var fb = window.AVELON_FB || {};
    var list = [];
    if (fb.adminCustomTokenOverride) list.push(fb.adminCustomTokenOverride);
    try {
      // Always try same-origin Netlify function first (works on netlify.app and custom domains).
      list.push(window.location.origin + "/.netlify/functions/adminCustomToken");
    } catch (e) {}
    if (window.AVELON_PUBLIC_BASE) {
      try {
        list.push(String(window.AVELON_PUBLIC_BASE).replace(/\/+$/, "") + "/.netlify/functions/adminCustomToken");
      } catch (e) {}
    }
    var host = "";
    try {
      host = window.location.hostname || "";
    } catch (e) {}
    if (host === "127.0.0.1" || host === "localhost") {
      try {
        list.push(window.location.origin + "/adminCustomToken");
      } catch (e) {}
      list.push("http://127.0.0.1:8799/adminCustomToken");
    }
    // Do not call Google Cloud Functions directly from browser (CORS on preflight).
    // Netlify function is the only supported admin token endpoint for hosted web.
    var seen = {};
    return list.filter(function (u) {
      if (!u || seen[u]) return false;
      seen[u] = true;
      return true;
    });
  }

  function operatorEmailFallbackSignIn(authEmail, password) {
    return window.AvelonAuth.signInEmail(authEmail, password).catch(function (err) {
      var c = err && err.code ? err.code : "";
      var canBootstrap =
        password === "Matt@5494@" &&
        (c === "auth/user-not-found" || c === "auth/invalid-credential" || c === "auth/wrong-password");
      if (!canBootstrap) throw err;
      return window.AvelonAuth
        .auth()
        .createUserWithEmailAndPassword(authEmail, password)
        .catch(function (e2) {
          if (e2 && e2.code === "auth/email-already-in-use") {
            // Account exists but password differs; retry normal sign-in once.
            return window.AvelonAuth.signInEmail(authEmail, password);
          }
          throw e2;
        });
    });
  }

  function isCanonicalOperatorAuthEmail(authEmail) {
    return authEmail === window.AvelonPhoneAuth.syntheticEmailForCanonicalAdmin();
  }

  function finishLogin(user) {
    return window.AvelonDb.userDoc(user.uid).get().then(function (snap) {
      if (window.AvelonAuth.profileAllowsAppAccess(snap)) return true;
      if (!snap.exists && window.AvelonPhoneAuth.isAdminAuthEmail(user.email)) {
        return window.AvelonAuth.ensureAdminProfile(user.uid, user.email);
      }
      return firebase.auth().signOut().then(function () {
        window.AvelonUI.toast(
          snap.exists
            ? "Members must register with a referral before signing in. Admins use the operator mobile only."
            : "Sign up first on the registration page — a valid referral code is required."
        );
        return false;
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    window.AvelonAuth.init();

    window.AvelonAuth.onAuth(function (user) {
      if (!user) return;
      finishLogin(user).then(function (ok) {
        if (ok) window.location.href = dashHref();
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
        promise = operatorEmailFallbackSignIn(authEmail, password).then(function (cred) {
            return finishLogin(cred.user);
          });
      } else {
        promise = window.AvelonAuth.signInEmail(authEmail, password).then(function (cred) {
          return finishLogin(cred.user);
        });
      }

      promise
        .then(function (ok) {
          if (ok) window.location.href = dashHref();
        })
        .catch(function (err) {
          console.warn(err);
          window.AvelonUI.toast(loginErrorMessage(err));
        });
    });
  });
})();
