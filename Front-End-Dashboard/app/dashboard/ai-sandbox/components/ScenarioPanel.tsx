"use client";

import { useState } from "react";
import {
  addEventToBucket,
  addTargets,
  describeYield,
  eventProgress,
  formatClock,
  resolutionView,
  schedulePhases,
  type Direction,
  type ManualClosure,
  type NewEventSpec,
  type Ownership,
  type Road,
  type ScenarioEvent,
} from "../scenarios/adapter";
import {
  NOT_YET_BUILT,
  SCENARIO_TEMPLATES,
  UNSUPPORTED_FAMILIES,
  assertNever,
  defaultOperatorLane,
  getTemplate,
  type BreakdownCause,
  type CollisionLabel,
  type FamilyKey,
  type RainIntensity,
  type ScenarioTemplate,
  type ScenarioVariant,
  type VehicleKind,
} from "../scenarios/catalogue";
import { ASSUMPTIONS } from "../scenarios/assumptions";
import { resolveDuration, type DurationMode, type ResolvedDuration } from "../scenarios/sampler";
import DirectionPill, { DIRECTION_NAME } from "./DirectionPill";
import FamilyIcon from "./FamilyIcon";
import ScenePreview from "./ScenePreview";

/**
 * The Add-event panel and the event list (phase 3).
 *
 * Everything shown here is built by scenarios/adapter.ts (resolutionView, the phase
 * list, eventProgress...); this file only lays it out and keeps the form's state.
 * The panel previews exactly what "Add event" will store: it calls the same
 * addEventToBucket with the same seed, so the minutes, the calibration level, the badges and
 * any refusal on screen are the ones that will apply.
 */

export type SkipView = {
  /** What is being skipped through, e.g. "Minor collision #1 — Lane blocked: awaiting response". */
  readonly label: string;
  /** Scenario clock (seconds after warm-up) when the interval began, where it must end, and where the engine is now. */
  readonly intervalStartS: number;
  readonly targetS: number;
  readonly nowS: number;
};

export type AddOutcome = { readonly ok: true; readonly event: ScenarioEvent } | { readonly ok: false; readonly reason: string };

/**
 * Above this, a skip asks first. About two minutes of real waiting is where "fast-forward"
 * stops feeling like one; the estimate is shown either way, but only a long one interrupts.
 * Applies to every view: a 3 km capped self-accident runs several minutes on one carriageway too.
 */
export const SKIP_WARN_MS = 120_000;

/** What a skip on one carriageway would do, worked out before it starts. */
export type SkipPlan = {
  /** What it skips to, in the words the progress bar will use ("Multi-vehicle collision #1 — ..."). */
  readonly label: string;
  /** Simulated seconds between now and that boundary. */
  readonly simSeconds: number;
  /** Predicted real time, ms; null until this machine has stepped the sim long enough to know its cost. */
  readonly estimateMs: number | null;
};

/** Everything the panel needs about ONE carriageway. In Both mode it is handed two of these. */
export type DirectionScenarioData = {
  events: readonly ScenarioEvent[];
  owners: Ownership;
  road: Road;
  /** Seconds after the end of warm-up, as of the last metrics refresh. */
  nowS: number;
  laneCount: number;
  /** Km for a percentage along the stretch in the direction of travel: used only for a template's default placement. */
  kmAtPct: (pct: number) => number;
  manualClosure: ManualClosure;
  /** The number the next stored event will get. */
  nextSeq: number;
  onAdd: (spec: NewEventSpec) => AddOutcome;
  onRemove: (id: string) => void;
  skip: SkipView | null;
  canSkip: boolean;
  skipPlan: SkipPlan | null;
  onSkip: () => void;
  onCancelSkip: () => void;
};

type Props = {
  /** The carriageways on screen: one in NB-only/SB-only (nothing below changes), two in Both. */
  directions: readonly Direction[];
  /**
   * Which carriageway "Add event" targets: the viewed one, or in Both mode the one picked in the
   * "Add to" control under the family chips (which moves the page's focus with it, so the panel and
   * the rest of the controls never disagree about which road is meant). Always a real direction —
   * there is no direction-less event; "Both" (weather, flooding) adds one event to each.
   */
  focus: Direction;
  onFocus: (d: Direction) => void;
  data: Readonly<Record<Direction, DirectionScenarioData>>;
  fromKm: number;
  toKm: number;
  /**
   * The time of day, in minutes since midnight, at which the scenario clock reads zero — the top of the
   * hour chosen in Hour of day, since the road is simulated at that hour's flow. Events are stored as minutes
   * after warm-up (the engine's clock); this is what lets the form and the list speak in time of day.
   */
  clockStartMin: number;
};

