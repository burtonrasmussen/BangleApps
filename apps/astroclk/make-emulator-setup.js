// Run from BangleApps root: node apps/astroclk/make-emulator-setup.js
// Generates emulator-setup.js which you send once in the IDE to pre-load storage.
const fs = require("fs");
const path = require("path");
const BASE = path.join(__dirname, "../..");
const APP  = __dirname;

// Escape content for a JS template literal (backticks, backslashes, ${)
function esc(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/`/g,  "\\`")
    .replace(/\$\{/g, "\\${");
}

const suncalc = esc(fs.readFileSync(path.join(BASE, "modules/suncalc.js"), "utf8"));

const now = Date.now();
const weather = JSON.stringify({
  fetchedAt: now, cloudAtDusk: 25,
  iss: { risetime: Math.floor(now / 1000) + 3600, duration: 360 },
  hourly: [
    { hour: 21, cloud: 20, wind: 5,  precip: 0,  humidity: 55 },
    { hour: 22, cloud: 30, wind: 6,  precip: 0,  humidity: 58 },
    { hour: 23, cloud: 15, wind: 4,  precip: 0,  humidity: 52 },
    { hour: 0,  cloud: 10, wind: 3,  precip: 0,  humidity: 50 },
    { hour: 1,  cloud: 40, wind: 7,  precip: 5,  humidity: 62 },
  ]
});

const lines = [
  "// AstroWatch emulator setup — open in IDE and hit Send to Espruino",
  "// Do this ONCE before sending app.js",
  "require(\"Storage\").write(\"suncalc\", `" + suncalc + "`);",
  "require(\"Storage\").writeJSON(\"mylocation.json\", {lat:45.52,lon:-122.68,alt:50,accuracy:5});",
  "require(\"Storage\").writeJSON(\"astroclk.weather.json\", " + weather + ");",
  "require(\"Storage\").writeJSON(\"astroclk.settings.json\", {redMode:false,use24h:true,windUnit:\"mph\"});",
  "print(\"Storage ready — now open app.js and Send to Espruino\");",
];

const out = lines.join("\n") + "\n";
const outPath = path.join(APP, "emulator-setup.js");
fs.writeFileSync(outPath, out, "utf8");
console.log("Written:", outPath);
console.log("Size:", out.length, "bytes");
