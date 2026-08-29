#!/usr/bin/env python3
"""
jarv-satvision.py — Satellite communications intelligence for JARV-Genie.

Provides OSINT-style satellite coverage analysis for consumer-grade
communications satellites (Starlink, OneWeb, Iridium, Globalstar, GPS, etc.).

Usage from JARV (via jarv_run):
  python3 jarv-satvision.py --lat 37.7749 --lon -122.4194 --satellites starlink,oneweb,iridium --passes 5
  python3 jarv-satvision.py --lat 37.7749 --lon -122.4194 --footprint --radius-km 1000
  python3 jarv-satvision.py --satellites starlink --overhead --lat 37.7749 --lon -122.4194
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import math
from datetime import datetime, timezone
from orbitdeck.engine import SatDb, Predictor, Observer


CELESTRAK_GROUPS = {
    "starlink": "starlink",
    "oneweb": "oneweb",
    "iridium": "iridium",
    "iridium-next": "iridium-next",
    "globalstar": "globalstar",
    "gps": "gps-ops",
    "galileo": "galileo",
    "glonass": "glonass",
    "beidou": "beidou",
    "geo": "geo",
    "active": "active",
}

RE_KM = 6378.135

CACHE_FRESH_SECS = 2 * 3600  # CelesTrak refreshes GROUPs roughly every 2 hours


def fetch_tle_group(group: str) -> str:
    """Fetch TLE data from CelesTrak for a group, with a retry/backoff and a
    persistent on-disk cache so a flaky or rate-limited CelesTrak (503/403,
    the documented 'reuse cached data' cases) never blinds the tunnel.

    Strategy: serve from cache when it is young (< CACHE_FRESH_SECS), else try
    the network; on failure fall back to any cached copy, whatever its age.
    """
    cache_group = group
    fetch_group = CELESTRAK_GROUPS.get(group, "active")
    cache = load_cache()
    cached = cache.get(cache_group)
    if cached and time.time() - cached.get("fetched_at", 0) < CACHE_FRESH_SECS:
        print(f"Using fresh cached TLE for {cache_group}", file=sys.stderr)
        return cached["data"]
    url = f"https://celestrak.org/NORAD/elements/gp.php?GROUP={fetch_group}&FORMAT=json"
    req = urllib.request.Request(url, headers={"User-Agent": "jarv-satvision/1.0"})
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read().decode("utf-8")
            cache[cache_group] = {"fetched_at": time.time(), "data": data}
            save_cache(cache)
            print(f"Fetched {cache_group} from CelesTrak", file=sys.stderr)
            return data
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (403, 429, 503):
                wait = 8 * (attempt + 1)
                print(f"TLE fetch {cache_group}: HTTP {e.code} (throttled) — retry in {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            break
        except Exception as e:
            last_err = e
            wait = 4 * (attempt + 1)
            print(f"TLE fetch {cache_group} failed ({e}) — retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    if cached:
        print(f"Using stale cached TLE for {cache_group} ({last_err})", file=sys.stderr)
        return cached["data"]
    raise last_err if last_err else RuntimeError(f"no TLE for {cache_group}")


def cache_file() -> str:
    """Stable per-host cache path (survives restarts, never shipped)."""
    base = os.environ.get("JARV_TLE_CACHE") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "jarv-sandbox", "tmp", "tle-cache.json")
    if os.environ.get("JARV_TLE_CACHE") is None:
        os.makedirs(os.path.dirname(base), exist_ok=True)
    return base


def load_cache() -> dict:
    try:
        with open(cache_file(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_cache(cache: dict) -> None:
    path = cache_file()
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f)
        os.replace(tmp, path)
    except Exception as e:
        print(f"TLE cache write failed: {e}", file=sys.stderr)


def load_catalog(groups: list[str]) -> SatDb:
    """Load TLE catalog for specified satellite groups."""
    db = SatDb()
    total = 0
    for group in groups:
        try:
            data = fetch_tle_group(group)
            count = db.load_gp_json(data)
            total += count
            print(f"Loaded {count} satellites from {group}", file=sys.stderr)
        except Exception as e:
            print(f"Failed to load {group}: {e}", file=sys.stderr)
    print(f"Total: {total} satellites", file=sys.stderr)
    return db


def filter_satellites(db: SatDb, types: list[str]) -> list:
    """Filter satellites by name/type keywords."""
    keywords = [t.lower() for t in types]
    result = []
    for sat in db.sats:
        name_lower = sat.name.lower()
        if any(kw in name_lower for kw in keywords):
            result.append(sat)
    return result


def compute_range_km(sat, observer: Observer, unix: float) -> float:
    """Compute slant range from observer to satellite."""
    # Get satellite position in TEME
    pred = Predictor()
    pred.set_site(observer)
    pred.set_sat(sat)
    r, _ = pred._eci_state(unix) if pred._have else (None, None)
    if r is None:
        return 0.0
    # Observer position in TEME
    ox, oy, oz, _ = pred._observer_teme(unix)
    rx, ry, rz = r[0] - ox, r[1] - oy, r[2] - oz
    return math.sqrt(rx * rx + ry * ry + rz * rz)


def get_sat_position(sat, observer: Observer, unix: float):
    """Get satellite subpoint lat/lon/alt at given time."""
    pred = Predictor()
    pred.set_site(observer)
    pred.set_sat(sat)
    if not pred._have:
        return None, None, None
    return pred.subpoint_at(unix)


def predict_passes(db: SatDb, observer: Observer, satellites: list, min_el: float, max_n: int):
    """Predict passes for a list of satellites."""
    results = []
    for sat in satellites:
        pred = Predictor()
        pred.set_site(observer)
        pred.set_sat(sat)
        try:
            passes = list(pred.predict_passes(time.time(), min_el=min_el, max_n=max_n))
            for p in passes:
                az, el = pred.azel_at(p.tca)
                results.append({
                    "satellite": sat.name,
                    "norad": sat.norad,
                    "aos": datetime.fromtimestamp(p.aos, tz=timezone.utc).isoformat(),
                    "los": datetime.fromtimestamp(p.los, tz=timezone.utc).isoformat(),
                    "tca": datetime.fromtimestamp(p.tca, tz=timezone.utc).isoformat(),
                    "max_elevation_deg": round(p.max_el, 1),
                    "duration_min": round((p.los - p.aos) / 60, 1),
                    "azimuth_at_tca_deg": round(az, 1),
                })
        except Exception as e:
            print(f"Pass prediction failed for {sat.name}: {e}", file=sys.stderr)
    return results


def get_overhead(db: SatDb, observer: Observer, satellites: list, min_el: float = 10.0):
    """Get currently overhead satellites above minimum elevation."""
    now = time.time()
    results = []
    for sat in satellites:
        pred = Predictor()
        pred.set_site(observer)
        pred.set_sat(sat)
        if not pred._have:
            continue
        try:
            az, el = pred.azel_at(now)
            if el >= min_el:
                range_km = compute_range_km(sat, observer, now)
                lat, lon, alt = get_sat_position(sat, observer, now)
                results.append({
                    "satellite": sat.name,
                    "norad": sat.norad,
                    "elevation_deg": round(el, 1),
                    "azimuth_deg": round(az, 1),
                    "range_km": round(range_km, 1),
                    "subpoint_lat": round(lat, 4) if lat else None,
                    "subpoint_lon": round(lon, 4) if lon else None,
                    "subpoint_alt_km": round(alt, 1) if alt else None,
                })
        except Exception as e:
            print(f"Overhead check failed for {sat.name}: {e}", file=sys.stderr)
    return sorted(results, key=lambda x: -x["elevation_deg"])


def get_footprint(sat, observer: Observer):
    """Calculate satellite footprint (coverage circle on Earth)."""
    try:
        pred = Predictor()
        pred.set_site(observer)
        pred.set_sat(sat)
        if not pred._have:
            return {"satellite": sat.name, "error": "no propagation data"}
        # Get satellite altitude from subpoint
        lat, lon, alt_km = pred.subpoint_at(time.time())
        if alt_km is None:
            return {"satellite": sat.name, "error": "no altitude data"}
        # Footprint radius = Earth radius * acos(Re / (Re + alt))
        ratio = RE_KM / (RE_KM + alt_km)
        fp_radius_km = RE_KM * math.acos(max(-1.0, min(1.0, ratio)))
        return {
            "satellite": sat.name,
            "norad": sat.norad,
            "footprint_radius_km": round(fp_radius_km, 1),
            "subpoint_lat": round(lat, 4),
            "subpoint_lon": round(lon, 4),
            "altitude_km": round(alt_km, 1),
        }
    except Exception as e:
        return {"satellite": sat.name, "error": str(e)}


def get_all_positions(db: SatDb, groups: list[str]) -> list:
    """Subpoint (lat/lon/alt) of every loaded satellite right now — the global
    projection for the sanctuary globe. Observer-independent."""
    now = time.time()
    out = []
    for sat in db.sats:
        try:
            pred = Predictor()
            pred.set_sat(sat)
            if not pred._have:
                continue
            lat, lon, alt = pred.subpoint_at(now)
            if lat is None or lon is None:
                continue
            span = sat.name.lower()
            group = next((g for g in groups if g.lower() in span), "other")
            out.append({
                "satellite": sat.name,
                "norad": sat.norad,
                "group": group,
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "alt_km": round(alt, 1),
            })
        except Exception as e:
            print(f"Position failed for {sat.name}: {e}", file=sys.stderr)
    return out


def main():
    parser = argparse.ArgumentParser(description="Satellite communications vision for JARV")
    parser.add_argument("--lat", type=float, default=None, help="Observer latitude (omit only with --positions)")
    parser.add_argument("--lon", type=float, default=None, help="Observer longitude (omit only with --positions)")
    parser.add_argument("--alt", type=float, default=10.0, help="Observer altitude (meters)")
    parser.add_argument("--satellites", type=str, default="starlink,oneweb,iridium,gps",
                        help="Comma-separated satellite groups to track")
    parser.add_argument("--passes", type=int, default=3, help="Max passes per satellite")
    parser.add_argument("--min-el", type=float, default=10.0, help="Minimum elevation (degrees)")
    parser.add_argument("--overhead", action="store_true", help="Show currently overhead satellites")
    parser.add_argument("--footprint", action="store_true", help="Calculate coverage footprints")
    parser.add_argument("--radius-km", type=float, default=1000, help="Footprint radius limit")
    parser.add_argument("--positions", action="store_true", help="Global projection: subpoint of every loaded sat (no observer)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    groups = [g.strip() for g in args.satellites.split(",")]
    db = load_catalog(groups)
    satellites = filter_satellites(db, groups)

    result = {"timestamp": datetime.now(timezone.utc).isoformat()}

    if args.positions:
        result["mode"] = "globe"
        result["positions"] = get_all_positions(db, groups)
        result["satellites_tracked"] = len(satellites)
        if args.json:
            print(json.dumps(result))
        else:
            print(f"Global OSINT projection — {result['timestamp']}")
            print(f"Sats: {len(result['positions'])} positions from {args.satellites}")
        return

    if args.lat is None or args.lon is None:
        parser.error("--lat and --lon are required unless --positions is used")

    observer = Observer(lat=args.lat, lon=args.lon, alt_m=args.alt, valid=True)
    result["observer"] = {"lat": args.lat, "lon": args.lon, "alt_m": args.alt}
    result["satellites_tracked"] = len(satellites)

    if args.overhead:
        result["overhead"] = get_overhead(db, observer, satellites, args.min_el)

    if args.passes > 0:
        result["passes"] = predict_passes(db, observer, satellites, args.min_el, args.passes)

    if args.footprint:
        result["footprints"] = [get_footprint(s, observer) for s in satellites[:20]]

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Satellite Vision — {result['timestamp']}")
        print(f"Observer: {args.lat:.4f}, {args.lon:.4f} @ {args.alt}m")
        print(f"Tracking: {len(satellites)} satellites from {args.satellites}")
        if "overhead" in result:
            print(f"\nOverhead (>{args.min_el}°):")
            for s in result["overhead"][:10]:
                print(f"  {s['satellite']}: el={s['elevation_deg']}° az={s['azimuth_deg']}° range={s['range_km']}km")
        if "passes" in result:
            print(f"\nUpcoming passes:")
            for p in result["passes"][:15]:
                print(f"  {p['satellite']}: AOS={p['aos'][:19]} max_el={p['max_elevation_deg']}° dur={p['duration_min']}min")
        if "footprints" in result:
            print(f"\nFootprints:")
            for f in result["footprints"][:10]:
                if "footprint_radius_km" in f:
                    print(f"  {f['satellite']}: radius={f['footprint_radius_km']}km @ {f['subpoint_lat']},{f['subpoint_lon']}")


if __name__ == "__main__":
    main()