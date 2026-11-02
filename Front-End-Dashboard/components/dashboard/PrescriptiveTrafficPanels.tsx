"use client";

/* The Traffic Prescriptive tab: three panels, one per row of the analytics
 * diagram, each acting on the Predictive tab's own forecast.
 *
 * They live in one file because they share a single cached fetch and a single
 * decision-logic module; splitting them would triple the boilerplate without
 * separating anything that is actually independent.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import SignalGlyph from "./SignalGlyph";
import { fmtKm } from "../../lib/km-post";
import InfoTooltip from "./InfoTooltip";
import StateNote from "../stage/StateNote";
import { SourceBadge, ForecastAge } from "./prescriptiveShell";
import {
  loadForecast, loadPrescriptive, rankByLowerBound, exitsFromEvents, exitsFromUpcoming,
  type ForecastPayload, type TrafficPrescriptive, type StaffingHour, type StaffingLevel, type RankedExit,
} from "./prescriptiveTraffic.shared";

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);
const shortDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/* True once a load has taken longer than a few seconds, so the panel can say why it is waiting. */
function useSlow(waiting: boolean, afterMs = 6000) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const t = window.setTimeout(() => setSlow(true), afterMs);
    return () => window.clearTimeout(t);
  }, [waiting, afterMs]);
  return slow;
}

/* What the event ranking's "how sure" rests on (2 Nov 2026). The Firm / Fair / Loose words it replaced cut the
   interval width at 0.05 and 0.12, which were set by hand; the interval itself is shown instead. */
const ESTIMATE_HINT =
  "Uplift is the median ratio of the exit's entries on past Philippine Arena event days to a normal day (the median of " +
  "days with no event and no holiday, on the same weekday and month). Its 95% interval comes from resampling those event " +
  "days (a bootstrap). The ranking uses the interval's lower end: the rise the past event days support even at their weakest.";

function useForecast() {
  const [data, setData] = useState<ForecastPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    loadForecast()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => { alive = false; };
  }, [attempt]);
  const slow = useSlow(!data && !error);
  return { data, error, slow, retry: () => setAttempt((n) => n + 1) };
}

/* Night Corridor chrome for the three panels: a near-opaque card with a
   hairline, a 20 px headline with its method behind (i), and the panel's
   own controls on the same line. */
function Shell({ title, hint, children, right, meta }: {
  title: string; hint: string; right?: React.ReactNode; children: React.ReactNode;
  /** Where the card's advice comes from (SourceBadge) and how fresh it is (ForecastAge), under the title. */
  meta?: React.ReactNode;
}) {
  return (
    <article className="chart-card wide nct-card">
      <div className="nct-card-head-split">
        <div className="nct-head-text">
          <h3 className="nct-title">
            {title} <InfoTooltip text={hint} />
          </h3>
          {meta && <div className="rx-head-meta">{meta}</div>}
        </div>
        {right}
      </div>
      {children}
    </article>
  );
}

const Banner = ({ tone = "info", children }: { tone?: "info" | "alert"; children: React.ReactNode }) => (
  <div className={`nct-banner${tone === "alert" ? " is-alert" : ""}`}>
    {tone === "alert" && <AlertTriangle size={18} strokeWidth={2} aria-hidden="true" className="nct-banner-icon" />}
    <div className="nct-banner-text">{children}</div>
  </div>
);

/* Empty, loading and error states keep their words; the mascot only
   decorates them (headlights dimmed for "no data", hazards for errors). */
const Empty = ({ msg, slow, onRetry }: { msg: string; slow?: boolean; onRetry?: () => void }) => {
  const kind = /unavailable/i.test(msg) ? "error" : /…$/.test(msg) ? "loading" : "nodata";
  return (
    <article className="chart-card wide nct-card nct-empty-card">
      <StateNote kind={kind} role={kind === "error" ? "alert" : undefined}>
        {msg}
        {slow && kind === "loading" && (
          <span className="nct-empty-note">Still working: the first load after the server starts can take up to a minute.</span>
        )}
        {onRetry && kind === "error" && (
          <button type="button" className="btn-muted nct-empty-retry" onClick={onRetry}>Try again</button>
        )}
      </StateNote>
    </article>
  );
};

const Foot = ({ children }: { children: React.ReactNode }) => (
  <p className="nct-foot">{children}</p>
);

/** One recommended action: what to do, where, when, the expected effect and
 *  its basis, and how sure. Fields the data does not carry are left out
 *  rather than filled in; the basis and reasoning sit behind Details. */
