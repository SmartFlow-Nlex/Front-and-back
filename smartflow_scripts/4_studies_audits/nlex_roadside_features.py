"""Where the AI Sandbox's fuel stations and lay-bys come from, reproducibly.

Rebuilds, from OpenStreetMap, the two data files the sandbox draws:
  Front-End-Dashboard/lib/nlex-fuel-stations.ts   (service-area fuel stations)
  Front-End-Dashboard/lib/nlex-laybys.ts          (lay-bys / emergency bays)
and checks every entry in them: position on the sandbox's km scale and which
carriageway it serves.

METHOD
  km        Projection of the site onto the sandbox's own exit chain
            (/api/map-comparison/exits: Balintawak km 0 -> Sta. Ines km 76.25).
            NLEX's signed km-posts are on a different origin; for the service
            areas the official-minus-sandbox offset is printed and should be
            near-constant (about 11-13 km).
  direction Taken from OSM geometry, most reliable first:
              1. a bay drawn as a one-way way -> that way's direction of travel;
              2. a bay tagged as a node ON a one-way carriageway -> that
                 carriageway's direction;
              3. otherwise the side of the nearest carriageway it lies on
                 (traffic keeps right, so a site on a carriageway's right
                 serves it).
  kept      Lay-bys within 40 m of a carriageway and 1.5 km of the exit chain
            (drops the Balintawak ramp bays). The two Harbor Link bays near
            km 2 pass these filters but sit on the spur, not the simulated
            mainline, so lib/nlex-laybys.ts leaves them out by hand.

NLEX publishes no list of lay-bys, so the lay-by file is only as complete as
OpenStreetMap. The service areas were cross-checked by hand against
Wikipedia's NLEX service-area table and the Shell station locator; the OSM
ids below are the ones used.

RUN (backend on :5000 for the exits, or pass --exits app_exits.json):
  python smartflow_scripts/4_studies_audits/nlex_roadside_features.py
Needs network access to the Overpass API.
"""
import argparse
import json
import math
import urllib.parse
import urllib.request

OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
BBOX = "14.66,120.55,15.25,121.02"

# (label, signed NLEX km per Wikipedia, stated direction, OSM id)
SERVICE_AREAS = [
    ("NLEX Drive & Dine (Phoenix)", 17, "SB", "w661214360"),
    ("Petron NLEX-Marilao", 23, "NB", "w164559562"),
    ("Petron NLEX South Bocaue", 31, "SB", "w82869538"),
    ("Shell NLEX North Balagtas", 31.5, "NB", "w82869577"),
    ("Shell of Asia", 36, "SB", "w164599452"),
    ("Petron Km 42", 42, "NB", "w559644734"),
    ("Total NLEX Northbound", 55, "NB", "w244987546"),
    ("Mega Station (Caltex)", 62, "SB", "w165284205"),
    ("Petron Km 71 Lakeshore", 71, "NB", "w164776379"),
    ("Shell Mobility NLT2 Southbound", 76, "SB", "w71079902"),
    ("Shell Mobility Mexico Haven", 77, "NB", "r19628159"),
]


def overpass(q):
    last = None
    for ep in OVERPASS * 3:  # public mirrors time out under load; retry each
        try:
            req = urllib.request.Request(ep, data=urllib.parse.urlencode({"data": q}).encode(),
                                         headers={"User-Agent": "SmartFlow-capstone/1.0 (research)"})
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)["elements"]
        except Exception as e:  # try the next mirror
            last = e
    raise SystemExit(f"Overpass unreachable: {last}")


