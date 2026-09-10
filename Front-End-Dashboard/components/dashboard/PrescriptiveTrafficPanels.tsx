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
  loadForecast, championValue, fuzzyUrgency, topsisRank, manilaDate,
  type ForecastPayload,
} from "./prescriptiveTraffic.shared";

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);
const shortDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

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

const Banner = ({ tone = "info", children }: { tone?: "info" | "alert"; children: React.ReactNode }) => {
  const c = tone === "alert" ? "var(--color-danger)" : "var(--brand-primary)";
  return (
    <div style={{
      background: `color-mix(in srgb, ${c} 8%, transparent)`,
      border: `1px solid color-mix(in srgb, ${c} 22%, transparent)`,
      borderRadius: 10, padding: "12px 14px", fontSize: "0.82rem", lineHeight: 1.5,
      color: "var(--text-primary)",
    }}>{children}</div>
  );
};

const Empty = ({ msg }: { msg: string }) => (
  <article className="chart-card wide" style={{ ...CARD, minHeight: 160, justifyContent: "center", alignItems: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
    {msg}
  </article>
);

const Foot = ({ children }: { children: React.ReactNode }) => (
  <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.45 }}>{children}</p>
);

/* ==================================================================== 1 ====
 * Booth staffing plan, per plaza.
 *
 * The first version of this panel allocated "extra lanes" across a
 * corridor-wide count -- 58 lanes open at once -- which is not a quantity
 * anyone manages. Staffing is decided one plaza at a time: how many booths to
 * open for the peak. So the corridor forecast is apportioned to each plaza by
 * its observed share of volume, then to the plaza's own busiest hour by its
 * observed hourly profile, and divided by what one booth can serve. The single
 * assumption left is booth throughput, which the warehouse does not hold and
 * the operator does.
 */
export type PlazaShare = { plaza: string; v: number };
export type PlazaHour = { plaza: string; hour: number; v: number };

