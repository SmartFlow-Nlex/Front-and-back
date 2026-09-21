import { corridorKmAt } from "./nlex-fuel-stations";
import type { NlexExit } from "./nlex-exits";

/* ══════════════════════════════════════════════════════════════════════════════
   NLEX LAY-BYS AND EMERGENCY BAYS (mainline, Balintawak – Sta. Ines)

   NLEX Corporation publishes no list of its lay-bys. AARoads notes only that
   the expressway "has parking bays at regular intervals". These entries are
   every OpenStreetMap feature (highway=emergency_bay, highway=rest_area,
   amenity=parking along the carriageway) that touches or sits within 40 m of an
   NLEX mainline carriageway and within 1.5 km of the exit chain, queried from
   Overpass in September 2026. Reproduce and re-check with
   smartflow_scripts/4_studies_audits/nlex_roadside_features.py.

   The direction served comes from the OSM geometry, not guessed:
   - a bay drawn as a one-way way takes that way's direction of travel;
   - a bay tagged as a node takes the direction of the one-way carriageway it
     sits on;
   - the two untagged areas (km ≈ 8.4 parking, km ≈ 70.3 rest area) take the
     side of the road they lie on (traffic keeps right).

   Left out on purpose:
   - Harbor Link bays, which are on the spur and not on the simulated mainline;
   - bays on the Balintawak / Mindanao Ave. ramps, which are off the mainline;
   - the NLEX office "Parking / Rest Area" near km ≈ 15, which is 41 m off the
     road and not a roadside stop.

   COVERAGE: this is only as complete as OpenStreetMap. Stretches with no entry
   here may still have bays that nobody has mapped.
══════════════════════════════════════════════════════════════════════════════ */

export type Layby = {
  /** OSM element, e.g. "w548823893" (way) or "n6791646862" (node). */
  osm: string;
  kind: "emergency_bay" | "rest_area" | "parking";
  /** Name as tagged in OSM, if any. */
  name?: string;
  direction: "NB" | "SB";
  latitude: number;
  longitude: number;
  /** Sandbox corridor km when this file was built; a fallback only. */
  sandboxKmAtBuild: number;
};

export const LAYBYS: Layby[] = [
  { osm: "w735135248", kind: "parking", direction: "NB", latitude: 14.747873, longitude: 120.971891, sandboxKmAtBuild: 8.38 },
  { osm: "w1419600996", kind: "emergency_bay", direction: "SB", latitude: 14.760323, longitude: 120.964728, sandboxKmAtBuild: 9.96 },
  // Candaba Viaduct: one bay each side roughly every kilometre.
  { osm: "w548823893", kind: "emergency_bay", direction: "SB", latitude: 14.926512, longitude: 120.800903, sandboxKmAtBuild: 35.99 },
  { osm: "w938408109", kind: "emergency_bay", direction: "NB", latitude: 14.926656, longitude: 120.801074, sandboxKmAtBuild: 35.99 },
  { osm: "w938408107", kind: "emergency_bay", direction: "SB", latitude: 14.933469, longitude: 120.794813, sandboxKmAtBuild: 37.0 },
  { osm: "w938408108", kind: "emergency_bay", direction: "NB", latitude: 14.933604, longitude: 120.794983, sandboxKmAtBuild: 37.0 },
  { osm: "w548704491", kind: "emergency_bay", direction: "SB", latitude: 14.9404, longitude: 120.788732, sandboxKmAtBuild: 38.01 },
  { osm: "w548704489", kind: "emergency_bay", direction: "NB", latitude: 14.940535, longitude: 120.788909, sandboxKmAtBuild: 38.01 },
  { osm: "w548704482", kind: "emergency_bay", direction: "SB", latitude: 14.947341, longitude: 120.782652, sandboxKmAtBuild: 39.02 },
  { osm: "w548704487", kind: "emergency_bay", direction: "NB", latitude: 14.947477, longitude: 120.78282, sandboxKmAtBuild: 39.02 },
  { osm: "w1381220613", kind: "emergency_bay", direction: "SB", latitude: 15.025442, longitude: 120.722172, sandboxKmAtBuild: 49.82 },
  { osm: "w1381220614", kind: "emergency_bay", direction: "NB", latitude: 15.026164, longitude: 120.721651, sandboxKmAtBuild: 49.91 },
  { osm: "n6804302422", kind: "emergency_bay", direction: "NB", latitude: 15.077689, longitude: 120.676811, sandboxKmAtBuild: 57.43 },
  { osm: "n6791646862", kind: "emergency_bay", name: "Emergency Parking", direction: "NB", latitude: 15.113311, longitude: 120.658205, sandboxKmAtBuild: 61.84 },
  { osm: "n12071179885", kind: "emergency_bay", name: "Emergency Parking", direction: "NB", latitude: 15.124789, longitude: 120.648944, sandboxKmAtBuild: 63.45 },
  { osm: "n12071179883", kind: "emergency_bay", name: "Emergency Parking", direction: "SB", latitude: 15.1368, longitude: 120.636413, sandboxKmAtBuild: 65.34 },
  { osm: "w220019528", kind: "rest_area", direction: "NB", latitude: 15.171912, longitude: 120.608172, sandboxKmAtBuild: 70.28 },
  { osm: "w1103595087", kind: "emergency_bay", direction: "SB", latitude: 15.217434, longitude: 120.590219, sandboxKmAtBuild: 75.69 },
];

export type PlacedLayby = Layby & {
  /** Position on the sandbox corridor km scale for the exits passed in. */
  km: number;
};

export function placeLaybys(exits: Pick<NlexExit, "km" | "latitude" | "longitude">[]): PlacedLayby[] {
  return LAYBYS.map((l) => ({ ...l, km: corridorKmAt(l.latitude, l.longitude, exits) ?? l.sandboxKmAtBuild }))
    .sort((a, b) => a.km - b.km);
}

export const laybyLabel = (l: Layby) =>
  l.kind === "rest_area" ? "Rest area" : l.kind === "parking" ? "Roadside parking" : "Emergency bay";