type DurationChoice = "sampled" | "p50" | "p90" | "manual";
const DURATION_CHOICES: readonly { readonly id: DurationChoice; readonly label: string }[] = [
  { id: "sampled", label: "Sampled" },
  { id: "p50", label: "Median" },
  { id: "p90", label: "90th pct" },
  { id: "manual", label: "Manual" },
];

function variantFor(family: FamilyKey, vehicle: VehicleKind, cause: BreakdownCause, label: CollisionLabel, intensity: RainIntensity): ScenarioVariant {
  switch (family) {
    case "breakdown_in_lane":
      return { family, vehicle, cause };
    case "breakdown_shoulder":
      return { family, vehicle, cause };
    case "minor_collision":
      return { family, label };
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
      return { family, intensity };
    default:
      return assertNever(family);
  }
}

function hasLane(family: FamilyKey): boolean {
  return family !== "breakdown_shoulder" && family !== "rain";
}

/** Minutes since midnight as HH:MM. Past midnight it wraps and says so ("00:20 next day"). */
function clockLabel(totalMin: number): string {
  const m = Math.round(totalMin);
  const day = Math.floor(m / 1440);
  const inDay = ((m % 1440) + 1440) % 1440;
  const hh = String(Math.floor(inDay / 60)).padStart(2, "0");
  const mm = String(inDay % 60).padStart(2, "0");
  return `${hh}:${mm}${day > 0 ? " next day" : ""}`;
}

/**
 * A time-of-day box (HH:MM, 24-hour value) that commits on blur or Enter, like NumberField, so a half-typed
 * time is never acted on. It speaks in minutes since midnight and clamps to [minMin, maxMin]: the run only
 * goes forward from the top of the selected hour, and one day has no times past 23:59.
 */