function ActionCard({ rank, signal, tag, tone = "info", action, lead, facts, details }: {
  rank?: number;
  signal?: "clear" | "slow" | "congested" | "none";
  tag?: ReactNode;
  tone?: "info" | "act" | "prepare" | "alert";
  action: ReactNode;
  lead?: ReactNode;
  facts: { k: string; v: ReactNode }[];
  details?: ReactNode;
}) {
  return (
    <div className={`nct-action is-${tone}`}>
      {rank != null && <span className="nct-action-rank" aria-label={`Rank ${rank}`}>{rank}</span>}
      <div className="nct-action-main">
        {(signal || tag) && (
          <div className="nct-action-tag">
            {signal && <SignalGlyph state={signal} size={20} title="" />}
            {tag}
          </div>
        )}
        <p className="nct-action-title">{action}</p>
        {lead && <p className="nct-action-lead">{lead}</p>}
        {facts.length > 0 && (
          <dl className="nct-action-facts">
            {facts.map((f) => (
              <div key={f.k}>
                <dt>{f.k}</dt>
                <dd>{f.v}</dd>
              </div>
            ))}
          </dl>
        )}
        {details && (
          <details className="nc-details nct-action-details">
            <summary>Details</summary>
            <div>{details}</div>
          </details>
        )}
      </div>
    </div>
  );
}

/* ==================================================================== 1 ====
 * Staffing priority by forecast demand (2 Nov 2026).
 *
 * Replaced the Booth Staffing Plan, which planned booths from OpenStreetMap
 * booth counts and a booth-throughput slider: neither is measured anywhere in
 * the warehouse. This compares each plaza-hour's forecast with that plaza's
 * own usual level for the hour and day type, and says how sure it is from the
 * forecast chain's measured held-out error (traffic-prescriptive.service.ts).
 */

function usePrescriptive() {
  const [data, setData] = useState<TrafficPrescriptive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let off = false;
    setData(null);
    setError(null);
    loadPrescriptive()
      .then((d) => { if (!off) setData(d); })
      .catch((e) => { if (!off) setError(e instanceof Error ? e.message : String(e)); });
    return () => { off = true; };
  }, [attempt]);
  const slow = useSlow(!data && !error);
  return { data, error, slow, retry: () => setAttempt((n) => n + 1) };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** "93%" -- or "99% or more" / "1% or less", the resolution the measured quantiles carry. */
const chanceText = (c: number) => (c >= 0.99 ? "99% or more" : c <= 0.01 ? "1% or less" : pct(c));
const LEVEL_WORD: Record<StaffingLevel, string> = { above: "Near-certain", likely: "Likely", normal: "Normal" };

/** One plaza's day as 24 cells, shaded by the forecast against its usual level for that hour (load), with the
 *  hours likely or near-certain to pass its usual peak marked. */
function HourHeat({ hours, peakHour }: { hours: StaffingHour[]; peakHour: number }) {
  return (
    <div className="nct-heat" role="img" aria-label={`Forecast against the usual level by hour; busiest at ${fmtHour(peakHour)}`}>
      {hours.map((h) => (
        <span
          key={h.hour}
          className={`nct-heat-cell${h.level === "likely" ? " is-tight" : ""}${h.level === "above" ? " is-over" : ""}${h.hour === peakHour ? " is-peak" : ""}`}
          style={{ ["--lvl" as string]: Math.max(0, Math.min(1, ((h.load ?? 0) - 0.6) / 0.6)).toFixed(3) }}
          title={
            `${fmtHour(h.hour)}: ${fmtInt(h.forecast)} vehicles forecast` +
            (h.low != null && h.high != null ? ` (80% band ${fmtInt(h.low)}–${fmtInt(h.high)})` : "") +
            (h.usual != null ? `; usual ${fmtInt(h.usual)}` : "") +
            (h.usualPeak != null ? `, usual peak ${fmtInt(h.usualPeak)}` : "") +
            (h.chance != null ? `; ${chanceText(h.chance)} chance of passing the usual peak` : "; not rated (under the measured range)")
          }
        />
      ))}
    </div>
  );
}

const listOf = (xs: string[]) =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

