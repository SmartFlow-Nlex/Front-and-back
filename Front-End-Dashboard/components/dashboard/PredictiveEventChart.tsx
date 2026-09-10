"use client";

import { useEffect, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";

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
type UpcomingEvent = { date: string; title: string; isDerived: boolean; capacity: number | null; exits: UpcomingExit[] };

const SURGE_COLOR = "#e11d48";
const SHARE_COLORS = ["#e11d48", "#fb7185", "#fecdd3", "#a3a3a3"];

const fmtVeh = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n));

// Mainline barriers, ramps and spur roads are toll points, not exits people
// leave the expressway from — worth separating so "Bocaue Barrier" is not
// mistaken for the "Bocaue Interchange" that the event actually hits.
const NON_EXIT = /barrier|ramp|spur/i;

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

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
    fetch(`${BACKEND}/api/traffic/forecast`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled || !json.success || !json.data?.events?.length) return;
        setRaw(json.data.events as RawRow[]);
        if (Array.isArray(json.data?.eventSurgeMetrics)) setVal(json.data.eventSurgeMetrics);
        if (Array.isArray(json.data?.upcomingEvents)) setUpcoming(json.data.upcomingEvents as UpcomingEvent[]);
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

  // Where the surge concentrates — one 100% bar, labelled in the key below so
  // slivers do not go unexplained.
  const shareOption: EChartsOption = {
    grid: { left: 0, right: 0, top: 2, bottom: 2 },
    tooltip: {
      trigger: "item",
      backgroundColor: "rgba(255,255,255,0.97)",
      borderColor: "#e2e8f0",
      borderWidth: 1,
      textStyle: { color: "#334155" },
      formatter: (params: unknown) => {
        const p = params as { seriesName: string; value: number };
        const r = affected.find((x) => x.exit === p.seriesName);
        return `<b>${p.seriesName}</b><br/>${p.value.toFixed(0)}% of the surge${r ? `<br/>+${fmtVeh(r.added)} vehicles` : ""}`;
      },
    },
    xAxis: { type: "value", max: 100, show: false },
    yAxis: { type: "category", data: [""], show: false },
    series: affected.map((r, i) => ({
      name: r.exit,
      type: "bar" as const,
      stack: "share",
      barWidth: 22,
      data: [r.shareOfSurge],
      itemStyle: {
        color: SHARE_COLORS[i % SHARE_COLORS.length],
        borderRadius: i === 0 ? [5, 0, 0, 5] : i === affected.length - 1 ? [0, 5, 5, 0] : 0,
      },
      label: {
        show: r.shareOfSurge > 14,
        position: "inside" as const,
        formatter: `${r.shareOfSurge.toFixed(0)}%`,
        color: i === 0 ? "#fff" : "#7f1d1d",
        fontSize: 11,
        fontWeight: 800,
      },
    })),
  };

  const kpi = (label: string, value: string, sub: string, tone?: string) => (
    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "11px 13px" }}>
      <div style={{ fontSize: "0.68rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: "1.1rem", fontWeight: 700, color: tone ?? "#0f172a", margin: "2px 0 1px" }}>{value}</div>
      <div style={{ fontSize: "0.72rem", color: "#94a3b8" }}>{sub}</div>
    </div>
  );

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

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "16px", marginTop: "24px" }}>
      <div>
        <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em", display: "flex", alignItems: "center", gap: "8px" }}>
          Event Surge Impact by Exit
          {/* This said "Prophet". No Prophet model ever touched this panel — the
              badge was a hardcoded string sitting above three hand-typed rows.
              It now states what the numbers actually are. */}
          {chosen ? (
            <span style={{ fontSize: "0.72rem", padding: "2px 8px", background: "#fff1f2", borderRadius: "999px", border: "1px solid #fecdd3", color: "#9f1239", fontWeight: 600 }}>
              Forecast · {chosenDate}
            </span>
          ) : (
            <span style={{ fontSize: "0.72rem", padding: "2px 8px", background: "#ecfdf5", borderRadius: "999px", border: "1px solid #a7f3d0", color: "#047857", fontWeight: 600 }}>
              Observed{meta?.nEvents ? ` · ${meta.nEvents} past event days` : ""}
            </span>
          )}
          {/* The uplift table is descriptive. This badge reports the SEPARATE
              out-of-sample test — earlier events fitted, later events held out —
              so the panel states plainly what has and has not been validated. */}
          {champ?.wmape != null && (
            <span
              title={champ.diagnosis ?? undefined}
              style={{
                fontSize: "0.72rem", padding: "2px 8px", borderRadius: "999px", fontWeight: 600,
                background: champ.accepted ? "#eff6ff" : "#fef2f2",
                border: `1px solid ${champ.accepted ? "#bfdbfe" : "#fecaca"}`,
                color: champ.accepted ? "#1d4ed8" : "#b91c1c",
              }}
            >
              {champ.accepted ? "✓ tested" : "failed test"} · {champ.wmape.toFixed(1)}% error on held-out events
            </span>
          )}
        </h3>
        <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
          {chosen ? (
            <>
              During <b style={{ color: "#0f172a" }}>{chosen.title}</b>
              {chosen.isDerived && <span title="A recurring event the ETL inferred from prior years, not an announced date."> (recurring, inferred)</span>}
              {" "}on <b>{chosenDateLong}</b>{chosenLead != null && chosenLead >= 0 && <> · in {chosenLead} day{chosenLead === 1 ? "" : "s"}</>}: expected extra vehicles per exit, ranked
            </>
          ) : (
            <>Extra vehicles on past <b>{eventName}</b> days, ranked</>
          )}
          <span
            style={{ cursor: "help" }}
            title={`Baseline is the same weekday and month on non-event days, so events cannot inflate their own baseline.${
              meta?.firstEvent && meta?.lastEvent ? ` Events span ${meta.firstEvent} to ${meta.lastEvent}.` : ""
            }`}
          >
            {" "}· method ⓘ
          </span>
        </p>
      </div>

      {/* What the card is showing: what past events did, or the forecast for a
          specific upcoming day. Multi-day runs appear once per day because the
          numbers differ by weekday; the day index says which night it is. */}
      {upcoming.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.7rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, marginRight: 4 }}>Show</span>
          {[null, ...upcoming.map((_, i) => i)].map((i) => {
            const u = i == null ? null : upcoming[i];
            const active = i === selUpcoming;
            const nth = u ? upcoming.slice(0, i! + 1).filter((x) => x.title === u.title).length : 0;
            const multi = u ? upcoming.filter((x) => x.title === u.title).length > 1 : false;
            const d = u ? new Date(`${u.date}T00:00:00`) : null;
            return (
              <button key={u ? u.date : "past"} onClick={() => setSelUpcoming(i)} title={u?.title} style={{
                padding: "4px 10px", borderRadius: "999px", fontSize: "0.72rem", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
                border: `1px solid ${active ? SURGE_COLOR : "#dce2ef"}`,
                background: active ? SURGE_COLOR : "#fff",
                color: active ? "#fff" : "#475569",
              }}>
                {u && d
                  ? `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${u.title.split(" - ")[0]}${multi ? ` (day ${nth})` : ""}`
                  : "Past events (observed)"}
              </button>
            );
          })}
        </div>
      )}

      {/* Plain-language read, so the card lands without decoding the bars */}
      <div style={{ padding: "11px 14px", background: "#fff1f2", border: "1px solid #fecdd3", borderRadius: "8px", fontSize: "0.86rem", color: "#9f1239", lineHeight: 1.5 }}>
        {/* Was four clauses ending in a recommendation. The "exits affected"
            count is already a KPI card directly below, so the banner keeps only
            the single fact a reader needs first. */}
        {chosen ? (
          <>On <b>{chosenDate}</b> ({chosen.title.split(" - ")[0]}), expect <b>+{fmtVeh(totalAdded)}</b> extra vehicles across {affected.length} exits;{" "}
          <b>{top.exit}</b> takes {top.shareOfSurge.toFixed(0)}% of it — {multiple.toFixed(1)}× its normal{" "}
          {new Date(`${chosen.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" })}, +{fmtVeh(top.added)} vehicles.</>
        ) : (
          <><b>{top.exit}</b> takes {top.shareOfSurge.toFixed(0)}% of the event surge — {multiple.toFixed(1)}× a
          normal day, +{fmtVeh(top.added)} vehicles.</>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(165px, 1fr))", gap: "10px" }}>
        {kpi("Extra vehicles", `+${fmtVeh(totalAdded)}`, "across affected exits", SURGE_COLOR)}
        {kpi("Uplift at those exits", `+${((totalAdded / affectedBaseline) * 100).toFixed(0)}%`, "vs their normal-day volume", SURGE_COLOR)}
        {kpi("Hardest hit", top.exit, `${multiple.toFixed(1)}× normal · ${top.shareOfSurge.toFixed(0)}% of the surge`)}
        {kpi("Exits affected", `${affected.length} of ${totalPlazas}`, chosen ? "toll points with a material uplift; the rest run normally" : "toll points; the rest run normally")}
      </div>

      <div style={{ width: "100%", height: `${impactHeight}px` }}>
        <DashboardChart option={impactOption} height={impactHeight} />
      </div>

      <div>
        <div style={{ fontSize: "0.7rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, marginBottom: "6px" }}>
          Where the surge lands
        </div>
        <div style={{ width: "100%", height: "26px" }}>
          <DashboardChart option={shareOption} height={26} />
        </div>
        {/* Key — every slice is named here, including ones too thin to label */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "14px", marginTop: "8px" }}>
          {affected.map((r, i) => (
            <span key={r.exit} style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "0.76rem", color: "#64748b", whiteSpace: "nowrap" }}>
              <span style={{ width: 10, height: 10, borderRadius: "3px", background: SHARE_COLORS[i % SHARE_COLORS.length] }} />
              <b style={{ color: "#334155" }}>{r.exit}</b> {r.shareOfSurge.toFixed(0)}%
              <span style={{ color: "#cbd5e1" }}>+{fmtVeh(r.added)}</span>
            </span>
          ))}
        </div>
      </div>

      {champ?.wmape != null && (
        <details style={{ fontSize: "0.72rem", color: "#64748b" }}>
          {/* This was an always-visible paragraph naming every candidate and its
              score. All of it is still here, but a reader who just wants to know
              which exits are affected no longer has to scroll past it. */}
          <summary style={{ cursor: "pointer", color: "#475569", fontWeight: 600 }}>
            How this was validated
          </summary>
          <p style={{ margin: "6px 0 0", lineHeight: 1.55 }}>
            Per-exit uplift is fitted on earlier events and scored on later ones it never saw
            ({champ.diagnosis}), reaching{" "}
            <b style={{ color: "#334155" }}>{champ.wmape.toFixed(2)}% WMAPE</b>
            {noAdj?.wmape != null && <> against <b style={{ color: "#334155" }}>{noAdj.wmape.toFixed(2)}%</b> for
              ignoring the event entirely</>}
            .{" "}
            {others.length > 0 && (
              <>
                Ranked against{" "}
                {others.map((o, i) => (
                  <span key={o.model}>
                    {i > 0 && ", "}
                    {o.model} {o.wmape?.toFixed(2)}%
                  </span>
                ))}
                .{" "}
              </>
            )}
            The uplift was fitted on event days inferred from the arena exit&apos;s own spikes.{" "}
            {chosen
              ? <>The day shown applies that uplift to the exit&apos;s normal volume for the same weekday and month; the uplift is one figure per exit and does not yet vary with the act or its announced capacity.</>
              : <>&ldquo;Past events&rdquo; describes what those days did; pick an upcoming date above to see the forecast for it.</>}
          </p>
        </details>
      )}

      {minorAffected.length > 0 && (
        <p style={{ fontSize: "0.72rem", color: "#64748b", margin: 0 }}>
          <b style={{ color: "#334155" }}>{minorAffected.length} smaller rises</b> not charted (each under 4% of
          the surge, {minorAffected.reduce((a, r) => a + r.shareOfSurge, 0).toFixed(0)}% combined):{" "}
          {minorAffected.map((r) => `${r.exit} +${fmtVeh(r.added)}`).join(" · ")}
        </p>
      )}

      {otherExits.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", marginBottom: "6px" }}>
            <div style={{ fontSize: "0.7rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>
              Other exits · no forecast change
            </div>
            {otherExits.length > VISIBLE_OTHERS && (
              <button
                onClick={() => setShowAllOthers((v) => !v)}
                style={{ border: "1px solid #dce2ef", background: "#fff", borderRadius: "999px", padding: "3px 11px", fontSize: "0.72rem", fontWeight: 600, color: "#475569", cursor: "pointer" }}
              >
                {showAllOthers ? "Show fewer" : `Show all ${otherExits.length}`}
              </button>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {shownOthers.map((o) => (
              <span
                key={o.exit}
                title={`${o.exit} — ${fmtVeh(o.baseline)} vehicles/day, no event surge forecast`}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "6px",
                  padding: "3px 9px", borderRadius: "999px",
                  background: "#f8fafc", border: "1px solid #e2e8f0",
                  fontSize: "0.72rem", color: "#64748b", whiteSpace: "nowrap",
                }}
              >
                {o.exit}
                <span style={{ color: "#cbd5e1" }}>{fmtVeh(o.baseline)}</span>
              </span>
            ))}
          </div>
          {otherPoints.length > 0 && (
            <p style={{ fontSize: "0.72rem", color: "#94a3b8", margin: "8px 0 0 0", lineHeight: 1.5 }}>
              Excludes {otherPoints.length} mainline barriers, ramps and spur roads ({otherPoints.slice(0, 3).map((p) => p.exit).join(", ")}
              {otherPoints.length > 3 ? "…" : ""}), which are toll points rather than exits. Note <b>Bocaue Barrier</b> is a
              mainline barrier and is separate from the <b>Bocaue Interchange</b> exit above.
            </p>
          )}
        </div>
      )}
    </article>
  );
}
