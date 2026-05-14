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
var LOG_FILE = "astroclk.log.json";

function log(msg) {
  var entry = new Date().toISOString().slice(11,19) + " " + msg;
  var lines = require("Storage").readJSON(LOG_FILE, 1) || [];
  lines.push(entry);
  if (lines.length > 20) lines = lines.slice(-20);
  require("Storage").writeJSON(LOG_FILE, lines);
}

function httpText(ev) {
  if (!ev) return "";
  if (typeof ev === "string") return ev;
  if (typeof ev.resp === "string") return ev.resp;
  return "";
}

function parseJson(ev, what) {
  // Surface HTTP error codes from Gadgetbridge
  if (ev && ev.status && ev.status >= 400) throw what + ": HTTP " + ev.status;
  var s = httpText(ev);
  if (!s) throw what + ": empty body";
  try { return JSON.parse(s); }
  catch (e) { throw what + ": bad JSON (" + s.slice(0, 40) + ")"; }
}

// n2yo.com visual passes — HTTPS direct, free tier (1000 req/hr), no proxy needed.
// Register free at https://www.n2yo.com/login/register/ to get an API key.
// Store it as n2yoKey in astroclk.json.
function issN2yoUrl(lat, lon, key) {
  return "https://api.n2yo.com/rest/v1/satellite/visualpasses/25544/" +
    lat.toFixed(4) + "/" + lon.toFixed(4) + "/0/2/60/&apiKey=" + key;
}

