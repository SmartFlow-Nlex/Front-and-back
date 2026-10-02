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
  loadForecast, championValue, topsisRank, manilaDate, loadPrescriptive,
  type ForecastPayload, type TrafficPrescriptive, type BoothHour,
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
 * Booth staffing plan, per plaza, per hour.
 *
 * The model moved to the backend (traffic-prescriptive.service.ts). Two things
 * were wrong with computing it here:
 *
 *   - it ran on props the DESCRIPTIVE tab happened to have loaded, so the
 *     recommendation changed when the operator moved a date range that has
 *     nothing to do with next week's staffing, and
 *   - it only ever covered each plaza's single busiest hour, because that is
 *     all the page had. "How many booths at 10am" had no answer.
 *
 * The server returns the full 24-hour profile per plaza, split weekday from
 * weekend, so the shift plan below is real. Throughput is still the operator's
 * dial; everything else is measured.
 */

function usePrescriptive(throughput: number) {
  const [data, setData] = useState<TrafficPrescriptive | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    setData(null);
    setError(null);
    loadPrescriptive(throughput)
      .then((d) => { if (!off) setData(d); })
      .catch((e) => { if (!off) setError(e instanceof Error ? e.message : String(e)); });
    return () => { off = true; };
  }, [throughput]);
  return { data, error };
}

/** A 24-cell strip: one block per hour, height by booths needed. Where that
 *  is more than the plaza can open, the excess is hatched red on top: needed,
 *  but there is no booth for it. */
function HourStrip({ hours, peakHour, max }: { hours: BoothHour[]; peakHour: number; max: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(24, 1fr)", gap: 1, alignItems: "end", height: 34 }}>
      {hours.map((h) => {
        const frac = max > 0 ? h.need / max : 0;
        const short = h.need - h.staffed;
        const isPeak = h.hour === peakHour;
        return (
          <div
            key={h.hour}
            title={
              `${fmtHour(h.hour)} — ${h.need} booth${h.need === 1 ? "" : "s"} for ${fmtInt(h.demand)} vehicles` +
              (short > 0 ? `; ${h.staffed} can open, so about ${fmtInt(h.unmet)} vehicles queue` : "")
            }
            style={{
              height: `${Math.max(8, frac * 100)}%`,
              display: "flex", flexDirection: "column",
              borderRadius: "2px 2px 0 0", overflow: "hidden",
            }}
          >
            {short > 0 && (
              <div style={{ flex: short, background: "repeating-linear-gradient(135deg, var(--color-danger) 0 2px, transparent 2px 4px)" }} />
            )}
            <div style={{
              flex: Math.max(1, h.staffed),
              background: isPeak ? "var(--brand-primary)" : "color-mix(in srgb, var(--brand-primary) 55%, transparent)",
            }} />
          </div>
        );
      })}
    </div>
  );
}

const listOf = (xs: string[]) =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

