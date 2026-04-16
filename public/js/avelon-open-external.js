/**
 * Messenger / Facebook / Instagram in-app browser: buksan ang parehong URL sa system browser (Chrome / Safari).
 * Kapag naka-install ang PWA (standalone), walang banner — nakikilala bilang installed app.
 */
(function () {
  var SKIP_Q = "avelon_skip_inapp";
  var INTENT_KEY = "avelon_chrome_intent_tried";

  function isStandalonePwa() {
    try {
      if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
      if (window.matchMedia && window.matchMedia("(display-mode: fullscreen)").matches) return true;
      if (window.navigator.standalone === true) return true;
    } catch (e) {}
    return false;
  }

  function skipByQuery() {
    try {
      var p = new URLSearchParams(window.location.search || "");
      return p.get(SKIP_Q) === "1";
    } catch (e) {
      return false;
    }
  }

  function isInAppSocialBrowser() {
    var ua = String(navigator.userAgent || navigator.vendor || "");
    if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) return true;
    if (/messenger/i.test(ua) && /FB_IAB|FBAV|FBIOS|FBAN/i.test(ua)) return true;
    if (/Instagram/i.test(ua)) return true;
    if (/Line\//i.test(ua)) return true;
    if (/Snapchat/i.test(ua)) return true;
    if (/Twitter/i.test(ua)) return true;
    return false;
  }

  function isAndroid() {
    return /Android/i.test(navigator.userAgent || "");
  }

  function isIos() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  }

  function pageUrl() {
    return String(window.location.href || "").split("#")[0];
  }

  /** Android: buksan ang Chrome gamit ang parehong HTTPS URL (fallback kung walang Chrome). */
  function chromeIntentUrl(httpsUrl) {
    try {
      var u = new URL(httpsUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") return "";
      var scheme = u.protocol.replace(":", "");
      var authority = u.host + (u.port ? ":" + u.port : "");
      var pathQueryHash = (u.pathname || "/") + (u.search || "") + (u.hash || "");
      var fallback = encodeURIComponent(httpsUrl);
      return (
        "intent://" +
        authority +
        pathQueryHash +
        "#Intent;scheme=" +
        scheme +
        ";action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=com.android.chrome;S.browser_fallback_url=" +
        fallback +
        ";end"
      );
    } catch (e) {
      return "";
    }
  }

  function tryOpenChromeOnce() {
    if (!isAndroid() || sessionStorage.getItem(INTENT_KEY) === "1") return;
    var intent = chromeIntentUrl(pageUrl());
    if (!intent) return;
    sessionStorage.setItem(INTENT_KEY, "1");
    window.location.href = intent;
  }

  function mountBanner() {
    if (document.getElementById("avelon-in-app-bar")) return;
    var bar = document.createElement("div");
    bar.id = "avelon-in-app-bar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Open in browser");

    var msg = document.createElement("div");
    msg.className = "avelon-in-app-msg";
    msg.innerHTML =
      "<strong>In-app browser detected.</strong> For login, deposits, and notifications, open this page in " +
      (isIos() ? "<strong>Safari</strong> or Chrome." : "<strong>Chrome</strong> or your default browser.") +
      " <span class='avelon-in-app-pwa-hint'>If you installed AVELON (Add to Home Screen), open it from that home screen icon — it runs as the app.</span>";

    var actions = document.createElement("div");
    actions.className = "avelon-in-app-actions";

    if (isAndroid()) {
      var bChrome = document.createElement("button");
      bChrome.type = "button";
      bChrome.className = "btn";
      bChrome.textContent = "Open in Chrome";
      bChrome.onclick = function () {
        sessionStorage.removeItem(INTENT_KEY);
        var intent = chromeIntentUrl(pageUrl());
        if (intent) window.location.href = intent;
      };
      actions.appendChild(bChrome);
    }

    var bDismiss = document.createElement("button");
    bDismiss.type = "button";
    bDismiss.className = "btn secondary";
    bDismiss.textContent = "Stay here";
    bDismiss.onclick = function () {
      try {
        sessionStorage.setItem("avelon_skip_external_once", "1");
      } catch (e) {}
      bar.remove();
      try {
        document.documentElement.classList.remove("avelon-in-app-pad");
      } catch (e2) {}
    };
    actions.appendChild(bDismiss);

    if (isIos()) {
      var hint = document.createElement("p");
      hint.className = "avelon-in-app-ios";
      hint.innerHTML =
        "iOS: tap <strong>· · ·</strong> (lower right or top) → <strong>Open in Safari</strong>, or long-press the link before opening.";
      bar.appendChild(hint);
    }

    bar.appendChild(msg);
    bar.appendChild(actions);
    document.body.insertBefore(bar, document.body.firstChild);
    try {
      document.documentElement.classList.add("avelon-in-app-pad");
    } catch (e3) {}
  }

  if (skipByQuery()) return;
  if (isStandalonePwa()) {
    try {
      document.documentElement.setAttribute("data-avelon-display", "standalone");
    } catch (e) {}
    return;
  }
  if (!isInAppSocialBrowser()) return;

  document.addEventListener(
    "DOMContentLoaded",
    function () {
      if (sessionStorage.getItem("avelon_skip_external_once") === "1") return;
      mountBanner();
      if (isAndroid()) {
        setTimeout(tryOpenChromeOnce, 500);
      }
    },
    { once: true }
  );
})();