exports.fetch = function(onDone, onError) {
  log("fetch() called");

  if (typeof Bangle.http !== "function") {
    log("ERROR: Bangle.http not a function");
    if (onError) onError("Android Integration app not loaded");
    return;
  }
  log("Bangle.http OK");

  if (!NRF.getSecurityStatus || !NRF.getSecurityStatus().connected) {
    log("ERROR: BT not connected");
    if (onError) onError("Bluetooth not connected");
    return;
  }
  log("BT connected");

  var loc = require("Storage").readJSON("mylocation.json", 1);
  if (!loc || !loc.lat || !loc.lon) {
    loc = { lat: 40.7608, lon: -111.891, location: "Salt Lake City" };
    require("Storage").writeJSON("mylocation.json", loc);
  }
  log("loc=" + loc.lat.toFixed(3) + "," + loc.lon.toFixed(3));
  var lat = loc.lat;
  var lon = loc.lon;

  var cfg = require("Storage").readJSON("astroclk.json", 1) || {};
  var provider  = cfg.weatherProvider  || "openmeteo";
  var astroKey  = cfg.astrosphericKey  || "";
  var n2yoKey   = cfg.n2yoKey           || "";

  // If using Astrospheric but no key stored yet, write the default key.
  // Users publishing the app should replace this with their own key or clear it.
  if (provider === "astrospheric" && !astroKey) {
    astroKey = "49127ACC9AD52E6D09D069C37819CC28F5FCA6766A0710454175402E5A0D2FB44EE9C743";
    cfg.astrosphericKey = astroKey;
    require("Storage").writeJSON("astroclk.json", cfg);
    log("wrote default Astrospheric key to astroclk.json");
  }
  log("provider=" + provider);

  var duskMs, dawnMs;
  try {
    var SunCalc = require("suncalc");
    log("SunCalc loaded");
    var now  = new Date();
    var times = SunCalc.getTimes(now, lat, lon);
    var dusk  = times.night        || times.nauticalDusk || times.dusk;
    var dawn  = SunCalc.getTimes(new Date(now.getTime() + 86400000), lat, lon).nightEnd
                || SunCalc.getTimes(new Date(now.getTime() + 86400000), lat, lon).nauticalDawn
                || SunCalc.getTimes(new Date(now.getTime() + 86400000), lat, lon).dawn;
    duskMs = dusk ? dusk.getTime() : now.getTime();
    dawnMs = dawn ? dawn.getTime() : duskMs + 8 * 3600000;
    log("dusk=" + new Date(duskMs).toISOString().slice(11,16) + " dawn=" + new Date(dawnMs).toISOString().slice(11,16));
  } catch(e) {
    log("ERROR SunCalc: " + e);
    if (onError) onError("SunCalc: " + e);
    return;
  }

  // Branch: Astrospheric Pro or free Open-Meteo
  if (provider === "astrospheric" && astroKey) {
    _fetchAstrospheric(lat, lon, astroKey, duskMs, dawnMs, onDone, onError);
    return;
  }

  var meteoUrl = "https://api.open-meteo.com/v1/forecast" +
    "?latitude=" + lat.toFixed(4) +
    "&longitude=" + lon.toFixed(4) +
    "&hourly=cloud_cover,wind_speed_10m,precipitation_probability,relative_humidity_2m" +
    "&forecast_days=2" +
    "&timezone=auto";

  log("calling Bangle.http meteo");
  E.showMessage("1/2 Weather...");
  Bangle.http(meteoUrl, HTTP_OPTS).then(function(resp) {
    log("meteo resp len=" + (resp && resp.resp ? resp.resp.length : typeof resp));
    var meteoData;
    try { meteoData = parseJson(resp, "Meteo"); }
    catch (e) { log("ERROR parse: " + e); if (onError) onError(e); return; }
    log("meteo JSON OK");

    var hourly = _trimMeteo(meteoData, duskMs, dawnMs);
    log("trimmed hours=" + hourly.length);

    // --- Step 2: ISS passes ---
    if (!n2yoKey) {
      log("ISS skipped: no n2yoKey in astroclk.json");
      var result = {
        fetchedAt:   Date.now(),
        hourly:      hourly,
        cloudAtDusk: hourly.length ? hourly[0].cloud : null,
        iss:         null
      };
      require("Storage").writeJSON("astroclk.weather.json", result);
      log("DONE (no ISS key)");
      if (onDone) onDone(result);
      return;
    }
    var issUrl = issN2yoUrl(lat, lon, n2yoKey);
    log("ISS url=" + issUrl);
    E.showMessage("2/2 ISS...");
    Bangle.http(issUrl, HTTP_OPTS).then(function(resp2) {
      log("ISS resp len=" + (resp2 && resp2.resp ? resp2.resp.length : typeof resp2));
      if (resp2 && resp2.status) log("ISS http status=" + resp2.status);
      var issData = null;
      try { issData = parseJson(resp2, "ISS"); } catch(e) { log("ISS parse err: " + e); }

      var issPass = _findIssPass(issData, duskMs / 1000, dawnMs / 1000);
      if (issPass) {
        var rt = new Date(issPass.risetime * 1000);
        log("ISS pass=" + rt.toISOString().slice(0,16).replace("T"," ") + " local (" + issPass.duration + "s)");
      } else {
        log("ISS pass=none");
      }

      var result = {
        fetchedAt:   Date.now(),
        hourly:      hourly,
        cloudAtDusk: hourly.length ? hourly[0].cloud : null,
        iss:         issPass
      };
      require("Storage").writeJSON("astroclk.weather.json", result);
      log("DONE");
      if (onDone) onDone(result);

    }).catch(function(e) {
      var eStr = (typeof e === "object") ? JSON.stringify(e) : "" + e;
      log("ISS fetch failed: " + eStr);
      var result = {
        fetchedAt:   Date.now(),
        hourly:      hourly,
        cloudAtDusk: hourly.length ? hourly[0].cloud : null,
        iss:         null
      };
      require("Storage").writeJSON("astroclk.weather.json", result);
      log("DONE (no ISS)");
      if (onDone) onDone(result);
    });

  }).catch(function(e) {
    log("ERROR http meteo: " + e);
    if (onError) onError("Meteo fetch failed: " + e);
  });
};

// --- Helpers ---

