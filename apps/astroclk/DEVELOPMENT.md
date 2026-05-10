# AstroWatch Development Guide

## Repo layout

```
Smartwatch/
  BangleApps/          ← main repo (your fork of espruino/BangleApps)
  EspruinoWebIDE/      ← sibling repo (espruino/EspruinoWebIDE, needed for emulator)
```

---

## First-time setup on a new computer

### 1. Prerequisites

- **Node.js** v18 or later — https://nodejs.org
- **Git**

### 2. Clone the repos

```bash
# Your fork of BangleApps
git clone https://github.com/burtonrasmussen/BangleApps.git
cd BangleApps
git remote add upstream https://github.com/espruino/BangleApps.git

# EspruinoWebIDE must live as a sibling folder
cd ..
git clone https://github.com/espruino/EspruinoWebIDE.git
cd EspruinoWebIDE
git submodule update --init --recursive   # ← CRITICAL: populates EspruinoTools
```

> The `--init --recursive` step is easy to forget. Without it the IDE gets
> stuck on "LOADING…" because all its scripts are 404.

### 3. Install Node dependencies

```bash
cd BangleApps
npm install
```

This installs `jimp` (screenshot), `eslint`, `http-server`, and other dev tools
listed in `package.json`.

### 4. Check out the feature branch

```bash
git checkout feature/astroclk
```

---

## Starting the development servers

You need **two** servers running simultaneously — open two separate terminals.

### Terminal 1 — BangleApp Loader (port 8080)

```bash
cd BangleApps
node bin/serve.js
```

If that doesn't exist, use the inline server (run from the `BangleApps` folder):

```bash
node -e "const h=require('http'),fs=require('fs'),path=require('path'),ROOT=process.cwd();h.createServer((q,s)=>{const f=path.join(ROOT,q.url.split('?')[0]);if(fs.existsSync(f)&&fs.statSync(f).isFile()){const m={'html':'text/html','js':'application/javascript','css':'text/css','json':'application/json','png':'image/png'}[path.extname(f).slice(1)]||'text/plain';s.writeHead(200,{'Content-Type':m,'Access-Control-Allow-Origin':'*'});fs.createReadStream(f).pipe(s);}else{s.writeHead(404);s.end('not found');}}).listen(8080,()=>console.log('http://localhost:8080'));"
```

Or if `npx` works: `npx http-server -p 8080 -c-1`

Browse to **http://localhost:8080** to see the BangleApps loader.

### Terminal 2 — Espruino Web IDE + emulator (port 8081)

Run from the `BangleApps` folder (it finds `EspruinoWebIDE` as a sibling automatically):

```bash
node apps/astroclk/serve-ide.js
```

That script is just a saved version of this one-liner (run from `BangleApps` folder):

```bash
node -e "const h=require('http'),fs=require('fs'),path=require('path'),ROOT=path.join(process.cwd(),'..','EspruinoWebIDE');h.createServer((q,s)=>{const f=path.join(ROOT,q.url.split('?')[0]);if(fs.existsSync(f)&&fs.statSync(f).isFile()){const m={'html':'text/html','js':'application/javascript','css':'text/css','json':'application/json','png':'image/png','wasm':'application/wasm'}[path.extname(f).slice(1)]||'text/plain';s.writeHead(200,{'Content-Type':m,'Access-Control-Allow-Origin':'*'});fs.createReadStream(f).pipe(s);}else{s.writeHead(404);s.end('not found');}}).listen(8081,()=>console.log('http://localhost:8081/index.html?emulator'));"
```

Browse to **http://localhost:8081/index.html?emulator** in Chrome. Wait ~10 seconds
for the Bangle.js 2 emulator popup to appear.

---

## Iterating on app.js in the interactive emulator

### Step 1 — Load storage dependencies (once per emulator session)

```bash
node apps/astroclk/make-emulator-setup.js
```

This regenerates `apps/astroclk/emulator-setup.js` with `suncalc`,
fake location, and fake weather data embedded as a single sendable script.

