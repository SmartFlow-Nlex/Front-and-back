import { CLASS_META } from "../simulation";

/* ══════════════════════════════════════════════════════════════════════════════
   SCENARIO ASSUMPTIONS

   Everything in this file is a value that does NOT come from NLEX data. Each one
   is an `Assumption`: it carries its value, why it was chosen, what data (if
   any) informed it without determining it, and what would settle it.

   What DOES come from data lives in calibration.json (duration quantiles) and is
   documented there. The line between the two is deliberate: a number in this
   file is a modelling choice a reviewer is entitled to argue with.

   Nothing here changes the engine. The engine's own Interventions
   (closedLanes / closurePoint / closureEnd / incidents / speedLimitKmh /
   speedZone) are the only levers a scenario can pull.
══════════════════════════════════════════════════════════════════════════════ */

/** The scenario families the engine can represent today. */
export type FamilyKey =
  | "breakdown_in_lane"
  | "breakdown_shoulder"
  | "minor_collision"
  | "multi_vehicle_collision"
  | "self_accident";

/** Families that act on the engine through its single closure stretch. */
export type ClosureFamilyKey = "minor_collision" | "multi_vehicle_collision" | "self_accident";

/** Phase ids per family. The catalogue attaches the display labels. */
export type PhaseIdOf = {
  readonly breakdown_in_lane: "securing" | "recovery";
  readonly breakdown_shoulder: "stopped" | "assist";
  readonly minor_collision: "blocked" | "clearing";
  readonly multi_vehicle_collision: "blocked" | "tow" | "clearing";
  readonly self_accident: "blocked" | "tow" | "clearing";
};

/** Engine vehicle classes 1 / 2 / 3. */
export type VehicleKind = "car" | "bus" | "truck";
export type BreakdownCause = "tire" | "engine" | "mechanical" | "fuel" | "electrical";

export type Assumption<T> = {
  readonly status: "ASSUMPTION";
  readonly value: T;
  /** Why this value, and why it is not taken from data. */
  readonly reason: string;
  /** Data that informs the choice without determining it. */
  readonly evidence?: string;
  /** What would settle it. */
  readonly settledBy?: string;
};

function assume<T>(value: T, reason: string, extra?: { readonly evidence?: string; readonly settledBy?: string }): Assumption<T> {
  return { status: "ASSUMPTION", value, reason, ...extra };
}

type PerPhase<F extends FamilyKey, V> = Readonly<Record<PhaseIdOf[F], V>>;
type ByFamily<V> = { readonly [F in FamilyKey]: PerPhase<F, V> };
type ByClosureFamily<V> = { readonly [F in ClosureFamilyKey]: PerPhase<F, V> };
type PhaseShare<Id extends string> = { readonly id: Id; readonly share: number };
/** Ordered, so the catalogue can lay phases out in sequence. Shares sum to 1. */
type PhaseSplitTable = { readonly [F in FamilyKey]: readonly PhaseShare<PhaseIdOf[F]>[] };

/* ─────────────────────────────────────────────────────────────────────────────
   Chainage: how event locations in the data relate to the app's km scale.
   The derivation is data, shown in full so the 12.04 can be checked; the
   decision to APPLY one constant offset everywhere is the assumption.
   generate/verify: tools/build_calibration.py writes the same table into
   calibration.json (`chainage_offset`) and verify.ts asserts they agree.
───────────────────────────────────────────────────────────────────────────── */
export type ChainageMatch = {
  readonly appExit: string;
  /** Km on the app's scale (lib/nlex-exits.ts, Balintawak = 0). */
  readonly appKm: number;
  /** SubLocation label the accident/breakdown export uses for the same place. */
  readonly eventLabel: string;
  /** Silver accident + breakdown events logged at that label. */
  readonly events: number;
  /** Median StartKM/1000 of those events: absolute NLEX chainage. */
  readonly chainageKm: number;
  readonly offsetKm: number;
};

