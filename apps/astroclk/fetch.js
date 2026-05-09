// astroclk.fetch.js
// Pulls Open-Meteo weather data and Open-Notify ISS pass times from the phone
// via Gadgetbridge's Bangle.http() bridge (requires Android Integration app +
// Gadgetbridge with "Allow Internet Access"). Gadgetbridge accepts HTTPS URLs
// only; Open-Notify is HTTP-only, so we load it through an HTTPS raw proxy.
// Results are trimmed to tonight's astronomical night window and written to
// astroclk.weather.json.
//
// Caller pattern:
//   require("Storage").eval("astroclk.fetch.js").fetch(onDone, onError);
//
// astroclk.weather.json shape:
// {
//   fetchedAt: <unix ms>,
//   hourly: [           // hours inside tonight's astro night, trimmed
//     { hour: "HH:MM", cloud: N, wind: N, precip: N, humidity: N },
//     ...
//   ],
//   cloudAtDusk: N,     // cloud% at the first astro-night hour (F1 display)
//   iss: {              // nearest ISS pass tonight, or null
//     risetime: <unix s>,
//     duration: N
//   }
// }

var HTTP_OPTS = { timeout: 45000 };

function httpText(ev) {
  if (!ev) return "";
  if (typeof ev === "string") return ev;
  if (typeof ev.resp === "string") return ev.resp;
  return "";
}

function parseJson(ev, what) {
  var s = httpText(ev);
  if (!s) throw what + ": empty body";
  try { return JSON.parse(s); }
  catch (e) { throw what + ": bad JSON"; }
}

// Open-Notify is HTTP-only; Bangle/Gadgetbridge requires HTTPS — wrap via raw proxy.
function issProxyUrl(lat, lon) {
  var q = "http://api.open-notify.org/iss-pass.json" +
    "?lat=" + lat.toFixed(4) + "&lon=" + lon.toFixed(4) + "&n=5";
  return "https://api.allorigins.win/raw?url=" + encodeURIComponent(q);
}

exports.fetch = function(onDone, onError) {
  if (typeof Bangle.http !== "function") {
    if (onError) onError("Android Integration app not loaded");
    return;
  }
  if (!NRF.getSecurityStatus || !NRF.getSecurityStatus().connected) {
    if (onError) onError("Bluetooth not connected");
    return;
  }

  var loc = require("Storage").readJSON("mylocation.json", 1);
  if (!loc || !loc.lat || !loc.lon) {
    if (onError) onError("No location set — open MyLocation app first");
    return;
  }
  var lat = loc.lat;
  var lon = loc.lon;

  // Compute tonight's astro-night window so we can trim the response
  var SunCalc = require("suncalc");
  var now  = new Date();
  var times = SunCalc.getTimes(now, lat, lon);
  // If astronomical dusk has already passed today, look at tomorrow's dawn
  var dusk  = times.astronomicalDusk  || times.dusk;
  var dawn  = SunCalc.getTimes(new Date(now.getTime() + 86400000), lat, lon).astronomicalDawn
              || SunCalc.getTimes(new Date(now.getTime() + 86400000), lat, lon).dawn;

  var duskMs = dusk ? dusk.getTime()  : now.getTime();
  var dawnMs = dawn ? dawn.getTime()  : duskMs + 8 * 3600000;

  function isoLocal(ms) {
    var d = new Date(ms);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }
  // Narrow date range on the server so the JSON fits comfortably over BLE.
  var startDate = isoLocal(Math.min(now.getTime(), duskMs));
  var endDate   = isoLocal(Math.max(dawnMs, duskMs));

  // --- Step 1: Open-Meteo hourly weather ---
  var meteoUrl = "https://api.open-meteo.com/v1/forecast" +
    "?latitude=" + lat.toFixed(4) +
    "&longitude=" + lon.toFixed(4) +
    "&hourly=cloudcover,windspeed_10m,precipitation_probability,relativehumidity_2m" +
    "&start_date=" + startDate +
    "&end_date=" + endDate +
    "&timezone=auto";

  Bangle.http(meteoUrl, HTTP_OPTS).then(function(resp) {
    var meteoData;
    try { meteoData = parseJson(resp, "Meteo"); }
    catch (e) { if (onError) onError(e); return; }

    var hourly = _trimMeteo(meteoData, duskMs, dawnMs);

    // --- Step 2: Open-Notify ISS passes (HTTPS-wrapped) ---
    var issUrl = issProxyUrl(lat, lon);

    Bangle.http(issUrl, HTTP_OPTS).then(function(resp2) {
      var issData;
      try { issData = parseJson(resp2, "ISS"); }
      catch (e) { issData = null; }

      var issPass = _findIssPass(issData, duskMs / 1000, dawnMs / 1000);

      var result = {
        fetchedAt:    Date.now(),
        hourly:       hourly,
        cloudAtDusk:  hourly.length ? hourly[0].cloud : null,
        iss:          issPass
      };
      require("Storage").writeJSON("astroclk.weather.json", result);
      if (onDone) onDone(result);

    }).catch(function(e) {
      // ISS fetch failed — store weather without ISS data
      var result = {
        fetchedAt:   Date.now(),
        hourly:      hourly,
        cloudAtDusk: hourly.length ? hourly[0].cloud : null,
        iss:         null
      };
      require("Storage").writeJSON("astroclk.weather.json", result);
      if (onDone) onDone(result);
    });

  }).catch(function(e) {
    if (onError) onError("Meteo fetch failed: " + e);
  });
};

// --- Helpers ---

// Trim Open-Meteo hourly array to hours that fall inside [duskMs, dawnMs]
function _trimMeteo(data, duskMs, dawnMs) {
  if (!data || !data.hourly || !data.hourly.time) return [];
  var times   = data.hourly.time;          // ISO strings "2026-05-08T22:00"
  var cloud   = data.hourly.cloudcover;
  var wind    = data.hourly.windspeed_10m;
  var precip  = data.hourly.precipitation_probability;
  var hum     = data.hourly.relativehumidity_2m;

  var result = [];
  for (var i = 0; i < times.length; i++) {
    var tMs = new Date(times[i]).getTime();
    if (tMs < duskMs || tMs > dawnMs) continue;
    result.push({
      hour:     times[i].slice(11, 16),   // "HH:MM"
      cloud:    cloud   ? cloud[i]   : null,
      wind:     wind    ? wind[i]    : null,
      precip:   precip  ? precip[i]  : null,
      humidity: hum     ? hum[i]     : null
    });
  }
  return result;
}

// Find the first ISS pass whose risetime falls inside tonight [duskS, dawnS] (unix seconds)
function _findIssPass(data, duskS, dawnS) {
  if (!data || !data.response) return null;
  var passes = data.response;
  for (var i = 0; i < passes.length; i++) {
    var rt = passes[i].risetime;
    if (rt >= duskS && rt <= dawnS) {
      return { risetime: rt, duration: passes[i].duration };
    }
  }
  return null;
}
