/* PH mobile ↔ Firebase Email/Password synthetic email
   Accepts: 09XXXXXXXXX · 9XXXXXXXXX · +63… · 63… (+63 applied automatically) */
(function () {
  function digitsOnly(s) {
    return String(s || "").replace(/\D/g, "");
  }

  function toE164Philippines(input) {
    var d = digitsOnly(input);
    if (!d) return null;

    if (d.indexOf("63") === 0) {
      if (d.length >= 12) return d.slice(0, 12);
      return null;
    }

    if (d.charAt(0) === "0" && d.charAt(1) === "9" && d.length === 11) {
      return "63" + d.slice(1);
    }

    if (d.charAt(0) === "9" && d.length === 10) {
      return "63" + d;
    }

    return null;
  }

  function isValidPhMobileE164(e164) {
    return typeof e164 === "string" && /^639\d{9}$/.test(e164);
  }

  function mobileToAuthEmail(e164) {
    return e164 + "@phone.avelon-wealth.local";
  }

  function formatDisplayMobile(e164) {
    if (!e164 || e164.length < 12) return e164 || "";
    return "0" + e164.slice(2);
  }

  /** Canonical operator admin (PH) — maps to 639…@phone.avelon-wealth.local */
  var ADMIN_E164 = "639152444480";

  window.AvelonPhoneAuth = {
    digitsOnly: digitsOnly,
    toE164Philippines: toE164Philippines,
    isValidPhMobileE164: isValidPhMobileE164,
    mobileToAuthEmail: mobileToAuthEmail,
    formatDisplayMobile: formatDisplayMobile,
    ADMIN_E164: ADMIN_E164,
    syntheticEmailForCanonicalAdmin: function () {
      return mobileToAuthEmail(ADMIN_E164);
    },
    isAdminAuthEmail: function (email) {
      var expected = mobileToAuthEmail(ADMIN_E164);
      return String(email || "").toLowerCase() === expected.toLowerCase();
    },
    authEmailFromInput: function (input) {
      var e164 = toE164Philippines(input);
      if (!e164 || !isValidPhMobileE164(e164)) return null;
      return mobileToAuthEmail(e164);
    },
    displayFromInput: function (input) {
      var e164 = toE164Philippines(input);
      return e164 ? formatDisplayMobile(e164) : "";
    },
    displayFromUser: function (u) {
      if (!u) return "";
      if (u.mobileNumber) return String(u.mobileNumber);
      var e = u.email || "";
      var m = /^(\d{12})@phone\.avelon-wealth\.local$/i.exec(e);
      if (m) return formatDisplayMobile(m[1]);
      return e || "";
    },
  };
})();
