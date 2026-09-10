"use client";

/* The Traffic Prescriptive tab: three panels, one per row of the analytics
 * diagram, each acting on the Predictive tab's own forecast.
 *
 * They live in one file because they share a single cached fetch and a single
 * decision-logic module; splitting them would triple the boilerplate without
 * separating anything that is actually independent.
 */

import { useEffect, useMemo, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import {
  loadForecast, championValue, allocateStaff, fuzzyUrgency, topsisRank, manilaDate,
  type ForecastPayload,
} from "./prescriptiveTraffic.shared";

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtPct = (n: number) => `${n >= 0 ? "" : "−"}${Math.abs(n).toFixed(1)}%`;

function useForecast() {
  const [data, setData] = useState<ForecastPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadForecast()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => { alive = false; };
  }, []);
  return { data, error };
}

const CARD: React.CSSProperties = {
  padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14,
};

function Shell({ title, hint, children, right }: {
  title: string; hint: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <article className="chart-card wide" style={CARD}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 800, letterSpacing: "-0.02em", display: "flex", alignItems: "center", gap: 6 }}>
            {title} <InfoTooltip text={hint} />
          </h3>
        </div>
        {right}
      </div>
      {children}
    </article>
  );
}

const Banner = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    background: "color-mix(in srgb, var(--brand-primary) 8%, transparent)",
    border: "1px solid color-mix(in srgb, var(--brand-primary) 22%, transparent)",
    borderRadius: 10, padding: "12px 14px", fontSize: "0.82rem", lineHeight: 1.5,
    color: "var(--text-primary)",
  }}>{children}</div>
);

const Slider = ({ label, value, min, max, step = 1, unit, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; unit: string;
  onChange: (v: number) => void;
}) => (
  <label style={{ display: "grid", gap: 4, minWidth: 150, flex: "1 1 150px" }}>
    <span style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", color: "var(--text-secondary)" }}>
      <span>{label}</span><b style={{ color: "var(--text-primary)" }}>{value.toLocaleString("en-US")} {unit}</b>
    </span>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(Number(e.target.value))} style={{ accentColor: "var(--brand-primary)" }} />
  </label>
);

