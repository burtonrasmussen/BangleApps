const path = require("path");
const fs   = require("fs");
const BASE_DIR = path.join(__dirname, "../..");
const APP_DIR  = __dirname;

const outFile = (function() {
  const i = process.argv.indexOf("--out");
  return i !== -1 ? process.argv[i + 1] : path.join(APP_DIR, "screenshot.png");
})();

function storageWrite(filename, content) {
  const escaped = content.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
  return 'require("Storage").write(' + JSON.stringify(filename) + ', "' + escaped + '");\n';
}

function buildUploadCommands() {
  let cmds = "";
  const appFiles = [
    ["astroclk.app.js", "app.js"],
    ["astroclk.zambretti.js", "zambretti.js"],
    ["astroclk.boot.js", "boot.js"],
  ];
  for (const [storageName, localFile] of appFiles) {
    cmds += storageWrite(storageName, fs.readFileSync(path.join(APP_DIR, localFile), "utf8"));
  }
  cmds += storageWrite("suncalc", fs.readFileSync(path.join(BASE_DIR, "modules/suncalc.js"), "utf8"));
  cmds += storageWrite("FontVGA16", fs.readFileSync(path.join(APP_DIR, "FontVGA16.js"), "utf8"));
  cmds += 'require("Storage").writeJSON("mylocation.json", {"lat":45.52,"lon":-122.68,"alt":50,"accuracy":5});\n';
  const now = Date.now();
  const weather = '{"fetchedAt":' + now + ',"cloudAtDusk":25,"iss":{"risetime":' + (Math.floor(now/1000)+3600) + ',"duration":360},"hourly":[{"hour":21,"cloud":20,"wind":5,"precip":0,"humidity":55},{"hour":22,"cloud":30,"wind":6,"precip":0,"humidity":58},{"hour":23,"cloud":15,"wind":4,"precip":0,"humidity":52},{"hour":0,"cloud":10,"wind":3,"precip":0,"humidity":50}]}';
  cmds += 'require("Storage").writeJSON("astroclk.weather.json", ' + weather + ');\n';
  cmds += 'require("Storage").writeJSON("astroclk.settings.json", {"redMode":false,"use24h":true,"windUnit":"mph","hrmInterval":5});\n';
  return cmds;
}

const emu = require(BASE_DIR + "/core/lib/emulator.js");
let consoleBuf = "";

emu.init({
  EMULATOR: "banglejs2",
  DEVICEID: "BANGLEJS2",
  rxCallback: () => {},
  consoleOutputCallback: (line) => {
    consoleBuf += line + "\n";
    if (line.match(/Uncaught|^ERROR:|ASSERT FAILED/)) process.stderr.write("  [EMU ERROR] " + line + "\n");
  }
}).then(() => {
  console.log("Emulator ready. Writing files...");
  emu.tx(buildUploadCommands());
  for (let i = 0; i < 50; i++) emu.idle();
  console.log("Loading app...");
  emu.tx('load("astroclk.app.js")\n');
  for (let i = 0; i < 300; i++) emu.idle();
  console.log("Taking screenshot...");
  return emu.writeScreenshot(outFile, { errorIfBlank: true });
}).then(() => {
  console.log("Screenshot saved to " + outFile);
  const errs = consoleBuf.split("\n").filter(l => l.match(/Uncaught|ERROR:|ASSERT/));
  if (errs.length) { console.log("Emulator errors:"); errs.forEach(l => console.log("  " + l)); }
  process.exit(0);
}).catch(err => {
  console.error("Failed: " + err);
  console.log(consoleBuf.trim().split("\n").slice(-30).join("\n"));
  process.exit(1);
});