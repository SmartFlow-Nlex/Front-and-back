"use client";

import { useEffect, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import { loadForecast } from "./prescriptiveTraffic.shared";

type RawRow = {
  exit: string;
  event: string | null;
  baseline: number | string;
  surge: number | string | null;
  uplift: number | string | null;
  upliftLo?: number | string | null;
  upliftHi?: number | string | null;
  nEvents?: number | null;
  material?: boolean | null;
  method?: string | null;
  anchorExit?: string | null;
  firstEvent?: string | null;
  lastEvent?: string | null;
};

type Row = {
  exit: string;
  baseline: number;
  surge: number;
  added: number;
  pct: number;
  shareOfSurge: number;
};

// One upcoming Arena event DAY with its dated per-exit forecast, as served on
// /api/traffic/forecast.upcomingEvents (see getUpcomingEventSurge). Baseline is
// that exit's median volume on the same weekday in the same month, times the
// measured uplift -- the same construction the observed rows use, applied to a
// real date.
type UpcomingExit = { exit: string; baseline: number; surge: number; surgeLo: number; surgeHi: number; uplift: number; nEvents: number };
type UpcomingEvent = { date: string; title: string; isDerived: boolean; capacity: number | null; venue: string | null; exits: UpcomingExit[] };

// The uplift was measured on Philippine Arena days. Events elsewhere in the
// same complex reach the same exit but not at the same scale, so the card
// names the venue whenever it is not the Arena.
const isArena = (venue: string | null) => !venue || /arena/i.test(venue);

const SURGE_COLOR = "#e11d48";

const fmtVeh = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n));

// Mainline barriers, ramps and spur roads are toll points, not exits people
// leave the expressway from — worth separating so "Bocaue Barrier" is not
// mistaken for the "Bocaue Interchange" that the event actually hits.
const NON_EXIT = /barrier|ramp|spur/i;


