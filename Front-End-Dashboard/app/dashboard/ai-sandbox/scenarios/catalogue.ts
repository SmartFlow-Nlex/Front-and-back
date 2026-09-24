import {
  ASSUMPTIONS,
  type BreakdownCause,
  type BreakdownFamilyKey,
  type ClosureFamilyKey,
  type FamilyKey,
  type NoCalibrationFamilyKey,
  type PhaseIdOf,
  type RainIntensity,
  type VehicleKind,
} from "./assumptions";

export type { BreakdownCause, BreakdownFamilyKey, ClosureFamilyKey, FamilyKey, NoCalibrationFamilyKey, PhaseIdOf, RainIntensity, SpeedZoneFamilyKey, VehicleKind } from "./assumptions";

/* ══════════════════════════════════════════════════════════════════════════════
   SCENARIO CATALOGUE

   What an operator can ask the sandbox to stage, and which of the engine's own
   levers each scenario pulls. Nothing here simulates anything: a scenario is a
   recipe for the existing Interventions (closedLanes / closurePoint /
   closureEnd / incidents / speedLimitKmh / speedZone), and the engine does the
   rest.

   Durations come from calibration.json (data). Accident phase splits, lanes
   blocked, lengths and speeds come from assumptions.ts (not data). A breakdown's
   phase split is measured (the response share in calibration.json), so its
   second phase has no fixed offset: it is set per event. This file holds only
   structure: names, labels, ordering, defaults and which resources are used.
══════════════════════════════════════════════════════════════════════════════ */

/** The three levers of the engine a scenario can pull. */
export type EngineResource = "incident_slot" | "closure_stretch" | "speed_zone";

/**
 * How the engine holds each resource. These are facts about simulation.ts and
 * verify.ts re-checks them against the source.
 *
 *   shared    - the engine keeps a list, so several events can each add to it.
 *   exclusive - the engine has ONE of it: a single closurePoint/closureEnd pair
 *               shared by every closed lane, and a single speedZone/speedLimitKmh.
 *               Two events cannot both use it at overlapping times.
 */
export const RESOURCE_SHARING = {
  incident_slot: "shared",
  closure_stretch: "exclusive",
  speed_zone: "exclusive",
} as const satisfies Record<EngineResource, "shared" | "exclusive">;

/** Keys of the entries every calibration file must contain: one per family, plus one per minor-collision label. */
export const CALIBRATION_KEYS = [
  "breakdown_in_lane",
  "breakdown_shoulder",
  "minor_collision",
  "minor_collision_rear_end",
  "minor_collision_sideswipe",
  "minor_collision_hit_and_run",
  "multi_vehicle_collision",
  "self_accident",
] as const;
export type CalibrationKey = (typeof CALIBRATION_KEYS)[number];

export const BREAKDOWN_FAMILIES = ["breakdown_in_lane", "breakdown_shoulder"] as const satisfies readonly BreakdownFamilyKey[];
export const BREAKDOWN_CAUSES = ["tire", "engine", "mechanical", "fuel", "electrical"] as const satisfies readonly BreakdownCause[];
export const BREAKDOWN_VEHICLES = ["car", "bus", "truck"] as const satisfies readonly VehicleKind[];

/**
 * Keys of the optional breakdown hierarchy entries. Only cells with enough usable
 * events are written to calibration.json, so any of these may be absent.
 */
export type HierarchyKey =
  | `${BreakdownFamilyKey}__cause_${BreakdownCause}`
  | `${BreakdownFamilyKey}__vehicle_${VehicleKind}`
  | `${BreakdownFamilyKey}__cause_${BreakdownCause}__vehicle_${VehicleKind}`;
/** A real calibration.json key, or — for a family in NO_CALIBRATION_FAMILIES — that family's own name, standing in for "no entry". */
export type EntryKey = CalibrationKey | HierarchyKey | NoCalibrationFamilyKey;

