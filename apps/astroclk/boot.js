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

  // ── 2. HRM polling ───────────────────────────────────────────────────────────
  var hrmBuf = [];
  var HRM_RAM_MAX = 288;
  var hrmActive = false;
  var hrmStopTimer = null;
  var hrmListener = null;

  function stopHrmNow() {
    if (!hrmActive) return;
    hrmActive = false;
    if (hrmStopTimer) { clearTimeout(hrmStopTimer); hrmStopTimer = null; }
    if (hrmListener) { Bangle.removeListener("HRM", hrmListener); hrmListener = null; }
    Bangle.setHRMPower(0, "astroclk");
  }

  function doHrmPoll() {
    if (hrmActive) return;
    hrmActive = true;
    Bangle.setHRMPower(1, "astroclk");
    hrmStopTimer = setTimeout(function() {
      stopHrmNow();
    }, 15000); // give up after 15 s
    hrmListener = function(hrm) {
      if (!hrm.bpm || hrm.bpm <= 0 || hrm.confidence < 50) return;
      var bpm = hrm.bpm;
      stopHrmNow();
      var entry = { t: Math.floor(Date.now() / 1000), bpm: bpm };
      hrmBuf.push(entry);
      if (hrmBuf.length > HRM_RAM_MAX) hrmBuf.shift();
      global._astroclkBPM = bpm;
    };
    Bangle.on("HRM", hrmListener);
  }

  function startHRM() {
    setTimeout(doHrmPoll, 60000); // first poll 60 s after boot — let GPS settle
    setInterval(doHrmPoll, HRM_INTERVAL_M * 60 * 1000);
    setInterval(function() {
      if (hrmBuf.length === 0) return;
      require("Storage").writeJSON(HRM_FILE, hrmBuf);
    }, 60 * 60 * 1000);
  }

  // ── 3. Barometer pressure sampling ───────────────────────────────────────────
  function samplePressure() {
    var p = (typeof Bangle.getPressure === "function") ? Bangle.getPressure() : null;
    if (!p || typeof p.then !== "function") return;
    p.then(function(d) {
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
  // The frontlight LED brightness is implemented as software PWM driven by
  // Espruino's poll loop. Power-save mode slows the poll from 80ms to 800ms
  // (when the watch has been stationary for ~1 minute), which drops the PWM
  // frequency from 12.5Hz to 1.25Hz — visibly flickering LEDs. The watch wakes
  // from power-save when the user raises their wrist or presses a button, then
  // gradually ramps the poll back to 80ms over ~5-10s (matching reported symptom).
  // Fix: force 80ms poll the moment the backlight turns on, restore powerSave
  // 2s after it turns off.
  var pollRestoreTimer = null;
  Bangle.on("backlight", function(on) {
    if (pollRestoreTimer) { clearTimeout(pollRestoreTimer); pollRestoreTimer = null; }
    if (on) {
      Bangle.setOptions({powerSave: false});
      Bangle.setPollInterval(80);
    } else {
      // Short delay before restoring so any final redraws stay flicker-free
      pollRestoreTimer = setTimeout(function() {
        pollRestoreTimer = null;
        Bangle.setOptions({powerSave: true});
      }, 2000);
    }
  });

  maybeGpsSync();
  startHRM();
  samplePressure();
  setInterval(samplePressure, PRES_INTERVAL_M * 60 * 1000);

  NRF.on("connect", function() {
    setTimeout(tryFetch, 3000);
  });
  setTimeout(tryFetch, 5000);
})();