export function BoothStaffingPanel() {
  const [view, setView] = useState<"week" | "hour">("week");
  const [showAll, setShowAll] = useState(false);
  const { data, error, slow, retry } = usePrescriptive();

  if (error) return <Empty msg={`Prescriptive traffic unavailable: ${error}`} onRetry={retry} />;
  if (!data) return <Empty msg="Comparing the forecast with each plaza's usual level…" slow={slow} />;
  if (data.week.length === 0 || !data.shiftPlan) return <Empty msg="No future days in the volume forecast." />;
  if (data.shiftPlan.plazas.length === 0) return <Empty msg="No plaza volumes are recorded to apportion the forecast with." />;

  const days = data.week;
  const plan = data.shiftPlan;
  const b = data.basis;
  const lead = data.priorities[0] ?? null;
  const more = data.priorities.slice(1, 6);
  const above = days.reduce((s, d) => s + d.aboveCells, 0);
  const likely = days.reduce((s, d) => s + d.likelyCells, 0);

  // Week table: each plaza-day's hour most likely to pass its usual peak; plazas in order of their week's highest chance.
  const byDay = days.map((d) => new Map(d.plazas.map((p) => [p.plaza, p] as const)));
  const rows = plan.plazas
    .map((p) => {
      const each = byDay.map((m) => m.get(p.plaza) ?? null);
      const best = Math.max(-1, ...each.map((x) => x?.top?.chance ?? -1));
      return { plaza: p.plaza, sharePct: p.sharePct, each, best };
    })
    .sort((x, y) => y.best - x.best);
  const visible = showAll ? rows : rows.slice(0, 8);
  // Without priorities: the closest any plaza-hour comes, so "normal" says how close.
  const closest = lead ?? days
    .flatMap((d) => d.plazas.map((p) => (p.top ? { ...p.top, date: d.date, dayType: d.dayType, plaza: p.plaza } : null)))
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((x, y) => (y.chance ?? -1) - (x.chance ?? -1))[0] ?? null;
  const past = b.forecastFrom && b.usualTo && b.forecastFrom <= b.usualTo;

  const Toggle = (
    <div className="nct-pills" role="group" aria-label="Plan view">
      {(["week", "hour"] as const).map((v) => (
        <button
          key={v}
          onClick={() => setView(v)}
          aria-pressed={view === v}
          className={`nct-pill-btn${view === v ? " is-on" : ""}`}
        >
          {v === "week" ? "Week ahead" : "Hour by hour"}
        </button>
      ))}
    </div>
  );

  return (
    <Shell
      title="Staffing Priority"
      hint={`Each plaza-hour's forecast against that plaza's own usual level for the same hour and day type (median of the latest 12 months; usual peak = its ${b.usualPeakPercentile}th percentile, passed on 1 comparable day in 10). Staff above normal where the forecast is likely to pass the usual peak. How sure comes from the forecast's measured error on held-out days.`}
      meta={<SourceBadge kind="forecast" detail={`${data.champion.model ?? "Champion"} volume forecast against each plaza's measured usual level`} />}
      right={<div className="nct-panel-controls">{Toggle}</div>}
    >
      <ActionCard
        rank={1}
        tone={lead?.level === "above" ? "alert" : lead ? "prepare" : "info"}
        tag={
          <span className="nct-action-kicker">
            {lead ? <>{LEVEL_WORD[lead.level]} · {chanceText(lead.chance ?? 0)}</> : "Staffing priority"}
          </span>
        }
        action={
          lead ? (
            <>Staff {lead.plaza} above normal on {shortDay(lead.date)} at {fmtHour(lead.hour)}</>
          ) : (
            <>Normal staffing at every plaza, {shortDay(days[0].date)} to {shortDay(days[days.length - 1].date)}</>
          )
        }
        facts={[
          ...(closest
            ? [
                ...(lead ? [] : [{ k: "Closest", v: <><b>{closest.plaza}</b>, {shortDay(closest.date)} at {fmtHour(closest.hour)}</> }]),
                {
                  k: "Forecast",
                  v: <><b>{fmtInt(closest.forecast)} vehicles</b>{closest.low != null && closest.high != null && <span className="nct-dim"> (80% band {fmtInt(closest.low)}–{fmtInt(closest.high)})</span>}</>,
                },
                {
                  k: "Usual",
                  v: <>{closest.usual != null ? fmtInt(closest.usual) : "—"} on a usual {closest.dayType}{closest.usualPeak != null && <> · usual peak {fmtInt(closest.usualPeak)} (passed 1 day in 10)</>}</>,
                },
                {
                  k: "How sure",
                  v: closest.chance != null
                    ? <><b>{chanceText(closest.chance)}</b> chance of passing the usual peak</>
                    : <>Not rated</>,
                },
              ]
            : []),
          {
            k: "This week",
            v: <>{above} plaza-hour{above === 1 ? "" : "s"} near-certain, {likely} likely to pass the usual peak</>,
          },
        ]}
      />

      {more.length > 0 && (
        <div className="nct-inline-list nct-rx-list">
          <p className="nct-kv-k">Also above normal</p>
          <ul>
            {more.map((p) => (
              <li key={`${p.date}|${p.plaza}|${p.hour}`}>
                <b className={p.level === "above" ? "nct-bad" : "nct-warn"}>{chanceText(p.chance ?? 0)}</b>
                <span className="nct-inline-seg">{p.plaza}</span>
                <span className="nct-dim">{shortDay(p.date)}, {fmtHour(p.hour)}</span>
                <span className="nct-dim">{fmtInt(p.forecast)} vs peak {p.usualPeak != null ? fmtInt(p.usualPeak) : "—"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {view === "hour" ? (
        <>
          <div className="nct-panel-intro nct-hour-head">
            <span>
              Forecast against the usual level, hour by hour, on <b>{shortDay(plan.date)}</b> ({plan.dayType})
              <InfoTooltip text="Darker = busier than usual for that hour. Amber: likely to pass the usual peak. Hatched: near-certain (even the band's low end passes it). Hover a cell for the numbers." />
            </span>
            <span className="nct-key">
              <span className="nct-key-item"><i className="nct-heat-swatch" style={{ ["--lvl" as string]: "0.25" }} />Below usual</span>
              <span className="nct-key-item"><i className="nct-heat-swatch" style={{ ["--lvl" as string]: "0.85" }} />Above usual</span>
              <span className="nct-key-item"><i className="nct-heat-swatch is-tight" />Likely past peak</span>
              <span className="nct-key-item"><i className="nct-hatch" />Near-certain</span>
            </span>
          </div>
          <div className="nct-hour-rows">
            <div className="nct-hour-row nct-heat-axis" aria-hidden="true">
              <div />
              <div className="nct-heat">
                {Array.from({ length: 24 }, (_, h) => (
                  <span key={h} className="nct-heat-tick">{h % 6 === 0 ? fmtHour(h).replace(" ", "") : ""}</span>
                ))}
              </div>
              <div />
            </div>
            {(showAll ? plan.plazas : plan.plazas.slice(0, 8)).map((p) => (
              <div key={p.plaza} className="nct-hour-row">
                <div className="nct-hour-name">
                  {p.plaza}
                  <span>{p.sharePct}% of corridor</span>
                </div>
                <HourHeat hours={p.hours} peakHour={p.peakHour} />
                <div className="nct-hour-peak">
                  {p.top?.load != null ? <><b>{pct(p.top.load)}</b> of usual</> : "—"}
                  {p.top && <> at {fmtHour(p.top.hour)}</>}
                  {p.top?.chance != null && <span className="nct-hour-queue">{chanceText(p.top.chance)} past peak</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="nct-table-wrap">
          <p className="nct-table-key">
            Each day: the plaza&apos;s hour most likely to pass its usual peak, as % of its usual level.{" "}
            <b className="nct-warn">▲</b> likely, <b className="nct-bad">!</b> near-certain.
          </p>
          <table className="nct-table nct-booth-table">
            <thead>
              <tr>
                <th>Plaza</th>
                {days.map((d) => (
                  <th key={d.date} className="num">
                    {new Date(`${d.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "short" })}
                    <span className="nct-th-sub">
                      {new Date(`${d.date}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.plaza}>
                  <td className="strong" style={{ whiteSpace: "nowrap" }}>{r.plaza}</td>
                  {r.each.map((p, i) => {
                    const t = p?.top ?? null;
                    return (
                      <td key={days[i].date}
                        title={t
                          ? `${fmtHour(t.hour)}: ${fmtInt(t.forecast)} vehicles forecast` +
                            (t.low != null && t.high != null ? ` (80% band ${fmtInt(t.low)}–${fmtInt(t.high)})` : "") +
                            `; usual ${t.usual != null ? fmtInt(t.usual) : "—"}, usual peak ${t.usualPeak != null ? fmtInt(t.usualPeak) : "—"}` +
                            (t.chance != null ? `; ${chanceText(t.chance)} chance of passing it` : "")
                          : "Not rated"}
                        style={t?.load != null ? { ["--used" as string]: Math.max(0, Math.min(1, (t.load - 0.6) / 0.6)).toFixed(3) } : undefined}
                        className={`num nct-used${t?.level === "likely" ? " is-tight" : ""}${t?.level === "above" ? " is-over strong nct-bad" : ""}`}>
                        {t?.load != null ? pct(t.load) : "—"}
                        {t && <span className="nct-cell-delta">{fmtHour(t.hour)}</span>}
                        {t?.level === "above" ? <b className="nct-bad nct-cell-flag">!</b> : t?.level === "likely" ? <b className="nct-warn nct-cell-flag" aria-label="Likely to pass the usual peak">▲</b> : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 8 && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="btn-muted" style={{ alignSelf: "flex-start" }}>
          {showAll ? "Show the first 8" : `Show all ${rows.length} plazas`}
        </button>
      )}

      {!data.champion.accepted && (
        <Banner tone="alert">
          <b>No volume model passed its acceptance gate:</b> the forecast is last week repeated, and the band is that method&apos;s own measured error.
        </Banner>
      )}
      {past && (
        <Banner tone="alert">
          <b>Its first day, {b.forecastFrom}, is already inside the record, which now runs to {b.usualTo}:</b>{" "}
          this plan is for days already past. Retrain the volume models to plan the coming week.
        </Banner>
      )}
      <details className="nc-details">
        <summary>How this is measured</summary>
        <div>
          <Foot>
            Forecast: the {data.champion.model ?? "champion"} corridor forecast (WMAPE {data.champion.wmapePct ?? "—"}% per day) times each
            plaza&apos;s share and hourly profile, weekday and weekend apart, over {b.usualFrom} to {b.usualTo}. Usual: the plaza&apos;s
            median for that hour and day type over the same 12 months ({b.usualWeekdays} weekdays, {b.usualWeekends} weekend days); usual
            peak: its {b.usualPeakPercentile}th percentile.{" "}
            {b.band ? (
              <>
                How sure: this whole chain replayed on the model&apos;s {b.band.days} held-out days ({b.band.from} to {b.band.to}),
                {" "}{fmtInt(b.band.cells)} plaza-hours, missed by {b.band.wmapePct}% per plaza-hour. The 80% band and each chance are that
                plaza&apos;s measured spread of actual ÷ forecast. Near-certain = 90% or more (the band&apos;s low end passes the usual peak);
                likely = 50% or more. Hours under {b.minCellVehicles} vehicles were not in the replay, so they are not rated.
              </>
            ) : (
              <>No held-out error could be measured, so no hour is rated.</>
            )}
            {data.plazasWithoutBand.length > 0 && <> {listOf(data.plazasWithoutBand)}: too few held-out hours to rate.</>}
          </Foot>
        </div>
      </details>
    </Shell>
  );
}

/* ==================================================================== 2 ====
 * Congestion response advisory.
 */

/** A segment's chance of High congestion for the next 12 forecast hours, one bar each, with the calibrated Act
 *  line marked: when it builds and how long it stays (2 Nov 2026). */
function HighTimeline({ hours, cut, compact = false }: { hours: { h: number; pHigh: number }[]; cut: number | null; compact?: boolean }) {
  if (hours.length === 0) return null;
  const peak = hours.reduce((a, b) => (b.pHigh > a.pHigh ? b : a));
  return (
    <span className={`nct-tl${compact ? " is-compact" : ""}`} role="img"
      aria-label={`Chance of High congestion over the next 12 hours; highest ${Math.round(peak.pHigh * 100)}% at +${peak.h}h`}>
      <span className="nct-tl-bars">
        {Array.from({ length: 12 }, (_, i) => {
          const pt = hours.find((x) => x.h === i + 1);
          const v = pt?.pHigh ?? 0;
          return (
            <span key={i}
              className={`nct-tl-bar${cut != null && v >= cut ? " is-high" : ""}`}
              style={{ height: `${Math.max(6, v * 100)}%` }}
              title={pt ? `+${i + 1}h: ${Math.round(v * 100)}% chance of High` : `+${i + 1}h: no forecast`} />
          );
        })}
        {cut != null && <span className="nct-tl-half" style={{ bottom: `${cut * 100}%` }} aria-hidden="true" />}
      </span>
      {!compact && <span className="nct-tl-axis" aria-hidden="true"><span>+1h</span><span>+12h</span></span>}
    </span>
  );
}
const CONGESTION_AUTO_RETRIES = 6;
const CONGESTION_RETRY_MS = 15_000;
export function CongestionResponsePanel() {
  const [showMonitor, setShowMonitor] = useState(false);
  const [copied, setCopied] = useState(false);
  const { data, error, slow, retry } = usePrescriptive();

  const rows = useMemo(() => data?.congestion ?? [], [data]);

  /* No segments is not an answer to sit on (TR-12, 19 Oct 2026). It means the forecast read failed
     while the server was starting, or the hourly model was rewriting its table; both clear within a
     minute or two, so the panel asks again on its own, and after that offers the button. */
  const noRows = !!data && rows.length === 0;
  const [autoTries, setAutoTries] = useState(0);
  useEffect(() => {
    if (!noRows || autoTries >= CONGESTION_AUTO_RETRIES) return;
    const t = window.setTimeout(() => { setAutoTries((n) => n + 1); retry(); }, CONGESTION_RETRY_MS);
    return () => window.clearTimeout(t);
    // retry is a fresh closure each render; noRows and autoTries are what decide a new attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noRows, autoTries]);

  if (error) return <Empty msg={`Prescriptive traffic unavailable: ${error}`} onRetry={retry} />;
  if (!data) return <Empty msg="Ranking segments…" slow={slow} />;
  if (rows.length === 0) {
    const why = data.congestionUnavailable
      ? "The congestion forecast could not be read yet. The server may still be starting up."
      : "The congestion forecast came back empty. The hourly model may be rewriting it.";
    return autoTries < CONGESTION_AUTO_RETRIES
      ? <Empty msg={`${why} Trying again in ${CONGESTION_RETRY_MS / 1000} seconds…`} />
      : <Empty msg={`Congestion forecast unavailable. ${why}`} onRetry={() => { setAutoTries(0); retry(); }} />;
  }

  const cal = data.congestionCalibration;
  const calibrated = !!cal?.ok && cal.threshold != null;
  const cut = calibrated ? cal!.threshold : null;
  const act = rows.filter((r) => r.label === "Act");
  const monitor = rows.filter((r) => r.label === "Monitor");
  // The cards: the Act segments most likely to turn High, or with none at Act the three closest to the line.
  const cards = (act.length ? act : rows).slice(0, 3);
  const inline = act.slice(3);
  const timelineOf = (segment: string) => data.congestionTimeline?.find((t) => t.segment === segment)?.hours ?? [];
  // A segment with no forecast rows is not a quiet segment. It is named, and "corridor clear" is not said while any is missing.
  const missing = data.congestionMissing ?? [];
  const lead = act.length ? Math.min(...act.map((r) => r.firstAct ?? 99)) : null;

  // Manila wall-clock text ("2026-10-19 14:00"), split rather than parsed so no browser zone shifts it.
  const [baseD, baseT] = (data.congestionBaseTs ?? "").split(" ");
  const baseH = baseT ? Number(baseT.slice(0, 2)) : NaN;
  const baseHour = baseD && Number.isFinite(baseH) ? `${fmtHour(baseH)} ${shortDay(baseD)}` : null;
  const baseMs = baseD && baseT ? new Date(`${baseD}T${baseT}:00+08:00`).getTime() : NaN;
  // The hourly job can lag (it runs every 3-7 h in the cloud), so past six hours the age is flagged.
  const stale = Number.isFinite(baseMs) && Date.now() - baseMs > 6 * 3_600_000;
  // The clock hour forecast hour +h lands on, in Manila time, for the advisory text.
  const clockAt = (h: number) => (Number.isFinite(baseMs) ? fmtHour((new Date(baseMs + h * 3_600_000).getUTCHours() + 8) % 24) : `+${h}h`);
  /* Advisory text for the Mobile App, from the Act cards. The system publishes advisories only through the
     Mobile App Control Centre (it cannot drive message signs), so the panel copies the text and links there.
     "Possible", not "expected": the measured precision at the Act line is well under one in two. */
  const advised = act.slice(0, 3);
  const advisoryText = advised.length
    ? `Heavy congestion possible on NLEX at ${listOf(advised.map((r) => r.segment))}` +
      (advised[0].firstAct != null ? `, from around ${clockAt(advised[0].firstAct)}` : "") +
      ". Expect delays; travel earlier or later if you can."
    : "";
  const copyAdvisory = () => {
    navigator.clipboard?.writeText(advisoryText).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    }).catch(() => setCopied(false));
  };
  const span = (a: string | null, z: string | null) => (a && z ? `${shortDay(a.slice(0, 10))} to ${shortDay(z.slice(0, 10))}` : "");

  return (
    <Shell
      title="Congestion Response Advisory"
      hint="Act = a segment's chance of High congestion reaches the Act line within 12 hours. The line is not set by hand: it is the cut-off that best balanced High hours caught against false alarms (F1) on the archived forecasts, then checked on the last 7 days, which it never saw."
      meta={
        <>
          <SourceBadge kind="forecast" detail="The congestion forecast's chance of High congestion, 1 to 12 hours ahead" />
          {baseHour && <ForecastAge at={baseHour} stale={stale} />}
        </>
      }
    >
      <Banner tone={act.length ? "alert" : "info"}>
        {!calibrated ? (
          <><b>No Act line yet.</b> {cal?.reason ?? "The forecast archive could not be read."} Segments are listed by their chance of High.</>
        ) : act.length > 0 ? (
          <>
            <b className="nct-bad">Act:</b> {act.length} segment{act.length === 1 ? "" : "s"} reach the {pct(cut!)} line
            {lead != null && lead < 99 && <> from <b>+{lead}h</b></>}: <b>{listOf(act.slice(0, 3).map((r) => r.segment))}</b>
            {act.length > 3 && <> and {act.length - 3} more</>}.
          </>
        ) : missing.length > 0 ? (
          <><b>No segment reaches the {pct(cut!)} line</b> in the next 12 hours, but {missing.length} segment{missing.length === 1 ? " has" : "s have"} no forecast at all.</>
        ) : (
          <><b>Corridor clear.</b> No segment reaches the {pct(cut!)} line in the next 12 hours.</>
        )}
        {baseHour && <> <span className="nct-dim">Hours count from the {baseHour} forecast.</span></>}
      </Banner>

      {calibrated && cal && cal.precision != null && cal.recall != null && (
        <div className="nct-calib" role="group" aria-label="How the Act line performed on held-out days">
          <span><span className="nct-kv-k">Act line</span> <b>{pct(cut!)}</b> chance of High</span>
          <span>When it said Act, High followed <b>{pct(cal.precision)}</b>{cal.baseRate != null && <span className="nct-dim"> (vs {pct(cal.baseRate)} of all hours)</span>}</span>
          <span>It caught <b>{pct(cal.recall)}</b> of High hours</span>
          <InfoTooltip text={`Picked on ${span(cal.fitFrom, cal.fitTo)} (F1 ${cal.fitF1?.toFixed(2)}), then measured on ${span(cal.testFrom, cal.testTo)}: ${fmtInt(cal.testRows)} forecast-hours it never saw (F1 ${cal.f1?.toFixed(2)}). In all, ${fmtInt(cal.scored)} forecast-hours from ${cal.runs} runs scored against Waze jam speeds, ${fmtInt(cal.scoredHigh)} of them High.`} />
        </div>
      )}

      {advisoryText && (
        <div className="nct-publish" role="group" aria-label="Advisory for the Mobile App">
          <p className="nct-publish-text"><span className="nct-kv-k">Advisory</span> {advisoryText}</p>
          <div className="nct-publish-actions">
            <button type="button" className="nct-pill-btn" onClick={copyAdvisory} aria-live="polite">
              {copied ? "Copied" : "Copy advisory"}
            </button>
            <a className="nct-pill-btn is-on" href="/dashboard/mobile">Publish in Mobile App</a>
          </div>
        </div>
      )}

      <div className="nct-actions nct-actions-3">
        {cards.map((r, i) => {
          const tl = timelineOf(r.segment);
          const isAct = r.label === "Act";
          return (
            <ActionCard
              key={r.segment}
              rank={i + 1}
              tone={isAct ? "act" : "info"}
              signal={isAct ? "congested" : "none"}
              tag={<span className="nct-action-label" style={{ color: isAct ? "var(--color-danger)" : "var(--text-muted)" }}>{calibrated ? r.label : "Unrated"}</span>}
              action={r.action}
              facts={[
                { k: "Where", v: <><b>{r.segment}</b>{r.km != null && <span className="nct-dim"> · km {fmtKm(r.km)}</span>}</> },
                ...(r.firstAct != null
                  ? [{ k: "When", v: <>From <b>+{r.firstAct}h</b>{Number.isFinite(baseMs) && <span className="nct-dim"> (around {clockAt(r.firstAct)})</span>}</> }]
                  : []),
                { k: "Peak", v: <><b>{pct(r.probability)}</b> chance of High at +{r.hoursAhead}h</> },
                ...(r.hitRate != null
                  ? [{ k: "How sure", v: <>High followed <b>{pct(r.hitRate)}</b> of {fmtInt(r.hitN)} past forecasts at {pct(r.probability)} or more</> }]
                  : []),
                ...(tl.length > 0 ? [{ k: "Next 12 h", v: <HighTimeline hours={tl} cut={cut} /> }] : []),
              ]}
            />
          );
        })}
      </div>

      {inline.length > 0 && (
        <div className="nct-inline-list">
          <p className="nct-kv-k">Also at Act</p>
          <ul>
            {inline.map((r) => (
              <li key={r.segment}>
                <b style={{ color: "var(--color-danger)" }}>Act</b>
                <span className="nct-inline-seg">{r.segment}</span>
                <span className="nct-dim">{r.firstAct != null ? `from +${r.firstAct}h · peak ${pct(r.probability)}` : ""}</span>
                <HighTimeline hours={timelineOf(r.segment)} cut={cut} compact />
              </li>
            ))}
          </ul>
        </div>
      )}

      {monitor.length > 0 && act.length > 0 && (
        <div className="nct-panel-intro">
          <button type="button" onClick={() => setShowMonitor((v) => !v)} className="nct-link-btn" aria-expanded={showMonitor}>
            {showMonitor ? "Hide" : "Show"} the {monitor.length} segment{monitor.length === 1 ? "" : "s"} at Monitor
          </button>
          {showMonitor && (
            <div className="nct-chip-row" style={{ marginTop: 10 }}>
              {monitor.map((r) => (
                <span key={r.segment} className="nct-mini-chip">{r.segment} · {pct(r.probability)}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {missing.length > 0 && (
        <div className="nct-panel-intro">
          <b className="nct-warn">No forecast:</b> {listOf(missing)}. Not ranked, and not clear either:
          treat {missing.length === 1 ? "it" : "them"} as unknown until the congestion model next runs.
        </div>
      )}

      <details className="nc-details">
        <summary>How this is measured</summary>
        <div>
          <Foot>
            Every archived forecast is matched with what the road then did (High = the Waze jam speed for that exit-hour). The Act
            line is the cut-off with the best F1 on all but the last 7 days; the precision and recall shown are on those 7 days.
            There is one line, not two: no higher cut-off in the archive buys a precision worth a second tier. A volume-to-capacity
            ratio is not shown: no capacity or lane-count column exists anywhere in the warehouse.
          </Foot>
        </div>
      </details>
    </Shell>
  );
}

/* ==================================================================== 3 ====
 * Event intervention ranking.
 */

/** Extra vehicles on an event day per ranked exit: solid to the 95% lower bound (what the rank rests on), lighter
 *  to the estimate, and the interval as a whisker (2 Nov 2026). */
function ExtraBars({ rows }: { rows: RankedExit[] }) {
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.map((r) => r.extraHi));
  const pctOf = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  return (
    <div className="nct-evbars" role="list" aria-label="Extra vehicles on an event day: at least, estimate, and the 95% interval">
      {rows.map((r) => (
        <div key={r.exit} className={`nct-evbar${r.rank <= 3 ? " is-top" : ""}`} role="listitem"
          aria-label={`${r.rank}. ${r.exit}: at least ${fmtInt(r.extraLo)} extra vehicles, estimate ${fmtInt(r.extra)}, up to ${fmtInt(r.extraHi)}`}>
          <span className="nct-evbar-name"><b>{r.rank}</b> {r.exit}</span>
          <span className="nct-evbar-track" aria-hidden="true">
            <span className="nct-evbar-est" style={{ width: pctOf(r.extra) }} />
            <span className="nct-evbar-fill" style={{ width: pctOf(r.extraLo) }} />
            <span className="nct-evbar-whisker" style={{ left: pctOf(r.extraLo), width: `calc(${pctOf(r.extraHi)} - ${pctOf(r.extraLo)})` }} />
          </span>
          <span className="nct-evbar-val">≥ {fmtInt(r.extraLo)} <span className="nct-dim">(est. {fmtInt(r.extra)})</span></span>
        </div>
      ))}
    </div>
  );
}
export function EventInterventionPanel() {
  const { data, error, slow, retry } = useForecast();
  // "" = a typical event day; otherwise an upcoming event's date. Defaults to the next one.
  const [pick, setPick] = useState<string | null>(null);
  const upcoming = useMemo(() => data?.upcomingEvents ?? [], [data]);
  const chosenDate = pick ?? upcoming[0]?.date ?? "";
  const chosen = upcoming.find((e) => e.date === chosenDate) ?? null;
  const ranked = useMemo(
    () => (data ? rankByLowerBound(chosen ? exitsFromUpcoming(chosen) : exitsFromEvents(data.events)) : []),
    [data, chosen],
  );

  if (error) return <Empty msg={`Forecast unavailable: ${error}`} onRetry={retry} />;
  if (!data) return <Empty msg="Loading forecast…" slow={slow} />;

  const top = ranked.slice(0, 3);
  const atLeast = top.reduce((s, r) => s + r.extraLo, 0);
  const estimate = top.reduce((s, r) => s + r.extra, 0);
  const anchor = data.events.find((e) => e.material)?.anchorExit ?? null;
  const longDay = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  const Picker = upcoming.length > 0 && (
    <label className="nct-pick">
      <span className="nct-kv-k">Plan for</span>
      <select className="nct-select" value={chosenDate} onChange={(e) => setPick(e.target.value)} aria-label="Event to plan for">
        {upcoming.map((e) => (
          <option key={e.date} value={e.date}>{shortDay(e.date)} · {e.title.split(" - ")[0]}{e.isDerived ? " (inferred)" : ""}</option>
        ))}
        <option value="">A typical event day</option>
      </select>
    </label>
  );

  return (
    <Shell
      title="Event Intervention Ranking"
      hint="Exits ranked by the extra vehicles each is sure to carry on the event day: the lower end of its uplift's 95% interval times its normal-day baseline. Only exits whose whole interval sits above a normal day are ranked. No weights: a loose estimate already has a low floor."
      meta={<SourceBadge kind="forecast" detail="The event-surge model (uplift measured on past Arena event days) applied to the upcoming Arena calendar" />}
      right={Picker || undefined}
    >
      {ranked.length === 0 ? (
        <Banner>
          <b>No exit shows a rise that is clearly above normal</b> {chosen ? <>for {chosen.title.split(" - ")[0]}</> : <>on an event day</>}: every uplift interval reaches a normal day.
        </Banner>
      ) : (
        <>
          <ActionCard
            rank={1}
            tag={<span className="nct-action-kicker">Event plan</span>}
            action={<>Deploy patrol and advisory resources first at {listOf(top.map((r) => r.exit))}</>}
            lead={anchor ? <>The surge is anchored on {anchor}.</> : undefined}
            facts={[
              ...(chosen
                ? [{ k: "When", v: <><b>{chosen.title.split(" - ")[0]}</b>, {longDay(chosen.date)}{chosen.isDerived ? " (recurring, inferred)" : ""}</> }]
                : [{ k: "When", v: <>Any Arena event day</> }]),
              {
                k: "At least",
                v: <><b>{fmtInt(atLeast)} extra vehicles</b> at these three <span className="nct-dim">(estimate {fmtInt(estimate)})</span></>,
              },
              {
                k: "How sure",
                v: <>95% lower bounds, from {top[0]?.nEvents ?? 0} past event days<InfoTooltip text={ESTIMATE_HINT} /></>,
              },
            ]}
          />

          <ExtraBars rows={ranked.slice(0, 10)} />

          <details className="nc-details">
            <summary>All ranked exits</summary>
            <div className="nct-table-wrap">
              <table className="nct-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Exit</th>
                    <th className="num">At least</th>
                    <th className="num">Estimate</th>
                    <th className="num">Up to</th>
                    <th className="num">Uplift (95% interval)</th>
                    <th className="num">Event days</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((r) => (
                    <tr key={r.exit} className={r.rank <= 3 ? "nct-row-top" : undefined}>
                      <td className={`strong${r.rank <= 3 ? " nct-accent" : " nct-dim"}`}>{r.rank}</td>
                      <td className="strong">{r.exit}</td>
                      <td className="num strong">{fmtInt(r.extraLo)}</td>
                      <td className="num">{fmtInt(r.extra)}</td>
                      <td className="num dim">{fmtInt(r.extraHi)}</td>
                      <td className="num">{r.uplift.toFixed(2)}× <span className="nct-dim">({r.upliftLo.toFixed(2)}–{r.upliftHi.toFixed(2)})</span></td>
                      <td className="num">{r.nEvents}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}

      <details className="nc-details">
        <summary>How this is measured</summary>
        <div>
          <Foot>
            Extra vehicles = the exit&apos;s normal-day baseline {chosen ? "for that weekday and month" : ""} times (uplift − 1). The rank
            uses the lower end of the uplift&apos;s 95% interval, so an exit with a loose estimate ranks on what it is sure to add.
            Exits whose interval reaches 1 are left out. The per-exit forecast for each date is also on the Predictive tab&apos;s Event
            Surge card.
          </Foot>
        </div>
      </details>
    </Shell>
  );
}
