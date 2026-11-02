"use client";

import { useEffect, useState } from "react";
import { fmtInt } from "./incidentPredictive.shared";
import { Truck } from "lucide-react";
import { Shell, Empty, ActionCard, SourceBadge } from "./prescriptiveShell";
// km arrives MEASURED (exits and segment midpoints); shown as the official km post.
import { fmtKm, kmMeasured, KM_POST_END, KM_POST_START } from "../../lib/km-post";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Built directly on top of the Predictive tab's own "Predicted Incidents
// Ranking" numbers, not a separately-modeled hotspot table — this panel's
// whole point is to be a solution FOR that ranking, so it reads the exact
// same corridorForecast/kmSegmentForecast /api/incident/predictive already
// returns (and PredictiveCorridorChart already renders) rather than an
// independent per-exit prediction that could show a different top corridor
// than what the user already saw. Mirrors incidentPredictive.shared.ts's
// CorridorForecastPoint/KmSegmentForecastPoint shapes; kept in sync by hand.
type CorridorForecastPoint = { exitId: number; exitName: string; km: number; predictedIncidents: number };
type KmSegmentForecastPoint = { segmentStart: number; segmentEnd: number; label: string; predictedIncidents: number };
type PredictiveSlice = {
  corridorForecast: CorridorForecastPoint[] | null;
  kmSegmentForecast: KmSegmentForecastPoint[] | null;
  corridorForecastModel: string | null;
  corridorForecastDays: number;
  /** The champion's daily forecast for the Future days, oldest first, to sum over the validated window. */
  futureDaily: { date: string; predicted: number | null }[];
  /** The rolling-origin study: which forecast ranges beat the benchmark. */
  horizonAccuracy: { hLo: number; hHi: number; usable: boolean; mase: number | null }[];
};

/** An official km-post span, from measured ends: "Km 25–30". */
const kmSpan = (lo: number, hi: number) => (Math.abs(hi - lo) < 0.05 ? `Km ${fmtKm(lo)}` : `Km ${fmtKm(lo)}–${fmtKm(hi)}`);

/** km, lo and hi are MEASURED. An exit is a point (lo = hi = km); a segment spans lo to hi, km its middle. */
type Row = { key: string; label: string; km: number; lo: number; hi: number; predictedIncidents: number };
type Placed = Row & { order: number; cumShare: number };

/* The placement order (2 Nov 2026, "no assumptions"). It replaced a Maximal Covering solve whose answer depended on a
   fleet size and a coverage radius the operator had to make up: no NLEX patrol or tow fleet data exists, and no
   radius is measured. Now each forecast incident counts at its own exit (or km segment), as the Predictive tab's
   ranking already splits it, and units are placed busiest first: unit 1 where most forecast incidents are, unit 2 at
   the next, and so on. After each unit, `cumShare` is the share of all forecast incidents at the sites staffed so
   far, so the operator reads off their own fleet: "3 units -> 31%". Every number is the forecast's. */
function placementOrder(rows: Row[]): Placed[] {
  const total = rows.reduce((t, r) => t + r.predictedIncidents, 0);
  let run = 0;
  return rows
    .slice()
    .sort((a, b) => b.predictedIncidents - a.predictedIncidents)
    .map((r, i) => {
      run += r.predictedIncidents;
      return { ...r, order: i + 1, cumShare: total > 0 ? run / total : 0 };
    });
}

/* The plan on one line of road: the corridor from the first to the last km post, a bar at each exit or segment for
   its forecast incidents, and the first `marked` places as numbered markers. Positions are MEASURED km; the ticks are
   labelled with the official posts. */
