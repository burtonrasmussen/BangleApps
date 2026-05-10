"""
verify_weather.py
Fetches and visualises the exact same Open-Meteo data the AstroWatch face
uses, so you can verify it matches real-world sky conditions.

Requirements:
    pip install requests matplotlib astral
"""

import json
import math
import datetime
import urllib.parse

try:
    import requests
except ImportError:
    raise SystemExit("Run: pip install requests matplotlib astral")

# ── Configuration ─────────────────────────────────────────────────────────────
LAT  = 40.7608
LON  = -111.891
CITY = "Salt Lake City"

# Weather provider: "openmeteo" (free) or "astrospheric" (Pro — needs API key)
PROVIDER = "openmeteo"
# Your Astrospheric API key — do NOT commit this to version control.
ASTROSPHERIC_KEY = "49127ACC9AD52E6D09D069C37819CC28F5FCA6766A0710454175402E5A0D2FB44EE9C743"
# ─────────────────────────────────────────────────────────────────────────────

def fetch(url: str) -> dict:
    print(f"  GET {url[:80]}...")
    r = requests.get(url, timeout=20)
    r.raise_for_status()
    return r.json()


def get_astro_night(lat: float, lon: float) -> tuple[datetime.datetime, datetime.datetime]:
    """Return (astro_dusk_local, astro_dawn_local) for tonight using astral."""
    try:
        from astral import LocationInfo
        from astral.sun import sun
        import zoneinfo, dateutil.tz

        # Try to guess local timezone from the OS
        local_tz = datetime.datetime.now().astimezone().tzinfo

        loc = LocationInfo(latitude=lat, longitude=lon, timezone=str(local_tz))
        today    = datetime.date.today()
        tomorrow = today + datetime.timedelta(days=1)

        s_today    = sun(loc.observer, date=today,    tzinfo=local_tz)
        s_tomorrow = sun(loc.observer, date=tomorrow, tzinfo=local_tz)

        dusk = s_today.get("astronomical_dusk") or s_today.get("dusk")
        dawn = s_tomorrow.get("astronomical_dawn") or s_tomorrow.get("dawn")
        return dusk, dawn

    except Exception as e:
        print(f"  [astral not available or error: {e}] — using simple sun approximation")
        return _simple_astro_night(lat, lon)


def _simple_astro_night(lat: float, lon: float):
    """Fallback: estimate astronomical dusk/dawn without astral using NOAA algorithm."""
    now = datetime.datetime.now()
    # Approximate: astronomical twilight ends ~1.5 h after civil sunset,
    # starts ~1.5 h before civil sunrise.  Good to ±20 min for mid-latitudes.
    day_of_year = now.timetuple().tm_yday
    # Equation of time + declination (Spencer, 1971)
    B   = 2 * math.pi * (day_of_year - 81) / 364
    eot = 9.87 * math.sin(2*B) - 7.53 * math.cos(B) - 1.5 * math.sin(B)  # minutes
    # Solar noon (UTC)
    lon_correction = lon / 15          # hours
    solar_noon_utc = 12 - lon_correction - eot / 60
    # Hour angle for astronomical twilight (sun at -18°)
    lat_r   = math.radians(lat)
    decl    = math.radians(23.45 * math.sin(2 * math.pi * (day_of_year - 81) / 365))
    cos_ha  = (math.cos(math.radians(108)) - math.sin(lat_r) * math.sin(decl)) / \
              (math.cos(lat_r) * math.cos(decl))
    cos_ha  = max(-1, min(1, cos_ha))
    ha_h    = math.degrees(math.acos(cos_ha)) / 15  # hours

    utc_offset = round(lon / 15)
    dusk_utc  = solar_noon_utc + ha_h
    dawn_utc  = solar_noon_utc - ha_h

    def utc_to_local(utc_decimal_h: float) -> datetime.datetime:
        h = int(utc_decimal_h) % 24
        m = int((utc_decimal_h % 1) * 60)
        base = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return base + datetime.timedelta(hours=utc_decimal_h + utc_offset)

    dusk_local = utc_to_local(dusk_utc)
    # Dawn is next day
    dawn_local = utc_to_local(dawn_utc) + datetime.timedelta(days=1)
    return dusk_local, dawn_local


def fetch_astrospheric(lat: float, lon: float, api_key: str) -> dict:
    """POST to Astrospheric GetForecastData_V1. Returns raw JSON."""
    url  = "https://astrosphericpublicaccess.azurewebsites.net/api/GetForecastData_V1"
    body = {"Latitude": lat, "Longitude": lon, "APIKey": api_key}
    print(f"  POST {url}")
    r = requests.post(url, json=body, timeout=30)
    r.raise_for_status()
    data = r.json()
    if "Error" in data:
        raise RuntimeError(f"Astrospheric API error: {data['Error']}")
    print(f"  Credits used today: {data.get('APICreditUsedToday', '?')}")
    return data