export const CHAINAGE_DERIVATION: readonly ChainageMatch[] = [
  { appExit: "Balintawak", appKm: 0, eventLabel: "Balintawak", events: 1248, chainageKm: 11.89, offsetKm: 11.89 },
  { appExit: "Paso De Blas Valenzuela", appKm: 3.44, eventLabel: "Valenzuela", events: 503, chainageKm: 15.3, offsetKm: 11.86 },
  { appExit: "Meycauayan", appKm: 8.21, eventLabel: "Meycauayan", events: 682, chainageKm: 20.13, offsetKm: 11.92 },
  { appExit: "Marilao", appKm: 11.73, eventLabel: "Marilao", events: 194, chainageKm: 23.85, offsetKm: 12.12 },
  { appExit: "Cdv/Ph Arena", appKm: 14.05, eventLabel: "CDV", events: 262, chainageKm: 25.9, offsetKm: 11.85 },
  { appExit: "Bocaue Barrier", appKm: 15.2, eventLabel: "Bocaue Barrier", events: 2333, chainageKm: 27.2, offsetKm: 12 },
  { appExit: "Bocaue Interchange", appKm: 15.82, eventLabel: "Bocaue", events: 650, chainageKm: 27.75, offsetKm: 11.93 },
  { appExit: "Balagtas", appKm: 21.09, eventLabel: "Balagtas", events: 551, chainageKm: 33.84, offsetKm: 12.75 },
  { appExit: "Sta. Rita Guiguinto", appKm: 26.55, eventLabel: "Sta. Rita", events: 224, chainageKm: 38.5, offsetKm: 11.95 },
  { appExit: "Pulilan", appKm: 33.33, eventLabel: "Pulilan", events: 280, chainageKm: 45.37, offsetKm: 12.04 },
  { appExit: "San Simon", appKm: 44.91, eventLabel: "San Simon", events: 344, chainageKm: 56.96, offsetKm: 12.05 },
  { appExit: "San Fernando", appKm: 53.78, eventLabel: "San Fernando", events: 1182, chainageKm: 65.84, offsetKm: 12.06 },
  { appExit: "Mexico", appKm: 60.78, eventLabel: "Mexico", events: 305, chainageKm: 72.87, offsetKm: 12.09 },
  { appExit: "Angeles", appKm: 69.15, eventLabel: "Angeles", events: 220, chainageKm: 81.3, offsetKm: 12.15 },
  { appExit: "Dau", appKm: 71.05, eventLabel: "Dau", events: 166, chainageKm: 83.3, offsetKm: 12.25 },
  { appExit: "Sta. Ines", appKm: 76.25, eventLabel: "Sta. Ines", events: 147, chainageKm: 88.2, offsetKm: 11.95 },
  { appExit: "Tabang Guiguinto", appKm: 20.69, eventLabel: "Tabang", events: 114, chainageKm: 36.6, offsetKm: 15.91 },
];

