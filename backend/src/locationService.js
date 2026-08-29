'use strict';
/**
 * locationService.js — hub-node location intelligence for the Fortress Hub.
 *
 * The hub node aggregates "where are we" from three sources, in order of trust:
 *   1. manual / env home coordinates (HUB_LAT / HUB_LON, or POST /api/location/manual)
 *   2. most recent family-device report (browser/Capacitor geolocation reported in)
 *   3. IP geolocation fallback (cached 24h in memory; may be unavailable off-link)
 *
 * JARV can ping this on demand (jarv_location skill) so satellite OSINT can be
 * computed from a real, current fix instead of a hard-coded default. Manual
 * input stays available for when no fix exists (off-grid).
 */

const DEFAULT_TTL_MS = 6 * 3600 * 1000; // how long a device fix stays "current"
const IP_CACHE_MS = 24 * 3600 * 1000;

async function ipGeolocate(log) {
  // Free, no-key geo from public IP. Best-effort only.
  const url = `${process.env.HUB_IP_GEO_URL || 'https://ipinfo.io/json'}`;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 4000) : null;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl ? ctrl.signal : undefined });
    const j = await res.json();
    const loc = (j && typeof j.loc === 'string' && j.loc.split(',').map(Number)) || null;
    if (loc && Number.isFinite(loc[0]) && Number.isFinite(loc[1])) {
      return { lat: loc[0], lon: loc[1], accuracy_m: j.accuracy || 15000, source: 'ip-geo', city: j.city || null, region: j.region || null, updated_at: new Date().toISOString() };
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const ENV_NAME = 'hub';

async function ensureLocationsTable(pool) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS hub_locations (
      device_id text PRIMARY KEY,
      lat double precision NOT NULL,
      lon double precision NOT NULL,
      accuracy_m double precision,
      source text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  } catch (e) { /* table may exist via migration; tolerate */ }
}

function makeLocationService({ pool, log } = {}) {
  const logFn = typeof log === 'function' ? log : (typeof log === 'object' && log.info && log.info.bind(log)) || (() => {});
  let ipCache = null;
  let ipCachedAt = 0;

  if (pool) ensureLocationsTable(pool).catch((e) => logFn('[location] table init failed: ' + e));

  /** Highest-trust current hub fix. Resolves {ok, ...} or {ok:false, error}. */
  async function getCurrent(opts = {}) {
    const envLat = Number(process.env.HUB_LAT);
    const envLon = Number(process.env.HUB_LON);
    if (Number.isFinite(envLat) && Number.isFinite(envLon)) {
      return { ok: true, lat: envLat, lon: envLon, accuracy_m: Number(process.env.HUB_ACCURACY_M) || null, source: 'manual', deviceId: ENV_NAME, updated_at: null, note: 'hub env coordinates' };
    }
    const ttl = Number(opts.ttlMs) || Number(process.env.HUB_LOCATION_TTL_MS) || DEFAULT_TTL_MS;
    if (pool) {
      try {
        // 2. Manual home grid (the 'hub' row) — authoritative until changed.
        const { rows: hubRows } = await pool.query(
          `SELECT device_id, lat, lon, accuracy_m, source, updated_at FROM hub_locations WHERE device_id = $1 ORDER BY updated_at DESC LIMIT 1`, [ENV_NAME]);
        if (hubRows && hubRows.length) {
          return { ok: true, lat: hubRows[0].lat, lon: hubRows[0].lon, accuracy_m: hubRows[0].accuracy_m != null ? Number(hubRows[0].accuracy_m) : null, source: hubRows[0].source || 'manual', deviceId: hubRows[0].device_id, updated_at: hubRows[0].updated_at, note: 'manual home grid' };
        }
        const { rows } = await pool.query(
          `SELECT device_id, lat, lon, accuracy_m, source, updated_at FROM hub_locations
           WHERE updated_at > now() - make_interval(secs => $1) AND device_id <> $2
           ORDER BY updated_at DESC LIMIT 1`, [ttl / 1000, ENV_NAME]);
        if (rows && rows.length) {
          return { ok: true, lat: rows[0].lat, lon: rows[0].lon, accuracy_m: rows[0].accuracy_m != null ? Number(rows[0].accuracy_m) : null, source: rows[0].source || 'device', deviceId: rows[0].device_id, updated_at: rows[0].updated_at, note: 'latest family-device fix' };
        }
      } catch (e) {
        logFn('[location] device lookup failed: ' + e);
      }
    }
    // IP geolocation fallback, cached.
    const now = Date.now();
    if (ipCache && now - ipCachedAt < IP_CACHE_MS) {
      return { ok: true, ...ipCache, note: 'IP geolocation (cached)' };
    }
    const ip = await ipGeolocate(logFn);
    if (ip) {
      ipCache = ip; ipCachedAt = now;
      return { ok: true, ...ip, note: 'IP geolocation' };
    }
    return { ok: false, error: 'no current hub location: set HUB_LAT/HUB_LON, report a device fix, or go online for IP geo' };
  }

  /** Minimal {lat, lon} accessor for JARV tool wiring (throws when unknown). */
  function locate() {
    return getCurrent().then((c) => {
      if (!c.ok) throw new Error(c.error);
      return { lat: c.lat, lon: c.lon, source: c.source, accuracy_m: c.accuracy_m, updated_at: c.updated_at };
    });
  }

  async function report({ lat, lon, accuracy_m = null, source = 'device', deviceId = null }) {
    const id = (deviceId && String(deviceId).slice(0, 80)) || `device-${Date.now()}`;
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return { ok: false, error: 'lat/lon must be numbers' };
    if (pool) {
      try {
        await pool.query(`INSERT INTO hub_locations (device_id, lat, lon, accuracy_m, source, updated_at)
                          VALUES ($1, $2, $3, $4, $5, now())
                          ON CONFLICT (device_id) DO UPDATE SET lat = $2, lon = $3, accuracy_m = $4, source = $5, updated_at = now()`,
          [id, Number(lat), Number(lon), accuracy_m != null ? Number(accuracy_m) : null, source]);
      } catch (e) {
        logFn('[location] report failed: ' + e);
        return { ok: false, error: String((e && e.message) || e) };
      }
    }
    logFn(`[location] fix reported device=${id} ${Number(lat).toFixed(4)},${Number(lon).toFixed(4)} src=${source}`);
    return { ok: true, lat: Number(lat), lon: Number(lon), deviceId: id, source };
  }

  async function setManual({ lat, lon, accuracy_m = 25 }) {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return { ok: false, error: 'lat/lon must be numbers' };
    if (pool) {
      try {
        await pool.query(`INSERT INTO hub_locations (device_id, lat, lon, accuracy_m, source, updated_at)
                          VALUES ($1, $2, $3, $4, 'manual', now())
                          ON CONFLICT (device_id) DO UPDATE SET lat = $2, lon = $3, accuracy_m = $4, source = 'manual', updated_at = now()`,
          [ENV_NAME, Number(lat), Number(lon), Number(accuracy_m)]);
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }
    return { ok: true, lat: Number(lat), lon: Number(lon), deviceId: ENV_NAME, source: 'manual' };
  }

  async function getDevices() {
    if (!pool) return { ok: true, devices: [] };
    try {
      const { rows } = await pool.query(`SELECT device_id, lat, lon, accuracy_m, source, updated_at FROM hub_locations ORDER BY updated_at DESC`);
      return { ok: true, devices: rows };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  return { getCurrent, locate, report, setManual, getDevices };
}

module.exports = { makeLocationService, DEFAULT_TTL_MS };