def _astro_val(arr, i):
    """Extract scalar from Astrospheric HourValue.
    Format: {"Value": {"ValueColor": "#...", "ActualValue": N}, "HourOffset": M}"""
    if not arr or i >= len(arr):
        return None
    v = arr[i]
    if v is None:
        return None
    if isinstance(v, dict):
        inner = v.get("Value")
        if isinstance(inner, dict):
            return inner.get("ActualValue")  # nested {ValueColor, ActualValue}
        return inner  # plain number under "Value" (older API format)
    return v  # bare number


def trim_astrospheric_to_night(data: dict, dusk: datetime.datetime, dawn: datetime.datetime) -> list:
    """Mirror _trimAstrospheric() from fetch.js.
    Wind: m/s → km/h.  Humidity: derived from temp+dewpoint (Magnus)."""
    utc_start = data.get("UTCStartTime")
    if not utc_start:
        return []
    # UTCStartTime has Z suffix — parse unambiguously as UTC
    import dateutil.parser
    # Parse as UTC and strip tzinfo so all comparisons are naive-UTC
    start_dt = dateutil.parser.parse(utc_start).replace(tzinfo=None)

    dusk_cmp = dusk.astimezone(datetime.timezone.utc).replace(tzinfo=None) if dusk.tzinfo else dusk
    dawn_cmp = dawn.astimezone(datetime.timezone.utc).replace(tzinfo=None) if dawn.tzinfo else dawn

    rows = []
    for i in range(81):
        dt = start_dt + datetime.timedelta(hours=i)
        if dt < dusk_cmp or dt > dawn_cmp:
            continue

        T  = _astro_val(data.get("RDPS_Temperature"), i)   # Kelvin
        Td = _astro_val(data.get("RDPS_DewPoint"), i)      # Kelvin
        hum = None
        if T is not None and Td is not None:
            Tc  = T  - 273.15
            Tdc = Td - 273.15
            hum = round(100 * math.exp(17.62*Tdc/(243.12+Tdc)) /
                              math.exp(17.62*Tc /(243.12+Tc)))
            hum = max(0, min(100, hum))

        w = _astro_val(data.get("RDPS_WindVelocity"), i)  # m/s

        # Cloud cover — average all available models (GFS/NAM may be None for some regions)
        cloud_rdps = _astro_val(data.get("RDPS_CloudCover"), i)
        cloud_gfs  = _astro_val(data.get("GFS_CloudCover"), i)
        cloud_nam  = _astro_val(data.get("NAM_CloudCover"), i)
        cc_vals    = [v for v in [cloud_rdps, cloud_gfs, cloud_nam] if v is not None]
        cloud_avg  = int(round(sum(cc_vals) / len(cc_vals))) if cc_vals else None

        rows.append({
            "dt":           dt,
            "cloud":        cloud_avg,   # average of available models (matches what watch stores)
            "cloud_rdps":   cloud_rdps,
            "cloud_gfs":    cloud_gfs,
            "cloud_nam":    cloud_nam,
            "wind":         round(w * 3.6, 1) if w is not None else None,  # km/h
            "precip":       None,
            "humidity":     hum,
            "seeing":       _astro_val(data.get("Astrospheric_Seeing"), i),       # 0-5
            "transparency": _astro_val(data.get("Astrospheric_Transparency"), i), # lower=better
        })
    return rows


def fetch_open_meteo(lat: float, lon: float) -> dict:
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat:.4f}&longitude={lon:.4f}"
        "&hourly=cloud_cover,wind_speed_10m,precipitation_probability,relative_humidity_2m"
        "&forecast_days=2"
        "&timezone=auto"
    )
    return fetch(url)


def fetch_iss(lat: float, lon: float) -> list:
    """Compute ISS passes using skyfield + live TLE from Celestrak."""
    try:
        from skyfield.api import Topos, load, EarthSatellite
        from skyfield import almanac

        print("  Downloading ISS TLE from Celestrak...")
        tle_url = "https://celestrak.org/SATCAT/tle.php?CATNR=25544"
        r = requests.get(tle_url, timeout=15)
        lines = [l.strip() for l in r.text.strip().splitlines() if l.strip()]
        # Expect: name, TLE line 1, TLE line 2
        if len(lines) < 3:
            raise ValueError("Unexpected TLE format")
        sat = EarthSatellite(lines[1], lines[2], lines[0])

        ts  = load.timescale()
        obs = Topos(latitude_degrees=lat, longitude_degrees=lon)

        now   = datetime.datetime.now(datetime.timezone.utc)
        t0    = ts.from_datetime(now)
        t1    = ts.from_datetime(now + datetime.timedelta(days=2))

        times, events = sat.find_events(obs, t0, t1, altitude_degrees=10.0)

        passes = []
        rise_t = None
        for t, ev in zip(times, events):
            if ev == 0:   # rise
                rise_t = t
            elif ev == 2 and rise_t:  # set
                dur = int((t - rise_t) * 86400)
                passes.append({
                    "risetime": int(rise_t.utc_datetime().timestamp()),
                    "duration": dur
                })
                rise_t = None
        return passes

    except ImportError:
        print("  skyfield not installed — trying n2yo fallback (pip install skyfield)")
        return _fetch_iss_n2yo(lat, lon)
    except Exception as e:
        print(f"  skyfield ISS failed: {e}")
        return []


