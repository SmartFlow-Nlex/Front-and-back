import type { NlexExit } from "./nlex-exits";

/**
 * Fuel stations you can reach from the NLEX mainline without leaving the
 * expressway — the service areas — between Balintawak and Sta. Ines.
 *
 * WHAT IS IN HERE, AND WHY ONLY THIS
 *   The list is the "Service areas" table of the Wikipedia article on the North
 *   Luzon Expressway (checked 2026-09-21), which names 12 service areas with
 *   their fuel brand, official km-post and carriageway. Eleven are on the
 *   mainline and are below. The twelfth, Shell Tabang (Km 36, eastbound), is on
 *   the Tabang Spur Road, which the sandbox does not model.
 *
 *   OpenStreetMap shows roughly twenty more fuel stations within 150 m of the
 *   NLEX carriageways — Flying V, Unioil, Uno Fuel, Oiland, PTT, Caltex and
 *   others in Valenzuela and Caloocan, Petron and Caltex on Magalang-Angeles
 *   Road, a Total on the Calumpit-Pulilan Road. They sit on frontage and local
 *   roads behind the expressway fence; reaching one means leaving NLEX. None is
 *   in any service-area list, so none is here.
 *
 * WHERE EACH ONE IS
 *   Every coordinate is the OpenStreetMap service-area outline (or its fuel
 *   station) matched to the Wikipedia entry by brand, town and carriageway.
 *   For each, independently of the text:
 *     - it lies within 100 m of an NLEX carriageway (28-99 m);
 *     - it is on the RIGHT of that carriageway — traffic keeps right, so a
 *       service area on the right serves that direction — and the direction
 *       this gives matches the published one for all eleven;
 *     - official km minus sandbox km comes out between 11.35 and 12.76 for
 *       every station. The two scales are offset, not scaled differently, so a
 *       near-constant difference is what eleven correct matches look like; a
 *       wrong match would stand out by kilometres.
 *   Shell's own locator lists exactly four NLEX Shells (NLT1-NLT4) and all four
 *   are here; the Mega Station coordinate agrees within ~150 m with a second,
 *   independently published one.
 *
 * KM-POSTS
 *   `officialKm` is the NLEX km-post printed on the signs (measured from
 *   Manila). The sandbox uses its own corridor scale — Balintawak 0, Sta. Ines
 *   76.25 — so the position drawn is not officialKm. It is computed at runtime
 *   by projecting the coordinate onto the chain of exits the page already
 *   loads (placeFuelStations below), the same way the exits' own positions
 *   relate to their coordinates. `sandboxKmAtBuild` records what that gave on
 *   2026-09-21, for checking; if the exit km-posts change, the drawn position
 *   follows them.
 *
 * NOT INCLUDED, DELIBERATELY
 *   Opening hours, prices, and food outlets — none of that is needed to place a
 *   station and all of it goes stale.
 */

export type FuelStation = {
  id: string;
  /** Name as it appears on the service area. */
  name: string;
  /** Fuel brand at the pumps. */
  brand: string;
  /** Carriageway it serves. A northbound service area cannot be reached southbound. */
  direction: "NB" | "SB";
  /** Town the service area is in. */
  town: string;
  /** NLEX km-post as signed (from Manila), per the Wikipedia service-area table. */
  officialKm: number;
  latitude: number;
  longitude: number;
  /** Sandbox km computed from the coordinate on 2026-09-21 — reference only. */
  sandboxKmAtBuild: number;
  /** OpenStreetMap element the coordinate came from. */
  osm: string;
  note?: string;
};