export default function PredictiveEventChart() {
  const [raw, setRaw] = useState<RawRow[] | null>(null);
  // Out-of-sample result from eval_event_surge.py. The uplift table itself is
  // descriptive; this is the separate check that it predicts unseen events.
  const [val, setVal] = useState<{ model: string; wmape: number | null; accepted: boolean; diagnosis: string | null }[]>([]);
  const [showAllOthers, setShowAllOthers] = useState(false);
  // The schedule of upcoming Arena days, and which one is open. null means the
  // card shows what PAST events did (the observed uplift); an index means it
  // shows the forecast for that specific day.
  const [upcoming, setUpcoming] = useState<UpcomingEvent[]>([]);
  const [selUpcoming, setSelUpcoming] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Shared, cached fetch -- see prescriptiveTraffic.shared. This card used to
    // request the same ~600 KB payload the volume and congestion cards had
    // already asked for.
    loadForecast()
      .then((fc) => {
        if (cancelled || fc.events.length === 0) return;
        setRaw(fc.events as unknown as RawRow[]);
        if (Array.isArray(fc.extras.eventSurgeMetrics)) setVal(fc.extras.eventSurgeMetrics as typeof val);
        setUpcoming(fc.upcomingEvents as unknown as UpcomingEvent[]);
      })
      .catch((err) => console.error("Failed to fetch ML event surge forecast", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const chosen = selUpcoming != null ? upcoming[selUpcoming] ?? null : null;

  /* When an upcoming day is chosen, its dated rows take the place of the
     observed ones and everything below -- bars, share, KPIs, banner -- follows
     with no second code path. Exits the forecast does not list (uplift not
     material) are kept from the observed set with surge nulled, so the "no
     forecast change" list beneath stays populated and nothing disappears. */
  const effectiveRaw = useMemo<RawRow[] | null>(() => {
    if (!raw) return null;
    if (!chosen) return raw;
    const dated = new Map(chosen.exits.map((x) => [x.exit, x]));
    return raw.map((r) => {
      const x = dated.get(r.exit);
      return x
        ? { ...r, event: chosen.title, baseline: x.baseline, surge: x.surge, uplift: x.uplift, material: true, nEvents: x.nEvents }
        : { ...r, baseline: r.baseline, surge: null, material: false };
    });
  }, [raw, chosen]);

  const model = useMemo(() => {
    const raw = effectiveRaw;
    if (!raw || raw.length === 0) return null;

    const affected: Row[] = raw
      // `material` is set by build_event_surge.py: the lower quartile of the
      // observed uplift must still be above normal. An exit whose IQR straddles
      // 1.0 rose on some event days and fell on others, which is noise, not an
      // effect — listing it as "affected" would overstate the corridor's spread.
      .filter((d) => d.surge != null && d.material !== false)
      .map((d) => {
        const baseline = Number(d.baseline);
        const surge = Number(d.surge);
        const added = surge - baseline;
        return { exit: d.exit, baseline, surge, added, pct: baseline > 0 ? (added / baseline) * 100 : 0, shareOfSurge: 0 };
      })
      .sort((a, b) => b.added - a.added);
    if (affected.length === 0) return null;

    const totalAdded = affected.reduce((s, r) => s + r.added, 0);
    affected.forEach((r) => (r.shareOfSurge = totalAdded > 0 ? (r.added / totalAdded) * 100 : 0));

    const rest = raw
      .filter((d) => d.surge == null || d.material === false)
      .map((d) => ({ exit: d.exit, baseline: Number(d.baseline) }))
      .sort((a, b) => b.baseline - a.baseline);

    return {
      affected,
      // ECharts lays a category axis out bottom-up.
      //
      // Only the exits carrying a MEANINGFUL share are plotted. Thirteen bars,
      // seven of them under 4% of the surge, buried the two that carry half of
      // it — the long tail cost as much vertical space as the finding. The rest
      // are still listed below the chart, so nothing disappears.
      rows: [...affected.filter((r) => r.shareOfSurge >= 4)].reverse(),
      minorAffected: affected.filter((r) => r.shareOfSurge < 4),
      otherExits: rest.filter((r) => !NON_EXIT.test(r.exit)),
      otherPoints: rest.filter((r) => NON_EXIT.test(r.exit)),
      totalAdded,
      affectedBaseline: affected.reduce((s, r) => s + r.baseline, 0),
      eventName: raw.find((d) => d.event)?.event ?? "the upcoming event",
      totalPlazas: raw.length,
    };
  }, [effectiveRaw]);

  if (!model) {
    return (
      <article className="chart-card wide" style={{ padding: "24px", marginTop: "24px" }}>
        <div style={{ color: "#64748b" }}>Loading ML event surge forecast from AWS…</div>
      </article>
    );
  }

  const { affected, rows, minorAffected, otherExits, otherPoints, totalAdded, affectedBaseline, eventName, totalPlazas } = model;
  const top = affected[0];
  const multiple = top.surge / top.baseline;

  // Sorted bar of the ADDED vehicles only, every bar starting at zero.
  // The previous stacked form began each red segment at that exit's baseline —
  // three different x positions — so comparing the surges meant judging
  // floating lengths, the one thing bar charts are bad at. Length from a common
  // zero is the most accurate comparison available, and it stops the smallest
  // exit collapsing into a sliver.
  const impactOption: EChartsOption = {
    grid: { left: 152, right: 210, top: 10, bottom: 36 },
    tooltip: {
      trigger: "item",
      backgroundColor: "rgba(255,255,255,0.97)",
      borderColor: "#e2e8f0",
      borderWidth: 1,
      textStyle: { color: "#334155" },
      extraCssText: "box-shadow: 0 6px 16px rgba(15,23,42,0.12); border-radius: 8px;",
      formatter: (params: unknown) => {
        const r = rows[(params as { dataIndex: number }).dataIndex];
        return `
          <div style="padding:2px 4px; min-width:225px;">
            <b style="font-size:1.05em; color:#0f172a;">${r.exit}</b>
            <div style="margin-top:8px; display:grid; grid-template-columns:120px 1fr; gap:5px 8px; font-size:0.9em;">
              <span style="color:#64748b;">Added by event</span><span style="font-weight:700; color:${SURGE_COLOR};">+${fmtVeh(r.added)} (+${r.pct.toFixed(0)}%)</span>
              <span style="color:#64748b;">Normal day</span><span style="font-weight:600;">${fmtVeh(r.baseline)}</span>
              <span style="color:#64748b;">With event</span><span style="font-weight:600; color:${SURGE_COLOR};">${fmtVeh(r.surge)}</span>
              <span style="color:#64748b;">Share of surge</span><span style="font-weight:500;">${r.shareOfSurge.toFixed(0)}%</span>
            </div>
          </div>`;
      },
    },
    xAxis: {
      type: "value",
      name: "Extra vehicles per day",
      nameLocation: "middle",
      nameGap: 26,
      nameTextStyle: { color: "#94a3b8", fontSize: 11 },
      axisLabel: { color: "#94a3b8", formatter: (v: number) => (v === 0 ? "0" : `+${fmtK(v)}`), fontSize: 11 },
      splitLine: { lineStyle: { color: "#eef2f7", type: "dashed" } },
    },
    yAxis: {
      type: "category",
      data: rows.map((r) => r.exit),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: "#0f172a", fontWeight: 700, fontSize: 12 },
    },
    series: [
      {
        name: "Added by event",
        type: "bar",
        barMaxWidth: 26,
        data: rows.map((r) => r.added),
        itemStyle: { color: SURGE_COLOR, borderRadius: [0, 5, 5, 0] },
        label: {
          show: true,
          position: "right",
          distance: 10,
          formatter: (params: unknown) => {
            const r = rows[(params as { dataIndex: number }).dataIndex];
            // The "50,890 -> 63,119 · 1.2x normal" second line repeated on
            // every bar and is already in the tooltip. The bar carries the
            // two numbers a reader actually scans for.
            return `{add|+${fmtVeh(r.added)}}  {pct|+${r.pct.toFixed(0)}%}`;
          },
          rich: {
            add: { color: SURGE_COLOR, fontWeight: 800, fontSize: 13, lineHeight: 17 },
            pct: { color: "#fb7185", fontWeight: 700, fontSize: 11, lineHeight: 17 },
            ctx: { color: "#94a3b8", fontSize: 10, lineHeight: 14 },
          },
        },
      },
    ],
  };

  // Provenance travels on the rows; take it from the first that has it.
  const meta = (raw ?? []).find((r) => r.nEvents != null) ?? null;
  const chosenDate = chosen ? new Date(`${chosen.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "";
  const chosenDateLong = chosen ? new Date(`${chosen.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "";
  const chosenLead = chosen ? Math.round((new Date(`${chosen.date}T00:00:00`).getTime() - Date.now()) / 86400000) : null;
  const champ = val.find((v) => !/baseline/i.test(v.model)) ?? null;
  const noAdj = val.find((v) => /no event/i.test(v.model)) ?? null;
  const others = val.filter((v) => !/baseline/i.test(v.model) && v.model !== champ?.model);
  const impactHeight = Math.max(rows.length * 56 + 62, 220);
  const VISIBLE_OTHERS = 8;
  const shownOthers = showAllOthers ? otherExits : otherExits.slice(0, VISIBLE_OTHERS);
  // How concentrated the surge is: the share the two biggest exits carry
  // between them. Replaces a stacked strip plus a thirteen-item key that said
  // the same thing at ten times the height.
  const top2Share = affected.slice(0, 2).reduce((a, r) => a + r.shareOfSurge, 0);
  const shortTitle = (t: string) => t.split(" - ")[0];

  /* Layout, from top: what am I looking at (title, mode, controls) -> the one
     sentence that is the finding -> four numbers -> the chart -> everything
     else behind a single disclosure. The previous card stacked ten regions --
     a banner, four tiles and a share legend all restating the top exit -- and
     read as a pile. Each fact now appears once, at the level it earns. */
  const stat = (value: string, label: string, tone?: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <span style={{ fontSize: "1.05rem", fontWeight: 800, color: tone ?? "#0f172a", letterSpacing: "-0.01em", fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{value}</span>
      <span style={{ fontSize: "0.68rem", color: "#64748b", whiteSpace: "nowrap" }}>{label}</span>
    </div>
  );

  return (
    <article className="chart-card wide" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: "14px", marginTop: "24px" }}>
      {/* Row 1: title on the left, provenance on the right. */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          Event Surge Impact by Exit
          <InfoTooltip text="Extra vehicles each exit takes on a Philippine Arena event day versus a normal day. Choose a past pattern or an upcoming event above." />
        </h3>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {chosen ? (
            <span style={{ fontSize: "0.7rem", padding: "2px 8px", background: "#fff1f2", borderRadius: "999px", border: "1px solid #fecdd3", color: "#9f1239", fontWeight: 600, whiteSpace: "nowrap" }}>
              Forecast · {chosenDate}
            </span>
          ) : (
            <span style={{ fontSize: "0.7rem", padding: "2px 8px", background: "#ecfdf5", borderRadius: "999px", border: "1px solid #a7f3d0", color: "#047857", fontWeight: 600, whiteSpace: "nowrap" }}>
              Observed{meta?.nEvents ? ` · ${meta.nEvents} past event days` : ""}
            </span>
          )}
          {champ?.wmape != null && (
            <span
              title={champ.diagnosis ?? undefined}
              style={{
                fontSize: "0.7rem", padding: "2px 8px", borderRadius: "999px", fontWeight: 600, whiteSpace: "nowrap",
                background: champ.accepted ? "#eff6ff" : "#fef2f2",
                border: `1px solid ${champ.accepted ? "#bfdbfe" : "#fecaca"}`,
                color: champ.accepted ? "#1d4ed8" : "#b91c1c",
              }}
            >
              {champ.accepted ? "✓ tested" : "failed test"} · {champ.wmape.toFixed(1)}% error held-out
            </span>
          )}
        </div>
      </div>

      {/* Row 2: what is shown. A select, not seven pills -- the pills wrapped to
          three lines and pushed the finding below the fold. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: "0.8rem", color: "#64748b" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", fontSize: "0.68rem" }}>Showing</span>
          <select
            value={selUpcoming == null ? "" : String(selUpcoming)}
            onChange={(e) => setSelUpcoming(e.target.value === "" ? null : Number(e.target.value))}
            style={{
              font: "inherit", fontWeight: 600, color: "#0f172a", background: "#fff",
              border: "1px solid #dce2ef", borderRadius: 8, padding: "5px 10px", cursor: "pointer", maxWidth: 360,
            }}
          >
            <option value="">Past events — what {eventName === "the upcoming event" ? "event" : eventName} days did</option>
            {upcoming.map((u, i) => {
              // Group nights by the act, not the full title: the source spells
              // BTS's three nights two different ways ("BTS - Arirang World
              // Tour", "BTS - BTS WORLD TOUR 'ARIRANG'"), which by full title
              // read as one lone night plus a two-night run.
              const act = shortTitle(u.title);
              const nth = upcoming.slice(0, i + 1).filter((x) => shortTitle(x.title) === act).length;
              const multi = upcoming.filter((x) => shortTitle(x.title) === act).length > 1;
              const d = new Date(`${u.date}T00:00:00`);
              return (
                <option key={u.date} value={String(i)}>
                  {d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })} — {shortTitle(u.title)}{multi ? ` (day ${nth})` : ""}{isArena(u.venue) ? "" : ` · ${u.venue}`}
                </option>
              );
            })}
          </select>
        </label>
        <span
          style={{ cursor: "help" }}
          title={`Baseline is the same weekday and month on non-event days, so events cannot inflate their own baseline.${
            meta?.firstEvent && meta?.lastEvent ? ` Events span ${meta.firstEvent} to ${meta.lastEvent}.` : ""
          }`}
        >
          method ⓘ
        </span>
      </div>

      {/* Row 3: the finding, in one sentence, event first. */}
      <div style={{ padding: "12px 14px", background: "#fff1f2", border: "1px solid #fecdd3", borderRadius: "10px", fontSize: "0.88rem", color: "#9f1239", lineHeight: 1.5 }}>
        {chosen ? (
          <>
            During <b>{shortTitle(chosen.title)}</b>
            {chosen.isDerived && <span title="A recurring event the ETL inferred from prior years, not an announced date." style={{ opacity: 0.8 }}> (inferred)</span>}
            {!isArena(chosen.venue) && (
              <span style={{ opacity: 0.85 }}> at {chosen.venue}{chosen.capacity ? ` (${fmtVeh(chosen.capacity)} capacity)` : ""}</span>
            )}
            {" "}on <b>{chosenDateLong}</b>
            {chosenLead != null && chosenLead >= 0 && <> · in {chosenLead} day{chosenLead === 1 ? "" : "s"}</>}: expect{" "}
            <b>+{fmtVeh(totalAdded)}</b> extra vehicles. <b>{top.exit}</b> takes {top.shareOfSurge.toFixed(0)}% of it,{" "}
            {multiple.toFixed(1)}× its normal {new Date(`${chosen.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" })}.
          </>
        ) : (
          <>
            On a <b>{eventName}</b> day, <b>{top.exit}</b> takes {top.shareOfSurge.toFixed(0)}% of the surge —{" "}
            {multiple.toFixed(1)}× a normal day, +{fmtVeh(top.added)} vehicles.
          </>
        )}
      </div>

      {/* Row 4: the numbers, once each, on one line. */}
      {/* Two by two, not auto-fit: in a half-width card four stats wrapped 3+1
          and left the last one orphaned on its own line. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px 16px", padding: "10px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10 }}>
        {stat(`+${fmtVeh(totalAdded)}`, "extra vehicles", SURGE_COLOR)}
        {stat(`${affected.length} of ${totalPlazas}`, "exits with a material rise")}
        {stat(`+${((totalAdded / affectedBaseline) * 100).toFixed(0)}%`, "uplift at those exits", SURGE_COLOR)}
        {stat(`${top2Share.toFixed(0)}%`, `carried by the top ${Math.min(2, affected.length)}`)}
      </div>

      {/* Row 5: the chart, with the room the strip and tiles were taking. */}
      <div style={{ width: "100%", height: `${impactHeight}px` }}>
        <DashboardChart option={impactOption} height={impactHeight} />
      </div>

      {/* Row 6: what a reviewer needs and an operator does not need first.
          Validation as a table, matching how the volume card above shows its
          models; the long tail and unchanged exits as one chip row, there so
          "13 of 19" can be checked, not to be read. */}
      <details style={{ fontSize: "0.76rem", color: "#64748b", borderTop: "1px solid #eef2f7", paddingTop: 10 }}>
        <summary style={{ cursor: "pointer", color: "#475569", fontWeight: 600, listStyle: "none", display: "flex", gap: 14, flexWrap: "wrap" }}>
          <span>Details</span>
          {champ?.wmape != null && <span style={{ color: "#94a3b8" }}>model comparison</span>}
          {(minorAffected.length > 0 || otherExits.length > 0) && (
            <span style={{ color: "#94a3b8" }}>the other {minorAffected.length + otherExits.length} exits</span>
          )}
        </summary>

        <div style={{ display: "grid", gap: 14, marginTop: 10 }}>
          {champ?.wmape != null && (
            <div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.74rem" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "#94a3b8", borderBottom: "1px solid #eef2f7" }}>
                    <th style={{ padding: "4px 6px", fontWeight: 600 }}>Model</th>
                    <th style={{ padding: "4px 6px", fontWeight: 600, textAlign: "right" }}>Error on held-out events</th>
                  </tr>
                </thead>
                <tbody>
                  {[champ, ...others].map((m, i) => (
                    <tr key={m.model} style={{ borderBottom: "1px solid #f1f5f9", color: i === 0 ? "#0f172a" : "#475569" }}>
                      <td style={{ padding: "4px 6px", fontWeight: i === 0 ? 700 : 500 }}>
                        {m.model}{i === 0 && <span style={{ marginLeft: 6, fontSize: "0.66rem", color: "#1d4ed8", fontWeight: 700 }}>used</span>}
                      </td>
                      <td style={{ padding: "4px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: i === 0 ? 700 : 500 }}>
                        {m.wmape != null ? `${m.wmape.toFixed(2)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                  {noAdj?.wmape != null && (
                    <tr style={{ color: "#94a3b8" }}>
                      <td style={{ padding: "4px 6px", fontStyle: "italic" }}>Ignoring the event</td>
                      <td style={{ padding: "4px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{noAdj.wmape.toFixed(2)}%</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <p style={{ margin: "6px 0 0", lineHeight: 1.5, color: "#94a3b8" }}>
                Fitted on earlier events, scored on later ones it never saw{champ.diagnosis ? ` (${champ.diagnosis})` : ""}.{" "}
                {chosen
                  ? <>The day shown applies each exit&apos;s uplift to its normal same-weekday, same-month volume; the uplift does not yet vary with the act or its capacity.
                      {!isArena(chosen.venue) && <> It was measured on Philippine Arena days; this event is at the {chosen.venue}, a smaller venue in the same complex, so treat the figures as an upper bound.</>}</>
                  : <>Choose an upcoming date above to see the forecast for it.</>}
              </p>
            </div>
          )}

          {(minorAffected.length > 0 || otherExits.length > 0) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {minorAffected.map((r) => (
                <span key={r.exit} title={`${r.exit}: +${fmtVeh(r.added)} vehicles, ${r.shareOfSurge.toFixed(1)}% of the surge — too small to chart`} style={{
                  display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px", borderRadius: "999px",
                  background: "#fff1f2", border: "1px solid #fecdd3", fontSize: "0.72rem", color: "#9f1239", whiteSpace: "nowrap",
                }}>
                  {r.exit}<b>+{fmtVeh(r.added)}</b>
                </span>
              ))}
              {shownOthers.map((o) => (
                <span key={o.exit} title={`${o.exit}: ${fmtVeh(o.baseline)} vehicles/day, no material event effect`} style={{
                  display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px", borderRadius: "999px",
                  background: "#fff", border: "1px solid #e2e8f0", fontSize: "0.72rem", color: "#94a3b8", whiteSpace: "nowrap",
                }}>
                  {o.exit}<span>no change</span>
                </span>
              ))}
              {otherExits.length > VISIBLE_OTHERS && (
                <button onClick={() => setShowAllOthers((v) => !v)} style={{ border: "1px solid #dce2ef", background: "#fff", borderRadius: "999px", padding: "3px 10px", fontSize: "0.7rem", fontWeight: 600, color: "#475569", cursor: "pointer" }}>
                  {showAllOthers ? "fewer" : `+${otherExits.length - VISIBLE_OTHERS} more`}
                </button>
              )}
              {otherPoints.length > 0 && (
                <span style={{ alignSelf: "center", fontSize: "0.7rem", color: "#94a3b8" }} title={otherPoints.map((x) => x.exit).join(", ")}>
                  · {otherPoints.length} barriers/ramps excluded
                </span>
              )}
            </div>
          )}
        </div>
      </details>
    </article>
  );
}
