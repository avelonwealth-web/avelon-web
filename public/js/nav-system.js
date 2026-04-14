/* AVELON bottom navigation — single template, inject, modes (spa | gateway | external) */
(function () {
  var LS_KEY = "avelon_active_tab";

  function bottomNavMarkup() {
    return (
      '<nav class="bottom-nav bottom-nav--avelon" aria-label="Primary">' +
      '<button type="button" data-tab="home" class="is-active">' +
      '<svg class="ico" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z" stroke="currentColor" stroke-width="1.6"/></svg>' +
      "<span>HOME</span></button>" +
      '<button type="button" data-tab="markets">' +
      '<svg class="ico" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 19V5" stroke="currentColor" stroke-width="1.6"/><path d="M4 14h4l3-8 4 14 3-6h6" stroke="currentColor" stroke-width="1.6"/></svg>' +
      "<span>MARKETS</span></button>" +
      '<button type="button" data-tab="features">' +
      '<svg class="ico" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3l2.2 6.8H21l-5.5 4 2.1 6.7L12 16.3 6.4 20.5l2.1-6.7L3 9.8h6.8L12 3Z" stroke="currentColor" stroke-width="1.3"/></svg>' +
      "<span>FEATURES</span></button>" +
      '<button type="button" data-tab="assets">' +
      '<svg class="ico" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 7h12v10H6V7Zm3 3h6M9 14h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
      "<span>ASSETS</span></button>" +
      '<button type="button" data-tab="profile">' +
      '<svg class="ico" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-4 0-7 2-7 4v2h14v-2c0-2-3-4-7-4Z" stroke="currentColor" stroke-width="1.6"/></svg>' +
      "<span>PROFILE</span></button>" +
      "</nav>"
    );
  }

  function allSections() {
    return Array.prototype.slice.call(document.querySelectorAll(".tab-section"));
  }

  function setActiveButton(page) {
    document.querySelectorAll(".bottom-nav--avelon [data-tab]").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-tab") === page);
    });
  }

  function saveTabLocal(page) {
    try {
      localStorage.setItem(LS_KEY, page);
    } catch (e) {}
  }

  function saveTabRemote(page) {
    if (window.AvelonDb && window.AvelonAuth && window.AvelonAuth.currentUid) {
      var uid = window.AvelonAuth.currentUid();
      if (uid) window.AvelonDb.setUserPrefs(uid, { activeTab: page });
    }
  }

  window.switchTab = function (page) {
    var sections = allSections();
    if (sections.length) {
      sections.forEach(function (sec) {
        var id = sec.getAttribute("data-tab");
        sec.classList.toggle("is-active", id === page);
      });
    }
    setActiveButton(page);
    saveTabLocal(page);
    saveTabRemote(page);
    try {
      history.replaceState(null, "", "#" + page);
    } catch (e) {}
    try {
      window.dispatchEvent(new CustomEvent("avelon-tab", { detail: { page: page } }));
    } catch (e) {}
  };

  window.restoreTab = function (fallback) {
    var hash = (location.hash || "").replace("#", "");
    var fromLs = null;
    try {
      fromLs = localStorage.getItem(LS_KEY);
    } catch (e) {}
    var page = hash || fromLs || fallback || "home";
    window.switchTab(page);
  };

  window.avGoAppTab = function (page) {
    saveTabLocal(page);
    saveTabRemote(page);
    var url = (window.avPath ? window.avPath("dashboard.html") : "dashboard.html") + "#" + page;
    window.location.href = url;
  };

  function bindBottomNav(mode) {
    mode = mode || "spa";
    document.querySelectorAll(".bottom-nav--avelon [data-tab]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        var p = btn.getAttribute("data-tab");
        if (!p) return;

        if (mode === "external") {
          e.preventDefault();
          window.avGoAppTab(p);
          return;
        }

        if (mode === "gateway") {
          e.preventDefault();
          var uid = null;
          try {
            uid = window.AvelonAuth && window.AvelonAuth.currentUid ? window.AvelonAuth.currentUid() : null;
          } catch (err) {}
          if (uid) {
            window.avGoAppTab(p);
            return;
          }
          window.switchTab(p);
          return;
        }

        e.preventDefault();
        window.switchTab(p);
      });
    });
  }

  function injectNav() {
    var slot = document.getElementById("bottom-nav-slot");
    if (!slot) return null;
    var mode = String(slot.getAttribute("data-nav-mode") || "spa");
    slot.outerHTML = bottomNavMarkup();
    return mode;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var mode = injectNav();
    if (mode) {
      window.AVELON_NAV_MODE = mode;
      bindBottomNav(mode);
    } else if (document.querySelector(".bottom-nav--avelon")) {
      window.AVELON_NAV_MODE = "spa";
      bindBottomNav("spa");
    }
  });
})();