export function causeKey<F extends BreakdownFamilyKey, C extends BreakdownCause>(family: F, cause: C): `${F}__cause_${C}` {
  return `${family}__cause_${cause}`;
}
export function vehicleKey<F extends BreakdownFamilyKey, V extends VehicleKind>(family: F, vehicle: V): `${F}__vehicle_${V}` {
  return `${family}__vehicle_${vehicle}`;
}
export function causeVehicleKey<F extends BreakdownFamilyKey, C extends BreakdownCause, V extends VehicleKind>(
  family: F,
  cause: C,
  vehicle: V,
): `${F}__cause_${C}__vehicle_${V}` {
  return `${family}__cause_${cause}__vehicle_${vehicle}`;
}

export type CollisionLabel = "rear_end" | "sideswipe" | "hit_and_run";

/** Where an event sits along the segment. The operator can also pick a km (Phase 3); the catalogue default is a percentage. */
export type Placement = { readonly kind: "segment_pct"; readonly pct: number };

/**
 * Default lane. Operator lane numbers are 1-based as printed on the controls
 * (see LANE1_IS_INNERMOST in assumptions.ts for how they map to the engine).
 */
export type LaneDefault =
  | { readonly kind: "operator_lane"; readonly lane: number }
  | { readonly kind: "outermost" };

/**
 * Where a phase starts, as a fraction of the event's total duration.
 *   fixed          - a constant (the first phase is always fixed at 0).
 *   response_share - the event's own response share: the fraction of its total
 *                    spent waiting for the responder. Known only once the event's
 *                    duration has been resolved (see phaseOffsetFractions).
 */
export type PhaseOffset =
  | { readonly kind: "fixed"; readonly fraction: number }
  | { readonly kind: "response_share" };

export type PhaseDef<Id extends string> = {
  readonly id: Id;
  readonly label: string;
  readonly offset: PhaseOffset;
};

type TemplateCommon<F extends FamilyKey> = {
  readonly family: F;
  readonly displayName: string;
  readonly description: string;
  /** In order. The first starts at offset 0. */
  readonly phases: readonly PhaseDef<PhaseIdOf[F]>[];
  readonly defaultLane: LaneDefault;
  readonly defaultPlacement: Placement;
  /** Engine levers this scenario pulls. */
  readonly resources: readonly EngineResource[];
  /**
   * "calibrated" - this family has a calibration.json entry; Sampled / Median /
   *   90th percentile are offered, as well as Manual.
   * "manual_only" - no NLEX category exists for this family (see
   *   ASSUMPTIONS.NO_CALIBRATION_FAMILIES); ONLY Manual duration is offered, and
   *   the template has no `calibrationKey`.
   */
  readonly durationSource: "calibrated" | "manual_only";
};

export type VehicleOption = { readonly id: VehicleKind; readonly label: string; readonly engineClass: 1 | 2 | 3 };
export type CauseOption = { readonly id: BreakdownCause; readonly label: string };
/** Pairs each collision label with its own calibration entry, so a label cannot point at another's data. */
export type CollisionLabelOption = {
  [L in CollisionLabel]: { readonly id: L; readonly label: string; readonly calibrationKey: `minor_collision_${L}` };
}[CollisionLabel];

type BreakdownCommon<F extends BreakdownFamilyKey> = TemplateCommon<F> & {
  readonly vehicles: readonly VehicleOption[];
  readonly causes: readonly CauseOption[];
  readonly defaultVehicle: VehicleKind;
  readonly defaultCause: BreakdownCause;
  /** The family-level entry: where the fallback hierarchy ends. */
  readonly calibrationKey: F;
};