const Empty = ({ msg }: { msg: string }) => (
  <article className="chart-card wide" style={{ ...CARD, minHeight: 160, justifyContent: "center", alignItems: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
    {msg}
  </article>
);

/* ==================================================================== 1 ====
 * Volume surge advisory and booth staffing.
 */
export function VolumeStaffingPanel({ peakShare }: { peakShare: number | null }) {
  const { data, error } = useForecast();
  /* Corridor-wide defaults, sized off the data rather than picked: ~350k
     vehicles a day with ~6.7% in the peak hour is ~23k veh/hr across roughly
     twenty plazas, so ~60 lanes at 400 veh/hr is the regime where the fleet
     is neither trivially sufficient nor hopelessly short. Opening at 12 lanes
     made every day short by ~18k vehicles and the whole allocation pointless. */
  const [baseLanes, setBaseLanes] = useState(58);
  const [rate, setRate] = useState(400);
  const [pool, setPool] = useState(20);
  const [horizon, setHorizon] = useState(14);

  const future = useMemo(() => {
    if (!data) return [];
    return data.volumes
      .filter((v) => v.is_future)
      .map((v) => ({ date: manilaDate(v.date), forecast: championValue(v, data.championModel) ?? 0 }))
      .filter((d) => d.forecast > 0)
      .slice(0, horizon);
  }, [data, horizon]);

  /* The surge threshold is the 90th percentile of days the model was actually
     scored on, so "surge" means busy relative to observed history rather than
     relative to a number chosen here. */
  const p90 = useMemo(() => {
    if (!data) return null;
    const actuals = data.volumes.map((v) => v.actual_volume).filter((n): n is number => typeof n === "number" && n > 0).sort((a, b) => a - b);
    return actuals.length ? actuals[Math.floor(actuals.length * 0.9)] : null;
  }, [data]);

  if (error) return <Empty msg={`Forecast unavailable: ${error}`} />;
  if (!data) return <Empty msg="Loading forecast…" />;
  if (peakShare == null) return <Empty msg="Waiting for the descriptive peak-hour profile." />;
  if (future.length === 0) return <Empty msg="No future days in the forecast." />;

  const lp = allocateStaff(future, { peakShare, baseLanes, rate, pool, maxExtra: 8 });
  const surgeDays = p90 != null ? future.filter((d) => d.forecast > p90) : [];
  const worked = lp.schedule.filter((r) => r.lanes > 0).sort((a, b) => b.lanes - a.lanes);

  /* Queue delay under a deterministic server: vehicles that cannot be served in
     the peak hour wait for the hour(s) behind it. Reduction is the change in
     total queued vehicle-hours, which is what an extra lane actually buys. */
  const waitCut = lp.unmetBefore > 0 ? ((lp.unmetBefore - lp.unmetAfter) / lp.unmetBefore) * 100 : 0;
  const peakHours = lp.schedule.filter((r) => r.unmetAfter > 0).length;

  return (
    <Shell
      title="Volume Surge Advisory & Booth Staffing"
      hint="Allocates a fixed pool of extra staffed lanes across the forecast days to minimise unmet peak-hour demand. The allocation is the exact optimum of the stated linear program; lane count and throughput are yours to set because the warehouse holds no plaza capacity."
      right={
        <div style={{ display: "flex", gap: 6 }}>
          {[7, 14, 30].map((n) => (
            <button key={n} onClick={() => setHorizon(n)} style={{
              padding: "4px 10px", borderRadius: 999, fontSize: "0.72rem", fontWeight: 700, cursor: "pointer",
              border: `1px solid ${horizon === n ? "var(--brand-primary)" : "var(--border-strong)"}`,
              background: horizon === n ? "var(--brand-primary)" : "var(--bg-surface)",
              color: horizon === n ? "#fff" : "var(--text-secondary)",
            }}>{n}d</button>
          ))}
        </div>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <Slider label="Lanes open (baseline)" value={baseLanes} min={20} max={140} unit="lanes" onChange={setBaseLanes} />
        <Slider label="Throughput per lane" value={rate} min={150} max={800} step={25} unit="veh/hr" onChange={setRate} />
        <Slider label="Extra lane-shifts available" value={pool} min={0} max={80} unit="shifts" onChange={setPool} />
      </div>

      <Banner>
        <b>{worked.length} of the next {future.length} days need reinforcement.</b>{" "}
        Assigning {pool} extra lane-shifts by the linear program cuts unmet peak demand from{" "}
        <b>{fmtInt(lp.unmetBefore)}</b> to <b>{fmtInt(lp.unmetAfter)}</b> vehicles — a{" "}
        <b>{fmtPct(waitCut)}</b> reduction in queued vehicles.{" "}
        {peakHours > 0
          ? <>Even so, <b>{peakHours}</b> day{peakHours === 1 ? "" : "s"} still exceed capacity at peak; that residual is the honest limit of this fleet.</>
          : <>No day exceeds capacity after allocation.</>}
        {surgeDays.length > 0 && p90 != null && (
          <> <b>{surgeDays.length}</b> day{surgeDays.length === 1 ? " sits" : "s sit"} above the {fmtInt(p90)}-vehicle surge threshold (90th percentile of scored history).</>
        )}
      </Banner>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)", borderBottom: "1px solid var(--border-default)" }}>
              <th style={{ padding: "6px 8px", fontWeight: 700 }}>Date</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Forecast volume</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Peak-hour demand</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Extra lanes</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Unmet after</th>
            </tr>
          </thead>
          <tbody>
            {(worked.length ? worked : lp.schedule.slice(0, 6)).slice(0, 10).map((r) => (
              <tr key={r.date} style={{ borderBottom: "1px solid var(--border-default)" }}>
                <td style={{ padding: "6px 8px", fontWeight: 600 }}>{r.date}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtInt(r.forecast)}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtInt(r.peakDemand)}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 800, color: "var(--brand-primary)" }}>{r.lanes || "—"}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: r.unmetAfter > 0 ? "var(--color-danger)" : "var(--text-muted)" }}>
                  {r.unmetAfter > 0 ? fmtInt(r.unmetAfter) : "0"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.45 }}>
        Peak-hour share {(peakShare * 100).toFixed(1)}% is measured from the descriptive hour×weekday profile, and the
        volume is the {data.championModel ?? "champion"} forecast. Lanes and throughput are operator inputs: the warehouse
        holds no plaza capacity, so those two numbers are assumptions you set, not measurements.
      </p>
    </Shell>
  );
}

