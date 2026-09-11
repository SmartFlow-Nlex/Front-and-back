"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import { fmtInt } from "./incidentPredictive.shared";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Solves the same problem the Predictive tab's Secondary Incident Risk panel
// only describes: that panel ranks WHERE risk is elevated, but risk alone
// isn't actionable — the actual lever operators have is how fast an incident
// gets cleared, since every extra minute a first incident's response window
// stays open is another minute a second one can start nearby. This panel
// pairs the same avgRisk each zone already shows with its avgClearanceMin
// (added to /api/incident/severity's response specifically so the two are
// computed from the SAME rows, not two separately-quantiled groupings that
// might not line up), then splits zones into a priority quadrant by their
// own median — no fixed thresholds, so the split adapts to wherever this
// corridor's numbers actually sit on the next retrain.
type SecondaryRiskByExit = { exitId: number; exitName: string; km: number; n: number; avgRisk: number; avgClearanceMin: number; actualSecondaryCount: number };
type SecondaryRiskByKmSegment = { label: string; kmStart: number; kmEnd: number; n: number; avgRisk: number; avgClearanceMin: number; actualSecondaryCount: number };
type SeverityData = {
  secondaryRiskByExit: SecondaryRiskByExit[];
  secondaryRiskByKmSegment: SecondaryRiskByKmSegment[];
  metadata: { secondary_risk: { auc: number | null; base_rate: number; n: number }; cox_ph: { concordance_index: number; mae_minutes: number | null } } | null;
};

type Row = { key: string; label: string; tooltipDetail: string; risk: number; clearanceMin: number; n: number };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Which upstream intervention a priority zone calls for — driven by WHICH of
// the two axes is comparatively more extreme for that zone (each measured as
// % above its own median, so the two are on a comparable scale), not an
// arbitrary per-row assignment. A zone that's mostly a clearance problem
// needs the queue physically protected while it's cleared; a zone that's
// mostly a risk problem needs approaching traffic warned earlier. A zone
// where neither dominates gets both. The 1.2x margin keeps genuine near-ties
// in the "both" bucket rather than forcing a coin-flip pick.
function interventionFor(r: Row, medianRisk: number, medianClearance: number): string {
  const riskExcess = medianRisk > 0 ? (r.risk - medianRisk) / medianRisk : 0;
  const clearExcess = medianClearance > 0 ? (r.clearanceMin - medianClearance) / medianClearance : 0;
  if (clearExcess >= riskExcess * 1.2) return "Queue-end protection vehicle";
  if (riskExcess >= clearExcess * 1.2) return "Automated VMS hazard warning";
  return "Queue-end vehicle + VMS warning";
}

