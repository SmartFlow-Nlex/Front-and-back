import {
  ASSUMPTIONS,
  type BreakdownCause,
  type FamilyKey,
  type PhaseIdOf,
  type VehicleKind,
} from "./assumptions";

export type { BreakdownCause, ClosureFamilyKey, FamilyKey, PhaseIdOf, VehicleKind } from "./assumptions";

/* ══════════════════════════════════════════════════════════════════════════════
   SCENARIO CATALOGUE

   What an operator can ask the sandbox to stage, and which of the engine's own
   levers each scenario pulls. Nothing here simulates anything: a scenario is a
   recipe for the existing Interventions (closedLanes / closurePoint /
   closureEnd / incidents / speedLimitKmh / speedZone), and the engine does the
   rest.

   Durations come from calibration.json (data). Phase splits, lanes blocked,
   lengths and speeds come from assumptions.ts (not data). This file holds only
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

/** Keys into calibration.json `families`. */
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

/** A phase of an event. `offsetFraction` is where it starts, as a fraction of the event's total duration (0 <= f < 1). */
export type PhaseDef<Id extends string> = {
  readonly id: Id;
  readonly label: string;
  readonly offsetFraction: number;
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
};

export type VehicleOption = { readonly id: VehicleKind; readonly label: string; readonly engineClass: 1 | 2 | 3 };
export type CauseOption = { readonly id: BreakdownCause; readonly label: string };
/** Pairs each collision label with its own calibration entry, so a label cannot point at another's data. */
export type CollisionLabelOption = {
  [L in CollisionLabel]: { readonly id: L; readonly label: string; readonly calibrationKey: `minor_collision_${L}` };
}[CollisionLabel];

export type BreakdownInLaneTemplate = TemplateCommon<"breakdown_in_lane"> & {
  readonly vehicles: readonly VehicleOption[];
  readonly causes: readonly CauseOption[];
  readonly defaultVehicle: VehicleKind;
  readonly defaultCause: BreakdownCause;
  readonly calibrationKey: "breakdown_in_lane";
};
export type BreakdownShoulderTemplate = TemplateCommon<"breakdown_shoulder"> & {
  readonly calibrationKey: "breakdown_shoulder";
};
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

export type ScenarioTemplate =
  | BreakdownInLaneTemplate
  | BreakdownShoulderTemplate
  | MinorCollisionTemplate
  | MultiVehicleCollisionTemplate
  | SelfAccidentTemplate;

export type TemplateOf<F extends FamilyKey> = Extract<ScenarioTemplate, { readonly family: F }>;

/** What the operator picked within a family. */
export type ScenarioVariant =
  | { readonly family: "breakdown_in_lane"; readonly vehicle: VehicleKind; readonly cause: BreakdownCause }
  | { readonly family: "breakdown_shoulder" }
  | { readonly family: "minor_collision"; readonly label: CollisionLabel }
  | { readonly family: "multi_vehicle_collision" }
  | { readonly family: "self_accident" };

export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}

/* ─────────────────────────────────────────────────────────────────────────────
   Phases: labels are here, shares are an assumption. One list drives both, so a
   phase cannot exist without a share or a share without a phase.
───────────────────────────────────────────────────────────────────────────── */
function buildPhases<F extends FamilyKey>(
  family: F,
  labels: Readonly<Record<PhaseIdOf[F], string>>,
): readonly PhaseDef<PhaseIdOf[F]>[] {
  const split: readonly { readonly id: PhaseIdOf[F]; readonly share: number }[] = ASSUMPTIONS.PHASE_SPLIT.value[family];
  let offset = 0;
  return split.map((p) => {
    const phase: PhaseDef<PhaseIdOf[F]> = { id: p.id, label: labels[p.id], offsetFraction: offset };
    offset += p.share;
    return phase;
  });
}

const DEFAULT_PLACEMENT: Placement = { kind: "segment_pct", pct: ASSUMPTIONS.DEFAULT_PLACEMENT_PCT.value };

/* ─────────────────────────────────────────────────────────────────────────────
   Templates
   Default lanes are the modal numbered lane in calibration.json
   (reference.lane_distribution.all); verify.ts re-checks them.
───────────────────────────────────────────────────────────────────────────── */
const BREAKDOWN_IN_LANE: BreakdownInLaneTemplate = {
  family: "breakdown_in_lane",
  displayName: "Breakdown in a lane",
  description:
    "A vehicle stalls in a running lane and stays there until the patrol clears it. Modelled as a stopped obstacle in that lane (a bus or truck uses several of the engine's 5 m obstacle slots) and removed when the event ends. Traffic behind it queues and works around it.",
  phases: buildPhases("breakdown_in_lane", {
    securing: "Stalled: patrol securing the vehicle",
    recovery: "Recovery in progress",
  }),
  defaultLane: { kind: "operator_lane", lane: 3 },
  defaultPlacement: DEFAULT_PLACEMENT,
  resources: ["incident_slot"],
  vehicles: [
    { id: "car", label: "Car / light vehicle", engineClass: 1 },
    { id: "bus", label: "Bus", engineClass: 2 },
    { id: "truck", label: "Truck", engineClass: 3 },
  ],
  causes: [
    { id: "tire", label: "Tire failure" },
    { id: "engine", label: "Engine fault" },
    { id: "mechanical", label: "Mechanical fault" },
    { id: "fuel", label: "Out of fuel" },
    { id: "electrical", label: "Electrical / battery" },
  ],
  // Most in-lane deployment records: truck (3,835) and engine (2,713) in calibration.json reference.
  defaultVehicle: "truck",
  defaultCause: "engine",
  calibrationKey: "breakdown_in_lane",
};

