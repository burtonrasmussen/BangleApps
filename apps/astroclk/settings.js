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
    "HRM Interval": {
      value: [1, 5, 10, 30].indexOf(settings.hrmIntervalM || 5),
      min: 0, max: 3,
      format: function(v) { return [1, 5, 10, 30][v] + " min"; },
      onchange: function(v) { save("hrmIntervalM", [1, 5, 10, 30][v]); }
    },
    "GPS Sync Interval": {
      value: [12, 24, 48].indexOf(settings.gpsIntervalH || 24),
      min: 0, max: 2,
      format: function(v) { return [12, 24, 48][v] + "h"; },
      onchange: function(v) { save("gpsIntervalH", [12, 24, 48][v]); }
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
      require("Storage").eval("astroclk.fetch.js").fetch(
        function() { E.showAlert("Done!").then(function() { E.showMenu(menu); }); },
        function(e) { E.showAlert("Error:\n" + e).then(function() { E.showMenu(menu); }); }
      );
    },
    "Clear Weather Cache": function() {
      require("Storage").erase("astroclk.weather.json");
      E.showAlert("Cache cleared").then(function() { E.showMenu(menu); });
    }
  };

  E.showMenu(menu);
})
