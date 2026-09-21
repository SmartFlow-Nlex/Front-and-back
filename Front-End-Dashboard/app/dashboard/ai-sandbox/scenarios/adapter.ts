import type { Interventions } from "../simulation";
import { ASSUMPTIONS, closureStretch, incidentSlotsFor, operatorLaneToEngineIndex } from "./assumptions";
import { TEMPLATE_BY_FAMILY, assertNever, phaseOffsetFractions, type FamilyKey, type PhaseDef, type ScenarioVariant, type VehicleKind } from "./catalogue";
import { resolveDuration, type CalibrationLevel, type DurationMode, type ResolvedDuration } from "./sampler";

/* ══════════════════════════════════════════════════════════════════════════════
   SCENARIO ADAPTER

   Turns scenario events into the engine's own Interventions, and keeps that
   apart from what the operator has set by hand.

   ONE pure function does the work: composeInterventions(manual, events, simTime,
   road) -> { interventions, owners }. Everything else here either prepares its
   inputs (addEvent stores an event with its duration already resolved) or
   applies its result (EngineBinding.apply). The animation loop and the
   live-apply effect both go through EngineBinding.apply, so there is exactly one
   place where "what does the engine hold right now" is decided, and neither
   caller can overwrite the other's result.

   Who owns what, while an event runs:
     closure stretch  the one closurePoint/closureEnd pair. A collision event
                      owns it in every phase that blocks a lane. The operator may
                      close MORE lanes on it, never reopen the event's, and cannot
                      move it.
     speed zone       a shoulder breakdown owns it for its whole duration, unless
                      the operator is using it (a speed limit is set), in which
                      case the event yields and changes nothing.
     incidents        the engine keeps a list, so events add their own and the
                      operator's stay. An in-lane breakdown adds stalled
                      obstacles for its whole duration, removed when it ends.

   Times: an event's schedule is in seconds after the END OF WARM-UP. The engine
   clock (sim.time) counts from 0 including warm-up; scenarioTimeS converts, and
   every comparison here is made on the converted value so the animation loop and
   composeInterventions can never disagree about which phase is current.

   This file does not touch simulation.ts. Where a scenario would need the
   engine to do something it cannot, the event is flagged, never approximated
   silently.
══════════════════════════════════════════════════════════════════════════════ */

/** One of the engine's stalled obstacles. */
export type Incident = Interventions["incidents"][number];

/** The road an event runs on. `laneCount` and `segmentLengthM` come from the engine itself (see EngineBinding.apply). */
export type Road = {
  readonly laneCount: number;
  readonly segmentLengthM: number;
  /** Seconds of warm-up. An event's times are counted from the end of it. */
  readonly warmupS: number;
  /** Metres along the simulated stretch, in the direction of travel, for an app km-post. May fall outside [0, segmentLengthM]. */
  readonly metresAt: (km: number) => number;
};

/** What the operator has set by hand, apart from incidents. */
export type ManualControls = {
  readonly closedLanes: readonly boolean[];
  readonly closurePoint: number;
  readonly closureEnd: number;
  readonly showClosurePreview: boolean;
  readonly speedLimitKmh: number | null;
  readonly speedZone: readonly [number, number];
};

/** Everything the operator has set by hand, including the incidents they placed. */
export type ManualInterventions = ManualControls & { readonly incidents: readonly Incident[] };

/** Seconds since the end of warm-up: the clock event schedules are written in. Negative during warm-up. */
export function scenarioTimeS(simTimeS: number, road: Pick<Road, "warmupS">): number {
  return simTimeS - road.warmupS;
}

/** A phase shorter than this is treated as zero-length and skipped (a phase share of 0 or 1, or a duration that rounds to nothing). */
export const ZERO_PHASE_S = 1e-6;

/* ─────────────────────────────────────────────────────────────────────────────
   Events
───────────────────────────────────────────────────────────────────────────── */

export type ScheduledPhase = {
  readonly id: string;
  readonly label: string;
  /** Where the phase starts and how long it lasts, in seconds from the start of the event. */
  readonly offsetS: number;
  readonly durationS: number;
  readonly minutes: number;
  /** Zero-length: never applied, no engine change, but still listed. */
  readonly skipped: boolean;
  /** For the operator: "<label> — 12 min", or "<label> — 0 min (skipped)". */
  readonly text: string;
  /** Lanes this phase blocks (see ASSUMPTIONS.LANES_BLOCKED). */
  readonly lanesBlocked: number;
  /** How far downstream of the event the scene extends in this phase; null for families that do not use a closure. */
  readonly wreckLengthM: number | null;
};

/**
 * A scenario event, stored with everything resolved: the duration is drawn ONCE,
 * when the event is added, and kept here. Nothing downstream re-samples, so a
 * rebuild or a re-render replays the same event.
 */
