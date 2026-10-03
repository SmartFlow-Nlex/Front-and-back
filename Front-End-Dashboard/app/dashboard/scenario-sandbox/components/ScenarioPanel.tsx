"use client";

import { useEffect, useState } from "react";
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
import InfoTooltip from "../../../../components/dashboard/InfoTooltip";
import {
  HOTSPOT_FAMILIES,
  SITE_FAMILIES,
  candidatesFrom,
  resolvePlace,
  stationLabel,
  useHotspots,
  type PickResult,
  type PlaceMode,
  type ScenarioDrop,
  SCENARIO_DRAG_TYPE,
  type SiteOption,
} from "./placement";

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
  /** Toll plazas, ramps and service areas on this carriageway's stretch. */
  sites: readonly SiteOption[];
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
  /** Arm the canvas: the next click on the road (or a booth) is handed back here. */
  onPickOnRoad?: (direction: Direction, done: (p: PickResult) => void) => void;
  /** Filled by the panel: what the road calls when a scenario chip is dropped on it. */
  dropRef?: { current: ScenarioDrop | null };
  /** A chip is being dragged (its family), or the drag ended (null): the road shows where it would land. */
  onDragFamily?: (family: FamilyKey | null) => void;
  /** Disarm it again. */
  onCancelPick?: () => void;
  /** Outline a plaza or service area on the canvas while it is the chosen place. */
  onHighlight?: (facilityId: string | null) => void;
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

/**
 * Families where blocking more than one lane is plausible enough to let the operator add
 * extra lanes by hand, beyond the automatic outward-spill guess (see composeInterventions /
 * ASSUMPTIONS.LANES_BLOCKED). Left out: minor_collision and self_accident (typically one
 * car, one lane), breakdown_in_lane (a single stalled vehicle — the "incident" effect, not
 * a closure, has no lane list to extend), and breakdown_shoulder/rain (no lane at all).
 */
const MULTI_LANE_FAMILIES = new Set<FamilyKey>(["multi_vehicle_collision", "overturned_vehicle", "flood", "scheduled_roadworks"]);
function canAddExtraLanes(family: FamilyKey): boolean {
  return MULTI_LANE_FAMILIES.has(family);
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
 * A time-of-day box (HH:MM, or HH:MM:SS when `step` asks for second precision) that commits on
 * blur or Enter, like NumberField, so a half-typed time is never acted on. It speaks in SECONDS
 * since midnight and clamps to [minS, maxS]: the run only goes forward from the top of the
 * selected hour, and one day has no times past 23:59:59. `step` defaults to 60 (minute
 * granularity, no seconds shown) for the scenario form's own use, where a start time has never
 * needed finer than a minute.
 *
 * Plain text, not `<input type="time">`: a native time control's displayed format (12-hour AM/PM
 * vs. 24-hour) follows the browser/OS locale, not the page. `lang="en-GB"` on the input was tried
 * to force Chromium's own picker chrome into 24-hour and did not hold on every machine (still
 * showed AM/PM on Windows). A plain text box has no native picker to disagree with it — what's
 * rendered here, always HH:MM[:SS] in 24-hour, is exactly what shows, everywhere.
 */
