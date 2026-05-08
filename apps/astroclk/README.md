# AstroWatch (`astroclk`)

Astronomy-focused watch face for Bangle.js 2. Purpose-built for amateur astronomical observing sessions.

## Screens

| Screen | Access |
|--------|--------|
| **F1 — Main face** | Default / wrist-raise |
| **F2 — Hourly conditions** | Swipe left or right |
| **Menu** | Long-press BTN1 |

### F1 — Main Clock Face

- Large time display (12h or 24h, configurable)
- Date, step count, heart rate (last HRM poll)
- Moon phase icon + illumination % + phase name
- Moon rise / moon set times
- Astronomical dusk and dawn times
- Cloud cover % at astronomical dusk tonight (fetched via Gadgetbridge)
- ISS visible pass time tonight (if any)
- Barometer trend arrow + Zambretti forecast string
- Battery % and BLE connection indicator

### F2 — Hourly Sky Conditions

Hourly breakdown for tonight's astronomical night window:
- Hour, cloud%, wind speed, precipitation probability, humidity

Data is fetched from [Open-Meteo](https://open-meteo.com) (free, no API key required) and trimmed to the astronomical night hours before being stored on-device.

## Dependencies

- **MyLocation** — stores your GPS coordinates (`mylocation.json`). Set your location there before first use, or use "Manual GPS Sync" in the AstroWatch menu.
- **Gadgetbridge** (Android) — required for weather and ISS data fetches. All astronomical calculations (moon phase, rise/set, dusk/dawn) work fully offline.

## Data Sources

| Data | Source | Fetch frequency |
|------|--------|-----------------|
| Weather (cloud, wind, precip, humidity) | Open-Meteo API | Once per day |
| ISS passes tonight | Open-Notify API | Once per day |
| Moon phase, rise/set, dusk/dawn | suncalc module (on-device) | Every minute |
| Barometric forecast | Zambretti algorithm (on-device) | Every 15 min sample |

## Settings (Long-press BTN1 → menu, or via the Bangle.js App Loader)

| Setting | Options |
|---------|---------|
| Red Mode | Remaps display to red-only palette for night vision |
| 24h / 12h | Clock format |
| Wind Unit | mph / km/h |
| HRM Interval | 1 / 5 / 10 / 30 minutes |
| GPS Sync Interval | 12h / 24h / 48h |
| Manual GPS Sync | Trigger immediate GPS time sync |
| Fetch Weather Now | Pull latest weather + ISS data via Gadgetbridge |
| Clear Weather Cache | Remove cached weather data |

## File Structure

```
apps/astroclk/
  app.js            ← Main clock face (F1 + F2 + navigation)
  boot.js           ← Startup: GPS sync, HRM polling, pressure sampling, BLE fetch trigger
  settings.js       ← Settings menu
  fetch.js          ← Gadgetbridge HTTP: Open-Meteo + Open-Notify
  zambretti.js      ← Barometric forecast algorithm (pure JS, no dependencies)
  metadata.json
  app.png
  app-icon.js
```

## Data Files Written to Flash

| File | Purpose | Max size |
|------|---------|---------|
| `astroclk.json` | Settings | ~200 B |
| `astroclk.sync.json` | Last GPS sync time | ~50 B |
| `astroclk.pressure.json` | 3-hour pressure ring buffer | ~300 B |
| `astroclk.weather.json` | Cached weather + ISS data | ~3 KB |
| `astroclk.hrm.json` | 24h HRM log | ~3 KB |