export type ScenarioEvent = {
  readonly id: string;
  /** For messages: "Breakdown in a lane #2". */
  readonly name: string;
  readonly variant: ScenarioVariant;
  /** Operator lane number (1-based); null for a shoulder breakdown, which has no lane. */
  readonly lane: number | null;
  /** App km-post. Converted to metres against the current stretch when used, so a route change moves nothing silently. */
  readonly positionKm: number;
  /** Seconds after the end of warm-up. */
  readonly startS: number;
  /** How the duration was chosen, kept so the operator can see it (a sampled event keeps its seed). */
  readonly duration: DurationMode;
  /**
   * The resolved duration and where it came from: minutes, response share,
   * calibration entry / level / n / low-sample flag, whether a cap applied and the
   * level and n it came from, and the uncapped draw. Kept whole so nothing has to
   * be re-derived later.
   */
  readonly resolved: ResolvedDuration;
  /** In order. Includes skipped (zero-length) phases. */
  readonly phases: readonly ScheduledPhase[];
  /** startS plus the whole duration, in seconds after the end of warm-up. */
  readonly endS: number;
};

export type NewEventSpec = {
  readonly variant: ScenarioVariant;
  /** Operator lane number, 1-based. Ignored for a shoulder breakdown. */
  readonly lane: number | null;
  readonly positionKm: number;
  /** Minutes after the end of warm-up. */
  readonly startMinutes: number;
  readonly duration: DurationMode;
};

export type AddResult =
  | { readonly ok: true; readonly events: readonly ScenarioEvent[]; readonly event: ScenarioEvent }
  | { readonly ok: false; readonly reason: string };

function fmtMinutes(minutes: number): string {
  const digits = minutes < 1 ? 2 : 1;
  return `${Number(minutes.toFixed(digits))} min`;
}

function buildPhases<Id extends string>(
  phases: readonly PhaseDef<Id>[],
  resolved: ResolvedDuration,
  lanesBlocked: Readonly<Record<Id, number>>,
  wreckLengthM: Readonly<Record<Id, number>> | null,
): readonly ScheduledPhase[] {
  const fractions = phaseOffsetFractions(phases, resolved.responseShare);
  const totalS = resolved.minutes * 60;
  return phases.map((p, i): ScheduledPhase => {
    const start = fractions[i];
    const end = i + 1 < phases.length ? fractions[i + 1] : 1;
    const offsetS = start * totalS;
    const durationS = Math.max(0, (end - start) * totalS);
    const skipped = durationS < ZERO_PHASE_S;
    const minutes = skipped ? 0 : durationS / 60;
    return {
      id: p.id,
      label: p.label,
      offsetS,
      durationS: skipped ? 0 : durationS,
      minutes,
      skipped,
      text: skipped ? `${p.label} — 0 min (skipped)` : `${p.label} — ${fmtMinutes(minutes)}`,
      lanesBlocked: lanesBlocked[p.id],
      wreckLengthM: wreckLengthM === null ? null : wreckLengthM[p.id],
    };
  });
}

/**
 * The phases of a variant for a resolved duration. One case per family, so a new
 * family cannot be forgotten. Exported so a test can lay out a synthetic duration
 * (a response share of exactly 0 or 1) without going through the sampler.
 */
export function schedulePhases(variant: ScenarioVariant, resolved: ResolvedDuration): readonly ScheduledPhase[] {
  const blocked = ASSUMPTIONS.LANES_BLOCKED.value;
  const wreck = ASSUMPTIONS.CLOSURE_LENGTH_M.value;
  switch (variant.family) {
    case "breakdown_in_lane":
      return buildPhases(TEMPLATE_BY_FAMILY.breakdown_in_lane.phases, resolved, blocked.breakdown_in_lane, null);
    case "breakdown_shoulder":
      return buildPhases(TEMPLATE_BY_FAMILY.breakdown_shoulder.phases, resolved, blocked.breakdown_shoulder, null);
    case "minor_collision":
      return buildPhases(TEMPLATE_BY_FAMILY.minor_collision.phases, resolved, blocked.minor_collision, wreck.minor_collision);
    case "multi_vehicle_collision":
      return buildPhases(TEMPLATE_BY_FAMILY.multi_vehicle_collision.phases, resolved, blocked.multi_vehicle_collision, wreck.multi_vehicle_collision);
    case "self_accident":
      return buildPhases(TEMPLATE_BY_FAMILY.self_accident.phases, resolved, blocked.self_accident, wreck.self_accident);
    default:
      return assertNever(variant);
  }
}