export type BreakdownInLaneTemplate = BreakdownCommon<"breakdown_in_lane">;
export type BreakdownShoulderTemplate = BreakdownCommon<"breakdown_shoulder">;
export type MinorCollisionTemplate = TemplateCommon<"minor_collision"> & {
  readonly labels: readonly CollisionLabelOption[];
  readonly defaultLabel: CollisionLabel;
  /** Family-level entry; each label also has its own (see `labels`). */
  readonly calibrationKey: "minor_collision";
};
export type MultiVehicleCollisionTemplate = TemplateCommon<"multi_vehicle_collision"> & {
  readonly calibrationKey: "multi_vehicle_collision";
};
export type SelfAccidentTemplate = TemplateCommon<"self_accident"> & {
  readonly calibrationKey: "self_accident";
};
/** No calibrationKey: see TemplateCommon.durationSource and ASSUMPTIONS.NO_CALIBRATION_FAMILIES. */
export type OverturnedVehicleTemplate = TemplateCommon<"overturned_vehicle"> & {
  readonly durationSource: "manual_only";
};
/** No calibrationKey. Single phase ("active"): see ASSUMPTIONS.PHASE_SPLIT. */
export type FloodTemplate = TemplateCommon<"flood"> & {
  readonly durationSource: "manual_only";
};
/** No calibrationKey. Single phase ("active"), one planned window — not a recurring schedule (see the file header). */
export type ScheduledRoadworksTemplate = TemplateCommon<"scheduled_roadworks"> & {
  readonly durationSource: "manual_only";
};
/** No calibrationKey. Speed zone, not closure_stretch — see ASSUMPTIONS.RAIN_ZONE / RAIN_SPEED_KMH. */
export type RainTemplate = TemplateCommon<"rain"> & {
  readonly durationSource: "manual_only";
  /** What the operator picks: how hard it rains. Each has its own speed cap (ASSUMPTIONS.RAIN_SPEED_KMH). */
  readonly intensities: readonly RainIntensityOption[];
  readonly defaultIntensity: RainIntensity;
};
export type RainIntensityOption = { readonly id: RainIntensity; readonly label: string };

export type ScenarioTemplate =
  | BreakdownInLaneTemplate
  | BreakdownShoulderTemplate
  | MinorCollisionTemplate
  | MultiVehicleCollisionTemplate
  | SelfAccidentTemplate
  | OverturnedVehicleTemplate
  | FloodTemplate
  | ScheduledRoadworksTemplate
  | RainTemplate;

export type TemplateOf<F extends FamilyKey> = Extract<ScenarioTemplate, { readonly family: F }>;

/** What the operator picked within a family. */
export type ScenarioVariant =
  | { readonly family: "breakdown_in_lane"; readonly vehicle: VehicleKind; readonly cause: BreakdownCause }
  | { readonly family: "breakdown_shoulder"; readonly vehicle: VehicleKind; readonly cause: BreakdownCause }
  | { readonly family: "minor_collision"; readonly label: CollisionLabel }
  | { readonly family: "multi_vehicle_collision" }
  | { readonly family: "self_accident" }
  | { readonly family: "overturned_vehicle" }
  | { readonly family: "flood" }
  | { readonly family: "scheduled_roadworks" }
  | { readonly family: "rain"; readonly intensity: RainIntensity };

export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}

/* ─────────────────────────────────────────────────────────────────────────────
   Phases
   Accident phases: labels are here, shares are an assumption. One list drives
   both, so a phase cannot exist without a share or a share without a phase.
   Breakdown phases: two, "Waiting for responder" then "Service / tow"; the
   second starts at the event's own response share, measured from data.
───────────────────────────────────────────────────────────────────────────── */
function buildAccidentPhases<F extends ClosureFamilyKey>(
  family: F,
  labels: Readonly<Record<PhaseIdOf[F], string>>,
): readonly PhaseDef<PhaseIdOf[F]>[] {
  const split: readonly { readonly id: PhaseIdOf[F]; readonly share: number }[] = ASSUMPTIONS.PHASE_SPLIT.value[family];
  let offset = 0;
  return split.map((p) => {
    const phase: PhaseDef<PhaseIdOf[F]> = { id: p.id, label: labels[p.id], offset: { kind: "fixed", fraction: offset } };
    offset += p.share;
    return phase;
  });
}

function breakdownPhases(): readonly PhaseDef<"waiting" | "service">[] {
  return [
    { id: "waiting", label: "Waiting for responder", offset: { kind: "fixed", fraction: 0 } },
    { id: "service", label: "Service / tow", offset: { kind: "response_share" } },
  ];
}

