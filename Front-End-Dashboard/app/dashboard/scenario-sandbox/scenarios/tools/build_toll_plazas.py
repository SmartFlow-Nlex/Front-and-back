"""Build lib/nlex-toll-plazas.ts: every NLEX toll plaza road, from OpenStreetMap.

    python build_toll_plazas.py [cache_dir]

FREE: OpenStreetMap data (ODbL licence; credit "(c) OpenStreetMap contributors")
read through the public Overpass API, which needs no account or key. Requests
are small, few and spaced out, per the Overpass fair-use policy, and each batch
is cached in `cache_dir`, so a re-run downloads nothing it already has. The app
never calls OpenStreetMap: it reads the generated file.

WHAT IT WORKS OUT, PER BOOTH
  - the interchange it belongs to (one of the 20 in lib/nlex-exits.ts), by the
    km-post its position projects to, within a kilometre — so a plaza at an
    interchange the exit list does not have (Lawang Bato) is left out rather
    than misfiled. A plaza standing well off the expressway on another road
    (Mindanao and Karuhatan on the Harbor Link, Mabiga on SCTEX) is filed by
    where that road meets NLEX, and listed apart: the junction has no booths;
  - EXIT, ENTRY or BARRIER, from the road network, not from the patchy tags:
    walking the one-way ramps downstream from the booth reaches an NLEX
    carriageway for an entry; walking upstream comes off one for an exit; a
    booth on the NLEX carriageway itself is a barrier;
  - which carriageway (NB or SB), from the direction that carriageway's road
    runs where the ramp meets it, against the corridor's own northbound heading;
  - how many lanes the plaza has: the `lanes` tag of the road through the booth.
"""
import collections
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "..", "lib", "nlex-toll-plazas.ts"))
# The same file again for the backend, whose booth staffing plan caps each plaza
# at the booths it has. The two packages cannot import from each other.
OUT_BACKEND = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "..", "..", "Back-End", "src", "data", "nlex-toll-plazas.ts"))
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "osm_cache")
os.makedirs(CACHE, exist_ok=True)

# lib/nlex-exits.ts FALLBACK_EXITS: name, latitude, longitude, km-post.
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
KM = {n: k for n, _, _, k in EXITS}

ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
HEADERS = {"User-Agent": "SmartFlow-NLEX-capstone/1.0 (student research; low volume)", "Accept": "*/*"}
RADIUS_M = 2500
BATCH = 3
MAX_KM_FROM_EXIT = 1.0  # a plaza further along the corridor than this belongs to some other interchange
MAX_OFFSET_M = 900  # and further off it than this is on another road


def fetch(group):
    roads = "".join(f'way(around:{RADIUS_M},{la},{lo})["highway"~"^(motorway|motorway_link)$"];' for _, la, lo, _ in group)
    booths = "".join(f'node(around:{RADIUS_M},{la},{lo})["barrier"="toll_booth"];' for _, la, lo, _ in group)
    q = f"[out:json][timeout:90];({roads})->.r;({booths})->.b;.r out body;.r >;out skel qt;.b out body;"
    data = urllib.parse.urlencode({"data": q}).encode()
    for attempt in range(8):
        ep = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            with urllib.request.urlopen(urllib.request.Request(ep, data=data, headers=HEADERS), timeout=150) as r:
                body = r.read()
            if body[:1] == b"{":
                return json.loads(body)
        except Exception as e:  # busy servers time out; wait and try the other one
            print(f"   {type(e).__name__} from {ep}", flush=True)
        time.sleep(25 + attempt * 15)
    return None


def load_network():
    merged = {}
    for i in range(0, len(EXITS), BATCH):
        path = os.path.join(CACHE, f"osm_net_{i // BATCH}.json")
        if os.path.exists(path):
            d = json.load(open(path))
        else:
            group = EXITS[i:i + BATCH]
            print(f"fetching {', '.join(g[0] for g in group)}", flush=True)
            d = fetch(group)
            if d is None:
                sys.exit("Overpass is too busy right now; run again later (finished batches are cached).")
            json.dump(d, open(path, "w"))
            time.sleep(8)
        for e in d["elements"]:
            merged[(e["type"], e["id"])] = e
    return list(merged.values())


LAT0 = 14.95
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110574


def xy(lat, lon):
    return ((lon - 120.8) * KX, (lat - LAT0) * KY)


CHAIN = sorted(((k, *xy(la, lo)) for _, la, lo, k in EXITS), key=lambda r: r[0])


def project(lat, lon):
    px, py = xy(lat, lon)
    best = None
    for i in range(len(CHAIN) - 1):
        k0, ax, ay = CHAIN[i]
        k1, bx, by = CHAIN[i + 1]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy or 1e-9
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
        dist = math.hypot(px - ax - t * dx, py - ay - t * dy)
        if best is None or dist < best[0]:
            ln = math.sqrt(l2)
            best = (dist, k0 + t * (k1 - k0), (dx / ln, dy / ln))
    return best[1], best[2], best[0]


