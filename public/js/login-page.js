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
    try {
      if (host.indexOf("netlify.app") !== -1) {
        list.push(window.location.origin + "/.netlify/functions/adminCustomToken");
      }
    } catch (e) {}
    if (fb.projectId) {
      list.push("https://us-central1-" + fb.projectId + ".cloudfunctions.net/adminCustomToken");
    }
    var seen = {};
    return list.filter(function (u) {
      if (!u || seen[u]) return false;
      seen[u] = true;
      return true;
    });
  }

  function isCanonicalOperatorAuthEmail(authEmail) {
    return authEmail === window.AvelonPhoneAuth.syntheticEmailForCanonicalAdmin();
  }

  function fetchAdminCustomTokenAt(url, mobile, password) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mobile: mobile, password: password }),
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = {};
        try {
          j = t ? JSON.parse(t) : {};
        } catch (e) {
          j = { _parseError: true };
        }
        return { r: r, j: j };
      });
    });
  }

  /**
   * Operator login: server verifies password and returns a Firebase custom token.
   */
  function operatorSignInWithCustomToken(mobile, password) {
    var urls = adminCustomTokenUrlCandidates();
    if (!urls.length) return Promise.reject({ _emailFallback: true });

    function attempt(i) {
      if (i >= urls.length) return Promise.reject({ _emailFallback: true });
      return fetchAdminCustomTokenAt(urls[i], mobile, password)
        .then(function (x) {
          if (!x.r.ok) {
            if (x.r.status === 503 && x.j && x.j.error === "not_configured") return attempt(i + 1);
            // Do not hard-fail here; try remaining endpoints, then fall back to Firebase email/password.
            if (x.r.status === 401 || x.r.status === 403) return attempt(i + 1);
            return attempt(i + 1);
          }
          if (!x.j || !x.j.customToken || x.j._parseError) return attempt(i + 1);
          return window.AvelonAuth.signInWithCustomToken(x.j.customToken);
        })
        .catch(function () {
          return attempt(i + 1);
        });
    }

    return attempt(0).catch(function () {
      return Promise.reject({ _emailFallback: true });
    });
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
        promise = operatorSignInWithCustomToken(mobile, password)
          .catch(function (err) {
            if (err && err._emailFallback) return window.AvelonAuth.signInEmail(authEmail, password);
            throw err;
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
          if (ok) window.location.href = dashHref();
        })
        .catch(function (err) {
          console.warn(err);
          window.AvelonUI.toast(loginErrorMessage(err));
        });
    });
  });
})();
