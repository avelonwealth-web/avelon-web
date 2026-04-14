/* Site base path for GitHub Pages / subfolder deploys (optional). */
(function () {
  function readBase() {
    var m = document.querySelector('meta[name="avelon-base"]');
    var raw = m && m.getAttribute("content") ? String(m.getAttribute("content")).trim() : "";
    if (!raw) return "";
    return raw.replace(/\/+$/, "");
  }

  window.AVELON_BASE = readBase();

  window.avPath = function (rel) {
    var r = String(rel || "").replace(/^\/+/, "");
    if (!r) return window.AVELON_BASE || "/";
    if (!window.AVELON_BASE) return r;
    return window.AVELON_BASE + "/" + r;
  };

  window.avAbs = function (rel) {
    var p = window.avPath(rel);
    try {
      return new URL(p, window.location.href).toString();
    } catch (e) {
      return p;
    }
  };

  document.addEventListener("DOMContentLoaded", function () {
    if (!window.AVELON_BASE) return;
    document.querySelectorAll('a[href]:not([data-av-skip])').forEach(function (a) {
      var h = a.getAttribute("href");
      if (!h) return;
      if (h.startsWith("#")) return;
      if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return;
      if (h.startsWith("//")) return;
      if (h.startsWith("/")) {
        a.setAttribute("href", window.AVELON_BASE + h);
        return;
      }
      a.setAttribute("href", window.avPath(h));
    });
  });
})();
