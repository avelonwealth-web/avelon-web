/* Show / hide password (eye toggle) */
(function () {
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-password-toggle]").forEach(function (btn) {
      var targetId = btn.getAttribute("data-password-for");
      var input = targetId ? document.getElementById(targetId) : null;
      if (!input) return;

      var open = btn.querySelector(".pw-eye-open");
      var shut = btn.querySelector(".pw-eye-shut");

      function sync() {
        var hidden = input.type === "password";
        /* Slash icon = concealed; open eye = visible (tap to hide) */
        if (open) open.style.display = hidden ? "none" : "block";
        if (shut) shut.style.display = hidden ? "block" : "none";
      }

      sync();

      btn.addEventListener("click", function () {
        var show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.setAttribute("aria-pressed", show ? "true" : "false");
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
        sync();
      });
    });
  });
})();