def _fetch_iss_n2yo(lat: float, lon: float) -> list:
    """Fallback: hit wheretheiss.at (current pos only — no pass times)."""
    print("  (n2yo requires API key — skipping ISS)")
    return []


def _estimate_seeing(wind_kmh, hum_pct) -> float | None:
    """Estimate seeing (0-5, higher=better) from wind speed (km/h) and humidity (%).
    Starts at 4.0 (good baseline), penalised by wind >10 km/h and humidity >60%."""
    if wind_kmh is None or hum_pct is None:
        return None
    s = 4.0 - max(0.0, wind_kmh - 10) / 10 - max(0.0, hum_pct - 60) / 80
    return round(max(0.0, min(5.0, s)), 1)


def _estimate_transparency(hum_pct, precip_pct) -> int | None:
    """Estimate transparency (5-29, lower=better) from humidity and precip probability.
    Scale matches Astrospheric: 5=excellent, 29=very poor."""
    if hum_pct is None:
        return None
    t = 5 + hum_pct * 0.20 + (precip_pct or 0) * 0.04
    return max(5, min(29, round(t)))


def trim_to_night(data: dict, dusk: datetime.datetime, dawn: datetime.datetime) -> list:
    """Mirror the _trimMeteo() logic from fetch.js."""
    hourly = data.get("hourly", {})
    times  = hourly.get("time", [])
    cloud  = hourly.get("cloud_cover", [])
    wind   = hourly.get("wind_speed_10m", [])
    precip = hourly.get("precipitation_probability", [])
    hum    = hourly.get("relative_humidity_2m", [])

    # Open-Meteo returns naive ISO strings — treat as UTC then convert to local
    utc_offset = dusk.utcoffset() if dusk.utcoffset() else datetime.timedelta(0)

    rows = []
    for i, t in enumerate(times):
        # timezone=auto: times are local strings like "2026-05-10T22:00" — parse as naive local
        dt_local = datetime.datetime.fromisoformat(t)

        # Strip tzinfo from dusk/dawn for comparison if present, or compare naive
        dusk_cmp = dusk.replace(tzinfo=None) if dusk.tzinfo else dusk
        dawn_cmp = dawn.replace(tzinfo=None) if dawn.tzinfo else dawn

        if dt_local < dusk_cmp or dt_local > dawn_cmp:
            continue
        rows.append({
            "dt":           dt_local,
            "cloud":        cloud[i]  if i < len(cloud)  else None,
            "wind":         wind[i]   if i < len(wind)   else None,
            "precip":       precip[i] if i < len(precip) else None,
            "humidity":     hum[i]    if i < len(hum)    else None,
            "seeing":       _estimate_seeing(
                                wind[i]   if i < len(wind) else None,
                                hum[i]    if i < len(hum)  else None),
            "transparency": _estimate_transparency(
                                hum[i]    if i < len(hum)    else None,
                                precip[i] if i < len(precip) else None),
        })
    return rows


def find_iss_passes(passes: list, dusk: datetime.datetime, dawn: datetime.datetime) -> list:
    dusk_ts = dusk.timestamp()
    dawn_ts = dawn.timestamp()
    tonight = []
    for p in passes:
        rt = p.get("risetime", 0)
        if dusk_ts <= rt <= dawn_ts:
            tonight.append(p)
    return tonight


