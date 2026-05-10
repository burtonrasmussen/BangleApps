// astroclk.boot.js — runs at watch startup
// Responsibilities:
//   1. GPS time-sync (at most once per 24h)
//   2. Scheduled weather fetch at 05:00 and 15:00 (only when Gadgetbridge connected)

(function() {
  var SETTINGS_FILE  = "astroclk.json";
  var SYNC_FILE      = "astroclk.sync.json";

  var settings = require("Storage").readJSON(SETTINGS_FILE, 1) || {};
  var GPS_INTERVAL_H  = settings.gpsIntervalH  || 24;   // hours between GPS syncs

  // Fetch windows: [hour, minuteOfDay]. Fetch runs at 05:00 and 15:00.
  var FETCH_HOURS = [5, 15];

  // ── 1. GPS time sync ─────────────────────────────────────────────────────────
  var gpsRunning = false;
  var gpsListener = null;
  var gpsStopTimer = null;

  function stopGpsNow() {
    if (!gpsRunning) return;
    gpsRunning = false;
    if (gpsStopTimer) { clearTimeout(gpsStopTimer); gpsStopTimer = null; }
    if (gpsListener) { Bangle.removeListener("GPS", gpsListener); gpsListener = null; }
    Bangle.setGPSPower(0, "astroclk");
  }

  function maybeGpsSync() {
    if (gpsRunning) return;
    var sync = require("Storage").readJSON(SYNC_FILE, 1) || {};
    var ageH = (Date.now() - (sync.lastGPSSync || 0)) / 3600000;
    if (ageH < GPS_INTERVAL_H) return;

    gpsRunning = true;
    gpsStopTimer = setTimeout(function() {
      stopGpsNow();
    }, 3 * 60 * 1000);

    Bangle.setGPSPower(1, "astroclk");
    gpsListener = function(fix) {
      if (!fix.fix) return;
      stopGpsNow();
      setTime(fix.time.getTime() / 1000);
      var loc = require("Storage").readJSON("mylocation.json", 1) || {};
      loc.lat = fix.lat; loc.lon = fix.lon;
      require("Storage").writeJSON("mylocation.json", loc);
      require("Storage").writeJSON(SYNC_FILE, { lastGPSSync: Date.now() });
    };
    Bangle.on("GPS", gpsListener);
  }

  // ── 2. Scheduled weather fetch (05:00 and 15:00) ─────────────────────────────
  function doFetch() {
    if (typeof Bangle.http !== "function") return;       // Gadgetbridge not loaded
    if (!NRF.getSecurityStatus || !NRF.getSecurityStatus().connected) return; // not connected
    try { var exports = {}; eval(require("Storage").read("astroclk.fetch.js")); exports.fetch(null, null); } catch(e) {}
  }

  // Returns ms until the next occurrence of the given hour (local time).
  function msUntilHour(targetHour) {
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), targetHour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  // Schedule a recurring daily alarm at targetHour.
  function scheduleDailyFetch(targetHour) {
    setTimeout(function fire() {
      doFetch();
      setTimeout(fire, 24 * 60 * 60 * 1000); // repeat every 24 h
    }, msUntilHour(targetHour));
  }

  maybeGpsSync();

  for (var i = 0; i < FETCH_HOURS.length; i++) {
    scheduleDailyFetch(FETCH_HOURS[i]);
  }
})();
