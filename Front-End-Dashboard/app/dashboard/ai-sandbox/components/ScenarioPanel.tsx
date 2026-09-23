"use client";

import { useState } from "react";
import {
  addEvent,
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
  type ScenarioTemplate,
  type ScenarioVariant,
  type VehicleKind,
} from "../scenarios/catalogue";
import { resolveDuration, type DurationMode, type ResolvedDuration } from "../scenarios/sampler";

/**
 * The Add-event panel and the event list (phase 3).
 *
 * Everything shown here is built by scenarios/adapter.ts (resolutionView, the phase
 * list, eventProgress...); this file only lays it out and keeps the form's state.
 * The panel previews exactly what "Add event" will store: it calls the same
 * addEvent with the same seed, so the minutes, the calibration level, the badges and
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

type Props = {
  events: readonly ScenarioEvent[];
  owners: Ownership;
  road: Road;
  /**
   * Which carriageway this panel's events belong to. Stamped onto every event this panel
   * creates; the picker in Both mode (see D4) will let the operator change it before Add,
   * but a value is always required — there is no direction-less event.
   */
  direction: Direction;
  /** Seconds after the end of warm-up, as of the last metrics refresh. */
  nowS: number;
  laneCount: number;
  fromKm: number;
  toKm: number;
  /** Km for a percentage along the stretch in the direction of travel: used only for a template's default placement. */
  kmAtPct: (pct: number) => number;
  manualClosure: ManualClosure;
  /** The number the next stored event will get. */
  nextSeq: number;
  onAdd: (spec: NewEventSpec) => AddOutcome;
  onRemove: (id: string) => void;
  skip: SkipView | null;
  canSkip: boolean;
  onSkip: () => void;
  onCancelSkip: () => void;
};

type DurationChoice = "sampled" | "p50" | "p90" | "manual";
const DURATION_CHOICES: readonly { readonly id: DurationChoice; readonly label: string }[] = [
  { id: "sampled", label: "Sampled" },
  { id: "p50", label: "Median" },
  { id: "p90", label: "90th pct" },
  { id: "manual", label: "Manual" },
];

function variantFor(family: FamilyKey, vehicle: VehicleKind, cause: BreakdownCause, label: CollisionLabel): ScenarioVariant {
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
      return { family };
    default:
      return assertNever(family);
  }
}