In the IDE: **open `emulator-setup.js`**, hit **Send to Espruino** (Ctrl+Enter).  
Wait for `Storage ready` to appear in the console.

You only need to redo this if you want fresh fake data.

### Step 2 — Send the app

In the IDE: **open `app.js`**, hit **Send to Espruino** (Ctrl+Enter).

The clock face renders in the emulator popup. You can:
- **Tap / click** the watch face
- **Swipe left/right** by dragging across the screen
- **Press BTN1** (the button on the right side of the emulator window)

Repeat Step 2 every time you edit `app.js`.

---

## Quick automated screenshot (no IDE needed)

```bash
cd BangleApps
node apps/astroclk/run-screenshot.js
```

Saves to `apps/astroclk/screenshot.png`. Useful for checking layout without
opening the IDE. Pass `--out path/file.png` to change the output path.

---

## Catch errors before testing

```bash
node apps/astroclk/test-shim.js
```

Runs `app.js` in a Node.js `vm` sandbox with all Espruino APIs stubbed out.
Calls `drawF1()`, `drawF2()`, and `draw()` explicitly. Exits with code 1 if
anything throws. Run this after every edit before opening the IDE.

---

## Updating the apps.local.json (needed by the loader)

The loader at `localhost:8080` needs `apps.local.json` to list locally available apps:

```bash
node -e "
  const fs=require('fs');
  const apps=fs.readdirSync('apps').filter(d=>
    !d.startsWith('_') && fs.existsSync('apps/'+d+'/metadata.json')
  );
  fs.writeFileSync(
    'apps.local.json',
    '['+apps.map(d=>fs.readFileSync('apps/'+d+'/metadata.json','utf8').trim()).join(',\n')+']'
  );
  console.log('done',apps.length,'apps');
"
```

---

## Sanity check and lint

```bash
node bin/sanitycheck.js        # validates all metadata.json files
npm test                       # sanitycheck + eslint
```

---

## Flashing to the physical watch

1. Start the loader: `http://localhost:8080`
2. Connect the watch via USB or Bluetooth
3. Find **AstroWatch** in the app list and click **Install**

The loader handles dependency resolution and uploads all required files.

---

## Git workflow

```bash
# Keep your branch up to date with upstream
git fetch upstream
git rebase upstream/master

# Push your changes
git push origin feature/astroclk
```

Active branch: `feature/astroclk`  
Your fork: `https://github.com/burtonrasmussen/BangleApps`  
Upstream: `https://github.com/espruino/BangleApps`

---

## File reference

| File | Purpose |
|------|---------|
| `apps/astroclk/app.js` | Main clock face (F1 + F2 screens) |
| `apps/astroclk/boot.js` | Startup: GPS sync, BLE fetch trigger |
| `apps/astroclk/fetch.js` | Gadgetbridge HTTP fetch for weather + ISS data |
| `apps/astroclk/zambretti.js` | Barometric forecast algorithm (no dependencies) |
| `apps/astroclk/settings.js` | Settings menu |
| `apps/astroclk/metadata.json` | App manifest for the BangleApps loader |
| `apps/astroclk/test-shim.js` | Node.js error checker — run before every IDE test |
| `apps/astroclk/run-screenshot.js` | Headless emulator screenshot |
| `apps/astroclk/make-emulator-setup.js` | Generates `emulator-setup.js` for IDE storage pre-load |
| `apps/astroclk/emulator-setup.js` | **Generated** — open in IDE once per session |
| `modules/suncalc.js` | Sun/moon calculations (shared BangleApps module) |
| `apps/astroclk/verify_weather.py` | Python weather verifier + night-sky chart |

---

## Weather provider selection

AstroWatch supports two weather sources, switchable in the watch settings menu under **"Weather Source"**:

| Provider | Cost | Fields | Coverage |
|----------|------|--------|----------|
| **OpenMeteo** (default) | Free, no key | Cloud, wind, precip, humidity | Global |
| **Astrospheric Pro** | Paid subscription | Cloud, wind, humidity, **seeing**, **transparency** | RDPS domain (N. America + parts of Europe) |