// Astrospheric Pro: POST GetForecastData_V1, trim to night, save result.
function _fetchAstrospheric(lat, lon, key, duskMs, dawnMs, onDone, onError) {
  var url  = "https://astrosphericpublicaccess.azurewebsites.net/api/GetForecastData_V1";
  var body = JSON.stringify({ Latitude: lat, Longitude: lon, APIKey: key });
  var opts = {
    timeout: 50000,
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    body
  };

  // Local watchdog — Gadgetbridge occasionally silently drops POST requests
  // without firing .catch(). After 55 s we give up regardless.
  var _done = false;
  var _wd = setTimeout(function() {
    if (_done) return;
    _done = true;
    log("ERROR Astrospheric: local watchdog fired (no response after 55s)");
    if (onError) onError("Astrospheric timed out");
  }, 55000);

  log("astro POST body-len=" + body.length);
  E.showMessage("1/2 Astrospheric...");
  Bangle.http(url, opts).then(function(resp) {
    if (_done) return; _done = true; clearTimeout(_wd);
    var rawStr = (resp && resp.resp) ? resp.resp : "";
    log("astro resp len=" + rawStr.length);
    if (!rawStr) { log("ERROR: empty resp"); if (onError) onError("empty resp"); return; }
    // Extract credit usage before clearing rawStr (response field APICreditUsedToday)
    var credits = _numField(rawStr, "APICreditUsedToday");
    if (credits !== null) log("credits used today=" + credits);
    var hourly;
    try { hourly = _parseAstrosphericRaw(rawStr, duskMs, dawnMs); rawStr = null; }
    catch(e) { log("ERROR parse: " + e); if (onError) onError("" + e); return; }
    log("trimmed hours=" + hourly.length);

    // Step 2: ISS passes (n2yo.com)
    if (!n2yoKey) {
      log("ISS skipped: no n2yoKey in astroclk.json");
      var result2 = {
        fetchedAt:        Date.now(),
        provider:         "astrospheric",
        hourly:           hourly,
        cloudAtDusk:      hourly.length ? hourly[0].cloud : null,
        creditsUsedToday: credits,
        iss:              null
      };
      require("Storage").writeJSON("astroclk.weather.json", result2);
      log("DONE (no ISS key)");
      if (onDone) onDone(result2);
      return;
    }
    var issUrl = issN2yoUrl(lat, lon, n2yoKey);
    log("ISS url=" + issUrl);
    E.showMessage("2/2 ISS...");
    Bangle.http(issUrl, HTTP_OPTS).then(function(resp2) {
      var issData = null;
      if (resp2 && resp2.status) log("ISS http status=" + resp2.status);
      try { issData = parseJson(resp2, "ISS"); } catch(e) { log("ISS parse err: " + e); }
      var issPass = _findIssPass(issData, duskMs / 1000, dawnMs / 1000);
      if (issPass) {
        var rt = new Date(issPass.risetime * 1000);
        log("ISS pass=" + rt.toISOString().slice(0,16).replace("T"," ") + " local (" + issPass.duration + "s)");
      } else {
        log("ISS pass=none");
      }
      var result = {
        fetchedAt:        Date.now(),
        provider:         "astrospheric",
        hourly:           hourly,
        cloudAtDusk:      hourly.length ? hourly[0].cloud : null,
        creditsUsedToday: credits,
        iss:              issPass
      };
      require("Storage").writeJSON("astroclk.weather.json", result);
      log("DONE");
      if (onDone) onDone(result);
    }).catch(function(e) {
      var eStr = (typeof e === "object") ? JSON.stringify(e) : "" + e;
      log("ISS fetch failed: " + eStr);
      var result = {
        fetchedAt:        Date.now(),
        provider:         "astrospheric",
        hourly:           hourly,
        cloudAtDusk:      hourly.length ? hourly[0].cloud : null,
        creditsUsedToday: credits,
        iss:              null
      };
      require("Storage").writeJSON("astroclk.weather.json", result);
      log("DONE (no ISS)");
      if (onDone) onDone(result);
    });
  }).catch(function(e) {
    if (_done) return; _done = true; clearTimeout(_wd);
    log("ERROR http Astrospheric: " + e);
    if (onError) onError("Astrospheric fetch failed: " + e);
  });
}