const BREAKDOWN_SHOULDER: BreakdownShoulderTemplate = {
  family: "breakdown_shoulder",
  displayName: "Breakdown on the shoulder",
  description:
    "A vehicle stops on the shoulder. No lane is blocked, but passing traffic slows to look. Modelled as a speed zone around the location for the duration of the event. The engine has a single speed zone, so this cannot run alongside a hand-set speed limit.",
  phases: buildPhases("breakdown_shoulder", {
    stopped: "Stopped on the shoulder",
    assist: "Patrol assisting",
  }),
  defaultLane: { kind: "outermost" },
  defaultPlacement: DEFAULT_PLACEMENT,
  resources: ["speed_zone"],
  calibrationKey: "breakdown_shoulder",
};

const MINOR_COLLISION: MinorCollisionTemplate = {
  family: "minor_collision",
  displayName: "Minor collision",
  description:
    "A rear-end, side-swipe or hit-and-run that blocks its lane until the vehicles are moved, then clears the scene. Modelled by closing the lane over a short stretch and reopening it when the lane-blocked share of the duration has passed. The engine has a single closure stretch, so it cannot overlap another collision.",
  phases: buildPhases("minor_collision", {
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
};

const MULTI_VEHICLE_COLLISION: MultiVehicleCollisionTemplate = {
  family: "multi_vehicle_collision",
  displayName: "Multi-vehicle collision",
  description:
    "Three or more vehicles. Two lanes are blocked at first, reduced to one while the tow works, then reopened while the scene is cleared. Modelled through the engine's single closure stretch, so it cannot overlap another collision.",
  phases: buildPhases("multi_vehicle_collision", {
    blocked: "Lanes blocked: awaiting response",
    tow: "Tow in progress",
    clearing: "Scene clearing: lanes reopened",
  }),
  defaultLane: { kind: "operator_lane", lane: 1 },
  defaultPlacement: DEFAULT_PLACEMENT,
  resources: ["closure_stretch"],
  calibrationKey: "multi_vehicle_collision",
};

const SELF_ACCIDENT: SelfAccidentTemplate = {
  family: "self_accident",
  displayName: "Self accident",
  description:
    "A single vehicle loses control. The slowest family to clear in the data. The lane stays blocked while awaiting response and during the tow, then reopens while the scene is cleared. Modelled through the engine's single closure stretch, so it cannot overlap another collision.",
  phases: buildPhases("self_accident", {
    blocked: "Vehicle in lane: awaiting response",
    tow: "Tow in progress",
    clearing: "Scene clearing: lane reopened",
  }),
  defaultLane: { kind: "operator_lane", lane: 1 },
  defaultPlacement: DEFAULT_PLACEMENT,
  resources: ["closure_stretch"],
  calibrationKey: "self_accident",
};

/** In the order they should be offered. */
export const SCENARIO_TEMPLATES: readonly ScenarioTemplate[] = [
  BREAKDOWN_IN_LANE,
  BREAKDOWN_SHOULDER,
  MINOR_COLLISION,
  MULTI_VEHICLE_COLLISION,
  SELF_ACCIDENT,
];

export const TEMPLATE_BY_FAMILY: { readonly [F in FamilyKey]: TemplateOf<F> } = {
  breakdown_in_lane: BREAKDOWN_IN_LANE,
  breakdown_shoulder: BREAKDOWN_SHOULDER,
  minor_collision: MINOR_COLLISION,
  multi_vehicle_collision: MULTI_VEHICLE_COLLISION,
  self_accident: SELF_ACCIDENT,
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
      return { family };
    case "minor_collision":
      return { family, label: MINOR_COLLISION.defaultLabel };
    case "multi_vehicle_collision":
      return { family };
    case "self_accident":
      return { family };
    default:
      return assertNever(family);
  }
}

/**
 * Which calibration entry a variant's duration is drawn from. Breakdowns use
 * one family-level entry whatever the cause or vehicle (the variant is a label);
 * minor collisions use the entry for their own label.
 */
export function calibrationKeyFor(variant: ScenarioVariant): CalibrationKey {
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
