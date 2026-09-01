"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import { shadeFor } from "./PredictiveCorridorChart";
import { fmtInt, fmtNum } from "./incidentPredictive.shared";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Mirrors src/services/incident-severity.service.ts's response shape — also
// duplicated in IncidentSeverityModels.tsx (the "Time to Clear, by Severity" curve),
// which reads the same endpoint independently. Split into two components,
// each with its own fetch, so this panel can be laid out independently of
// its curve. Kept in sync by hand.
type SeverityBreakdownRow = { severityCode: number; label: string; actualCount: number; predictedCount: number };
type SeverityMetrics = { accuracy: number; MAE_ordinal: number; n: number };
type Metadata = {
  severity: { champion: string; metrics: Record<string, SeverityMetrics> };
  cox_ph: { concordance_index: number; mae_minutes: number | null; n: number };
  secondary_risk: { auc: number | null; base_rate: number; n: number };
  secondary_km_radius: number;
};
type SecondaryRiskByExit = { exitId: number; exitName: string; km: number; n: number; avgRisk: number; actualSecondaryCount: number };

type SeverityData = {
  severityBreakdown: SeverityBreakdownRow[];
  avgPredictedClearanceMin: number | null;
  avgSecondaryRisk: number | null;
  secondaryRiskByExit: SecondaryRiskByExit[];
  trainedAt: string | null;
  metadata: Metadata | null;
};

