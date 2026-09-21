import { CLASS_META } from "../simulation";

/* ══════════════════════════════════════════════════════════════════════════════
   SCENARIO ASSUMPTIONS

   Everything in this file is a value that does NOT come from NLEX data. Each one
   is an `Assumption`: it carries its value, why it was chosen, what data (if
   any) informed it without determining it, and what would settle it.

   What DOES come from data lives in calibration.json (duration quantiles, the
   breakdown response share) and is documented there. The line between the two
   is deliberate: a number in this file is a modelling choice a reviewer is
   entitled to argue with.

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

/** Breakdown families: their durations and phase split both come from data. */
export type BreakdownFamilyKey = "breakdown_in_lane" | "breakdown_shoulder";

/** Phase ids per family. The catalogue attaches the display labels. */
export type PhaseIdOf = {
  readonly breakdown_in_lane: "waiting" | "service";
  readonly breakdown_shoulder: "waiting" | "service";
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
/**
 * Ordered, so the catalogue can lay phases out in sequence. Shares sum to 1.
 * ACCIDENT families only: a breakdown's phases are split by the response share
 * measured in the data, so a breakdown has no entry here.
 */
type PhaseSplitTable = { readonly [F in ClosureFamilyKey]: readonly PhaseShare<PhaseIdOf[F]>[] };

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
      breakdown_in_lane: { waiting: 1, service: 1 },
      breakdown_shoulder: { waiting: 0, service: 0 },
      minor_collision: { blocked: 1, clearing: 0 },
      multi_vehicle_collision: { blocked: 2, tow: 1, clearing: 0 },
      self_accident: { blocked: 1, tow: 1, clearing: 0 },
    },
    "NOT AVAILABLE in the data: neither export has a lanes-blocked count, only the single lane an event was logged in. The values are the smallest physically plausible ones. An in-lane breakdown blocks the lane it is in for its whole duration (waiting and service alike); a shoulder breakdown blocks none; a collision blocks its own lane; a multi-vehicle collision starts by blocking two lanes and is reduced to the working lane once vehicles are moved. Once the recorded lane-reopen time has passed (see PHASE_SPLIT) no lane is blocked.",
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
    "The WRECK LENGTH: how far downstream of the event position the scene extends. NOT AVAILABLE in the data (no export records how much road a scene occupies). Sized to the vehicles involved (4.6 m car, 9 m bus, 14 m truck in the engine) plus a working buffer: two vehicles about 40 m, a multi-vehicle scene about 100 m while lanes are blocked, then a shorter working area while a tow is in progress. Zero where no lane is blocked. The closed stretch is longer than this: it also includes UPSTREAM_BUFFER_M.",
    { settledBy: "Field measurement or NLEX incident-management guidance." },
  ),

  UPSTREAM_BUFFER_M: assume(
    100,
    "How far UPSTREAM of a collision the closure begins. In the engine a closure is a wall at closurePoint that traffic in the closed lane must merge out of before reaching it, so a closure that begins exactly at the wreck makes vehicles queue right up against it. A real scene is protected by advance warning and cones well before the wreck. 100 m is a round figure of that order; it is not from an NLEX document. Applies to the closure families only.",
    {
      evidence: "The engine's own merge-urgency zone is 150 m (MERGE_ZONE_M), so at 100 m the wall sits inside the distance over which drivers are already merging. With the sandbox's 600 m default segment and the default 55% placement, the closure starts at about 230 m for a 330 m event.",
      settledBy: "NLEX incident-management practice for advance warning distance.",
    },
  ),

  CLOSURE_ANCHOR: assume<"closure_starts_upstream_of_event">(
    "closure_starts_upstream_of_event",
    "A collision's closure is placed as closurePoint = position - UPSTREAM_BUFFER_M and closureEnd = position + wreck length (CLOSURE_LENGTH_M for the current phase). CLAMPING: each end is clamped to the segment independently, closurePoint = max(0, position - buffer) and closureEnd = min(segment length, position + wreck length), so the closure can only be shortened, never moved, and the event position itself is never altered. The event position must lie within [0, segment length], otherwise there is no stretch (see closureStretch). The engine models no separate advance-warning taper.",
    { settledBy: "Nothing external: this follows from how simulation.ts treats a closure." },
  ),

  PHASE_SPLIT: assume<PhaseSplitTable>(
    {
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
    "ACCIDENT families only. The data gives one total duration per event, not a timeline, so how that total divides into phases is a modelling choice. The lane-blocked share is anchored to the data (below) and only the split of that share into 'awaiting response' and 'tow' is assumed. Breakdown phases are NOT here: they are split by the response share measured in the data (RESPONSE_SHARE_MODEL).",
    {
      evidence:
        "Ratio of median lane-blockage time (BlockageCleared - start) to median clearance time (SiteCleared - start), in-lane events, positive values only: minor collision 0.80 (rear-end 0.80, side-swipe 0.80, hit-and-run 0.38 on n=76), multi-vehicle 0.54, self accident 0.71. A ratio of medians is a rough guide, not a median of ratios.",
      settledBy: "An event timeline (reported / lanes reopened / cleared) in the incident export.",
    },
  ),

  BREAKDOWN_DURATION_SCOPE: assume<"response_plus_service_per_event">(
    "response_plus_service_per_event",
    "AMENDED in Phase 1b. A breakdown's simulated duration is the event's TOTAL, first dispatch to last departure (response + service), replacing the Phase 1 choice of on-scene service time only. The obstacle exists while it waits for the responder as well as while it is served, so service-only understated it by roughly 2.7x at the median in-lane. Still understated: the clock starts at the first dispatch, not at the breakdown, and any delay before dispatch is not recorded.",
    {
      evidence:
        "In-lane median total 43 min (p90 105) against 16 (p90 56) for service only per deployment record; shoulder 37 (p90 86) against 14 (p90 40). The service-only quantiles are kept in calibration.json under reference.service_only_per_deployment_record. Only 53% of in-lane and 28% of shoulder breakdown events have any deployment record, and events without one cannot be calibrated. Dispatch precedes the event's encoded time in 29% of deployment records, so time since the breakdown cannot be reconstructed.",
      settledBy: "A reported-at (breakdown began) timestamp in the incident export.",
    },
  ),

  MULTI_DEPLOYMENT_RULE: assume<"first_dispatch_to_last_departure_ignoring_check_ins">(
    "first_dispatch_to_last_departure_ignoring_check_ins",
    "A breakdown event can carry several deployment records. Rule: ignore records that are zero-length check-ins (dispatch = arrival = departure); over the rest take t0 = earliest dispatch, a = earliest arrival, t1 = latest departure; response = a - t0, service = t1 - a, total = t1 - t0. Gaps between visits therefore count as service, on the assumption that the obstacle is present until the last departure. Zero-length records are ignored because they show no responder attending; keeping them would move the start earlier by an unknown amount.",
    {
      evidence:
        "13.3% of usable in-lane events (781 of 5,863) and 2.7% of shoulder events (156 of 5,690) have more than one substantive record, and run longer (in-lane median 67 min against 41 for single-record events; shoulder 74.5 against 36). Keeping check-ins in the span instead changes the aggregate very little: in-lane p50 43 / p90 106 against 43 / 105, shoulder 37 / 87 against 37 / 86.",
      settledBy: "NLEX confirmation of whether several records on one event are successive visits to one obstacle or separate jobs.",
    },
  ),

  RESPONSE_SHARE_MODEL: assume<"per_event_share_quantiles_drawn_independently_of_total">(
    "per_event_share_quantiles_drawn_independently_of_total",
    "The response share (response / total) is calibrated as its own per-event quantile set, not as a ratio of medians: the distribution is wide (in-lane p10 0.18, median 0.60, p90 0.89) and one fixed ratio would give every event the same phase split. A sampled event draws its share independently of its total, from a second seed derived from the first. p50, p90 and manual durations use the median share, because they fix the total deliberately.",
    {
      evidence:
        "Spearman correlation between total and share: in-lane -0.195, shoulder -0.007. The mild in-lane negative correlation (long events tend to be service-heavy) is ignored. 6.9% of in-lane events (3.7% of shoulder) have a share of exactly 1 (service recorded as 0 min); the p90-p99 knots smooth that mass, so the model draws fewer exact 1s than the data has. A share of exactly 1 gives the Service / tow phase zero length.",
      settledBy: "A joint (total, share) model, if the correlation is judged to matter.",
    },
  ),

  SAMPLED_CAP: assume<"entry_p99">(
    "entry_p99",
    "A sampled duration is capped at its own calibration entry's p99 and reported as capped. The last 1% of the distribution runs from p99 out to the observed maximum (up to 24 h), which a sandbox run cannot usefully show; the cap is a project decision, not a statistical one. About 1% of draws are capped. Manual durations are never capped; p50 and p90 are below the cap by construction.",
    {
      evidence:
        "p99 caps: minor collision 127 min, multi-vehicle 157, self accident 535, in-lane breakdown 347, shoulder breakdown 251. A p99 estimated from about 200 events rests on two observations, so the cap is noisy for the smallest hierarchy entries.",
      settledBy: "Operator preference: the sampler accepts a different cap, or none.",
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
    "How the template's variant labels correspond to the exports' raw categories. The exports have no 'electrical' cause (it is spread across MainCause 'Others') and no car/bus/truck field (Truck alone spans all three engine vehicle classes). Breakdown durations follow the variant wherever a cause x vehicle, cause or vehicle cell has at least LOW_SAMPLE_N usable events; a breakdown of an unmapped vehicle (PUV, jeepney, motorcycle, heavy equipment) or an unmapped cause simply does not contribute to those cells.",
    {
      evidence:
        "The variant matters: in-lane median totals are truck 50 min against car 35, and mechanical 52 against engine 40 (tire 43). Bus (175 in-lane, 99 shoulder usable events) is below the threshold in both families, so a bus falls back to its cause or the family.",
      settledBy: "NLEX definitions of the cause and vehicle categories.",
    },
  ),

  LOW_SAMPLE_N: assume(
    200,
    "A calibration entry with fewer usable values than this is flagged as a small sample when shown to the operator, and a breakdown hierarchy entry (cause x vehicle, cause, vehicle) is used only if it has at least this many usable events. calibration.json records the value it was generated with and verify.ts checks the two agree. The figure is a judgement, not a statistical threshold. Hit-and-run (129 usable events after excluding 105 zero-minute and 9 negative) is below it but has no lower level inside its family to fall back to, so it keeps its own entry and is flagged.",
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
export const UPSTREAM_BUFFER_M: number = ASSUMPTIONS.UPSTREAM_BUFFER_M.value;

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

/* ─────────────────────────────────────────────────────────────────────────────
   Closure geometry (CLOSURE_ANCHOR, UPSTREAM_BUFFER_M, CLOSURE_LENGTH_M)
───────────────────────────────────────────────────────────────────────────── */
export type ClosureStretch = {
  /** Where the closed lane begins, metres along the segment in the direction of travel (the engine's closurePoint). */
  readonly closurePointM: number;
  /** Where it ends (the engine's closureEnd). */
  readonly closureEndM: number;
  /** True when the upstream buffer ran off the start of the segment and was cut to 0. */
  readonly clampedStart: boolean;
  /** True when the wreck ran off the end of the segment and was cut to the segment length. */
  readonly clampedEnd: boolean;
};

/**
 * The closure stretch for a collision at `positionM` (metres along the segment, in the direction of travel).
 *
 *   closurePoint = max(0, position - UPSTREAM_BUFFER_M)
 *   closureEnd   = min(segmentLength, position + wreckLength)
 *
 * Each end is clamped independently, so a clamp only ever shortens the closure; the event itself does not move.
 * Returns null when there is no valid stretch: a non-finite argument, a segment or wreck length that is not
 * positive, or a position outside [0, segmentLength]. The caller decides whether that means "flag the event".
 */
export function closureStretch(positionM: number, wreckLengthM: number, segmentLengthM: number): ClosureStretch | null {
  if (!Number.isFinite(positionM) || !Number.isFinite(wreckLengthM) || !Number.isFinite(segmentLengthM)) return null;
  if (segmentLengthM <= 0 || wreckLengthM <= 0) return null;
  if (positionM < 0 || positionM > segmentLengthM) return null;
  const rawStart = positionM - UPSTREAM_BUFFER_M;
  const rawEnd = positionM + wreckLengthM;
  const closurePointM = Math.max(0, rawStart);
  const closureEndM = Math.min(segmentLengthM, rawEnd);
  if (closureEndM <= closurePointM) return null;
  return { closurePointM, closureEndM, clampedStart: rawStart < 0, clampedEnd: rawEnd > segmentLengthM };
}