export default function SecondaryRiskMitigationPanel() {
  const [view, setView] = useState<"exit" | "km">("exit");
  const [data, setData] = useState<SeverityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND}/api/incident/severity`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setData(json.data as SeverityData);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load secondary-risk mitigation data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <article className="chart-card wide" style={{ height: "320px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>Loading secondary-risk mitigation…</div>
      </article>
    );
  }

  if (error || !data || (data.secondaryRiskByExit.length === 0 && data.secondaryRiskByKmSegment.length === 0)) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "440px" }}>
          <div style={{ fontWeight: 700, color: "#334155", marginBottom: "6px" }}>Secondary-risk mitigation unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            {error ?? "The severity pipeline hasn't written its output yet — run train_incident_severity_models.py --write-db."}
          </div>
        </div>
      </article>
    );
  }

  const useKmView = view === "km" && data.secondaryRiskByKmSegment.length > 0;
  const exitRows: Row[] = data.secondaryRiskByExit.map((x) => ({
    key: `exit-${x.exitId}`, label: x.exitName, tooltipDetail: `Km ${x.km}`, risk: x.avgRisk, clearanceMin: x.avgClearanceMin, n: x.n,
  }));
  const kmRows: Row[] = data.secondaryRiskByKmSegment.map((x) => ({
    key: `seg-${x.kmStart}`, label: x.label, tooltipDetail: "", risk: x.avgRisk, clearanceMin: x.avgClearanceMin, n: x.n,
  }));
  const rows = (useKmView ? kmRows : exitRows).filter((r) => r.clearanceMin > 0);

  const medianRisk = median(rows.map((r) => r.risk));
  const medianClearance = median(rows.map((r) => r.clearanceMin));
  // Priority quadrant: above-median on BOTH axes — slower than typical
  // clearance AND riskier than typical for a secondary incident to follow.
  // That combination, not either alone, is what makes a zone the best
  // candidate for faster-response resources: high risk with fast clearance
  // is already being handled well, and slow clearance with low risk isn't
  // where a secondary incident is likely to follow anyway.
  const priorityRows = rows.filter((r) => r.risk >= medianRisk && r.clearanceMin >= medianClearance).sort((a, b) => b.risk * b.clearanceMin - a.risk * a.clearanceMin);

  const maxN = Math.max(...rows.map((r) => r.n), 1);
  const quadrantColor = (r: Row) => {
    const highRisk = r.risk >= medianRisk;
    const slowClear = r.clearanceMin >= medianClearance;
    if (highRisk && slowClear) return "#dc2626"; // priority
    if (highRisk && !slowClear) return "#f59e0b"; // risky but clears fast — being handled
    if (!highRisk && slowClear) return "#3b82f6"; // slow but low risk — lower urgency
    return "#94a3b8"; // neither
  };

  const scatterOption: EChartsOption = {
    grid: { left: 56, right: 24, top: 24, bottom: 56 },
    tooltip: {
      trigger: "item",
      formatter: (p: unknown) => {
        const point = p as { dataIndex: number };
        const r = rows[point.dataIndex];
        return (
          `<b>${r.label}</b>${r.tooltipDetail ? ` (${r.tooltipDetail})` : ""}<br/>` +
          `Secondary risk: <b>${(r.risk * 100).toFixed(2)}%</b><br/>` +
          `Predicted clearance: <b>${r.clearanceMin.toFixed(1)} min</b><br/>` +
          `n=${r.n}`
        );
      },
    },
    xAxis: {
      type: "value",
      name: "Predicted clearance time (min)",
      nameLocation: "middle",
      nameGap: 32,
      axisLabel: { color: "#64748b" },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: "Secondary incident risk",
      nameLocation: "middle",
      nameGap: 48,
      axisLabel: { color: "#64748b", formatter: (v: number) => `${v.toFixed(1)}%` },
      splitLine: { lineStyle: { color: "#eef1f7" } },
    },
    series: [
      {
        type: "scatter",
        data: rows.map((r) => [r.clearanceMin, r.risk * 100]),
        symbolSize: (val: number[], p: unknown) => {
          const r = rows[(p as { dataIndex: number }).dataIndex];
          return 10 + Math.sqrt(r.n / maxN) * 26;
        },
        itemStyle: {
          color: (p: unknown) => quadrantColor(rows[(p as { dataIndex: number }).dataIndex]),
          opacity: 0.82,
          borderColor: "#fff",
          borderWidth: 1.5,
        },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: "#cbd5e1", type: "dashed", width: 1.5 },
          label: { show: false },
          data: [{ xAxis: medianClearance }, { yAxis: medianRisk * 100 }],
        },
        label: {
          show: true,
          formatter: (p: unknown) => rows[(p as { dataIndex: number }).dataIndex].label,
          position: "top",
          fontSize: 9,
          color: "#475569",
        },
      },
    ],
  };

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          Dynamic Queue &amp; Secondary Risk Mitigation
          <InfoTooltip text="A solution for the Predictive tab's own Secondary Incident Risk panel: that panel ranks WHERE risk is elevated, but the actual lever is clearance speed — every extra minute a first incident stays unresolved is another minute a second one can start nearby. Priority zones get a recommended upstream intervention (queue-end protection vehicle, automated VMS hazard warning, or both), driven by whether that zone's problem is mostly slow clearance, elevated risk, or roughly both." />
        </h3>
        <div style={{ display: "inline-flex", gap: "2px", padding: "3px", background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef", borderRadius: "999px", flexShrink: 0 }}>
          {(["exit", "km"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              disabled={v === "km" && data.secondaryRiskByKmSegment.length === 0}
              style={{
                padding: "4px 12px", borderRadius: "999px", border: "none", cursor: "pointer",
                background: view === v ? "#4f46e5" : "transparent",
                color: view === v ? "#fff" : "#4b5e7d",
                fontWeight: 600, fontSize: "0.72rem", whiteSpace: "nowrap",
              }}
            >
              {v === "exit" ? "By Exit" : "By Km"}
            </button>
          ))}
        </div>
      </div>
      <p style={{ color: "#64748b", fontSize: "0.82rem", margin: 0 }}>
        Each point is one {useKmView ? "km segment" : "exit"}; size is evidence (n). Dashed lines mark this
        view&apos;s own median clearance time and median risk, not a fixed threshold.
      </p>

      {priorityRows.length > 0 && (
        <div style={{ padding: "10px 14px", borderRadius: "10px", background: "#fef2f2", border: "1px solid #fecaca" }}>
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#7f1d1d" }}>
            <strong>{priorityRows.length}</strong> of {rows.length} {useKmView ? "segments" : "exits"} combine
            above-median secondary risk (≥{(medianRisk * 100).toFixed(2)}%) with above-median clearance time (≥
            {medianClearance.toFixed(0)} min) — led by <strong>{priorityRows[0].label}</strong> (
            {(priorityRows[0].risk * 100).toFixed(2)}% risk, {priorityRows[0].clearanceMin.toFixed(0)} min),
            recommending a <strong>{interventionFor(priorityRows[0], medianRisk, medianClearance)}</strong>. Cutting
            clearance time at any of these does double duty, since it also shortens the window a secondary incident
            has to start in. Across every priority zone, a lower advisory speed threshold during active incidents is
            also worth standing up — a standing operational recommendation, not something this model measures.
          </p>
        </div>
      )}

      <DashboardChart option={scatterOption} height={360} />

      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", alignItems: "center", borderTop: "1px solid #e2e8f0", paddingTop: "10px" }}>
        {[
          { color: "#dc2626", label: "Priority — high risk, slow clearance" },
          { color: "#f59e0b", label: "High risk, fast clearance" },
          { color: "#3b82f6", label: "Low risk, slow clearance" },
          { color: "#94a3b8", label: "Low risk, fast clearance" },
        ].map((q) => (
          <div key={q.label} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.72rem", color: "#64748b" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: q.color }} />
            {q.label}
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.72rem", color: "#64748b", marginLeft: "auto" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#94a3b8", display: "inline-block" }} />
            <span style={{ width: 14, height: 14, borderRadius: "50%", background: "#94a3b8", display: "inline-block" }} />
          </span>
          dot size = evidence (n)
        </div>
      </div>

      {priorityRows.length > 0 && (
        <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "12px" }}>
          <h4 style={{ margin: "0 0 8px 0", fontSize: "0.85rem", color: "#0f172a", fontWeight: 700 }}>Priority zones, ranked</h4>
          <table style={{ width: "100%", fontSize: "0.78rem", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                <th style={{ fontWeight: 600, paddingBottom: "4px" }}>{useKmView ? "Segment" : "Exit"}</th>
                <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>Secondary risk</th>
                <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>Predicted clearance</th>
                <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>n</th>
                <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>Recommended intervention</th>
              </tr>
            </thead>
            <tbody>
              {priorityRows.map((r) => (
                <tr key={r.key} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "4px 0", color: "#334155" }}>{r.label}</td>
                  <td style={{ padding: "4px 0", textAlign: "right", color: "#dc2626", fontWeight: 700 }}>{(r.risk * 100).toFixed(2)}%</td>
                  <td style={{ padding: "4px 0", textAlign: "right", color: "#334155" }}>{r.clearanceMin.toFixed(1)} min</td>
                  <td style={{ padding: "4px 0", textAlign: "right", color: "#94a3b8" }}>{fmtInt(r.n)}</td>
                  <td style={{ padding: "4px 0", textAlign: "right", color: "#4f46e5", fontWeight: 600, fontSize: "0.72rem" }}>
                    {interventionFor(r, medianRisk, medianClearance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
