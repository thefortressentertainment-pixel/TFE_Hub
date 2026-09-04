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
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import math
from datetime import datetime, timezone, timedelta
from orbitdeck.engine import SatDb, Predictor, Observer


CELESTRAK_GROUPS = {
    "starlink": "starlink",
    "oneweb": "oneweb",
    "iridium": "iridium",
    "iridium-next": "iridium-next",
    "globalstar": "globalstar",
    "gps": "gps-ops",
    "galileo": "galileo",
    "glonass": "glo-ops",
    "beidou": "beidou",
    "geo": "geo",
    "stations": "stations",
    "iss": "stations",
    "active": "active",
}

# Reachable CelesTrak mirrors for when celestrak.org itself is unreachable
# from this network. Preference order in fetch_tle_group():
#   CelesTrak (authoritative) -> retlector.eu (full OMM groups, live) ->
#   tle.ivanstanojevic.me (classic lines, hard-capped at 20 results).
RETLECTOR_API = "https://retlector.eu"          # ReTLEctor: GROUPME/json -> OMM array
# Groups retlector.eu does not serve directly are satisfied from its
# "active-no-starlink" (full live catalog minus Starlink) with a name filter.
RETLECTOR_OVERRIDE = {
    "iridium": ("active-no-starlink", lambda o: "IRIDIUM" in (o.get("OBJECT_NAME") or "").upper()),
    "iridium-next": ("active-no-starlink", lambda o: "IRIDIUM" in (o.get("OBJECT_NAME") or "").upper()),
}
MIRROR_API = "https://tle.ivanstanojevic.me/api/tle"
MIRROR_SEARCH = {
    "starlink": "starlink",
    "oneweb": "oneweb",
    "iridium": "iridium",
    "iridium-next": "iridium",
    "globalstar": "globalstar",
    "gps": "navstar",
    "galileo": "galileo",
    "glonass": "glonass",
    "beidou": "beidou",
    "iss": "iss",
}
MIRROR_CAP = 1000  # bounded pagination; plenty for the globe projection
OVERHEAD_SCAN_CAP = 3000  # even per-group sample; the whole sky, not the whole catalog
OVERHEAD_MAX_RESULTS = 120  # top-N by elevation handed to the AI (keeps output small)
PASS_SCAN_CAP = 1000  # even per-group sample for pass windows (each is a time search)
PASS_RESULT_CAP = 300  # best pass windows by max elevation handed to the AI

RE_KM = 6378.135

CACHE_FRESH_SECS = 2 * 3600  # CelesTrak refreshes GROUPs roughly every 2 hours

# Name keywords don't always contain the group slug (e.g. "IRIDIUM 104"),
# so match on aliases when tagging/filtering.
GROUP_ALIASES = {
    "starlink": ["starlink"],
    "oneweb": ["oneweb"],
    "iridium": ["iridium"],
    "iridium-next": ["iridium"],
    "gps": ["gps", "navstar"],
    "galileo": ["galileo"],
    "glonass": ["glonass", "cosmos "],
    "beidou": ["beidou"],
    "geo": [],
    "globalstar": ["globalstar"],
    "iss": ["iss", "zarya", "yymt"],
    "active": [],
}

ALL_GROUPS = list(CELESTRAK_GROUPS.keys())