def print_summary(rows: list, iss_tonight: list, dusk, dawn):
    print("\n" + "="*60)
    print(f"  AstroWatch Night Window  ({CITY})  [{PROVIDER}]")
    print(f"  Astro Dusk : {dusk.strftime('%Y-%m-%d %H:%M %Z')}")
    print(f"  Astro Dawn : {dawn.strftime('%Y-%m-%d %H:%M %Z')}")
    print("="*60)
    if not rows:
        print("  No hourly data falls inside the night window.")
        print("     Check that timestamps match your local date.")
        return

    has_seeing = any(r.get("seeing") is not None for r in rows)
    is_estimated = PROVIDER != "astrospheric"
    seeing_words = {0: "Terrible", 1: "Bad", 2: "Poor", 3: "Average", 4: "Good", 5: "Excellent"}

    if has_seeing:
        # Show astronomy columns — real values (Astrospheric) or estimated (Open-Meteo)
        est_note = " (estimated from wind+humidity)" if is_estimated else ""
        hdr = f"  {'Time':<7} {'Cloud%':>7} {'Seeing'+est_note:<{14+len(est_note)}} {'Transp':>6}"
        print(hdr)
        print("  " + "-" * (38 + len(est_note)))
        for r in rows:
            sv = r.get("seeing")
            tv = r.get("transparency")
            see_lbl = seeing_words.get(int(round(sv)), str(sv)) if sv is not None else "n/a"
            trns_str = f"{int(tv)}" if tv is not None else "n/a"
            print(f"  {r['dt'].strftime('%H:%M'):<7} "
                  f"{str(r['cloud'])+'%':>7} "
                  f"{see_lbl:<{13+len(est_note)}} "
                  f"{trns_str:>6}")
    else:
        # Open-Meteo without estimates (fallback — shouldn't happen)
        hdr = f"  {'Time':<7} {'Cloud%':>6} {'Wind(mph)':>9} {'Precip%':>7} {'Humidity%':>9}"
        print(hdr)
        print("  " + "-" * 44)
        for r in rows:
            wind_mph = round(r['wind'] * 0.621371, 1) if r['wind'] is not None else None
            print(f"  {r['dt'].strftime('%H:%M'):<7} "
                  f"{str(r['cloud'])+'%':>6} "
                  f"{str(wind_mph)+'mph':>9} "
                  f"{str(r['precip'])+'%' if r['precip'] is not None else 'n/a':>7} "
                  f"{str(r['humidity'])+'%':>9}")

    print()
    if iss_tonight:
        print("  ISS Passes tonight:")
        for p in iss_tonight:
            t = datetime.datetime.fromtimestamp(p['risetime']).strftime('%H:%M')
            print(f"    {t}  duration {p['duration']}s")
    else:
        print("  ISS: no passes during astronomical night tonight")
    print()


