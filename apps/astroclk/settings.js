// astroclk.settings.js
(function(back) {
  var SETTINGS_FILE = "astroclk.json";
  var SYNC_FILE     = "astroclk.sync.json";

  var settings = require("Storage").readJSON(SETTINGS_FILE, 1) || {};

  function save(key, value) {
    settings[key] = value;
    require("Storage").writeJSON(SETTINGS_FILE, settings);
  }

  var menu = {
    "": { title: "AstroWatch" },
    "< Back": back,
    "Red Mode": {
      value: !!settings.redMode,
      onchange: function(v) { save("redMode", v); }
    },
    "24h / 12h": {
      value: !!settings.use12h,
      format: function(v) { return v ? "12h" : "24h"; },
      onchange: function(v) { save("use12h", v); }
    },
    "Wind Unit": {
      value: settings.windUnit === "kmh" ? 1 : 0,
      min: 0, max: 1,
      format: function(v) { return v ? "km/h" : "mph"; },
      onchange: function(v) { save("windUnit", v ? "kmh" : "mph"); }
    },
    "Weather Source": {
      value: settings.weatherProvider === "astrospheric" ? 1 : 0,
      min: 0, max: 1,
      format: function(v) { return v ? "Astrospheric" : "OpenMeteo"; },
      onchange: function(v) { save("weatherProvider", v ? "astrospheric" : "openmeteo"); }
    },
    "Astro API Key": function() {
      var key = settings.astrosphericKey || "";
      var preview = key.length ? key.slice(0, 8) + "..." : "Not set";
      E.showScroller({
        h: 16, c: 5,
        draw: function(i, r) {
          g.setColor(1,1,1).fillRect(r.x,r.y,r.x+r.w,r.y+r.h);
          g.setColor(0,0,0).setFont("6x8");
          var lines = [
            "Key: " + preview,
            "Set via IDE console:",
            "require('Storage')",
            ".writeJSON('astroclk.json',",
            "Object.assign(require('Storage')"
          ];
          g.drawString(lines[i] || "", r.x+2, r.y+4);
        },
        select: function() { E.showMenu(menu); }
      });
    },
    "GPS Sync Interval": {
      value: [12, 24, 48].indexOf(settings.gpsIntervalH || 24),
      min: 0, max: 2,
      format: function(v) { return [12, 24, 48][v] + "h"; },
      onchange: function(v) { save("gpsIntervalH", [12, 24, 48][v]); }
    },
    "Set Location": function() {
      var cities = ["London","Edinburgh","Manchester","Birmingham","Bristol","Cardiff","Belfast","Dublin","Paris","Berlin","Amsterdam","Brussels","Zurich","Vienna","Rome","Madrid","Lisbon","Stockholm","Oslo","Copenhagen","Helsinki","Warsaw","Prague","Athens","Istanbul","Toronto","Montreal","Vancouver","New York","Boston","Washington DC","Chicago","Denver","Seattle","San Francisco","Los Angeles","Phoenix","Dallas","Houston","Miami","Atlanta","Sydney","Melbourne","Auckland","Tokyo","Singapore","Dubai","Cape Town","Johannesburg","Cairo"];
      var lats =   [51.5072,55.9533,53.4808,52.4862,51.4545,51.4816,54.5973,53.3498,48.8566,52.52,52.3676,50.8503,47.3769,48.2082,41.9028,40.4168,38.7169,59.3293,59.9139,55.6761,60.1699,52.2297,50.0755,37.9838,41.0082,43.7,45.5017,49.2827,40.7128,42.3601,38.9072,41.8781,39.7392,47.6062,37.7749,34.0522,33.4484,32.7767,29.7604,25.7617,33.749,-33.8688,-37.8136,-36.9,35.6762,1.3521,25.2048,-33.9249,-26.2041,30.0444];
      var lons =   [-0.1276,-3.1883,-2.2426,-1.8904,-2.5879,-3.1791,-5.9301,-6.2603,2.3522,13.405,4.9041,4.3517,8.5417,16.3738,12.4964,-3.7038,-9.1399,18.0686,10.7522,12.5683,24.9384,21.0122,14.4378,23.7275,28.9784,-79.4,-73.5673,-123.1207,-74.006,-71.0589,-77.0369,-87.6298,-104.9903,-122.3321,-122.4194,-118.2437,-112.074,-96.797,-95.3698,-80.1918,-84.388,151.2093,144.9631,174.7832,139.6503,103.8198,55.2708,18.4241,28.0473,31.2357];
      var loc = require("Storage").readJSON("mylocation.json", 1) || {};
      var curIdx = 0;
      if (loc.lat) {
        var best = 999;
        for (var i = 0; i < lats.length; i++) {
          var d = Math.abs(lats[i] - loc.lat);
          if (d < best) { best = d; curIdx = i; }
        }
      }
      E.showMenu({
        "": { title: "Set Location" },
        "< Back": function() { E.showMenu(menu); },
        "City": {
          value: curIdx,
          min: 0, max: cities.length - 1,
          format: function(v) { return cities[v]; },
          onchange: function(v) {
            var l = require("Storage").readJSON("mylocation.json", 1) || {};
            l.lat = lats[v]; l.lon = lons[v]; l.location = cities[v];
            require("Storage").writeJSON("mylocation.json", l);
          }
        }
      });
    },
    "Manual GPS Sync": function() {
      E.showMessage("GPS Syncing...\n(up to 3 min)");
      require("Storage").writeJSON(SYNC_FILE, { lastGPSSync: 0 }); // force sync
      // The boot.js logic will run on next reboot; trigger here directly
      var timeout = setTimeout(function() {
        Bangle.setGPSPower(0, "astroclkSettings");
        E.showAlert("GPS timeout").then(back);
      }, 3 * 60 * 1000);
      Bangle.setGPSPower(1, "astroclkSettings");
      Bangle.on("GPS", function onGPS(fix) {
        if (!fix.fix) return;
        setTime(fix.time.getTime() / 1000);
        clearTimeout(timeout);
        Bangle.setGPSPower(0, "astroclkSettings");
        Bangle.removeListener("GPS", onGPS);
        var loc = require("Storage").readJSON("mylocation.json", 1) || {};
        loc.lat = fix.lat; loc.lon = fix.lon;
        require("Storage").writeJSON("mylocation.json", loc);
        require("Storage").writeJSON(SYNC_FILE, { lastGPSSync: Date.now() });
        E.showAlert("GPS synced!").then(back);
      });
    },
    "Fetch Weather Now": function() {
      if (typeof Bangle.http !== "function") {
        E.showAlert("Android Integration\nnot installed").then(function() { E.showMenu(menu); });
        return;
      }
      if (!NRF.getSecurityStatus || !NRF.getSecurityStatus().connected) {
        E.showAlert("Bluetooth\nnot connected").then(function() { E.showMenu(menu); });
        return;
      }
      E.showMessage("Fetching...");
      try {
        var exports = {};
        eval(require("Storage").read("astroclk.fetch.js"));
        exports.fetch(
          function() { E.showAlert("Done!").then(function() { E.showMenu(menu); }); },
          function(e) { E.showAlert("Error:\n" + e).then(function() { E.showMenu(menu); }); }
        );
      } catch(e) { E.showAlert("Load error:\n" + e).then(function() { E.showMenu(menu); }); }
    },
    "Clear Weather Cache": function() {
      require("Storage").erase("astroclk.weather.json");
      E.showAlert("Cache cleared").then(function() { E.showMenu(menu); });
    }
  };

  E.showMenu(menu);
})
