(function () {
  var selectedUid = null;
  var usersUnsub = null;
  var cachedUsers = [];
  var pendingDeleteUid = null;
  /** uid -> { adminDisplayName, adminDisplayMobile } from adminListUsersMerged */
  var serverDisplayByUid = {};
  var serverMergeTimer = null;
  var cachedDeposits = [];
  var liveDataTimer = null;
  /** After first poll, play sound when a new pending withdrawal id appears */
  var seenPendingWithdrawalIds = null;
  var adminLogLines = [];
  var livePollCount = 0;
  var lastPendingWithdrawalCount = 0;

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

  /** Firestore Timestamp or JSON `{ seconds|_seconds }` or ISO string from API */
  function tsToMillis(ts) {
    if (ts == null) return 0;
    if (typeof ts === "string") {
      var ps = Date.parse(ts);
      return isFinite(ps) ? ps : 0;
    }
    try {
      if (typeof ts.toMillis === "function") return Number(ts.toMillis()) || 0;
      if (typeof ts.toDate === "function") {
        var d = ts.toDate();
        return d && d.getTime ? d.getTime() : 0;
      }
      var sec = ts.seconds != null ? ts.seconds : ts._seconds;
      if (sec != null) {
        var nano = Number(ts.nanoseconds != null ? ts.nanoseconds : ts._nanoseconds) || 0;
        return Number(sec) * 1000 + nano / 1e6;
      }
      if (typeof ts === "number" && isFinite(ts)) return ts > 1e12 ? ts : ts * 1000;
      var iso = Date.parse(String(ts));
      return isFinite(iso) ? iso : 0;
    } catch (e) {
      return 0;
    }
  }

  function tsField(obj, baseKey) {
    if (!obj) return null;
    var v = obj[baseKey];
    if (tsToMillis(v) > 0) return v;
    var iso = obj[baseKey + "Iso"];
    if (iso) return iso;
    return v;
  }

  function fmtDateTimeFull(ts) {
    var ms = tsToMillis(ts);
    if (!(ms > 0)) return "—";
    try {
      return new Date(ms).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    } catch (e2) {
      return "—";
    }
  }

  function playWithdrawalAlertSound() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.setValueAtTime(660, ctx.currentTime + 0.12);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + 0.48);
    } catch (e) {}
  }

  function appendAdminLog(msg) {
    var line =
      new Date().toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      }) +
      " — " +
      String(msg || "");
    adminLogLines.unshift(line);
    if (adminLogLines.length > 250) adminLogLines.length = 250;
    var el = document.getElementById("admin-activity-log");
    if (el) el.textContent = adminLogLines.join("\n");
  }

  function clearAdminActivityLog() {
    adminLogLines = [];
    var el = document.getElementById("admin-activity-log");
    if (el) el.textContent = "";
  }

  function processNewPendingWithdrawals(rows) {
    var pendingIds = [];
    (rows || []).forEach(function (w) {
      if (String((w && w.status) || "").toLowerCase() === "pending" && w.id) pendingIds.push(String(w.id));
    });
    var nextSet = new Set(pendingIds);
    if (seenPendingWithdrawalIds === null) {
      seenPendingWithdrawalIds = nextSet;
      return;
    }
    var hasNew = false;
    pendingIds.forEach(function (id) {
      if (!seenPendingWithdrawalIds.has(id)) hasNew = true;
    });
    seenPendingWithdrawalIds = nextSet;
    if (hasNew) {
      playWithdrawalAlertSound();
      appendAdminLog("New PENDING withdrawal in queue (" + pendingIds.length + " total pending).");
      try {
        window.AvelonUI.toast("New withdrawal request — check queue");
      } catch (e) {}
    }
  }

  function renderWithdrawals(rows) {
    var tb = document.querySelector("#wd-table tbody");
    var sorted = (rows || []).slice().sort(function (a, b) {
      return tsToMillis(b.createdAt || b.updatedAt) - tsToMillis(a.createdAt || a.updatedAt);
    });
    tb.innerHTML = sorted
      .map(function (w) {
        var st = w.status || "";
        var user = cachedUsers.find(function (u) {
          return u.id === w.userId;
        }) || {};
        var mobile = user.id ? resolvedMobile(user) : "";
        var reqDt = esc(fmtDateTimeFull(w.createdAt || w.updatedAt));
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
          esc(st) +
          "</td><td class=\"mono\">" +
          reqDt +
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

  function depositActivityMillis(d) {
    if (!d) return 0;
    return (
      tsToMillis(tsField(d, "creditedAt")) ||
      tsToMillis(tsField(d, "updatedAt")) ||
      tsToMillis(tsField(d, "createdAt")) ||
      tsToMillis(d.paid_at) ||
      0
    );
  }

  function depositTimeCellHtml(d) {
    var primaryTs = tsField(d, "creditedAt") || tsField(d, "updatedAt") || tsField(d, "createdAt") || d.paid_at;
    var line1 = fmtDateTimeFull(primaryTs);
    var cMs = tsToMillis(tsField(d, "createdAt"));
    var pMs = tsToMillis(tsField(d, "creditedAt") || tsField(d, "updatedAt"));
    var extra = "";
    if (cMs > 0 && pMs > 0 && Math.abs(cMs - pMs) > 60000) {
      extra =
        '<div class="muted" style="font-size:0.72rem;margin-top:3px;line-height:1.35">Created: ' +
        esc(fmtDateTimeFull(tsField(d, "createdAt"))) +
        "</div>";
    }
    return '<div class="mono">' + esc(line1) + "</div>" + extra;
  }

  function renderDeposits(rows) {
    var tb = document.querySelector("#dep-table tbody");
    if (!tb) return;
    var sorted = (rows || []).slice().sort(function (a, b) {
      return depositActivityMillis(b) - depositActivityMillis(a);
    });
    tb.innerHTML = sorted
      .slice(0, 200)
      .map(function (d) {
        var uid = String(d.userId || "").trim();
        var u =
          cachedUsers.find(function (x) {
            return x.id === uid;
          }) || {};
        var name = esc(resolvedName(Object.assign({ id: uid }, u)));
        var mobile = esc(resolvedMobile(Object.assign({ id: uid }, u)));
        var amount = window.AvelonUI.money(Number(d.amountPhp || 0));
        var balance = window.AvelonUI.money(Number(u.balance || 0));
        var method = esc(String(d.paymentMethod || d.sourceType || d.method || d.provider || "paymongo"));
        var st = esc(String(d.status || "unknown"));
        return (
          "<tr><td>" +
          name +
          "</td><td>" +
          mobile +
          "</td><td>" +
          amount +
          "</td><td>" +
          balance +
          "</td><td>" +
          method +
          "</td><td>" +
          depositTimeCellHtml(d) +
          "</td><td>" +
          st +
          "</td></tr>"
        );
      })
      .join("");
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
        appendAdminLog((ok ? "Withdrawal APPROVED" : "Withdrawal REJECTED") + " · id " + String(id || "").slice(0, 12) + "…");
      })
      .catch(function () {
        window.AvelonUI.toast("Update failed");
        appendAdminLog("Withdrawal action FAILED · id " + String(id || "").slice(0, 12) + "…");
      });
  }

  function stopLiveDataLoop() {
    if (liveDataTimer) {
      clearTimeout(liveDataTimer);
      liveDataTimer = null;
    }
  }

  function fetchLiveData() {
    if (!window.AvelonApi) return Promise.resolve();
    return window.AvelonApi
      .call("adminLiveData", { usersLimit: 1000, depositsLimit: 300, withdrawalsLimit: 300 })
      .then(function (j) {
        livePollCount += 1;
        cachedUsers = (j && j.users) || [];
        cachedDeposits = (j && j.deposits) || [];
        var wds = (j && j.withdrawals) || [];
        processNewPendingWithdrawals(wds);
        renderUsers(cachedUsers);
        renderWithdrawals(wds);
        renderDeposits(cachedDeposits);
        scheduleServerMerge();
        lastPendingWithdrawalCount = wds.filter(function (w) {
          return String((w && w.status) || "").toLowerCase() === "pending";
        }).length;
        if (livePollCount === 1) {
          appendAdminLog(
            "Connected · " +
              cachedUsers.length +
              " users · " +
              cachedDeposits.length +
              " deposits · " +
              wds.length +
              " withdrawals in snapshot."
          );
        } else if (livePollCount % 15 === 0) {
          appendAdminLog("Live sync OK (poll " + livePollCount + ").");
        }
      })
      .catch(function (e) {
        var msg = (e && e.message) || "";
        if (msg) window.AvelonUI.toast("Live admin sync failed: " + msg);
        appendAdminLog("Live data ERROR: " + (msg || "unknown"));
      });
  }

  function startLiveDataLoop() {
    stopLiveDataLoop();
    function tick() {
      fetchLiveData()
        .catch(function () {})
        .then(function () {
          liveDataTimer = setTimeout(tick, lastPendingWithdrawalCount > 0 ? 3500 : 5000);
        });
    }
    tick();
  }

  document.addEventListener("DOMContentLoaded", function () {
    requireAdminProfile(function () {
      startLiveDataLoop();
      fetchMergedUsers();

      document.getElementById("reload-users").onclick = function () {
        Promise.all([fetchLiveData(), fetchMergedUsers()]).then(function () {
          window.AvelonUI.toast("Users refreshed (Firestore + Auth)");
          appendAdminLog("Manual reload (users + live data).");
        });
      };
      var clearLogBtn = document.getElementById("clear-admin-log");
      if (clearLogBtn) {
        clearLogBtn.onclick = function () {
          clearAdminActivityLog();
        };
      }
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
      var editRec = document.getElementById("edit-reconcile");
      if (editRec) {
        editRec.onclick = function () {
          if (!selectedUid) return;
          if (!window.AvelonApi) {
            window.AvelonUI.toast("Admin API unavailable");
            return;
          }
          editRec.disabled = true;
          window.AvelonApi
            .call("adminReconcileUserDeposits", { targetUid: selectedUid })
            .then(function (j) {
              var checked = Number((j && j.checked) || 0);
              var credited = Number((j && j.credited) || 0);
              window.AvelonUI.toast("Reconcile done · checked " + checked + " · credited " + credited);
            })
            .catch(function (e) {
              var detail = e && e.data && e.data.detail ? String(e.data.detail) : "";
              var msg = (e && e.message) || "Reconcile failed";
              if (detail) msg += ": " + detail;
              window.AvelonUI.toast(msg);
            })
            .then(function () {
              editRec.disabled = false;
            });
        };
      }
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