def plot(rows: list, iss_tonight: list, dusk, dawn):
    try:
        import matplotlib.pyplot as plt
        import matplotlib.dates as mdates
        import matplotlib.patches as mpatches
        import matplotlib.gridspec as gridspec
    except ImportError:
        print("matplotlib not installed — skipping plot (pip install matplotlib)")
        return

    if not rows:
        print("No night-window data to plot.")
        return

    BG      = "#0d1117"
    FG      = "#e6edf3"
    GRID    = "#21262d"
    CLOUD_C = "#4a9eff"
    WIND_C  = "#7ee787"
    PRECIP_C= "#79c0ff"
    HUM_C   = "#d2a679"
    ISS_C   = "#ffd700"
    GOOD    = "#3fb950"
    WARN    = "#d29922"
    BAD     = "#f85149"

    plt.rcParams.update({
        "figure.facecolor": BG, "axes.facecolor": BG,
        "axes.edgecolor": GRID, "axes.labelcolor": FG,
        "xtick.color": FG, "ytick.color": FG,
        "text.color": FG, "grid.color": GRID,
    })

    dusk_naive = dusk.replace(tzinfo=None)
    dawn_naive = dawn.replace(tzinfo=None)

    times   = [r["dt"] for r in rows]
    cloud   = [r["cloud"]   if r["cloud"]   is not None else 0 for r in rows]
    wind    = [r["wind"] * 0.621371 if r["wind"] is not None else 0 for r in rows]
    precip  = [r["precip"]  if r["precip"]  is not None else 0 for r in rows]
    hum     = [r["humidity"]if r["humidity"] is not None else 0 for r in rows]

    # Extend time axis one hour past each end for readability
    t_start = times[0]  - datetime.timedelta(hours=0.5)
    t_end   = times[-1] + datetime.timedelta(hours=1.5)

    fig = plt.figure(figsize=(13, 9), facecolor=BG)
    fig.suptitle(
        f"AstroWatch — Tonight's Sky  ·  {CITY}",
        fontsize=16, fontweight="bold", color=FG, y=0.98
    )

    gs = gridspec.GridSpec(
        3, 2, figure=fig,
        left=0.07, right=0.97, top=0.91, bottom=0.08,
        hspace=0.55, wspace=0.35
    )

    # ── Helper: colour-coded bar chart ───────────────────────────────────────
    def coloured_bars(ax, x, y, thresholds, colors, label, unit, ylim=(0,100)):
        bar_w = datetime.timedelta(hours=0.85)
        for xi, yi in zip(x, y):
            if yi is None:
                continue
            c = colors[0]
            for thresh, col in zip(thresholds, colors[1:]):
                if yi >= thresh:
                    c = col
            ax.bar(xi, yi, width=bar_w, color=c, alpha=0.85, align="center",
                   edgecolor=BG, linewidth=0.4)
        ax.set_xlim(t_start, t_end)
        ax.set_ylim(*ylim)
        ax.set_ylabel(f"{label}\n({unit})", fontsize=8, color=FG)
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))
        ax.xaxis.set_major_locator(mdates.HourLocator(interval=1))
        ax.tick_params(axis="x", labelsize=7, rotation=45)
        ax.tick_params(axis="y", labelsize=7)
        ax.grid(axis="y", linestyle="--", alpha=0.3)
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)

        # Value labels on bars
        for xi, yi in zip(x, y):
            if yi is None: continue
            ax.text(xi, yi + ylim[1]*0.03, f"{yi:.0f}",
                    ha="center", va="bottom", fontsize=6.5, color=FG)

    # ── ISS marker helper ─────────────────────────────────────────────────────
    def mark_iss(ax):
        for p in iss_tonight:
            t = datetime.datetime.fromtimestamp(p["risetime"])
            ax.axvline(t, color=ISS_C, linewidth=1.2, linestyle="--", alpha=0.7, zorder=5)

    # ── Cloud cover ───────────────────────────────────────────────────────────
    ax_cloud = fig.add_subplot(gs[0, 0])
    coloured_bars(ax_cloud, times, cloud,
                  [25, 60, 85],
                  [GOOD, GOOD, WARN, BAD],
                  "Cloud Cover", "%")
    ax_cloud.set_title("Cloud Cover", fontsize=10, color=FG, pad=6)
    # Observing quality band
    ax_cloud.axhspan(0, 20,  alpha=0.07, color=GOOD)
    ax_cloud.axhspan(20, 60, alpha=0.05, color=WARN)
    ax_cloud.axhspan(60, 100,alpha=0.05, color=BAD)
    mark_iss(ax_cloud)

    # ── Precipitation ─────────────────────────────────────────────────────────
    ax_precip = fig.add_subplot(gs[0, 1])
    coloured_bars(ax_precip, times, precip,
                  [20, 50],
                  [GOOD, WARN, BAD],
                  "Precip Prob", "%")
    ax_precip.set_title("Precipitation Probability", fontsize=10, color=FG, pad=6)
    mark_iss(ax_precip)

    # ── Wind speed ────────────────────────────────────────────────────────────
    ax_wind = fig.add_subplot(gs[1, 0])
    max_wind = max(wind) if wind else 10
    coloured_bars(ax_wind, times, wind,
                  [10, 20],
                  [GOOD, WARN, BAD],
                  "Wind Speed", "mph",
                  ylim=(0, max(max_wind * 1.4, 5)))
    ax_wind.set_title("Wind Speed", fontsize=10, color=FG, pad=6)
    mark_iss(ax_wind)

    # ── Humidity ─────────────────────────────────────────────────────────────
    ax_hum = fig.add_subplot(gs[1, 1])
    coloured_bars(ax_hum, times, hum,
                  [60, 80],
                  [GOOD, WARN, BAD],
                  "Humidity", "%")
    ax_hum.set_title("Humidity", fontsize=10, color=FG, pad=6)
    mark_iss(ax_hum)

    # ── Summary table (bottom row, full width) ────────────────────────────────
    ax_table = fig.add_subplot(gs[2, :])
    ax_table.axis("off")

    dusk_str = dusk_naive.strftime("%b %d  %H:%M")
    dawn_str = dawn_naive.strftime("%H:%M")

    col_labels = ["Time", "Cloud", "Wind", "Precip", "Humidity", "Observing"]
    table_data = []
    for r in rows:
        w = r["wind"] * 0.621371 if r["wind"] else 0
        c = r["cloud"] or 0
        p = r["precip"] or 0
        h = r["humidity"] or 0
        # Simple observing quality score
        score = 100 - c*0.6 - p*0.2 - max(0, w-15)*2
        if score >= 75:   qual = "[***] Excellent"
        elif score >= 50: qual = "[** ] Good"
        elif score >= 25: qual = "[*  ] Fair"
        else:             qual = "[   ] Poor"
        table_data.append([
            r["dt"].strftime("%H:%M"),
            f"{c:.0f}%",
            f"{w:.1f} mph",
            f"{p:.0f}%",
            f"{h:.0f}%",
            qual,
        ])

    tbl = ax_table.table(
        cellText=table_data,
        colLabels=col_labels,
        loc="center",
        cellLoc="center",
    )
    tbl.auto_set_font_size(False)
    tbl.set_fontsize(8.5)
    tbl.scale(1, 1.5)

    # Style header
    for j in range(len(col_labels)):
        tbl[0, j].set_facecolor("#21262d")
        tbl[0, j].set_text_props(color=FG, fontweight="bold")

    # Style data rows — colour observing quality cell
    for i, r in enumerate(rows):
        c = r["cloud"] or 0
        p = r["precip"] or 0
        w = (r["wind"] or 0) * 0.621371
        score = 100 - c*0.6 - p*0.2 - max(0, w-15)*2
        row_bg = "#161b22"
        if score >= 75:   q_bg = "#1a3a1a"
        elif score >= 50: q_bg = "#3a2e00"
        elif score >= 25: q_bg = "#3a1a00"
        else:             q_bg = "#3a0000"
        for j in range(len(col_labels)):
            tbl[i+1, j].set_facecolor(q_bg if j == 5 else row_bg)
            tbl[i+1, j].set_text_props(color=FG)

    # Window info + ISS banner above table
    info_lines = [f"Astronomical night:  {dusk_str}  ->  {dawn_str} MDT"]
    if iss_tonight:
        for p in iss_tonight:
            t = datetime.datetime.fromtimestamp(p["risetime"])
            info_lines.append(
                f"ISS pass at {t.strftime('%H:%M')}  ({p['duration']}s visible)"
            )
        ax_table.set_title("  ".join(info_lines), fontsize=9,
                           color=ISS_C, pad=10, loc="left")
    else:
        ax_table.set_title(info_lines[0] + "     No ISS passes tonight",
                           fontsize=9, color=FG, pad=10, loc="left")

    # Legend
    legend_items = [
        mpatches.Patch(color=GOOD,  label="Good observing"),
        mpatches.Patch(color=WARN,  label="Fair / marginal"),
        mpatches.Patch(color=BAD,   label="Poor"),
    ]
    if iss_tonight:
        legend_items.append(
            mpatches.Patch(color=ISS_C, label="ISS pass")
        )
    fig.legend(handles=legend_items, loc="upper right",
               fontsize=8, facecolor="#21262d", edgecolor=GRID,
               labelcolor=FG, framealpha=0.9, bbox_to_anchor=(0.97, 0.95))

    plt.savefig("astroclk_night_forecast.png", dpi=150, facecolor=BG)
    print("  Saved astroclk_night_forecast.png")
    plt.show()  # opens interactive window


