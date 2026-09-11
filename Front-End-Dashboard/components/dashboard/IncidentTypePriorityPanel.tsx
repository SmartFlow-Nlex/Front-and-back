"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import { fmtInt } from "./incidentPredictive.shared";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// The other two prescriptive panels are both organized by LOCATION (patrol
// deployment by exit/km, secondary-risk priority by exit/km) — neither
// touches the sharpest split the Predictive tab's own "Time to Clear, by
// Incident Source/Severity" chart surfaces: the biggest driver of clearance
// time there isn't WHERE an incident happens, it's WHAT KIND it is. This
// panel crosses each severity/source group's own median clearance time (same
// survivalCurve/medianOf logic that chart uses) against a predicted volume
// for that type, apportioned from the Predicted Incidents Ranking's own total
// forecast by each type's historical share of incidents — the same
// derive-don't-separately-model approach corridorForecast already uses for
// location, just applied along the type axis instead. Two independent
// fetches (severity + predictive), same convention PrescriptiveDeploymentPanel
// already uses for its own two-endpoint pull.
type SurvivalCurvePoint = { group: string; dimension: string; timeMin: number; survivalProbability: number; n: number };
type SeverityData = { survivalCurve: SurvivalCurvePoint[]; avgPredictedClearanceMin: number | null };
type PredictiveSlice = { totalPredictedNext7Days: number; corridorForecastDays: number; corridorForecastModel: string | null };

// Standard incident-response dispatch tiers, not a model output — a real,
// commonly used doctrine (heavier scenes need more simultaneous resources),
// paired below with this corridor's own measured clearance times per
// severity so the "why" stays grounded in real numbers even though the
// package itself is operational judgment, not something the ML pipeline
// predicts. Matched by substring so it reads any label containing the
// severity word — "Fatal" and "Road Crash — Fatal" both resolve the same
// way — and falls back to a generic response for source-only labels (Road
// Crash / Motorcycle Crash) that carry no severity component at all.
const DISPATCH_PACKAGE: Record<"Fatal" | "Injury" | "Property Damage Only" | "default", string> = {
  Fatal: "Heavy tow + medical unit + traffic control (simultaneous dispatch)",
  Injury: "Medical unit + traffic control",
  "Property Damage Only": "Standard patrol response",
  default: "Standard patrol response",
};
function dispatchPackageFor(label: string): string {
  if (label.includes("Fatal")) return DISPATCH_PACKAGE.Fatal;
  if (label.includes("Injury")) return DISPATCH_PACKAGE.Injury;
  if (label.includes("Property Damage Only")) return DISPATCH_PACKAGE["Property Damage Only"];
  return DISPATCH_PACKAGE.default;
}

type Dimension = "severity" | "source" | "both";
// Mirrors IncidentSeverityModels.tsx's own VIEW_GROUPS, minus each
// dimension's "Baseline (average incident)" entry — baseline is a reference
// curve, not a category with a volume share to apportion.
const VIEW_GROUPS: Record<Dimension, string[]> = {
  severity: ["Property Damage Only", "Injury", "Fatal"],
  source: ["Road Crash", "Motorcycle Crash"],
  both: [
    "Road Crash — Property Damage Only", "Road Crash — Injury", "Road Crash — Fatal",
    "Motorcycle Crash — Property Damage Only", "Motorcycle Crash — Injury", "Motorcycle Crash — Fatal",
  ],
};

