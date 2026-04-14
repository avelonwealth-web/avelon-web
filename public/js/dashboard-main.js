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
  var tabNavHooked = false;

  function liveSymbolPair() {
    return sym === "BTC" ? "btcusdt" : sym === "ETH" ? "ethusdt" : "bnbusdt";
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
      livePoints.push(liveLastPrice);
      if (livePoints.length > LIVE_POINTS_MAX) livePoints.shift();
      renderLiveLine();
    }, 1000);
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
          '">' +
          (secUp ? "+" : "") +
          sec.toFixed(2) +
          "%" +
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
    boardPollTimer = setInterval(refreshBoardFromRest, 1000);
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
    }, 1000);
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

  function renderVipTable() {
    var el = document.getElementById("vip-table");
    if (!el) return;
    var currentVip = Number((latestUser && latestUser.vipLevel) || 1);
    var rows = (window.AVELON_VIP || []).map(function (v) {
      var isOwned = v.level <= currentVip;
      var label = v.level === currentVip ? "CURRENT VIP " + v.level : isOwned ? "OWNED VIP " + v.level : "BUY VIP " + v.level;
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
        '%</div><div class="row" style="margin-top:10px"><button class="btn secondary" type="button" ' +
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
        var level = Number(b.getAttribute("data-buy-vip") || "0");
        b.disabled = true;
        b.textContent = "PROCESSING...";
        window.AvelonApi
          .call("buyVip", { vipLevel: level })
          .then(function () {
            window.AvelonUI.toast("VIP " + level + " activated");
          })
          .catch(function (e) {
            b.disabled = false;
            b.textContent = "BUY VIP " + level;
            window.AvelonUI.toast((e && e.message) || "VIP purchase failed");
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

  function renderUser(u) {
    latestUser = u;
    if (!u) return;
    var bal = Number(u.balance || 0);
    document.getElementById("bal-main").textContent = window.AvelonUI.money(bal);
    document.getElementById("bal-assets").textContent = window.AvelonUI.money(bal);
    document.getElementById("modal-bal").textContent = window.AvelonUI.money(bal);
    document.getElementById("prof-name").textContent = u.displayName || "Member";
    var mobEl = document.getElementById("prof-mobile");
    if (mobEl) mobEl.textContent = window.AvelonPhoneAuth ? window.AvelonPhoneAuth.displayFromUser(u) : u.mobileNumber || u.email || "";
    var lvl = Number(u.vipLevel || 1);
    document.getElementById("vip-label").textContent = "VIP " + lvl;
    document.getElementById("modal-vip").textContent = "VIP " + lvl;
    document.getElementById("prof-vip").textContent = "VIP " + lvl;
    document.getElementById("prof-code").textContent = u.referralCode || "—";
    document.getElementById("modal-code").textContent = u.referralCode || "—";
    var link = window.AvelonUI.referralLinkFromCode(u.referralCode || "");
    document.getElementById("prof-link").value = link;
    var totalEarningsEl = document.getElementById("total-earnings");
    if (totalEarningsEl) totalEarningsEl.textContent = window.AvelonUI.money(u.totalEarnings || 0);
    var isAdmin = u.role === "admin";
    var dl =
      typeof window.__AVELON_DL === "number" ? window.__AVELON_DL : Number(u.downlineCount || 0);
    document.getElementById("downline-line").textContent =
      "Downlines: " + window.AvelonUI.maskDownline(dl, isAdmin);
    var vipRow = (window.AVELON_VIP || []).find(function (x) {
      return x.level === lvl;
    });
    var dailyIncomeEl = document.getElementById("daily-income");
    if (dailyIncomeEl) dailyIncomeEl.textContent = window.AvelonUI.money(vipRow ? vipRow.daily : 0);
    setGlow(lvl);
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
      if (f === "referrals") return String(r.type || "").indexOf("referral") >= 0;
      return true;
    });
    ul.innerHTML = items
      .slice(0, 80)
      .map(function (x) {
        var t = x.type || x.kind || x.source || "event";
        var amt = typeof x.amount === "number" ? window.AvelonUI.money(x.amount) : "";
        var ts = x.timestamp && x.timestamp.toDate ? x.timestamp.toDate().toLocaleString() : "";
        return (
          '<li><div class="row"><div style="font-weight:900">' +
          String(t) +
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
      .then(function () {
        document.getElementById("trade-status").textContent = "LIVE · round recorded";
        window.AvelonUI.toast(side + " · trade synced");
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
    if (Number(latestUser.totalDeposits || 0) <= 0) {
      window.AvelonUI.toast("Withdrawals unlock after first deposit");
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
        window.AvelonUI.toast((e && e.message) || "Withdrawal failed");
      });
  }

  function sendChat() {
    var uid = window.AvelonAuth.currentUid();
    var txt = document.getElementById("chat-msg").value.trim();
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
        document.getElementById("chat-msg").value = "";
      })
      .catch(function () {
        window.AvelonUI.toast("Chat send failed");
      });
  }

  function createCheckout() {
    var uid = window.AvelonAuth.currentUid();
    var amt = Number(document.getElementById("dep-amount").value || "0");
    var out = document.getElementById("dep-out");
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
        if (j.checkoutUrl) {
          out.innerHTML = 'Open checkout: <a href="' + j.checkoutUrl + '">' + j.checkoutUrl + "</a>";
        } else {
          out.textContent = "Checkout created";
        }
      })
      .catch(function (e) {
        out.textContent = (e && e.message) || "Checkout unavailable";
      });
  }

  function wireUi(uid) {
    function go(p) {
      window.location.href = window.avPath ? window.avPath(p) : p;
    }
    document.getElementById("bal-refresh").onclick = document.getElementById("bal-refresh-2").onclick = function () {
      if (latestUser) renderUser(latestUser);
      window.AvelonUI.toast("Balance re-synced");
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
    document.getElementById("share-native").onclick = async function () {
      var link = document.getElementById("prof-link").value;
      try {
        if (navigator.share) {
          await navigator.share({ title: "AVELON", text: "Join me on AVELON", url: link });
        } else {
          await window.AvelonUI.copyText(link);
        }
      } catch (e) {}
    };
    document.getElementById("open-admin").onclick = function () {
      window.location.href = window.avPath ? window.avPath("admin.html") : "admin.html";
    };
    var openDepositPage = document.getElementById("open-deposit-page");
    var openWithdrawPage = document.getElementById("open-withdraw-page");
    var openDepositHistoryPage = document.getElementById("open-deposit-history-page");
    var openWithdrawHistoryPage = document.getElementById("open-withdraw-history-page");
    var openTransactionsPage = document.getElementById("open-transactions-page");
    var openLogsPage = document.getElementById("open-logs-page");
    if (openDepositPage) openDepositPage.onclick = function () { go("deposit.html"); };
    if (openWithdrawPage) openWithdrawPage.onclick = function () { go("withdraw.html"); };
    if (openDepositHistoryPage) openDepositHistoryPage.onclick = function () { go("deposit-history.html"); };
    if (openWithdrawHistoryPage) openWithdrawHistoryPage.onclick = function () { go("withdraw-history.html"); };
    if (openTransactionsPage) openTransactionsPage.onclick = function () { go("transactions.html"); };
    if (openLogsPage) openLogsPage.onclick = function () { go("logs.html"); };
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
    document.getElementById("chat-send").onclick = sendChat;

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
        renderUser(data);
        maybeAutoVip(uid, data);
      })
    );
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
        window.location.href = window.avPath ? window.avPath("login.html") : "login.html";
        return;
      }
      window.restoreTab("home");
      wireUi(user.uid);

      if (window.AvelonUI.onceOnboard("hint_tabs")) {
        window.AvelonUI.toast("Tip: bottom navigation is always synced");
      }
    });
  });
})();