def fetch_tle_group(group: str) -> str:
    """Fetch TLE data for a group with a persistent on-disk cache and a
    three-source strategy:
      1. CelesTrak (authoritative; short timeout so an unreachable network
         fails fast instead of hanging the globe for minutes).
      2. retlector.eu (ReTLEctor) — the full live CelesTrak group as OMM JSON,
         reached the moment CelesTrak cannot be reached.
      3. tle.ivanstanojevic.me mirror (classic line1/line2 -> OMM), a smaller
         fallback capped at MIRROR_CAP results.

    Serve from cache when it is young (< CACHE_FRESH_SECS); on total failure
    fall back to any cached copy, whatever its age.
    """
    cache_group = group
    fetch_group = CELESTRAK_GROUPS.get(group, "active")
    cache = load_cache()
    cached = cache.get(cache_group)
    if cached and time.time() - cached.get("fetched_at", 0) < CACHE_FRESH_SECS:
        print(f"Using fresh cached TLE for {cache_group}", file=sys.stderr)
        return cached["data"]

    data = None
    source = None
    rt_group, rt_filter = RETLECTOR_OVERRIDE.get(group, (fetch_group, None))
    for src_name, fn in (
        ("CelesTrak", lambda: _fetch_celestrak(fetch_group)),
        ("retlector.eu", lambda: _fetch_retlector(rt_group, rt_filter)),
        ("tle.ivanstanojevic.me", lambda: _fetch_mirror_tle(group)),
    ):
        data = fn()
        if data is not None:
            source = src_name
            break
    if data is not None:
        cache[cache_group] = {"fetched_at": time.time(), "data": data, "source": source}
        save_cache(cache)
        print(f"Fetched {cache_group} from {source}", file=sys.stderr)
        return data
    if cached:
        print(f"Using stale cached TLE for {cache_group}", file=sys.stderr)
        return cached["data"]
    raise RuntimeError(f"no TLE for {cache_group} (CelesTrak unreachable and mirror unavailable)")


def _fetch_celestrak(fetch_group: str):
    """Best-effort CelesTrak fetch. Throttle responses (403/429/503) retry
    briefly; connection-level failures (blocked network) bail immediately."""
    url = f"https://celestrak.org/NORAD/elements/gp.php?GROUP={fetch_group}&FORMAT=json"
    req = urllib.request.Request(url, headers={"User-Agent": "jarv-satvision/1.0"})
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=12) as resp:
                return resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code in (403, 429, 503):
                print(f"CelesTrak {fetch_group}: HTTP {e.code} (throttled) — retry in {5 * (attempt + 1)}s", file=sys.stderr)
                time.sleep(5 * (attempt + 1))
                continue
            return None
        except Exception as e:
            print(f"CelesTrak unreachable for {fetch_group} ({e}) — using mirror", file=sys.stderr)
            return None
    return None


def _tle_num(field) -> float:
    """Decode a TLE numeric subfield: normal decimals, implied-decimal mantissas,
    and exponent forms like ' 39011-3' -> 0.39011e-3."""
    s = str(field).strip()
    if not s:
        return 0.0
    if "." in s:
        return float(s)
    m = re.search(r"([+-]\d{1,2})$", s)
    if m and m.start() > 0:
        body = s[:m.start()]
        exp = int(m.group(1))
        sign = -1.0 if body.startswith("-") else 1.0
        digits = re.sub(r"\D", "", body.lstrip("+-"))
        val = float("0." + digits) if digits else 0.0
        return sign * val * (10 ** exp)
    return float(s)


