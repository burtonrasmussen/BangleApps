// astroclk.boot.js — runs at watch startup
// Responsibilities:
//   1. GPS time-sync (at most once per 24h)
//   2. Start HRM polling interval
//   3. Start barometer pressure sampling (every 15 min)
//   4. Trigger opportunistic weather fetch when BLE connects

(function() {
  var SETTINGS_FILE  = "astroclk.json";
  var SYNC_FILE      = "astroclk.sync.json";
  var PRESSURE_FILE  = "astroclk.pressure.json";
  var HRM_FILE       = "astroclk.hrm.json";

  var settings = require("Storage").readJSON(SETTINGS_FILE, 1) || {};
  var GPS_INTERVAL_H  = settings.gpsIntervalH  || 24;   // hours between GPS syncs
  var HRM_INTERVAL_M  = settings.hrmIntervalM  || 5;    // minutes between HRM polls
  var PRES_INTERVAL_M = 15;                              // pressure sample interval (fixed)
  var PRES_MAX        = 12;                              // ring-buffer size (~3 h)

  // ── 1. GPS time sync ─────────────────────────────────────────────────────────
  function maybeGpsSync() {
    var sync = require("Storage").readJSON(SYNC_FILE, 1) || {};
    var ageH = (Date.now() - (sync.lastGPSSync || 0)) / 3600000;
    if (ageH < GPS_INTERVAL_H) return;

    var timeout = setTimeout(function() {
      Bangle.setGPSPower(0, "astroclk");
    }, 3 * 60 * 1000); // 3-minute hard stop

    Bangle.setGPSPower(1, "astroclk");
    Bangle.on("GPS", function onGPS(fix) {
      if (!fix.fix) return;
      // Valid fix: sync time and location
      setTime(fix.time.getTime() / 1000);
      clearTimeout(timeout);
      Bangle.setGPSPower(0, "astroclk");
      Bangle.removeListener("GPS", onGPS);

      // Update mylocation.json
      var loc = require("Storage").readJSON("mylocation.json", 1) || {};
      loc.lat = fix.lat;
      loc.lon = fix.lon;
      require("Storage").writeJSON("mylocation.json", loc);

      // Record sync timestamp
      require("Storage").writeJSON(SYNC_FILE, { lastGPSSync: Date.now() });
    });
  }

  // ── 2. HRM polling ───────────────────────────────────────────────────────────
  var hrmBuf = [];   // RAM ring buffer: [{t, bpm}]
  var HRM_RAM_MAX = 288; // 24h at 5-min intervals

  function startHRM() {
    Bangle.setHRMPower(1, "astroclk");
    setInterval(function() {
      Bangle.getHealthStatus("astroclk").then ? undefined : undefined; // no-op; use direct read
      Bangle.on("HRM-raw", undefined); // ensure listener cleared
      // Use a one-shot read
      var reading = Bangle.getHealthStatus ? Bangle.getHealthStatus() : null;
      if (reading && reading.bpm > 0) {
        var entry = { t: Math.floor(Date.now() / 1000), bpm: reading.bpm };
        hrmBuf.push(entry);
        if (hrmBuf.length > HRM_RAM_MAX) hrmBuf.shift();
        // Expose latest BPM for the clock face to read
        if (typeof global !== "undefined") global._astroclkBPM = reading.bpm;
      }
    }, HRM_INTERVAL_M * 60 * 1000);

    // Flush to storage at most once per hour
    setInterval(function() {
      if (hrmBuf.length === 0) return;
      require("Storage").writeJSON(HRM_FILE, hrmBuf);
    }, 60 * 60 * 1000);
  }

  // ── 3. Barometer pressure sampling ───────────────────────────────────────────
  function samplePressure() {
    Bangle.getPressure().then(function(d) {
      if (!d || !d.pressure) return;
      var buf = require("Storage").readJSON(PRESSURE_FILE, 1) || [];
      buf.push({ t: Math.floor(Date.now() / 1000), p: d.pressure });
      if (buf.length > PRES_MAX) buf.shift();
      require("Storage").writeJSON(PRESSURE_FILE, buf);
    });
  }

  // ── 4. BLE-opportunistic weather fetch ───────────────────────────────────────
  function tryFetch() {
    var weather = require("Storage").readJSON("astroclk.weather.json", 1) || {};
    var ageH = (Date.now() - (weather.fetchedAt || 0)) / 3600000;
    if (ageH < 20) return; // already fresh
    if (typeof Bangle.http !== "function") return; // android boot not loaded yet
    require("Storage").eval("astroclk.fetch.js").fetch(null, null);
  }

  // ── Boot sequence ─────────────────────────────────────────────────────────────
  maybeGpsSync();
  startHRM();
  samplePressure();
  setInterval(samplePressure, PRES_INTERVAL_M * 60 * 1000);

  // Try weather fetch when BLE connects (Gadgetbridge available)
  NRF.on("connect", function() {
    setTimeout(tryFetch, 3000); // brief delay to let android.boot.js finish setup
  });
  // Also try immediately in case already connected
  setTimeout(tryFetch, 5000);
})();
