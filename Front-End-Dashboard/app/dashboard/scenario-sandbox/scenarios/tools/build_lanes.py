"""Build the lane table in lib/nlex-lanes.ts: through lanes per direction, interchange to interchange, from OpenStreetMap.

    python build_lanes.py [cache_dir]

FREE: OpenStreetMap data (ODbL licence; credit "(c) OpenStreetMap contributors") read through the public
Overpass API, which needs no account or key. One request, cached in `cache_dir`, so a re-run downloads
nothing. The app never calls OpenStreetMap: it reads the generated table.

HOW
  - Every motorway way named North Luzon Expressway in the corridor's box, with its `lanes` tag.
  - Each piece of it is placed on the corridor by the km-post its midpoint projects to (the same chain of
    interchanges build_toll_plazas.py uses), and given NB or SB by the direction it runs against the
    corridor's own northbound heading.
  - Toll plaza booth fans (7 lanes or more) are left out: they are the plaza, not the road.
  - Per direction and per stretch between consecutive interchanges, the lane count covering the most metres
    is the stretch's width, and its share is kept in the source note. OSM is volunteer data: an official NLEX
    lane plan would override this.
"""
import collections
import datetime
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "..", "lib", "nlex-lanes.ts"))
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "osm_cache")
os.makedirs(CACHE, exist_ok=True)

# lib/nlex-exits.ts FALLBACK_EXITS: name, latitude, longitude, km-post (as in build_toll_plazas.py).
EXITS = [
    ("Balintawak", 14.678767, 121.000089, 12.0), ("NLEX Harbor Link", 14.693465, 121.000308, 13.63),
    ("Paso De Blas Valenzuela", 14.708213, 120.993002, 15.44), ("Meycauayan", 14.746388, 120.972316, 20.21),
    ("Marilao", 14.774562, 120.957267, 23.73), ("Cdv/Ph Arena", 14.793124, 120.947256, 26.05),
    ("Bocaue Barrier", 14.802456, 120.942456, 27.2), ("Bocaue Interchange", 14.807234, 120.939400, 27.82),
    ("Tambubong", 14.815124, 120.935071, 28.81), ("Tabang Guiguinto", 14.832746, 120.903911, 32.69),
    ("Balagtas", 14.834437, 120.900634, 33.09), ("Sta. Rita Guiguinto", 14.862453, 120.858887, 38.55),
    ("Pulilan", 14.908258, 120.817015, 45.33), ("San Simon", 14.990135, 120.749969, 56.91),
    ("San Fernando", 15.049706, 120.694856, 65.78), ("Mexico", 15.105217, 120.663619, 72.78),
    ("Angeles", 15.163114, 120.613459, 81.15), ("Dau", 15.178009, 120.604629, 83.05),
    ("Sctex", 15.196301, 120.597121, 85.23), ("Sta. Ines", 15.222037, 120.587835, 88.25),
]
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
HEADERS = {"User-Agent": "SmartFlow-NLEX-capstone/1.0 (student research; low volume)", "Accept": "*/*"}
QUERY = '[out:json][timeout:120];way["highway"="motorway"](14.66,120.57,15.24,121.02);out tags geom;'
PLAZA_FAN = 7  # lanes at or above this are a toll plaza's booths
MAX_OFF_M = 1500  # further from the corridor chain than this is another road


def load():
    path = os.path.join(CACHE, "osm_nlex_mainline.json")
    if not os.path.exists(path):
        data = urllib.parse.urlencode({"data": QUERY}).encode()
        for attempt in range(6):
            ep = ENDPOINTS[attempt % len(ENDPOINTS)]
            try:
                with urllib.request.urlopen(urllib.request.Request(ep, data=data, headers=HEADERS), timeout=180) as r:
                    body = r.read()
                if body[:1] == b"{":
                    open(path, "wb").write(body)
                    break
            except Exception as e:  # a busy server; wait and try the other one
                print(f"   {type(e).__name__} from {ep}", flush=True)
            time.sleep(20 + attempt * 10)
        else:
            sys.exit("Overpass is too busy right now; run again later.")
    return json.load(open(path))


