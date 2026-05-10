// astroclk — AstroWatch main clock face
// Bangle.js 2 (176×176 LCD)
//
// F1: Main clock face — time, biometrics, moon data, sky conditions
// F2: Hourly sky conditions table
//
// Navigation:
//   Wrist-raise / tap → wake, show F1
//   Swipe left/right  → toggle F1 ↔ F2
//   Long BTN1         → side menu

// ── Constants & defaults ──────────────────────────────────────────────────────
var W = g.getWidth();    // 176
var H = g.getHeight();   // 176

var SETTINGS_FILE = "astroclk.json";

var settings = require("Storage").readJSON(SETTINGS_FILE, 1) || {
  use12h:   true,
  windUnit: "mph"   // "mph" | "kmh"
};

// ── Palette (passthrough — 3-bit LCD needs no conversion) ───────────────────
function pal(hex) { return hex; }

var COLOR = {
  bg:       "#FFFFFF",
  time:     "#000000",
  label:    "#000000",
  accent:   "#000000",
  moon:     "#000000",
  good:     "#00FF00",
  warn:     "#FFFF00",
  bad:      "#FF0000",
  dim:      "#000000",
  iss:      "#000000",
  batt:     "#000000"
};

// ── Module references (hoisted — required once, not on every draw) ────────────
// Wrapped in try/catch so a missing file shows an error screen instead of
// a silent "Loading..." hang.
var SunCalc;
try { SunCalc = require("suncalc"); } catch(e) { SunCalc = null; }
try { require("FontVGA16").add(Graphics); } catch(e) {}


// ── State ─────────────────────────────────────────────────────────────────────
var screen = 1;          // 1 = F1, 2 = F2
var clockInterval;
var astroCache = {};     // computed once per minute from suncalc
var lastAstroMin = -1;   // minute at which astroCache was last computed

// ── Utility ───────────────────────────────────────────────────────────────────
function pad2(n) { return n < 10 ? "0" + n : "" + n; }

function fmtTime(date) {
  var h = date.getHours();
  var m = date.getMinutes();
  if (settings.use12h) {
    var ampm = h >= 12 ? "p" : "a";
    h = h % 12 || 12;
    return pad2(h) + ":" + pad2(m) + ampm;
  }
  return pad2(h) + ":" + pad2(m);
}