def _tle_to_omm(member: dict) -> dict:
    """Convert a mirror {name, satelliteId, date, line1, line2} entry to the OMM
    element-set dict that orbitdeck's _ingest() expects."""
    try:
        line1 = (member.get("line1") or "").strip()
        line2 = (member.get("line2") or "").strip()
        if len(line1) < 68 or len(line2) < 68:
            return None
        satnum = int(line1[2:7])
        ey = int(line1[18:20])
        year = 2000 + ey if ey < 57 else 1900 + ey
        doy = float(line1[20:32])
        epoch = (datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=doy - 1))
        ecc = float("0." + line2[26:33].strip()) if "." not in line2[26:33] else float(line2[26:33])
        intl_des = line1[9:17].strip()
        elset = line1[64:68].strip()
        return {
            "OBJECT_NAME": (member.get("name") or "")[:25],
            "OBJECT_ID": intl_des or f"{satnum:05d}",
            "EPOCH": epoch.strftime("%Y-%m-%dT%H:%M:%S.000000"),
            "NORAD_CAT_ID": satnum,
            "INCLINATION": _tle_num(line2[8:16]),
            "RA_OF_ASC_NODE": _tle_num(line2[17:25]),
            "ECCENTRICITY": ecc,
            "ARG_OF_PERICENTER": _tle_num(line2[34:42]),
            "MEAN_ANOMALY": _tle_num(line2[43:51]),
            "MEAN_MOTION": _tle_num(line2[52:63]),
            "BSTAR": _tle_num(line1[53:61]),
            "MEAN_MOTION_DOT": _tle_num(line1[33:43]),
            "MEAN_MOTION_DDOT": _tle_num(line1[44:52]),
            "REV_AT_EPOCH": int(_tle_num(line2[63:68])) if line2[63:68].strip() else 0,
            "ELEMENT_SET_NO": int(elset) if elset.isdigit() else 1,
        }
    except Exception as e:
        print(f"TLE->OMM skip ({member.get('name')}): {e}", file=sys.stderr)
        return None