/** Which engine lever an event's family pulls. */
type Effect = "incident" | "speed_zone" | "closure";
function effectOf(family: FamilyKey): Effect {
  switch (family) {
    case "breakdown_in_lane":
      return "incident";
    case "breakdown_shoulder":
      return "speed_zone";
    case "minor_collision":
    case "multi_vehicle_collision":
    case "self_accident":
      return "closure";
    default:
      return assertNever(family);
  }
}

/** The vehicle a breakdown variant is about, for its obstacle length. Null for the accident families. */
function breakdownVehicle(variant: ScenarioVariant): VehicleKind | null {
  switch (variant.family) {
    case "breakdown_in_lane":
    case "breakdown_shoulder":
      return variant.vehicle;
    case "minor_collision":
    case "multi_vehicle_collision":
    case "self_accident":
      return null;
    default:
      return assertNever(variant);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Validity
───────────────────────────────────────────────────────────────────────────── */

/**
 * Why an event cannot run on this road, as sentences; empty when it can. Used when
 * an event is added (then it is refused) and on every compose (then a road that no
 * longer suits it flags it and it goes inert, but it is never dropped).
 */
export function eventProblems(event: ScenarioEvent, road: Road): readonly string[] {
  const problems: string[] = [];
  const effect = effectOf(event.variant.family);
  const positionM = road.metresAt(event.positionKm);
  if (!Number.isFinite(positionM) || positionM < 0 || positionM > road.segmentLengthM) {
    problems.push(`Km ${event.positionKm.toFixed(2)} is outside the simulated stretch`);
  }
  if (effect !== "speed_zone") {
    if (event.lane === null) problems.push("it has no lane");
    else if (operatorLaneToEngineIndex(event.lane, road.laneCount) === null) {
      problems.push(`lane ${event.lane} does not exist on a ${road.laneCount}-lane road`);
    }
  }
  if (effect === "closure") {
    for (const p of event.phases) {
      if (p.skipped || p.lanesBlocked <= 0) continue;
      if (p.lanesBlocked >= road.laneCount) problems.push(`"${p.label}" blocks ${p.lanesBlocked} lanes, which is every lane of a ${road.laneCount}-lane road`);
      else if (p.wreckLengthM !== null && Number.isFinite(positionM) && closureStretch(positionM, p.wreckLengthM, road.segmentLengthM) === null) {
        problems.push(`"${p.label}" leaves no closure stretch at Km ${event.positionKm.toFixed(2)}`);
      }
    }
  }
  return problems;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Timeline
───────────────────────────────────────────────────────────────────────────── */
export type EventState = "pending" | "active" | "done";

export function eventState(event: ScenarioEvent, scenarioT: number): EventState {
  if (scenarioT < event.startS) return "pending";
  if (scenarioT < event.endS) return "active";
  return "done";
}

/** The phase running at `scenarioT`: never a skipped one, and null before the event, after it, or in a gap. */
export function phaseAt(event: ScenarioEvent, scenarioT: number): ScheduledPhase | null {
  if (eventState(event, scenarioT) !== "active") return null;
  for (const p of event.phases) {
    if (p.skipped) continue;
    const from = event.startS + p.offsetS;
    if (scenarioT >= from && scenarioT < from + p.durationS) return p;
  }
  return null;
}

export type EventProgress = {
  readonly state: EventState;
  readonly phase: ScheduledPhase | null;
  /** Seconds into the event (0 before it starts, its length after it ends). */
  readonly elapsedS: number;
  readonly remainingS: number;
  /** Seconds left in the current phase; null when no phase is running. */
  readonly phaseRemainingS: number | null;
  /** Seconds until the event starts; 0 once it has. */
  readonly startsInS: number;
};

export function eventProgress(event: ScenarioEvent, scenarioT: number): EventProgress {
  const state = eventState(event, scenarioT);
  const total = event.endS - event.startS;
  const elapsedS = Math.min(total, Math.max(0, scenarioT - event.startS));
  const phase = phaseAt(event, scenarioT);
  return {
    state,
    phase,
    elapsedS,
    remainingS: total - elapsedS,
    phaseRemainingS: phase === null ? null : event.startS + phase.offsetS + phase.durationS - scenarioT,
    startsInS: Math.max(0, event.startS - scenarioT),
  };
}

/**
 * Every moment the state an event asks of the engine can change, in seconds after
 * the end of warm-up: its start, the start of each phase that has a length, and
 * its end. Only events that are valid on this road count. Sorted, no repeats.
 */
export function boundaryTimes(events: readonly ScenarioEvent[], road: Road): readonly number[] {
  const out = new Set<number>();
  for (const e of events) {
    if (eventProblems(e, road).length > 0) continue;
    out.add(e.startS);
    for (const p of e.phases) if (!p.skipped) out.add(e.startS + p.offsetS);
    out.add(e.endS);
  }
  return [...out].sort((a, b) => a - b);
}

/** The first boundary strictly after `scenarioT`, or null when none is left. */
export function nextBoundaryAfter(events: readonly ScenarioEvent[], road: Road, scenarioT: number): number | null {
  for (const t of boundaryTimes(events, road)) if (t > scenarioT) return t;
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Conflicts: an exclusive resource cannot be held by two events at once
───────────────────────────────────────────────────────────────────────────── */
type ExclusiveResource = "closure_stretch" | "speed_zone";
type Window = { readonly resource: ExclusiveResource; readonly fromS: number; readonly toS: number };

/**
 * When an event needs one of the engine's single-instance levers, in seconds after
 * the end of warm-up. A collision holds the closure stretch from the start of its
 * first lane-blocking phase to the end of its last; a shoulder breakdown holds the
 * speed zone for its whole duration. An in-lane breakdown uses the incident list,
 * which the engine shares, so it holds nothing exclusive.
 */
export function resourceWindows(event: ScenarioEvent): readonly Window[] {
  const effect = effectOf(event.variant.family);
  switch (effect) {
    case "incident":
      return [];
    case "speed_zone":
      return [{ resource: "speed_zone", fromS: event.startS, toS: event.endS }];
    case "closure": {
      const blocking = event.phases.filter((p) => !p.skipped && p.lanesBlocked > 0);
      if (blocking.length === 0) return [];
      const from = Math.min(...blocking.map((p) => event.startS + p.offsetS));
      const to = Math.max(...blocking.map((p) => event.startS + p.offsetS + p.durationS));
      return [{ resource: "closure_stretch", fromS: from, toS: to }];
    }
    default:
      return assertNever(effect);
  }
}

const RESOURCE_NAME: Readonly<Record<ExclusiveResource, string>> = {
  closure_stretch: "closure stretch",
  speed_zone: "speed zone",
};

function minutesAfterWarmup(s: number): string {
  return `+${Number((s / 60).toFixed(1))} min`;
}

/** The first overlap between a new event and the events already stored, worded for the operator. Null when there is none. */
function conflictMessage(existing: readonly ScenarioEvent[], candidate: ScenarioEvent): string | null {
  const mine = resourceWindows(candidate);
  for (const other of existing) {
    for (const theirs of resourceWindows(other)) {
      for (const w of mine) {
        if (w.resource !== theirs.resource) continue;
        if (w.fromS < theirs.toS && theirs.fromS < w.toS) {
          return (
            `Cannot add "${candidate.name}": it needs the engine's single ${RESOURCE_NAME[w.resource]} from ${minutesAfterWarmup(w.fromS)} to ${minutesAfterWarmup(w.toS)}, ` +
            `and "${other.name}" holds it from ${minutesAfterWarmup(theirs.fromS)} to ${minutesAfterWarmup(theirs.toS)}. ` +
            `The two are not merged; move one of them in time. Nothing was changed.`
          );
        }
      }
    }
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Adding and removing events
───────────────────────────────────────────────────────────────────────────── */

/**
 * Store a new event, or refuse it and say why. The duration is resolved here,
 * once. `seq` numbers the event for its name and id ("Breakdown in a lane #2"),
 * and the caller keeps it counting up, so a name is never reused.
 * Refused when the event cannot run on `road` (see eventProblems) or when it needs
 * a single-instance lever another event holds at an overlapping time.
 */
export function addEvent(events: readonly ScenarioEvent[], spec: NewEventSpec, road: Road, seq: number): AddResult {
  if (!Number.isInteger(seq) || seq < 1) throw new RangeError(`seq must be a positive integer, got ${seq}`);
  const template = TEMPLATE_BY_FAMILY[spec.variant.family];
  const name = `${template.displayName} #${seq}`;
  if (!Number.isFinite(spec.startMinutes) || spec.startMinutes < 0) {
    return { ok: false, reason: `Cannot add "${name}": its start must be zero or more minutes after warm-up, got ${spec.startMinutes}.` };
  }
  let resolved: ResolvedDuration;
  try {
    resolved = resolveDuration(spec.variant, spec.duration);
  } catch (e) {
    if (e instanceof RangeError) return { ok: false, reason: `Cannot add "${name}": ${e.message}.` };
    throw e;
  }
  const startS = spec.startMinutes * 60;
  const event: ScenarioEvent = {
    id: `ev${seq}`,
    name,
    variant: spec.variant,
    lane: effectOf(spec.variant.family) === "speed_zone" ? null : spec.lane,
    positionKm: spec.positionKm,
    startS,
    duration: spec.duration,
    resolved,
    phases: schedulePhases(spec.variant, resolved),
    endS: startS + resolved.minutes * 60,
  };
  if (events.some((e) => e.id === event.id)) throw new RangeError(`an event with id ${event.id} already exists`);
  if (event.phases.every((p) => p.skipped)) {
    return { ok: false, reason: `Cannot add "${name}": its duration (${resolved.minutes} min) leaves every phase with no length.` };
  }
  const problems = eventProblems(event, road);
  if (problems.length > 0) return { ok: false, reason: `Cannot add "${name}": ${problems.join("; ")}.` };
  const conflict = conflictMessage(events, event);
  if (conflict !== null) return { ok: false, reason: conflict };
  return { ok: true, events: [...events, event], event };
}

const LEVEL_TEXT: Readonly<Record<CalibrationLevel, string>> = {
  cause_vehicle: "cause × vehicle",
  cause: "cause",
  vehicle: "vehicle",
  label: "collision type",
  family: "the whole family",
};

/** Seconds as m:ss, or h:mm:ss from an hour up. */
export function formatClock(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * The resolved duration in words, for the operator: how it was chosen, which
 * calibration level it came from and how many events that rests on, a low-sample
 * warning, and, when the cap applied, what was drawn and what it was cut to and
 * why. Everything comes from the stored resolution; nothing is re-derived.
 */
export function describeResolution(event: ScenarioEvent): string {
  const r = event.resolved;
  const how =
    r.mode === "sampled" ? "sampled" : r.mode === "p50" ? "median" : r.mode === "p90" ? "90th percentile" : "entered by the operator";
  const parts = [`${fmtMinutes(r.minutes)} ${how}`];
  if (r.mode !== "manual") {
    parts.push(`calibrated at ${LEVEL_TEXT[r.level]} level, n = ${r.n.toLocaleString("en-US")}${r.lowSample ? " (low sample)" : ""}`);
  }
  if (r.capped && r.capMinutes !== null && r.capLevel !== null && r.capN !== null) {
    parts.push(`capped: drew ${fmtMinutes(r.uncappedMinutes)}, cut to ${fmtMinutes(r.capMinutes)}, the 99th percentile of ${LEVEL_TEXT[r.capLevel]} level (n = ${r.capN.toLocaleString("en-US")})`);
  }
  return parts.join(" · ");
}

/** Events without `id`. Removing one gives back exactly what it changed: the next apply no longer asks for it. */
export function removeEvent(events: readonly ScenarioEvent[], id: string): readonly ScenarioEvent[] {
  return events.filter((e) => e.id !== id);
}

/* ─────────────────────────────────────────────────────────────────────────────
   Ownership
───────────────────────────────────────────────────────────────────────────── */
export type Owner = {
  readonly eventId: string;
  readonly eventName: string;
  readonly phaseId: string;
  readonly phaseLabel: string;
};

export type ClosureOwnership = Owner & {
  /** Engine lane indices the event is blocking, ascending. The operator cannot reopen these. */
  readonly lanes: readonly number[];
  readonly closurePointM: number;
  readonly closureEndM: number;
};
export type SpeedZoneOwnership = Owner & { readonly zone: readonly [number, number]; readonly limitKmh: number };
export type IncidentOwnership = Owner & {
  /** `${eventId}:${slot}`: how the binding tells this incident from the operator's. */
  readonly key: string;
  readonly slot: number;
  readonly lane: number;
  readonly x: number;
};
export type YieldedEvent = Owner & { readonly resource: "speed_zone"; readonly reason: "operator_limit_active" };
export type InvalidEvent = { readonly eventId: string; readonly eventName: string; readonly problems: readonly string[] };
/** Two events claiming the same exclusive lever at once. addEvent never allows it; if it ever occurs the earlier event wins and the other is listed here. */
export type SuppressedEvent = { readonly eventId: string; readonly eventName: string; readonly resource: ExclusiveResource; readonly heldBy: string };

export type Ownership = {
  readonly closure: ClosureOwnership | null;
  readonly speedZone: SpeedZoneOwnership | null;
  readonly incidents: readonly IncidentOwnership[];
  readonly yielded: readonly YieldedEvent[];
  readonly invalid: readonly InvalidEvent[];
  readonly suppressed: readonly SuppressedEvent[];
};

export const NO_OWNERS: Ownership = { closure: null, speedZone: null, incidents: [], yielded: [], invalid: [], suppressed: [] };

/** "<event> — <phase>", for "Driven by: ...". */
export function describeOwner(o: Owner): string {
  return `${o.eventName} — ${o.phaseLabel}`;
}

/** Engine lane indices a scenario is blocking, as a flag per lane. */
export function scenarioLockedLanes(owners: Ownership, laneCount: number): boolean[] {
  const locked = Array<boolean>(laneCount).fill(false);
  if (owners.closure !== null) for (const i of owners.closure.lanes) if (i >= 0 && i < laneCount) locked[i] = true;
  return locked;
}

/** A short string that changes exactly when ownership does, so a UI can skip a redundant state update. */
export function ownershipKey(o: Ownership): string {
  const c = o.closure === null ? "-" : `${o.closure.eventId}/${o.closure.phaseId}/${o.closure.lanes.join(",")}`;
  const z = o.speedZone === null ? "-" : `${o.speedZone.eventId}/${o.speedZone.phaseId}`;
  const i = o.incidents.map((x) => `${x.key}@${x.lane}:${x.x}`).join(";");
  const y = o.yielded.map((x) => x.eventId).join(",");
  const v = o.invalid.map((x) => x.eventId).join(",");
  const s = o.suppressed.map((x) => x.eventId).join(",");
  return [c, z, i, y, v, s].join("|");
}

/* ─────────────────────────────────────────────────────────────────────────────
   composeInterventions: the ONE pure function
───────────────────────────────────────────────────────────────────────────── */
export type Composition = {
  /** What the engine should hold: the operator's settings with the scenario's laid over them. `closureDraft` is display-only and not part of this. */
  readonly interventions: Interventions;
  readonly owners: Ownership;
};

/** The lanes a phase blocks: the event's own lane, then outward (higher engine index) first, then inward. See ASSUMPTIONS.SPILL_LANE_ORDER. */
function blockedLanes(baseIndex: number, count: number, laneCount: number): readonly number[] {
  const lanes = [baseIndex];
  let outward = baseIndex + 1;
  let inward = baseIndex - 1;
  while (lanes.length < count) {
    if (outward < laneCount) lanes.push(outward++);
    else if (inward >= 0) lanes.push(inward--);
    else break;
  }
  return lanes.sort((a, b) => a - b);
}

function ownerOf(event: ScenarioEvent, phase: ScheduledPhase): Owner {
  return { eventId: event.id, eventName: event.name, phaseId: phase.id, phaseLabel: phase.label };
}

/**
 * The engine's interventions at engine time `simTimeS`, given what the operator
 * has set and the scenario events, and who owns each lever.
 *
 * Rules (each is checked in verify.ts):
 *   - Events that are not valid on `road` (a lane that no longer exists, a position
 *     off the stretch, a phase that would block every lane) own nothing and change
 *     nothing; they are listed in `owners.invalid`.
 *   - Closure stretch: while a collision event is in a phase that blocks lanes, its
 *     lanes and its stretch replace the operator's stretch. Its lanes are always
 *     closed. The operator's own closed lanes are kept ON TOP (never fewer lanes
 *     than the scenario blocks, extra ones allowed), on the event's stretch.
 *   - Speed zone: a shoulder breakdown's zone and limit replace the operator's for
 *     the event's duration, unless the operator has a limit set, in which case the
 *     event yields.
 *   - Incidents: the operator's, then one per obstacle slot for each in-lane
 *     breakdown that is running.
 *   - Zero-length phases are never current, so they change nothing.
 * Nothing here reads a clock or the engine, and nothing is mutated.
 */
export function composeInterventions(manual: ManualInterventions, events: readonly ScenarioEvent[], simTimeS: number, road: Road): Composition {
  const t = scenarioTimeS(simTimeS, road);
  const ordered = [...events].sort((a, b) => a.startS - b.startS || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let closure: ClosureOwnership | null = null;
  let speedZone: SpeedZoneOwnership | null = null;
  const incidents: IncidentOwnership[] = [];
  const yielded: YieldedEvent[] = [];
  const invalid: InvalidEvent[] = [];
  const suppressed: SuppressedEvent[] = [];

  for (const event of ordered) {
    const problems = eventProblems(event, road);
    if (problems.length > 0) {
      invalid.push({ eventId: event.id, eventName: event.name, problems });
      continue;
    }
    const phase = phaseAt(event, t);
    if (phase === null) continue;
    const positionM = road.metresAt(event.positionKm);
    const effect = effectOf(event.variant.family);
    switch (effect) {
      case "closure": {
        if (phase.lanesBlocked <= 0 || phase.wreckLengthM === null || event.lane === null) break;
        const base = operatorLaneToEngineIndex(event.lane, road.laneCount);
        const stretch = closureStretch(positionM, phase.wreckLengthM, road.segmentLengthM);
        if (base === null || stretch === null) break;
        if (closure !== null) {
          suppressed.push({ eventId: event.id, eventName: event.name, resource: "closure_stretch", heldBy: closure.eventId });
          break;
        }
        closure = {
          ...ownerOf(event, phase),
          lanes: blockedLanes(base, phase.lanesBlocked, road.laneCount),
          closurePointM: stretch.closurePointM,
          closureEndM: stretch.closureEndM,
        };
        break;
      }
      case "speed_zone": {
        if (manual.speedLimitKmh !== null) {
          yielded.push({ ...ownerOf(event, phase), resource: "speed_zone", reason: "operator_limit_active" });
          break;
        }
        if (speedZone !== null) {
          suppressed.push({ eventId: event.id, eventName: event.name, resource: "speed_zone", heldBy: speedZone.eventId });
          break;
        }
        const zone = ASSUMPTIONS.GAWK_ZONE_M.value;
        speedZone = {
          ...ownerOf(event, phase),
          zone: [Math.max(0, positionM - zone.upstream), Math.min(road.segmentLengthM, positionM + zone.downstream)],
          limitKmh: ASSUMPTIONS.GAWK_SPEED_KMH.value.breakdown_shoulder,
        };
        break;
      }
      case "incident": {
        const vehicle = breakdownVehicle(event.variant);
        const laneIndex = event.lane === null ? null : operatorLaneToEngineIndex(event.lane, road.laneCount);
        if (vehicle === null || laneIndex === null) break;
        // The vehicle's front is at the event position and it extends upstream, one engine slot at a time.
        const slots = incidentSlotsFor(vehicle);
        const slotM = ASSUMPTIONS.ENGINE_INCIDENT_SLOT_M.value;
        for (let k = 0; k < slots; k++) {
          const x = positionM - k * slotM;
          if (x < 0) continue;
          incidents.push({ ...ownerOf(event, phase), key: `${event.id}:${k}`, slot: k, lane: laneIndex, x });
        }
        break;
      }
      default:
        return assertNever(effect);
    }
  }

  const closedLanes = Array.from({ length: road.laneCount }, (_, i) => Boolean(manual.closedLanes[i]) || (closure !== null && closure.lanes.includes(i)));
  const interventions: Interventions = {
    closedLanes,
    closurePoint: closure === null ? manual.closurePoint : closure.closurePointM,
    closureEnd: closure === null ? manual.closureEnd : closure.closureEndM,
    showClosurePreview: closure === null ? manual.showClosurePreview : false,
    incidents: [...manual.incidents.map((i): Incident => ({ lane: i.lane, x: i.x })), ...incidents.map((i): Incident => ({ lane: i.lane, x: i.x }))],
    speedLimitKmh: speedZone === null ? manual.speedLimitKmh : speedZone.limitKmh,
    speedZone: speedZone === null ? [manual.speedZone[0], manual.speedZone[1]] : [speedZone.zone[0], speedZone.zone[1]],
  };
  return { interventions, owners: { closure, speedZone, incidents, yielded, invalid, suppressed } };
}

/* ─────────────────────────────────────────────────────────────────────────────
   EngineBinding: applying a composition to a running engine
───────────────────────────────────────────────────────────────────────────── */

/** The part of TrafficSim the binding needs. TrafficSim satisfies it; a test can too. */
export type EngineLike = {
  readonly time: number;
  readonly cfg: { readonly length: number; readonly laneCount: number };
  interventions: Interventions;
  addIncident(lane: number, x: number): void;
};

/** What a caller supplies besides the engine: where warm-up ends and how km-posts map to metres on the current stretch. */
export type RoadFrame = Pick<Road, "warmupS" | "metresAt">;

export type EngineBinding = {
  /**
   * Compose and apply. THE only way scenario state reaches the engine, called from
   * the animation loop when a phase boundary is crossed and from the live-apply
   * effect when the operator changes something. Idempotent: applying the same
   * inputs again changes nothing. Returns the composition so the caller can show
   * who owns what.
   */
  apply(sim: EngineLike, controls: ManualControls, events: readonly ScenarioEvent[], frame: RoadFrame): Composition;
  /** The incidents the operator placed: everything the engine holds except what a scenario put there. */
  operatorIncidents(sim: EngineLike): readonly Incident[];
  /** Remove the operator's incidents only; a running scenario's are left in place. */
  clearOperatorIncidents(sim: EngineLike): void;
  /** Forget which incidents are scenario-owned. Call when the engine it was bound to is replaced. */
  reset(): void;
};

/** The road as the engine itself sees it: lane count and length are the engine's, not the page's, so they cannot be stale. */
export function roadOf(sim: Pick<EngineLike, "cfg">, frame: RoadFrame): Road {
  return { laneCount: sim.cfg.laneCount, segmentLengthM: sim.cfg.length, warmupS: frame.warmupS, metresAt: frame.metresAt };
}

/* ─────────────────────────────────────────────────────────────────────────────
   Driving a run: the two loops the page needs, kept here so they can be tested
   without a browser
───────────────────────────────────────────────────────────────────────────── */

/** The engine as the loops below step it. */
export type SteppableEngine = EngineLike & { step(dt: number): void };

/**
 * Call after each engine step. Once the scenario clock has reached `dueS` (a phase
 * boundary), applies the composition and returns the next due time; otherwise does
 * nothing. `dueS` is on the scenario clock (seconds after warm-up); start it at
 * -Infinity so the first step applies. Infinity means no boundary is left.
 */
export function applyAtBoundary(
  binding: EngineBinding,
  sim: EngineLike,
  controls: ManualControls,
  events: readonly ScenarioEvent[],
  frame: RoadFrame,
  dueS: number,
): { readonly dueS: number; readonly composition: Composition | null } {
  const road = roadOf(sim, frame);
  const now = scenarioTimeS(sim.time, road);
  if (now < dueS) return { dueS, composition: null };
  const composition = binding.apply(sim, controls, events, frame);
  const next = nextBoundaryAfter(events, road, now);
  return { dueS: next === null ? Infinity : next, composition };
}

/**
 * Fast-forward: step the engine, rendering nothing, until the scenario clock
 * reaches `targetS` or `budgetMs` of wall time has been spent, whichever is first.
 * Call again to continue. Returns whether the target was reached and how many steps
 * this call took. The engine steps at fixed `dt`, so it can overshoot the target by
 * less than one step. `now` is the wall clock (performance.now in a browser).
 */
export function stepToScenarioTime(
  sim: SteppableEngine,
  frame: RoadFrame,
  targetS: number,
  dt: number,
  budgetMs: number,
  now: () => number,
): { readonly reached: boolean; readonly steps: number } {
  if (!(dt > 0)) throw new RangeError(`dt must be positive, got ${dt}`);
  const started = now();
  let steps = 0;
  // The wall clock is read every step: a step costs from about 0.5 ms (600 m) to 3 ms (3 km), far more than reading it.
  while (scenarioTimeS(sim.time, frame) < targetS) {
    if (now() - started >= budgetMs) return { reached: false, steps };
    sim.step(dt);
    steps++;
  }
  return { reached: true, steps };
}

/**
 * Scenario incidents are tracked by OBJECT: each one the binding puts into the
 * engine's list is remembered under its owner key, so it can be removed exactly and
 * the operator's are never touched, even when an operator's sits at the same spot.
 * A new one goes in through the engine's own addIncident, which also absorbs any
 * vehicle standing on that spot, exactly as when the operator drops one.
 */
export function createEngineBinding(): EngineBinding {
  const owned = new Map<string, Incident>();

  const isOwned = (i: Incident): boolean => {
    for (const o of owned.values()) if (o === i) return true;
    return false;
  };
  const operatorIncidents = (sim: EngineLike): readonly Incident[] => sim.interventions.incidents.filter((i) => !isOwned(i));

  return {
    apply(sim, controls, events, frame) {
      const road = roadOf(sim, frame);
      const composition = composeInterventions({ ...controls, incidents: operatorIncidents(sim) }, events, sim.time, road);
      const next = composition.interventions;
      // Field by field: closureDraft belongs to the operator's click-to-place mode and must survive.
      sim.interventions.closedLanes = next.closedLanes;
      sim.interventions.closurePoint = next.closurePoint;
      sim.interventions.closureEnd = next.closureEnd;
      sim.interventions.showClosurePreview = next.showClosurePreview;
      sim.interventions.speedLimitKmh = next.speedLimitKmh;
      sim.interventions.speedZone = next.speedZone;

      // Scenario incidents: drop the ones no longer wanted, add or repair the ones wanted.
      const wanted = new Map(composition.owners.incidents.map((i) => [i.key, i] as const));
      for (const [key, obj] of [...owned]) {
        if (wanted.has(key)) continue;
        sim.interventions.incidents = sim.interventions.incidents.filter((i) => i !== obj);
        owned.delete(key);
      }
      for (const w of composition.owners.incidents) {
        const have = owned.get(w.key);
        if (have !== undefined && have.lane === w.lane && have.x === w.x && sim.interventions.incidents.includes(have)) continue;
        if (have !== undefined) {
          sim.interventions.incidents = sim.interventions.incidents.filter((i) => i !== have);
          owned.delete(w.key);
        }
        sim.addIncident(w.lane, w.x);
        const list = sim.interventions.incidents;
        const added = list[list.length - 1];
        if (added !== undefined && added.lane === w.lane && added.x === w.x) owned.set(w.key, added);
      }
      return composition;
    },
    operatorIncidents,
    clearOperatorIncidents(sim) {
      sim.interventions.incidents = sim.interventions.incidents.filter((i) => isOwned(i));
    },
    reset() {
      owned.clear();
    },
  };
}