// Extract a quoted string value for a named field from a raw JSON string.
// Handles optional whitespace after the colon.
function _strField(str, key) {
  var k = '"' + key + '"';
  var i = str.indexOf(k);
  if (i < 0) return null;
  i = str.indexOf(':', i + k.length);
  if (i < 0) return null;
  i++;
  while (i < str.length && str[i] === ' ') i++;
  if (str[i] !== '"') return null;
  i++;
  var e = str.indexOf('"', i);
  return e < 0 ? null : str.slice(i, e);
}

// Extract an unquoted numeric value for a named field from a raw JSON string.
function _numField(str, key) {
  var k = '"' + key + '"';
  var i = str.indexOf(k);
  if (i < 0) return null;
  i = str.indexOf(':', i + k.length);
  if (i < 0) return null;
  i++;
  while (i < str.length && str[i] === ' ') i++;
  var e = i;
  while (e < str.length && str[e] !== ',' && str[e] !== '}' && str[e] !== ']') e++;
  var v = parseFloat(str.slice(i, e));
  return isNaN(v) ? null : v;
}

// Parse Astrospheric response using indexOf-only extraction.
// Never calls JSON.parse on the full response or any sub-array,
// so peak memory = rawStr + 6 flat number arrays (81 nums each).
function _parseAstrosphericRaw(rawStr, duskMs, dawnMs) {
  // API errors come as "Error":"message" (null means no error, won't match)
  var apiErr = _strField(rawStr, "Error");
  if (apiErr) throw "API: " + apiErr;

  // UTCStartTime has a Z suffix so Espruino parses it unambiguously as UTC.
  var utcStart = _strField(rawStr, "UTCStartTime");
  if (!utcStart) throw "no UTCStartTime";
  var startMs = new Date(utcStart).getTime();
  if (isNaN(startMs)) throw "bad UTCStartTime: " + utcStart;
  log("startMs OK");

  // Which hour indices fall in tonight's window?
  var idxs = [];
  for (var ii = 0; ii < 81; ii++) {
    var t = startMs + ii * 3600000;
    if (t >= duskMs && t <= dawnMs) idxs.push(ii);
  }
  if (!idxs.length) { log("0 night hrs"); return []; }

  // Extract up to 81 numbers from a named array field.
  // Handles {Value:N,...} objects by scanning for "Value": patterns,
  // and plain number arrays via a bracket-counted slice + JSON.parse.
  // Uses only indexOf (C-level) for all scanning — no JS char loops over
  // the full 41KB rawStr.
  function extractNums(key) {
    var ki = rawStr.indexOf('"' + key + '"');
    if (ki < 0) return null;
    var ai = rawStr.indexOf('[', ki);
    if (ai < 0) return null;

    var nums = [];
    // Each element is {"Value":{"ValueColor":"#...","ActualValue":N},"HourOffset":M}
    // Search for "ActualValue": (14 chars) to extract the numeric value directly.
    var vk = '"ActualValue":';
    var vi = rawStr.indexOf(vk, ai + 1);

    if (vi >= 0 && vi < ai + 10000) {
      // Object array — extract ActualValue numbers via indexOf, no parse
      while (vi >= 0 && nums.length < 81) {
        var ns = vi + 14;
        var ne = rawStr.indexOf(',', ns);
        var ne2 = rawStr.indexOf('}', ns);
        if (ne < 0 || (ne2 >= 0 && ne2 < ne)) ne = ne2;
        if (ne < 0) break;
        nums.push(parseFloat(rawStr.slice(ns, ne)));
        vi = rawStr.indexOf(vk, ne);
      }
    } else {
      // Plain number array [1,2,3,...] — find end bracket, parse slice only
      var depth = 0, i = ai;
      while (i < rawStr.length) {
        var c = rawStr[i++];
        if (c === '[') depth++;
        else if (c === ']') { if (!--depth) break; }
      }
      try { nums = JSON.parse(rawStr.slice(ai, i)); } catch(ex) { return null; }
    }
    return nums.length ? nums : null;
  }

  var clouds = extractNums("RDPS_CloudCover");    log("c");
  var seeing = extractNums("Astrospheric_Seeing"); log("s");
  var trans  = extractNums("Astrospheric_Transparency"); log("t");
  var wind   = extractNums("RDPS_WindVelocity");   log("w");
  var temp   = extractNums("RDPS_Temperature");    log("T");
  var dew    = extractNums("RDPS_DewPoint");       log("d");

  var result = [];
  for (var j = 0; j < idxs.length; j++) {
    var i = idxs[j];
    var tMs = startMs + i * 3600000;
    var T   = temp  ? temp[i]  : null;  // Kelvin
    var Td  = dew   ? dew[i]   : null;
    var hum = null;
    if (T !== null && Td !== null && !isNaN(T) && !isNaN(Td)) {
      var Tc  = T  - 273.15;
      var Tdc = Td - 273.15;
      hum = Math.round(100 * Math.exp(17.62*Tdc/(243.12+Tdc)) /
                             Math.exp(17.62*Tc /(243.12+Tc)));
      hum = Math.max(0, Math.min(100, hum));
    }
    var w  = wind ? wind[i] : null;
    var dt = new Date(tMs);
    result.push({
      hour:         ("0"+dt.getHours()).slice(-2)+":"+("0"+dt.getMinutes()).slice(-2),
      cloud:        clouds ? Math.round(clouds[i])         : null,
      wind:         (w !== null && !isNaN(w)) ? Math.round(w * 3.6 * 10) / 10 : null,
      precip:       null,
      humidity:     hum,
      seeing:       seeing ? Math.round(seeing[i] * 10) / 10 : null,
      transparency: trans  ? Math.round(trans[i])          : null
    });
  }
  return result;
}