function CorridorStrip({ rows, placed, marked }: { rows: Row[]; placed: Placed[]; marked: number }) {
  const W = 1000;
  const H = 128;
  const padX = 18;
  const base = 92;
  const lo = Math.min(kmMeasured(KM_POST_START), ...rows.map((r) => r.lo));
  const hi = Math.max(kmMeasured(KM_POST_END), ...rows.map((r) => r.hi));
  const x = (km: number) => padX + ((km - lo) / Math.max(hi - lo, 1)) * (W - 2 * padX);
  const top = Math.max(1, ...rows.map((r) => r.predictedIncidents));
  const ticks: number[] = [];
  for (let post = Math.ceil(KM_POST_START / 10) * 10; post <= KM_POST_END; post += 10) ticks.push(kmMeasured(post));
  const first = placed.slice(0, marked);
  const firstKeys = new Set(first.map((p) => p.key));
  // Left to right, so neighbouring labels alternate rows instead of overlapping.
  const byKm = first.slice().sort((a, b) => a.km - b.km);
  return (
    <figure className="inc-strip">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Placement order: ${first.map((p) => `${p.order}. ${p.label}`).join(", ")}`}>
        <line className="inc-strip-road" x1={x(lo)} x2={x(hi)} y1={base} y2={base} />
        {rows.map((r) => {
          const h = Math.max(2, (r.predictedIncidents / top) * 50);
          const w = r.hi - r.lo > 0.05 ? Math.max(3, x(r.hi) - x(r.lo) - 1) : 4;
          return (
            <rect key={r.key} className={`inc-strip-bar${firstKeys.has(r.key) ? " is-staffed" : ""}`} x={r.hi - r.lo > 0.05 ? x(r.lo) : x(r.km) - 2} y={base - h} width={w} height={h}>
              <title>{`${r.label} · ${kmSpan(r.lo, r.hi)} · ${Math.round(r.predictedIncidents).toLocaleString()} forecast incidents`}</title>
            </rect>
          );
        })}
        {byKm.map((p, i) => (
          <g key={`unit-${p.key}`} className="inc-strip-unit">
            <circle cx={x(p.km)} cy={base} r={9} />
            <text className="inc-strip-order" x={x(p.km)} y={base + 4} textAnchor="middle">{p.order}</text>
            <text x={x(p.km)} y={i % 2 === 0 ? 12 : 30} textAnchor="middle">{p.label}</text>
          </g>
        ))}
        {ticks.map((t) => (
          <g key={`t-${t}`} className="inc-strip-tick">
            <line x1={x(t)} x2={x(t)} y1={base + 4} y2={base + 9} />
            <text x={x(t)} y={base + 24} textAnchor="middle">Km {fmtKm(t, 0)}</text>
          </g>
        ))}
      </svg>
      <figcaption className="inc-strip-key">
        <span><i className="is-unit" aria-hidden="true" />Placement order (first {marked})</span>
        <span><i className="is-bar" aria-hidden="true" />Forecast incidents</span>
      </figcaption>
    </figure>
  );
}

type Props = {
  // The Prescriptive tab's own Range control, threaded through the same way
  // PredictiveIncidentChart takes it — corridorForecast's apportionment
  // shares are computed from incidents within this window (verified: the
  // per-exit split shifts a few points between 3mo/12mo/all, even though the
  // published total forecast itself doesn't), so the placement order can move
  // with Range. Defaults to 12mo, this panel's original fixed window, when unset.
  months?: "3" | "12" | "all";
  from?: string;
  to?: string;
};

export default function PrescriptiveDeploymentPanel({ months = "12", from, to }: Props) {
  const [view, setView] = useState<"exit" | "km">("exit");
  const [predictive, setPredictive] = useState<PredictiveSlice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Cleared here, not just on success -- otherwise a retry after a control
    // change renders as a stale-refresh warning (the PREVIOUS attempt's
    // error) while it's still in flight, instead of "Updating…".
    setError(null);
    const qs = new URLSearchParams();
    if (months) qs.set("months", months);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    fetch(`${BACKEND}/api/incident/predictive?${qs}`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setPredictive({
          corridorForecast: json.data.corridorForecast,
          kmSegmentForecast: json.data.kmSegmentForecast,
          corridorForecastModel: json.data.corridorForecastModel,
          corridorForecastDays: json.data.corridorForecastDays,
          futureDaily: (json.data.daily ?? [])
            .filter((d: { predictionType?: string | null }) => d.predictionType === "future")
            .map((d: { date: string; predicted: number | null }) => ({ date: d.date, predicted: d.predicted }))
            .sort((a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date)),
          horizonAccuracy: json.data.horizonAccuracy ?? [],
        });
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load the predicted-incidents ranking");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [months, from, to]);

  const hint =
    "Where to place patrol and tow-truck units, in order: the first unit where the incident forecast expects the most incidents, the next at the second, and so on. Each line gives the share of all forecast incidents covered by the units placed so far, so you read off your own fleet size. Incidents count at their own exit (or km segment), split by each one's share of past incidents in the Range; the total is the forecast over the days where it beats repeating last week.";

  if (loading && predictive === null) {
    return (
      <Shell title="Resource Staging & Patrol Repositioning" hint={hint}>
        <Empty msg="Loading patrol deployment…" />
      </Shell>
    );
  }

  /* The forecast window that passes its accuracy test. The counts used to be the whole 90-day forecast, most of which
     loses to the benchmark (gold horizon study: days 15-90 fail). The first run of horizon buckets that pass is used
     instead; each exit keeps its share and the total becomes the forecast's sum over those days, so the rescaling is
     exact. With no passing bucket the full horizon stays, labelled as beyond the validated range. */
  const buckets = (predictive?.horizonAccuracy ?? []).slice().sort((a, b) => a.hLo - b.hLo);
  const firstOk = buckets.findIndex((b) => b.usable);
  let win: { lo: number; hi: number; mase: number | null } | null = null;
  if (firstOk >= 0) {
    let hi = buckets[firstOk].hHi;
    for (let i = firstOk + 1; i < buckets.length && buckets[i].usable && buckets[i].hLo === hi + 1; i++) hi = buckets[i].hHi;
    win = { lo: buckets[firstOk].hLo, hi, mase: buckets[firstOk].mase };
  }
  const future = predictive?.futureDaily ?? [];
  const sumDays = (lo: number, hi: number) => future.slice(lo - 1, hi).reduce((t, d) => t + (d.predicted ?? 0), 0);
  const allFuture = sumDays(1, future.length);
  const scale = win && allFuture > 0 && future.length >= win.hi ? sumDays(win.lo, win.hi) / allFuture : 1;
  const validated = win != null && scale !== 1;
  const winLabel = validated ? `days ${win!.lo}–${win!.hi} ahead` : `the ${predictive?.corridorForecastDays ?? future.length}-day forecast`;

  const useKmView = view === "km" && predictive?.kmSegmentForecast != null && predictive.kmSegmentForecast.length > 0;
  const exitRows: Row[] = (predictive?.corridorForecast ?? []).map((x) => ({
    key: `exit-${x.exitId}`, label: x.exitName, km: x.km, lo: x.km, hi: x.km, predictedIncidents: x.predictedIncidents * scale,
  }));
  const kmRows: Row[] = (predictive?.kmSegmentForecast ?? []).map((x) => ({
    key: `seg-${x.segmentStart}`, label: x.label, km: (x.segmentStart + x.segmentEnd) / 2, lo: x.segmentStart, hi: x.segmentEnd,
    predictedIncidents: x.predictedIncidents * scale,
  }));
  const rows: Row[] = useKmView ? kmRows : exitRows;

  // Only reachable with no successful load yet -- predictive === null -- or a
  // genuinely empty ranking, so there is nothing stale to fall back to; a
  // later refresh failure with data already loaded is handled below instead
  // of wiping the panel.
  if (!predictive || rows.length === 0) {
    return (
      <Shell title="Resource Staging & Patrol Repositioning" hint={hint}>
        <Empty kind={error ? "error" : "nodata"} msg={`Patrol deployment unavailable: ${error ?? "no Predicted Incidents Ranking data — check the Predictive tab's corridor card."}`} />
      </Shell>
    );
  }

  const placed = placementOrder(rows);
  const total = rows.reduce((t, r) => t + r.predictedIncidents, 0);
  const at = (n: number) => placed[Math.min(n, placed.length) - 1];
  // Milestones for the headline: how many units reach a quarter, half and three quarters of the forecast incidents.
  const unitsFor = (share: number) => (placed.find((p) => p.cumShare >= share - 1e-9)?.order ?? placed.length);
  const TOP_ROWS = 5;
  const visible = showAll ? placed : placed.slice(0, TOP_ROWS);
  const unitWord = useKmView ? "segment" : "exit";
  const modelName = predictive.corridorForecastModel ? `${predictive.corridorForecastModel} ` : "";

  return (
    <Shell
      title="Resource Staging & Patrol Repositioning"
      hint={hint}
      updating={loading && !error}
      right={
        <div className="inc-controls">
          <div className="inc-seg" role="group" aria-label="Group by">
            {(["exit", "km"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                disabled={v === "km" && (predictive.kmSegmentForecast == null || predictive.kmSegmentForecast.length === 0)}
                aria-pressed={view === v}
                className={view === v ? "is-on" : ""}
              >
                {v === "exit" ? "By Exit" : "By Km"}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {error && (
        <div role="alert" style={{ fontSize: "0.78rem", color: "var(--color-warning)" }}>
          Couldn&apos;t refresh with the current Range ({error}) — showing the last loaded result.
        </div>
      )}

      <ActionCard
        lead
        icon={Truck}
        title={`Place units in this order: ${placed.slice(0, 3).map((p) => p.label).join(", ")}${placed.length > 3 ? "…" : ""}`}
        tag={<SourceBadge kind="forecast" detail={`The ${modelName}incident forecast for ${winLabel}, split by each ${unitWord}'s share of past incidents`} />}
        facts={[
          {
            label: "Effect",
            value: (
              <>
                3 units: <b>{(at(3).cumShare * 100).toFixed(0)}%</b> · 5 units: <b>{(at(5).cumShare * 100).toFixed(0)}%</b> of {fmtInt(total)} forecast incidents
              </>
            ),
          },
          { label: "Half of them", value: <>needs <b>{unitsFor(0.5)}</b> {unitWord}s staffed</> },
          {
            label: "When",
            value: validated
              ? <>Days {win!.lo}–{win!.hi} ahead, where the forecast beats repeating last week{win!.mase != null ? ` (MASE ${win!.mase.toFixed(2)})` : ""}</>
              : <>The full forecast: no stretch of it beats repeating last week</>,
          },
        ]}
        details={
          <p style={{ margin: 0 }}>
            Incidents count at their own {unitWord}: the {modelName}forecast for {winLabel}, split by each {unitWord}&apos;s share of
            incidents in the Range. Units go busiest first, and each line&apos;s cumulative share is the forecast incidents at the{" "}
            {unitWord}s staffed so far. Nothing here is set by hand: no fleet size or coverage distance is assumed, so the
            order holds for any fleet.
          </p>
        }
      />

      <CorridorStrip rows={rows} placed={placed} marked={Math.min(5, placed.length)} />

      <div className="inc-table-wrap">
        <table className="inc-table inc-place">
          <thead>
            <tr>
              <th>Unit</th>
              <th>{useKmView ? "Segment" : "Exit"}</th>
              <th>Km post</th>
              <th>Forecast incidents</th>
              <th>Covered with units 1–n</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.key} className={p.order <= 3 ? "is-staffed" : undefined}>
                <td className="inc-place-order">{p.order}</td>
                <td style={{ whiteSpace: "nowrap" }}>{p.label}</td>
                {/* Official km post (lib/km-post.ts). */}
                <td className="is-muted" style={{ whiteSpace: "nowrap" }}>{kmSpan(p.lo, p.hi).replace("Km ", "")}</td>
                <td style={{ fontWeight: 600 }}>{fmtInt(p.predictedIncidents)}</td>
                <td>
                  <span className="inc-place-cum">
                    <span className="inc-place-bar" aria-hidden="true"><i style={{ width: `${(p.cumShare * 100).toFixed(1)}%` }} /></span>
                    <b>{(p.cumShare * 100).toFixed(0)}%</b>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {placed.length > TOP_ROWS && (
        <button onClick={() => setShowAll((v) => !v)} className="inc-ghost-btn" aria-expanded={showAll}>
          {showAll ? `Show the first ${TOP_ROWS}` : `Show all ${placed.length} ${useKmView ? "segments" : "exits"}`}
        </button>
      )}
    </Shell>
  );
}