export default function SecondaryIncidentRiskPanel() {
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
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load severity models");
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
        <div style={{ color: "#64748b" }}>Loading secondary incident risk…</div>
      </article>
    );
  }

  if (error || !data || data.severityBreakdown.length === 0) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "420px" }}>
          <div style={{ fontWeight: 700, color: "#334155", marginBottom: "6px" }}>Secondary incident risk unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            {error ?? "The severity pipeline hasn't written its output yet — run train_incident_severity_models.py --write-db."}
          </div>
        </div>
      </article>
    );
  }

  const meta = data.metadata;
  const champion = meta?.severity.champion ?? null;
  const championMetrics = champion ? meta?.severity.metrics[champion] : undefined;

  // Top corridors only, not all of them — cut by evidence, not by a round
  // number. Sorted by n (held-out incidents at that exit) descending, kept
  // until the running total crosses 80% of every held-out incident this
  // panel is built from; whatever's left is a long tail of exits too thin
  // to rank confidently. "Why top N" has a real answer this way: N isn't
  // chosen, it falls out of where 80% of the evidence actually sits. Ranked
  // by n rather than by the corridor forecast's predicted-incident count on
  // purpose — that count is Range/Weather/Volume/Models-scoped and would
  // silently change which exits appear here whenever someone adjusts a
  // toggle on a completely different card, even though nothing in THIS
  // panel's own numbers moved.
  const COVERAGE_TARGET = 0.8;
  const totalN = data.secondaryRiskByExit.reduce((s, x) => s + x.n, 0);
  const byEvidence = [...data.secondaryRiskByExit].sort((a, b) => b.n - a.n);
  let cumulative = 0;
  const topExitIds = new Set<number>();
  for (const x of byEvidence) {
    if (cumulative >= totalN * COVERAGE_TARGET) break;
    topExitIds.add(x.exitId);
    cumulative += x.n;
  }

  // Within that top set, ranked by km (along the corridor), not by risk — a
  // ranked-by-value chart would bury the "where" this exists to answer
  // under whichever exit happened to score highest. n is shown alongside
  // every bar (label and tooltip) because even within the top set, some
  // exits' bars are built from far more incidents than others, and a
  // lower-n exit reading as "high risk" is closer to a small-sample
  // artifact than a finding.
  const byExit = data.secondaryRiskByExit
    .filter((x) => topExitIds.has(x.exitId))
    .sort((a, b) => a.km - b.km);
  // Not charted, but not thrown away — a compact reference list under the
  // chart so the count for a below-threshold exit is still one glance away
  // rather than gone entirely. Sorted by n descending: closest-to-qualifying
  // first, thinnest last.
  const omittedExits = data.secondaryRiskByExit
    .filter((x) => !topExitIds.has(x.exitId))
    .sort((a, b) => b.n - a.n);
  const maxAvgRisk = Math.max(...byExit.map((x) => x.avgRisk), 1e-9);
  const exitChartOption: EChartsOption = {
    grid: { left: 130, right: 56, top: 16, bottom: 28 },
    tooltip: {
      trigger: "item",
      formatter: (p: unknown) => {
        const point = p as { dataIndex: number };
        const x = byExit[point.dataIndex];
        return (
          `<b>${x.exitName}</b> (Km ${x.km})<br/>` +
          `Avg. predicted risk: <b>${(x.avgRisk * 100).toFixed(1)}%</b><br/>` +
          `${x.actualSecondaryCount} of ${x.n} held-out incidents here actually had a secondary incident follow`
        );
      },
    },
    xAxis: {
      type: "value",
      name: "Avg. predicted secondary-incident risk",
      nameLocation: "middle",
      nameGap: 28,
      min: 0,
      axisLabel: { color: "#64748b", formatter: (v: number) => `${Math.round(v * 100)}%` },
      splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
    },
    yAxis: {
      type: "category",
      data: byExit.map((x) => x.exitName),
      axisLabel: { color: "#334155", fontSize: 11 },
      axisLine: { lineStyle: { color: "#cbd5e1" } },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        data: byExit.map((x) => ({
          value: x.avgRisk,
          itemStyle: { color: shadeFor(x.avgRisk / maxAvgRisk) },
        })),
        barMaxWidth: 16,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        label: {
          show: true,
          position: "right",
          color: "#334155",
          fontSize: 10,
          fontWeight: 600,
          formatter: (p: unknown) => {
            const x = byExit[(p as { dataIndex: number }).dataIndex];
            return `${(x.avgRisk * 100).toFixed(1)}% (n=${x.n})`;
          },
        },
      },
    ],
  };
  const exitChartHeight = Math.max(220, byExit.length * 26 + 60);

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div>
        <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          Secondary Incident Risk
        </h3>
        <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
          How often another incident starts within {meta?.secondary_km_radius ?? 2}km while this one is still
          being responded to, scored on a chronological holdout.
        </p>
      </div>
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 120px", padding: "10px 14px", borderRadius: "10px", background: "#f8fafc", border: "1px solid #e2e8f0" }}>
          <div style={{ fontSize: "0.7rem", color: "#94a3b8", fontWeight: 600, textTransform: "uppercase" }}>Risk score AUC</div>
          <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "#0f172a" }}>
            {meta?.secondary_risk.auc != null ? fmtNum(meta.secondary_risk.auc, 3) : "—"}
          </div>
        </div>
        <div style={{ flex: "1 1 120px", padding: "10px 14px", borderRadius: "10px", background: "#f8fafc", border: "1px solid #e2e8f0" }}>
          <div style={{ fontSize: "0.7rem", color: "#94a3b8", fontWeight: 600, textTransform: "uppercase" }}>Avg. risk score</div>
          <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "#0f172a" }}>
            {data.avgSecondaryRisk != null ? `${(data.avgSecondaryRisk * 100).toFixed(1)}%` : "—"}
          </div>
        </div>
      </div>

      {byExit.length > 0 && (
        <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "12px" }}>
          <h4 style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#0f172a", fontWeight: 700 }}>Top corridors by evidence</h4>
          <p style={{ color: "#94a3b8", fontSize: "0.72rem", margin: "0 0 8px 0" }}>
            Charting the {byExit.length} of {data.secondaryRiskByExit.length} exits that together account for at
            least {Math.round(COVERAGE_TARGET * 100)}% of this panel&apos;s {fmtInt(totalN)} held-out incidents —
            enough evidence to rank with some confidence. Even within this set n still varies, so thin bars are
            less certain than they look; the rest are listed, not dropped, below the chart.
          </p>
          <DashboardChart option={exitChartOption} height={exitChartHeight} />
          {omittedExits.length > 0 && (
            <div style={{ marginTop: "12px" }}>
              <p style={{ color: "#94a3b8", fontSize: "0.72rem", margin: "0 0 6px 0" }}>
                Below the coverage threshold — not charted above, but not dropped either:
              </p>
              <table style={{ width: "100%", fontSize: "0.76rem", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                    <th style={{ fontWeight: 600, paddingBottom: "4px" }}>Exit</th>
                    <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>n</th>
                    <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>Avg. risk</th>
                  </tr>
                </thead>
                <tbody>
                  {omittedExits.map((x) => (
                    <tr key={x.exitId} style={{ borderTop: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "3px 0", color: "#64748b" }}>{x.exitName}</td>
                      <td style={{ padding: "3px 0", textAlign: "right", color: "#64748b" }}>{x.n}</td>
                      <td style={{ padding: "3px 0", textAlign: "right", color: "#64748b" }}>{(x.avgRisk * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "12px" }}>
        <h4 style={{ margin: "0 0 8px 0", fontSize: "0.85rem", color: "#0f172a", fontWeight: 700 }}>
          Predicted severity level{champion ? ` (${champion})` : ""}
        </h4>
        <table style={{ width: "100%", fontSize: "0.78rem", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ color: "#94a3b8", textAlign: "left" }}>
              <th style={{ fontWeight: 600, paddingBottom: "4px" }}>Severity</th>
              <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>Actual</th>
              <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>Predicted</th>
            </tr>
          </thead>
          <tbody>
            {data.severityBreakdown.map((row) => (
              <tr key={row.severityCode} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={{ padding: "4px 0", color: "#334155" }}>{row.label}</td>
                <td style={{ padding: "4px 0", textAlign: "right", color: "#334155" }}>{fmtInt(row.actualCount)}</td>
                <td style={{ padding: "4px 0", textAlign: "right", color: "#334155", fontWeight: 600 }}>{fmtInt(row.predictedCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {championMetrics && (
          <p style={{ color: "#94a3b8", fontSize: "0.72rem", margin: "8px 0 0 0" }}>
            {(championMetrics.accuracy * 100).toFixed(1)}% accuracy on {fmtInt(championMetrics.n)} held-out
            incidents. Fatal incidents are rare enough in this holdout (11 of {fmtInt(championMetrics.n)}) that
            neither candidate model ever predicts that class.
          </p>
        )}
      </div>

      <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "12px" }}>
        <h4 style={{ margin: "0 0 8px 0", fontSize: "0.85rem", color: "#0f172a", fontWeight: 700 }}>Predicted clearance time</h4>
        <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "#0f172a" }}>
          {data.avgPredictedClearanceMin != null ? `${fmtNum(data.avgPredictedClearanceMin, 1)} min avg` : "—"}
        </div>
        <p style={{ color: "#94a3b8", fontSize: "0.72rem", margin: "4px 0 0 0" }}>
          Cox PH concordance {meta ? fmtNum(meta.cox_ph.concordance_index, 3) : "—"}
          {meta?.cox_ph.mae_minutes != null ? ` · MAE ${fmtNum(meta.cox_ph.mae_minutes, 1)} min` : ""} on held-out incidents.
        </p>
      </div>
    </article>
  );
}