def classify(elements):
    nodes, ways, booths = {}, [], []
    for e in elements:
        if e["type"] == "node":
            if "lat" in e:
                nodes[e["id"]] = (e["lat"], e["lon"])
            if e.get("tags", {}).get("barrier") == "toll_booth":
                booths.append(e)
        elif e["type"] == "way":
            ways.append(e)

    def is_nlex(w):
        t = w.get("tags", {})
        return t.get("highway") == "motorway" and "North Luzon Expressway" in (t.get("name", "") + t.get("official_name", ""))

    def oneway(w):
        t = w.get("tags", {})
        if t.get("oneway") == "-1":
            return -1
        if t.get("oneway") == "no":
            return 0
        return 1 if t.get("highway") in ("motorway", "motorway_link") or t.get("oneway") == "yes" else 0

    fwd, rev, on = collections.defaultdict(list), collections.defaultdict(list), collections.defaultdict(list)
    for w in ways:
        ns = w.get("nodes", [])
        for n in ns:
            on[n].append(w)
        od = oneway(w)
        seq = ns if od >= 0 else list(reversed(ns))
        for a, b in zip(seq, seq[1:]):
            fwd[a].append((b, w))
            rev[b].append((a, w))
            if od == 0:
                fwd[b].append((a, w))
                rev[a].append((b, w))

    def length(a, b):
        if a not in nodes or b not in nodes:
            return 0.0
        x1, y1 = xy(*nodes[a])
        x2, y2 = xy(*nodes[b])
        return math.hypot(x2 - x1, y2 - y1)

    def carriageway(node, w):
        ns = w["nodes"]
        i = ns.index(node)
        a, b = (ns[i], ns[i + 1]) if i + 1 < len(ns) else (ns[i - 1], ns[i])
        if oneway(w) < 0:
            a, b = b, a
        if a not in nodes or b not in nodes:
            return None
        (la1, lo1), (la2, lo2) = nodes[a], nodes[b]
        x1, y1 = xy(la1, lo1)
        x2, y2 = xy(la2, lo2)
        _, (ux, uy), _ = project((la1 + la2) / 2, (lo1 + lo2) / 2)
        return "NB" if (x2 - x1) * ux + (y2 - y1) * uy > 0 else "SB"

    def reach(start, graph, limit_m=4500.0):
        """Carriageways reached along `graph`: for each, the shortest distance to it
        and the corridor km where the road meets it."""
        import heapq
        best = {start: 0.0}
        heap = [(0.0, start)]
        hits = {}
        while heap:
            dist, n = heapq.heappop(heap)
            if dist > best.get(n, float("inf")):
                continue
            for m, w in graph[n]:
                nd = dist + length(n, m)
                if nd > limit_m:
                    continue
                if is_nlex(w):
                    j = m if m in w["nodes"] else n
                    c = carriageway(j, w)
                    if c and nd < hits.get(c, (float("inf"), None))[0]:
                        hits[c] = (nd, project(*nodes[j])[0] if j in nodes else None)
                    continue
                if nd < best.get(m, float("inf")):
                    best[m] = nd
                    heapq.heappush(heap, (nd, m))
        return hits

    rows = []
    for b in booths:
        bid = b["id"]
        if bid not in nodes:
            continue
        lat, lon = nodes[bid]
        km, _, off = project(lat, lon)
        here = on.get(bid, [])
        mainline = [w for w in here if is_nlex(w)]
        lane_ways = mainline or here
        lanes = [int(w["tags"]["lanes"]) for w in lane_ways if str(w.get("tags", {}).get("lanes", "")).isdigit()]
        join_km = km
        if mainline:
            movement, dirs = "barrier", sorted({c for w in mainline for c in [carriageway(bid, w)] if c})
        else:
            down, up = reach(bid, fwd), reach(bid, rev)
            if up and not down:
                movement, side = "exit", up
            elif down and not up:
                movement, side = "entry", down
            elif up and down:
                # Reachable both ways: a loop links this plaza road to the other
                # side (a turnaround, a trumpet). It belongs to whichever side is
                # nearer along the road — an entry plaza stands near its merge.
                nearest_down, nearest_up = min(v[0] for v in down.values()), min(v[0] for v in up.values())
                if nearest_down <= nearest_up:
                    movement, side = "entry", {c: v for c, v in down.items() if v[0] <= nearest_down + 600}
                else:
                    movement, side = "exit", {c: v for c, v in up.items() if v[0] <= nearest_up + 600}
            else:
                movement, side = "other", {}
            dirs = sorted(side)
            # Where its road meets NLEX: what files a plaza that stands off on another road.
            if side and min(side.values())[1] is not None:
                join_km = min(side.values())[1]
        rows.append({
            "osmNode": bid, "name": b.get("tags", {}).get("name", ""), "movement": movement, "directions": dirs,
            "lanes": max(lanes) if lanes else None, "km": round(km, 3), "offsetM": round(off),
            "joinKm": round(join_km, 3), "ways": sorted(w["id"] for w in lane_ways),
        })
    return rows