export const FUEL_STATIONS: FuelStation[] = [
  // ── Northbound ────────────────────────────────────────────────────────────
  {
    id: "petron-marilao-nb", name: "Petron NLEX-Marilao", brand: "Petron", direction: "NB",
    town: "Marilao", officialKm: 23, latitude: 14.76458, longitude: 120.96309,
    sandboxKmAtBuild: 10.46, osm: "way/164559562",
    note: "Stopover expanded in 2012; OSM maps two pump areas inside the one service area.",
  },
  {
    id: "shell-balagtas-nb", name: "Shell NLEX North Balagtas", brand: "Shell", direction: "NB",
    town: "Balagtas", officialKm: 31.5, latitude: 14.83082, longitude: 120.90856,
    sandboxKmAtBuild: 20.15, osm: "way/82869577",
    note: "Shell locator: SH NLT1 Northbound. Signed Km 31-32.",
  },
  {
    id: "petron-km42-nb", name: "Petron Km 42", brand: "Petron", direction: "NB",
    town: "Plaridel", officialKm: 42, latitude: 14.88538, longitude: 120.83553,
    sandboxKmAtBuild: 30.12, osm: "way/559644734",
  },
  {
    id: "total-apalit-nb", name: "Total NLEX Northbound", brand: "Total", direction: "NB",
    town: "Apalit", officialKm: 55, latitude: 14.97705, longitude: 120.75919,
    sandboxKmAtBuild: 43.16, osm: "way/244987546",
    note: "Address: 55 North Luzon Expressway, Sucad, Apalit.",
  },
  {
    id: "petron-lakeshore-nb", name: "Petron Km 71 Lakeshore", brand: "Petron", direction: "NB",
    town: "Mexico", officialKm: 71, latitude: 15.09468, longitude: 120.67,
    sandboxKmAtBuild: 59.43, osm: "way/164776379",
  },
  {
    id: "shell-mexico-haven-nb", name: "Shell Mobility Mexico Haven", brand: "Shell", direction: "NB",
    town: "Mexico", officialKm: 77, latitude: 15.1354, longitude: 120.63957,
    sandboxKmAtBuild: 65.0, osm: "relation/19628159",
    note: "Shell locator: SH NLT4 NB Mexico.",
  },

  // ── Southbound ────────────────────────────────────────────────────────────
  {
    id: "drive-dine-sb", name: "NLEX Drive & Dine", brand: "Phoenix", direction: "SB",
    town: "Valenzuela", officialKm: 17, latitude: 14.71833, longitude: 120.98662,
    sandboxKmAtBuild: 4.75, osm: "way/661214360",
    note: "Formerly a standalone Caltex station.",
  },
  {
    id: "petron-bocaue-sb", name: "Petron NLEX South Bocaue", brand: "Petron", direction: "SB",
    town: "Bocaue", officialKm: 31, latitude: 14.82133, longitude: 120.92339,
    sandboxKmAtBuild: 18.24, osm: "way/82869538",
  },
  {
    id: "shell-of-asia-sb", name: "Shell of Asia", brand: "Shell", direction: "SB",
    town: "Guiguinto", officialKm: 36, latitude: 14.85108, longitude: 120.87517,
    sandboxKmAtBuild: 24.39, osm: "way/164599452",
    note: "Shell locator: SH NLT3 Guiguinto.",
  },
  {
    id: "mega-station-sb", name: "Mega Station", brand: "Caltex", direction: "SB",
    town: "San Fernando", officialKm: 62, latitude: 15.02967, longitude: 120.71629,
    sandboxKmAtBuild: 50.59, osm: "way/165284205",
    note: "Long signed as Caltex Mega Station; Wikipedia lists it as converting to Aramco.",
  },
  {
    id: "shell-mexico-sb", name: "Shell Mobility NLT2 Southbound", brand: "Shell", direction: "SB",
    town: "Mexico", officialKm: 76, latitude: 15.12924, longitude: 120.64374,
    sandboxKmAtBuild: 64.19, osm: "way/71079902",
    note: "Shell locator: SH NLT2 SBND Mexico. OSM tags the pumps KM 77.",
  },
];

export type PlacedFuelStation = FuelStation & {
  /** Position on the sandbox's own corridor scale. */
  km: number;
};

/* Local flat projection in metres. Over ~80 km at this latitude the error is
   far below the width of a carriageway. */
const LAT0 = 14.95;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110_574;
const toXY = (lat: number, lon: number): [number, number] => [(lon - 120.8) * KX, (lat - LAT0) * KY];

/**
 * Sandbox km for a coordinate: the nearest point on the exit-to-exit chain,
 * interpolated between the two exits' km-posts.
 */
export function corridorKmAt(lat: number, lon: number, exits: Pick<NlexExit, "km" | "latitude" | "longitude">[]): number | null {
  const chain = exits
    .filter((e) => Number.isFinite(e.latitude) && Number.isFinite(e.longitude))
    .slice()
    .sort((a, b) => a.km - b.km);
  if (chain.length < 2) return null;
  const [px, py] = toXY(lat, lon);
  let best: { d: number; km: number } | null = null;
  for (let i = 0; i < chain.length - 1; i++) {
    const [ax, ay] = toXY(chain[i].latitude, chain[i].longitude);
    const [bx, by] = toXY(chain[i + 1].latitude, chain[i + 1].longitude);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
    if (!best || d < best.d) best = { d, km: chain[i].km + t * (chain[i + 1].km - chain[i].km) };
  }
  return best ? Math.round(best.km * 100) / 100 : null;
}

/** Every station with its position on the sandbox scale, south to north. */
export function placeFuelStations(exits: Pick<NlexExit, "km" | "latitude" | "longitude">[]): PlacedFuelStation[] {
  return FUEL_STATIONS.map((s) => ({ ...s, km: corridorKmAt(s.latitude, s.longitude, exits) ?? s.sandboxKmAtBuild }))
    .sort((a, b) => a.km - b.km);
}