Astrospheric's astronomy-specific **seeing** (0–5 scale, 5=Excellent) and **transparency** (lower=better, includes smoke/aerosol) fields are surfaced in the watch display and Python verifier when that provider is active.  Astrospheric costs 5 credits per fetch; the free Pro tier gives 100 credits/day.

### Setting your Astrospheric API key

The key is stored in `astroclk.json` on the watch.  There is no on-screen keyboard for the full 64-character hex key, so set it via the **Espruino IDE console** (paste this as one line):

```js
require("Storage").writeJSON("astroclk.json", Object.assign(require("Storage").readJSON("astroclk.json") || {}, { astrosphericKey: "YOUR_64_CHAR_KEY_HERE" }))
```

Alternatively, open **App Loader → Flash Storage → `astroclk.json`**, add the `astrosphericKey` field manually, and save.

> **Do not commit your API key to Git.**  `astroclk.json` lives only on the watch and is not tracked by this repo.

### Selecting the provider on the watch

**Settings → Weather Source** toggles between `OpenMeteo` and `Astrospheric`.  If Astrospheric is selected but no key is stored, "Fetch Weather" will show an error and log it to `astroclk.log.json`.

### Using Astrospheric in the Python verifier

Edit the constants near the top of `verify_weather.py`:

```python
PROVIDER         = "astrospheric"       # "openmeteo" or "astrospheric"
ASTROSPHERIC_KEY = "49127ACC..."        # your key — do NOT commit
```

Then run as normal:

```powershell
py -3.11 "apps/astroclk/verify_weather.py"
```

The terminal output and chart will include **Seeing** and **Transparency** columns when Astrospheric data is active.

---

## Verifying weather data with the Python script

`verify_weather.py` fetches the exact same Open-Meteo data the watch uses and
renders an interactive dark-themed dashboard so you can sanity-check what the
watch is seeing without needing to read raw JSON.

### Prerequisites (one-time)

Requires Python 3.11 and three packages:

```powershell
py -3.11 -m pip install requests matplotlib astral skyfield
```

### Run it

```powershell
py -3.11 "apps/astroclk/verify_weather.py"
```

Or with a full path if not in the repo root:

```powershell
py -3.11 "c:\Users\burto\Documents\1 - Project Stuff\Smartwatch\BangleApps\apps\astroclk\verify_weather.py"
```

### What it does

1. Computes tonight's astronomical night window (dusk → dawn) using `astral`
2. Fetches the Open-Meteo hourly forecast for Salt Lake City with `&timezone=auto`
   (same URL the watch uses — so timestamps are already in local time)
3. Trims the forecast to the night window only
4. Downloads the current ISS TLE from Celestrak and predicts any visible passes
   using `skyfield`
5. Prints a text table to the terminal
6. Opens an interactive matplotlib window with:
   - Four colour-coded bar charts: cloud cover, precipitation probability, wind
     speed (mph), and humidity — **green** = good, **orange** = marginal,
     **red** = poor
   - Gold dashed vertical lines for ISS pass times (if any)
   - A per-hour observing quality table at the bottom (`[***] Excellent` →
     `[   ] Poor`) based on a weighted score of cloud + precip + wind
7. Saves `astroclk_night_forecast.png` alongside the script
8. Also writes `astroclk_raw_night.json` with the raw trimmed data for
   offline inspection

### Configuration

Edit the constants near the top of the script to change location:

```python
LAT  = 40.7608
LON  = -111.891
CITY = "Salt Lake City"
```

### Notes

- The script uses `&timezone=auto` in the Open-Meteo URL — this is mandatory.
  Without it the API returns UTC timestamps, which appear shifted by ~6 hours
  and cause the night-window filter to select the wrong hours.
- ISS data comes from `celestrak.org` TLEs via `skyfield`; the old
  `api.open-notify.org` / `allorigins.win` proxies are dead and are not used.
- The watch always stores `iss: null` in `astroclk.data.json` because no
  working HTTPS ISS pass API is currently available for Gadgetbridge to call.