def _fetch_mirror_tle(group: str):
    """Fetch classic TLE lines from the mirror, convert to OMM JSON,
    bounded by MIRROR_CAP to keep the fetch quick."""
    query = MIRROR_SEARCH.get(group)
    if not query:
        return None
    out = []
    offset = 0
    limit = 20  # mirror hard-caps pages at 20 regardless of requested limit
    while offset < MIRROR_CAP:
        url = f"{MIRROR_API}?search={urllib.parse.quote(query)}&limit={limit}&offset={offset}"
        req = urllib.request.Request(url, headers={
            "Accept": "application/json",
            "User-Agent": "jarv-satvision/1.0",
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
        member = (data or {}).get("member") or []
        total = (data or {}).get("totalItems") or 0
        for m in member:
            omm = _tle_to_omm(m)
            if omm:
                out.append(omm)
        got = len(member)
        print(f"mirror {group}: fetched {got} (have {len(out)}/{total}, cap {MIRROR_CAP})", file=sys.stderr)
        if got < limit or 0 < total <= len(out):
            break
        offset += got
    return json.dumps(out) if out else None


def _fetch_retlector(fetch_group: str, name_filter=None):
    """Full-group OMM JSON from the ReTLEctor CelesTrak mirror (retlector.eu).
    Returns raw JSON text (an OMM array) exactly like CelesTrak FORMAT=json.
    name_filter, when supplied, is applied client-side (used for groups that
    the mirror satisfies out of 'active-no-starlink')."""
    url = f"{RETLECTOR_API}/{fetch_group}/json"
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "jarv-satvision/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read().decode("utf-8")
        arr = json.loads(raw)
        if not isinstance(arr, list) or not arr:
            print(f"retlector.eu {fetch_group}: empty or bad payload", file=sys.stderr)
            return None
        if name_filter:
            wanted = [o for o in arr if name_filter(o)]
            print(f"retlector.eu {fetch_group}: {len(arr)} -> {len(wanted)} after filter", file=sys.stderr)
            if not wanted:
                return None
            return json.dumps(wanted)
        return raw
    except Exception as e:
        print(f"retlector.eu fetch failed for {fetch_group} ({e})", file=sys.stderr)
        return None


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
    """Load TLE catalog for specified satellite groups, tagging provenance.

    Uses _ingest(replace=False) so multiple groups accumulate in one SatDb
    (load_gp_json would replace the catalog on every group).
    """
    db = SatDb()
    total = 0
    for group in groups:
        try:
            data = fetch_tle_group(group)
            parsed = data if isinstance(data, list) else json.loads(data)
            before = {sat.norad for sat in db.sats}
            count = db._ingest(parsed, replace=False)
            for sat in db.sats:
                if sat.norad not in before:
                    sat.src = group
            total += count
            print(f"Loaded {count} satellites from {group}", file=sys.stderr)
        except Exception as e:
            print(f"Failed to load {group}: {e}", file=sys.stderr)
    print(f"Total: {total} satellites", file=sys.stderr)
    return db


def _group_matches(sat, group: str) -> bool:
    src = getattr(sat, "src", None)
    if src:
        return src == group
    aliases = GROUP_ALIASES.get(group, [group])
    name_lower = sat.name.lower()
    return any(alias in name_lower for alias in aliases)


def filter_satellites(db: SatDb, types: list[str]) -> list:
    """Filter satellites by requested groups (name aliases + load provenance)."""
    result = []
    for sat in db.sats:
        if any(_group_matches(sat, t) for t in types):
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


def _bounded_sample(satellites: list, cap: int) -> list:
    """Even per-group sample of a satellite list, so one giant constellation
    cannot dominate (or stall) a query meant over the whole sky."""
    if len(satellites) <= cap:
        return satellites
    by_group = {}
    for sat in satellites:
        by_group.setdefault(getattr(sat, "src", None) or "other", []).append(sat)
    per = max(cap // max(len(by_group), 1), 50)
    out = []
    for sats in by_group.values():
        out.extend(sats[:per])
    return out


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle ground distance in km."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * RE_KM * math.asin(min(1.0, math.sqrt(a)))


def predict_passes(db: SatDb, observer: Observer, satellites: list, min_el: float, max_n: int):
    """Predict passes for a bounded, even per-group sample of satellites."""
    results = []
    pred = Predictor()
    pred.set_site(observer)
    for sat in _bounded_sample(satellites, PASS_SCAN_CAP):
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
    results.sort(key=lambda x: -x["max_elevation_deg"])
    return results[:PASS_RESULT_CAP]


def get_overhead(db: SatDb, observer: Observer, satellites: list, min_el: float = 10.0):
    """Currently overhead satellites above minimum elevation, computed over an
    even per-group sample (OVERHEAD_SCAN_CAP) so a full Starlink constellation
    cannot stall this tool. One Predictor is reused; latitude from azel, then a
    single SGP4 subpoint per qualifying satellite."""
    now = time.time()
    results = []
    pred = Predictor()
    pred.set_site(observer)
    scanned = 0
    for sat in _bounded_sample(satellites, OVERHEAD_SCAN_CAP):
        pred.set_sat(sat)
        if not pred._have:
            continue
        scanned += 1
        try:
            az, el = pred.azel_at(now)
            if el >= min_el:
                lat, lon, alt = pred.subpoint_at(now)
                if lat is None or lon is None:
                    continue
                if (isinstance(lat, float) and math.isnan(lat)) or (isinstance(lon, float) and math.isnan(lon)):
                    continue
                range_km = _haversine_km(observer.lat, observer.lon if hasattr(observer, "lon") else observer.longitude, lat, lon)
                results.append({
                    "satellite": sat.name,
                    "norad": sat.norad,
                    "elevation_deg": round(el, 1),
                    "azimuth_deg": round(az, 1),
                    "range_km": round(range_km, 1),
                    "subpoint_lat": round(lat, 4),
                    "subpoint_lon": round(lon, 4),
                    "subpoint_alt_km": round(alt, 1) if alt is not None else None,
                })
        except Exception as e:
            print(f"Overhead check failed for {sat.name}: {e}", file=sys.stderr)
    results.sort(key=lambda x: -x["elevation_deg"])
    top = results[:OVERHEAD_MAX_RESULTS]
    for r in top:
        r["sample"] = f"{scanned} sats scanned of {len(satellites)} tracked"
    return top


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
            if (isinstance(lat, float) and math.isnan(lat)) or (isinstance(lon, float) and math.isnan(lon)):
                continue  # decaying/re-entering object whose SGP4 solution blew up
            span = sat.name.lower()
            group = next((g for g in groups if _group_matches(sat, g)), getattr(sat, "src", None) or "other")
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