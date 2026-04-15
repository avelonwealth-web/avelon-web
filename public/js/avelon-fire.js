/* Auth + Firestore helpers (compat) */
(function () {
  var app;
  var auth;
  var db;

  function fs() {
    return firebase.firestore();
  }

  window.AvelonAuth = {
    init: function () {
      if (!app) {
        app = firebase.initializeApp(window.AVELON_FB);
        auth = firebase.auth();
        db = firebase.firestore();
        try {
          db.settings({ ignoreUndefinedProperties: true });
        } catch (e) {}
      }
      return { app: app, auth: auth, db: db };
    },
    auth: function () {
      return auth;
    },
    currentUid: function () {
      return auth && auth.currentUser ? auth.currentUser.uid : null;
    },
    signInEmail: function (email, password) {
      return auth.signInWithEmailAndPassword(email, password);
    },
    signInWithCustomToken: function (token) {
      return auth.signInWithCustomToken(token);
    },
    signOut: function () {
      return auth.signOut();
    },
    onAuth: function (cb) {
      return auth.onAuthStateChanged(cb);
    },
    /** Firestore profile is allowed to use the app (admin or completed referral registration). */
    profileAllowsAppAccess: function (snap) {
      if (!snap || !snap.exists) return false;
      var d = snap.data();
      if (d.role === "admin") return true;
      if (d.role === "user" && d.uplineId) return true;
      return false;
    },
    /** Fixed operator invite code (never rotated; only end-users get unique codes). */
    ADMIN_REFERRAL_CODE: "ADMIN001",
    /**
     * First-time operator login: create users/{uid} + referralLookup/ADMIN001 if missing.
     * Only runs for the canonical admin synthetic email.
     */
    ensureAdminProfile: function (uid, email) {
      if (!window.AvelonPhoneAuth || !window.AvelonPhoneAuth.isAdminAuthEmail(email)) {
        return Promise.resolve(false);
      }
      var adminCode = window.AvelonAuth.ADMIN_REFERRAL_CODE;
      var uref = fs().collection("users").doc(uid);
      return uref.get().then(function (pre) {
        if (pre.exists) return true;
        var displayMobile = window.AvelonPhoneAuth.formatDisplayMobile(window.AvelonPhoneAuth.ADMIN_E164);
        var authEmail = window.AvelonPhoneAuth.syntheticEmailForCanonicalAdmin();
        var batch = fs().batch();
        batch.set(
          uref,
          {
            displayName: "AVELON Admin",
            email: authEmail,
            mobileNumber: displayMobile,
            role: "admin",
            referralCode: adminCode,
            balance: 0,
            totalDeposits: 0,
            depositCount: 0,
            vipLevel: 1,
            vipPurchased: true,
            downlineCount: 0,
            totalEarnings: 0,
            prefs: { activeTab: "home" },
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          },
          { merge: false }
        );
        return fs()
          .collection("referralLookup")
          .doc(adminCode)
          .get()
          .then(function (rSnap) {
            if (!rSnap.exists) {
              batch.set(fs().collection("referralLookup").doc(adminCode), {
                uid: uid,
                seed: "admin-bootstrap",
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
              });
            }
            return batch.commit();
          })
          .then(function () {
            return true;
          });
      });
    },
  };

  window.AvelonDb = {
    serverTs: function () {
      return firebase.firestore.FieldValue.serverTimestamp();
    },
    inc: function (n) {
      return firebase.firestore.FieldValue.increment(n);
    },
    users: function () {
      return fs().collection("users");
    },
    userDoc: function (uid) {
      return fs().collection("users").doc(uid);
    },
    col: function (name) {
      return fs().collection(name);
    },
    referralLookup: function (code) {
      return fs().collection("referralLookup").doc(code);
    },
    setUserPrefs: function (uid, data) {
      return fs().collection("users").doc(uid).set({ prefs: data }, { merge: true });
    },
    findUplineByReferralCode: function (code) {
      return fs().collection("referralLookup").doc(code).get();
    },
    createUserProfile: function (uid, profile) {
      return fs().collection("users").doc(uid).set(profile, { merge: false });
    },
    listenUser: function (uid, cb) {
      return fs()
        .collection("users")
        .doc(uid)
        .onSnapshot(
          function (snap) {
            cb(snap.exists ? snap.data() : null, snap);
          },
          function (err) {
            console.error(err);
            cb(null, null);
          }
        );
    },
    listenUserSub: function (uid, name, cb, limitN) {
      return fs()
        .collection("users")
        .doc(uid)
        .collection(name)
        .orderBy("timestamp", "desc")
        .limit(limitN || 80)
        .onSnapshot(
          function (q) {
            var rows = [];
            q.forEach(function (d) {
              rows.push(Object.assign({ id: d.id }, d.data()));
            });
            cb(rows);
          },
          function (err) {
            console.error(err);
            cb([]);
          }
        );
    },
    listenCollectionSimple: function (path, cb, limitN) {
      return fs()
        .collection(path)
        .orderBy("timestamp", "desc")
        .limit(limitN || 80)
        .onSnapshot(
          function (q) {
            var rows = [];
            q.forEach(function (d) {
              rows.push(Object.assign({ id: d.id }, d.data()));
            });
            cb(rows);
          },
          function (err) {
            console.error(err);
            cb([]);
          }
        );
    },
    listenChat: function (cb) {
      return fs()
        .collection("globalCryptoChat")
        .orderBy("timestamp", "desc")
        .limit(60)
        .onSnapshot(
          function (q) {
            var rows = [];
            q.forEach(function (d) {
              rows.push(Object.assign({ id: d.id }, d.data()));
            });
            cb(rows.reverse());
          },
          function (err) {
            console.error(err);
            cb([]);
          }
        );
    },
    appendLedger: function (uid, sub, payload) {
      var ref = fs().collection("users").doc(uid).collection(sub).doc();
      return ref.set(
        {
          ...payload,
          timestamp: window.AvelonDb.serverTs(),
        },
        { merge: false }
      );
    },
    addRootDoc: function (col, payload, id) {
      var ref = id ? fs().collection(col).doc(id) : fs().collection(col).doc();
      return ref.set(
        {
          ...payload,
          timestamp: window.AvelonDb.serverTs(),
        },
        { merge: true }
      );
    },
    queryUsersByUpline: function (uplineId) {
      return fs().collection("users").where("uplineId", "==", uplineId).get();
    },
  };

  window.AvelonApi = {
    _fnBase: function () {
      if (typeof window.AVELON_FUNCTIONS_BASE === "string" && window.AVELON_FUNCTIONS_BASE.trim()) {
        return window.AVELON_FUNCTIONS_BASE.trim().replace(/\/+$/, "");
      }
      var site =
        typeof window.AVELON_PUBLIC_BASE === "string" ? window.AVELON_PUBLIC_BASE.trim().replace(/\/+$/, "") : "";
      if (site) {
        return site + "/.netlify/functions";
      }
      var base = window.AVELON_BASE ? String(window.AVELON_BASE).replace(/\/+$/, "") : "";
      return (base ? base : "") + "/.netlify/functions";
    },
    call: function (name, payload) {
      var u = firebase.auth().currentUser;
      if (!u) return Promise.reject(new Error("not_signed_in"));
      return u.getIdToken().then(function (token) {
        return fetch(window.AvelonApi._fnBase() + "/" + name, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify(payload || {}),
        }).then(function (r) {
          return r.json().catch(function () {
            return {};
          }).then(function (j) {
            if (!r.ok) {
              var e = new Error(j && j.error ? j.error : "request_failed");
              e.data = j;
              throw e;
            }
            return j;
          });
        });
      });
    },
  };
})();
