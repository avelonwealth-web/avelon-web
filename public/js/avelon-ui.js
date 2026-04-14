/* Shared UI helpers */
(function () {
  var host;

  function ensureHost() {
    if (!host) {
      host = document.createElement("div");
      host.className = "toast-host";
      document.body.appendChild(host);
    }
    return host;
  }

  window.AvelonUI = {
    toast: function (msg) {
      var h = ensureHost();
      var el = document.createElement("div");
      el.className = "toast";
      el.textContent = msg;
      h.appendChild(el);
      setTimeout(function () {
        el.remove();
      }, 2600);
    },
    money: function (n) {
      var v = Number(n || 0);
      return (
        "₱" +
        v.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      );
    },
    maskDownline: function (count, isAdmin) {
      var c = Number(count || 0);
      if (isAdmin) return String(c);
      if (c <= 0) return "***";
      var s = String(c);
      if (s.length <= 1) return "*";
      return s[0] + "xx";
    },
    copyText: async function (text) {
      try {
        await navigator.clipboard.writeText(text);
        window.AvelonUI.toast("Copied");
      } catch (e) {
        window.AvelonUI.toast("Copy failed");
      }
    },
    referralLinkFromCode: function (code) {
      if (!code) return "";
      var enc = encodeURIComponent(code);
      var pub = window.AVELON_PUBLIC_BASE && String(window.AVELON_PUBLIC_BASE).replace(/\/+$/, "");
      if (pub) {
        return pub + "/register.html?ref=" + enc;
      }
      var q = "register.html?ref=" + enc;
      if (window.avAbs) return window.avAbs(q);
      var origin = "";
      try {
        origin = window.location.origin.replace(/\/+$/, "");
      } catch (e) {}
      return origin + "/" + q;
    },
    shouldReduceEffects: function () {
      return (
        window.matchMedia &&
        (window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
          window.matchMedia("(prefers-reduced-transparency: reduce)").matches)
      );
    },
    onceOnboard: function (key) {
      var k = "avelon_once_" + key;
      try {
        if (localStorage.getItem(k)) return false;
        localStorage.setItem(k, "1");
        return true;
      } catch (e) {
        return true;
      }
    },
  };
})();