/* ─────────────────────────────────────────────────────────────────────────────
   The assumptions
───────────────────────────────────────────────────────────────────────────── */
export const ASSUMPTIONS = {
  LANE1_IS_INNERMOST: assume(
    true,
    "The exports label lanes Lane1..Lane4 and no file says which end is which. The sandbox already draws lane index 0 as L1, the innermost lane, and the engine keeps heavy vehicles out of it (HEAVY_MIN_LANE), so operator lane 1 is mapped to engine lane index 0.",
    {
      evidence:
        "Lane1 is the modal numbered lane in BOTH directions for rear-end (NB 53%, SB 66%), multi-vehicle (NB 63%, SB 84%) and hit-and-run collisions; for side-swipe it is modal in SB only and for self accidents in NB only, and those two are nearly flat across lanes. Lane3 + Lane4 hold 74% of in-lane breakdowns (NB 75%, SB 74%) against 16% in Lane1. That is the pattern you would expect if Lane1 is the fast lane by the median and the outer lanes are the ones next to the shoulder, but it does not prove it, and the number of lanes varies along the corridor.",
      settledBy: "NLEX confirmation of the lane-numbering convention (PENDING). If false, operator lane n maps to engine index laneCount - n and every lane default below inverts.",
    },
  ),

  LANES_BLOCKED: assume<ByFamily<number>>(
    {
      breakdown_in_lane: { securing: 1, recovery: 1 },
      breakdown_shoulder: { stopped: 0, assist: 0 },
      minor_collision: { blocked: 1, clearing: 0 },
      multi_vehicle_collision: { blocked: 2, tow: 1, clearing: 0 },
      self_accident: { blocked: 1, tow: 1, clearing: 0 },
    },
    "NOT AVAILABLE in the data: neither export has a lanes-blocked count, only the single lane an event was logged in. The values are the smallest physically plausible ones. An in-lane breakdown blocks the lane it is in; a shoulder breakdown blocks none; a collision blocks its own lane; a multi-vehicle collision starts by blocking two lanes and is reduced to the working lane once vehicles are moved. Once the recorded lane-reopen time has passed (see PHASE_SPLIT) no lane is blocked.",
    {
      evidence:
        "BlockageCleared (lane reopened) precedes SiteCleared for all but 358 of 21,804 accidents, so a final phase with no lane blocked is supported by the data. In-lane multi-vehicle collisions are logged with a median of 3 vehicles (96% have 3 or more, 25% have 4 or more: 556 of 2,257), which is why two lanes is assumed rather than one.",
      settledBy: "A lanes-blocked field in the incident export, or operator input.",
    },
  ),

  CLOSURE_LENGTH_M: assume<ByClosureFamily<number>>(
    {
      minor_collision: { blocked: 40, clearing: 0 },
      multi_vehicle_collision: { blocked: 100, tow: 60, clearing: 0 },
      self_accident: { blocked: 60, tow: 60, clearing: 0 },
    },
    "NOT AVAILABLE in the data: no export records how much road a scene occupies. Sized to the vehicles involved (4.6 m car, 9 m bus, 14 m truck in the engine) plus a working buffer: two vehicles about 40 m, a multi-vehicle scene about 100 m while lanes are blocked, then a shorter working area while a tow is in progress. Deliberately short against the sandbox's 600 m default view. Zero where no lane is blocked.",
    { settledBy: "Field measurement or NLEX incident-management guidance." },
  ),

  CLOSURE_ANCHOR: assume<"event_position_is_upstream_edge">(
    "event_position_is_upstream_edge",
    "The engine's closure is a stopped obstacle at closurePoint that traffic in the closed lane must merge out of before reaching it, and the lane is closed from there to closureEnd. A collision is therefore placed with closurePoint at the event position and closureEnd = closurePoint + CLOSURE_LENGTH_M. The engine models no separate advance-warning taper.",
    { settledBy: "Nothing external: this follows from how simulation.ts treats a closure." },
  ),

  PHASE_SPLIT: assume<PhaseSplitTable>(
    {
      breakdown_in_lane: [
        { id: "securing", share: 0.3 },
        { id: "recovery", share: 0.7 },
      ],
      breakdown_shoulder: [
        { id: "stopped", share: 0.4 },
        { id: "assist", share: 0.6 },
      ],
      minor_collision: [
        { id: "blocked", share: 0.8 },
        { id: "clearing", share: 0.2 },
      ],
      multi_vehicle_collision: [
        { id: "blocked", share: 0.25 },
        { id: "tow", share: 0.3 },
        { id: "clearing", share: 0.45 },
      ],
      self_accident: [
        { id: "blocked", share: 0.3 },
        { id: "tow", share: 0.41 },
        { id: "clearing", share: 0.29 },
      ],
    },
    "The data gives one total duration per event, not a timeline. How that total divides into phases is a modelling choice. For accidents the lane-blocked share is anchored to the data (below) and only the split of that share into 'awaiting response' and 'tow' is assumed. For breakdowns nothing in the data splits the on-scene time, so the split is assumed and changes labels only: the engine obstacle (or speed zone) is identical in both phases.",
    {
      evidence:
        "Ratio of median lane-blockage time (BlockageCleared - start) to median clearance time (SiteCleared - start), in-lane events, positive values only: minor collision 0.80 (rear-end 0.80, side-swipe 0.80, hit-and-run 0.38 on n=76), multi-vehicle 0.54, self accident 0.71. A ratio of medians is a rough guide, not a median of ratios. Breakdown reference: median response wait (dispatch to arrival) 23 min against a median on-scene service time of 16 min, in-lane.",
      settledBy: "An event timeline (reported / lanes reopened / cleared) in the incident export.",
    },
  ),

  OBSTACLE_LENGTH_M: assume<Readonly<Record<VehicleKind, number>>>(
    { car: CLASS_META[1].len, bus: CLASS_META[2].len, truck: CLASS_META[3].len },
    "The data does not record the length of a stalled vehicle. The engine's own class lengths are used (car 4.6 m, bus 9 m, truck 14 m). These are engine constants, not NLEX measurements.",
    { settledBy: "Nothing needed unless the engine's class lengths are revised." },
  ),

  ENGINE_INCIDENT_SLOT_M: assume(
    5,
    "Mirrors INCIDENT_LENGTH in simulation.ts: every incident the engine holds is a stalled obstacle 5 m long, and the engine offers no way to change that. A longer stalled vehicle is approximated by chaining ceil(length / 5) slots end to end, so a car uses 1, a bus 2 and a truck 3. simulation.ts does not export the constant, so it is copied here and verify.ts checks the copy against the source text.",
    { settledBy: "verify.ts (fails if simulation.ts changes the constant)." },
  ),

  GAWK_SPEED_KMH: assume<{ readonly breakdown_shoulder: number }>(
    { breakdown_shoulder: 70 },
    "A stopped vehicle on the shoulder slows passing traffic. There is no measured NLEX speed to calibrate against: the warehouse holds no observed corridor operating speed (four candidate columns were checked and rejected in the sandbox validation, see smartflow_scripts/4_studies_audits/sandbox_validation/README.md). 70 km/h is a moderate cut below the engine's 108 km/h free-flow class-1 speed. Only shoulder breakdowns use a speed zone; collisions are modelled by their closure alone, so no post-collision gawking is represented.",
    {
      evidence: "The engine's speed zone caps desired speed for every vehicle in the zone, on all lanes. Real gawking mostly affects the lane beside the incident, so this overstates the slowdown in the other lanes.",
      settledBy: "Probe / loop-detector speeds near recorded shoulder events, which do not exist in the warehouse.",
    },
  ),

  GAWK_ZONE_M: assume<{ readonly upstream: number; readonly downstream: number }>(
    { upstream: 150, downstream: 100 },
    "Extent of the speed zone around a shoulder breakdown: drivers ease off before they reach it and speed up again shortly after. Not measurable from the data.",
    { settledBy: "Field observation." },
  ),

  SPILL_LANE_ORDER: assume<"outward_first">(
    "outward_first",
    "When a scene blocks more than one lane (multi-vehicle collision, first phase), the extra lane is taken on the outer side of the event lane first, then the inner side if there is none. The data logs one lane per event and says nothing about which neighbour a scene spills into. Outward first because 68% of multi-vehicle collisions are logged in Lane1, where the inner side is the median.",
    { settledBy: "Scene-extent data, which does not exist in the exports." },
  ),

  CHAINAGE_OFFSET_KM: assume(
    12.04,
    "Event StartKM in the exports is absolute NLEX chainage (Balintawak sits at about 11.9), whereas the app's exit list measures from Balintawak = 0. Sixteen of the 17 named places that appear in both differ by 11.85 to 12.75 km; the offset is the median of all 17. One constant offset is then applied along the whole corridor, which is the assumption. Tabang (15.91) is a clear outlier: the label 'Tabang' in the events does not sit where the app's 'Tabang Guiguinto' exit is.",
    {
      evidence: "See CHAINAGE_DERIVATION (17 named places, events counted per place; each place's events sit at a single point, IQR < 1 km).",
      settledBy: "gold.exit_km_post, the authoritative km table, which was unreachable when this was derived (database down); or NLEX chainage documents.",
    },
  ),

  DEFAULT_PLACEMENT_PCT: assume(
    55,
    "Where a new event lands along the visible segment when the operator has not chosen. 55% matches the engine's own default closure position (cfg.length * 0.55) so an event and a hand-set closure start from the same place. Not data.",
    { settledBy: "Operator choice." },
  ),

  BREAKDOWN_DURATION_SCOPE: assume<"on_scene_service_time_only">(
    "on_scene_service_time_only",
    "A breakdown's simulated duration is the calibrated service time (a deployment record's arrival to departure). The obstacle in reality also exists while waiting for the patrol, so this UNDERSTATES total obstruction time.",
    {
      evidence: "In-lane: median response wait 23 min (p90 54) against median service 16 min (p90 56); shoulder: 20 min (p90 50) against 14 min (p90 40). Only about 31% of breakdowns have any deployment record.",
      settledBy: "A decision on whether the obstacle should last response + service. calibration.json carries the response quantiles as a reference block if that is chosen.",
    },
  ),

  LABEL_MAPPINGS: assume<{
    readonly cause: Readonly<Record<BreakdownCause, string>>;
    readonly vehicle: Readonly<Record<VehicleKind, string>>;
    readonly collision: Readonly<Record<"rear_end" | "sideswipe" | "hit_and_run", string>>;
  }>(
    {
      cause: {
        tire: "MainCause = Tire",
        engine: "MainCause = Engine",
        mechanical: "MainCause = Mechanical",
        fuel: "MainCause = Fuel",
        electrical: "SubCause in (Battery, Electrical, Alternator, Starter, Wiring, Spark Plug, Contact Point)",
      },
      vehicle: {
        car: "TypeOfVehicle in (Sedan/Car, AUV, SUV, Van, Pick-Up)",
        bus: "TypeOfVehicle = Bus",
        truck: "TypeOfVehicle = Truck",
      },
      collision: { rear_end: "TypeOfEvent = Rear End", sideswipe: "TypeOfEvent = Side Swipe", hit_and_run: "TypeOfEvent = Hit and Run" },
    },
    "How the template's variant labels correspond to the exports' raw categories. The exports have no 'electrical' cause (it is spread across MainCause 'Others'), and no car/bus/truck field (Truck alone spans all three engine vehicle classes in the data). Used only for the reference cuts in calibration.json and for the labels shown to the operator: durations are calibrated per family, not per cause or vehicle.",
    {
      evidence:
        "Reference service-time medians for in-lane breakdowns differ by cause (tire 21 min, mechanical 19, electrical 14, engine 13, fuel 13) and vehicle (bus 26.5, truck 19, car 11), so the family-level duration does not track them.",
      settledBy: "A decision on whether durations should follow the variant. The per-variant quantiles are in calibration.json under reference.",
    },
  ),

  LOW_SAMPLE_N: assume(
    200,
    "A calibration entry with fewer usable values than this is flagged as a small sample when shown to the operator. The figure is a judgement, not a statistical threshold. Hit-and-run (129 usable values after excluding 105 zero-minute and 9 negative records) is currently below it.",
    { settledBy: "Nothing external." },
  ),
} as const satisfies Record<string, Assumption<unknown>>;