// Trim Open-Meteo hourly array to hours that fall inside [duskMs, dawnMs]
// Estimate seeing (0-5, higher=better) from wind (km/h) and humidity (%).
// Start at 4 (good), penalise wind >10 km/h and humidity >60%.
function _estSeeing(windKmh, humPct) {
  if (windKmh === null || windKmh === undefined) return null;
  if (humPct  === null || humPct  === undefined) return null;
  var s = 4.0 - Math.max(0, windKmh - 10) / 10
              - Math.max(0, humPct  - 60) / 80;
  return Math.round(Math.max(0, Math.min(5, s)) * 10) / 10;
}

// Estimate transparency (5-29, lower=better) from humidity and precip probability.
function _estTransp(humPct, precipPct) {
  if (humPct === null || humPct === undefined) return null;
  var t = 5 + humPct * 0.20 + (precipPct || 0) * 0.04;
  return Math.max(5, Math.min(29, Math.round(t)));
}

function _trimMeteo(data, duskMs, dawnMs) {
  if (!data || !data.hourly || !data.hourly.time) return [];
  var times   = data.hourly.time;          // ISO strings "2026-05-08T22:00"
  var cloud   = data.hourly.cloud_cover;
  var wind    = data.hourly.wind_speed_10m;
  var precip  = data.hourly.precipitation_probability;
  var hum     = data.hourly.relative_humidity_2m;

  var result = [];
  for (var i = 0; i < times.length; i++) {
    var tMs = new Date(times[i]).getTime();
    if (tMs < duskMs || tMs > dawnMs) continue;
    var w = wind  ? wind[i]  : null;
    var h = hum   ? hum[i]   : null;
    var p = precip? precip[i]: null;
    result.push({
      hour:         times[i].slice(11, 16),   // "HH:MM"
      cloud:        cloud ? cloud[i] : null,
      wind:         w,
      precip:       p,
      humidity:     h,
      seeing:       _estSeeing(w, h),     // estimated from wind+humidity
      transparency: _estTransp(h, p)     // estimated from humidity+precip
    });
  }
  return result;
}

// Find the first ISS pass whose risetime falls inside tonight [duskS, dawnS] (unix seconds)
// Handles n2yo response: { passes: [{ startUTC, duration, maxEl, ... }] }
function _findIssPass(data, duskS, dawnS) {
  if (!data || !data.passes) return null;
  var passes = data.passes;
  for (var i = 0; i < passes.length; i++) {
    var rt = passes[i].startUTC;
    if (rt >= duskS && rt <= dawnS) {
      return { risetime: rt, duration: passes[i].duration };
    }
  }
  return null;
}
