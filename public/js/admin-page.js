(function () {
  var selectedUid = null;
  var usersUnsub = null;
  var cachedUsers = [];
  var pendingDeleteUid = null;
  /** uid -> { adminDisplayName, adminDisplayMobile } from adminListUsersMerged */
  var serverDisplayByUid = {};
  var serverMergeTimer = null;

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function displayUserLabel(u) {
    var v = String((u && (u.userName || u.displayName || u.name || u.username || u.fullName)) || "").trim();
    if (v) return v;
    var e = String((u && u.email) || "").trim();
    if (e) {
      var local = e.split("@")[0];
      if (/^639\d{9}$/.test(local)) {
        var tail = u.id ? String(u.id).replace(/[^A-Za-z0-9]/g, "").slice(-6) : "";
        return tail ? "Member · " + tail : "Member";
      }
      if (local) return local;
    }
    return "User";
  }

  function displayUserMobile(u) {
    if (window.AvelonPhoneAuth) {
      var m = window.AvelonPhoneAuth.displayFromUser(u);
      if (m) return m;
    }
    return String((u && (u.mobileNumber || u.mobile || u.email)) || "").trim();
  }

  function resolvedName(u) {
    var s = serverDisplayByUid[u.id];
    if (s && String(s.adminDisplayName || "").trim()) return String(s.adminDisplayName).trim();
    return displayUserLabel(u);
  }

  function resolvedMobile(u) {
    var s = serverDisplayByUid[u.id];
    if (s && String(s.adminDisplayMobile || "").trim()) return String(s.adminDisplayMobile).trim();
    return displayUserMobile(u);
  }

  function applyServerUsers(users) {
    serverDisplayByUid = {};
    (users || []).forEach(function (u) {
      if (!u || !u.id) return;
      serverDisplayByUid[u.id] = {
        adminDisplayName: String(u.adminDisplayName != null ? u.adminDisplayName : ""),
        adminDisplayMobile: String(u.adminDisplayMobile != null ? u.adminDisplayMobile : ""),
      };
    });
  }

  function fetchMergedUsers() {
    if (!window.AvelonApi) {
      renderUsers(cachedUsers);
      return Promise.resolve();
    }
    return window.AvelonApi
      .call("adminListUsersMerged", {})
      .then(function (j) {
        applyServerUsers(j && j.users);
        renderUsers(cachedUsers);
      })
      .catch(function () {
        // Keep admin usable even if optional Auth merge endpoint is unavailable.
        renderUsers(cachedUsers);
      });
  }

  function scheduleServerMerge() {
    if (serverMergeTimer) clearTimeout(serverMergeTimer);
    serverMergeTimer = setTimeout(function () {
      serverMergeTimer = null;
      fetchMergedUsers();
    }, 1200);
  }

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

  function requestDeleteUser(uid) {
    if (!uid) return;
    var row = cachedUsers.find(function (x) {
      return x.id === uid;
    });
    if (row && row.role === "admin") {
      window.AvelonUI.toast("Cannot delete admin");
      return;
    }
    pendingDeleteUid = uid;
    var modal = document.getElementById("delete-confirm-modal");
    var uidEl = document.getElementById("delete-confirm-uid");
    if (uidEl) uidEl.textContent = uid;
    if (modal) modal.classList.remove("hidden");
  }

  function doDeleteUser(uid) {
    if (!uid) return;
    if (!window.AvelonApi) {
      window.AvelonUI.toast("Admin API unavailable");
      return;
    }
    var editDel = document.getElementById("edit-delete");
    if (editDel) editDel.disabled = true;
    window.AvelonApi
      .call("adminDeleteUser", { targetUid: uid })
      .then(function () {
        window.AvelonUI.toast("User deleted. Mobile can register again.");
        document.getElementById("edit-modal").classList.add("hidden");
        selectedUid = null;
      })
      .catch(function (e) {
        var detail = e && e.data && e.data.detail ? String(e.data.detail) : "";
        var msg = (e && e.message) || "Delete failed";
        if (detail && (msg === "delete_failed" || msg === "request_failed")) msg = msg + ": " + detail;
        window.AvelonUI.toast(msg);
      })
      .then(function () {
        if (editDel) editDel.disabled = false;
      });
  }

  function renderUsers(rows) {
    var tb = document.querySelector("#users-table tbody");
    var sorted = rows.slice().sort(function (a, b) {
      var an = String(resolvedName(a) + " " + resolvedMobile(a) + " " + (a.email || a.id || "")).toLowerCase();
      var bn = String(resolvedName(b) + " " + resolvedMobile(b) + " " + (b.email || b.id || "")).toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
    });
    tb.innerHTML = sorted
      .map(function (u) {
        var name = esc(resolvedName(u));
        var mobile = esc(resolvedMobile(u));
        return (
          "<tr><td>" +
          name +
          "</td><td>" +
          mobile +
          "</td><td class=\"mono\">" +
          u.id +
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
          "\">Edit</button> " +
          (u.role === "admin"
            ? ""
            : '<button class="btn danger" data-delete="' + u.id + '">Delete</button>') +
          "</td></tr>"
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
        var row = cachedUsers.find(function (x) {
          return x.id === selectedUid;
        });
        document.getElementById("edit-uid").textContent = selectedUid;
        document.getElementById("edit-amt").value = "0";
        document.getElementById("edit-bucket").value = "add_deposit";
        document.getElementById("edit-vip").value = String(row.vipLevel || 1);
        var delBtn = document.getElementById("edit-delete");
        if (delBtn) {
          delBtn.hidden = row.role === "admin";
        }
        document.getElementById("edit-modal").classList.remove("hidden");
      });
    });
    tb.querySelectorAll("[data-delete]").forEach(function (b) {
      b.addEventListener("click", function () {
        var uid = b.getAttribute("data-delete");
        requestDeleteUser(uid);
      });
    });
  }

  function renderWithdrawals(rows) {
    var tb = document.querySelector("#wd-table tbody");
    tb.innerHTML = rows
      .map(function (w) {
        var st = w.status || "";
        var user = cachedUsers.find(function (u) {
          return u.id === w.userId;
        }) || {};
        var mobile = user.id ? resolvedMobile(user) : "";
        return (
          "<tr><td class=\"mono\">" +
          w.id.slice(0, 8) +
          "…</td><td class=\"mono\">" +
          (w.userId || "").slice(0, 8) +
          "…</td><td>" +
          esc(mobile) +
          "</td><td>" +
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
      .onSnapshot(
        function (q) {
          var rows = [];
          q.forEach(function (d) {
            rows.push(Object.assign({ id: d.id }, d.data()));
          });
          cachedUsers = rows;
          renderUsers(rows);
          scheduleServerMerge();
        },
        function () {
          window.AvelonUI.toast("Could not stream users");
        }
      );
  }

  document.addEventListener("DOMContentLoaded", function () {
    requireAdminProfile(function () {
      attachUsersRealtime();
      fetchMergedUsers();
      firebase
        .firestore()
        .collection("withdrawals")
        .orderBy("createdAt", "desc")
        .onSnapshot(function (q) {
          var rows = [];
          q.forEach(function (d) {
            rows.push(Object.assign({ id: d.id }, d.data()));
          });
          renderWithdrawals(rows);
        });

      document.getElementById("reload-users").onclick = function () {
        fetchMergedUsers().then(function () {
          window.AvelonUI.toast("Users refreshed (Firestore + Auth)");
        });
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
      var delModal = document.getElementById("delete-confirm-modal");
      var delCancel = document.getElementById("delete-confirm-cancel");
      var delOk = document.getElementById("delete-confirm-ok");
      if (delCancel) {
        delCancel.onclick = function () {
          pendingDeleteUid = null;
          if (delModal) delModal.classList.add("hidden");
        };
      }
      if (delOk) {
        delOk.onclick = function () {
          var uid = pendingDeleteUid;
          pendingDeleteUid = null;
          if (delModal) delModal.classList.add("hidden");
          doDeleteUser(uid);
        };
      }
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
            var detail = e && e.data && e.data.detail ? String(e.data.detail) : "";
            var msg = (e && e.message) || "Save failed";
            if (detail && msg === "adjust_failed") msg = msg + ": " + detail;
            window.AvelonUI.toast(msg);
          })
          .then(function () {
            document.getElementById("edit-save").disabled = false;
          });
      };
      var editDel = document.getElementById("edit-delete");
      if (editDel) {
        editDel.onclick = function () {
          if (!selectedUid) return;
          requestDeleteUser(selectedUid);
        };
      }
    });
  });
})();