export function BoothStaffingPanel() {
  const [rate, setRate] = useState(350);
  const [view, setView] = useState<"week" | "hour">("week");
  const [showAll, setShowAll] = useState(false);
  const { data, error } = usePrescriptive(rate);

  if (error) return <Empty msg={`Prescriptive traffic unavailable: ${error}`} />;
  if (!data) return <Empty msg="Computing the staffing plan…" />;
  if (data.week.length === 0 || !data.shiftPlan) return <Empty msg="No future days in the volume forecast." />;
  if (data.shiftPlan.plazas.length === 0) return <Empty msg="No plaza volumes are recorded to apportion the forecast with." />;

  const days = data.week;
  const plan = data.shiftPlan;
  const first = days[0];

  // Week table: booths to open at each plaza's peak, per day, ordered by the
  // busiest. "To open", not "needed": a plaza cannot open booths it does not
  // have, and where it would need more, the cell says so.
  const plazaNames = plan.plazas.map((p) => p.plaza);
  const byDay = new Map(days.map((d) => [d.date, new Map(d.plazas.map((p) => [p.plaza, p]))] as const));
  const rows = plazaNames.map((name) => {
    const p = plan.plazas.find((x) => x.plaza === name)!;
    const each = days.map((d) => byDay.get(d.date)!.get(name) ?? null);
    return {
      plaza: name,
      peakHour: p.peakHour,
      typical: p.typicalPeakStaffed,
      booths: p.booths,
      boothBasis: p.boothBasis,
      need: each.map((x) => x?.peakStaffed ?? 0),
      short: each.map((x) => x?.worstUnmet ?? null),
    };
  });
  const visible = showAll ? rows : rows.slice(0, 8);

  const corridorTypical = rows.reduce((s, r) => s + r.typical, 0);
  const biggest = [...rows].sort((a, b) => (b.need[0] - b.typical) - (a.need[0] - a.typical))[0];
  const daysUp = days.filter((_, i) => rows.some((r) => r.need[i] > r.typical)).length;
  const hourMax = Math.max(1, ...plan.plazas.flatMap((p) => p.hours.map((h) => h.need)));
  // Demand that every booth open would still not clear: worst first, and how
  // many other plaza-days run past their booths too.
  const worst = data.overCapacity[0] ?? null;
  const overDays = new Set(data.overCapacity.map((o) => `${o.date}|${o.plaza}`)).size;
  const noBooths = data.basis.plazasWithoutBooths;

  const Toggle = (
    <div style={{ display: "inline-flex", border: "1px solid var(--border-strong)", borderRadius: 999, overflow: "hidden" }}>
      {(["week", "hour"] as const).map((v) => (
        <button
          key={v}
          onClick={() => setView(v)}
          style={{
            border: "none", cursor: "pointer", padding: "4px 12px", fontSize: "0.72rem", fontWeight: 700,
            background: view === v ? "var(--brand-primary)" : "transparent",
            color: view === v ? "#fff" : "var(--text-secondary)",
          }}
        >
          {v === "week" ? "Week ahead" : "Hour by hour"}
        </button>
      ))}
    </div>
  );

  return (
    <Shell
      title="Booth Staffing Plan"
      hint="Corridor forecast apportioned to each plaza by its measured share of volume, then across the day by that plaza's own hourly profile, split weekday from weekend. Divided by what one booth serves, and capped at the booths each plaza has (OpenStreetMap): demand beyond them is shown as queuing, not as booths that do not exist. Throughput is the one figure you set; the rest is measured."
      right={
        <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
          {Toggle}
          <label style={{ display: "grid", gap: 4, minWidth: 220 }}>
            <span style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", color: "var(--text-secondary)" }}>
              <span>One booth serves</span><b style={{ color: "var(--text-primary)" }}>{rate} veh/hr</b>
            </span>
            <input type="range" min={150} max={800} step={25} value={rate}
              onChange={(e) => setRate(Number(e.target.value))} style={{ accentColor: "var(--brand-primary)" }} />
          </label>
        </div>
      }
    >
      <Banner>
        <b>{shortDay(first.date)}: open {first.totalPeakBooths} booths across the corridor at the peak</b>
        {first.totalPeakBooths !== corridorTypical && (
          <> — {first.totalPeakBooths > corridorTypical ? "+" : "\u2212"}{Math.abs(first.totalPeakBooths - corridorTypical)} versus a typical day</>
        )}.{" "}
        {biggest && biggest.need[0] !== biggest.typical ? (
          <>The largest change is at <b>{biggest.plaza}</b> ({biggest.typical} → {biggest.need[0]}, peak {fmtHour(biggest.peakHour)}).{" "}</>
        ) : null}
        {daysUp > 0
          ? <>{daysUp} of the next {days.length} days need more than typical staffing somewhere on the corridor.</>
          : <>No day in the next {days.length} exceeds typical staffing anywhere.</>}
      </Banner>

      {worst && (
        <Banner tone="alert">
          <b style={{ color: "var(--color-danger)" }}>Not enough booths.</b>{" "}
          {shortDay(worst.date)} at {fmtHour(worst.hour)}, <b>{worst.plaza}</b>&apos;s {worst.where} booths would need {worst.need},{" "}
          and there are {worst.booths}: about <b>{fmtInt(worst.vehicles)} vehicles an hour</b> queue with every one of them open.
          Staffing cannot clear that; divert traffic or post an advisory there.
          {overDays > 1 && (
            <> {overDays - 1} more plaza-day{overDays - 1 === 1 ? "" : "s"} this week run past their booths too, marked{" "}
            <b style={{ color: "var(--color-danger)" }}>!</b> below.</>
          )}
        </Banner>
      )}

      {view === "hour" ? (
        <>
          <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)" }}>
            Booths needed hour by hour on <b>{shortDay(plan.date)}</b> ({plan.dayType}).
            Plazas do not peak together — the tallest bar is each plaza&apos;s own busiest hour.
            {plan.plazas.some((p) => p.unmetVehicles > 0) && <> Red hatching is need beyond the booths the plaza has.</>}
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {(showAll ? plan.plazas : plan.plazas.slice(0, 8)).map((p) => (
              <div key={p.plaza} style={{ display: "grid", gridTemplateColumns: "150px 1fr 128px", gap: 10, alignItems: "end" }}>
                <div style={{ fontSize: "0.76rem", fontWeight: 600, paddingBottom: 2 }}>
                  {p.plaza}
                  <span style={{ display: "block", fontWeight: 500, fontSize: "0.66rem", color: "var(--text-muted)" }}>
                    {p.sharePct}% of corridor
                  </span>
                </div>
                <HourStrip hours={p.hours} peakHour={p.peakHour} max={hourMax} />
                <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", textAlign: "right", paddingBottom: 2 }} title={p.boothBasis}>
                  peak <b style={{ color: "var(--text-primary)" }}>{p.peakStaffed}</b>
                  {p.booths != null && <> of {p.booths}</>} at {fmtHour(p.peakHour)}
                  {p.worstUnmet && (
                    <span style={{ display: "block", color: "var(--color-danger)", fontWeight: 700 }}>
                      {fmtInt(p.worstUnmet.vehicles)}/h queue at {fmtHour(p.worstUnmet.hour)}
                      {/* Which booths: a plaza can have spare booths on one side while the other is full. */}
                      {p.worstUnmet.where && (
                        <span style={{ display: "block", fontWeight: 500, fontSize: "0.66rem" }}>{p.worstUnmet.where} full</span>
                      )}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-muted)", borderBottom: "1px solid var(--border-default)" }}>
                <th style={{ padding: "6px 8px", fontWeight: 700 }}>Plaza</th>
                <th style={{ padding: "6px 8px", fontWeight: 700 }}>Peak hour</th>
                <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Booths</th>
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
                  <td style={{ padding: "6px 8px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{fmtHour(r.peakHour)}</td>
                  <td
                    title={r.booths != null ? r.boothBasis : "No toll booths mapped in OpenStreetMap: not capped"}
                    style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-muted)" }}
                  >
                    {r.booths ?? "—"}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-secondary)" }}>{r.typical}</td>
                  {r.need.map((n, i) => {
                    const delta = n - r.typical;
                    const short = r.short[i];
                    return (
                      <td key={days[i].date}
                        title={short ? `At ${fmtHour(short.hour)} the ${short.where ?? "plaza's"} booths are full: about ${fmtInt(short.vehicles)} vehicles an hour queue with every one of them open.` : undefined}
                        style={{
                          padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: delta !== 0 ? 800 : 500,
                          color: delta > 0 ? "var(--color-danger)" : delta < 0 ? "var(--color-success)" : "var(--text-primary)",
                          background: delta > 0 || short ? "color-mix(in srgb, var(--color-danger) 7%, transparent)" : undefined,
                        }}>
                        {n}{delta !== 0 && <span style={{ fontSize: "0.66rem", marginLeft: 3 }}>{delta > 0 ? `+${delta}` : delta}</span>}
                        {short && <b style={{ color: "var(--color-danger)", marginLeft: 3 }}>!</b>}
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
        <button onClick={() => setShowAll((v) => !v)} style={{
          alignSelf: "flex-start", border: "1px solid var(--border-strong)", background: "var(--bg-surface)", color: "var(--text-secondary)",
          borderRadius: 999, padding: "4px 12px", fontSize: "0.72rem", fontWeight: 700, cursor: "pointer",
        }}>
          {showAll ? "Show the 8 busiest" : `Show all ${rows.length} plazas`}
        </button>
      )}

      <Foot>
        Volume is the {data.champion.model ?? "champion"} forecast
        {data.champion.wmapePct != null && <> (WMAPE {data.champion.wmapePct}%)</>}
        {!data.champion.accepted && <>, which did <b>not</b> pass its acceptance gate — the staffing SHAPE comes from measured profiles, the level it is scaled to is less certain</>}.
        {data.basis.forecastFrom && data.basis.profileTo && data.basis.forecastFrom <= data.basis.profileTo ? (
          // Traffic was loaded after the model was trained: the "week ahead" is then a stretch the record already holds.
          <> <b>Its first day, {data.basis.forecastFrom}, is already inside the record, which now runs to {data.basis.profileTo}:
          the model was trained before the latest traffic was loaded, so this plan is for days already past. Retrain the volume models to plan the coming week.</b></>
        ) : (
          <> Its first day, {data.basis.forecastFrom}, follows the last recorded day.</>
        )}
        Profiles measured over {data.basis.profileFrom} to {data.basis.profileTo} across {data.basis.plazasProfiled} plazas.
        Booth counts are from {data.basis.boothsFrom}, since the warehouse holds none: each plaza&apos;s booths for the movement
        that pays there, per carriageway where known
        {noBooths.length > 0 && <>; {listOf(noBooths)} {noBooths.length === 1 ? "has" : "have"} none mapped, so {noBooths.length === 1 ? "it is" : "they are"} not capped</>}.
        Booth throughput is the one figure that is yours to set.
      </Foot>
    </Shell>
  );
}

/* ==================================================================== 2 ====
 * Congestion response advisory.
 */
export function CongestionResponsePanel() {
  /* The fuzzy controller runs server-side now (traffic-prescriptive.service.ts)
     against the same forecast rows this panel used to read. Same memberships,
     same nine rules, same centroid defuzzification — verified against an
     independent reimplementation on all 20 segments before this was switched
     over, because moving a model is only safe if it still gives the same
     answer. Throughput is irrelevant to this half, so the default is fine. */
  const [showRest, setShowRest] = useState(false);
  const { data, error } = usePrescriptive(350);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.congestion.map((c) => ({
      segment: c.segment,
      km: c.km ?? 0,
      // The server reports the hour its winning row came from, and always as
      // the probability of HIGH, so these read the same way round as before.
      first: c.hoursAhead,
      peak: c.probability,
      peakHour: c.hoursAhead,
      urgency: c.urgency,
      label: c.label,
    }));
  }, [data]);

  if (error) return <Empty msg={`Prescriptive traffic unavailable: ${error}`} />;
  if (!data) return <Empty msg="Ranking segments…" />;
  if (rows.length === 0) return <Empty msg="No congestion forecast available." />;

  const act = rows.filter((r) => r.label === "Act");
  const prepare = rows.filter((r) => r.label === "Prepare");
  const top = act.slice(0, 3);
  const rest = rows.filter((r) => !top.includes(r) && r.label !== "Monitor");
  const lead = top.length ? Math.min(...top.map((r) => r.first ?? 99)) : null;
  // A segment with no forecast rows is not a quiet segment. It is named, and
  // "corridor clear" is not said while any is missing.
  const missing = data.congestionMissing ?? [];

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
        ) : missing.length > 0 ? (
          <><b>No forecast segment crosses Prepare</b> inside the 12-hour horizon, but {missing.length} segment{missing.length === 1 ? " has" : "s have"} no forecast at all.</>
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
              {r.first != null ? (
                <>
                  <span>First High <b style={{ color: "var(--text-primary)" }}>+{r.first}h</b></span>
                  <span>Peak <b style={{ color: "var(--text-primary)" }}>{Math.round(r.peak * 100)}%</b> at +{r.peakHour}h</span>
                </>
              ) : (
                <span style={{ fontStyle: "italic" }}>Never reaches High inside the horizon</span>
              )}
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

      {missing.length > 0 && (
        <div style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>
          <b style={{ color: "var(--color-warning)" }}>No forecast:</b> {listOf(missing)}. Not ranked, and not clear either:
          treat {missing.length === 1 ? "it" : "them"} as unknown until the congestion model next runs.
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