/** A family whose whole duration is one phase (rain: not a ClosureFamilyKey, so it can't use buildAccidentPhases). */
function singlePhase(label: string): readonly PhaseDef<"active">[] {
  return [{ id: "active", label, offset: { kind: "fixed", fraction: 0 } }];
}

/**
 * The start of each phase as a fraction of the event's duration.
 * `responseShare` is the event's own share (from its resolved duration); it is required
 * when the template has a response_share phase and ignored otherwise.
 */
export function phaseOffsetFractions(phases: readonly PhaseDef<string>[], responseShare: number | null): readonly number[] {
  return phases.map((p) => {
    switch (p.offset.kind) {
      case "fixed":
        return p.offset.fraction;
      case "response_share":
        if (responseShare === null || !(responseShare >= 0 && responseShare <= 1)) {
          throw new RangeError(`phase "${p.id}" needs a response share in [0, 1], got ${responseShare}`);
        }
        return responseShare;
      default:
        return assertNever(p.offset);
    }
  });
}

const DEFAULT_PLACEMENT: Placement = { kind: "segment_pct", pct: ASSUMPTIONS.DEFAULT_PLACEMENT_PCT.value };

const VEHICLE_OPTIONS: readonly VehicleOption[] = [
  { id: "car", label: "Car / light vehicle", engineClass: 1 },
  { id: "bus", label: "Bus", engineClass: 2 },
  { id: "truck", label: "Truck", engineClass: 3 },
];
const CAUSE_OPTIONS: readonly CauseOption[] = [
  { id: "tire", label: "Tire failure" },
  { id: "engine", label: "Engine fault" },
  { id: "mechanical", label: "Mechanical fault" },
  { id: "fuel", label: "Out of fuel" },
  { id: "electrical", label: "Electrical / battery" },
];

/* ─────────────────────────────────────────────────────────────────────────────
   Templates
   Default lanes are the modal numbered lane in calibration.json
   (reference.lane_distribution.all); default vehicle and cause are the most
   frequent cells in hierarchy.cells. verify.ts re-checks all of them.
───────────────────────────────────────────────────────────────────────────── */
const BREAKDOWN_IN_LANE: BreakdownInLaneTemplate = {
  family: "breakdown_in_lane",
  displayName: "Breakdown in a lane",
  description:
    "A vehicle stalls in a running lane and stays there until the patrol has finished with it: first waiting for the responder, then service or tow. Modelled as a stopped obstacle in that lane (a bus or truck uses several of the engine's 5 m obstacle slots) for the whole event, removed when it ends. Traffic behind it queues and works around it.",
  phases: breakdownPhases(),
  defaultLane: { kind: "operator_lane", lane: 3 },
  defaultPlacement: DEFAULT_PLACEMENT,
  resources: ["incident_slot"],
  vehicles: VEHICLE_OPTIONS,
  causes: CAUSE_OPTIONS,
  // Most usable in-lane events: truck (3,544) and engine (2,600); see hierarchy.cells.
  defaultVehicle: "truck",
  defaultCause: "engine",
  calibrationKey: "breakdown_in_lane",
  durationSource: "calibrated",
};

const BREAKDOWN_SHOULDER: BreakdownShoulderTemplate = {
  family: "breakdown_shoulder",
  displayName: "Breakdown on the shoulder",
  description:
    "A vehicle stops on the shoulder and waits for the responder, then is served or towed. No lane is blocked, but passing traffic slows to look. Modelled as a speed zone around the location for the whole event. The engine has a single speed zone, so this cannot run alongside a hand-set speed limit.",
  phases: breakdownPhases(),
  defaultLane: { kind: "outermost" },
  defaultPlacement: DEFAULT_PLACEMENT,
  resources: ["speed_zone"],
  vehicles: VEHICLE_OPTIONS,
  causes: CAUSE_OPTIONS,
  // Most usable shoulder events: car (3,154) and engine (3,209); see hierarchy.cells.
  defaultVehicle: "car",
  defaultCause: "engine",
  calibrationKey: "breakdown_shoulder",
  durationSource: "calibrated",
};

