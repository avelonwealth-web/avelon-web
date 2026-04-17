(function () {
  var unsub = [];
  var latestUser = null;
  var histFilter = "all";
  var sym = "BTC";
  var tf = "1";
  var cgTimer = null;
  var liveSocket = null;
  var liveReconnectTimer = null;
  var liveLastPrice = null;
  var livePointThrottleUntil = 0;
  var liveTickTimer = null;
  var livePoints = [];
  var LIVE_POINTS_MAX = 100;
  var boardSocket = null;
  var boardReconnectTimer = null;
  var boardMode = "change";
  var boardTickerMap = {};
  var boardSecBaseline = {};
  var boardSecPct = {};
  var boardPollTimer = null;
  var boardRenderScheduled = false;
  var BOARD_WATCH = [
    "TRXUSDT",
    "BTCUSDT",
    "ETHUSDT",
    "DOGEUSDT",
    "LTCUSDT",
    "XRPUSDT",
    "YFIUSDT",
    "BCHUSDT",
    "SHIBUSDT",
    "ADAUSDT",
    "LINKUSDT",
    "FILUSDT",
    "DOTUSDT",
    "DASHUSDT",
    "ZECUSDT"
  ];
  var BOARD_WATCH_SET = {};
  BOARD_WATCH.forEach(function (s) {
    BOARD_WATCH_SET[s] = 1;
  });
  var homeMiniSocket = null;
  var homeMiniReconnect = null;
  var homeMiniKlines = [];
  var homeMiniDrawPending = false;
  var homeMiniResizeTimer = null;
  var homeMiniResizeBound = false;
  var HOME_MINI_PAIR = "btcusdt";
  var homeMiniAggSocket = null;
  var homeMiniAggReconnect = null;
  var homeMiniSparkTimer = null;
  var homeMiniSpark = [];
  var HOME_MINI_SPARK_MAX = 90;
  var homeMiniTickPrice = 0;
  var homeMiniSparkLastPush = 0;
  var tabNavHooked = false;
  var referralSyncInFlight = false;
  var profileSyncFromAuthDone = false;
  var depositSyncTimer = null;
  var depositReconcilePulse = null;
  var commissionRowsByLevel = { 1: [], 2: [], 3: [] };
  var commissionSummaryTimer = null;
  var rewardsLoadInFlight = false;
  var rewardsModalHistoryPushed = false;
  var rewardsPopstateBound = false;
  var lastCommissionNotifyAt = 0;
  var depositWatchHooksBound = false;

  function qs(name) {
    try {
      var p = new URLSearchParams(window.location.search || "");
      return p.get(name);
    } catch (e) {
      return null;
    }
  }

  /** May deposit return flow — kung wala, huwag mag-poll ng API (nakaka-lag ng dashboard). */
  function hasPendingDepositContext() {
    if (String(qs("paid") || "").trim() === "1") return true;
    if (String(qs("depositId") || "").trim()) return true;
    try {
      var p = JSON.parse(localStorage.getItem("avelon_pending_deposit") || "null");
      if (p && p.depositId) return true;
    } catch (e) {}
    return false;
  }

  function playCommissionTone() {
    try {
      var now = Date.now();
      if (now - lastCommissionNotifyAt < 2500) return;
      lastCommissionNotifyAt = now;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var gain = ctx.createGain();
      gain.gain.value = 0.0001;
      gain.connect(ctx.destination);
      var osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 880;
      osc.connect(gain);
      osc.start();
      var t = ctx.currentTime;
      gain.gain.exponentialRampToValueAtTime(0.08, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.frequency.setValueAtTime(880, t + 0.01);
      osc.frequency.linearRampToValueAtTime(1320, t + 0.2);
      osc.stop(t + 0.3);
      setTimeout(function () {
        try {
          ctx.close();
        } catch (e) {}
      }, 450);
    } catch (e) {}
  }

  function mountVipCommissionNotifications(uid) {
    var seenKey = "avelon_seen_vip_commission_events";
    var legacyKey = "avelon_seen_commission_notifications";
    var seen = {};
    try {
      seen = JSON.parse(localStorage.getItem(seenKey) || "{}") || {};
    } catch (e) {}
    try {
      var leg = JSON.parse(localStorage.getItem(legacyKey) || "{}") || {};
      Object.keys(leg).forEach(function (k) {
        seen[k] = 1;
      });
    } catch (e2) {}

    function stableVipKey(row, docId, prefix) {
      var ref = String((row && row.referenceId) || "").trim();
      if (ref) return ref;
      return String(prefix || "v") + ":" + docId;
    }

    function announce(row, docId, prefix) {
      var key = stableVipKey(row, docId, prefix);
      if (seen[key]) return false;
      seen[key] = 1;
      var amt = Number(row.amount || 0);
      var msg = amt > 0 ? "VIP commission earned: " + window.AvelonUI.money(amt) : "VIP commission credited";
      window.AvelonUI.toast(msg);
      playCommissionTone();
      return true;
    }

    function persist() {
      try {
        localStorage.setItem(seenKey, JSON.stringify(seen));
      } catch (e) {}
    }

    var uref = firebase.firestore().collection("users").doc(uid);
    var unNotif = uref
      .collection("notifications")
      .where("kind", "==", "vip_daily_commission")
      .limit(25)
      .onSnapshot(function (q) {
        var c = false;
        q.forEach(function (d) {
          if (announce(d.data() || {}, d.id, "n")) c = true;
        });
        if (c) persist();
      });
    var unTx = uref
      .collection("transactions")
      .where("type", "==", "vip_daily_commission")
      .limit(25)
      .onSnapshot(function (q) {
        var c = false;
        q.forEach(function (d) {
          if (announce(d.data() || {}, d.id, "t")) c = true;
        });
        if (c) persist();
      });
    return function () {
      try {
        unNotif();
      } catch (e) {}
      try {
        unTx();
      } catch (e2) {}
    };
  }

  function redirectDeposit() {
    window.location.href = window.avPath ? window.avPath("deposit.html") : "deposit.html";
  }

  function genReferralCode(uid, salt) {
    var letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    var digits = "23456789";
    var all = letters + digits;
    var out = "";
    var seed = String(uid || "") + "\0" + String(salt != null ? salt : 0);
    var h = 0;
    for (var j = 0; j < seed.length; j++) h = (h * 33 + seed.charCodeAt(j)) | 0;
    for (var i = 0; i < 8; i++) {
      h = (h * 1103515245 + 12345) | 0;
      var idx = Math.abs(h) % all.length;
      out += all.charAt(idx);
    }
    out = letters.charAt(Math.abs(h) % letters.length) + letters.charAt(Math.abs(h >> 3) % letters.length) + out.slice(2);
    out = out.slice(0, 6);
    if (!/[A-Z]/.test(out)) out = "A" + out.slice(1);
    if (!/[0-9]/.test(out)) out = out.slice(0, 5) + digits.charAt(Math.abs(h >> 5) % digits.length);
    return out;
  }

  function makeUniqueReferralCode(db, uid, attempt) {
    attempt = attempt || 0;
    var candidate = genReferralCode(uid, attempt);
    return db
      .collection("referralLookup")
      .doc(candidate)
      .get()
      .then(function (snap) {
        if (!snap.exists) return candidate;
        return makeUniqueReferralCode(db, uid, attempt + 1);
      });
  }

  function ensureReferralIdentity(uid, userData) {
    if (!uid || !userData || userData.role === "admin") return;
    var currentCode = String(userData.referralCode || "").trim().toUpperCase();
    var validFormat = /^[A-Z0-9]{6}$/.test(currentCode) && /[A-Z]/.test(currentCode) && /[0-9]/.test(currentCode);
    if (validFormat) return;
    if (referralSyncInFlight) return;
    referralSyncInFlight = true;
    var db = firebase.firestore();
    makeUniqueReferralCode(db, uid)
      .then(function (code) {
        var batch = db.batch();
        batch.set(db.collection("users").doc(uid), { referralCode: code }, { merge: true });
        batch.set(
          db.collection("referralLookup").doc(code),
          {
            uid: uid,
            seed: "backfill-profile",
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return batch.commit();
      })
      .then(function () {})
      .catch(function () {})
      .then(function () {
        referralSyncInFlight = false;
      });
  }

  function liveSymbolPair() {
    return sym === "BTC" ? "btcusdt" : sym === "ETH" ? "ethusdt" : "bnbusdt";
  }

  function pushLivePointThrottled(price) {
    if (!(price > 0)) return;
    var now = Date.now();
    if (now < livePointThrottleUntil) return;
    livePointThrottleUntil = now + 220;
    livePoints.push(price);
    if (livePoints.length > LIVE_POINTS_MAX) livePoints.shift();
    renderLiveLine();
  }

  function updateLivePanel(data) {
    var symbolEl = document.getElementById("live-symbol");
    var priceEl = document.getElementById("live-price");
    var changeEl = document.getElementById("live-change");
    var updatedEl = document.getElementById("live-updated");
    if (!symbolEl || !priceEl || !changeEl || !updatedEl) return;

    var pair = liveSymbolPair().toUpperCase();
    var price = Number(data.c || data.p || 0);
    var open = Number(data.o || 0);
    var pct = open > 0 ? ((price - open) / open) * 100 : 0;

    symbolEl.textContent = pair;
    priceEl.textContent = price > 0 ? price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "--";
    changeEl.textContent = isFinite(pct) ? (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%" : "--";
    changeEl.classList.toggle("tick-up", pct >= 0);
    changeEl.classList.toggle("tick-down", pct < 0);
    if (liveLastPrice !== null && priceEl) {
      priceEl.classList.toggle("tick-up", price >= liveLastPrice);
      priceEl.classList.toggle("tick-down", price < liveLastPrice);
    }
    liveLastPrice = price;
    updatedEl.textContent = new Date().toLocaleTimeString();
    pushLivePointThrottled(price);
  }

  function renderLiveLine() {
    var line = document.getElementById("live-line");
    if (!line) return;
    if (!livePoints.length) {
      line.setAttribute("points", "");
      return;
    }
    var min = Math.min.apply(null, livePoints);
    var max = Math.max.apply(null, livePoints);
    var span = max - min || 1;
    var points = livePoints
      .map(function (p, i) {
        var x = (i / Math.max(1, LIVE_POINTS_MAX - 1)) * 100;
        var y = 28 - ((p - min) / span) * 26;
        return x.toFixed(2) + "," + y.toFixed(2);
      })
      .join(" ");
    line.setAttribute("points", points);
  }

  function startLiveTickChart() {
    if (liveTickTimer) clearInterval(liveTickTimer);
    liveTickTimer = setInterval(function () {
      if (!(liveLastPrice > 0)) return;
      pushLivePointThrottled(liveLastPrice);
    }, 8000);
  }

  function stopLiveFeed() {
    if (liveReconnectTimer) {
      clearTimeout(liveReconnectTimer);
      liveReconnectTimer = null;
    }
    if (liveSocket) {
      try {
        liveSocket.onclose = null;
        liveSocket.close();
      } catch (e) {}
      liveSocket = null;
    }
    if (liveTickTimer) {
      clearInterval(liveTickTimer);
      liveTickTimer = null;
    }
    if (boardReconnectTimer) {
      clearTimeout(boardReconnectTimer);
      boardReconnectTimer = null;
    }
    if (boardSocket) {
      try {
        boardSocket.onclose = null;
        boardSocket.close();
      } catch (e) {}
      boardSocket = null;
    }
    if (boardPollTimer) {
      clearInterval(boardPollTimer);
      boardPollTimer = null;
    }
    stopHomeMiniChart();
  }

  function startLiveFeed() {
    stopLiveFeed();
    livePoints = [];
    renderLiveLine();
    startLiveTickChart();
    var pair = liveSymbolPair();
    try {
      liveSocket = new WebSocket("wss://stream.binance.com:9443/ws/" + pair + "@ticker");
      liveSocket.onmessage = function (evt) {
        try {
          var data = JSON.parse(evt.data || "{}");
          updateLivePanel(data);
        } catch (e) {}
      };
      liveSocket.onclose = function () {
        liveReconnectTimer = setTimeout(startLiveFeed, 1200);
      };
      liveSocket.onerror = function () {
        try {
          liveSocket.close();
        } catch (e) {}
      };
    } catch (e) {}
    startBoardFeed();
    startHomeMiniChart();
  }

  function normalizeTickerRow(o) {
    if (!o) return null;
    var s = String(o.s != null ? o.s : o.symbol || "");
    if (!BOARD_WATCH_SET[s]) return null;
    return {
      s: s,
      c: Number(o.c != null ? o.c : o.lastPrice || 0),
      P: Number(o.P != null ? o.P : o.priceChangePercent || 0),
      q: Number(o.q != null ? o.q : o.quoteVolume || 0)
    };
  }

  function mergeTickerStreamItem(raw) {
    var row = normalizeTickerRow(raw);
    if (!row) return false;
    var now = Date.now();
    var prev = boardSecBaseline[row.s];
    if (prev && prev.p > 0 && now - prev.t >= 900) {
      boardSecPct[row.s] = ((row.c - prev.p) / prev.p) * 100;
      boardSecBaseline[row.s] = { p: row.c, t: now };
    } else if (!prev) {
      boardSecBaseline[row.s] = { p: row.c, t: now };
      boardSecPct[row.s] = 0;
    }
    boardTickerMap[row.s] = row;
    return true;
  }

  function scheduleRenderBoard() {
    if (boardRenderScheduled) return;
    boardRenderScheduled = true;
    requestAnimationFrame(function () {
      boardRenderScheduled = false;
      renderBoardFeed();
    });
  }

  function refreshBoardFromRest() {
    var encoded = encodeURIComponent(JSON.stringify(BOARD_WATCH));
    fetch("https://api.binance.com/api/v3/ticker/24hr?symbols=" + encoded)
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (!Array.isArray(data)) return;
        for (var i = 0; i < data.length; i++) {
          var row = normalizeTickerRow(data[i]);
          if (row) boardTickerMap[row.s] = row;
        }
        scheduleRenderBoard();
      })
      .catch(function () {});
  }

  function rankBoard(rows) {
    if (boardMode === "losers") {
      return rows.slice().sort(function (a, b) {
        return Number(a.P || 0) - Number(b.P || 0);
      });
    }
    if (boardMode === "turnover") {
      return rows.slice().sort(function (a, b) {
        return Number(b.q || 0) - Number(a.q || 0);
      });
    }
    return rows.slice().sort(function (a, b) {
      return Math.abs(Number(b.P || 0)) - Math.abs(Number(a.P || 0));
    });
  }

  function formatBoardPrice(p) {
    if (!(p > 0) || !isFinite(p)) return "--";
    if (p >= 1000) {
      return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (p >= 1) {
      return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
    }
    if (p >= 0.0001) {
      return p.toLocaleString(undefined, { maximumFractionDigits: 8 });
    }
    return p.toPrecision(4);
  }

  function coinAccentStyle(sym) {
    var s = String(sym || "XX");
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    var hue = Math.abs(h) % 360;
    return (
      "background:linear-gradient(145deg,hsl(" +
      hue +
      ",52%,40%),hsl(" +
      hue +
      ",46%,22%))"
    );
  }

  function renderBoardFeed() {
    var el = document.getElementById("live-feed-list");
    if (!el) return;
    var pool = BOARD_WATCH.map(function (sym) {
      return boardTickerMap[sym];
    }).filter(Boolean);
    var rows = rankBoard(pool).slice(0, 15);
    if (!rows.length) {
      el.innerHTML =
        '<div class="live-feed-empty muted">Syncing live prices from Binance…</div>';
      return;
    }
    el.innerHTML = rows
      .map(function (r) {
        var sym2 = String(r.s || "").replace("USDT", "");
        var initials = sym2.length <= 2 ? sym2.toUpperCase() : sym2.slice(0, 2).toUpperCase();
        var price = Number(r.c || 0);
        var sec = Number(boardSecPct[r.s] || 0);
        var chg = Number(r.P || 0);
        var up = chg >= 0;
        var secUp = sec >= 0;
        var secText = (sec >= 0 ? "+" : "-") + Math.abs(sec).toFixed(6) + "%";
        return (
          '<div class="live-feed-row ' +
          (up ? "live-feed-row--up" : "live-feed-row--down") +
          '"><div class="live-feed-pair"><div class="live-feed-coin" style="' +
          coinAccentStyle(sym2) +
          '">' +
          esc(initials) +
          '</div><div class="live-feed-pair-names"><span class="live-feed-base">' +
          esc(sym2) +
          '</span><span class="live-feed-quote"> / USDT</span></div></div><div class="live-feed-price">' +
          formatBoardPrice(price) +
          '</div><div class="live-feed-sec ' +
          (secUp ? "tick-up" : "tick-down") +
          '">' + secText +
          '</div><div class="live-feed-badge ' +
          (up ? "tick-up" : "tick-down") +
          '">' +
          (up ? "+" : "") +
          chg.toFixed(2) +
          "%</div></div>"
        );
      })
      .join("");
  }

  function startBoardFeed() {
    if (boardReconnectTimer) {
      clearTimeout(boardReconnectTimer);
      boardReconnectTimer = null;
    }
    if (boardPollTimer) {
      clearInterval(boardPollTimer);
      boardPollTimer = null;
    }
    if (boardSocket) {
      try {
        boardSocket.onclose = null;
        boardSocket.close();
      } catch (e) {}
      boardSocket = null;
    }
    refreshBoardFromRest();
    boardPollTimer = setInterval(refreshBoardFromRest, 4000);
    try {
      boardSocket = new WebSocket("wss://stream.binance.com:9443/stream?streams=!ticker@arr");
      boardSocket.onmessage = function (evt) {
        try {
          var raw = JSON.parse(evt.data || "{}");
          var arr = Array.isArray(raw) ? raw : raw && Array.isArray(raw.data) ? raw.data : null;
          var touched = false;
          if (arr && arr.length) {
            for (var i = 0; i < arr.length; i++) {
              if (mergeTickerStreamItem(arr[i])) touched = true;
            }
            if (touched) scheduleRenderBoard();
            return;
          }
          if (raw && raw.data && typeof raw.data === "object" && mergeTickerStreamItem(raw.data)) {
            scheduleRenderBoard();
          }
        } catch (e) {}
      };
      boardSocket.onopen = function () {
        refreshBoardFromRest();
      };
      boardSocket.onclose = function () {
        boardReconnectTimer = setTimeout(startBoardFeed, 1500);
      };
      boardSocket.onerror = function () {
        try {
          boardSocket.close();
        } catch (e) {}
      };
    } catch (e) {}
  }

  function parseRestKlineRow(row) {
    return {
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4])
    };
  }

  function mergeHomeMiniKline(k) {
    if (!k) return;
    var t = Number(k.t);
    var row = {
      t: t,
      o: Number(k.o),
      h: Number(k.h),
      l: Number(k.l),
      c: Number(k.c)
    };
    var idx = -1;
    for (var j = 0; j < homeMiniKlines.length; j++) {
      if (homeMiniKlines[j].t === t) {
        idx = j;
        break;
      }
    }
    if (idx >= 0) homeMiniKlines[idx] = row;
    else {
      homeMiniKlines.push(row);
      homeMiniKlines.sort(function (a, b) {
        return a.t - b.t;
      });
      while (homeMiniKlines.length > 48) homeMiniKlines.shift();
    }
    var lastEl = document.getElementById("home-mini-last");
    if (lastEl && row.c > 0) {
      lastEl.textContent = row.c.toLocaleString(undefined, { maximumFractionDigits: 2 });
      lastEl.classList.toggle("tick-up", row.c >= row.o);
      lastEl.classList.toggle("tick-down", row.c < row.o);
    }
    homeMiniTickPrice = Number(row.c) || homeMiniTickPrice;
    scheduleHomeMiniDraw();
  }

  function scheduleHomeMiniDraw() {
    if (homeMiniDrawPending) return;
    homeMiniDrawPending = true;
    requestAnimationFrame(function () {
      homeMiniDrawPending = false;
      drawHomeMiniChart();
    });
  }

  function drawHomeMiniChart() {
    var canvas = document.getElementById("home-mini-chart");
    if (!canvas) return;
    var closes =
      homeMiniSpark.length >= 2
        ? homeMiniSpark.slice()
        : homeMiniKlines.length
          ? homeMiniKlines.map(function (x) {
              return x.c;
            })
          : [];
    if (!closes.length) return;
    var wrap = canvas.parentElement;
    if (!wrap) return;
    var rect = wrap.getBoundingClientRect();
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var cssW = Math.max(100, Math.floor(rect.width));
    var cssH = Math.max(72, Math.floor(rect.height));
    var w = Math.floor(cssW * dpr);
    var h = Math.floor(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    var min = Math.min.apply(null, closes);
    var max = Math.max.apply(null, closes);
    var pad = (max - min) * 0.1 || max * 0.0002 || 1;
    min -= pad;
    max += pad;
    var span = max - min || 1;
    var n = closes.length;
    var lastClose = closes[n - 1];
    var firstClose = closes[0];
    var up = lastClose >= firstClose;
    var stroke = up ? "rgba(61, 255, 154, 0.95)" : "rgba(255, 92, 122, 0.95)";
    function xAt(i) {
      return n <= 1 ? cssW * 0.5 : (i / (n - 1)) * (cssW - 6) + 3;
    }
    function yAt(price) {
      return cssH - 4 - ((price - min) / span) * (cssH - 8);
    }
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var px = xAt(i);
      var py = yAt(closes[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  function stopHomeMiniAgg() {
    if (homeMiniAggReconnect) {
      clearTimeout(homeMiniAggReconnect);
      homeMiniAggReconnect = null;
    }
    if (homeMiniAggSocket) {
      try {
        homeMiniAggSocket.onclose = null;
        homeMiniAggSocket.close();
      } catch (e) {}
      homeMiniAggSocket = null;
    }
    if (homeMiniSparkTimer) {
      clearInterval(homeMiniSparkTimer);
      homeMiniSparkTimer = null;
    }
  }

  function connectHomeMiniAggTrade() {
    try {
      homeMiniAggSocket = new WebSocket("wss://stream.binance.com:9443/ws/" + HOME_MINI_PAIR + "@aggTrade");
      homeMiniAggSocket.onmessage = function (evt) {
        try {
          var j = JSON.parse(evt.data || "{}");
          var p = Number(j.p || 0);
          if (p > 0) {
            homeMiniTickPrice = p;
            var lastEl = document.getElementById("home-mini-last");
            if (lastEl) {
              lastEl.textContent = p.toLocaleString(undefined, { maximumFractionDigits: 2 });
            }
            var now = Date.now();
            if (now - homeMiniSparkLastPush >= 280) {
              homeMiniSparkLastPush = now;
              homeMiniSpark.push(p);
              if (homeMiniSpark.length > HOME_MINI_SPARK_MAX) homeMiniSpark.shift();
              scheduleHomeMiniDraw();
            }
          }
        } catch (e) {}
      };
      homeMiniAggSocket.onclose = function () {
        homeMiniAggReconnect = setTimeout(connectHomeMiniAggTrade, 1800);
      };
      homeMiniAggSocket.onerror = function () {
        try {
          homeMiniAggSocket.close();
        } catch (e) {}
      };
    } catch (e) {}
  }

  function startHomeMiniSparkSampler() {
    if (homeMiniSparkTimer) clearInterval(homeMiniSparkTimer);
    homeMiniSparkTimer = setInterval(function () {
      var px = homeMiniTickPrice > 0 ? homeMiniTickPrice : 0;
      if (!(px > 0) && homeMiniKlines.length) {
        px = Number(homeMiniKlines[homeMiniKlines.length - 1].c) || 0;
      }
      if (!(px > 0)) return;
      homeMiniSpark.push(px);
      if (homeMiniSpark.length > HOME_MINI_SPARK_MAX) homeMiniSpark.shift();
      scheduleHomeMiniDraw();
    }, 12000);
  }

  function stopHomeMiniChart() {
    if (homeMiniReconnect) {
      clearTimeout(homeMiniReconnect);
      homeMiniReconnect = null;
    }
    if (homeMiniSocket) {
      try {
        homeMiniSocket.onclose = null;
        homeMiniSocket.close();
      } catch (e) {}
      homeMiniSocket = null;
    }
    stopHomeMiniAgg();
  }

  function connectHomeMiniKline() {
    try {
      homeMiniSocket = new WebSocket(
        "wss://stream.binance.com:9443/ws/" + HOME_MINI_PAIR + "@kline_1m"
      );
      homeMiniSocket.onmessage = function (evt) {
        try {
          var j = JSON.parse(evt.data || "{}");
          if (j && j.k) mergeHomeMiniKline(j.k);
        } catch (e) {}
      };
      homeMiniSocket.onclose = function () {
        homeMiniReconnect = setTimeout(connectHomeMiniKline, 1800);
      };
      homeMiniSocket.onerror = function () {
        try {
          homeMiniSocket.close();
        } catch (e) {}
      };
    } catch (e) {}
  }

  function startHomeMiniChart() {
    stopHomeMiniChart();
    homeMiniKlines = [];
    homeMiniSpark = [];
    homeMiniTickPrice = 0;
    if (!homeMiniResizeBound) {
      homeMiniResizeBound = true;
      window.addEventListener("resize", function () {
        if (homeMiniResizeTimer) clearTimeout(homeMiniResizeTimer);
        homeMiniResizeTimer = setTimeout(scheduleHomeMiniDraw, 140);
      });
    }
    var url =
      "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=36";
    fetch(url)
      .then(function (r) {
        return r.json();
      })
      .then(function (rows) {
        if (!Array.isArray(rows)) return;
        homeMiniKlines = rows.map(parseRestKlineRow);
        if (homeMiniKlines.length) {
          var lc = homeMiniKlines[homeMiniKlines.length - 1];
          homeMiniTickPrice = Number(lc.c) || 0;
          homeMiniSpark = homeMiniKlines.map(function (x) {
            return x.c;
          });
          var lastEl = document.getElementById("home-mini-last");
          if (lastEl && lc.c > 0) {
            lastEl.textContent = lc.c.toLocaleString(undefined, { maximumFractionDigits: 2 });
            lastEl.classList.toggle("tick-up", lc.c >= lc.o);
            lastEl.classList.toggle("tick-down", lc.c < lc.o);
          }
        }
        scheduleHomeMiniDraw();
        connectHomeMiniKline();
        connectHomeMiniAggTrade();
        startHomeMiniSparkSampler();
      })
      .catch(function () {
        connectHomeMiniKline();
        connectHomeMiniAggTrade();
        startHomeMiniSparkSampler();
      });
  }

  function clearUnsub() {
    unsub.forEach(function (fn) {
      try {
        fn();
      } catch (e) {}
    });
    unsub = [];
  }

  function coinGeckoId(s) {
    if (s === "BTC") return "bitcoin";
    if (s === "ETH") return "ethereum";
    return "binancecoin";
  }

  function userVipPurchased(u) {
    if (!u) return false;
    if (u.role === "admin") return true;
    if (u.vipPurchased === true) return true;
    if (u.vipPurchased === false) return false;
    return Number(u.vipLevel || 0) >= 1;
  }

  function effectiveVipLevel(u) {
    if (!u) return 0;
    if (u.role === "admin") return Math.max(1, Number(u.vipLevel || 1));
    if (!userVipPurchased(u)) return 0;
    return Math.max(1, Number(u.vipLevel || 1));
  }

  function renderVipTable() {
    var el = document.getElementById("vip-table");
    if (!el) return;
    var currentEff = effectiveVipLevel(latestUser);
    var purchased = userVipPurchased(latestUser);
    var vipLine = document.getElementById("vip-current-line");
    if (vipLine) {
      vipLine.textContent = purchased
        ? "Active VIP tier: " + currentEff + "."
        : "No current VIP — add a deposit, then purchase a tier below.";
    }
    var rows = (window.AVELON_VIP || []).map(function (v) {
      var isCurrent = purchased && v.level === currentEff;
      var isOwnedLower = purchased && v.level < currentEff;
      var isOwned = isCurrent || isOwnedLower;
      var btnClass = isCurrent ? "btn danger" : "btn secondary";
      var label = isCurrent ? "ACTIVE · VIP " + v.level : isOwnedLower ? "OWNED · VIP " + v.level : "BUY VIP " + v.level;
      return (
        '<div class="list"><li><div class="row"><div><div style="font-weight:950">VIP ' +
        v.level +
        '</div><div class="muted">Deposit ' +
        window.AvelonUI.money(v.deposit) +
        "</div></div><div style=\"text-align:right\"><div class=\"muted\">Daily Income</div><div style=\"font-weight:900\">" +
        window.AvelonUI.money(v.daily) +
        "</div></div></div><div class=\"muted\" style=\"margin-top:6px\">Total 180 Days " +
        window.AvelonUI.money(v.total180) +
        " · rate " +
        v.rate +
        '%</div><div class="row" style="margin-top:10px"><button class="' +
        btnClass +
        '" type="button" ' +
        (isOwned ? "disabled " : "") +
        'data-buy-vip="' +
        v.level +
        '" style="width:100%">' +
        label +
        "</button></div></li></div>"
      );
    });
    el.innerHTML = rows.join("");
    el.querySelectorAll("[data-buy-vip]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!window.AvelonApi) return window.AvelonUI.toast("VIP backend unavailable");
        if (Number((latestUser && latestUser.totalDeposits) || 0) <= 0) {
          window.AvelonUI.toast("Deposit required — opening deposit page");
          redirectDeposit();
          return;
        }
        var level = Number(b.getAttribute("data-buy-vip") || "0");
        var prevLabel = b.textContent;
        b.disabled = true;
        b.textContent = "PROCESSING...";
        window.AvelonApi
          .call("buyVip", { vipLevel: level })
          .then(function () {
            window.AvelonUI.toast("VIP " + level + " activated");
          })
          .catch(function (e) {
            b.disabled = false;
            b.textContent = prevLabel;
            var msg = (e && e.message) || "VIP purchase failed";
            if (msg === "deposit_required") {
              window.AvelonUI.toast("Deposit required — opening deposit page");
              redirectDeposit();
              return;
            }
            if (msg === "insufficient_balance") {
              window.AvelonUI.toast("Insufficient balance — opening deposit page");
              redirectDeposit();
              return;
            }
            if (msg === "vip_already_owned") msg = "You already own this VIP level or higher";
            window.AvelonUI.toast(msg);
          });
      });
    });
  }

  function setGlow(level) {
    var px = window.AvelonVip.glowForLevel(level);
    var card = document.getElementById("vip-glow-card");
    if (!card) return;
    card.style.boxShadow = "0 0 " + px + "px rgba(30,144,255,0.22), 0 18px 60px rgba(0,0,0,0.45)";
  }

  function renderUser(u, uid) {
    latestUser = u;
    if (!u) return;
    if (u.role === "admin" && window.AvelonAuth && window.AvelonAuth.ensureAdminProfile) {
      var want = String(window.AvelonAuth.ADMIN_REFERRAL_CODE || "").trim().toUpperCase();
      var have = String(u.referralCode || "").trim().toUpperCase();
      if (want && have !== want) {
        try {
          var au = firebase.auth().currentUser;
          var syn = window.AvelonPhoneAuth && window.AvelonPhoneAuth.syntheticEmailForCanonicalAdmin();
          window.AvelonAuth.ensureAdminProfile(uid || window.AvelonAuth.currentUid(), (au && au.email) || syn).catch(
            function () {}
          );
        } catch (e) {}
      }
    }
    ensureReferralIdentity(uid || window.AvelonAuth.currentUid(), u);
    var bal = Number(u.balance || 0);
    document.getElementById("bal-main").textContent = window.AvelonUI.money(bal);
    document.getElementById("bal-assets").textContent = window.AvelonUI.money(bal);
    document.getElementById("modal-bal").textContent = window.AvelonUI.money(bal);
    var displayName = String(u.displayName || "").trim();
    var userName = String(u.userName || "").trim();
    var shownUsername = userName || displayName;
    var displayMobile = window.AvelonPhoneAuth ? window.AvelonPhoneAuth.displayFromUser(u) : u.mobileNumber || u.email || "";
    if (!displayName) displayName = displayMobile || "User";
    if (!shownUsername) shownUsername = displayName;
    document.getElementById("prof-name").textContent = shownUsername;
    var mobEl = document.getElementById("prof-mobile");
    if (mobEl) mobEl.textContent = displayMobile;
    var topName = document.getElementById("profile-top-name");
    var topMobile = document.getElementById("profile-top-mobile");
    if (topName) topName.textContent = shownUsername;
    if (topMobile) topMobile.textContent = displayMobile;
    var effVip = effectiveVipLevel(u);
    var vipLabelText = userVipPurchased(u) ? "VIP " + effVip : "No VIP";
    document.getElementById("vip-label").textContent = vipLabelText;
    document.getElementById("modal-vip").textContent = vipLabelText;
    document.getElementById("prof-vip").textContent = vipLabelText;
    var principal = Number(u.depositPrincipal || 0);
    var bonusLocked = userVipPurchased(u) ? 0 : Math.max(0, Number(u.signupBonusLocked || 0));
    var withdrawEst = Math.max(0, bal - principal - bonusLocked);
    var depEl = document.getElementById("prof-stat-deposits");
    var earEl = document.getElementById("prof-stat-earnings");
    var wBal = document.getElementById("prof-stat-balance");
    var wWd = document.getElementById("prof-stat-withdraw");
    if (wBal) wBal.textContent = window.AvelonUI.money(bal);
    if (depEl) depEl.textContent = window.AvelonUI.money(u.totalDeposits || 0);
    var inviteEarnings = Number(u.commissionEarnings || 0);
    var tradeAndOtherEarnings = Number(u.totalEarnings || 0);
    var creditedEarnings = Math.max(0, inviteEarnings + tradeAndOtherEarnings);
    if (earEl) earEl.textContent = window.AvelonUI.money(creditedEarnings);
    if (wWd) wWd.textContent = window.AvelonUI.money(withdrawEst);
    document.getElementById("prof-code").textContent = u.referralCode || "—";
    document.getElementById("modal-code").textContent = u.referralCode || "—";
    var link = window.AvelonUI.referralLinkFromCode(u.referralCode || "");
    document.getElementById("prof-link").value = link;
    var totalEarningsEl = document.getElementById("total-earnings");
    if (totalEarningsEl) totalEarningsEl.textContent = window.AvelonUI.money(creditedEarnings);
    var isAdmin = u.role === "admin";
    var dl =
      typeof window.__AVELON_DL === "number" ? window.__AVELON_DL : Number(u.downlineCount || 0);
    var c1 = document.getElementById("commission-l1-count");
    if (c1) {
      c1.textContent =
        "Direct (L1) downlines: " + dl + " · commission totals below are credited from your genealogy (L1/L2/L3).";
    }
    var dlLine = "Downlines: " + window.AvelonUI.maskDownline(dl, isAdmin);
    document.getElementById("downline-line").textContent = dlLine;
    var assetsDl = document.getElementById("assets-downline-line");
    if (assetsDl) assetsDl.textContent = dlLine;
    var vipRow = (window.AVELON_VIP || []).find(function (x) {
      return x.level === effVip;
    });
    var dailyIncomeEl = document.getElementById("daily-income");
    if (dailyIncomeEl) dailyIncomeEl.textContent = window.AvelonUI.money(userVipPurchased(u) && vipRow ? vipRow.daily : 0);
    var vipDailyCreditedEl = document.getElementById("vip-daily-credited");
    var vipDailyLineEl = document.getElementById("vip-daily-line");
    var vipDailyTotal = Number(u.vipDailyEarningsTotal || 0);
    if (vipDailyCreditedEl) {
      vipDailyCreditedEl.textContent = window.AvelonUI.money(vipDailyTotal);
    }
    if (vipDailyLineEl) {
      vipDailyLineEl.textContent =
        "VIP commission (credited" +
        (userVipPurchased(u) && vipRow ? " · tier " + window.AvelonUI.money(vipRow.daily) + "/day" : "") +
        ")";
    }
    setGlow(userVipPurchased(u) ? effVip : 0);
    document.getElementById("open-admin").hidden = !isAdmin;
    renderVipTable();

    var holdings = document.getElementById("holdings");
    var simBtc = (bal / 4000000).toFixed(6);
    holdings.innerHTML =
      '<li><div class="row"><div>BTC</div><div class="mono">' +
      simBtc +
      '</div></div><div class="muted" style="margin-top:6px">Live market view</div></li>' +
      '<li><div class="row"><div>ETH</div><div class="mono">' +
      (bal / 160000).toFixed(4) +
      "</div></div></li>";

    document.getElementById("bal-sync").textContent = "LIVE · " + new Date().toLocaleTimeString();
  }

  // VIP upgrades are backend-controlled in production.
  function maybeAutoVip(uid, u) {
    return;
  }

  function renderHist(rows) {
    var ul = document.getElementById("hist-list");
    if (!ul) return;
    var f = histFilter;
    var items = rows.filter(function (r) {
      if (f === "all") return true;
      if (f === "trades") return r.source === "trades" || r.type === "trade";
      if (f === "deposits") return String(r.type || "").indexOf("deposit") >= 0;
      if (f === "withdrawals") return String(r.type || "").indexOf("withdraw") >= 0 || r.kind === "withdrawal";
      if (f === "referrals")
        return (
          String(r.type || "").indexOf("referral") >= 0 ||
          r.type === "vip_daily_commission" ||
          r.kind === "vip_commission" ||
          r.kind === "vip_daily_commission"
        );
      return true;
    });
    ul.innerHTML = items
      .slice(0, 80)
      .map(function (x) {
        var t = x.type || x.kind || x.source || "event";
        var tText = String(t);
        if (tText === "rewards") tText = "REWARDS";
        else if (tText === "admin_add_deposit" || tText === "admin_add_earning") tText = "REWARDS";
        else if (tText === "admin_deduct") tText = "withdrawal";
        else if (tText === "signup_bonus") tText = "rewards";
        else if (tText === "admin_adjust") tText = "REWARDS";
        else if (tText.indexOf("referral_commission_l") === 0) {
          var level = tText.split("_l")[1] || "";
          tText = "rewards (commission L" + level + ")";
        } else if (tText.indexOf("referral_commission") >= 0) tText = "rewards";
        else if (tText === "vip_daily_commission" || tText === "vip_commission") tText = "VIP daily commission";
        var rawAmt = typeof x.amount === "number" ? x.amount : Number(x.amount || 0);
        var amt = isFinite(rawAmt) && rawAmt !== 0 ? window.AvelonUI.money(rawAmt) : "";
        var ts = x.timestamp && x.timestamp.toDate ? x.timestamp.toDate().toLocaleString() : "";
        return (
          '<li><div class="row"><div style="font-weight:900">' +
          tText +
          '</div><div class="mono">' +
          amt +
          '</div></div><div class="muted" style="margin-top:6px">' +
          (x.message || x.note || x.status || "") +
          " · " +
          ts +
          "</div></li>"
        );
      })
      .join("");
  }

  function maskedFromMeta(meta) {
    var m = String((meta && meta.fromMasked) || "").trim();
    if (m) return m;
    var uid = String((meta && meta.fromUid) || "").trim();
    if (!uid) return "***";
    return "Member · " + uid.replace(/[^A-Za-z0-9]/g, "").slice(-6);
  }

  function openCommissionLevelModal(level, rows) {
    var modal = document.getElementById("commission-level-modal");
    var title = document.getElementById("commission-level-title");
    var subtitle = document.getElementById("commission-level-subtitle");
    var list = document.getElementById("commission-level-list");
    if (!modal || !title || !subtitle || !list) return;
    var cleanLevel = Number(level || 0);
    var cleanRows = Array.isArray(rows) ? rows.slice() : [];
    title.textContent = "Level " + cleanLevel + " downlines";
    subtitle.textContent =
      "Masked member · joined/deposit time · latest deposit amount (" + cleanRows.length + " item" + (cleanRows.length === 1 ? "" : "s") + ")";
    if (!cleanRows.length) {
      list.innerHTML = '<li class="muted">No deposit records yet.</li>';
      modal.classList.remove("hidden");
      return;
    }
    list.innerHTML = cleanRows
      .map(function (r) {
        var ts = r.timestamp && r.timestamp.toDate ? r.timestamp.toDate().toLocaleString() : "";
        var dep = Number(r.depositAmount || 0);
        return (
          '<li><div class="row"><div style="font-weight:900">' +
          esc(r.masked || "***") +
          '</div><div class="mono">' +
          (dep > 0 ? window.AvelonUI.money(dep) : "No deposit yet") +
          '</div></div><div class="muted commission-detail-line">' +
          esc(ts || "—") +
          "</div></li>"
        );
      })
      .join("");
    modal.classList.remove("hidden");
  }

  function mountCommissionSummary(uid) {
    var host = document.getElementById("commission-cards");
    if (!host) return function () {};
    var db = firebase.firestore();
    var txRef = db.collection("users").doc(uid).collection("transactions").orderBy("timestamp", "desc").limit(800);
    var latestSums = { l1: 0, l2: 0, l3: 0 };
    var latestCounts = { l1: 0, l2: 0, l3: 0 };
    function paint() {
      var tiers = [
        { level: 1, rate: "10%", sum: latestSums.l1, hint: "Direct referrals", count: latestCounts.l1 || 0 },
        { level: 2, rate: "4%", sum: latestSums.l2, hint: "2nd generation", count: latestCounts.l2 || 0 },
        { level: 3, rate: "1%", sum: latestSums.l3, hint: "3rd generation", count: latestCounts.l3 || 0 },
      ];
      host.innerHTML =
        '<div class="commission-grid">' +
        tiers
          .map(function (x) {
            return (
              '<div class="commission-card" data-level="' +
              x.level +
              '"><div class="muted">Level ' +
              x.level +
              '</div><div class="rate-pct">' +
              x.rate +
              '</div><div class="muted" style="font-size:0.76rem">' +
              x.hint +
              " · " +
              x.count +
              " downline" +
              (x.count === 1 ? "" : "s") +
              '</div><div class="mono" style="margin-top:8px;font-weight:900;font-size:1.02rem">' +
              window.AvelonUI.money(x.sum) +
              "</div></div>"
            );
          })
          .join("") +
        "</div>";
      host.querySelectorAll("[data-level]").forEach(function (node) {
        node.addEventListener("click", function () {
          var lvl = Number(node.getAttribute("data-level") || "0");
          openCommissionLevelModal(lvl, commissionRowsByLevel[lvl] || []);
        });
      });
    }
    var unTx = txRef.onSnapshot(
      function (q) {
        var sums = { l1: 0, l2: 0, l3: 0 };
        q.forEach(function (d) {
          var row = d.data() || {};
          var t = String(row.type || "");
          var a = Number(row.amount || 0);
          if (t === "referral_commission_l1") {
            sums.l1 += a;
          } else if (t === "referral_commission_l2") {
            sums.l2 += a;
          } else if (t === "referral_commission_l3") {
            sums.l3 += a;
          }
        });
        latestSums = sums;
        paint();
      },
      function () {
        latestSums = { l1: 0, l2: 0, l3: 0 };
        paint();
      }
    );
    var downlineRef = db.collection("users").doc(uid).collection("downlineDeposits").orderBy("timestamp", "desc").limit(2000);
    var unDownline = downlineRef.onSnapshot(
      function (q) {
        var byLevelUid = { 1: {}, 2: {}, 3: {} };
        q.forEach(function (d) {
          var row = d.data() || {};
          var lvl = Number(row.level || 1);
          if (!(lvl >= 1 && lvl <= 3)) lvl = 1;
          var fromUid = String(row.fromUid || "").trim();
          if (!fromUid) return;
          var bucket = byLevelUid[lvl];
          if (!bucket[fromUid]) {
            bucket[fromUid] = {
              fromUid: fromUid,
              masked: maskedFromMeta({ fromUid: row.fromUid, fromMasked: row.fromMasked }),
              timestamp: row.timestamp || null,
              depositAmount: 0,
            };
          }
          bucket[fromUid].depositAmount = Number(bucket[fromUid].depositAmount || 0) + Number(row.depositAmount || 0);
        });
        var rowsBy = { 1: [], 2: [], 3: [] };
        [1, 2, 3].forEach(function (lvl) {
          rowsBy[lvl] = Object.keys(byLevelUid[lvl]).map(function (k) {
            return byLevelUid[lvl][k];
          });
        });
        commissionRowsByLevel = rowsBy;
        latestCounts = { l1: rowsBy[1].length, l2: rowsBy[2].length, l3: rowsBy[3].length };
        paint();
      },
      function () {}
    );
    return function () {
      try {
        unTx();
      } catch (e) {}
      try {
        unDownline();
      } catch (e) {}
    };
  }

  function renderRewardsModal(data) {
    var j = data || {};
    var head = document.getElementById("rewards-headline");
    var list = document.getElementById("rewards-list");
    var foot = document.getElementById("rewards-footnote");
    if (!head || !list || !foot) return;
    var directDepositedCount = Number(j.directDepositedCount || 0);
    var milestones = Array.isArray(j.milestones) ? j.milestones : [];
    var reached = milestones.filter(function (m) {
      return !!m.reached;
    });
    if (!reached.length) {
      head.textContent =
        "Direct referrals with deposit: " + directDepositedCount + ". Kailangan mag invite to earn big rewards.";
    } else {
      head.textContent =
        "Direct referrals with deposit: " +
        directDepositedCount +
        ". May qualified reward tier ka na.";
    }
    if (!milestones.length) {
      list.innerHTML = '<li class="muted">No reward tiers configured yet.</li>';
    } else {
      list.innerHTML = milestones
        .map(function (m) {
          var t = Number(m.target || 0);
          var amount = m.amount != null && Number(m.amount || 0) > 0 ? window.AvelonUI.money(Number(m.amount || 0)) : "From AVELON";
          return (
            "<li><div class='row'><div style='font-weight:900'>" +
            t +
            " direct referrals (deposited)</div><div class='mono'>" +
            (m.reached ? "QUALIFIED" : "LOCKED") +
            "</div></div><div class='muted' style='margin-top:6px'>Reward: " +
            amount +
            "</div></li>"
          );
        })
        .join("");
    }
    foot.textContent =
      "Reward release amount and posting are depends on invitee's deposit amount.";
  }

  function openRewardsModal() {
    var modal = document.getElementById("rewards-modal");
    if (!modal || !window.AvelonApi || rewardsLoadInFlight) return;
    if (!modal.classList.contains("hidden")) return;
    rewardsLoadInFlight = true;
    modal.classList.remove("hidden");
    try {
      history.pushState({ avelonRewardsModal: 1 }, "", window.location.href);
      rewardsModalHistoryPushed = true;
    } catch (eHist) {
      rewardsModalHistoryPushed = false;
    }
    var head = document.getElementById("rewards-headline");
    var list = document.getElementById("rewards-list");
    if (head) head.textContent = "Loading rewards...";
    if (list) list.innerHTML = "";
    window.AvelonApi
      .call("rewardsEligibility", {})
      .then(function (j) {
        renderRewardsModal(j || {});
      })
      .catch(function (e) {
        if (head) head.textContent = "Reward status unavailable right now.";
        if (list) list.innerHTML = '<li class="muted">Try again in a moment.</li>';
        window.AvelonUI.toast((e && e.message) || "Rewards load failed");
      })
      .then(function () {
        rewardsLoadInFlight = false;
      });
  }

  function mountHistory(uid) {
    var r1 = [];
    var r2 = [];
    var r3 = [];
    function renderMerged() {
      var merged = [];
      r1.forEach(function (r) {
        merged.push(Object.assign({}, r, { source: "transactions" }));
      });
      r2.forEach(function (r) {
        merged.push(Object.assign({}, r, { source: "trades" }));
      });
      r3.forEach(function (r) {
        merged.push(Object.assign({}, r, { source: "history" }));
      });
      merged.sort(function (a, b) {
        var ta = a.timestamp && a.timestamp.toMillis ? a.timestamp.toMillis() : 0;
        var tb = b.timestamp && b.timestamp.toMillis ? b.timestamp.toMillis() : 0;
        return tb - ta;
      });
      window.__AVELON_HIST__ = merged;
      renderHist(merged);
    }
    unsub.push(
      window.AvelonDb.listenUserSub(uid, "transactions", function (rows) {
        r1 = rows;
        renderMerged();
      })
    );
    unsub.push(
      window.AvelonDb.listenUserSub(uid, "trades", function (rows) {
        r2 = rows;
        renderMerged();
      })
    );
    unsub.push(
      window.AvelonDb.listenUserSub(uid, "history", function (rows) {
        r3 = rows;
        renderMerged();
      })
    );
  }

  function mountTape(uid) {
    var box = document.getElementById("trade-feed");
    if (!box) return function () {};
    return window.AvelonDb.listenUserSub(uid, "trades", function (rows) {
      box.innerHTML = rows
        .slice(0, 12)
        .map(function (t) {
          var ts = t.timestamp && t.timestamp.toDate ? t.timestamp.toDate().toLocaleTimeString() : "";
          return (
            '<div class="item"><div><div style="font-weight:900">' +
            (t.side || "TRADE") +
            '</div><div class="muted">' +
            (t.symbol || "") +
            " · " +
            ts +
            '</div></div><div class="mono">' +
            (typeof t.pnl === "number" ? window.AvelonUI.money(t.pnl) : "") +
            "</div></div>"
          );
        })
        .join("");
    });
  }

  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c;
    });
  }

  function mountChat() {
    var box = document.getElementById("chat-box");
    if (!box) return function () {};
    return window.AvelonDb.listenChat(function (rows) {
      box.innerHTML = rows
        .map(function (m) {
          var ts = m.timestamp && m.timestamp.toDate ? m.timestamp.toDate().toLocaleTimeString() : "";
          return (
            '<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)"><div class="row"><div style="font-weight:900">' +
            esc(m.displayName || "Member") +
            '</div><div class="muted mono">' +
            esc(ts) +
            '</div></div><div style="margin-top:6px">' +
            esc(m.text || "") +
            "</div></div>"
          );
        })
        .join("");
    });
  }

  function rebuildTv() {
    var host = document.getElementById("tv-wrap");
    if (!host) return;
    var symTv =
      sym === "BTC" ? "BINANCE:BTCUSDT" : sym === "ETH" ? "BINANCE:ETHUSDT" : "BINANCE:BNBUSDT";
    var src =
      "https://www.tradingview.com/widgetembed/?frameElementId=avelon_tv&symbol=" +
      encodeURIComponent(symTv) +
      "&interval=" +
      encodeURIComponent(tf) +
      "&hidesidetoolbar=1&hidetoptoolbar=1&symboledit=0&saveimage=0&hideideas=1&theme=dark&style=1&locale=en";
    host.innerHTML =
      '<iframe title="TradingView" style="width:100%;height:100%;border:0" src="' + src + '"></iframe>';
  }

  function ensureTvScript(cb) {
    cb();
  }

  function startCgPoll() {
    startLiveFeed();
  }

  function fetchCg() {
    return;
  }

  function tradeDurationMs(vipLevel) {
    var base = 3200 - Math.min(15, Math.max(1, vipLevel)) * 120;
    if (window.AvelonUI.shouldReduceEffects()) base = 1200;
    return Math.max(900, base);
  }

  function runTrade(side) {
    var uid = window.AvelonAuth.currentUid();
    if (!uid || !latestUser) return;
    var stake = Number(document.getElementById("trade-stake").value || "0");
    if (!(stake > 0)) {
      window.AvelonUI.toast("Enter stake");
      return;
    }
    if (Number(latestUser.balance || 0) < stake) {
      window.AvelonUI.toast("Insufficient balance");
      return;
    }
    if (!window.AvelonApi) {
      window.AvelonUI.toast("Trade backend unavailable");
      return;
    }
    document.getElementById("trade-status").textContent = "LIVE · placing…";
    window.AvelonApi
      .call("tradeCreateRound", { side: side, stake: stake, symbol: sym })
      .then(function (j) {
        var didWin = !!(j && j.win);
        var pnl = Number((j && j.pnl) || 0);
        document.getElementById("trade-status").textContent =
          "LIVE · " +
          (didWin ? "WIN" : "LOSS") +
          (isFinite(pnl) ? " · " + window.AvelonUI.money(pnl) : "");
      })
      .catch(function (e) {
        document.getElementById("trade-status").textContent = "LIVE";
        var code = (e && e.message) || "Trade failed";
        if (code === "insufficient_balance") code = "Insufficient balance for this stake";
        if (code === "bad_token" || code === "missing_auth") code = "Session expired — sign in again";
        if (code === "no_profile") code = "Account profile missing — contact support";
        if (code === "request_failed") code = "Network or server error — try again";
        window.AvelonUI.toast(code);
      });
  }

  function finalizeTrade(uid, side, stake, pnl, symbol, win) {
    return;
  }

  function requestWithdraw() {
    var uid = window.AvelonAuth.currentUid();
    if (!uid || !latestUser) return;
    var amt = Number(document.getElementById("wd-amount").value || "0");
    if (!(amt > 0)) {
      window.AvelonUI.toast("Enter amount");
      return;
    }
    if (amt < 500) {
      window.AvelonUI.toast("Minimum withdrawal is ₱500");
      return;
    }
    if (!(latestUser && latestUser.vipPurchased === true)) {
      window.AvelonUI.toast("Withdrawal requires first VIP purchase");
      return;
    }
    if (Number(latestUser.balance || 0) < amt) {
      window.AvelonUI.toast("Insufficient balance");
      return;
    }
    if (!window.AvelonApi) {
      window.AvelonUI.toast("Withdrawal backend unavailable");
      return;
    }
    var method = (document.getElementById("wd-method") && document.getElementById("wd-method").value) || "gcash";
    var accountName = (document.getElementById("wd-name") && document.getElementById("wd-name").value) || "";
    var accountNumber = (document.getElementById("wd-number") && document.getElementById("wd-number").value) || "";
    if (!accountName || !accountNumber) {
      window.AvelonUI.toast("Enter payout details");
      return;
    }
    window.AvelonApi
      .call("requestWithdrawal", {
        amount: amt,
        method: method,
        accountName: accountName,
        accountNumber: accountNumber,
      })
      .then(function () {
        window.AvelonUI.toast("Withdrawal queued");
      })
      .catch(function (e) {
        var code = (e && e.message) || "Withdrawal failed";
        if (code === "min_withdraw_500") code = "Minimum withdrawal is ₱500";
        else if (code === "min_withdraw_500_for_commissions")
          code = "Invite or VIP commission earnings require a minimum ₱500 withdrawal";
        else if (code === "vip4_required_for_trade_withdraw")
          code = "Trading earnings need VIP 4 or higher to withdraw";
        else if (code === "vip_purchase_required") code = "Withdrawal requires first VIP purchase";
        else if (code === "vip_required_for_signup_bonus") code = "Signup bonus unlocks after first VIP purchase";
        else if (code === "deposit_required") code = "Withdrawals unlock after first deposit";
        else if (code === "insufficient_withdrawable") code = "Insufficient withdrawable balance";
        else if (code === "withdraw_failed") code = ((e && e.data && e.data.detail) || "Withdrawal failed") + "";
        window.AvelonUI.toast(code);
      });
  }

  function sendChat() {
    var uid = window.AvelonAuth.currentUid();
    var chatMsgEl = document.getElementById("chat-msg");
    if (!chatMsgEl) return;
    var txt = chatMsgEl.value.trim();
    if (!uid || !txt) return;
    firebase
      .firestore()
      .collection("globalCryptoChat")
      .add({
        uid: uid,
        text: txt,
        displayName: (latestUser && latestUser.displayName) || "Member",
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      })
      .then(function () {
        chatMsgEl.value = "";
      })
      .catch(function () {
        window.AvelonUI.toast("Chat send failed");
      });
  }

  function createCheckout() {
    var uid = window.AvelonAuth.currentUid();
    var amt = Number(document.getElementById("dep-amount").value || "0");
    var out = document.getElementById("dep-out");
    if (!(amt >= 1)) {
      out.textContent = "Minimum deposit is ₱1";
      return;
    }
    out.textContent = "Creating…";
    if (!window.AvelonApi) {
      out.textContent = "Deposit backend unavailable";
      return;
    }
    window.AvelonApi
      .call("createCheckout", {
        amount: amt,
        mobile: (latestUser && (latestUser.mobileNumber || "")) || "",
        email: (latestUser && latestUser.email) || "",
      })
      .then(function (j) {
        try {
          localStorage.setItem(
            "avelon_pending_deposit",
            JSON.stringify({
              depositId: j && j.depositId ? String(j.depositId) : "",
              startedAt: Date.now(),
            })
          );
        } catch (e) {}
        if (j.checkoutUrl) {
          out.textContent = "Redirecting to Deposit Page...";
          window.location.href = j.checkoutUrl;
        } else {
          out.textContent = "Deposit Page created";
        }
      })
      .catch(function (e) {
        var msg = (e && e.message) || "Checkout unavailable";
        if (msg === "min_deposit_1") msg = "Minimum deposit is ₱1";
        out.textContent = msg;
      });
  }

  function refreshUserFromServer(uid) {
    if (!uid || !window.AvelonDb) return;
    try {
      window.AvelonDb
        .userDoc(uid)
        .get()
        .then(function (snap) {
          if (snap && snap.exists) renderUser(snap.data() || {}, uid);
        })
        .catch(function () {});
    } catch (e) {}
  }

  function mountPendingDepositRealtime(uid) {
    var depositId = String(qs("depositId") || "").trim();
    if (!depositId) {
      try {
        var pending = JSON.parse(localStorage.getItem("avelon_pending_deposit") || "null");
        if (pending && pending.depositId) depositId = String(pending.depositId).trim();
      } catch (e) {}
    }
    if (!depositId || !uid) return function () {};
    var announced = false;
    return window.AvelonDb.listenDeposit(depositId, function (data) {
      if (!data) return;
      var st = String(data.status || "").toLowerCase();
      var credited = data.credited === true;
      if (st !== "paid" && !credited) return;
      refreshUserFromServer(uid);
      if (!announced) {
        announced = true;
        try {
          localStorage.removeItem("avelon_pending_deposit");
          var url = new URL(window.location.href);
          url.searchParams.delete("paid");
          url.searchParams.delete("depositId");
          window.history.replaceState({}, "", url.toString());
        } catch (e2) {}
        if (window.AvelonUI && window.AvelonUI.toast) {
          window.AvelonUI.toast("Deposit credited — wallet synced");
        }
      }
    });
  }

  function startDepositSyncWatch() {
    if (!window.AvelonApi) return;
    if (!hasPendingDepositContext()) {
      if (depositSyncTimer) clearInterval(depositSyncTimer);
      depositSyncTimer = null;
      return;
    }
    var paid = String(qs("paid") || "").trim();
    var pending = null;
    try {
      pending = JSON.parse(localStorage.getItem("avelon_pending_deposit") || "null");
    } catch (e) {}
    var urlDepositId = String(qs("depositId") || "").trim();
    var depositId = urlDepositId || (pending && pending.depositId ? String(pending.depositId) : "");
    // Always run watcher on dashboard: if no explicit depositId, backend reconciles latest pending deposit.
    var body = depositId ? { depositId: depositId } : {};
    var tries = 0;
    var maxTries = paid === "1" || depositId ? 600 : 120;
    var intervalMs = paid === "1" || depositId ? 2500 : 5000;
    if (depositSyncTimer) clearInterval(depositSyncTimer);
    depositSyncTimer = setInterval(function () {
      tries += 1;
      window.AvelonApi
        .call("depositSyncStatus", body)
        .then(function (j) {
          var st = String((j && j.status) || "").toLowerCase();
          if (st === "paid") {
            if (depositSyncTimer) clearInterval(depositSyncTimer);
            depositSyncTimer = null;
            refreshUserFromServer(window.AvelonAuth && window.AvelonAuth.currentUid ? window.AvelonAuth.currentUid() : "");
            try {
              localStorage.removeItem("avelon_pending_deposit");
              var url = new URL(window.location.href);
              url.searchParams.delete("paid");
              window.history.replaceState({}, "", url.toString());
            } catch (e) {}
          }
        })
        .catch(function () {});
      if (tries >= maxTries) {
        if (depositSyncTimer) clearInterval(depositSyncTimer);
        depositSyncTimer = null;
      }
    }, intervalMs);
  }

  function startDepositReconcilePulse() {
    if (!window.AvelonApi) return;
    var hasPending = false;
    try {
      var p0 = JSON.parse(localStorage.getItem("avelon_pending_deposit") || "null");
      hasPending = !!(p0 && p0.depositId);
    } catch (e0) {}
    if (!hasPending) {
      if (depositReconcilePulse) clearInterval(depositReconcilePulse);
      depositReconcilePulse = null;
      return;
    }
    if (depositReconcilePulse) clearInterval(depositReconcilePulse);
    depositReconcilePulse = setInterval(function () {
      var body = {};
      try {
        var pending = JSON.parse(localStorage.getItem("avelon_pending_deposit") || "null");
        if (pending && pending.depositId) body.depositId = String(pending.depositId);
      } catch (e) {}
      if (!body.depositId) {
        if (depositReconcilePulse) clearInterval(depositReconcilePulse);
        depositReconcilePulse = null;
        return;
      }
      window.AvelonApi
        .call("depositSyncStatus", body)
        .then(function (j) {
          var st = String((j && j.status) || "").toLowerCase();
          if (st === "paid") {
            try {
              localStorage.removeItem("avelon_pending_deposit");
            } catch (e) {}
            refreshUserFromServer(
              window.AvelonAuth && window.AvelonAuth.currentUid ? window.AvelonAuth.currentUid() : ""
            );
          }
        })
        .catch(function () {});
    }, 15000);
  }

  function wireUi(uid) {
    function go(p) {
      window.location.href = window.avPath ? window.avPath(p) : p;
    }
    var supTg = document.getElementById("support-telegram");
    if (supTg && typeof window.AVELON_TELEGRAM === "string" && window.AVELON_TELEGRAM.trim()) {
      supTg.href = window.AVELON_TELEGRAM.trim();
    }
    document.getElementById("bal-refresh").onclick = document.getElementById("bal-refresh-2").onclick = function () {
      if (latestUser) renderUser(latestUser);
    };
    document.getElementById("open-deposit").onclick = function () {
      document.getElementById("deposit-modal").classList.remove("hidden");
    };
    document.getElementById("deposit-close").onclick = function () {
      document.getElementById("deposit-modal").classList.add("hidden");
    };
    document.getElementById("dep-go").onclick = createCheckout;

    document.getElementById("profile-hit").onclick = function () {
      document.getElementById("profile-modal").classList.remove("hidden");
    };
    document.getElementById("profile-close").onclick = function () {
      document.getElementById("profile-modal").classList.add("hidden");
    };
    var rewardsOpenBtn = document.getElementById("open-rewards-modal");
    var rewardsCloseBtn = document.getElementById("rewards-close");
    var rewardsModal = document.getElementById("rewards-modal");
    if (rewardsOpenBtn) {
      rewardsOpenBtn.onclick = openRewardsModal;
    }
    if (rewardsCloseBtn && rewardsModal) {
      rewardsCloseBtn.onclick = function () {
        rewardsModal.classList.add("hidden");
        if (rewardsModalHistoryPushed) {
          rewardsModalHistoryPushed = false;
          try {
            history.back();
          } catch (eBack) {}
        }
      };
    }
    var commissionClose = document.getElementById("commission-level-close");
    if (commissionClose) {
      commissionClose.onclick = function () {
        document.getElementById("commission-level-modal").classList.add("hidden");
      };
    }
    document.getElementById("modal-logout").onclick = document.getElementById("logout").onclick = function () {
      window.AvelonAuth.signOut().then(function () {
        window.location.href = window.avPath ? window.avPath("login.html") : "login.html";
      });
    };

    document.getElementById("copy-code").onclick = function () {
      window.AvelonUI.copyText((latestUser && latestUser.referralCode) || "");
    };
    document.getElementById("copy-link").onclick = function () {
      window.AvelonUI.copyText(document.getElementById("prof-link").value);
    };
    document.getElementById("share-friends").onclick = function () {
      window.AvelonUI.copyText(document.getElementById("prof-link").value);
    };
    document.getElementById("open-admin").onclick = function () {
      window.location.href = window.avPath ? window.avPath("admin.html") : "admin.html";
    };
    var openDepositPage = document.getElementById("open-deposit-page");
    var openWithdrawPage = document.getElementById("open-withdraw-page");
    var openDepositHistoryPage = document.getElementById("open-deposit-history-page");
    var openWithdrawHistoryPage = document.getElementById("open-withdraw-history-page");
    var openDownlinesPage = document.getElementById("open-downlines-page");
    var openTransactionsPage = document.getElementById("open-transactions-page");
    if (openDepositPage) openDepositPage.onclick = function () { go("deposit.html"); };
    if (openWithdrawPage) openWithdrawPage.onclick = function () { go("withdraw.html"); };
    if (openDepositHistoryPage) openDepositHistoryPage.onclick = function () { go("deposit-history.html"); };
    if (openWithdrawHistoryPage) openWithdrawHistoryPage.onclick = function () { go("withdraw-history.html"); };
    if (openDownlinesPage) openDownlinesPage.onclick = function () { go("downlines.html"); };
    if (openTransactionsPage) openTransactionsPage.onclick = function () { go("transactions.html"); };
    document.querySelectorAll("#live-feed-tabs [data-board-mode]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll("#live-feed-tabs [data-board-mode]").forEach(function (x) {
          x.classList.remove("is-on");
        });
        btn.classList.add("is-on");
        boardMode = btn.getAttribute("data-board-mode") || "change";
        renderBoardFeed();
      });
    });

    document.querySelectorAll("#hist-filter .chip").forEach(function (c) {
      c.addEventListener("click", function () {
        document.querySelectorAll("#hist-filter .chip").forEach(function (x) {
          x.classList.remove("is-on");
        });
        c.classList.add("is-on");
        histFilter = c.getAttribute("data-f");
        renderHist(window.__AVELON_HIST__ || []);
      });
    });

    document.getElementById("wd-submit").onclick = requestWithdraw;
    var chatSendBtn = document.getElementById("chat-send");
    if (chatSendBtn) chatSendBtn.onclick = sendChat;

    document.querySelectorAll("#sym-chips .chip").forEach(function (c) {
      c.addEventListener("click", function () {
        document.querySelectorAll("#sym-chips .chip").forEach(function (x) {
          x.classList.remove("is-on");
        });
        c.classList.add("is-on");
        sym = c.getAttribute("data-sym");
        liveLastPrice = null;
        livePoints = [];
        renderLiveLine();
        ensureTvScript(function () {
          rebuildTv();
        });
        fetchCg();
      });
    });
    document.querySelectorAll("#tf-chips .chip").forEach(function (c) {
      c.addEventListener("click", function () {
        document.querySelectorAll("#tf-chips .chip").forEach(function (x) {
          x.classList.remove("is-on");
        });
        c.classList.add("is-on");
        tf = c.getAttribute("data-tf");
        ensureTvScript(function () {
          rebuildTv();
        });
      });
    });

    document.getElementById("btn-call").onclick = function () {
      runTrade("CALL");
    };
    document.getElementById("btn-put").onclick = function () {
      runTrade("PUT");
    };

    unsub.push(
      window.AvelonDb.listenUser(uid, function (data) {
        renderUser(data, uid);
        maybeAutoVip(uid, data);
      })
    );
    unsub.push(mountPendingDepositRealtime(uid));
    unsub.push(
      firebase
        .firestore()
        .collection("users")
        .doc(uid)
        .collection("downlines")
        .onSnapshot(function (q) {
          window.__AVELON_DL = q.docs.length;
          if (latestUser) renderUser(latestUser);
        })
    );
    unsub.push(mountTape(uid));
    unsub.push(mountCommissionSummary(uid));
    unsub.push(mountVipCommissionNotifications(uid));
    mountHistory(uid);
    unsub.push(mountChat());

    ensureTvScript(function () {
      rebuildTv();
    });
    startCgPoll();
  }

  function installUi() {
    var banner = document.getElementById("install-banner");
    var deferred = null;
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferred = e;
      banner.classList.add("is-visible");
    });
    document.getElementById("install-dismiss").onclick = function () {
      banner.classList.remove("is-visible");
    };
    document.getElementById("install-go").onclick = async function () {
      if (!deferred) {
        window.AvelonUI.toast("Install prompt not available");
        return;
      }
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      banner.classList.remove("is-visible");
    };
  }

  document.addEventListener("DOMContentLoaded", function () {
    window.AvelonAuth.init();
    renderVipTable();
    installUi();

    if (!rewardsPopstateBound) {
      rewardsPopstateBound = true;
      window.addEventListener("popstate", function () {
        var rm = document.getElementById("rewards-modal");
        if (!rm || rm.classList.contains("hidden")) return;
        rm.classList.add("hidden");
        rewardsModalHistoryPushed = false;
        if (window.switchTab) window.switchTab("home");
      });
    }

    if (!tabNavHooked) {
      tabNavHooked = true;
      window.addEventListener("avelon-tab", function (ev) {
        var p = ev.detail && ev.detail.page;
        if (p === "home") refreshBoardFromRest();
        if (p === "markets") {
          ensureTvScript(function () {
            rebuildTv();
          });
        }
      });
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(function () {});
    }

    window.AvelonAuth.onAuth(function (user) {
      clearUnsub();
      if (!user) {
        profileSyncFromAuthDone = false;
        window.location.href = window.avPath ? window.avPath("login.html") : "login.html";
        return;
      }
      if (!profileSyncFromAuthDone && window.AvelonApi) {
        profileSyncFromAuthDone = true;
        var runSync = function () {
          window.AvelonApi.call("syncProfileFromAuth", {}).catch(function () {});
        };
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(runSync, { timeout: 2500 });
        } else {
          setTimeout(runSync, 1);
        }
      }
      window.restoreTab("home");
      wireUi(user.uid);
      startDepositSyncWatch();
      startDepositReconcilePulse();
      if (!depositWatchHooksBound) {
        depositWatchHooksBound = true;
        window.addEventListener("focus", startDepositSyncWatch);
        window.addEventListener("online", startDepositSyncWatch);
      }

      window.AvelonUI.onceOnboard("hint_tabs");
    });
  });
})();