function fmtTimeFromDate(d) {
  if (!d || isNaN(d.getTime())) return "--:--";
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

// Return a moon-phase icon character (uses built-in 6x8 font shapes as fallback)
// We draw a simple crescent/circle ourselves below.
function moonPhaseLabel(phase) {
  // phase 0–1: 0=new, 0.25=first quarter, 0.5=full, 0.75=last quarter
  if (phase < 0.03 || phase > 0.97) return "New";
  if (phase < 0.22) return "Wax Crescent";
  if (phase < 0.28) return "1st Qtr";
  if (phase < 0.47) return "Wax Gibbous";
  if (phase < 0.53) return "Full";
  if (phase < 0.72) return "Wan Gibbous";
  if (phase < 0.78) return "Last Qtr";
  return "Wan Crescent";
}

// Draw a small moon icon at (cx, cy) radius r, phase 0–1
// White = lit, black = dark, black outline
// Uses row-by-row scan with correct terminator ellipse — no clipping artifacts.
function drawMoonIcon(cx, cy, r, phase) {
  // cos(phase * 2π): +1=new, 0=quarter, -1=full, 0=quarter, +1=new
  var cosP = Math.cos(phase * 2 * Math.PI);
  var waning = phase > 0.5;

  for (var dy = -r; dy <= r; dy++) {
    var halfW = Math.round(Math.sqrt(r * r - dy * dy));
    // Terminator x offset at this row (ellipse with same vertical radius as circle)
    var tx = Math.round(cosP * halfW);
    var y = cy + dy;
    var litL, litR, dkL, dkR;

    if (!waning) {
      // Waxing: lit side is right (x >= center+tx)
      litL = Math.max(cx - halfW, cx + tx);
      litR = cx + halfW;
      dkL = cx - halfW; dkR = litL - 1;
    } else {
      // Waning: lit side is left (x <= center-tx)
      litL = cx - halfW;
      litR = Math.min(cx + halfW, cx - tx);
      dkL = litR + 1; dkR = cx + halfW;
    }

    if (dkL <= dkR) { g.setColor("#000000"); g.fillRect(dkL, y, dkR, y); }
    if (litL <= litR) { g.setColor("#FFFFFF"); g.fillRect(litL, y, litR, y); }
  }
  g.setColor("#FFFFFF");   // white outline — visible on black background (3-bit palette, no gray)
  g.drawCircle(cx, cy, r);
}

// Sky-clarity color based on cloud %
function cloudColor(pct) {
  if (pct === null || pct === undefined) return COLOR.dim;
  if (pct <= 25) return COLOR.good;
  if (pct <= 60) return COLOR.warn;
  return COLOR.bad;
}

// ── Astronomical data (computed once per minute) ──────────────────────────────
function refreshAstro() {
  if (!SunCalc) return; // module not loaded — skip silently
  var now  = new Date();
  var min  = now.getMinutes() + now.getHours() * 60;
  if (min === lastAstroMin) return;
  lastAstroMin = min;

  var loc = require("Storage").readJSON("mylocation.json", 1) || { lat: 51.5, lon: -0.12 };
  var lat = loc.lat, lon = loc.lon;

  var moonIll  = SunCalc.getMoonIllumination(now);
  var moonTimes = SunCalc.getMoonTimes(now, lat, lon);
  var sunTimes  = SunCalc.getTimes(now, lat, lon);

  astroCache = {
    phase:      moonIll.phase,          // 0–1
    illumination: Math.round(moonIll.fraction * 100),  // %
    moonRise:   moonTimes.rise,         // Date or undefined
    moonSet:    moonTimes.set,          // Date or undefined
    astroDusk:  sunTimes.night || sunTimes.nauticalDusk,
    astroDawn:  SunCalc.getTimes(new Date(now.getTime() + 86400000), lat, lon).nightEnd
                || SunCalc.getTimes(new Date(now.getTime() + 86400000), lat, lon).nauticalDawn
  };
}

// ── F1 — Main clock face ──────────────────────────────────────────────────────
function drawF1() {
  var now = new Date();

  // If suncalc didn't load, show a diagnostic screen instead of crashing
  if (!SunCalc) {
    g.reset(); g.clear();
    g.setFont("VGA16"); g.setColor("#FF4444");
    g.setFontAlign(0, 0);
    g.drawString("Missing: suncalc\nReinstall via\nApp Loader", W/2, H/2);
    return;
  }

  refreshAstro();
  var weather = require("Storage").readJSON("astroclk.weather.json", 1) || {};

  g.reset();
  g.setColor(pal(COLOR.bg));
  g.fillRect(0, 0, W, H);

  var lx  = 4;
  var rvx = W - 4;
  var DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // ── Time (Vector 54 — 50% larger than original 36) ───────────────────────
  // 12h: AM/PM drawn separately in top-right corner so it never overlaps time digits
  g.setFont("Vector", 54);
  g.setColor(pal(COLOR.time));
  g.setFontAlign(-1, -1);
  if (settings.use12h) {
    var h12  = now.getHours() % 12 || 12;
    var ampm = now.getHours() >= 12 ? "PM" : "AM";
    g.drawString(h12 + ":" + pad2(now.getMinutes()), lx, 2);
    g.setFont("Vector", 26);
    g.setFontAlign(1, -1);
    g.drawString(ampm, rvx, 2);
  } else {
    g.drawString(pad2(now.getHours()) + ":" + pad2(now.getMinutes()), lx, 2);
  }

  // ── Date row + moon illumination ──────────────────────────────────────────
  // Vector 18 — noticeably larger than VGA16 (16px) and fits both strings.
  g.setFont("Vector", 18);
  g.setFontAlign(-1, -1);
  g.setColor(pal(COLOR.label));
  g.drawString(DAYS[now.getDay()] + " " + now.getDate() + " " + MONTHS[now.getMonth()], lx, 58);
  g.setFontAlign(1, -1);
  g.setColor(pal(COLOR.moon));
  g.drawString((astroCache.illumination || 0) + "%", rvx, 58);

  // ── Black band — fills from just below date row to just above bottom bar ──
  var bandTop = 78;   // moon top = moonCy-moonR = 116-33 = 83, fits just inside
  var bandBot = 154;
  var bandFG  = "#FFFFFF";   // white text on black background
  g.setColor(pal("#000000"));
  g.drawLine(0, bandTop, W, bandTop);
  g.fillRect(0, bandTop + 1, W, bandBot);

  // ── Moon icon — right side, r=33 ─────────────────────────────────────────
  // Dark portion blends into black band; lit portion glows white against it.
  var moonR  = 33;
  var moonCx = W - moonR - 4;   // 176-33-4 = 139
  var moonCy = 116;
  drawMoonIcon(moonCx, moonCy, moonR, astroCache.phase || 0);

  // ── Left data column — DARK / R / S / SKY ────────────────────────────────
  var dataRX = moonCx - moonR - 4;
  g.setFont("VGA16");

  // DARK — astronomical dusk
  g.setFontAlign(-1, -1);
  g.setColor(pal(bandFG));
  g.drawString("DARK", lx, 91);
  g.setFontAlign(1, -1);
  g.setColor(pal(bandFG));
  g.drawString(fmtTimeFromDate(astroCache.astroDusk), dataRX, 91);

  // Moon rise
  g.setFontAlign(-1, -1);
  g.setColor(pal(bandFG));
  g.drawString("R", lx, 107);
  g.setFontAlign(1, -1);
  g.setColor(pal(bandFG));
  g.drawString(fmtTimeFromDate(astroCache.moonRise), dataRX, 107);

  // Moon set
  g.setFontAlign(-1, -1);
  g.setColor(pal(bandFG));
  g.drawString("S", lx, 123);
  g.setFontAlign(1, -1);
  g.setColor(pal(bandFG));
  g.drawString(fmtTimeFromDate(astroCache.moonSet), dataRX, 123);

  // SKY — cloud cover at dusk; coloured filled box with black text inside
  g.setFontAlign(-1, -1);
  g.setColor(pal(bandFG));
  g.drawString("SKY", lx, 139);
  var cloud = weather.cloudAtDusk;
  if (cloud !== null && cloud !== undefined) {
    var cAge   = weather.fetchedAt ? Math.round((Date.now() - weather.fetchedAt) / 3600000) : null;
    var stale  = cAge !== null && cAge > 12;
    var skyStr = cloud + "%" + (stale ? "*" : "");
    // Filled box: right edge at dataRX+2, wide enough for up to 5 chars ("100%*")
    var boxR = dataRX + 2;
    var boxL = boxR - 44;   // 44px = 5 VGA16 chars + 2px side padding each
    g.setColor(pal(cloudColor(cloud)));
    g.fillRect(boxL, 139, boxR, 154);
    g.setColor(pal("#000000"));  // black text on coloured box
    g.setFontAlign(1, -1);
    g.drawString(skyStr, dataRX, 140);
  } else {
    g.setFontAlign(1, -1);
    g.setColor(pal(bandFG));
    g.drawString("--", dataRX, 139);
  }

  // ── Bottom bar — Battery + ISS indicator ─────────────────────────────────
  g.setColor(pal(COLOR.dim));
  g.drawLine(0, 155, W, 155);

  var bat = E.getBattery();
  var batStr = "BAT " + bat + "%";
  g.setFont("VGA16");
  g.setFontAlign(-1, -1);
  if (bat <= 25) {
    // Red box: flush left/bottom edges, tight under divider
    g.setColor(pal(COLOR.bad));
    g.fillRect(0, 156, 76, H - 1);
    g.setColor(pal("#000000"));
  } else {
    g.setColor(pal("#000000"));
  }
  g.drawString(batStr, lx, 158);

  // ISS: green label when a pass is expected tonight, red when none
  var iss = weather.iss;
  g.setFontAlign(1, -1);
  g.setColor(pal(iss ? COLOR.good : COLOR.bad));
  g.drawString("ISS", rvx, 158);
}

// ── F2 — Hourly sky conditions table ─────────────────────────────────────────
function drawF2() {
  var weather = require("Storage").readJSON("astroclk.weather.json", 1) || {};
  var hourly  = weather.hourly || [];

  g.reset();
  g.setColor(pal(COLOR.bg));
  g.fillRect(0, 0, W, H);

  // Header
  g.setFont("VGA16");
  g.setColor(pal(COLOR.accent));
  g.setFontAlign(0, -1);
  g.drawString("TONIGHT", W / 2, 2);

  var hdrY = 22;
  g.setFont("6x8", 1);
  g.setFontAlign(-1, -1);
  g.setColor(pal(COLOR.label));
  g.drawString("TIME",  4,   hdrY);
  g.drawString("CLD%",  52,  hdrY);
  g.drawString("SEE",   100, hdrY);
  g.drawString("TRNS",  133, hdrY);
  g.setColor(pal(COLOR.dim));
  g.drawLine(0, hdrY + 9, W, hdrY + 9);

  if (hourly.length === 0) {
    g.setFont("VGA16");
    g.setColor(pal(COLOR.label));
    g.setFontAlign(0, 0);
    g.drawString("No data\nFetch via BLE", W / 2, H / 2);
    return;
  }

  // Show up to 8 rows
  var rowH = 14;
  var startY = hdrY + 11;
  var maxRows = Math.min(hourly.length, Math.floor((H - startY - 14) / rowH));

  for (var i = 0; i < maxRows; i++) {
    var row = hourly[i];
    var ry  = startY + i * rowH;

    // Alternating row tint
    if (i % 2 === 0) {
      g.setColor(pal("#111111"));
      g.fillRect(0, ry, W, ry + rowH - 1);
    }

    g.setFont("6x8", 1);
    g.setFontAlign(-1, -1);

    // Time
    g.setColor(pal(COLOR.label));
    g.drawString(row.hour || "--:--", 4, ry + 2);

    // Cloud % — colour coded
    g.setColor(pal(cloudColor(row.cloud)));
    g.drawString(row.cloud !== null ? pad2(row.cloud) + "%" : "--% ", 52, ry + 2);

    // Seeing 0–5 (0=Terrible, 5=Excellent) — green/yellow/red
    var see = row.seeing;
    var seeCol = see === null   ? COLOR.dim  :
                 see >= 4       ? COLOR.good :
                 see >= 2       ? COLOR.warn : COLOR.bad;
    g.setColor(pal(seeCol));
    g.drawString(see !== null ? Math.round(see) + "/5" : " --", 100, ry + 2);

    // Transparency (lower = better; <=10 excellent, <=18 average, else poor)
    var trns = row.transparency;
    var trnsCol = trns === null ? COLOR.dim  :
                  trns <= 10   ? COLOR.good :
                  trns <= 18   ? COLOR.warn : COLOR.bad;
    g.setColor(pal(trnsCol));
    g.drawString(trns !== null ? "" + Math.round(trns) : "--", 138, ry + 2);
  }

  // Bottom bar
  var by = H - 14;
  g.setColor(pal(COLOR.dim));
  g.drawLine(0, by - 2, W, by - 2);
  g.setFont("6x8", 1);
  g.setColor(pal(COLOR.label));
  g.setFontAlign(0, -1);
  if (weather.fetchedAt) {
    var ageH = Math.round((Date.now() - weather.fetchedAt) / 3600000);
    g.drawString("fetched " + ageH + "h ago", W / 2, by);
  } else {
    g.drawString("no data cached", W / 2, by);
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function draw() {
  if (screen === 1) drawF1();
  else              drawF2();
}

// Named so it can be removed while the menu is open
function onSwipe(dir) {
  screen = screen === 1 ? 2 : 1;
  draw();
}

var inMenu = false;
var menuRef = null;

// Long-press BTN1 → side menu
function stopClock() {
  if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
  Bangle.removeListener("swipe", onSwipe);
}
function startClock() {
  inMenu = false;
  if (menuRef) { E.showMenu(); menuRef = null; }
  if (clockInterval) return; // already running
  Bangle.on("swipe", onSwipe);
  draw();
  clockInterval = setInterval(draw, 60000);
}

setWatch(function() {
  if (inMenu) return; // ignore if menu already open
  inMenu = true;
  stopClock();
  menuRef = E.showMenu({
    "": { title: "AstroWatch", back: startClock },
    "< Back":        function() { startClock(); },
    "12h Clock": {
      value: !!settings.use12h,
      onchange: function(v) {
        settings.use12h = v;
        require("Storage").writeJSON(SETTINGS_FILE, settings);
      }
    },
    "Wind Unit": {
      value: settings.windUnit === "mph" ? 0 : 1,
      min: 0, max: 1,
      format: function(v) { return v === 0 ? "mph" : "km/h"; },
      onchange: function(v) {
        settings.windUnit = v === 0 ? "mph" : "kmh";
        require("Storage").writeJSON(SETTINGS_FILE, settings);
      }
    },
    "Weather Source": {
      value: settings.weatherProvider === "astrospheric" ? 1 : 0,
      min: 0, max: 1,
      format: function(v) { return v ? "Astrospheric" : "OpenMeteo"; },
      onchange: function(v) {
        settings.weatherProvider = v ? "astrospheric" : "openmeteo";
        require("Storage").writeJSON(SETTINGS_FILE, settings);
      }
    },
    "Fetch Weather": function() {
      if (typeof Bangle.http !== "function") {
        E.showAlert("Android Integration\nnot installed").then(startClock);
        return;
      }
      if (!NRF.getSecurityStatus || !NRF.getSecurityStatus().connected) {
        E.showAlert("Bluetooth\nnot connected").then(startClock);
        return;
      }
      E.showMessage("Fetching...");
      var _fetchDone = false;
      var _watchdog = setTimeout(function() {
        if (_fetchDone) return;
        _fetchDone = true;
        E.showAlert("Timed out").then(startClock);
      }, 60000);
      var _appLog = require("Storage").readJSON("astroclk.log.json", 1) || [];
      _appLog.push("[app.js] starting eval");
      require("Storage").writeJSON("astroclk.log.json", _appLog);
      var _fetchMod;
      try {
        var exports = {};
        eval(require("Storage").read("astroclk.fetch.js"));
        _fetchMod = exports;
        _appLog.push("[app.js] eval OK, fetch=" + typeof _fetchMod.fetch);
        require("Storage").writeJSON("astroclk.log.json", _appLog);
      } catch(e) {
        _appLog.push("[app.js] eval THREW: " + e);
        require("Storage").writeJSON("astroclk.log.json", _appLog);
        if (!_fetchDone) { _fetchDone = true; clearTimeout(_watchdog); }
        E.showAlert("eval error:\n" + e).then(startClock);
        return;
      }
      _fetchMod.fetch(
        function() {
          if (_fetchDone) return;
          _fetchDone = true;
          clearTimeout(_watchdog);
          E.showAlert("Done!").then(startClock);
        },
        function(e) {
          if (_fetchDone) return;
          _fetchDone = true;
          clearTimeout(_watchdog);
          E.showAlert("Error:\n" + e).then(startClock);
        }
      );
    },
    "Show Log": function() {
      var lines = require("Storage").readJSON("astroclk.log.json", 1) || [];
      E.showScroller({
        h: 16, c: lines.length || 1,
        draw: function(i, r) {
          g.setColor(1,1,1).fillRect(r.x,r.y,r.x+r.w,r.y+r.h);
          g.setColor(0,0,0).setFont("6x8").drawString(lines[i]||"(empty)",r.x+2,r.y+4);
        },
        select: function() { E.showMenu(menuRef); }
      });
    },
    "Clear Log": function() {
      require("Storage").erase("astroclk.log.json");
      E.showAlert("Log cleared").then(function() { E.showMenu(menuRef); });
    }
});
}, BTN1, { repeat: true, edge: "falling", debounce: 50 });

// ── Clock tick ────────────────────────────────────────────────────────────────

// Align first tick to the wall-clock minute boundary.
// Use stopClock() before startClock() so the swipe listener is never double-registered.
var now = new Date();
var msToNextMin = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
setTimeout(function() {
  if (!inMenu) { stopClock(); startClock(); }
}, msToNextMin);

// Initial draw
startClock();
