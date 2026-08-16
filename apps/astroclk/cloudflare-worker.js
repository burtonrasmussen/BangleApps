/**
 * AstroWatch Slimming Proxy for Astrospheric Pro API
 * 
 * Cloudflare Worker script:
 * Receives GET request with ?lat=..&lon=..&key=..&dusk=..&dawn=..&tz=..
 * Queries Astrospheric GetForecastData_V1 (41.5 KB payload)
 * Trims to tonight's hours (~600 bytes)
 * Returns compact JSON to Bangle.js over Bluetooth in <1 second
 */

const ASTRO_URL = "https://astrosphericpublicaccess.azurewebsites.net/api/GetForecastData_V1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "AstroWatch Proxy" }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    if (url.pathname !== "/astro") {
      return new Response(JSON.stringify({ error: "Endpoint not found. Use /astro" }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const lat = parseFloat(url.searchParams.get("lat"));
    const lon = parseFloat(url.searchParams.get("lon"));
    const key = url.searchParams.get("key") || (env.ASTROSPHERIC_KEY || "").trim();
    const duskMs = parseInt(url.searchParams.get("dusk") || "0", 10);
    const dawnMs = parseInt(url.searchParams.get("dawn") || "0", 10);
    const tzMin = parseInt(url.searchParams.get("tz") || "0", 10); // Timezone offset in minutes

    if (isNaN(lat) || isNaN(lon) || !key) {
      return new Response(JSON.stringify({ error: "Missing required query params: lat, lon, key" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    try {
      // 1. Query Astrospheric
      const astroResp = await fetch(ASTRO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Latitude: lat, Longitude: lon, APIKey: key })
      });

      if (!astroResp.ok) {
        return new Response(JSON.stringify({ error: `Astrospheric HTTP error: ${astroResp.status}` }), {
          status: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const rawData = await astroResp.json();
      if (rawData.Error) {
        return new Response(JSON.stringify({ error: `Astrospheric API error: ${rawData.Error}` }), {
          status: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // 2. Slim & Trim payload for Bangle.js
      const slimData = slimAstrospheric(rawData, duskMs, dawnMs, tzMin);

      return new Response(JSON.stringify(slimData), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=1800"
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || "Proxy fetch failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};

function extractNums(arr) {
  if (!arr || !Array.isArray(arr)) return [];
  return arr.map(item => {
    if (item && typeof item === "object") {
      if (item.Value && typeof item.Value === "object") {
        return item.Value.ActualValue !== undefined ? item.Value.ActualValue : null;
      }
      return item.Value !== undefined ? item.Value : null;
    }
    return typeof item === "number" ? item : null;
  });
}

function calcHumidity(tempK, dewK) {
  if (tempK === null || dewK === null) return null;
  const tc = tempK - 273.15;
  const tdc = dewK - 273.15;
  try {
    const hum = 100 * Math.exp((17.62 * tdc) / (243.12 + tdc)) / Math.exp((17.62 * tc) / (243.12 + tc));
    return Math.max(0, Math.min(100, Math.round(hum)));
  } catch (e) {
    return null;
  }
}

function slimAstrospheric(data, duskMs, dawnMs, tzMin) {
  const utcStart = data.UTCStartTime;
  if (!utcStart) throw new Error("Missing UTCStartTime in response");

  const startMs = new Date(utcStart).getTime();
  const cloudsRdps = extractNums(data.RDPS_CloudCover);
  const cloudsGfs  = extractNums(data.GFS_CloudCover);
  const cloudsNam  = extractNums(data.NAM_CloudCover);
  const seeing = extractNums(data.Astrospheric_Seeing);
  const trans = extractNums(data.Astrospheric_Transparency);
  const wind = extractNums(data.RDPS_WindVelocity);
  const temp = extractNums(data.RDPS_Temperature);
  const dew = extractNums(data.RDPS_DewPoint);

  const totalHours = Math.max(cloudsRdps.length, seeing.length, trans.length, wind.length, 81);
  const hourly = [];

  for (let i = 0; i < totalHours; i++) {
    const tMs = startMs + i * 3600000;
    // If dusk/dawn provided, filter to night window; otherwise take first 24h
    if (duskMs && dawnMs && (tMs < duskMs || tMs > dawnMs)) {
      continue;
    }
    if (!duskMs && i >= 24) break;

    // Format local hour
    const localDate = new Date(tMs - tzMin * 60000);
    const hh = String(localDate.getUTCHours()).padStart(2, "0");
    const mm = String(localDate.getUTCMinutes()).padStart(2, "0");

    // Multi-model cloud ensemble: average all available models (RDPS, GFS, NAM)
    const cVals = [];
    if (cloudsRdps[i] !== null && cloudsRdps[i] !== undefined) cVals.push(cloudsRdps[i]);
    if (cloudsGfs[i] !== null && cloudsGfs[i] !== undefined) cVals.push(cloudsGfs[i]);
    if (cloudsNam[i] !== null && cloudsNam[i] !== undefined) cVals.push(cloudsNam[i]);
    const cloudEnsemble = cVals.length ? Math.round(cVals.reduce((a, b) => a + b, 0) / cVals.length) : null;

    const s = seeing[i] !== undefined ? seeing[i] : null;
    const tr = trans[i] !== undefined ? trans[i] : null;
    const w = wind[i] !== undefined ? wind[i] : null;

    hourly.push({
      hour: `${hh}:${mm}`,
      cloud: cloudEnsemble,
      wind: w !== null ? Math.round(w * 3.6 * 10) / 10 : null,
      precip: null,
      humidity: calcHumidity(temp[i], dew[i]),
      seeing: s !== null ? Math.round(s * 10) / 10 : null,
      transparency: tr !== null ? Math.round(tr) : null
    });
  }

  return {
    credits: data.APICreditUsedToday !== undefined ? data.APICreditUsedToday : null,
    hourly: hourly
  };
}