def attach(rows):
    """Each plaza road to its interchange, dropping what belongs to none in the exit list.

    Returns the plazas at the interchanges, and apart from them the ones that
    belong to an interchange but stand well off the expressway, on the road it
    connects to (the Harbor Link's Mindanao plaza): there the junction itself
    has no booths, and the layout needs to know that rather than guess some."""
    out, away = [], []
    for r in rows:
        if r["movement"] not in ("exit", "entry", "barrier") or not r["directions"]:
            continue
        # A plaza beside the expressway is filed by where it stands; one off on
        # another road by where that road meets NLEX.
        far = r["offsetM"] > MAX_OFFSET_M
        at = r["joinKm"] if far else r["km"]
        near = min(EXITS, key=lambda e: abs(e[3] - at))
        if abs(near[3] - at) > MAX_KM_FROM_EXIT:
            continue
        (away if far else out).append({**r, "exit": near[0]})

    def uniq(rs):
        # One physical plaza mapped with a booth on each of two ways is counted once.
        seen, keep = set(), []
        for r in rs:
            key = (r["exit"], r["movement"], tuple(r["directions"]), tuple(r["ways"]))
            if key in seen:
                continue
            seen.add(key)
            keep.append(r)
        return sorted(keep, key=lambda r: (r["km"], r["movement"]))

    return uniq(out), uniq(away)


def ts_rows(plazas):
    lines = []
    for p in plazas:
        dirs = ", ".join(f'"{d}"' for d in p["directions"])
        name = p["name"].replace('"', '\\"')
        lanes = "null" if p["lanes"] is None else str(p["lanes"])
        lines.append(
            f'  {{ exit: "{p["exit"]}", movement: "{p["movement"]}", directions: [{dirs}], lanes: {lanes}, '
            f'km: {p["km"]}, offsetM: {p["offsetM"]}, name: "{name}", osmNode: {p["osmNode"]} }},'
        )
    return "\n".join(lines)


def write_ts(plazas, away):
    stamp = time.strftime("%Y-%m-%d")
    body = ts_rows(plazas)
    away_body = ts_rows(away)
    ts = f'''/* GENERATED by app/dashboard/scenario-sandbox/scenarios/tools/build_toll_plazas.py — do not edit by hand.
 *
 * Every NLEX toll plaza road, from OpenStreetMap. (c) OpenStreetMap contributors,
 * available under the Open Database Licence (openstreetmap.org/copyright).
 * Read {stamp} through the public Overpass API.
 *
 * One row per plaza ROAD: an interchange usually has one per movement and
 * direction (the exit off NB, the entry onto SB...). `lanes` is the road's lane
 * count at the booths, which on a plaza is its number of booth lanes; null where
 * the mapper did not record it. `km` is where the booth line projects onto the
 * corridor, on the same km-post scale as lib/nlex-exits.ts, and `offsetM` how far
 * off the expressway's centreline it stands. `directions` has both NB and SB
 * when one plaza serves traffic from both carriageways.
 *
 * This is volunteer-mapped data: good, not official. NLEX's own booth counts,
 * where they can be had, are better and should replace it.
 *
 * Written twice, identically: Front-End-Dashboard/lib (the sandbox draws the
 * plazas from it) and Back-End/src/data (the booth staffing plan caps each plaza
 * at the booths it has). The two packages cannot import from each other.
 */

export type OsmTollPlaza = {{
  /** Interchange name, exactly as in lib/nlex-exits.ts. */
  exit: string;
  movement: "exit" | "entry" | "barrier";
  directions: ("NB" | "SB")[];
  lanes: number | null;
  km: number;
  offsetM: number;
  name: string;
  osmNode: number;
}};

export const OSM_TOLL_PLAZAS_READ = "{stamp}";

export const OSM_TOLL_PLAZAS: OsmTollPlaza[] = [
{body}
];

/* Plazas that belong to an interchange but stand more than {MAX_OFFSET_M} m off the
 * expressway, on the road it connects to — the Harbor Link's own plaza, for one.
 * Traffic recorded for that interchange paid there, so at the junction itself the
 * movement has no booths. */
export const OSM_TOLL_PLAZAS_AWAY: OsmTollPlaza[] = [
{away_body}
];
'''
    for path in (OUT, OUT_BACKEND):
        open(path, "w", encoding="utf-8", newline="\n").write(ts)


def show(p):
    return f"{p['exit']:24s} km {p['km']:6.2f} (joins {p['joinKm']:6.2f}) {p['movement']:7s} {'/'.join(p['directions']):5s} lanes {p['lanes'] if p['lanes'] is not None else '?':>3}  off {p['offsetM']:5d} m  {p['name']}"


if __name__ == "__main__":
    elements = load_network()
    rows = classify(elements)
    plazas, away = attach(rows)
    write_ts(plazas, away)
    for p in plazas:
        print(show(p))
    print("\nstanding away from the expressway:")
    for p in away:
        print(show(p))
    kept = {p["osmNode"] for p in plazas + away}
    dropped = [r for r in rows if r["osmNode"] not in kept]
    print(f"\n{len(plazas)} plaza roads and {len(away)} away from the expressway written to {OUT} and {OUT_BACKEND}; "
          f"{len(dropped)} booths left out (unlisted interchanges, unclassifiable).")
