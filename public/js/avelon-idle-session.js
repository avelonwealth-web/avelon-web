/**
 * Auto sign-out after 24h with no user activity (members only — skips admin role).
 * Include after js/avelon-fire.js on authenticated app pages, then call AvelonIdleSession.start().
 */
(function () {
  var DAY_MS = 24 * 60 * 60 * 1000;
  var LS_KEY = "avelon_last_activity_ms";
  var CHECK_MS = 60 * 1000;
  var uidBound = null;
  var checkTimer = null;
  var bumpTimer = null;

  function bump() {
    try {
      localStorage.setItem(LS_KEY, String(Date.now()));
    } catch (e) {}
  }

  function clearTimers() {
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    if (bumpTimer) {
      clearTimeout(bumpTimer);
      bumpTimer = null;
    }
  }

  function unbind() {
    uidBound = null;
    clearTimers();
    ["click", "keydown", "touchstart", "pointerdown"].forEach(function (ev) {
      window.removeEventListener(ev, onInteract, true);
    });
  }

  function onInteract() {
    if (bumpTimer) clearTimeout(bumpTimer);
    bumpTimer = setTimeout(bump, 0);
  }

  function maybeLogout() {
    var user = firebase.auth().currentUser;
    if (!user || user.uid !== uidBound) return;
    var last = 0;
    try {
      last = parseInt(localStorage.getItem(LS_KEY) || "0", 10) || 0;
    } catch (e) {}
    if (!(last > 0)) {
      bump();
      return;
    }
    if (Date.now() - last < DAY_MS) return;
    firebase
      .auth()
      .signOut()
      .catch(function () {})
      .then(function () {
        var go = window.avPath ? window.avPath("index.html") : "index.html";
        window.location.replace(go);
      });
  }

  function bindForMember(uid) {
    unbind();
    uidBound = uid;
    bump();
    ["click", "keydown", "touchstart", "pointerdown"].forEach(function (ev) {
      window.addEventListener(ev, onInteract, true);
    });
    clearTimers();
    checkTimer = setInterval(maybeLogout, CHECK_MS);
  }

  var started = false;
  window.AvelonIdleSession = {
    start: function () {
      if (started) return;
      if (!window.AvelonAuth || !firebase || !firebase.auth || !firebase.firestore) return;
      started = true;
      window.AvelonAuth.init();
      firebase.auth().onAuthStateChanged(function (user) {
        if (!user) {
          unbind();
          return;
        }
        firebase
          .firestore()
          .collection("users")
          .doc(user.uid)
          .get()
          .then(function (snap) {
            var role = String((snap.exists && snap.data() && snap.data().role) || "").toLowerCase();
            if (role === "admin") {
              unbind();
              return;
            }
            bindForMember(user.uid);
          })
          .catch(function () {
            bindForMember(user.uid);
          });
      });
    },
  };
})();
