// test-shim.js — run with: node apps/astroclk/test-shim.js
// Mocks all Espruino globals so app.js can be evaluated in Node
// to catch syntax errors and basic runtime crashes.
const fs   = require("fs");
const path = require("path");
const vm   = require("vm");

// Load real suncalc into a sandbox context
let SunCalcReal = null;
try {
  const suncalcSrc = fs.readFileSync(
    path.join(__dirname, "../../modules/suncalc.js"), "utf8"
  );
  const ctx = { globalThis: {} };
  vm.createContext(ctx);
  vm.runInContext(suncalcSrc, ctx);
  SunCalcReal = ctx.globalThis.SunCalc || ctx.SunCalc;
  console.log("  suncalc loaded:", typeof SunCalcReal.getTimes);
} catch(e) {
  console.warn("  suncalc not loaded:", e.message);
}

// Load real zambretti
let zambrettiReal = null;
try {
  const zsrc = fs.readFileSync(path.join(__dirname, "zambretti.js"), "utf8");
  const zmod = { exports: {} };
  vm.runInNewContext(zsrc, { module: zmod, exports: zmod.exports });
  zambrettiReal = zmod.exports;
  console.log("  zambretti loaded:", typeof zambrettiReal.forecast);
} catch(e) {
  console.warn("  zambretti not loaded:", e.message);
}

// Build the sandbox context for app.js
const sandbox = {
  g: {
    getWidth:     () => 176,
    getHeight:    () => 176,
    reset:        () => {},
    clear:        () => {},
    setColor:     () => {},
    fillRect:     () => {},
    setFont:      () => {},
    setFontAlign: () => {},
    drawString:   () => {},
    stringWidth:  () => 40,
    drawLine:     () => {},
    fillCircle:   () => {},
    drawCircle:   () => {},
    fillEllipse:  () => {},
    toColor:      () => "#000000",
    drawImage:    () => {},
  },
  Bangle: {
    loadWidgets:     () => {},
    drawWidgets:     () => {},
    on:              () => {},
    removeListener:  () => {},
    getHealthStatus: () => ({ steps: 1234, bpm: 72 }),
    http:            null,
    setHRMPower:     () => {},
    setGPSPower:     () => {},
    getPressure:     () => Promise.resolve({ pressure: 1013 }),
  },
  E: {
    getBattery:  () => 80,
    showMenu:    () => {},
    showAlert:   () => Promise.resolve(),
    showMessage: () => {},
  },
  NRF: {
    getSecurityStatus: () => ({ connected: false }),
    on: () => {},
  },
  BTN1: 1,
  setWatch:      () => {},
  setInterval:   () => 0,
  setTimeout:    () => 0,
  clearTimeout:  () => {},
  clearInterval: () => {},
  load:          () => {},
  require: function(mod) {
    if (mod === "Storage") {
      return {
        readJSON:  () => null,
        writeJSON: () => {},
        read:      () => null,
        eval: (name) => {
          if (name === "astroclk.zambretti.js") return zambrettiReal;
          return null;
        },
      };
    }
    if (mod === "suncalc") return SunCalcReal;
    console.warn("  require('" + mod + "') stub");
    return {};
  },
  Math, Date, JSON, parseInt, parseFloat, isNaN, isFinite,
  console, Promise,
};

vm.createContext(sandbox);

console.log("\n=== Evaluating app.js ===");
let errors = 0;
try {
  const src = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  vm.runInContext(src, sandbox);
  console.log("  Top-level eval: OK");
} catch(e) {
  console.error("  CRASH during eval:", e.message);
  e.stack.split("\n").slice(0, 4).forEach(l => console.error(" ", l));
  errors++;
  process.exit(1);
}

const calls = [
  ["drawF1", "drawF1()"],
  ["drawF2", "drawF2()"],
  ["draw",   "draw()"],
];

for (const [name, expr] of calls) {
  try {
    vm.runInContext(expr, sandbox);
    console.log("  " + name + "(): OK");
  } catch(e) {
    console.error("  " + name + "() CRASH:", e.message);
    e.stack.split("\n").slice(1, 3).forEach(l => console.error("   ", l));
    errors++;
  }
}

console.log("\n=== Result:", errors === 0 ? "ALL PASS" : errors + " ERROR(S)", "===\n");
process.exit(errors > 0 ? 1 : 0);