const MINOR_COLLISION: MinorCollisionTemplate = {
  family: "minor_collision",
  displayName: "Minor collision",
  description:
    "A rear-end, side-swipe or hit-and-run that blocks its lane until the vehicles are moved, then clears the scene. Modelled by closing the lane from a short distance upstream of the wreck to its far end, and reopening it when the lane-blocked share of the duration has passed. The engine has a single closure stretch, so it cannot overlap another collision.",
  phases: buildAccidentPhases("minor_collision", {
    blocked: "Lane blocked: awaiting response",
    clearing: "Scene clearing: lane reopened",
  }),
  defaultLane: { kind: "operator_lane", lane: 1 },
  defaultPlacement: DEFAULT_PLACEMENT,
  resources: ["closure_stretch"],
  labels: [
    { id: "rear_end", label: "Rear-end", calibrationKey: "minor_collision_rear_end" },
    { id: "sideswipe", label: "Side-swipe", calibrationKey: "minor_collision_sideswipe" },
    { id: "hit_and_run", label: "Hit and run", calibrationKey: "minor_collision_hit_and_run" },
  ],
  defaultLabel: "rear_end",
  calibrationKey: "minor_collision",
  durationSource: "calibrated",
};

const MULTI_VEHICLE_COLLISION: MultiVehicleCollisionTemplate = {
  family: "multi_vehicle_collision",
  displayName: "Multi-vehicle collision",
  description:
    "Three or more vehicles. Two lanes are blocked at first, reduced to one while the tow works, then reopened while the scene is cleared. Modelled through the engine's single closure stretch, so it cannot overlap another collision.",
  phases: buildAccidentPhases("multi_vehicle_collision", {
    blocked: "Lanes blocked: awaiting response",
    tow: "Tow in progress",
    clearing: "Scene clearing: lanes reopened",
  }),
  defaultLane: { kind: "operator_lane", lane: 1 },
  defaultPlacement: DEFAULT_PLACEMENT,
  resources: ["closure_stretch"],
  calibrationKey: "multi_vehicle_collision",
  durationSource: "calibrated",
};

const SELF_ACCIDENT: SelfAccidentTemplate = {
  family: "self_accident",
  displayName: "Self accident",
  description:
    "A single vehicle loses control. The slowest accident family to clear in the data. The lane stays blocked while awaiting response and during the tow, then reopens while the scene is cleared. Modelled through the engine's single closure stretch, so it cannot overlap another collision.",
  phases: buildAccidentPhases("self_accident", {
    blocked: "Vehicle in lane: awaiting response",
    tow: "Tow in progress",
    clearing: "Scene clearing: lane reopened",
  }),
  defaultLane: { kind: "operator_lane", lane: 1 },
  defaultPlacement: DEFAULT_PLACEMENT,
  resources: ["closure_stretch"],
  calibrationKey: "self_accident",
  durationSource: "calibrated",
};

const OVERTURNED_VEHICLE: OverturnedVehicleTemplate = {
  family: "overturned_vehicle",
  displayName: "Overturned vehicle",
  description:
    "A vehicle has rolled or come to rest on its side, blocking a lane until it is righted and towed. NLEX's own accident logs have no category for this (no \"Overturned\" or \"Rollover\" event type exists in the data), so there is no calibrated duration to sample from: the operator enters the duration directly. Modelled through the engine's single closure stretch, like the other collision families, so it cannot overlap another collision.",
  phases: buildAccidentPhases("overturned_vehicle", {
    blocked: "Vehicle overturned: awaiting response",
    tow: "Righting and tow in progress",
    clearing: "Scene clearing: lane reopened",
  }),
  defaultLane: { kind: "operator_lane", lane: 1 },
  defaultPlacement: DEFAULT_PLACEMENT,
  resources: ["closure_stretch"],
  durationSource: "manual_only",
};