def plot_astrospheric(rows: list, dusk, dawn, credits="?"):
    """Dark-themed dashboard for Astrospheric Pro data.
    Shows cloud cover (per model + average), seeing (0-5), and transparency.
    """
    try:
        import matplotlib.pyplot as plt
        import matplotlib.dates as mdates
        import matplotlib.gridspec as gridspec
        import matplotlib.patches as mpatches
    except ImportError:
        print("matplotlib not installed — skipping plot")
        return

    if not rows:
        print("No night-window data to plot.")
        return

    BG     = "#0d1117"
    FG     = "#e6edf3"
    GRID   = "#21262d"
    GOOD   = "#3fb950"
    WARN   = "#d29922"
    BAD    = "#f85149"
    RDPS_C = "#4a9eff"
    GFS_C  = "#e3b341"
    NAM_C  = "#bc8cff"

    plt.rcParams.update({
        "figure.facecolor": BG, "axes.facecolor": BG,
        "axes.edgecolor":   GRID, "axes.labelcolor": FG,
        "xtick.color": FG, "ytick.color": FG,
        "text.color":  FG, "grid.color":  GRID,
    })

    dusk_naive = dusk.replace(tzinfo=None)
    dawn_naive = dawn.replace(tzinfo=None)

    times        = [r["dt"]              for r in rows]
    cloud_rdps   = [r.get("cloud_rdps")  for r in rows]
    cloud_gfs    = [r.get("cloud_gfs")   for r in rows]
    cloud_nam    = [r.get("cloud_nam")   for r in rows]
    cloud_avg    = [r.get("cloud")       for r in rows]
    seeing_vals  = [r.get("seeing")      for r in rows]
    trans_vals   = [r.get("transparency") for r in rows]

    has_gfs = any(v is not None for v in cloud_gfs)
    has_nam = any(v is not None for v in cloud_nam)

    t_start = times[0]  - datetime.timedelta(hours=0.5)
    t_end   = times[-1] + datetime.timedelta(hours=1.5)
    bar_w   = datetime.timedelta(hours=0.85)

    fig = plt.figure(figsize=(13, 10), facecolor=BG)
    fig.suptitle(
        f"AstroWatch  —  Astrospheric Pro  |  {CITY}  ({credits} API credits used today)",
        fontsize=15, fontweight="bold", color=FG, y=0.98
    )

    gs = gridspec.GridSpec(3, 2, figure=fig,
                           left=0.07, right=0.97, top=0.91, bottom=0.08,
                           hspace=0.65, wspace=0.35)

    def setup_ax(ax, title, ylabel, ylim=None):
        ax.set_title(title, fontsize=10, color=FG, pad=6)
        ax.set_xlim(t_start, t_end)
        if ylim:
            ax.set_ylim(*ylim)
        ax.set_ylabel(ylabel, fontsize=8, color=FG)
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))
        ax.xaxis.set_major_locator(mdates.HourLocator(interval=1))
        ax.tick_params(axis="x", labelsize=7, rotation=45)
        ax.tick_params(axis="y", labelsize=7)
        ax.grid(axis="y", linestyle="--", alpha=0.3)
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)

    # ── Cloud cover (full-width top panel) ──────────────────────────────────
    ax_cloud = fig.add_subplot(gs[0, :])
    setup_ax(ax_cloud, "Cloud Cover  (lower = better for astronomy)", "Cloud %", (0, 105))
    ax_cloud.axhspan(0,  25, alpha=0.08, color=GOOD)
    ax_cloud.axhspan(25, 60, alpha=0.06, color=WARN)
    ax_cloud.axhspan(60, 100, alpha=0.06, color=BAD)

    if not has_gfs and not has_nam:
        # Single model — colour bars by cloud value
        for xi, yi in zip(times, cloud_rdps):
            if yi is None:
                continue
            col = GOOD if yi <= 25 else WARN if yi <= 60 else BAD
            ax_cloud.bar(xi, yi, width=bar_w, color=col, alpha=0.85,
                         align="center", edgecolor=BG, linewidth=0.4)
            ax_cloud.text(xi, yi + 1.5, f"{yi:.0f}",
                          ha="center", va="bottom", fontsize=7, color=FG)
        ax_cloud.text(0.01, 0.93, "RDPS model", transform=ax_cloud.transAxes,
                      fontsize=8, color=RDPS_C, alpha=0.9)
    else:
        # Multiple models — grouped bars + average line
        n = 1 + (1 if has_gfs else 0) + (1 if has_nam else 0)
        w = datetime.timedelta(hours=0.65 / n)
        groups = [(cloud_rdps, RDPS_C, "RDPS")]
        if has_gfs:
            groups.append((cloud_gfs, GFS_C, "GFS"))
        if has_nam:
            groups.append((cloud_nam, NAM_C, "NAM"))
        for g_i, (vals, col, lbl) in enumerate(groups):
            offset = datetime.timedelta(hours=(g_i - (n - 1) / 2) * 0.65 / n)
            xs = [t + offset for t in times]
            ys = [v if v is not None else 0 for v in vals]
            ax_cloud.bar(xs, ys, width=w, color=col, alpha=0.75, align="center",
                         edgecolor=BG, linewidth=0.3, label=lbl)
        # Average overlay
        avg_pts = [(t, v) for t, v in zip(times, cloud_avg) if v is not None]
        if avg_pts:
            ax_cloud.plot([t for t, _ in avg_pts], [v for _, v in avg_pts],
                          color="#ffffff", linewidth=1.8, marker="o", markersize=4,
                          linestyle="--", label="Avg", zorder=5)
        ax_cloud.legend(loc="upper right", fontsize=7, facecolor="#21262d",
                        edgecolor=GRID, labelcolor=FG, framealpha=0.85)

    # ── Seeing (0–5 scale) ──────────────────────────────────────────────────
    see_words  = {0: "Terrible", 1: "Bad", 2: "Poor", 3: "Average", 4: "Good", 5: "Excellent"}
    see_colors = {0: BAD, 1: BAD, 2: BAD, 3: WARN, 4: GOOD, 5: GOOD}

    ax_see = fig.add_subplot(gs[1, 0])
    setup_ax(ax_see, "Seeing  (0 = Terrible … 5 = Excellent)", "Seeing (0–5)", (0, 5.8))
    for xi, yi in zip(times, seeing_vals):
        if yi is None:
            continue
        s = int(round(yi))
        ax_see.bar(xi, yi, width=bar_w, color=see_colors.get(s, WARN), alpha=0.85,
                   align="center", edgecolor=BG, linewidth=0.4)
        ax_see.text(xi, yi + 0.1, see_words.get(s, str(s)),
                    ha="center", va="bottom", fontsize=6, color=FG)
    ax_see.set_yticks([0, 1, 2, 3, 4, 5])
    ax_see.set_yticklabels(["0 Terrible", "1 Bad", "2 Poor",
                             "3 Average", "4 Good", "5 Excellent"], fontsize=6)

    # ── Transparency (lower = better) ────────────────────────────────────────
    max_t = max((v for v in trans_vals if v is not None), default=20)
    ax_trns = fig.add_subplot(gs[1, 1])
    setup_ax(ax_trns, "Transparency  (lower = better)",
             "Value (lower = better)", (0, max(max_t * 1.25, 15)))
    for xi, yi in zip(times, trans_vals):
        if yi is None:
            continue
        col = GOOD if yi <= 10 else GOOD if yi <= 15 else WARN if yi <= 20 else BAD
        ax_trns.bar(xi, yi, width=bar_w, color=col, alpha=0.85,
                    align="center", edgecolor=BG, linewidth=0.4)
        ax_trns.text(xi, yi + max_t * 0.02, f"{yi:.1f}",
                     ha="center", va="bottom", fontsize=6.5, color=FG)
    for ref, col in [(10, GOOD), (15, GOOD), (20, WARN)]:
        ax_trns.axhline(ref, color=col, linewidth=0.7, linestyle=":", alpha=0.55)

    # ── Summary table ────────────────────────────────────────────────────────
    ax_table = fig.add_subplot(gs[2, :])
    ax_table.axis("off")

    def trns_word(t):
        if t is None:
            return "n/a"
        if t <= 10:
            return f"{t:.1f} Excellent"
        if t <= 15:
            return f"{t:.1f} Good"
        if t <= 20:
            return f"{t:.1f} Average"
        return f"{t:.1f} Poor"

    if has_gfs or has_nam:
        col_labels = ["Time", "Cloud Avg", "RDPS", "GFS", "NAM", "Seeing", "Transparency"]
        table_data = [
            [r["dt"].strftime("%H:%M"),
             f"{r.get('cloud'):.0f}%"      if r.get("cloud")      is not None else "--",
             f"{r.get('cloud_rdps'):.0f}%" if r.get("cloud_rdps") is not None else "--",
             f"{r.get('cloud_gfs'):.0f}%"  if r.get("cloud_gfs")  is not None else "--",
             f"{r.get('cloud_nam'):.0f}%"  if r.get("cloud_nam")  is not None else "--",
             see_words.get(int(round(sv)), str(sv)) if (sv := r.get("seeing")) is not None else "--",
             trns_word(r.get("transparency"))]
            for r in rows
        ]
    else:
        col_labels = ["Time", "Cloud (RDPS)", "Seeing", "Transparency"]
        table_data = [
            [r["dt"].strftime("%H:%M"),
             f"{r.get('cloud'):.0f}%" if r.get("cloud") is not None else "--",
             see_words.get(int(round(sv)), str(sv)) if (sv := r.get("seeing")) is not None else "--",
             trns_word(r.get("transparency"))]
            for r in rows
        ]

    tbl = ax_table.table(cellText=table_data, colLabels=col_labels,
                         loc="center", cellLoc="center")
    tbl.auto_set_font_size(False)
    tbl.set_fontsize(8.5)
    tbl.scale(1, 1.5)

    for j in range(len(col_labels)):
        tbl[0, j].set_facecolor("#21262d")
        tbl[0, j].set_text_props(color=FG, fontweight="bold")

    for row_i, r in enumerate(rows):
        sv  = r.get("seeing")
        tv  = r.get("transparency")
        cv  = r.get("cloud") or 0
        # Composite quality: cloud 0=best, seeing 5=best, transparency low=best
        q = (100 - cv) * 0.5
        if sv is not None:
            q += (sv / 5.0) * 30
        if tv is not None:
            q += max(0, (20 - tv)) * 1.0
        row_bg = "#1a3a1a" if q >= 65 else "#3a2e00" if q >= 40 else "#3a1a00"
        for j in range(len(col_labels)):
            tbl[row_i + 1, j].set_facecolor(row_bg)
            tbl[row_i + 1, j].set_text_props(color=FG)

    dusk_str = dusk_naive.strftime("%b %d  %H:%M")
    dawn_str = dawn_naive.strftime("%H:%M")
    ax_table.set_title(f"Night: {dusk_str} -> {dawn_str}",
                       fontsize=9, color=FG, pad=8, loc="left")

    plt.savefig("astroclk_astro_forecast.png", dpi=150, facecolor=BG)
    print("  Saved astroclk_astro_forecast.png")
    plt.show()


