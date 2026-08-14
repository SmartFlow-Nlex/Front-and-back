"use client";

import { useEffect, useState } from "react";

/**
 * The NLEX exit list — one shared source for every tab.
 *
 * The dashboard used to carry three hand-written lists that disagreed with each
 * other and with the database: 9 exits in the AI sandbox, 26 in maintenance and
 * 20 on the map, using three different sets of names ("Bocaue" vs "Bocaue
 * Interchange" vs "Ciudad de Victoria"). Anyone comparing two tabs saw two
 * different corridors.
 *
 * The list now comes from the API, which reads nlex_exits and derives each
 * km-post from dim_location's segment lengths. FALLBACK_EXITS below is a
 * snapshot of that response, used only until the fetch resolves or if the
 * backend is unreachable, so a tab never renders an empty picker.
 */

export type NlexExit = {
  exit_id: number;
  exit_name: string;
  latitude: number;
  longitude: number;
  /** Km-post along the corridor: Balintawak is 0, Sta. Ines is 76.25. */
  km: number;
  /** Per-direction access, from silver.nlex_exit_reference. */
  nb_entry: boolean;
  nb_exit: boolean;
  sb_entry: boolean;
  sb_exit: boolean;
  /** "interchange", or "toll-barrier" for a mainline barrier. */
  node_type: "interchange" | "toll-barrier";
};

/** Human label for a direction's access, e.g. "Entry & Exit". */
export function accessLabel(x: NlexExit, dir: "NB" | "SB"): string | null {
  const entry = dir === "NB" ? x.nb_entry : x.sb_entry;
  const exit = dir === "NB" ? x.nb_exit : x.sb_exit;
  if (x.node_type === "toll-barrier") return null;
  if (entry && exit) return "Entry & Exit";
  if (entry) return "Entry Only";
  if (exit) return "Exit Only";
  return "No Access";
}

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

/** Snapshot of GET /api/map-comparison/exits — keep in step with the database. */
export const FALLBACK_EXITS: NlexExit[] = [
  { exit_id: 1,  exit_name: "Balintawak",              latitude: 14.678767, longitude: 121.000089, km: 0 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 2,  exit_name: "NLEX Harbor Link",        latitude: 14.693465, longitude: 121.000308, km: 1.63 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 3,  exit_name: "Paso De Blas Valenzuela", latitude: 14.708213, longitude: 120.993002, km: 3.44 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 4,  exit_name: "Meycauayan",              latitude: 14.746388, longitude: 120.972316, km: 8.21 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 5,  exit_name: "Marilao",                 latitude: 14.774562, longitude: 120.957267, km: 11.73 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 6,  exit_name: "Cdv/Ph Arena",            latitude: 14.793124, longitude: 120.947256, km: 14.05 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 7,  exit_name: "Bocaue Barrier",          latitude: 14.802456, longitude: 120.942456, km: 15.2 , nb_entry: false, nb_exit: false, sb_entry: false, sb_exit: true, node_type: "toll-barrier" },
  { exit_id: 8,  exit_name: "Bocaue Interchange",      latitude: 14.807234, longitude: 120.939400, km: 15.82 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 9,  exit_name: "Tambubong",               latitude: 14.815124, longitude: 120.935071, km: 16.81 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 10, exit_name: "Tabang Guiguinto",        latitude: 14.832746, longitude: 120.903911, km: 20.69 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 11, exit_name: "Balagtas",                latitude: 14.834437, longitude: 120.900634, km: 21.09 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 12, exit_name: "Sta. Rita Guiguinto",     latitude: 14.862453, longitude: 120.858887, km: 26.55 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 13, exit_name: "Pulilan",                 latitude: 14.908258, longitude: 120.817015, km: 33.33 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 14, exit_name: "San Simon",               latitude: 14.990135, longitude: 120.749969, km: 44.91 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 15, exit_name: "San Fernando",            latitude: 15.049706, longitude: 120.694856, km: 53.78 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 16, exit_name: "Mexico",                  latitude: 15.105217, longitude: 120.663619, km: 60.78 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 17, exit_name: "Angeles",                 latitude: 15.163114, longitude: 120.613459, km: 69.15 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 18, exit_name: "Dau",                     latitude: 15.178009, longitude: 120.604629, km: 71.05 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 19, exit_name: "Sctex",                   latitude: 15.196301, longitude: 120.597121, km: 73.23 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
  { exit_id: 20, exit_name: "Sta. Ines",               latitude: 15.222037, longitude: 120.587835, km: 76.25 , nb_entry: true, nb_exit: true, sb_entry: true, sb_exit: true, node_type: "interchange" },
];

/** Length of the corridor in km, from the last exit's km-post. */
export const CORRIDOR_KM = FALLBACK_EXITS[FALLBACK_EXITS.length - 1].km;

// Fetched once per page load and shared, so several components on one tab do
// not each hit the endpoint.
let cache: NlexExit[] | null = null;
let inFlight: Promise<NlexExit[]> | null = null;

async function loadExits(): Promise<NlexExit[]> {
  if (cache) return cache;
  if (!inFlight) {
    inFlight = fetch(`${BACKEND}/api/map-comparison/exits`)
      .then((r) => r.json())
      .then((j) => {
        const rows = Array.isArray(j?.data) ? (j.data as NlexExit[]) : [];
        // Reject a short or km-less response rather than rendering a corridor
        // that silently disagrees with the map.
        if (rows.length === 0 || rows.some((x) => x.km == null || x.node_type == null)) return FALLBACK_EXITS;
        cache = rows;
        return rows;
      })
      .catch(() => FALLBACK_EXITS)
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** The corridor's exits, ordered south to north. Never empty. */
export function useNlexExits(): { exits: NlexExit[]; loading: boolean } {
  const [exits, setExits] = useState<NlexExit[]>(cache ?? FALLBACK_EXITS);
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    let cancelled = false;
    loadExits().then((rows) => {
      if (cancelled) return;
      setExits(rows);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return { exits, loading };
}

/** Nearest exit to a km-post — used to label a position on the corridor. */
export function exitNearestKm(exits: NlexExit[], km: number): NlexExit | null {
  if (exits.length === 0) return null;
  return exits.reduce((best, x) =>
    Math.abs(x.km - km) < Math.abs(best.km - km) ? x : best
  );
}
