# AstroWatch (`astroclk`)

Astronomy-focused watch face for Bangle.js 2. Purpose-built for amateur astronomical observing sessions.

## Screens

| Screen | Access |
|--------|--------|
| **F1 — Main face** | Default / wrist-raise |
| **F2 — Hourly conditions** | Swipe left from F1 (Swipe right to return) |
| **F3 — Settings & Menu** | Swipe right from F1 |
| **Bangle.js Launcher** | Physical button (BTN1) on F1 |

### F1 — Main Clock Face

- Large time display (12h or 24h, configurable)
- Date, step count
- Moon phase icon + illumination % + phase name
- Moon rise / moon set times
- Astronomical dusk and dawn times
- Cloud cover % at astronomical dusk tonight (fetched via Gadgetbridge)
- ISS visible pass time tonight (if any)
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

## Settings (Swipe Right from F1 → menu, or via Bangle App Settings)

| Setting | Options |
|---------|---------|
| Red Mode | Remaps display to red-only palette for night vision |
| 24h / 12h | Clock format |
| Wind Unit | mph / km/h |
| GPS Sync Interval | 12h / 24h / 48h |
| Manual GPS Sync | Trigger immediate GPS time sync |
| Fetch Weather Now | Pull latest weather + ISS data via Gadgetbridge |
| Clear Weather Cache | Remove cached weather data |

## File Structure

```
apps/astroclk/
  app.js            ← Main clock face (F1 + F2 + navigation)
  boot.js           ← Startup: GPS sync, BLE fetch trigger
  settings.js       ← Settings menu
  fetch.js          ← Gadgetbridge HTTP: Open-Meteo + Open-Notify
  metadata.json
  app.png
  app-icon.js
```

## Data Files Written to Flash

| File | Purpose | Max size |
|------|---------|---------|
| `astroclk.json` | Settings | ~200 B |
| `astroclk.sync.json` | Last GPS sync time | ~50 B |
| `astroclk.weather.json` | Cached weather + ISS data | ~3 KB |
