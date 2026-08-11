"use client";

import { useEffect, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";

type State = "Low" | "Med" | "High";

type RawRow = { segment: string; hours: number; state: State; probability: number | string };

// Segments are laid out along the corridor, not alphabetically — congestion
// propagates between neighbours, and that pattern is only visible when the
// rows are in km-post order.
const KM_POST: Record<string, number> = {
  Balintawak: 0,
  "Mindanao Ave": 2,
  Karuhatan: 4,
  Valenzuela: 8,
  Meycauayan: 16,
  Marilao: 22,
  Bocaue: 26,
  Balagtas: 30,
  Tabang: 35,
  "Santa Rita": 40,
};

// Solid fills only. Confidence used to be encoded as opacity, which made a
// low-confidence SEVERE cell look calmer than a solid HEAVY one — the opacity
// channel fought the colour channel. Free flow is deliberately muted so the
// eye lands on the problems; label colours are chosen for contrast on the fill.
const STATE_META: Record<State, { rank: number; color: string; text: string; label: string; short: string; speed: string }> = {
  Low: { rank: 0, color: "#bbf7d0", text: "#166534", label: "Free flow", short: "", speed: "> 60 km/h" },
  Med: { rank: 1, color: "#fbbf24", text: "#7c2d12", label: "Heavy", short: "HEAVY", speed: "30–60 km/h" },
  High: { rank: 2, color: "#ef4444", text: "#ffffff", label: "Severe", short: "SEVERE", speed: "< 30 km/h" },
};

const LOW_CONF = 0.8;

type CellItem = { value: [number, number, number]; state: State; conf: number; label: { color: string } };
type Alert = { segment: string; state: State; from: number; to: number; conf: number };

export default function PredictiveCongestionChart() {
  const [raw, setRaw] = useState<RawRow[] | null>(null);
  const [alertsOpen, setAlertsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("http://localhost:4000/api/traffic/forecast")
      .then((r) => r.json())
      .then((json) => {
        if (cancelled || !json.success || !json.data.congestion) return;
        setRaw(json.data.congestion as RawRow[]);
      })
      .catch((err) => console.error("Failed to fetch ML congestion forecast", err));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!alertsOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAlertsOpen(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [alertsOpen]);

  const model = useMemo(() => {
    if (!raw || raw.length === 0) return null;

    const byKm = Array.from(new Set(raw.map((d) => d.segment))).sort(
      (a, b) => (KM_POST[a] ?? 999) - (KM_POST[b] ?? 999)
    );
    const maxHour = Math.max(...raw.map((d) => d.hours));
    const hourLabels = Array.from({ length: maxHour }, (_, i) => `+${i + 1}h`);

    // ECharts draws a category y-axis bottom-up, so reverse to read north-bound
    // down the page (Balintawak on top).
    const segments = [...byKm].reverse();

    const states: (State | null)[][] = segments.map(() => Array(maxHour).fill(null));
    const confs: number[][] = segments.map(() => Array(maxHour).fill(0));
    const cells: CellItem[] = [];

    raw.forEach((d) => {
      const y = segments.indexOf(d.segment);
      const x = d.hours - 1;
      if (y < 0 || x < 0 || x >= maxHour) return;
      const conf = Number(d.probability);
      states[y][x] = d.state;
      confs[y][x] = conf;
      const meta = STATE_META[d.state] ?? STATE_META.Low;
      cells.push({ value: [x, y, meta.rank], state: d.state, conf, label: { color: meta.text } });
    });

    // ---- Operational summary ----
    const atRisk = new Set<string>();
    const severeSegments = new Set<string>();
    let severeCells = 0;
    const perHour = Array(maxHour).fill(0) as number[];
    const perSegment = segments.map(() => 0);

    states.forEach((row, y) =>
      row.forEach((st, x) => {
        if (!st) return;
        if (st === "High") {
          severeCells++;
          severeSegments.add(segments[y]);
        }
        if (st !== "Low") {
          atRisk.add(segments[y]);
          perHour[x]++;
          perSegment[y]++;
        }
      })
    );

    // One alert per contiguous run of the same state — "Bocaue severe +4h→+6h"
    // instead of three near-identical cards.
    const alerts: Alert[] = [];
    states.forEach((row, y) => {
      let run: Alert | null = null;
      row.forEach((st, x) => {
        const on = st !== null && st !== "Low";
        if (on && run && run.state === st && run.to === x) {
          run.to = x + 1;
          run.conf = Math.max(run.conf, confs[y][x]);
        } else {
          if (run) alerts.push(run);
          run = on ? { segment: segments[y], state: st as State, from: x + 1, to: x + 1, conf: confs[y][x] } : null;
        }
      });
      if (run) alerts.push(run);
    });
    alerts.sort((a, b) => {
      const r = STATE_META[b.state].rank - STATE_META[a.state].rank;
      if (r !== 0) return r;
      const span = b.to - b.from - (a.to - a.from);
      return span !== 0 ? span : b.conf - a.conf;
    });

    const peakIdx = perHour.indexOf(Math.max(...perHour));
    const worstIdx = perSegment.indexOf(Math.max(...perSegment));
    const firstSevere = alerts.find((a) => a.state === "High");

    return {
      segments,
      hourLabels,
      cells,
      perHour,
      alerts,
      severeCount: alerts.filter((a) => a.state === "High").length,
      atRisk: atRisk.size,
      severeSegments: [...severeSegments],
      severeCells,
      peakHour: perHour[peakIdx] > 0 ? peakIdx + 1 : null,
      peakHourCount: perHour[peakIdx],
      worstSegment: perSegment[worstIdx] > 0 ? segments[worstIdx] : null,
      worstSegmentCount: perSegment[worstIdx],
      firstSevere,
      lowConfCount: cells.filter((c) => c.state !== "Low" && c.conf < LOW_CONF).length,
    };
  }, [raw]);

  if (!model) {
    return (
      <article className="chart-card wide" style={{ padding: "24px", marginTop: "24px" }}>
        <div style={{ color: "#64748b" }}>Loading ML congestion forecast from AWS…</div>
      </article>
    );
  }

  const { segments, hourLabels, cells, perHour, alerts } = model;
  const maxPerHour = Math.max(...perHour, 1);
  const heatTop = 34;
  const heatHeight = segments.length * 34;
  const stripTop = heatTop + heatHeight + 34;
  const stripHeight = 44;
  const chartHeight = stripTop + stripHeight + 20;

  const option: EChartsOption = {
    // A cartesian heatmap throws "Heatmap must use with visualMap" without
    // this — it is what drives the cell fill from the third data value.
    visualMap: {
      show: false,
      type: "piecewise",
      dimension: 2,
      seriesIndex: 0,
      pieces: [
        { value: 0, color: STATE_META.Low.color },
        { value: 1, color: STATE_META.Med.color },
        { value: 2, color: STATE_META.High.color },
      ],
    },
    title: [
      {
        text: "SEGMENTS CONGESTED PER HOUR",
        left: 0,
        top: stripTop - 20,
        textStyle: { fontSize: 10, fontWeight: 700, color: "#94a3b8" },
      },
    ],
    tooltip: {
      backgroundColor: "rgba(255,255,255,0.97)",
      borderColor: "#e2e8f0",
      borderWidth: 1,
      textStyle: { color: "#334155" },
      extraCssText: "box-shadow: 0 6px 16px rgba(15,23,42,0.12); border-radius: 8px;",
      formatter: (params: unknown) => {
        const p = params as { seriesIndex: number; data: CellItem | number; dataIndex: number };
        if (p.seriesIndex === 1) {
          const n = p.data as number;
          return `<b>${hourLabels[p.dataIndex]}</b><br/>${n} of ${segments.length} segments congested`;
        }
        const d = p.data as CellItem;
        const [x, y] = d.value;
        const meta = STATE_META[d.state];
        const low = d.conf < LOW_CONF;
        return `
          <div style="padding:2px 4px; min-width:215px;">
            <b style="font-size:1.05em; color:#0f172a;">${segments[y]}</b>
            <span style="color:#94a3b8; font-size:0.85em;"> · km ${KM_POST[segments[y]] ?? "—"}</span>
            <div style="margin-top:8px; display:grid; grid-template-columns:112px 1fr; gap:5px 8px; font-size:0.9em;">
              <span style="color:#64748b;">Horizon</span><span style="font-weight:600;">${hourLabels[x]}</span>
              <span style="color:#64748b;">Predicted state</span><span style="color:${d.state === "Low" ? "#166534" : d.state === "Med" ? "#b45309" : "#dc2626"}; font-weight:700;">${meta.label}</span>
              <span style="color:#64748b;">Speed band</span><span style="font-weight:500;">${meta.speed}</span>
              <span style="color:#64748b;">Model confidence</span><span style="font-weight:600; color:${low ? "#b45309" : "#334155"};">${(d.conf * 100).toFixed(1)}%${low ? " · lower" : ""}</span>
            </div>
          </div>`;
      },
    },
    grid: [
      { left: 150, right: 24, top: heatTop, height: heatHeight },
      { left: 150, right: 24, top: stripTop, height: stripHeight },
    ],
    xAxis: [
      {
        gridIndex: 0,
        type: "category",
        data: hourLabels,
        position: "top",
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: "#64748b", fontWeight: 600, fontSize: 11 },
      },
      {
        gridIndex: 1,
        type: "category",
        data: hourLabels,
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { show: false },
      },
    ],
    yAxis: [
      {
        gridIndex: 0,
        type: "category",
        data: segments.map((s) => `${s}  ·  km ${KM_POST[s] ?? "—"}`),
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: "#334155", fontWeight: 600, fontSize: 11 },
      },
      {
        gridIndex: 1,
        type: "value",
        max: segments.length,
        splitLine: { show: false },
        axisLabel: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
      },
    ],
    series: [
      {
        name: "Predicted congestion state",
        type: "heatmap",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: cells,
        // Only states that need action carry text; free-flow cells stay quiet.
        // A trailing * flags predictions the model is less sure about.
        label: {
          show: true,
          formatter: (params: unknown) => {
            const d = (params as { data: CellItem }).data;
            if (d.state === "Low") return "";
            return d.conf < LOW_CONF ? `${STATE_META[d.state].short}*` : STATE_META[d.state].short;
          },
          fontSize: 9,
          fontWeight: 700,
        },
        itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 4 },
        emphasis: { itemStyle: { borderColor: "#0f172a", borderWidth: 2, shadowBlur: 10, shadowColor: "rgba(15,23,42,0.3)" } },
      },
      {
        name: "Segments congested",
        type: "bar",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: perHour.map((n) => ({
          value: n,
          itemStyle: { color: n === maxPerHour && n > 0 ? "#f59e0b" : "#e2e8f0", borderRadius: [3, 3, 0, 0] },
          label: { color: n === maxPerHour && n > 0 ? "#b45309" : "#94a3b8" },
        })),
        barMaxWidth: 40,
        label: {
          show: true,
          position: "top",
          formatter: (p: unknown) => String((p as { value: number }).value || ""),
          fontSize: 11,
          fontWeight: 700,
        },
      },
    ],
  };

  const kpi = (label: string, value: string, sub: string, tone?: string) => (
    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "11px 13px" }}>
      <div style={{ fontSize: "0.68rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: "1.1rem", fontWeight: 700, color: tone ?? "#0f172a", margin: "2px 0 1px" }}>{value}</div>
      <div style={{ fontSize: "0.72rem", color: "#94a3b8" }}>{sub}</div>
    </div>
  );

  const VISIBLE_ALERTS = 4;
  const shown = alerts.slice(0, VISIBLE_ALERTS);

  // Grouped by location for the full list — scanning "what happens at Bocaue"
  // beats scrolling 29 loose cards.
  const bySegment = segments
    .map((seg) => ({ seg, runs: alerts.filter((a) => a.segment === seg).sort((a, b) => a.from - b.from) }))
    .filter((g) => g.runs.length > 0)
    .sort((a, b) => (KM_POST[a.seg] ?? 999) - (KM_POST[b.seg] ?? 999));

  const alertCard = (a: Alert, key: string) => {
    const severe = a.state === "High";
    const span = a.to - a.from + 1;
    return (
      <div
        key={key}
        style={{
          display: "flex", alignItems: "center", gap: "12px",
          padding: "10px 12px", borderRadius: "8px",
          background: severe ? "#fef2f2" : "#fffbeb",
          border: `1px solid ${severe ? "#fecaca" : "#fde68a"}`,
        }}
      >
        <span
          style={{
            flex: "none", padding: "3px 8px", borderRadius: "999px",
            background: severe ? "#dc2626" : "#f59e0b", color: "#fff",
            fontSize: "0.64rem", fontWeight: 800, letterSpacing: "0.04em",
          }}
        >
          {severe ? "SEVERE" : "HEAVY"}
        </span>
        <div style={{ minWidth: 0, fontSize: "0.82rem", lineHeight: 1.4 }}>
          <div style={{ fontWeight: 700, color: "#0f172a" }}>
            {a.segment} <span style={{ fontWeight: 500, color: "#94a3b8" }}>km {KM_POST[a.segment] ?? "—"}</span>
          </div>
          <div style={{ color: "#64748b" }}>
            {a.from === a.to ? `+${a.from}h` : `+${a.from}h → +${a.to}h`} · {span}h · {(a.conf * 100).toFixed(0)}% confidence
          </div>
        </div>
      </div>
    );
  };

  // A one-sentence read of the whole card, for stakeholders who will not
  // decode a 108-cell grid.
  const headline = model.firstSevere
    ? `${model.severeSegments.join(" and ")} ${model.severeSegments.length > 1 ? "are" : "is"} forecast to hit severe congestion — first at ${model.firstSevere.segment}, +${model.firstSevere.from}h. The corridor is busiest at +${model.peakHour}h with ${model.peakHourCount} of ${segments.length} segments congested.`
    : `No severe congestion forecast in the next ${hourLabels.length} hours. Busiest window is +${model.peakHour}h with ${model.peakHourCount} of ${segments.length} segments running heavy.`;

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "16px", marginTop: "24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
        <div>
          <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em", display: "flex", alignItems: "center", gap: "8px" }}>
            Predictive Congestion State Map
            <span style={{ fontSize: "0.72rem", padding: "2px 8px", background: "#f1f5f9", borderRadius: "999px", border: "1px solid #dce2ef", color: "#475569", fontWeight: 600 }}>
              XGBoost
            </span>
          </h3>
          <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
            Each cell is one segment at one hour ahead · rows run north-bound by km-post · hover for model confidence
          </p>
        </div>
        <div style={{ display: "flex", gap: "14px", alignItems: "center", fontSize: "0.76rem", color: "#64748b", fontWeight: 500, flexWrap: "wrap" }}>
          {(["Low", "Med", "High"] as State[]).map((s) => (
            <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" }}>
              <span style={{ width: 13, height: 13, background: STATE_META[s].color, borderRadius: "3px" }} />
              {STATE_META[s].label} <span style={{ color: "#94a3b8" }}>({STATE_META[s].speed})</span>
            </span>
          ))}
          {model.lowConfCount > 0 && (
            <span style={{ color: "#94a3b8", whiteSpace: "nowrap" }}>
              <b style={{ color: "#64748b" }}>*</b> lower confidence (&lt;80%)
            </span>
          )}
        </div>
      </div>

      {/* Plain-language read of the grid */}
      <div
        style={{
          padding: "11px 14px",
          borderRadius: "8px",
          background: model.firstSevere ? "#fef2f2" : "#f0fdf4",
          border: `1px solid ${model.firstSevere ? "#fecaca" : "#bbf7d0"}`,
          color: model.firstSevere ? "#991b1b" : "#166534",
          fontSize: "0.86rem",
          lineHeight: 1.5,
        }}
      >
        {headline}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(165px, 1fr))", gap: "10px" }}>
        {kpi("Severe risk", `${model.severeSegments.length} of ${segments.length}`, `segments · ${model.severeCells} hours below 30 km/h`, model.severeSegments.length > 0 ? "#b91c1c" : "#15803d")}
        {kpi("Peak risk window", model.peakHour ? `+${model.peakHour}h` : "—", model.peakHour ? `${model.peakHourCount} of ${segments.length} segments congested` : "no congestion predicted")}
        {kpi("Most-affected segment", model.worstSegment ?? "—", model.worstSegment ? `${model.worstSegmentCount} of ${hourLabels.length} hours at risk` : "—")}
        {kpi("Heavy or worse", `${model.atRisk} of ${segments.length}`, "segments congested at some point", model.atRisk > 0 ? "#b45309" : "#15803d")}
      </div>

      <div style={{ width: "100%", height: `${chartHeight}px` }}>
        <DashboardChart option={option} height={chartHeight} />
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", marginBottom: "10px" }}>
          <h4 style={{ margin: 0, fontSize: "0.9rem", color: "#0f172a", fontWeight: 700 }}>
            What to act on{" "}
            <span style={{ color: "#94a3b8", fontWeight: 500 }}>
              · {model.severeCount} severe, {alerts.length - model.severeCount} heavy
            </span>
          </h4>
          {alerts.length > VISIBLE_ALERTS && (
            <button
              onClick={() => setAlertsOpen(true)}
              style={{
                display: "inline-flex", alignItems: "center", gap: "6px",
                border: "1px solid #dce2ef", background: "#fff", borderRadius: "999px",
                padding: "5px 13px", fontSize: "0.76rem", fontWeight: 600, color: "#475569", cursor: "pointer",
              }}
            >
              View all {alerts.length}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "10px" }}>
          {alerts.length === 0 ? (
            <div style={{ padding: "12px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", fontSize: "0.85rem", color: "#166534" }}>
              No heavy or severe congestion predicted in the next {hourLabels.length} hours.
            </div>
          ) : (
            shown.map((a, i) => alertCard(a, `${a.segment}-${a.from}-${i}`))
          )}
        </div>
      </div>

      {/* Full list in a dialog — the inline expander pushed the rest of the
          page down and trapped 29 cards in a small scroll box. */}
      {alertsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="All predicted congestion episodes"
          onClick={() => setAlertsOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 200,
            background: "rgba(15, 23, 42, 0.55)",
            display: "grid", placeItems: "center", padding: "24px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(980px, 100%)", maxHeight: "84vh",
              display: "flex", flexDirection: "column",
              background: "#fff", borderRadius: "14px",
              boxShadow: "0 24px 60px rgba(15,23,42,0.3)", overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px", padding: "18px 22px", borderBottom: "1px solid #e2e8f0" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
                  Predicted congestion · next {hourLabels.length} hours
                </h3>
                <p style={{ margin: "4px 0 0 0", fontSize: "0.8rem", color: "#64748b" }}>
                  {alerts.length} episodes across {bySegment.length} segments ·{" "}
                  <b style={{ color: "#b91c1c" }}>{model.severeCount} severe</b>,{" "}
                  <b style={{ color: "#b45309" }}>{alerts.length - model.severeCount} heavy</b> · grouped by location
                </p>
              </div>
              <button
                onClick={() => setAlertsOpen(false)}
                aria-label="Close"
                style={{
                  flex: "none", width: 32, height: 32, borderRadius: "8px",
                  border: "1px solid #e2e8f0", background: "#fff", color: "#475569",
                  cursor: "pointer", display: "grid", placeItems: "center", fontSize: "1rem", lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ overflowY: "auto", padding: "18px 22px", display: "flex", flexDirection: "column", gap: "18px" }}>
              {bySegment.map(({ seg, runs }) => (
                <div key={seg}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "8px" }}>
                    <span style={{ fontSize: "0.88rem", fontWeight: 700, color: "#0f172a" }}>{seg}</span>
                    <span style={{ fontSize: "0.74rem", color: "#94a3b8" }}>km {KM_POST[seg] ?? "—"}</span>
                    <span style={{ flex: 1, borderBottom: "1px solid #eef2f7" }} />
                    <span style={{ fontSize: "0.74rem", color: "#94a3b8" }}>
                      {runs.length} {runs.length === 1 ? "episode" : "episodes"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: "8px" }}>
                    {runs.map((a, i) => alertCard(a, `modal-${seg}-${a.from}-${i}`))}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ padding: "12px 22px", borderTop: "1px solid #e2e8f0", background: "#f8fafc", fontSize: "0.75rem", color: "#94a3b8" }}>
              Confidence is the model&apos;s certainty in its classification, not the probability of congestion. Press Esc to close.
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