export function TimeField({
  valueS,
  minS,
  maxS,
  step = 60,
  onCommit,
  scn,
}: {
  valueS: number;
  minS: number;
  maxS: number;
  step?: number;
  onCommit: (totalS: number) => void;
  scn: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const rounded = Math.round(valueS);
  const withSeconds = step < 60;
  const shown =
    `${String(Math.floor(rounded / 3600) % 24).padStart(2, "0")}:${String(Math.floor(rounded / 60) % 60).padStart(2, "0")}` +
    (withSeconds ? `:${String(rounded % 60).padStart(2, "0")}` : "");
  const commit = () => {
    if (draft === null) return;
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(draft);
    setDraft(null);
    if (m) onCommit(Math.min(maxS, Math.max(minS, Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0))));
  };
  return (
    <input
      type="text"
      className="sandbox-km-input"
      data-scn={scn}
      placeholder={withSeconds ? "HH:MM:SS" : "HH:MM"}
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
    event.site
      ? `${event.site.facilityName} · ${
          event.site.kind === "approach"
            ? event.site.facilityId.startsWith("barrier:") ? "before the booths" : "on the ramp"
            : `${event.site.kind} ${event.site.stations.map((i) => i + 1).join(", ")}`
        }`
      : event.variant.family === "rain"
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
  /** Extra lanes the operator added on top of `lane`, for a MULTI_LANE_FAMILIES family. 1-based, no duplicates. */
  const [extraLanes, setExtraLanes] = useState<number[]>([]);
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
  /* Where: from the incident log, a click on the road, a plaza or service
     area, or a typed km — see placement.ts. The log is the default for
     anything it records: "where it usually happens" is the first question
     to ask of an incident, and the answer is in the corridor's own record. */
  const [placeMode, setPlaceMode] = useState<PlaceMode>("data");
  const [hotChoice, setHotChoice] = useState<string | null>(null);
  const [pick, setPick] = useState<PickResult | null>(null);
  const [picking, setPicking] = useState(false);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [siteStations, setSiteStations] = useState<number[]>([0]);
  const [siteApproach, setSiteApproach] = useState(false);

  const pickFamily = (f: FamilyKey) => {
    const t = getTemplate(f);
    setFamily(f);
    setInfoOpen(false);
    setWantBoth(t.carriageways === "one_or_both");
    setLane(null);
    setExtraLanes([]);
    setPosKm(null);
    setRefusal(null);
    setHotChoice(null);
    // Keep the operator's way of placing wherever it still applies to the new family.
    setPlaceMode((m) => (m === "data" && !HOTSPOT_FAMILIES.has(f) ? "km" : m === "site" && !SITE_FAMILIES.has(f) ? "km" : m === "km" && HOTSPOT_FAMILIES.has(f) ? "data" : m));
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

  // Where the event goes. With two targets (weather, flooding) only a km makes sense.
  const mode: PlaceMode = onBoth ? "km" : placeMode === "data" && !HOTSPOT_FAMILIES.has(family) ? "km" : placeMode === "site" && !SITE_FAMILIES.has(family) ? "km" : placeMode;
  const defaultKm = Math.min(toKm, Math.max(fromKm, data[targets[0]].kmAtPct(template.defaultPlacement.pct)));
  const sites = onBoth ? [] : data[direction].sites;
  const hot = useHotspots(family, direction, fromKm, toKm, mode === "data");
  const candidates = candidatesFrom(hot.data, SITE_FAMILIES.has(family) ? sites : [], fromKm, toKm);
  const place = resolvePlace({
    mode,
    defaultKm,
    fromKm,
    toKm,
    posKm,
    candidates,
    choice: hotChoice,
    pick: pick && pick.direction === direction ? pick : null,
    sites,
    siteId,
    siteStations,
    siteApproach,
    hotLoading: hot.loading,
    hotError: hot.error,
  });
  const site = SITE_FAMILIES.has(family) ? place.site : null;
  const siteSel = sites.find((x) => x.id === siteId) ?? sites[0] ?? null;
  // The plaza or service area being aimed at is outlined on the road.
  const highlightId = site?.facilityId ?? (mode === "site" ? siteSel?.id ?? null : null);
  const { onHighlight, onPickOnRoad, onCancelPick } = props;
  useEffect(() => {
    onHighlight?.(highlightId);
  }, [highlightId, onHighlight]);
  useEffect(() => () => onHighlight?.(null), [onHighlight]);
  const armPick = () => {
    if (!onPickOnRoad) return;
    setPicking(true);
    onPickOnRoad(direction, (res) => {
      setPick(res);
      setPicking(false);
      setLane(null);
    });
  };
  const choosePlaceMode = (m: PlaceMode) => {
    setPlaceMode(m);
    setLane(null);
    if (m === "pick") armPick();
    else if (picking) {
      setPicking(false);
      onCancelPick?.();
    }
  };
  // Lane numbers mean the same on both carriageways (lane 1 against the median), so with two targets the
  // lane list is the shorter road's and both events get the same lane.
  const laneCap = Math.min(...targets.map((d) => data[d].laneCount));
  // The place's own lane (the log's usual lane there, or the lane clicked) until the operator picks one.
  const laneNow =
    lane === null
      ? Math.min(Math.max(1, place.lane ?? defaultOperatorLane(template, laneCap)), laneCap)
      : Math.min(Math.max(1, lane), laneCap);
  // Re-clamped every render against the current laneCap/laneNow, same spirit as laneNow above: a lane
  // picked before switching to Both (a narrower road) or before changing the primary lane never lingers
  // as an out-of-range or duplicate entry.
  const extraLanesNow = canAddExtraLanes(family)
    ? [...new Set(extraLanes.filter((l) => l >= 1 && l <= laneCap && l !== laneNow))]
    : [];
  // One place for both carriageways: the first target's default, so Both does not put the two events at different km.
  const kmNow = Math.min(toKm, Math.max(fromKm, place.positionKm));
  const variant = variantFor(family, vehicle, cause, label, intensity);
  const duration: DurationMode =
    choice === "sampled" ? { kind: "sampled", seed } : choice === "p50" ? { kind: "p50" } : choice === "p90" ? { kind: "p90" } : { kind: "manual", minutes: manualMin };
  // At a plaza the event has no lane of the carriageway: the booth or pump is its place.
  const specFor = (d: Direction): NewEventSpec => ({ variant, direction: d, lane: site ? null : hasLane(family) ? laneNow : null, extraLanes: site ? [] : extraLanesNow, positionKm: kmNow, startMinutes: startMin, duration, site });

  // The same call "Add event" makes, once per target, so what is shown is what will be stored (and why not, if
  // it will not). With two targets the Add is all or nothing: one refusal blocks both, and names its carriageway.
  let refusalNow: string | null = null;
  for (const d of targets) {
    const v = addEventToBucket(d, data[d].events, specFor(d), data[d].road, data[d].nextSeq, data[d].manualClosure);
    if (!v.ok && refusalNow === null) refusalNow = v.reason;
  }
  // A place not chosen yet comes first: until there is one, nothing else can be judged.
  if (place.incomplete) refusalNow = place.note ?? "Choose where the event happens.";
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

  /* A chip dropped on the road: this family as the form below has it (vehicle, cause, duration, start), at the
     place it landed. The start is the form's, or now if that time has already passed, so a dropped incident
     appears on the road straight away rather than in the past. Weather and flooding set to "Both" go on both
     carriageways at the dropped km, as Add event would put them. */
  const dropAt: ScenarioDrop = (f, at) => {
    const t = getTemplate(f);
    // Dragging a chip selects it first (onDragStart); a drop that beats that render is simply asked again.
    if (f !== family) return `Drop ${t.displayName} again: it was still being selected.`;
    if (at.site !== null && !SITE_FAMILIES.has(f)) return `${t.displayName} happens on a lane: drop it on a lane, not on a booth or pump.`;
    const onto = onBoth && at.site === null ? targets : [at.direction];
    if (!onto.includes(at.direction)) return `${t.displayName} cannot be added to that carriageway here.`;
    const cap = Math.min(...onto.map((d) => data[d].laneCount));
    const laneAt = at.site !== null || !hasLane(f) ? null : Math.min(Math.max(1, at.lane ?? defaultOperatorLane(t, cap)), cap);
    const extras = laneAt === null || !canAddExtraLanes(f) ? [] : [...new Set(extraLanes.filter((l) => l >= 1 && l <= cap && l !== laneAt))];
    let failure: string | null = null;
    for (const d of onto) {
      const r = data[d].onAdd({
        variant, direction: d, lane: laneAt, extraLanes: extras,
        positionKm: Math.min(toKm, Math.max(fromKm, at.km)),
        startMinutes: Math.max(startMin, data[d].nowS / 60),
        duration, site: SITE_FAMILIES.has(f) ? at.site : null,
      });
      if (!r.ok && failure === null) failure = r.reason;
    }
    if (failure !== null) {
      setRefusal(failure);
      return failure;
    }
    if (at.direction !== direction) props.onFocus(at.direction);
    clearAnswers(f);
    return null;
  };
  useEffect(() => {
    if (props.dropRef) props.dropRef.current = dropAt;
  });
  useEffect(() => {
    const ref = props.dropRef;
    return () => {
      if (ref) ref.current = null;
    };
  }, [props.dropRef]);

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
      <span className="sandbox-slider-hint" data-scn="drag-hint">
        Drag one onto the road to put it there, or choose it and set where below.
      </span>
      <div className="sandbox-scn-families">
        {SCENARIO_TEMPLATES.map((t) => (
          <button
            key={t.family}
            className={`sandbox-scn-fam${family === t.family ? " active" : ""}`}
            data-scn-family={t.family}
            onClick={() => pickFamily(t.family)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(SCENARIO_DRAG_TYPE, t.family);
              e.dataTransfer.effectAllowed = "copy";
              // Selected as it is picked up, so the form below is this scenario's and the drop uses it.
              if (family !== t.family) pickFamily(t.family);
              props.onDragFamily?.(t.family);
            }}
            onDragEnd={() => props.onDragFamily?.(null)}
            title={`Drag onto the road to place ${t.displayName} there`}
          >
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

      <div className="sandbox-scn-place" data-scn="place">
        <span className="sandbox-mini-label">Where</span>
        <div className="sandbox-speed-seg" role="radiogroup" aria-label="Where the event happens">
          {HOTSPOT_FAMILIES.has(family) && !onBoth && (
            <button role="radio" aria-checked={mode === "data"} className={mode === "data" ? "active" : ""} data-scn-place="data" onClick={() => choosePlaceMode("data")}
                    title="Where the incident log records this kind of event most often on this stretch">
              Most frequent
            </button>
          )}
          {!onBoth && onPickOnRoad && (
            <button role="radio" aria-checked={mode === "pick"} className={mode === "pick" ? "active" : ""} data-scn-place="pick" onClick={() => choosePlaceMode("pick")}
                    title="Click a lane, a toll booth or a pump on the road">
              Pick on road
            </button>
          )}
          {SITE_FAMILIES.has(family) && !onBoth && (
            <button role="radio" aria-checked={mode === "site"} className={mode === "site" ? "active" : ""} data-scn-place="site" onClick={() => choosePlaceMode("site")}
                    disabled={sites.length === 0}
                    title={sites.length === 0 ? "No toll plaza, ramp or service area on this stretch for this carriageway — widen the window, or frame one from the Corridor section." : "At a toll plaza's booths, a service area's pumps, or on a ramp"}>
              At a plaza
            </button>
          )}
          <button role="radio" aria-checked={mode === "km"} className={mode === "km" ? "active" : ""} data-scn-place="km" onClick={() => choosePlaceMode("km")}>
            Km
          </button>
        </div>

        {mode === "data" && (
          <div className="sandbox-scn-hot" data-scn="hotspots">
            {candidates.slice(0, 5).map((c, i) => {
              const on = (hotChoice ?? candidates[0]?.key) === c.key;
              return (
                <button key={c.key} className={`sandbox-scn-hot-row${on ? " active" : ""}`} data-scn-hot={i}
                        onClick={() => { setHotChoice(c.key); setLane(null); }}>
                  <b>{c.label}</b>
                  <span>{c.detail}</span>
                </button>
              );
            })}
            {hot.data && (
              <span className="sandbox-slider-hint" data-scn="hot-source">
                {hot.data.inWindow.toLocaleString()} recorded on this stretch of the {direction === "NB" ? "northbound" : "southbound"} carriageway
                {hot.data.period ? `, ${hot.data.period.from} to ${hot.data.period.to}` : ""}. Source: {hot.data.source}.{hot.data.note ? ` ${hot.data.note}` : ""}
              </span>
            )}
          </div>
        )}

        {mode === "pick" && (
          <div className="sandbox-btn-row" style={{ marginTop: 4 }}>
            <button className={`btn-muted${picking ? " active" : ""}`} data-scn="pick-arm" onClick={() => (picking ? (setPicking(false), onCancelPick?.()) : armPick())}>
              {picking ? "Cancel picking" : pick && pick.direction === direction ? "Pick again" : "Pick on road"}
            </button>
          </div>
        )}

        {mode === "site" && siteSel && (
          <div className="sandbox-scn-site" data-scn="site">
            <label>
              Place
              <select data-scn="site-id" value={siteSel.id} onChange={(e) => { setSiteId(e.target.value); setSiteStations([0]); setSiteApproach(false); }}>
                {sites.map((x) => (
                  <option key={x.id} value={x.id}>{x.name} · Km {x.km.toFixed(2)}</option>
                ))}
              </select>
            </label>
            {siteSel.stations > 0 ? (
              <div className="sandbox-scn-stations" data-scn="stations">
                {Array.from({ length: siteSel.stations }, (_, i) => (
                  <label key={i} className="sandbox-scn-check">
                    <input type="checkbox" data-scn-station={i} checked={!siteApproach && siteStations.includes(i)} disabled={siteApproach}
                           onChange={(e) => {
                             const next = e.target.checked ? [...siteStations, i] : siteStations.filter((x) => x !== i);
                             if (next.length > 0) setSiteStations(next);
                           }} />
                    {stationLabel(siteSel.kind, i, siteSel.stations)}
                  </label>
                ))}
                <label className="sandbox-scn-check">
                  <input type="checkbox" data-scn="site-approach" checked={siteApproach} onChange={(e) => setSiteApproach(e.target.checked)} />
                  {siteSel.kind === "barrier" ? "Before the booths (the plaza's approach)" : "On the ramp before the " + (siteSel.kind === "service_area" ? "pumps" : "booths") + " — blocks all of them"}
                </label>
              </div>
            ) : (
              <span className="sandbox-slider-hint">An untolled ramp: the event blocks the ramp itself, single file, so everything using it stops.</span>
            )}
          </div>
        )}

        {mode === "km" && (
          <div className="sandbox-scn-row">
            <label>
              Position (km)
              <NumberField value={kmNow} min={fromKm} max={toKm} step={0.05} decimals={2} scn="km" onCommit={setPosKm} />
            </label>
          </div>
        )}
        {place.note && mode !== "data" && <span className="sandbox-slider-hint" data-scn="place-note">{place.note}</span>}
        {mode === "data" && place.note && candidates.length === 0 && <span className="sandbox-slider-hint" data-scn="place-note">{place.note}</span>}
      </div>

      <div className="sandbox-scn-row">
        {hasLane(family) && !site && (
          <label>
            Lane
            <select data-scn="lane" value={laneNow} onChange={(e) => setLane(Number(e.target.value))}>
              {Array.from({ length: laneCap }, (_, i) => (
                <option key={i} value={i + 1}>Lane {i + 1}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {canAddExtraLanes(family) && lane !== null && !site && (
        <div className="sandbox-scn-row" data-scn="extra-lanes">
          <label style={{ flex: 1, minWidth: 0 }}>
            <span className="sandbox-mini-label" style={{ margin: "0 0 3px" }}>
              Extra lanes
              <InfoTooltip text="This family can plausibly block more than one lane. Add the specific lanes it also closes, beyond the primary Lane above — replaces the automatic guess for this event." />
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              {extraLanes.map((l, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                  <select
                    data-scn={`extra-lane-${i}`}
                    value={l}
                    onChange={(e) => setExtraLanes(extraLanes.map((x, xi) => (xi === i ? Number(e.target.value) : x)))}
                  >
                    {Array.from({ length: laneCap }, (_, li) => li + 1)
                      .filter((n) => n === l || (n !== laneNow && !extraLanes.includes(n)))
                      .map((n) => (
                        <option key={n} value={n}>Lane {n}</option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="btn-muted"
                    data-scn={`remove-extra-lane-${i}`}
                    onClick={() => setExtraLanes(extraLanes.filter((_, xi) => xi !== i))}
                    aria-label={`Remove lane ${l}`}
                    style={{ padding: "4px 8px" }}
                  >
                    &times;
                  </button>
                </span>
              ))}
              {extraLanesNow.length < laneCap - 1 && (
                <button
                  type="button"
                  className="btn-muted"
                  data-scn="add-extra-lane"
                  onClick={() => {
                    const used = new Set([laneNow, ...extraLanes]);
                    const next = Array.from({ length: laneCap }, (_, i) => i + 1).find((n) => !used.has(n));
                    if (next !== undefined) setExtraLanes([...extraLanes, next]);
                  }}
                >
                  + Add lane
                </button>
              )}
            </div>
          </label>
        </div>
      )}
      <div className="sandbox-scn-row">
        <label title={`The road is simulated at the flow of the hour chosen in Hour of day, so the clock starts at ${clockLabel(clockStartMin)}: an event can start then or later that day.`}>
          Start (time of day)
          <TimeField
            valueS={(clockStartMin + startMin) * 60}
            minS={clockStartMin * 60}
            maxS={1439 * 60}
            scn="start"
            onCommit={(t) => setStartMin(t / 60 - clockStartMin)}
          />
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