/* ==================================================================== 2 ====
 * Congestion response advisory.
 */
export function CongestionResponsePanel() {
  const { data, error } = useForecast();

  const rows = useMemo(() => {
    if (!data) return [];
    const bySeg = new Map<string, { segment: string; km: number; first: number | null; peak: number; peakHour: number; urgency: number; label: string }>();
    for (const c of data.congestion) {
      const p = Number(c.probability);
      if (!Number.isFinite(p)) continue;
      const high = String(c.state).toLowerCase() === "high";
      const u = fuzzyUrgency(high ? p : 1 - p, c.hours);
      const cur = bySeg.get(c.segment) ?? { segment: c.segment, km: c.km, first: null, peak: 0, peakHour: 0, urgency: 0, label: "Monitor" };
      if (high && cur.first == null) cur.first = c.hours;
      if (high && p > cur.peak) { cur.peak = p; cur.peakHour = c.hours; }
      if (u.score > cur.urgency) { cur.urgency = u.score; cur.label = u.label; }
      bySeg.set(c.segment, cur);
    }
    return [...bySeg.values()].sort((a, b) => b.urgency - a.urgency);
  }, [data]);

  if (error) return <Empty msg={`Forecast unavailable: ${error}`} />;
  if (!data) return <Empty msg="Loading forecast…" />;
  if (rows.length === 0) return <Empty msg="No congestion forecast available." />;

  const act = rows.filter((r) => r.label === "Act");
  const prepare = rows.filter((r) => r.label === "Prepare");
  const lead = act.length ? Math.min(...act.map((r) => r.first ?? 99)) : null;
  const tone = (l: string) => (l === "Act" ? "var(--color-danger)" : l === "Prepare" ? "var(--color-warning)" : "var(--text-muted)");

  return (
    <Shell
      title="Congestion Response Advisory"
      hint="A Mamdani fuzzy controller over predicted congestion likelihood and how soon it arrives. Overlapping memberships mean a segment near a threshold reads as near a threshold, instead of flipping an alert on and off between two probabilities that describe the same road."
    >
      <Banner>
        {act.length > 0 ? (
          <>
            <b style={{ color: "var(--color-danger)" }}>Operator alert:</b>{" "}
            severe congestion predicted on <b>{act.slice(0, 3).map((r) => r.segment).join(", ")}</b>
            {act.length > 3 && <> and <b>{act.length - 3}</b> other segment{act.length - 3 === 1 ? "" : "s"}</>}
            {lead != null && lead < 99 && <> in <b>{lead}h</b></>}.{" "}
            {/* Counter-flow is a scarce, disruptive intervention: naming twelve
                segments at once is the same as naming none, so the advisory
                goes to the three highest-urgency and the rest are reported as
                a count. */}
            Counter-flow advisory recommended for the {Math.min(3, act.length)} highest-urgency
            segment{Math.min(3, act.length) === 1 ? "" : "s"}; {prepare.length} more
            {prepare.length === 1 ? " is" : " are"} at Prepare.
          </>
        ) : prepare.length > 0 ? (
          <><b>No segment reaches Act.</b> {prepare.length} at Prepare — worth staging, not worth intervening.</>
        ) : (
          <><b>Corridor clear.</b> No segment crosses Prepare inside the 12-hour horizon.</>
        )}
      </Banner>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)", borderBottom: "1px solid var(--border-default)" }}>
              <th style={{ padding: "6px 8px", fontWeight: 700 }}>Segment</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>First High</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Peak probability</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Urgency</th>
              <th style={{ padding: "6px 8px", fontWeight: 700 }}>Advisory</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((r) => (
              <tr key={r.segment} style={{ borderBottom: "1px solid var(--border-default)" }}>
                <td style={{ padding: "6px 8px", fontWeight: 600 }}>{r.segment}</td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>{r.first != null ? `+${r.first}h` : "—"}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {r.peak > 0 ? `${(r.peak * 100).toFixed(0)}%` : "—"}
                </td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.urgency.toFixed(2)}</td>
                <td style={{ padding: "6px 8px", fontWeight: 700, color: tone(r.label) }}>{r.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.45 }}>
        Urgency is the defuzzified score, not a probability. The diagram&apos;s peak V/C ratio target is not shown: a
        volume-to-capacity ratio needs lane capacity, and no capacity or lane-count column exists anywhere in the
        warehouse — the predicted congestion state is what the data can actually support.
      </p>
    </Shell>
  );
}