def load_exits(path):
    if path:
        d = json.load(open(path, encoding="utf-8"))
    else:
        with urllib.request.urlopen("http://localhost:5000/api/map-comparison/exits", timeout=30) as r:
            d = json.load(r)
    d = d.get("data", d) if isinstance(d, dict) else d
    return sorted((float(x["km"]), float(x["latitude"]), float(x["longitude"])) for x in d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exits", help="saved /api/map-comparison/exits JSON instead of the live API")
    args = ap.parse_args()
    exits = load_exits(args.exits)

    lat0 = 14.95
    kx, ky = 111_320 * math.cos(math.radians(lat0)), 110_574
    xy = lambda la, lo: ((lo - 120.8) * kx, (la - lat0) * ky)

    def seg_dist(p, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy or 1e-9)))
        return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), t, dx, dy

    def chain(la, lo):
        """(distance to the exit chain m, sandbox km)."""
        p, best = xy(la, lo), None
        for (k1, a1, o1), (k2, a2, o2) in zip(exits, exits[1:]):
            d, t, _, _ = seg_dist(p, xy(a1, o1), xy(a2, o2))
            if best is None or d < best[0]:
                best = (d, k1 + t * (k2 - k1))
        return best

    def travel_dir(geom):
        k0, k1 = chain(geom[0]["lat"], geom[0]["lon"])[1], chain(geom[-1]["lat"], geom[-1]["lon"])[1]
        return "NB" if k1 > k0 + 0.005 else ("SB" if k1 < k0 - 0.005 else "?")

    print("fetching NLEX carriageways ...")
    roads = [w for w in overpass(f'[out:json][timeout:180];way["highway"="motorway"]({BBOX});out geom tags;')
             if len(w.get("geometry", [])) >= 2]
    rdir = {w["id"]: travel_dir(w["geometry"]) for w in roads}

    def nearest_carriageway(la, lo):
        p, best = xy(la, lo), None
        for w in roads:
            if rdir[w["id"]] == "?":
                continue
            g = w["geometry"]
            for s, e in zip(g, g[1:]):
                a = xy(s["lat"], s["lon"])
                d, _, dx, dy = seg_dist(p, a, xy(e["lat"], e["lon"]))
                if best is None or d < best[0]:
                    cross = dx * (p[1] - a[1]) - dy * (p[0] - a[0])
                    best = (d, rdir[w["id"]], cross < 0, w)
        return best

    def on_way(la, lo, w):
        return any(abs(g["lat"] - la) < 2e-6 and abs(g["lon"] - lo) < 2e-6 for g in w["geometry"])

    def serves(el, la, lo):
        t = el.get("tags", {})
        if el["type"] == "way" and t.get("oneway") == "yes":
            return travel_dir(el["geometry"]), "own one-way geometry"
        d, cdir, right, w = nearest_carriageway(la, lo)
        if el["type"] == "node" and w.get("tags", {}).get("oneway") == "yes" and on_way(la, lo, w):
            return cdir, "on a one-way carriageway"
        return (cdir if right else {"NB": "SB", "SB": "NB"}[cdir]), "side of the road"

    def centre(el):
        if "lat" in el:
            return el["lat"], el["lon"]
        if "center" in el:
            return el["center"]["lat"], el["center"]["lon"]
        g = el["geometry"]
        return sum(p["lat"] for p in g) / len(g), sum(p["lon"] for p in g) / len(g)

    # ── service areas ──────────────────────────────────────────────────────────
    ids = {"w": [], "r": [], "n": []}
    for *_, oid in SERVICE_AREAS:
        ids[oid[0]].append(oid[1:])
    q = "[out:json][timeout:120];(" + "".join(
        f'{"way" if k == "w" else "relation" if k == "r" else "node"}(id:{",".join(v)});' for k, v in ids.items() if v
    ) + ");out center tags;"
    found = {f"{e['type'][0]}{e['id']}": e for e in overpass(q)}
    print("\nSERVICE AREAS (lib/nlex-fuel-stations.ts)")
    print(f"{'site':<34} {'signed':>6} {'sandbox':>7} {'offset':>6} {'serves':>6} {'stated':>6}  ok")
    for label, okm, stated, oid in SERVICE_AREAS:
        el = found.get(oid)
        if not el:
            print(f"{label:<34} missing from OSM ({oid})")
            continue
        la, lo = centre(el)
        km = chain(la, lo)[1]
        d, cdir, right, _ = nearest_carriageway(la, lo)
        s = cdir if right else {"NB": "SB", "SB": "NB"}[cdir]
        print(f"{label:<34} {okm:>6} {km:7.2f} {okm - km:6.2f} {s:>6} {stated:>6}  {'yes' if s == stated else 'CHECK'}")

    # ── lay-bys ────────────────────────────────────────────────────────────────
    print("\nfetching lay-bys ...")
    q = f"""[out:json][timeout:180];
way["highway"="motorway"]["name"~"North Luzon Expressway|NLEX",i]({BBOX})->.nlex;
(
  nwr["parking"~"layby|lay_by|lane|street_side",i](around.nlex:80);
  nwr["highway"~"emergency_bay|rest_area",i](around.nlex:250);
  nwr["name"~"lay[- ]?by|laybay|lay[- ]?bay|emergency bay|rest area|rest stop",i](around.nlex:300);
);
out geom tags;"""
    print("\nLAY-BYS (lib/nlex-laybys.ts) — kept: <= 40 m from a carriageway, <= 1.5 km from the exit chain")
    print(f"{'sandbox km':>10} {'serves':>6}  {'kind':<14} {'osm':<14} how")
    rows = []
    for el in overpass(q):
        t = el.get("tags", {})
        kind = t.get("highway") if t.get("highway") in ("emergency_bay", "rest_area") else t.get("amenity", "-")
        la, lo = centre(el)
        off, km = chain(la, lo)
        d = nearest_carriageway(la, lo)[0]
        if d > 40 or off > 1500:
            continue
        s, how = serves(el, la, lo)
        rows.append((km, s, kind, f"{el['type'][0]}{el['id']}", how, t.get("name", "")))
    for km, s, kind, oid, how, name in sorted(rows):
        print(f"{km:10.2f} {s:>6}  {kind:<14} {oid:<14} {how}{'  · ' + name if name else ''}")
    print(f"\n{len(rows)} lay-bys kept. Compare against lib/nlex-laybys.ts; entries excluded there by hand"
          " (the two Harbor Link spur bays) are listed in that file's header.")


if __name__ == "__main__":
    main()