export function BoothStaffingPanel({ byPlaza, plazaHour, typicalDaily }: {
  byPlaza: PlazaShare[];
  plazaHour: PlazaHour[];
  typicalDaily: number | null;
}) {
  const { data, error } = useForecast();
  const [rate, setRate] = useState(350);
  const [showAll, setShowAll] = useState(false);

  const days = useMemo(() => {
    if (!data) return [];
    return data.volumes
      .filter((v) => v.is_future)
      .map((v) => ({ date: manilaDate(v.date), forecast: championValue(v, data.championModel) ?? 0 }))
      .filter((d) => d.forecast > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(0, 7);
  }, [data]);

  /* Per plaza: share of corridor volume, and the share of its own day that
     falls in its busiest hour. Both measured over the selected range. */
  const plazas = useMemo(() => {
    const total = byPlaza.reduce((s, p) => s + p.v, 0);
    if (total <= 0) return [];
    const byName = new Map<string, { sum: number; peak: number; peakHour: number }>();
    for (const r of plazaHour) {
      const cur = byName.get(r.plaza) ?? { sum: 0, peak: 0, peakHour: 0 };
      cur.sum += r.v;
      if (r.v > cur.peak) { cur.peak = r.v; cur.peakHour = r.hour; }
      byName.set(r.plaza, cur);
    }
    return byPlaza
      .filter((p) => p.v > 0)
      .map((p) => {
        const h = byName.get(p.plaza);
        const peakShare = h && h.sum > 0 ? h.peak / h.sum : null;
        return { plaza: p.plaza, share: p.v / total, peakShare, peakHour: h?.peakHour ?? null };
      })
      .filter((p) => p.peakShare != null) as { plaza: string; share: number; peakShare: number; peakHour: number }[];
  }, [byPlaza, plazaHour]);

  if (error) return <Empty msg={`Forecast unavailable: ${error}`} />;
  if (!data) return <Empty msg="Loading forecast…" />;
  if (days.length === 0) return <Empty msg="No future days in the forecast." />;
  if (plazas.length === 0 || typicalDaily == null) return <Empty msg="Waiting for the descriptive plaza and hourly profiles." />;

  const booths = (dailyCorridor: number, p: { share: number; peakShare: number }) =>
    Math.max(1, Math.ceil((dailyCorridor * p.share * p.peakShare) / rate));

  const rows = plazas.map((p) => {
    const typical = booths(typicalDaily, p);
    const need = days.map((d) => booths(d.forecast, p));
    return { ...p, typical, need };
  });

  const visible = showAll ? rows : rows.slice(0, 8);
  const first = days[0];
  const corridorTomorrow = rows.reduce((s, r) => s + r.need[0], 0);
  const corridorTypical = rows.reduce((s, r) => s + r.typical, 0);
  const biggest = [...rows].sort((a, b) => (b.need[0] - b.typical) - (a.need[0] - a.typical))[0];
  const daysUp = days.filter((_, i) => rows.some((r) => r.need[i] > r.typical)).length;

  return (
    <Shell
      title="Booth Staffing Plan"
      hint="Booths to open at each plaza's busiest hour for the next seven forecast days. Corridor forecast × the plaza's observed share of volume × the share of its day that falls in its peak hour, divided by what one booth serves. Throughput is the one assumption; everything else is measured."
      right={
        <label style={{ display: "grid", gap: 4, minWidth: 220 }}>
          <span style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", color: "var(--text-secondary)" }}>
            <span>One booth serves</span><b style={{ color: "var(--text-primary)" }}>{rate} veh/hr</b>
          </span>
          <input type="range" min={150} max={800} step={25} value={rate}
            onChange={(e) => setRate(Number(e.target.value))} style={{ accentColor: "var(--brand-primary)" }} />
        </label>
      }
    >
      <Banner>
        <b>{shortDay(first.date)}: open {corridorTomorrow} booths across the corridor at the peak</b>
        {corridorTomorrow !== corridorTypical && (
          <> — {corridorTomorrow > corridorTypical ? "+" : "−"}{Math.abs(corridorTomorrow - corridorTypical)} versus a typical day</>
        )}.{" "}
        {biggest && biggest.need[0] !== biggest.typical ? (
          <>The largest change is at <b>{biggest.plaza}</b> ({biggest.typical} → {biggest.need[0]}, peak {fmtHour(biggest.peakHour)}).{" "}</>
        ) : null}
        {daysUp > 0
          ? <>{daysUp} of the next {days.length} days need more than typical staffing somewhere on the corridor.</>
          : <>No day in the next {days.length} exceeds typical staffing anywhere.</>}
      </Banner>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)", borderBottom: "1px solid var(--border-default)" }}>
              <th style={{ padding: "6px 8px", fontWeight: 700 }}>Plaza</th>
              <th style={{ padding: "6px 8px", fontWeight: 700 }}>Peak hour</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Typical</th>
              {days.map((d) => (
                <th key={d.date} style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right", whiteSpace: "nowrap" }}>
                  {new Date(`${d.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "short" })}
                  <span style={{ display: "block", fontWeight: 500, fontSize: "0.68rem" }}>
                    {new Date(`${d.date}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.plaza} style={{ borderBottom: "1px solid var(--border-default)" }}>
                <td style={{ padding: "6px 8px", fontWeight: 600, whiteSpace: "nowrap" }}>{r.plaza}</td>
                <td style={{ padding: "6px 8px", color: "var(--text-secondary)" }}>{fmtHour(r.peakHour)}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-secondary)" }}>{r.typical}</td>
                {r.need.map((n, i) => {
                  const delta = n - r.typical;
                  return (
                    <td key={days[i].date} style={{
                      padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: delta !== 0 ? 800 : 500,
                      color: delta > 0 ? "var(--color-danger)" : delta < 0 ? "var(--color-success)" : "var(--text-primary)",
                      background: delta > 0 ? "color-mix(in srgb, var(--color-danger) 7%, transparent)" : undefined,
                    }}>
                      {n}{delta !== 0 && <span style={{ fontSize: "0.66rem", marginLeft: 3 }}>{delta > 0 ? `+${delta}` : delta}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > 8 && (
        <button onClick={() => setShowAll((v) => !v)} style={{
          alignSelf: "flex-start", border: "1px solid var(--border-strong)", background: "var(--bg-surface)", color: "var(--text-secondary)",
          borderRadius: 999, padding: "4px 12px", fontSize: "0.72rem", fontWeight: 700, cursor: "pointer",
        }}>
          {showAll ? "Show the 8 busiest" : `Show all ${rows.length} plazas`}
        </button>
      )}

      <Foot>
        Volume is the {data.championModel ?? "champion"} forecast. Each plaza&apos;s share of the corridor and its peak-hour share are
        measured over the selected Range; &ldquo;typical&rdquo; is the same calculation on the range&apos;s average day. Booth
        throughput is the only assumption — the warehouse holds no plaza capacity, so it is yours to set.
      </Foot>
    </Shell>
  );
}

/* ==================================================================== 2 ====
 * Congestion response advisory.
 */
export function CongestionResponsePanel() {
  const { data, error } = useForecast();
  const [showRest, setShowRest] = useState(false);

  const rows = useMemo(() => {
    if (!data) return [];
    type Row = { segment: string; km: number; first: number | null; peak: number; peakHour: number; urgency: number; label: "Monitor" | "Prepare" | "Act" };
    const bySeg = new Map<string, Row>();
    for (const c of data.congestion) {
      const p = Number(c.probability);
      if (!Number.isFinite(p)) continue;
      const high = String(c.state).toLowerCase() === "high";
      const u = fuzzyUrgency(high ? p : 1 - p, c.hours);
      const cur: Row = bySeg.get(c.segment) ?? { segment: c.segment, km: c.km, first: null, peak: 0, peakHour: 0, urgency: 0, label: "Monitor" };
      if (high && cur.first == null) cur.first = c.hours;
      if (high && p > cur.peak) { cur.peak = p; cur.peakHour = c.hours; }
      if (u.score > cur.urgency) { cur.urgency = u.score; cur.label = u.label; }
      bySeg.set(c.segment, cur);
    }
    return [...bySeg.values()].sort((a, b) => b.urgency - a.urgency || (a.first ?? 99) - (b.first ?? 99));
  }, [data]);

  if (error) return <Empty msg={`Forecast unavailable: ${error}`} />;
  if (!data) return <Empty msg="Loading forecast…" />;
  if (rows.length === 0) return <Empty msg="No congestion forecast available." />;

  const act = rows.filter((r) => r.label === "Act");
  const prepare = rows.filter((r) => r.label === "Prepare");
  const top = act.slice(0, 3);
  const rest = rows.filter((r) => !top.includes(r) && r.label !== "Monitor");
  const lead = top.length ? Math.min(...top.map((r) => r.first ?? 99)) : null;

  const ACTION: Record<string, string> = {
    Act: "Deploy counter-flow and post VMS advisories before the first High hour.",
    Prepare: "Stage units nearby; hold the advisory until probability firms up.",
    Monitor: "No action; re-check next cycle.",
  };
  const tone = (l: string) => (l === "Act" ? "var(--color-danger)" : l === "Prepare" ? "var(--color-warning)" : "var(--text-muted)");

  return (
    <Shell
      title="Congestion Response Advisory"
      hint="Ranks segments by how likely High congestion is and how soon, through a fuzzy controller so a segment near a threshold reads as near a threshold rather than flipping an alert on and off. Counter-flow is disruptive and scarce, so the advisory goes to the three most urgent; the rest are listed, not alerted."
    >
      <Banner tone={act.length ? "alert" : "info"}>
        {top.length > 0 ? (
          <>
            <b style={{ color: "var(--color-danger)" }}>Operator alert:</b> severe congestion predicted
            {lead != null && lead < 99 && <> within <b>{lead}h</b></>} — counter-flow advisory for{" "}
            <b>{top.map((r) => r.segment).join(", ")}</b>.
            {rest.length > 0 && <> {rest.length} more segment{rest.length === 1 ? "" : "s"} elevated but not advised.</>}
          </>
        ) : prepare.length > 0 ? (
          <><b>No segment reaches Act.</b> {prepare.length} at Prepare — stage, don&apos;t intervene.</>
        ) : (
          <><b>Corridor clear.</b> No segment crosses Prepare inside the 12-hour horizon.</>
        )}
      </Banner>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        {(top.length ? top : rows.slice(0, 3)).map((r, i) => (
          <div key={r.segment} style={{ border: "1px solid var(--border-default)", borderLeft: `4px solid ${tone(r.label)}`, borderRadius: 10, padding: "12px 14px", display: "grid", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontWeight: 800, fontSize: "0.9rem" }}>{i + 1}. {r.segment}</span>
              <span style={{ fontSize: "0.7rem", fontWeight: 800, color: tone(r.label), textTransform: "uppercase", letterSpacing: "0.06em" }}>{r.label}</span>
            </div>
            <div style={{ display: "flex", gap: 14, fontSize: "0.76rem", color: "var(--text-secondary)" }}>
              <span>First High <b style={{ color: "var(--text-primary)" }}>{r.first != null ? `+${r.first}h` : "—"}</b></span>
              <span>Peak <b style={{ color: "var(--text-primary)" }}>{r.peak > 0 ? `${Math.round(r.peak * 100)}%` : "—"}</b>{r.peak > 0 && <> at +{r.peakHour}h</>}</span>
            </div>
            <div style={{ fontSize: "0.76rem", lineHeight: 1.4 }}>{ACTION[r.label]}</div>
          </div>
        ))}
      </div>

      {rest.length > 0 && (
        <div style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>
          <button onClick={() => setShowRest((v) => !v)} style={{ border: 0, background: "none", color: "var(--brand-primary)", fontWeight: 700, cursor: "pointer", padding: 0, fontSize: "0.76rem" }}>
            {showRest ? "Hide" : "Show"} the {rest.length} elevated segment{rest.length === 1 ? "" : "s"} not advised
          </button>
          {showRest && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {rest.map((r) => (
                <span key={r.segment} style={{ border: "1px solid var(--border-default)", borderRadius: 999, padding: "3px 10px", background: "var(--bg-surface)" }}>
                  <b style={{ color: tone(r.label) }}>{r.label}</b> · {r.segment}{r.first != null && <> · +{r.first}h</>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <Foot>
        A volume-to-capacity ratio is not shown: it needs lane capacity, and no capacity or lane-count column exists anywhere in
        the warehouse. The predicted congestion state is what the data supports.
      </Foot>
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

  // The next scheduled Arena day, named so the plan can say what it is for.
  // The per-exit forecast for it lives on the Predictive tab's Event Surge
  // card, where a prediction belongs; this panel is the action on it.
  const next = (data.upcomingEvents ?? [])[0] ?? null;

  const top = ranked.slice(0, 3);
  const totalExtra = top.reduce((s, r) => s + r.extraVehicles, 0);
  const anchor = data.events.find((e) => e.material)?.anchorExit ?? null;
  const confidence = (w: number) => (w < 0.05 ? "firm" : w < 0.12 ? "fair" : "loose");

  return (
    <Shell
      title="Event Intervention Ranking"
      hint="Ranks exits for event-day intervention by closeness to an ideal option across four criteria: vehicles moved, uplift over baseline, how many events the estimate rests on, and the width of its confidence interval as a penalty (TOPSIS)."
    >
      <Banner>
        <b>Event traffic management plan: {top.map((r) => r.exit).join(", ")}.</b>{" "}
        On an event day these three exits carry <b>{fmtInt(totalExtra)}</b> extra vehicles between them.
        Deploy patrol and advisory resources here first{anchor ? <> — the surge is anchored on {anchor}</> : null}.
        {next && (
          <> Next up: <b>{next.title.split(" - ")[0]}</b> on{" "}
          <b>{new Date(`${next.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</b>
          {next.isDerived ? " (recurring, inferred)" : ""}.</>
        )}
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
              <th style={{ padding: "6px 8px", fontWeight: 700 }}>Estimate</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Score</th>
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
                <td style={{ padding: "6px 8px", color: "var(--text-secondary)" }}>{confidence(r.uncertainty)} <span style={{ fontSize: "0.68rem" }}>(±{(r.uncertainty / 2).toFixed(2)})</span></td>
                <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{r.closeness.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Dated forecasts for the next Arena events. The ranking above says which
          exits matter on an event day in general; this says what to expect on a
          specific date -- the measured uplift applied to that weekday-in-that-
          month's baseline, the same construction the Predictive tab uses when
          given a date. */}
      <Foot>
        Criteria weighted 0.40 vehicles / 0.25 uplift / 0.20 evidence / 0.15 interval width. &ldquo;Estimate&rdquo; reads the
        uplift interval: firm under ±0.025, fair under ±0.06. The per-exit forecast for each upcoming Arena date is on the
        Predictive tab&apos;s Event Surge card; this ranking is the deployment order for whichever date is chosen there.
      </Foot>
    </Shell>
  );
}