LAT0 = 14.95
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110574


def xy(lat, lon):
    return ((lon - 120.8) * KX, (lat - LAT0) * KY)


CHAIN = [(k, *xy(la, lo)) for _, la, lo, k in EXITS]


def project(lat, lon):
    px, py = xy(lat, lon)
    best = None
    for i in range(len(CHAIN) - 1):
        k0, ax, ay = CHAIN[i]
        k1, bx, by = CHAIN[i + 1]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
        dist = math.hypot(px - ax - t * dx, py - ay - t * dy)
        if best is None or dist < best[0]:
            ln = math.sqrt(l2)
            best = (dist, k0 + t * (k1 - k0), (dx / ln, dy / ln))
    return best


def measure(d):
    """Metres of road at each lane count, per direction and per stretch (index of its first interchange)."""
    acc = {dr: collections.defaultdict(collections.Counter) for dr in ("NB", "SB")}
    for w in d["elements"]:
        t = w.get("tags", {})
        if w["type"] != "way" or "North Luzon" not in (t.get("name", "") + t.get("official_name", "")):
            continue
        try:
            lanes = int(t.get("lanes", ""))
        except ValueError:
            continue
        if lanes >= PLAZA_FAN:
            continue
        g = w.get("geometry", [])
        if t.get("oneway") == "-1":
            g = list(reversed(g))
        for a, b in zip(g, g[1:]):
            x1, y1 = xy(a["lat"], a["lon"])
            x2, y2 = xy(b["lat"], b["lon"])
            dist, km, (ux, uy) = project((a["lat"] + b["lat"]) / 2, (a["lon"] + b["lon"]) / 2)
            if dist > MAX_OFF_M:
                continue
            dr = "NB" if (x2 - x1) * ux + (y2 - y1) * uy > 0 else "SB"
            for i in range(len(EXITS) - 1):
                if EXITS[i][3] <= km < EXITS[i + 1][3]:
                    acc[dr][i][lanes] += math.hypot(x2 - x1, y2 - y1)
                    break
    return acc


def main():
    acc = measure(load())
    today = datetime.date.today().isoformat()
    rows = []
    for dr in ("NB", "SB"):
        for i in range(len(EXITS) - 1):
            c = acc[dr][i]
            if not c:
                print(f"  {dr} {EXITS[i][0]} -> {EXITS[i + 1][0]}: nothing mapped, left out")
                continue
            lanes, metres = c.most_common(1)[0]
            share = metres / sum(c.values()) * 100
            src = f"OpenStreetMap lanes tags (© OpenStreetMap contributors), read {today}: {lanes} lanes on {share:.0f}% of this stretch"
            rows.append(f'  {{ fromKm: {EXITS[i][3]}, toKm: {EXITS[i + 1][3]}, lanes: {lanes}, direction: "{dr}", source: "{src}" }},')
            print(f"  {dr} {EXITS[i][0][:18]:>18} -> {EXITS[i + 1][0][:18]:<18} {lanes} lanes ({share:.0f}%)")
    block = "\n".join(rows)
    text = open(OUT, encoding="utf-8").read()
    new, n = re.subn(
        r"(// BEGIN GENERATED by scenarios/tools/build_lanes\.py[^\n]*\n)(.*?)([ \t]*// END GENERATED)",
        lambda m: m.group(1) + block + "\n" + m.group(3),
        text,
        flags=re.S,
    )
    if n != 1:
        sys.exit("lib/nlex-lanes.ts has no generated block to fill.")
    open(OUT, "w", encoding="utf-8", newline="\n").write(new)
    print(f"wrote {len(rows)} stretches to {OUT}")


if __name__ == "__main__":
    main()
