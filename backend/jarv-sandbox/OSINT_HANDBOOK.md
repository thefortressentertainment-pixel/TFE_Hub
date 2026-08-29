# JARV — OSINT Cross-Training Handbook (Satellite Comms Intelligence)

You are cross-trained on OrbitDeck, a satellite tracking & orbital analysis
engine installed on this machine. Its job here is **communications
continuity**: knowing which satellites are overhead, which passes give you a
window to a given ground station, and what coverage a constellation provides
over a region — so the Fortress Hub / JARV link is never blind.

## Installed toolchain

- **OrbitDeck** 0.39.4 — Python package, editable install from
  `osint/OrbitDeck` (vendored in this repo). Importable as `orbitdeck` on the
  system `python3`. Uses a pure-Python SGP4 propagator plus the `sgp4`
  C-accelerated backend (deep-space / GEO correct).
- **jarv-satvision.py** — `backend/jarv-satvision.py`, the CLI wrapper you call
  through the `jarv_run` / `jarv_satvision` tools. Fetches fresh TLE elements
  from CelesTrak live (network), so results are current, not cached.

## The jarv_satvision tool

Parameters (all keys are strings):

- `lat` (required) — observer latitude, decimal degrees.
- `lon` (required) — observer longitude, decimal degrees.
- `alt` — observer altitude in meters (default 10).
- `satellites` — comma-separated groups:
  `starlink, oneweb, iridium-next, globalstar, gps, galileo, glonass, beidou, geo, active`
  (default `starlink,oneweb,iridium-next,gps`).
- `passes` — max pass predictions per satellite (default 3).
- `min_el` — minimum elevation for overhead/pass filtering in degrees
  (default 10).
- `overhead` — `true` to include satellites currently above the horizon.
- `footprint` — `true` to include Earth coverage footprints for the first 20
  tracked satellites.

Returns JSON: `observer`, `timestamp`, `satellites_tracked`, and (as requested)
`overhead[]`, `passes[]`, `footprints[]`.

### Reading the results

- `elevation_deg` — how high above the horizon. <10° is unusable for comms
  (terrain/tree line); 10–25° marginal; >25° solid for LMSS/LEO handheld.
- `azimuth_deg` — point a directional antenna here.
- `range_km` — slant range; ~500–1,200 km means LEO (Iridium ~780 km / Starlink
  ~550 km), ~20,000 km means MEO (GPS/Galileo), ~36,000 km means GEO.
- `passes[].aos/los/tca` — ISO timestamps of acquisition/loss/closest-approach.
  These are your **connectivity windows**.
- `footprints[].footprint_radius_km` — radius of the coverage circle on Earth;
  a hotspot inside two footprints = handoff possible.

## Continuity playbooks

1. **Pre-trip coverage check**: pick the destination as observer, run overhead +
   footprint for `starlink,oneweb,iridium-next`. If none overhead at min_el 10,
   list passes to find a window when coverage will exist.
2. **Emergency uplink search**: given an approximate lat/lon, run overhead for
   `iridium-next` (works to the poles, 66 sats) or `gps` as a position/time
   reference if a terminal has lost GNSS lock.
3. **Blackout forensics**: before a long tunnel, record overhead starlink/
   iridium; after a drop, re-run and diff — a constellation gap is an
   unavoidable outage; everything else is a tunnel bug to investigate locally.
4. **Footprint handoff planning**: with `footprint`, note which satellites
   overlap the observer's zip-code region so a link can hop constellations when
   one is eclipsed.

## Rules

- Always verify `satellites_tracked` > 0; if 0, the TLE fetch failed (no net)
  — say so rather than guessing.
- Distinguish LEO vs MEO vs GEO by `range_km` (not just name) when you reason
  about latency/doppler.
- Do not fabricate satellite positions when offline — if CelesTrak is
  unreachable, say the TLE source is down, don't invent passes.
## Location Services (jarv_location) & the Sanctuary Globe (jarv_globe)

- **jarv_location** pings the hub-node location services for the family grid
  fix. Precedence: manual/home coordinates (HUB_LAT/HUB_LON or the hub manual
  row) → most recent family-device fix (within TTL) → IP geolocation. Returns
  `{ok, here:{lat,lon,accuracy_m,source,updated_at}}`. Prefer it over asking
  the operator for lat/lon; you may pass `lat`/`lon` yourself only as a manual
  override when the operator explicitly gives them.
- **jarv_satvision** needs no observer: if `lat`/`lon` are omitted it pulls the
  current hub location automatically. Mention "using the family grid fix" when
  you do this.
- **jarv_globe** returns the subpoint lat/lon/alt of *every* loaded satellite
  (not just those above an observer) for the global projection / sanctuary
  globe. Use it for constellation-wide reasoning, interop windows, and
  "what's over region X" questions — the globe shows the whole system at once.
- When the family grid and the globe disagree with a CelesTrak outage, trust the
  cache + say so; never invent satellites.