export type AssumptionId = keyof typeof ASSUMPTIONS;

/** Every assumption, for showing to the operator or auditing. */
export function listAssumptions(): readonly { readonly id: string; readonly assumption: Assumption<unknown> }[] {
  return Object.entries(ASSUMPTIONS).map(([id, assumption]) => ({ id, assumption }));
}

/** LANE1_IS_INNERMOST as a plain constant, because it is used everywhere. */
export const LANE1_IS_INNERMOST: boolean = ASSUMPTIONS.LANE1_IS_INNERMOST.value;
export const CHAINAGE_OFFSET_KM: number = ASSUMPTIONS.CHAINAGE_OFFSET_KM.value;

/* ─────────────────────────────────────────────────────────────────────────────
   Small conversions that depend on the assumptions above
───────────────────────────────────────────────────────────────────────────── */

/**
 * Operator lane number (1-based, as printed on the controls) -> engine lane index (0-based).
 * Null when the lane does not exist on a road of `laneCount` lanes.
 */
export function operatorLaneToEngineIndex(lane: number, laneCount: number): number | null {
  if (!Number.isInteger(lane) || !Number.isInteger(laneCount) || laneCount < 1) return null;
  if (lane < 1 || lane > laneCount) return null;
  return LANE1_IS_INNERMOST ? lane - 1 : laneCount - lane;
}

/** Inverse of operatorLaneToEngineIndex. */
export function engineIndexToOperatorLane(index: number, laneCount: number): number | null {
  if (!Number.isInteger(index) || !Number.isInteger(laneCount) || laneCount < 1) return null;
  if (index < 0 || index >= laneCount) return null;
  return LANE1_IS_INNERMOST ? index + 1 : laneCount - index;
}

/** The app's km (Balintawak = 0) -> absolute NLEX chainage, the scale the event data uses. */
export function appKmToChainageKm(appKm: number): number {
  return appKm + CHAINAGE_OFFSET_KM;
}

/** Absolute NLEX chainage -> the app's km. */
export function chainageKmToAppKm(chainageKm: number): number {
  return chainageKm - CHAINAGE_OFFSET_KM;
}

/** How many 5 m engine incident slots a stalled vehicle of this kind occupies. */
export function incidentSlotsFor(vehicle: VehicleKind): number {
  return Math.max(1, Math.ceil(ASSUMPTIONS.OBSTACLE_LENGTH_M.value[vehicle] / ASSUMPTIONS.ENGINE_INCIDENT_SLOT_M.value));
}