const FLOOD: FloodTemplate = {
  family: "flood",
  displayName: "Flooding",
  description:
    "Standing water makes a lane impassable until it drains. NLEX has no flood record of any kind (no event type, no duration, no lane count), so this is a simplification: modelled as a single lane closed over a longer stretch than a wreck (150 m, against 60-100 m for a collision), for a duration the operator enters directly. A real flood can be a partial-width, reduced-speed hazard rather than a full closure; the engine has no lever for that, so a closed lane is the closest honest approximation with what exists today.",
  phases: singlePhase("Flooded: lane closed"),
  defaultLane: { kind: "operator_lane", lane: 1 },
  defaultPlacement: DEFAULT_PLACEMENT,
  resources: ["closure_stretch"],
  durationSource: "manual_only",
};

const SCHEDULED_ROADWORKS: ScheduledRoadworksTemplate = {
  family: "scheduled_roadworks",
  displayName: "Scheduled roadworks",
  description:
    "A planned lane closure for maintenance, for a duration the operator enters directly (NLEX has no roadworks record to sample from, and a planned closure would not be something to \"sample\" even if it did). Modelled as a single lane closed over a work-zone-sized stretch (120 m). This is ONE planned window, not a recurring schedule: add it again at a later start time to represent a second occurrence.",
  phases: singlePhase("Roadworks: lane closed"),
  defaultLane: { kind: "operator_lane", lane: 1 },
  defaultPlacement: DEFAULT_PLACEMENT,
  resources: ["closure_stretch"],
  durationSource: "manual_only",
};

const RAIN: RainTemplate = {
  family: "rain",
  displayName: "Rain",
  description:
    "Light, moderate or heavy rain: a speed zone across the WHOLE simulated stretch, for a duration the operator enters directly. The caps are scaled from free-flow speeds measured on the NLEx in rain (Mejia & Sigua 2018; heavy is lowest, and the study does not separate light from moderate). NLEX does record weather on accidents, but checked properly (the same population and exclusion rules the calibration file itself uses) it shows no real difference in how long anything takes to clear during rain, so there is no calibrated duration. A speed cap is a proxy: rain mostly lengthens following headways, which the engine cannot vary, so capacity loss is understated. No lane is blocked. The engine has a single speed zone, so this cannot run alongside a hand-set speed limit or a shoulder breakdown's gawk zone.",
  phases: singlePhase("Raining"),
  defaultLane: { kind: "outermost" },
  defaultPlacement: DEFAULT_PLACEMENT,
  resources: ["speed_zone"],
  durationSource: "manual_only",
  intensities: [
    { id: "light", label: "Light" },
    { id: "moderate", label: "Moderate" },
    { id: "heavy", label: "Heavy" },
  ],
  defaultIntensity: "moderate",
};

/** In the order they should be offered. */
export const SCENARIO_TEMPLATES: readonly ScenarioTemplate[] = [
  BREAKDOWN_IN_LANE,
  BREAKDOWN_SHOULDER,
  MINOR_COLLISION,
  MULTI_VEHICLE_COLLISION,
  SELF_ACCIDENT,
  OVERTURNED_VEHICLE,
  RAIN,
  FLOOD,
  SCHEDULED_ROADWORKS,
];

export const TEMPLATE_BY_FAMILY: { readonly [F in FamilyKey]: TemplateOf<F> } = {
  breakdown_in_lane: BREAKDOWN_IN_LANE,
  breakdown_shoulder: BREAKDOWN_SHOULDER,
  minor_collision: MINOR_COLLISION,
  multi_vehicle_collision: MULTI_VEHICLE_COLLISION,
  self_accident: SELF_ACCIDENT,
  overturned_vehicle: OVERTURNED_VEHICLE,
  flood: FLOOD,
  scheduled_roadworks: SCHEDULED_ROADWORKS,
  rain: RAIN,
};

export function getTemplate<F extends FamilyKey>(family: F): TemplateOf<F> {
  return TEMPLATE_BY_FAMILY[family];
}

