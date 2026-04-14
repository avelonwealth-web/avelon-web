(function () {
  var selectedUid = null;
  var usersUnsub = null;
  var cachedUsers = [];

  function requireAdminProfile(next) {
    window.AvelonAuth.init();
    window.AvelonAuth.onAuth(function (user) {
      if (!user) {
        window.location.href = window.avPath ? window.avPath("login.html") : "login.html";
        return;
      }
      window.AvelonDb
        .userDoc(user.uid)
        .get()
        .then(function (snap) {
          var d = snap.data() || {};
          if (d.role !== "admin") {
            window.AvelonUI.toast("Admin only");
            window.location.href = window.avPath ? window.avPath("dashboard.html") : "dashboard.html";
            return;
          }
          next(user.uid);
        })
        .catch(function () {
          window.location.href = window.avPath ? window.avPath("login.html") : "login.html";
        });
    });
  }

  function renderUsers(rows) {
    var tb = document.querySelector("#users-table tbody");
    tb.innerHTML = rows
      .map(function (u) {
        return (
          "<tr><td class=\"mono\">" +
          u.id.slice(0, 8) +
          "…</td><td>" +
          (window.AvelonPhoneAuth ? window.AvelonPhoneAuth.displayFromUser(u) : u.mobileNumber || u.email || "") +
          "</td><td>" +
          window.AvelonUI.money(u.balance || 0) +
          "</td><td>VIP " +
          (u.vipLevel || 1) +
          "</td><td>" +
          String(u.downlineCount || 0) +
          "</td><td class=\"mono\">" +
          (u.referralCode || "") +
          "</td><td><button type=\"button\" class=\"btn secondary\" data-refcode=\"" +
          encodeURIComponent(u.referralCode || "") +
          "\">Copy</button></td><td><button class=\"btn secondary\" data-edit=\"" +
          u.id +
          "\">Edit</button></td></tr>"
        );
      })
      .join("");
    tb.querySelectorAll("[data-refcode]").forEach(function (b) {
      b.addEventListener("click", function () {
        var c = decodeURIComponent(b.getAttribute("data-refcode") || "");
        if (!c) return;
        window.AvelonUI.copyText(window.AvelonUI.referralLinkFromCode(c));
      });
    });
    tb.querySelectorAll("[data-edit]").forEach(function (b) {
      b.addEventListener("click", function () {
        selectedUid = b.getAttribute("data-edit");
        var row = rows.find(function (x) {
          return x.id === selectedUid;
        });
        document.getElementById("edit-uid").textContent = selectedUid;
        document.getElementById("edit-amt").value = "0";
        document.getElementById("edit-bucket").value = "add_deposit";
        document.getElementById("edit-vip").value = String(row.vipLevel || 1);
        document.getElementById("edit-modal").classList.remove("hidden");
      });
    });
  }

  function renderWithdrawals(rows) {
    var tb = document.querySelector("#wd-table tbody");
    tb.innerHTML = rows
      .map(function (w) {
        var st = w.status || "";
        return (
          "<tr><td class=\"mono\">" +
          w.id.slice(0, 8) +
          "…</td><td class=\"mono\">" +
          (w.userId || "").slice(0, 8) +
          "…</td><td>" +
          window.AvelonUI.money(w.amountGross || 0) +
          "</td><td>" +
          window.AvelonUI.money(w.amountNet || 0) +
          "</td><td>" +
          st +
          "</td><td>" +
          (st === "pending"
            ? '<button class="btn" data-approve="' +
              w.id +
              '">Approve</button> <button class="btn danger" data-reject="' +
              w.id +
              '">Reject</button>'
            : "") +
          "</td></tr>"
        );
      })
      .join("");

    tb.querySelectorAll("[data-approve]").forEach(function (b) {
      b.addEventListener("click", function () {
        approveWithdrawal(b.getAttribute("data-approve"), true);
      });
    });
    tb.querySelectorAll("[data-reject]").forEach(function (b) {
      b.addEventListener("click", function () {
        approveWithdrawal(b.getAttribute("data-reject"), false);
      });
    });
  }

  function approveWithdrawal(id, ok) {
    if (!window.AvelonApi) {
      window.AvelonUI.toast("Admin backend unavailable");
      return;
    }
    window.AvelonApi
      .call(ok ? "adminApproveWithdrawal" : "adminRejectWithdrawal", { withdrawalId: id })
      .then(function () {
        window.AvelonUI.toast(ok ? "Approved" : "Rejected");
      })
      .catch(function () {
        window.AvelonUI.toast("Update failed");
      });
  }

  function attachUsersRealtime() {
    if (usersUnsub) {
      try {
        usersUnsub();
      } catch (e) {}
    }
    usersUnsub = firebase
      .firestore()
      .collection("users")
      .limit(200)
      .onSnapshot(
        function (q) {
          var rows = [];
          q.forEach(function (d) {
            rows.push(Object.assign({ id: d.id }, d.data()));
          });
          cachedUsers = rows;
          renderUsers(rows);
        },
        function () {
          window.AvelonUI.toast("Could not stream users");
        }
      );
  }

  document.addEventListener("DOMContentLoaded", function () {
    requireAdminProfile(function () {
      attachUsersRealtime();
      firebase
        .firestore()
        .collection("withdrawals")
        .orderBy("createdAt", "desc")
        .limit(40)
        .onSnapshot(function (q) {
          var rows = [];
          q.forEach(function (d) {
            rows.push(Object.assign({ id: d.id }, d.data()));
          });
          renderWithdrawals(rows);
        });

      document.getElementById("reload-users").onclick = function () {
        renderUsers(cachedUsers);
        window.AvelonUI.toast("Users are LIVE");
      };
      document.getElementById("go-dash").onclick = function () {
        window.location.href = window.avPath ? window.avPath("dashboard.html") : "dashboard.html";
      };
      document.getElementById("logout").onclick = function () {
        window.AvelonAuth.signOut().then(function () {
          window.location.href = window.avPath ? window.avPath("login.html") : "login.html";
        });
      };
      document.getElementById("edit-close").onclick = function () {
        document.getElementById("edit-modal").classList.add("hidden");
      };
      document.getElementById("edit-save").onclick = function () {
        if (!selectedUid) return;
        if (!window.AvelonApi) {
          window.AvelonUI.toast("Admin API unavailable");
          return;
        }
        var amt = Number(document.getElementById("edit-amt").value || "0");
        var mode = document.getElementById("edit-bucket").value;
        var vip = Number(document.getElementById("edit-vip").value || "1");
        var nextVip = Math.max(1, Math.min(15, vip));
        document.getElementById("edit-save").disabled = true;
        window.AvelonApi
          .call("adminAdjustBalance", {
            targetUid: selectedUid,
            amount: amt,
            mode: mode,
            vipLevel: nextVip,
          })
          .then(function () {
            window.AvelonUI.toast("Saved");
            document.getElementById("edit-modal").classList.add("hidden");
          })
          .catch(function (e) {
            window.AvelonUI.toast((e && e.message) || "Save failed");
          })
          .then(function () {
            document.getElementById("edit-save").disabled = false;
          });
      };
    });
  });
})();
