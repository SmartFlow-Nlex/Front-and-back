"use client";

import { useEffect, useState } from "react";
import InfoTooltip from "./InfoTooltip";
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
// Same rows, grouped by km position (quantile bins — equal incident count,
// unequal km width) instead of nearest exit. See
// src/services/incident-severity.service.ts's own doc comment for why
// quantile bins, not a fixed km grid: km_value holds only a handful of
// distinct values in this data, so an even grid leaves several bins empty.
type SecondaryRiskByKmSegment = { label: string; kmStart: number; kmEnd: number; n: number; avgRisk: number; actualSecondaryCount: number };

type SeverityData = {
  severityBreakdown: SeverityBreakdownRow[];
  avgPredictedClearanceMin: number | null;
  avgSecondaryRisk: number | null;
  secondaryRiskByExit: SecondaryRiskByExit[];
  secondaryRiskByKmSegment: SecondaryRiskByKmSegment[];
  trainedAt: string | null;
  metadata: Metadata | null;
};

export default function SecondaryIncidentRiskPanel() {
  const [data, setData] = useState<SeverityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"exit" | "km">("exit");
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

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

  // Common shape both views reduce to, so one chart/table implementation
  // serves either grouping. sortKey orders "along the corridor" for
  // whichever view is active (km for exits, kmStart for segments) — both
  // are just "position", so one field name covers both.
  type Row = { key: string; label: string; tooltipDetail: string; sortKey: number; n: number; avgRisk: number; actualSecondaryCount: number };
  const exitRows: Row[] = data.secondaryRiskByExit.map((x) => ({
    key: `exit-${x.exitId}`, label: x.exitName, tooltipDetail: `Km ${x.km}`, sortKey: x.km,
    n: x.n, avgRisk: x.avgRisk, actualSecondaryCount: x.actualSecondaryCount,
  }));
  const kmRows: Row[] = data.secondaryRiskByKmSegment.map((x) => ({
    key: `seg-${x.kmStart}`, label: x.label, tooltipDetail: "", sortKey: x.kmStart,
    n: x.n, avgRisk: x.avgRisk, actualSecondaryCount: x.actualSecondaryCount,
  }));
  const allRows = view === "km" ? kmRows : exitRows;

  // Top corridors only, not all of them — cut by evidence, not by a round
  // number. Sorted by n descending, kept until the running total crosses
  // 80% of every held-out incident this panel is built from; whatever's
  // left is a long tail too thin to rank confidently. "Why top N" has a
  // real answer this way: N isn't chosen, it falls out of where 80% of the
  // evidence actually sits. Ranked by n rather than by the corridor
  // forecast's predicted-incident count on purpose — that count is
  // Range/Weather/Volume/Models-scoped and would silently change which
  // rows appear here whenever someone adjusts a toggle on a completely
  // different card, even though nothing in THIS panel's own numbers moved.
  const COVERAGE_TARGET = 0.8;
  const totalN = allRows.reduce((s, x) => s + x.n, 0);
  const byEvidence = [...allRows].sort((a, b) => b.n - a.n);
  let cumulative = 0;
  const topKeys = new Set<string>();
  for (const x of byEvidence) {
    if (cumulative >= totalN * COVERAGE_TARGET) break;
    topKeys.add(x.key);
    cumulative += x.n;
  }

  // Within that top set, ranked by position (along the corridor), not by
  // risk — a ranked-by-value chart would bury the "where" this exists to
  // answer under whichever row happened to score highest. n is shown
  // alongside every bar (label and tooltip) because even within the top
  // set, some rows are built from far more incidents than others, and a
  // lower-n row reading as "high risk" is closer to a small-sample
  // artifact than a finding.
  const topRows = allRows.filter((x) => topKeys.has(x.key)).sort((a, b) => a.sortKey - b.sortKey);
  // Not charted, but not thrown away — a compact reference list under the
  // chart so the count for a below-threshold row is still one glance away
  // rather than gone entirely. Sorted by n descending: closest-to-qualifying
  // first, thinnest last.
  const omittedRows = allRows.filter((x) => !topKeys.has(x.key)).sort((a, b) => b.n - a.n);
  // Same row-list visual language as PredictiveCorridorChart's ranking (rank
  // number, rounded pill bar shaded by the shared indigo ramp, rounded value
  // badge, a "Highest" marker on the peak row, hover-to-inspect tooltip) —
  // kept visually consistent since both cards are ranking the same corridor,
  // just by a different metric.
  const maxAvgRisk = Math.max(...topRows.map((x) => x.avgRisk), 1e-9);
  const highestRow = topRows.length > 0 ? topRows.reduce((a, b) => (b.avgRisk > a.avgRisk ? b : a)) : null;
  const axisTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => maxAvgRisk * f);

  const renderRow = (row: Row, displayIndex: number) => {
    const pct = maxAvgRisk > 0 ? Math.max((row.avgRisk / maxAvgRisk) * 100, row.avgRisk > 0 ? 2 : 0) : 0;
    const isHighest = highestRow != null && row.key === highestRow.key;
    return (
      <div
        key={row.key}
        onMouseEnter={() => setHoveredKey(row.key)}
        onMouseLeave={() => setHoveredKey((k) => (k === row.key ? null : k))}
        style={{
          position: "relative",
          display: "grid",
          gridTemplateColumns: "26px minmax(120px, 240px) 1fr 64px",
          columnGap: "10px",
          alignItems: "center",
          padding: "5px 8px",
          borderRadius: "8px",
          background: hoveredKey === row.key ? "rgba(79,70,229,0.06)" : "transparent",
          cursor: "default",
        }}
      >
        <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "#0f172a", textAlign: "right" }}>{displayIndex}</span>
        <span
          title={row.tooltipDetail ? `${row.label} (${row.tooltipDetail})` : row.label}
          style={{ fontSize: "0.8rem", fontWeight: 600, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {row.label}
        </span>
        <div style={{ position: "relative" }}>
          <div style={{ height: 16, borderRadius: "999px", background: "#eef1f7", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                borderRadius: "999px",
                background: shadeFor(row.avgRisk / maxAvgRisk),
                transition: "width 0.2s ease",
              }}
            />
          </div>
          {isHighest && (
            <div style={{ position: "absolute", left: `${pct}%`, top: -18, transform: "translateX(-50%)", pointerEvents: "none" }}>
              <span
                style={{
                  fontSize: "0.6rem", fontWeight: 800, color: "#b45309", background: "#fffbeb",
                  border: "1px solid #fde68a", borderRadius: "999px", padding: "1px 6px", whiteSpace: "nowrap",
                }}
              >
                Highest
              </span>
            </div>
          )}
          {hoveredKey === row.key && (
            <div
              style={{
                position: "absolute", right: 0, bottom: "calc(100% + 8px)", zIndex: 20, pointerEvents: "none",
                background: "#0f172a", color: "#f1f5f9", borderRadius: "8px", padding: "8px 10px",
                fontSize: "0.72rem", lineHeight: 1.5, minWidth: "200px", boxShadow: "0 10px 24px rgba(15,23,42,0.28)",
              }}
            >
              <div style={{ fontWeight: 700 }}>
                {row.label}{row.tooltipDetail ? ` (${row.tooltipDetail})` : ""}
              </div>
              <div>Avg. predicted risk: {(row.avgRisk * 100).toFixed(1)}%</div>
              <div style={{ color: "#94a3b8" }}>
                {row.actualSecondaryCount} of {row.n} held-out incidents here actually had a secondary incident follow
              </div>
            </div>
          )}
        </div>
        <span
          style={{
            justifySelf: "end", padding: "3px 10px", borderRadius: "8px",
            background: "#fff", border: "1.5px solid #e2e8f0",
            fontSize: "0.78rem", fontWeight: 700, color: "#1e1b4b",
          }}
        >
          {(row.avgRisk * 100).toFixed(1)}%
        </span>
      </div>
    );
  };

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
            Secondary Incident Risk
            <InfoTooltip text={`Probability another incident starts within ${meta?.secondary_km_radius ?? 2}km while a first one is still being responded to — a logistic regression scored on held-out incidents, not an observed rate.`} />
          </h3>
        </div>
        <div style={{ display: "inline-flex", gap: "2px", padding: "3px", background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef", borderRadius: "999px", flexShrink: 0 }}>
          {(["exit", "km"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              disabled={v === "km" && data.secondaryRiskByKmSegment.length === 0}
              title={v === "km" ? "Grouped by quantile km segments instead of nearest exit — equal incident count per segment, unequal width" : "Grouped by exit — the specific interchange to dispatch resources to"}
              style={{
                padding: "4px 12px", borderRadius: "999px", border: "none", cursor: "pointer",
                background: view === v ? "#4f46e5" : "transparent",
                color: view === v ? "#fff" : "#4b5e7d",
                fontWeight: 600, fontSize: "0.72rem", whiteSpace: "nowrap",
                opacity: v === "km" && data.secondaryRiskByKmSegment.length === 0 ? 0.4 : 1,
              }}
            >
              {v === "exit" ? "By Exit" : "By Km"}
            </button>
          ))}
        </div>
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

      {topRows.length > 0 && (
        <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "12px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "6px" }}>
            <div>
              <div style={{ fontSize: "0.68rem", fontWeight: 800, color: "#4f46e5", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                Top {view === "km" ? "segments" : "corridors"} by evidence
              </div>
              <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Avg. predicted secondary-incident risk</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "0.7rem", color: "#94a3b8" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: 10, height: 10, borderRadius: "999px", background: "linear-gradient(90deg, #818cf8, #3730a3)", display: "inline-block" }} />
                darker = higher risk
              </span>
              <span>Hover a row to inspect its numbers</span>
            </div>
          </div>
          <p style={{ color: "#94a3b8", fontSize: "0.72rem", margin: "0 0 10px 0" }}>
            Charting the {topRows.length} of {allRows.length} {view === "km" ? "km segments" : "exits"} that
            together account for at least {Math.round(COVERAGE_TARGET * 100)}% of this panel&apos;s {fmtInt(totalN)}{" "}
            held-out incidents — enough evidence to rank with some confidence. Even within this set n still varies,
            so thin bars are less certain than they look; the rest are listed, not dropped, below.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {topRows.map((row, i) => renderRow(row, i + 1))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "26px minmax(120px, 240px) 1fr 64px", columnGap: "10px", marginTop: "6px" }}>
            <span />
            <span />
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid #e2e8f0", paddingTop: "4px" }}>
              {axisTicks.map((t, i) => (
                <span key={i} style={{ fontSize: "0.66rem", color: "#94a3b8" }}>{Math.round(t * 100)}%</span>
              ))}
            </div>
            <span />
            {/* Centered under the whole row (rank + label + track + value),
                not just the narrow track column the ticks sit in — a
                caption centered under only that sub-column reads as
                off-center relative to the card a reader is actually
                looking at. */}
            <div style={{ gridColumn: "1 / -1", textAlign: "center", fontSize: "0.66rem", color: "#94a3b8", marginTop: "2px" }}>
              Avg. predicted secondary-incident risk
            </div>
          </div>
          {omittedRows.length > 0 && (
            <div style={{ marginTop: "12px" }}>
              <p style={{ color: "#94a3b8", fontSize: "0.72rem", margin: "0 0 6px 0" }}>
                Below the coverage threshold — not charted above, but not dropped either:
              </p>
              <table style={{ width: "100%", fontSize: "0.76rem", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                    <th style={{ fontWeight: 600, paddingBottom: "4px" }}>{view === "km" ? "Segment" : "Exit"}</th>
                    <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>n</th>
                    <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>Avg. risk</th>
                  </tr>
                </thead>
                <tbody>
                  {omittedRows.map((x) => (
                    <tr key={x.key} style={{ borderTop: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "3px 0", color: "#64748b" }}>{x.label}</td>
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