function hasLane(family: FamilyKey): boolean {
  return family !== "breakdown_shoulder" && family !== "rain";
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

function EventRow({ event, owners, nowS, onRemove }: { event: ScenarioEvent; owners: Ownership; nowS: number; onRemove: () => void }) {
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
  const place = event.variant.family === "rain" ? "Corridor-wide" : event.lane === null ? "Shoulder" : `Lane ${event.lane}`;
  const where = `${place} · Km ${event.positionKm.toFixed(2)} · starts +${Number((event.startS / 60).toFixed(1))} min`;
  return (
    <div className={`sandbox-scn-event${invalid ? " is-invalid" : ""}`} data-scn-event={event.id}>
      <div className="sandbox-scn-event-head">
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

export default function ScenarioPanel(props: Props) {
  const { events, owners, road, direction, nowS, laneCount, fromKm, toKm, kmAtPct, manualClosure, nextSeq } = props;
  const [family, setFamily] = useState<FamilyKey>("breakdown_in_lane");
  const template: ScenarioTemplate = getTemplate(family);
  const [vehicle, setVehicle] = useState<VehicleKind>("truck");
  const [cause, setCause] = useState<BreakdownCause>("engine");
  const [label, setLabel] = useState<CollisionLabel>("rear_end");
  const [lane, setLane] = useState<number | null>(null);
  const [posKm, setPosKm] = useState<number | null>(null);
  const [startMin, setStartMin] = useState(1);
  const [choice, setChoice] = useState<DurationChoice>("sampled");
  const [manualMin, setManualMin] = useState(30);
  const [seed, setSeed] = useState(1);
  const [refusal, setRefusal] = useState<string | null>(null);

  const pickFamily = (f: FamilyKey) => {
    const t = getTemplate(f);
    setFamily(f);
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
      case "multi_vehicle_collision":
      case "self_accident":
      case "overturned_vehicle":
      case "flood":
      case "scheduled_roadworks":
      case "rain":
        break;
      default:
        assertNever(t);
    }
  };

  const laneNow = lane === null ? defaultOperatorLane(template, laneCount) : Math.min(Math.max(1, lane), laneCount);
  const kmNow = Math.min(toKm, Math.max(fromKm, posKm === null ? kmAtPct(template.defaultPlacement.pct) : posKm));
  const variant = variantFor(family, vehicle, cause, label);
  const duration: DurationMode =
    choice === "sampled" ? { kind: "sampled", seed } : choice === "p50" ? { kind: "p50" } : choice === "p90" ? { kind: "p90" } : { kind: "manual", minutes: manualMin };
  const spec: NewEventSpec = { variant, direction, lane: hasLane(family) ? laneNow : null, positionKm: kmNow, startMinutes: startMin, duration };

  // The same call "Add event" makes, so what is shown is what will be stored (and why not, if it will not).
  const verdict = addEvent(events, spec, road, nextSeq, manualClosure);
  let preview: ResolvedDuration | null = null;
  try {
    preview = resolveDuration(variant, duration);
  } catch {
    preview = null; // a manual duration that is not a positive number: the verdict says so
  }
  const previewPhases = preview === null ? [] : schedulePhases(variant, preview);

  const add = () => {
    const r = props.onAdd(spec);
    setRefusal(r.ok ? null : r.reason);
  };

  return (
    <div className="sandbox-scn" data-scn="panel">
      <span className="sandbox-mini-label">Add a real-incident scenario</span>
      <div className="sandbox-scn-families">
        {SCENARIO_TEMPLATES.map((t) => (
          <button key={t.family} className={`sandbox-scn-fam${family === t.family ? " active" : ""}`} data-scn-family={t.family} onClick={() => pickFamily(t.family)}>
            {t.displayName}
          </button>
        ))}
        {UNSUPPORTED_FAMILIES.map((u) => (
          <button key={u.id} className="sandbox-scn-fam" data-scn-family={u.id} disabled title={`${NOT_YET_BUILT}: ${u.needs}`}>
            {u.displayName}
            <small>{NOT_YET_BUILT}</small>
          </button>
        ))}
      </div>
      <p className="sandbox-scn-desc">{template.description}</p>

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
              {Array.from({ length: laneCount }, (_, i) => (
                <option key={i} value={i + 1}>Lane {i + 1}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          Start (min after warm-up)
          <NumberField value={startMin} min={0} max={1440} step={0.5} decimals={1} scn="start" onCommit={setStartMin} />
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

      {!verdict.ok && (
        <p className="sandbox-live-note warn" data-scn="refusal">
          {verdict.reason}
        </p>
      )}
      {refusal !== null && verdict.ok && <p className="sandbox-live-note warn">{refusal}</p>}
      <div className="sandbox-btn-row">
        <button className="btn-primary" data-scn="add" disabled={!verdict.ok} onClick={add} style={{ marginLeft: 0 }}>
          Add event
        </button>
      </div>

      {events.length > 0 && (
        <>
          <span className="sandbox-mini-label">Events · timed from the end of warm-up</span>
          {props.skip !== null ? (
            <SkipProgress skip={props.skip} onCancel={props.onCancelSkip} />
          ) : (
            <div className="sandbox-btn-row" style={{ marginTop: 0 }}>
              <button className="btn-muted" data-scn="skip" disabled={!props.canSkip} onClick={props.onSkip} title="Fast-forward without drawing to the next phase change of any event.">
                Skip to next phase
              </button>
            </div>
          )}
          {events.map((e) => (
            <EventRow key={e.id} event={e} owners={owners} nowS={nowS} onRemove={() => props.onRemove(e.id)} />
          ))}
        </>
      )}
    </div>
  );
}