/** The variant a new event starts with. */
export function defaultVariant(family: FamilyKey): ScenarioVariant {
  switch (family) {
    case "breakdown_in_lane":
      return { family, vehicle: BREAKDOWN_IN_LANE.defaultVehicle, cause: BREAKDOWN_IN_LANE.defaultCause };
    case "breakdown_shoulder":
      return { family, vehicle: BREAKDOWN_SHOULDER.defaultVehicle, cause: BREAKDOWN_SHOULDER.defaultCause };
    case "minor_collision":
      return { family, label: MINOR_COLLISION.defaultLabel };
    case "multi_vehicle_collision":
      return { family };
    case "self_accident":
      return { family };
    case "overturned_vehicle":
      return { family };
    case "flood":
      return { family };
    case "scheduled_roadworks":
      return { family };
    case "rain":
      return { family, intensity: RAIN.defaultIntensity };
    default:
      return assertNever(family);
  }
}

/** A variant whose family has a calibration.json entry (excludes NoCalibrationFamilyKey members). */
export type CalibratedVariant = Exclude<ScenarioVariant, { readonly family: NoCalibrationFamilyKey }>;

/** `variant` narrowed to CalibratedVariant, or null when its family has no calibration entry (NO_CALIBRATION_FAMILIES). */
export function calibratedVariantOf(variant: ScenarioVariant): CalibratedVariant | null {
  switch (variant.family) {
    case "overturned_vehicle":
    case "flood":
    case "scheduled_roadworks":
    case "rain":
      return null;
    default:
      return variant;
  }
}

/**
 * The BASE calibration entry a variant belongs to: the family entry, or for a
 * minor collision the entry for its own label. For breakdowns this is where the
 * cause x vehicle -> cause -> vehicle -> family fallback ENDS; the sampler's
 * selectCalibration() walks the hierarchy above it.
 *
 * Takes a CalibratedVariant, not a plain ScenarioVariant: a family in
 * NO_CALIBRATION_FAMILIES has no calibration entry to return, so it is excluded
 * at the type level rather than handled by throwing here.
 */
export function calibrationKeyFor(variant: CalibratedVariant): CalibrationKey {
  switch (variant.family) {
    case "breakdown_in_lane":
      return "breakdown_in_lane";
    case "breakdown_shoulder":
      return "breakdown_shoulder";
    case "minor_collision":
      return minorCollisionKey(variant.label);
    case "multi_vehicle_collision":
      return "multi_vehicle_collision";
    case "self_accident":
      return "self_accident";
    default:
      return assertNever(variant);
  }
}

function minorCollisionKey(label: CollisionLabel): CalibrationKey {
  switch (label) {
    case "rear_end":
      return "minor_collision_rear_end";
    case "sideswipe":
      return "minor_collision_sideswipe";
    case "hit_and_run":
      return "minor_collision_hit_and_run";
    default:
      return assertNever(label);
  }
}

/** The operator lane a new event starts in, for a road of `laneCount` lanes (1-based). */
export function defaultOperatorLane(template: ScenarioTemplate, laneCount: number): number {
  const d = template.defaultLane;
  switch (d.kind) {
    case "operator_lane":
      return Math.max(1, Math.min(d.lane, laneCount));
    case "outermost":
      return Math.max(1, laneCount);
    default:
      return assertNever(d);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Families still not built
   Empty as of the rain/flood/scheduled_roadworks batch: every family the
   review asked for is now built (see ASSUMPTIONS.NO_CALIBRATION_FAMILIES for
   the four with no calibration data — overturned_vehicle, flood,
   scheduled_roadworks, rain — all manual-duration-only, all built on the
   engine's EXISTING closure_stretch / speed_zone levers with no simulation.ts
   change). The type and list stay in place, empty, so the Add panel's
   disabled-family branch keeps compiling and rendering nothing rather than
   being deleted outright — the next reviewer-requested family that has no
   data or no adapter support yet has a slot ready to drop into.
───────────────────────────────────────────────────────────────────────────── */
/** The Add panel's badge on a disabled family. Never "engine": no disabled family should ever need simulation.ts — it would be a data or adapter gap. */
export const NOT_YET_BUILT = "Not yet built";

export type UnsupportedFamily = {
  readonly id: string;
  readonly displayName: string;
  /** Why it isn't built yet: a data gap, an adapter capability gap, or both. Never an engine gap. */
  readonly needs: string;
};

export const UNSUPPORTED_FAMILIES: readonly UnsupportedFamily[] = [];