def main():
    print(f"\nAstroWatch Weather Verifier — {CITY} ({LAT}, {LON})")
    print(f"Provider: {PROVIDER}\n")

    print("Computing astronomical night window...")
    dusk, dawn = get_astro_night(LAT, LON)
    print(f"  Dusk: {dusk}  ->  Dawn: {dawn}\n")

    if PROVIDER == "astrospheric":
        if not ASTROSPHERIC_KEY:
            raise SystemExit("Set ASTROSPHERIC_KEY at the top of verify_weather.py")
        print("Fetching Astrospheric Pro forecast...")
        raw         = fetch_astrospheric(LAT, LON, ASTROSPHERIC_KEY)
        rows        = trim_astrospheric_to_night(raw, dusk, dawn)
        print("Fetching ISS pass times...")
        iss_passes  = fetch_iss(LAT, LON)
        iss_tonight = find_iss_passes(iss_passes, dusk, dawn)
    else:
        print("Fetching Open-Meteo hourly forecast...")
        raw         = fetch_open_meteo(LAT, LON)
        print("Fetching ISS pass times...")
        iss_passes  = fetch_iss(LAT, LON)
        rows        = trim_to_night(raw, dusk, dawn)
        iss_tonight = find_iss_passes(iss_passes, dusk, dawn)

    print_summary(rows, iss_tonight, dusk, dawn)
    if PROVIDER == "astrospheric":
        plot_astrospheric(rows, dusk, dawn, credits=raw.get("APICreditUsedToday", "?"))
    else:
        plot(rows, iss_tonight, dusk, dawn)

    with open("astroclk_raw_night.json", "w") as f:
        json.dump({
            "provider":   PROVIDER,
            "dusk":       str(dusk),
            "dawn":       str(dawn),
            "hourly":     rows,
            "iss_passes": iss_tonight,
        }, f, indent=2, default=str)
    print("  Raw data written to astroclk_raw_night.json\n")


if __name__ == "__main__":
    main()