function TimeField({
  valueMin,
  minMin,
  maxMin,
  onCommit,
  scn,
}: {
  valueMin: number;
  minMin: number;
  maxMin: number;
  onCommit: (totalMin: number) => void;
  scn: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const rounded = Math.round(valueMin);
  const shown = `${String(Math.floor(rounded / 60) % 24).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
  const commit = () => {
    if (draft === null) return;
    const m = /^(\d{1,2}):(\d{2})$/.exec(draft);
    setDraft(null);
    if (m) onCommit(Math.min(maxMin, Math.max(minMin, Number(m[1]) * 60 + Number(m[2]))));
  };
  return (
    <input
      type="time"
      className="sandbox-km-input"
      step={60}
      data-scn={scn}
      value={draft ?? shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

/** A number box that commits on blur or Enter, so a half-typed value is never acted on. */
function NumberField({
  value,
  onCommit,
  min,
  max,
  step,
  decimals,
  scn,
}: {
  value: number;
  onCommit: (n: number) => void;
  min: number;
  max: number;
  step: number;
  decimals: number;
  scn: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number.parseFloat(draft);
    setDraft(null);
    if (Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)));
  };
  return (
    <input
      type="number"
      className="sandbox-km-input"
      data-scn={scn}
      min={min}
      max={max}
      step={step}
      value={draft ?? String(Number(value.toFixed(decimals)))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

function ResolutionBlock({ resolved }: { resolved: ResolvedDuration }) {
  const v = resolutionView(resolved);
  return (
    <div className="sandbox-scn-res">
      <b>{v.headline}</b>
      {v.calibration !== null && <span>{v.calibration}</span>}
      {(v.noCalibration !== null || v.lowSample !== null || v.capped !== null) && (
        <span className="sandbox-scn-badges">
          {v.noCalibration !== null && <em className="sandbox-scn-badge no-cal" data-scn="badge-no-cal">{v.noCalibration}</em>}
          {v.lowSample !== null && <em className="sandbox-scn-badge low" data-scn="badge-low">{v.lowSample}</em>}
          {v.capped !== null && <em className="sandbox-scn-badge cap" data-scn="badge-capped">{v.capped}</em>}
        </span>
      )}
      {v.cappedDetail !== null && <span className="sandbox-scn-detail">{v.cappedDetail}</span>}
    </div>
  );
}

function Bar({ fraction, ticks }: { fraction: number; ticks?: readonly number[] }) {
  return (
    <div className="sandbox-scn-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
      <i style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }} />
      {(ticks ?? []).map((t) => (
        <b key={t} style={{ left: `${t * 100}%` }} />
      ))}
    </div>
  );
}

const minutesText = (s: number): string => `${(Math.max(0, s) / 60).toFixed(1)}`;

function SkipProgress({ skip, onCancel }: { skip: SkipView; onCancel: () => void }) {
  const total = Math.max(1e-9, skip.targetS - skip.intervalStartS);
  const done = Math.min(total, Math.max(0, skip.nowS - skip.intervalStartS));
  return (
    <div className="sandbox-scn-skip" data-scn="skip-progress">
      <div className="sandbox-scn-skip-head">
        <b>Skipping · {skip.label}</b>
        <button className="btn-muted active sandbox-scn-cancel" data-scn="skip-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <Bar fraction={done / total} />
      <span data-scn="skip-text">
        {minutesText(done)} of {minutesText(total)} simulated min done · {minutesText(total - done)} min left
      </span>
    </div>
  );
}

/** "45 s", "2 min 40 s", "1 h 12 min": real waiting time, rounded to what a person reads off a warning. */
export function formatWall(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 >= 1 ? ` ${s % 60} s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 >= 1 ? ` ${m % 60} min` : ""}`;
}

/**
 * One carriageway's "Skip to next phase", in every view (NB-only, SB-only, Both). The estimate is
 * shown beside the button, and a skip that the running step cost says will take longer than
 * SKIP_WARN_MS shows it in full and asks first, instead of quietly holding the tab's CPU for minutes.
 */
function SkipControl({ data }: { data: DirectionScenarioData }) {
  const [confirming, setConfirming] = useState(false);
  if (data.skip !== null) return <SkipProgress skip={data.skip} onCancel={data.onCancelSkip} />;
  const plan = data.skipPlan;
  const estimateMs = plan === null ? null : plan.estimateMs;
  const heavy = plan !== null && estimateMs !== null && estimateMs > SKIP_WARN_MS;
  if (confirming && heavy && plan !== null && estimateMs !== null) {
    return (
      <div className="sandbox-scn-skipwarn" data-scn="skip-warn">
        <b>This skip may take up to about {formatWall(estimateMs)} of real time</b>
        <span>
          {plan.label}: {minutesText(plan.simSeconds)} simulated minutes. The figure is a cautious upper bound from how fast this
          machine is stepping now — a queue that is still building makes it slower, one draining makes it faster. The page stays
          responsive and you can cancel part-way, but this carriageway will not animate until it is done.
        </span>
        <div className="sandbox-btn-row" style={{ marginTop: 6 }}>
          <button
            className="btn-primary"
            data-scn="skip-confirm"
            style={{ marginLeft: 0 }}
            onClick={() => {
              setConfirming(false);
              data.onSkip();
            }}
          >
            Skip anyway
          </button>
          <button className="btn-muted" data-scn="skip-decline" onClick={() => setConfirming(false)}>
            Not now
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="sandbox-btn-row" style={{ marginTop: 0 }}>
      <button
        className="btn-muted"
        data-scn="skip"
        data-scn-skip-est={estimateMs === null ? "" : String(Math.round(estimateMs))}
        disabled={!data.canSkip}
        onClick={() => (heavy ? setConfirming(true) : data.onSkip())}
        title="Fast-forward without drawing to the next phase change of any event."
      >
        Skip to next phase
      </button>
      {estimateMs !== null && (
        <span className={`sandbox-scn-est${heavy ? " is-heavy" : ""}`} data-scn="skip-est">
          ≤ ~{formatWall(estimateMs)}
        </span>
      )}
    </div>
  );
}

function EventRow({
  event,
  owners,
  nowS,
  onRemove,
  showDirection,
  clockStartMin,
}: {
  event: ScenarioEvent;
  owners: Ownership;
  nowS: number;
  onRemove: () => void;
  /** Time of day at which the scenario clock reads zero, so the row can say when the event starts on the clock. */
  clockStartMin: number;
  /** Both mode: name the carriageway on the row itself, not only on the group it sits in. */
  showDirection: boolean;
}) {
  const p = eventProgress(event, nowS);
  const invalid = owners.invalid.find((i) => i.eventId === event.id);
  const yields = owners.yielded.filter((y) => y.eventId === event.id);
  const total = event.endS - event.startS;
  const status = invalid
    ? "Not running"
    : p.state === "pending"
      ? `Starts in ${formatClock(p.startsInS)}`
      : p.state === "done"
        ? "Finished"
        : "Active";
  // "Shoulder" is right for a breakdown beside the road; rain has no location at all (its zone is the whole
  // segment, see ASSUMPTIONS.RAIN_ZONE) so it gets its own word instead of borrowing a place that isn't true of it.
  const place =
    event.variant.family === "rain"
      ? `Corridor-wide · ${ASSUMPTIONS.RAIN_SPEED_KMH.value[event.variant.intensity]} km/h cap`
      : event.lane === null
        ? "Shoulder"
        : `Lane ${event.lane}`;
  const where = `${place} · Km ${event.positionKm.toFixed(2)} · starts ${clockLabel(clockStartMin + event.startS / 60)}`;
  return (
    <div className={`sandbox-scn-event${invalid ? " is-invalid" : ""}`} data-scn-event={event.id}>
      <div className="sandbox-scn-event-head">
        {showDirection && <DirectionPill direction={event.direction} />}
        <b>{event.name}</b>
        <span className={`sandbox-scn-chip ${invalid ? "bad" : p.state}`}>{status}</span>
        <button className="btn-muted" data-scn="remove" onClick={onRemove}>
          Remove
        </button>
      </div>
      <span className="sandbox-scn-meta">{where}</span>
      <Bar fraction={total > 0 ? p.elapsedS / total : 0} ticks={event.phases.filter((ph) => !ph.skipped && ph.offsetS > 0).map((ph) => ph.offsetS / total)} />
      {p.state === "active" && (
        <span className="sandbox-scn-meta" data-scn="event-time">
          {p.phase ? `${p.phase.label} · ${formatClock(p.phaseRemainingS ?? 0)} left · ` : ""}
          {formatClock(p.remainingS)} left in the event
        </span>
      )}
      <ResolutionBlock resolved={event.resolved} />
      <ul className="sandbox-scn-phases">
        {event.phases.map((ph) => (
          <li key={ph.id} className={`${ph.skipped ? "is-skipped" : ""}${p.phase !== null && p.phase.id === ph.id ? " is-now" : ""}`}>
            {ph.text}
          </li>
        ))}
      </ul>
      {yields.map((y) => (
        <span key={y.resource} className="sandbox-scn-note" data-scn="suspended">
          {describeYield(y)}
        </span>
      ))}
      {invalid && <span className="sandbox-scn-note">Not running: {invalid.problems.join("; ")}</span>}
    </div>
  );
}

/** The form's starting answers (also what "Add event" puts back once it has stored an event). */
const DEFAULT_START_MIN = 1;
const DEFAULT_MANUAL_MIN = 30;

export default function ScenarioPanel(props: Props) {
  const { directions, focus: direction, data, fromKm, toKm, clockStartMin } = props;
  const both = directions.length > 1;
  // The form reads the FOCUSED carriageway's events, and the verdict is worked out per target carriageway
  // (conflicts and locks are scoped within a direction): its events, its road, its manual closure. Weather and
  // flooding can target both at once in Both mode (see addTargets).
  const target = data[direction];
  const { events } = target;
  const [family, setFamily] = useState<FamilyKey>("breakdown_in_lane");
  const template: ScenarioTemplate = getTemplate(family);
  const [vehicle, setVehicle] = useState<VehicleKind>("truck");
  const [cause, setCause] = useState<BreakdownCause>("engine");
  const [label, setLabel] = useState<CollisionLabel>("rear_end");
  const [intensity, setIntensity] = useState<RainIntensity>("moderate");
  const [lane, setLane] = useState<number | null>(null);
  const [posKm, setPosKm] = useState<number | null>(null);
  const [startMin, setStartMin] = useState(DEFAULT_START_MIN);
  const [choice, setChoice] = useState<DurationChoice>("sampled");
  const [manualMin, setManualMin] = useState(DEFAULT_MANUAL_MIN);
  const [seed, setSeed] = useState(1);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Both mode only: add to both carriageways at once (the default for a family that reaches both).
  const [wantBoth, setWantBoth] = useState(false);
  // The scenario's description lives behind the "i" on its picture rather than taking up the panel.
  const [infoOpen, setInfoOpen] = useState(false);

  const pickFamily = (f: FamilyKey) => {
    const t = getTemplate(f);
    setFamily(f);
    setInfoOpen(false);
    setWantBoth(t.carriageways === "one_or_both");
    setLane(null);
    setPosKm(null);
    setRefusal(null);
    // A family with no calibration entry only accepts Manual (resolveDuration throws otherwise);
    // force it here so the panel can never sit on a now-invalid Sampled/Median/90th choice.
    if (t.durationSource === "manual_only") setChoice("manual");
    switch (t.family) {
      case "breakdown_in_lane":
      case "breakdown_shoulder":
        setVehicle(t.defaultVehicle);
        setCause(t.defaultCause);
        break;
      case "minor_collision":
        setLabel(t.defaultLabel);
        break;
      case "rain":
        setIntensity(t.defaultIntensity);
        break;
      case "multi_vehicle_collision":
      case "self_accident":
      case "overturned_vehicle":
      case "flood":
      case "scheduled_roadworks":
        break;
      default:
        assertNever(t);
    }
  };

  // Where this Add goes: one carriageway (the focused one) or, for weather and flooding in Both mode, both.
  const targets = addTargets(template.carriageways, directions, direction, wantBoth);
  const onBoth = targets.length > 1;
  // Lane numbers mean the same on both carriageways (lane 1 against the median), so with two targets the
  // lane list is the shorter road's and both events get the same lane.
  const laneCap = Math.min(...targets.map((d) => data[d].laneCount));
  const laneNow = lane === null ? defaultOperatorLane(template, laneCap) : Math.min(Math.max(1, lane), laneCap);
  // One place for both carriageways: the first target's default, so Both does not put the two events at different km.
  const kmNow = Math.min(toKm, Math.max(fromKm, posKm === null ? data[targets[0]].kmAtPct(template.defaultPlacement.pct) : posKm));
  const variant = variantFor(family, vehicle, cause, label, intensity);
  const duration: DurationMode =
    choice === "sampled" ? { kind: "sampled", seed } : choice === "p50" ? { kind: "p50" } : choice === "p90" ? { kind: "p90" } : { kind: "manual", minutes: manualMin };
  const specFor = (d: Direction): NewEventSpec => ({ variant, direction: d, lane: hasLane(family) ? laneNow : null, positionKm: kmNow, startMinutes: startMin, duration });

  // The same call "Add event" makes, once per target, so what is shown is what will be stored (and why not, if
  // it will not). With two targets the Add is all or nothing: one refusal blocks both, and names its carriageway.
  let refusalNow: string | null = null;
  for (const d of targets) {
    const v = addEventToBucket(d, data[d].events, specFor(d), data[d].road, data[d].nextSeq, data[d].manualClosure);
    if (!v.ok && refusalNow === null) refusalNow = v.reason;
  }
  let preview: ResolvedDuration | null = null;
  try {
    preview = resolveDuration(variant, duration);
  } catch {
    preview = null; // a manual duration that is not a positive number: the verdict says so
  }
  const previewPhases = preview === null ? [] : schedulePhases(variant, preview);

  // Back to this family's own defaults: what was typed for the event just stored must not linger and be
  // re-submitted (it would refuse as a conflict with itself). The family chip stays where it is.
  const clearAnswers = (f: FamilyKey) => {
    pickFamily(f);
    setStartMin(DEFAULT_START_MIN);
    setManualMin(DEFAULT_MANUAL_MIN);
    setSeed(1);
    if (getTemplate(f).durationSource !== "manual_only") setChoice("sampled");
  };

  const add = () => {
    let failure: string | null = null;
    for (const d of targets) {
      const r = data[d].onAdd(specFor(d));
      if (!r.ok && failure === null) failure = r.reason;
    }
    if (failure === null) clearAnswers(family);
    else setRefusal(failure);
  };

  return (
    <div className="sandbox-scn" data-scn="panel">
      <span className="sandbox-mini-label">Add a real-incident scenario</span>
      <div className="sandbox-scn-families">
        {SCENARIO_TEMPLATES.map((t) => (
          <button key={t.family} className={`sandbox-scn-fam${family === t.family ? " active" : ""}`} data-scn-family={t.family} onClick={() => pickFamily(t.family)}>
            <FamilyIcon family={t.family} />
            <span>{t.displayName}</span>
          </button>
        ))}
        {UNSUPPORTED_FAMILIES.map((u) => (
          <button key={u.id} className="sandbox-scn-fam" data-scn-family={u.id} disabled title={`${NOT_YET_BUILT}: ${u.needs}`}>
            {u.displayName}
            <small>{NOT_YET_BUILT}</small>
          </button>
        ))}
      </div>
      {both && (
        <div className="sandbox-dir-pick" data-scn="direction-pick" role="tablist" aria-label="Add the event to which carriageway">
          <span className="k">Add to</span>
          <div className="sandbox-dir-seg">
            {template.carriageways === "one_or_both" && (
              <button role="tab" aria-selected={onBoth} className={`dir-BOTH${onBoth ? " active" : ""}`} data-scn-dir="BOTH" onClick={() => setWantBoth(true)}>
                Both
              </button>
            )}
            {directions.map((d) => (
              <button
                key={d}
                role="tab"
                aria-selected={!onBoth && direction === d}
                className={`dir-${d}${!onBoth && direction === d ? " active" : ""}`}
                data-scn-dir={d}
                onClick={() => {
                  setWantBoth(false);
                  props.onFocus(d);
                }}
              >
                {DIRECTION_NAME[d]}
              </button>
            ))}
          </div>
          <span className="sandbox-slider-hint" data-scn="direction-note">
            {template.carriageways === "one"
              ? "This happens on one carriageway: choose which."
              : onBoth
                ? "Applies to both carriageways: one event is added to each, at the same place and time."
                : `Only ${DIRECTION_NAME[direction]}. Choose Both to add it to each carriageway.`}
          </span>
        </div>
      )}
      <div
        className="sandbox-scn-scene"
        onKeyDown={(e) => {
          if (e.key === "Escape") setInfoOpen(false);
        }}
      >
        <ScenePreview family={family} vehicle={vehicle} intensity={intensity} />
        <button
          type="button"
          className="sandbox-scn-info"
          data-scn="info"
          aria-label={`About ${template.displayName}`}
          aria-expanded={infoOpen}
          title={infoOpen ? "Hide the description" : `About ${template.displayName}`}
          onClick={() => setInfoOpen((o) => !o)}
        >
          i
        </button>
        {infoOpen && (
          <div className="sandbox-scn-info-pop" data-scn="description" role="note">
            <b>{template.displayName}</b>
            <p>{template.description}</p>
          </div>
        )}
      </div>
      {template.family === "rain" && (
        <div className="sandbox-scn-intensity" data-scn="intensity" role="radiogroup" aria-label="Rain intensity">
          <span className="sandbox-mini-label">How hard is it raining?</span>
          <div className="sandbox-speed-seg">
            {template.intensities.map((o) => (
              <button
                key={o.id}
                role="radio"
                aria-checked={intensity === o.id}
                className={intensity === o.id ? "active" : ""}
                data-scn-intensity={o.id}
                onClick={() => setIntensity(o.id)}
                title={`Caps traffic at ${ASSUMPTIONS.RAIN_SPEED_KMH.value[o.id]} km/h`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <span className="sandbox-scn-cap" data-scn="rain-cap">
            Caps traffic at {ASSUMPTIONS.RAIN_SPEED_KMH.value[intensity]} km/h — scaled from free-flow speeds measured on the NLEx in rain (Mejia &amp; Sigua 2018). A cap does not lengthen following headways, so capacity loss is understated.
          </span>
        </div>
      )}

      {(template.family === "breakdown_in_lane" || template.family === "breakdown_shoulder") && (
        <div className="sandbox-scn-row">
          <label>
            Vehicle
            <select data-scn="vehicle" value={vehicle} onChange={(e) => setVehicle(template.vehicles.find((v) => v.id === e.target.value)?.id ?? vehicle)}>
              {template.vehicles.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
          </label>
          <label>
            Cause
            <select data-scn="cause" value={cause} onChange={(e) => setCause(template.causes.find((c) => c.id === e.target.value)?.id ?? cause)}>
              {template.causes.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {template.family === "minor_collision" && (
        <label>
          Collision type
          <select data-scn="label" value={label} onChange={(e) => setLabel(template.labels.find((l) => l.id === e.target.value)?.id ?? label)}>
            {template.labels.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
        </label>
      )}

      <div className="sandbox-scn-row">
        {hasLane(family) && (
          <label>
            Lane
            <select data-scn="lane" value={laneNow} onChange={(e) => setLane(Number(e.target.value))}>
              {Array.from({ length: laneCap }, (_, i) => (
                <option key={i} value={i + 1}>Lane {i + 1}</option>
              ))}
            </select>
          </label>
        )}
        <label title={`The road is simulated at the flow of the hour chosen in Hour of day, so the clock starts at ${clockLabel(clockStartMin)}: an event can start then or later that day.`}>
          Start (time of day)
          <TimeField
            valueMin={clockStartMin + startMin}
            minMin={clockStartMin}
            maxMin={1439}
            scn="start"
            onCommit={(t) => setStartMin(t - clockStartMin)}
          />
        </label>
      </div>
      <div className="sandbox-scn-row">
        <label>
          Position (km)
          <NumberField value={kmNow} min={fromKm} max={toKm} step={0.05} decimals={2} scn="km" onCommit={setPosKm} />
        </label>
      </div>

      <span className="sandbox-mini-label">Duration</span>
      {template.durationSource === "manual_only" ? (
        <p className="sandbox-scn-desc" data-scn="manual-only-note">
          No NLEX record of this family exists, so there is nothing to sample from — enter the duration yourself.
        </p>
      ) : (
        <div className="sandbox-speed-seg">
          {DURATION_CHOICES.map((c) => (
            <button key={c.id} className={choice === c.id ? "active" : ""} data-scn-duration={c.id} onClick={() => setChoice(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      )}
      {choice === "sampled" && (
        <button className="btn-muted" data-scn="redraw" onClick={() => setSeed(1 + Math.floor(Math.random() * 2147483000))} title="Draw again from the same calibrated distribution">
          Redraw
        </button>
      )}
      {choice === "manual" && (
        <label>
          Minutes
          <NumberField value={manualMin} min={0.1} max={1440} step={1} decimals={1} scn="manual-min" onCommit={setManualMin} />
        </label>
      )}
      {preview !== null && <ResolutionBlock resolved={preview} />}
      {previewPhases.length > 0 && (
        <ul className="sandbox-scn-phases" data-scn="preview-phases">
          {previewPhases.map((ph) => (
            <li key={ph.id} className={ph.skipped ? "is-skipped" : ""}>{ph.text}</li>
          ))}
        </ul>
      )}

      {refusalNow !== null && (
        <p className="sandbox-live-note warn" data-scn="refusal">
          {refusalNow}
        </p>
      )}
      {refusal !== null && refusalNow === null && <p className="sandbox-live-note warn">{refusal}</p>}
      <div className="sandbox-btn-row">
        <button className="btn-primary" data-scn="add" disabled={refusalNow !== null} onClick={add} style={{ marginLeft: 0 }}>
          {both ? (onBoth ? "Add to both carriageways" : `Add to ${DIRECTION_NAME[direction]}`) : "Add event"}
        </button>
      </div>

      {both
        ? directions.some((d) => data[d].events.length > 0) && (
            <>
              <span className="sandbox-mini-label">Events · time of day, the clock starts at {clockLabel(clockStartMin)}</span>
              {directions.map((d) => {
                const dd = data[d];
                if (dd.events.length === 0) return null;
                return (
                  <div key={d} className={`sandbox-scn-group dir-${d}`} data-scn-group={d}>
                    <div className="sandbox-scn-group-head">
                      <DirectionPill direction={d} long />
                      <span>
                        {dd.events.length} event{dd.events.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <SkipControl data={dd} />
                    {dd.events.map((e) => (
                      <EventRow key={e.id} event={e} owners={dd.owners} nowS={dd.nowS} onRemove={() => dd.onRemove(e.id)} showDirection clockStartMin={clockStartMin} />
                    ))}
                  </div>
                );
              })}
            </>
          )
        : events.length > 0 && (
            <>
              <span className="sandbox-mini-label">Events · time of day, the clock starts at {clockLabel(clockStartMin)}</span>
              <SkipControl data={target} />
              {events.map((e) => (
                <EventRow key={e.id} event={e} owners={target.owners} nowS={target.nowS} onRemove={() => target.onRemove(e.id)} showDirection={false} clockStartMin={clockStartMin} />
              ))}
            </>
          )}
    </div>
  );
}
