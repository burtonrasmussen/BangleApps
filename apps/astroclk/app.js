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
  use12h:   false,
  redMode:  false,
  windUnit: "mph"   // "mph" | "kmh"
};

// ── Palette (normal / red mode) ───────────────────────────────────────────────
function pal(hex) {
  // In red mode, convert to a red-channel-only version
  if (!settings.redMode) return hex;
  // Parse hex color, keep only red channel (dim green/blue to 0)
  var r = parseInt(hex.slice(1, 3), 16);
  // Map luminance to red channel — simple: use r/4 of original luma
  var luma = Math.round(0.299 * r + 0.587 * parseInt(hex.slice(3, 5), 16) + 0.114 * parseInt(hex.slice(5, 7), 16));
  var rv = Math.min(255, Math.round(luma * 0.9));
  return g.toColor(rv / 255, 0, 0);
}

var COLOR = {
  bg:       "#FFFFFF",
  time:     "#000000",
  label:    "#000000",
  accent:   "#000000",
  moon:     "#000000",
  good:     "#00AA00",
  warn:     "#FFFF00",
  bad:      "#FF0000",
  dim:      "#000000",
  iss:      "#000000",
  batt:     "#000000"
};

// ── Module references (hoisted — required once, not on every draw) ────────────
// Wrapped in try/catch so a missing file shows an error screen instead of
// a silent "Loading..." hang.
var zambretti, SunCalc;
try { zambretti = require("Storage").eval("astroclk.zambretti.js"); } catch(e) { zambretti = null; }
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
  g.setColor("#000000");
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

  // Background
  g.reset();
  g.setColor(pal(COLOR.bg));
  g.fillRect(0, 0, W, H);

  // ── Layout constants ──────────────────────────────────────────────────────
  var lx  = 4;           // left col label x
  var lcx = Math.floor(W / 2) - 2;  // left col values right-align here
  var rcx = W - 60;      // right col labels start here (56px wide, ends at W-4)
  var rvx = W - 4;       // right col values right-align here
  var y   = 4;

  // Time (large) — 12h: draw HH:MM in Vector,36 then AM/PM in VGA16 to avoid clip
  g.setFont("Vector", 36);
  g.setFontAlign(-1, -1);
  g.setColor(pal(COLOR.time));
  if (settings.use12h) {
    var h12 = now.getHours() % 12 || 12;
    var ampm = now.getHours() >= 12 ? "PM" : "AM";
    var hhmm = pad2(h12) + ":" + pad2(now.getMinutes());
    g.drawString(hhmm, lx, y);
    var tw = g.stringWidth(hhmm);
    g.setFont("VGA16");
    g.drawString(ampm, lx + tw + 2, y + 20);
  } else {
    g.drawString(fmtTime(now), lx, y);
  }

  // Moon icon — top right, radius 22
  drawMoonIcon(W - 26, y + 22, 22, astroCache.phase || 0);

  y += 48;

  // Date (left) + illumination % (right)
  var DAYS  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  g.setFont("VGA16");
  g.setFontAlign(-1, -1);
  g.setColor(pal(COLOR.label));
  g.drawString(DAYS[now.getDay()] + " " + now.getDate() + " " + MONTHS[now.getMonth()], lx, y);
  g.setColor(pal(COLOR.moon));
  g.setFontAlign(1, -1);
  g.drawString((astroCache.illumination || 0) + "%", rvx, y);
  g.setFontAlign(-1, -1);
  y += 16;

  // Divider
  g.setColor(pal(COLOR.dim));
  g.drawLine(0, y + 2, W, y + 2);
  y += 8;

  // Two-column data rows
  // Left:  DARK, LITE, ISS  — labels at lx, values right-aligned at lcx
  // Right: R, S, SKY        — labels at rcx, values right-aligned at rvx
  g.setFont("VGA16");

  // Row 1: DARK | R (moon rise)
  // VGA16 = 8px/char; right-col values drawn left-aligned right after their label
  g.setColor(pal(COLOR.label));
  g.drawString("DARK", lx, y);
  g.setColor(pal(COLOR.accent));
  g.setFontAlign(1, -1);
  g.drawString(fmtTimeFromDate(astroCache.astroDusk), lcx, y);
  g.setFontAlign(-1, -1);
  g.setColor(pal(COLOR.label));
  g.drawString("R", rcx, y);
  g.setColor(pal(COLOR.time));
  g.drawString(fmtTimeFromDate(astroCache.moonRise), rcx + 16, y);
  y += 16;

  // Row 2: LITE | S (moon set)
  g.setColor(pal(COLOR.label));
  g.drawString("LITE", lx, y);
  g.setColor(pal(COLOR.accent));
  g.setFontAlign(1, -1);
  g.drawString(fmtTimeFromDate(astroCache.astroDawn), lcx, y);
  g.setFontAlign(-1, -1);
  g.setColor(pal(COLOR.label));
  g.drawString("S", rcx, y);
  g.setColor(pal(COLOR.time));
  g.drawString(fmtTimeFromDate(astroCache.moonSet), rcx + 16, y);
  y += 16;

  // Row 3: ISS | SKY
  var iss = weather.iss;
  g.setColor(pal(COLOR.label));
  g.drawString("ISS", lx, y);
  if (iss) {
    var issDate = new Date(iss.risetime * 1000);
    g.setColor(pal(COLOR.iss));
    g.setFontAlign(1, -1);
    g.drawString(fmtTimeFromDate(issDate), lcx, y);
    g.setFontAlign(-1, -1);
  } else {
    g.setColor(pal(COLOR.dim));
    g.setFontAlign(1, -1);
    g.drawString("none", lcx, y);
    g.setFontAlign(-1, -1);
  }
  var cloud = weather.cloudAtDusk;
  g.setColor(pal(COLOR.label));
  g.drawString("SKY", rcx, y);
  if (cloud !== null && cloud !== undefined) {
    var cAge = weather.fetchedAt ? Math.round((Date.now() - weather.fetchedAt) / 3600000) : null;
    var stale = cAge !== null && cAge > 12;
    g.setColor(pal(cloudColor(cloud)));
    g.drawString(cloud + "%" + (stale ? "*" : ""), rcx + 32, y);
  } else {
    g.setColor(pal(COLOR.dim));
    g.drawString("--", rcx + 32, y);
  }

  // ── Bottom bar ────────────────────────────────────────────────────────────
  var by = H - 20;
  g.setColor(pal(COLOR.dim));
  g.drawLine(0, by - 2, W, by - 2);

  // Battery
  var bat = E.getBattery();
  var batColor = bat > 30 ? COLOR.good : bat > 15 ? COLOR.warn : COLOR.bad;
  g.setFont("VGA16");
  g.setColor(pal(batColor));
  g.setFontAlign(-1, -1);
  g.drawString("BAT " + bat + "%", 4, by);

  g.setFontAlign(-1, -1); // reset
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

  g.setFont("6x8", 1);
  g.setColor(pal(COLOR.label));
  g.setFontAlign(-1, -1);
  var hdrY = 22;
  g.drawString("TIME  CLD  WND  PCPN  HUM", 4, hdrY);
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

    // Cloud color coding
    var cc = cloudColor(row.cloud);
    g.setColor(pal(cc));
    g.setFont("6x8", 1);
    g.setFontAlign(-1, -1);

    var windVal = row.wind !== null
      ? (settings.windUnit === "mph"
          ? Math.round(row.wind * 0.621)
          : Math.round(row.wind)) + (settings.windUnit === "mph" ? "m" : "k")
      : "--";

    var line = (row.hour || "--:--") + "  " +
               pad2(row.cloud !== null ? row.cloud : "--") + "%  " +
               windVal + "  " +
               pad2(row.precip !== null ? row.precip : "--") + "%  " +
               pad2(row.humidity !== null ? row.humidity : "--") + "%";
    g.drawString(line, 4, ry + 2);
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
      require("Storage").eval("astroclk.fetch.js").fetch(
        function() { E.showAlert("Done!").then(startClock); },
        function(e) { E.showAlert("Error:\n" + e).then(startClock); }
      );
    },
    "Red Mode": {
      value: !!settings.redMode,
      onchange: function(v) {
        settings.redMode = v;
        require("Storage").writeJSON(SETTINGS_FILE, settings);
      }
    },
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
