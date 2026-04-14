/* VIP table — UI + upgrade thresholds (max tier 15) */
(function () {
  window.AVELON_VIP = [
    { level: 1, deposit: 500, daily: 25, rate: 5.0, total180: 4500 },
    { level: 2, deposit: 1500, daily: 78, rate: 5.2, total180: 14040 },
    { level: 3, deposit: 3500, daily: 192.5, rate: 5.5, total180: 34650 },
    { level: 4, deposit: 7500, daily: 435, rate: 5.8, total180: 78300 },
    { level: 5, deposit: 15000, daily: 900, rate: 6.0, total180: 162000 },
    { level: 6, deposit: 20000, daily: 1240, rate: 6.2, total180: 223200 },
    { level: 7, deposit: 25000, daily: 1600, rate: 6.4, total180: 288000 },
    { level: 8, deposit: 30000, daily: 1980, rate: 6.6, total180: 356400 },
    { level: 9, deposit: 40000, daily: 2720, rate: 6.8, total180: 489600 },
    { level: 10, deposit: 50000, daily: 3500, rate: 7.0, total180: 630000 },
    { level: 11, deposit: 75000, daily: 5250, rate: 7.2, total180: 945000 },
    { level: 12, deposit: 100000, daily: 7500, rate: 7.5, total180: 1350000 },
    { level: 13, deposit: 125000, daily: 9500, rate: 7.8, total180: 1710000 },
    { level: 14, deposit: 150000, daily: 11500, rate: 8.0, total180: 2070000 },
    { level: 15, deposit: 200000, daily: 15000, rate: 8.5, total180: 2700000 },
  ];

  window.AvelonVip = {
    computeLevel(totalDeposits) {
      var lvl = 1;
      for (var i = 0; i < window.AVELON_VIP.length; i++) {
        if (totalDeposits >= window.AVELON_VIP[i].deposit) lvl = window.AVELON_VIP[i].level;
      }
      return lvl;
    },
    glowForLevel(level) {
      var t = Math.max(1, Math.min(15, level || 1)) / 15;
      return 8 + Math.round(26 * t);
    },
  };
})();
