(function () {
  var selectedUid = null;
  var usersUnsub = null;
  var cachedUsers = [];
  /** uid -> { email, displayName, phoneNumber } | { _empty: true } */
  var authProfileByUid = {};
  var authFetchedUid = {};
  var enrichTimer = null;

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function hasRichName(u) {
    return !!String((u && (u.userName || u.displayName || u.name || u.username || u.fullName)) || "").trim();
  }

  function hasRichMobile(u) {
    try {
      return !!(window.AvelonPhoneAuth && window.AvelonPhoneAuth.displayFromUser(u));
    } catch (e) {
      return false;
    }
  }

  function mergeAuthIntoUser(row, ap) {
    var out = Object.assign({}, row);
    if (!ap || ap._empty) return out;
    if (!String(out.email || "").trim() && ap.email) out.email = ap.email;
    if (!hasRichName(out) && ap.displayName) out.displayName = ap.displayName;
    if (!hasRichMobile(out)) {
      if (ap.phoneNumber) out.phoneNumber = ap.phoneNumber;
      else if (ap.email && !String(out.email || "").trim()) out.email = ap.email;
    }
    return out;
  }

  function rowForDisplay(row) {
    return mergeAuthIntoUser(row, authProfileByUid[row.id]);
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

  function scheduleAuthEnrich(rows) {
    if (enrichTimer) clearTimeout(enrichTimer);
    enrichTimer = setTimeout(function () {
      enrichTimer = null;
      runAuthEnrich(rows);
    }, 450);
  }

  function runAuthEnrich(rows) {
    if (!rows || !rows.length) return;
    if (!window.AvelonApi) {
      renderUsers(cachedUsers);
      return;
    }
    var need = [];
    rows.forEach(function (r) {
      var uid = r.id;
      if (!uid) return;
      if (authProfileByUid[uid] && authProfileByUid[uid]._empty) return;
      if (authFetchedUid[uid]) return;
      var merged = rowForDisplay(r);
      if (hasRichName(merged) && hasRichMobile(merged)) {
        authFetchedUid[uid] = true;
        return;
      }
      need.push(uid);
    });
    if (!need.length) {
      renderUsers(cachedUsers);
      return;
    }

    function chunk(start) {
      var slice = need.slice(start, start + 100);
      if (!slice.length) {
        renderUsers(cachedUsers);
        return;
      }
      window.AvelonApi
        .call("adminEnrichUsers", { uids: slice })
        .then(function (j) {
          var profiles = (j && j.profiles) || {};
          slice.forEach(function (uid) {
            authFetchedUid[uid] = true;
            var p = profiles[uid];
            if (p && (p.email || p.displayName || p.phoneNumber)) {
              authProfileByUid[uid] = {
                email: String(p.email || ""),
                displayName: String(p.displayName || ""),
                phoneNumber: String(p.phoneNumber || ""),
              };
            } else {
              authProfileByUid[uid] = { _empty: true };
            }
          });
          chunk(start + 100);
        })
        .catch(function () {
          slice.forEach(function (uid) {
            authFetchedUid[uid] = true;
            authProfileByUid[uid] = authProfileByUid[uid] || { _empty: true };
          });
          chunk(start + 100);
        });
    }
    chunk(0);
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

  function renderUsers(rows) {
    var tb = document.querySelector("#users-table tbody");
    var sorted = rows.slice().sort(function (a, b) {
      var ra = rowForDisplay(a);
      var rb = rowForDisplay(b);
      var an = String(
        displayUserLabel(ra) + " " + displayUserMobile(ra) + " " + (ra.email || ra.id || "")
      ).toLowerCase();
      var bn = String(
        displayUserLabel(rb) + " " + displayUserMobile(rb) + " " + (rb.email || rb.id || "")
      ).toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
    });
    tb.innerHTML = sorted
      .map(function (u) {
        var disp = rowForDisplay(u);
        var name = esc(displayUserLabel(disp));
        var mobile = esc(displayUserMobile(disp));
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
        var row = cachedUsers.find(function (x) {
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
        var user = cachedUsers.find(function (u) {
          return u.id === w.userId;
        }) || {};
        var ud = user.id ? rowForDisplay(user) : user;
        var mobile = user.id ? displayUserMobile(ud) : "";
        return (
          "<tr><td class=\"mono\">" +
          w.id.slice(0, 8) +
          "…</td><td class=\"mono\">" +
          (w.userId || "").slice(0, 8) +
          "…</td><td>" +
          mobile +
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
          scheduleAuthEnrich(rows);
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