type Row = { key: string; label: string; n: number; medianClearanceMin: number; predictedVolume: number };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export default function IncidentTypePriorityPanel() {
  const [dimension, setDimension] = useState<Dimension>("severity");
  const [severity, setSeverity] = useState<SeverityData | null>(null);
  const [predictive, setPredictive] = useState<PredictiveSlice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${BACKEND}/api/incident/severity`, { cache: "no-store" }).then((res) => res.json()),
      // months=12 to match the Predictive tab's own default Range — same
      // sample the ranking card shows on a fresh page load, same convention
      // PrescriptiveDeploymentPanel already uses for this endpoint.
      fetch(`${BACKEND}/api/incident/predictive?months=12`, { cache: "no-store" }).then((res) => res.json()),
    ])
      .then(([severityJson, predictiveJson]) => {
        if (cancelled) return;
        if (!severityJson.success) throw new Error(severityJson.message ?? "Request failed");
        if (!predictiveJson.success) throw new Error(predictiveJson.message ?? "Request failed");
        setSeverity({ survivalCurve: severityJson.data.survivalCurve, avgPredictedClearanceMin: severityJson.data.avgPredictedClearanceMin ?? null });
        setPredictive({
          totalPredictedNext7Days: predictiveJson.data.summary.totalPredictedNext7Days,
          corridorForecastDays: predictiveJson.data.corridorForecastDays,
          corridorForecastModel: predictiveJson.data.corridorForecastModel,
        });
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load incident-type priority data");
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
        <div style={{ color: "#64748b" }}>Loading incident-type priority…</div>
      </article>
    );
  }

  const nOf = (g: string): number => severity?.survivalCurve.find((p) => p.group === g)?.n ?? 0;
  const medianClearanceOf = (g: string): number | null => {
    const pts = (severity?.survivalCurve ?? []).filter((p) => p.group === g).sort((a, b) => a.timeMin - b.timeMin);
    return pts.find((p) => p.survivalProbability <= 0.5)?.timeMin ?? null;
  };

  const groupNames = VIEW_GROUPS[dimension].filter((g) => (severity?.survivalCurve ?? []).some((p) => p.group === g));
  const totalN = groupNames.reduce((s, g) => s + nOf(g), 0);
  const totalPredicted = predictive?.totalPredictedNext7Days ?? 0;

  const rows: Row[] = groupNames
    .map((g) => {
      const n = nOf(g);
      const medianClearanceMin = medianClearanceOf(g);
      if (medianClearanceMin == null || n === 0) return null;
      return { key: g, label: g, n, medianClearanceMin, predictedVolume: totalN > 0 ? totalPredicted * (n / totalN) : 0 };
    })
    .filter((r): r is Row => r != null);

  if (error || !severity || !predictive || rows.length === 0) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "440px" }}>
          <div style={{ fontWeight: 700, color: "#334155", marginBottom: "6px" }}>Incident-type priority unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            {error ?? "The severity pipeline hasn't written its output yet — run train_incident_severity_models.py --write-db."}
          </div>
        </div>
      </article>
    );
  }

  const medianVolume = median(rows.map((r) => r.predictedVolume));
  const medianClearance = median(rows.map((r) => r.medianClearanceMin));
  // Priority quadrant: above-median on BOTH axes — frequent enough to matter
  // AND slower than typical to clear. Same "combination, not either alone"
  // logic SecondaryRiskMitigationPanel uses for location, applied to type:
  // high volume with fast clearance is already handled efficiently, and slow
  // clearance on a rare type doesn't move the corridor's overall numbers much.
  const priorityRows = rows
    .filter((r) => r.predictedVolume >= medianVolume && r.medianClearanceMin >= medianClearance)
    .sort((a, b) => b.predictedVolume * b.medianClearanceMin - a.predictedVolume * a.medianClearanceMin);

  const maxN = Math.max(...rows.map((r) => r.n), 1);
  const quadrantColor = (r: Row) => {
    const highVolume = r.predictedVolume >= medianVolume;
    const slowClear = r.medianClearanceMin >= medianClearance;
    if (highVolume && slowClear) return "#dc2626"; // priority
    if (highVolume && !slowClear) return "#f59e0b"; // frequent but clears fast — being handled
    if (!highVolume && slowClear) return "#3b82f6"; // slow but rare — lower urgency
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
          `<b>${r.label}</b><br/>` +
          `Predicted: <b>${fmtInt(r.predictedVolume)}</b> incidents (next ${predictive.corridorForecastDays}d)<br/>` +
          `Median clearance: <b>${r.medianClearanceMin.toFixed(1)} min</b><br/>` +
          `n=${r.n} (historical)`
        );
      },
    },
    xAxis: {
      type: "value",
      name: "Median clearance time (min)",
      nameLocation: "middle",
      nameGap: 32,
      axisLabel: { color: "#64748b" },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: `Predicted incidents (next ${predictive.corridorForecastDays}d)`,
      nameLocation: "middle",
      nameGap: 48,
      axisLabel: { color: "#64748b" },
      splitLine: { lineStyle: { color: "#eef1f7" } },
    },
    series: [
      {
        type: "scatter",
        data: rows.map((r) => [r.medianClearanceMin, r.predictedVolume]),
        symbolSize: (val: number[], p: unknown) => {
          const r = rows[(p as { dataIndex: number }).dataIndex];
          return 12 + Math.sqrt(r.n / maxN) * 28;
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
          data: [{ xAxis: medianClearance }, { yAxis: medianVolume }],
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
          Clearance Protocol &amp; Resource Recommendation
          <InfoTooltip text="A solution for two Predictive-tab charts at once: the Predicted Incidents Ranking's total forecast, apportioned across incident types the same derived way it's apportioned across exits, crossed with each type's own median clearance time from Time to Clear, by Incident Source/Severity. Each severity level gets a recommended dispatch package — a standard incident-response doctrine, not a model prediction — paired with this corridor's own measured clearance time for that severity, so heavier packages are justified by real numbers, not assumed." />
        </h3>
        <div style={{ display: "inline-flex", gap: "2px", padding: "3px", background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef", borderRadius: "999px", flexShrink: 0 }}>
          {(["severity", "source", "both"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setDimension(v)}
              style={{
                padding: "4px 12px", borderRadius: "999px", border: "none", cursor: "pointer",
                background: dimension === v ? "#4f46e5" : "transparent",
                color: dimension === v ? "#fff" : "#4b5e7d",
                fontWeight: 600, fontSize: "0.72rem", whiteSpace: "nowrap",
              }}
            >
              {v === "severity" ? "By Severity" : v === "source" ? "By Source" : "By Both"}
            </button>
          ))}
        </div>
      </div>
      <p style={{ color: "#64748b", fontSize: "0.82rem", margin: 0 }}>
        Built from the {predictive.corridorForecastModel ? `${predictive.corridorForecastModel} ` : ""}
        {predictive.corridorForecastDays}-day forecast, apportioned by each type&apos;s historical share of incidents
        instead of location.
        {dimension === "both" && " Some crossed groups are thin (as few as 25 incidents) — hover a point to see its n."}
      </p>

      {priorityRows.length > 0 && (
        <div style={{ padding: "10px 14px", borderRadius: "10px", background: "#fef2f2", border: "1px solid #fecaca" }}>
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#7f1d1d" }}>
            <strong>{priorityRows.length}</strong> of {rows.length} incident types combine above-median predicted
            volume (≥{fmtInt(medianVolume)}) with above-median clearance time (≥{medianClearance.toFixed(0)} min) —
            led by <strong>{priorityRows[0].label}</strong> ({fmtInt(priorityRows[0].predictedVolume)} predicted,{" "}
            {priorityRows[0].medianClearanceMin.toFixed(0)} min), recommending{" "}
            <strong>{dispatchPackageFor(priorityRows[0].label)}</strong>
            {severity.avgPredictedClearanceMin != null &&
              ` to bring clearance down from the corridor's ${severity.avgPredictedClearanceMin.toFixed(1)} min average`}
            . These are the best candidates for a dedicated response protocol: frequent enough to matter, slow
            enough that shaving minutes off compounds across the most incidents.
          </p>
        </div>
      )}

      <DashboardChart option={scatterOption} height={340} />

      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", alignItems: "center", borderTop: "1px solid #e2e8f0", paddingTop: "10px" }}>
        {[
          { color: "#dc2626", label: "Priority — high volume, slow clearance" },
          { color: "#f59e0b", label: "High volume, fast clearance" },
          { color: "#3b82f6", label: "Low volume, slow clearance" },
          { color: "#94a3b8", label: "Low volume, fast clearance" },
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
          <h4 style={{ margin: "0 0 8px 0", fontSize: "0.85rem", color: "#0f172a", fontWeight: 700 }}>Priority types, ranked</h4>
          <table style={{ width: "100%", fontSize: "0.78rem", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                <th style={{ fontWeight: 600, paddingBottom: "4px" }}>Incident type</th>
                <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>Predicted incidents</th>
                <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>Median clearance</th>
                <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>n</th>
                <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>Recommended dispatch</th>
              </tr>
            </thead>
            <tbody>
              {priorityRows.map((r) => (
                <tr
                  key={r.key}
                  onMouseEnter={() => setHoveredKey(r.key)}
                  onMouseLeave={() => setHoveredKey((k) => (k === r.key ? null : k))}
                  style={{ borderTop: "1px solid #f1f5f9", background: hoveredKey === r.key ? "rgba(220,38,38,0.05)" : "transparent" }}
                >
                  <td style={{ padding: "4px 0", color: "#334155" }}>{r.label}</td>
                  <td style={{ padding: "4px 0", textAlign: "right", color: "#dc2626", fontWeight: 700 }}>{fmtInt(r.predictedVolume)}</td>
                  <td style={{ padding: "4px 0", textAlign: "right", color: "#334155" }}>{r.medianClearanceMin.toFixed(1)} min</td>
                  <td style={{ padding: "4px 0", textAlign: "right", color: "#94a3b8" }}>{fmtInt(r.n)}</td>
                  <td style={{ padding: "4px 0", textAlign: "right", color: "#4f46e5", fontWeight: 600, fontSize: "0.72rem" }}>
                    {dispatchPackageFor(r.label)}
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