/* ==================================================================== 3 ====
 * Event intervention ranking.
 */
export function EventInterventionPanel() {
  const { data, error } = useForecast();
  const ranked = useMemo(() => (data ? topsisRank(data.events) : []), [data]);

  if (error) return <Empty msg={`Forecast unavailable: ${error}`} />;
  if (!data) return <Empty msg="Loading forecast…" />;
  if (ranked.length === 0) return <Empty msg="No event surge forecast available." />;

  const top = ranked.slice(0, 3);
  const totalExtra = top.reduce((s, r) => s + r.extraVehicles, 0);
  const anchor = data.events.find((e) => e.material)?.anchorExit ?? null;

  return (
    <Shell
      title="Event Intervention Ranking (TOPSIS)"
      hint="Ranks exits for event-day intervention by closeness to an ideal option across four criteria: vehicles moved, uplift over baseline, how many events the estimate rests on, and the width of its confidence interval as a penalty."
    >
      <Banner>
        <b>Event traffic management plan: {top.map((r) => r.exit).join(", ")}.</b>{" "}
        On an event day these three exits carry <b>{fmtInt(totalExtra)}</b> extra vehicles between them.
        Deploy patrol and advisory resources here first{anchor ? <> — the surge is anchored on {anchor}</> : null}.
      </Banner>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)", borderBottom: "1px solid var(--border-default)" }}>
              <th style={{ padding: "6px 8px", fontWeight: 700 }}>#</th>
              <th style={{ padding: "6px 8px", fontWeight: 700 }}>Exit</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Extra vehicles</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Uplift</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Events seen</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>CI width</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Closeness</th>
            </tr>
          </thead>
          <tbody>
            {ranked.slice(0, 10).map((r) => (
              <tr key={r.exit} style={{ borderBottom: "1px solid var(--border-default)", background: r.rank <= 3 ? "color-mix(in srgb, var(--brand-primary) 5%, transparent)" : undefined }}>
                <td style={{ padding: "6px 8px", fontWeight: 800, color: r.rank <= 3 ? "var(--brand-primary)" : "var(--text-muted)" }}>{r.rank}</td>
                <td style={{ padding: "6px 8px", fontWeight: 600 }}>{r.exit}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtInt(r.extraVehicles)}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.uplift.toFixed(2)}×</td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.evidence}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>±{(r.uncertainty / 2).toFixed(3)}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{r.closeness.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.45 }}>
        Criteria are weighted 0.40 vehicles / 0.25 uplift / 0.20 evidence / 0.15 interval width. Alert lead time is not
        shown: it needs a schedule of upcoming events, and this forecast carries only the historical window the uplift
        was measured over ({data.events[0]?.event ?? "event"} days).
      </p>
    </Shell>
  );
}
