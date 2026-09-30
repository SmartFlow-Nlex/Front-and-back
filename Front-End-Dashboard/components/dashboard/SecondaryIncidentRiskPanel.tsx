"use client";

import { useEffect, useState } from "react";
import { useThemeTokens } from "./useThemeTokens";
import InfoTooltip from "./InfoTooltip";
import NarrativePanel from "./NarrativePanel";
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
  // Mean of each row's Cox PH predict_median -- tracks the (heavily
  // right-skewed) accident population's own MEDIAN clearance time, not its
  // mean. See meanPredictedClearanceMin for the figure comparable to the
  // Descriptive tab's mean MTTC.
  avgPredictedClearanceMin: number | null;
  meanPredictedClearanceMin: number | null;
  avgSecondaryRisk: number | null;
  secondaryRiskByExit: SecondaryRiskByExit[];
  // Exits with no held-out incident to score (see the service's own note) — named
  // in the panel so "18 exits" is never a silent gap in a 20-exit corridor.
  exitsWithoutData?: string[];
  secondaryRiskByKmSegment: SecondaryRiskByKmSegment[];
  trainedAt: string | null;
  metadata: Metadata | null;
};

// Inline rows shown before the reader has to reach for "See more" — mirrors
// PredictiveCorridorChart's own INLINE_LIMIT so the two ranking cards behave
// the same way.
const INLINE_LIMIT = 5;

export default function SecondaryIncidentRiskPanel() {
  const [data, setData] = useState<SeverityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seeMoreOpen, setSeeMoreOpen] = useState(false);
  // Read before the early returns below -- a hook cannot sit after one.
  const T = useThemeTokens();

  /* The accent, darkened for light backgrounds. Mixing toward #0b1020 is what
     makes it readable on white, and exactly what makes it vanish on a dark
     card, so on dark it mixes toward white instead. */
  const accentInk = T.isDark
    ? "color-mix(in srgb, var(--page-accent, #4f46e5) 36%, #ffffff)"
    : "color-mix(in srgb, var(--page-accent, #4f46e5) 72%, #0b1020)";
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
        <div style={{ color: "var(--text-muted)" }}>Loading secondary incident risk…</div>
      </article>
    );
  }

  if (error || !data || data.severityBreakdown.length === 0) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "420px" }}>
          <div style={{ fontWeight: 700, color: "var(--text-secondary)", marginBottom: "6px" }}>Secondary incident risk unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
            {error ?? "The severity pipeline hasn't written its output yet — run train_incident_severity_models.py --write-db."}
          </div>
        </div>
      </article>
    );
  }

  const meta = data.metadata;
  const champion = meta?.severity.champion ?? null;

  // Grouped by fixed km segment only now (see PredictiveCorridorChart for
  // the same call).
  type Row = { key: string; label: string; n: number; avgRisk: number; actualSecondaryCount: number };
  const allRows: Row[] = data.secondaryRiskByKmSegment.map((x) => ({
    key: `seg-${x.kmStart}`, label: x.label,
    n: x.n, avgRisk: x.avgRisk, actualSecondaryCount: x.actualSecondaryCount,
  }));

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

  // Within that top set, ranked by risk (highest first) — rank 1 is the
  // segment with the highest avg. predicted secondary-incident risk, same
  // leaderboard convention as PredictiveCorridorChart's ranking. n is shown
  // alongside every bar (label and tooltip) because even within the top
  // set, some rows are built from far more incidents than others, and a
  // lower-n row reading as "high risk" is closer to a small-sample
  // artifact than a finding.
  const topRows = allRows.filter((x) => topKeys.has(x.key)).sort((a, b) => b.avgRisk - a.avgRisk);
  // Not charted, but not thrown away — a compact reference list under the
  // chart so the count for a below-threshold row is still one glance away
  // rather than gone entirely. Sorted by n descending: closest-to-qualifying
  // first, thinnest last.
  const omittedRows = allRows.filter((x) => !topKeys.has(x.key)).sort((a, b) => b.n - a.n);
  // Same row-list visual language as PredictiveCorridorChart's ranking (rank
  // number, rounded pill bar shaded by the shared amber ramp, rounded value
  // badge, a "Highest" marker on the peak row, hover-to-inspect tooltip) —
  // kept visually consistent since both cards are ranking the same corridor,
  // just by a different metric. Not split into a "top tier" the way that
  // card's exit ranking is, so only the row COUNT is capped inline.
  const inlineRows = topRows.slice(0, INLINE_LIMIT);
  const restTopRows = topRows.slice(INLINE_LIMIT);
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
        <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--text-primary)", textAlign: "right" }}>{displayIndex}</span>
        <span
          title={row.label}
          style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {row.label}
        </span>
        <div style={{ position: "relative" }}>
          <div style={{ height: 16, borderRadius: "999px", background: "var(--bg-surface-hover)", overflow: "hidden" }}>
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
                  fontSize: "0.6rem", fontWeight: 800,
                  color: T.isDark ? "#fbbf24" : "#b45309",
                  background: T.isDark ? "rgba(251,191,36,0.14)" : "#fffbeb",
                  border: `1px solid ${T.isDark ? "rgba(251,191,36,0.38)" : "#fde68a"}`,
                  borderRadius: "999px", padding: "1px 6px", whiteSpace: "nowrap",
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
                background: T.isDark ? "#05080f" : "#0f172a", color: "#f1f5f9",
                border: T.isDark ? "1px solid var(--border-strong)" : "none",
                borderRadius: "8px", padding: "8px 10px",
                fontSize: "0.72rem", lineHeight: 1.5, minWidth: "200px", boxShadow: "0 10px 24px rgba(15,23,42,0.28)",
              }}
            >
              <div style={{ fontWeight: 700 }}>{row.label}</div>
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
            background: "var(--bg-surface)", border: "1.5px solid var(--border-default)",
            fontSize: "0.78rem", fontWeight: 700, color: accentInk,
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
          <h3 style={{ fontSize: "1.05rem", color: "var(--text-primary)", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
            Secondary Incident Risk
            <InfoTooltip text={`Probability another incident starts within ${meta?.secondary_km_radius ?? 2}km while a first one is still being responded to — a logistic regression scored on held-out incidents, not an observed rate.`} />
          </h3>
        </div>
        {/* Named "Severity model", not the bare "Model" the corridor card
            uses: this endpoint takes no Range/Weather/Volume/model params at
            all (getIncidentSeverity ignores its request entirely), so there's
            no toggle-driven Volume/Weather badge to add alongside it, and
            plain "Model" would misleadingly suggest one card-wide model when
            this is specifically the severity classifier's champion -- the
            secondary-risk score above and the clearance model below are each
            their own single fixed model with no champion of their own to
            show. */}
        {champion && (
          <span
            title="The severity-classification model — chosen as its own champion; the secondary-risk score above and the clearance model are each a single fixed model, not one of several compared."
            style={{
              display: "inline-flex", alignItems: "center", padding: "2px 9px",
              borderRadius: "999px", fontSize: "0.7rem", fontWeight: 600,
              background: "var(--bg-surface-hover)", color: "var(--text-secondary)",
              border: "1px solid var(--border-default)", flexShrink: 0,
            }}
          >
            Severity model: {champion}
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 120px", padding: "10px 14px", borderRadius: "10px", background: "var(--bg-surface-hover)", border: "1px solid var(--border-default)" }}>
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase" }}>Risk score AUC</div>
          <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "var(--text-primary)" }}>
            {meta?.secondary_risk.auc != null ? fmtNum(meta.secondary_risk.auc, 3) : "—"}
          </div>
        </div>
        <div style={{ flex: "1 1 120px", padding: "10px 14px", borderRadius: "10px", background: "var(--bg-surface-hover)", border: "1px solid var(--border-default)" }}>
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase" }}>Avg. risk score</div>
          <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "var(--text-primary)" }}>
            {data.avgSecondaryRisk != null ? `${(data.avgSecondaryRisk * 100).toFixed(1)}%` : "—"}
          </div>
        </div>
      </div>

      {topRows.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border-default)", paddingTop: "12px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "6px" }}>
            <div>
              <div style={{ fontSize: "0.68rem", fontWeight: 800, color: "var(--page-accent, #4f46e5)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                Top segments by evidence
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Avg. predicted secondary-incident risk</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "0.7rem", color: "var(--text-muted)" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: 10, height: 10, borderRadius: "999px", background: `linear-gradient(90deg, color-mix(in srgb, var(--page-accent, #4f46e5) 50%, ${T.isDark ? "#0d1117" : "white"}), var(--page-accent, #4f46e5))`, display: "inline-block" }} />
                darker = higher risk
              </span>
              <span>Hover a row to inspect its numbers</span>
            </div>
          </div>
          <p style={{ color: "var(--text-muted)", fontSize: "0.72rem", margin: "0 0 10px 0" }}>
            Charting the {topRows.length} of {allRows.length} km segments that
            together account for at least {Math.round(COVERAGE_TARGET * 100)}% of this panel&apos;s {fmtInt(totalN)}{" "}
            held-out incidents — enough evidence to rank with some confidence. Even within this set n still varies,
            so thin bars are less certain than they look; the rest are listed, not dropped, below.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {inlineRows.map((row, i) => renderRow(row, i + 1))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "26px minmax(120px, 240px) 1fr 64px", columnGap: "10px", marginTop: "6px" }}>
            <span />
            <span />
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-default)", paddingTop: "4px" }}>
              {axisTicks.map((t, i) => (
                <span key={i} style={{ fontSize: "0.66rem", color: "var(--text-muted)" }}>{Math.round(t * 100)}%</span>
              ))}
            </div>
            <span />
            {/* Centered under the whole row (rank + label + track + value),
                not just the narrow track column the ticks sit in — a
                caption centered under only that sub-column reads as
                off-center relative to the card a reader is actually
                looking at. */}
            <div style={{ gridColumn: "1 / -1", textAlign: "center", fontSize: "0.66rem", color: "var(--text-muted)", marginTop: "2px" }}>
              Avg. predicted secondary-incident risk
            </div>
          </div>
          {(restTopRows.length > 0 || omittedRows.length > 0) && (
            <button
              type="button"
              onClick={() => setSeeMoreOpen(true)}
              style={{
                marginTop: "12px", width: "100%", padding: "8px 12px", borderRadius: "8px",
                border: "1px dashed var(--border-default)", background: "var(--bg-surface-hover)",
                color: accentInk, fontWeight: 600, fontSize: "0.78rem", cursor: "pointer",
              }}
            >
              See {restTopRows.length + omittedRows.length} more segment{restTopRows.length + omittedRows.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
      )}

      {/* Ranked rows are the AI's only input -- same read-only contract as
          the forecast chart's own Narrative Explanation, and the same
          ranking-narrative endpoint PredictiveCorridorChart uses, since
          both cards reduce to "a location, a magnitude, an evidence count."
          Sent as percent + n here rather than count + share, so the prompt
          reads this as a risk score, not an incident count. */}
      {allRows.length > 0 && (
        <NarrativePanel
          metrics={allRows.map((r) => ({ model: r.label }))}
          endpoint="/api/ai-insight/ranking-narrative"
          subjectKey={JSON.stringify(["secondary-risk", allRows.map((r) => [r.key, r.avgRisk, r.n])])}
          contextLine={`Avg. predicted secondary-incident risk across ${allRows.length} corridor segments.`}
          buildBody={() => ({
            cardTitle: "Secondary Incident Risk",
            groupBy: "segment",
            metricLabel: "Avg. secondary-incident risk",
            metricUnit: "percent",
            metricDescription: `Probability another incident starts within ${meta?.secondary_km_radius ?? 2}km while a first one is still being responded to — a logistic regression scored on held-out incidents, not an observed rate.`,
            rows: allRows.map((r) => ({
              label: r.label,
              value: r.avgRisk * 100,
              n: r.n,
            })),
          })}
        />
      )}

      {seeMoreOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="All segments"
          onClick={() => setSeeMoreOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(15, 23, 42, 0.55)", display: "grid", placeItems: "center", padding: 24 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(720px, 100%)", maxHeight: "84vh", display: "flex", flexDirection: "column",
              background: "var(--bg-surface)", borderRadius: 14, border: "1px solid var(--border-default)",
              boxShadow: "0 24px 60px rgba(15,23,42,0.35)", overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, padding: "18px 22px", borderBottom: "1px solid var(--border-default)" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "var(--text-primary)" }}>All segments</h3>
                <p style={{ margin: "4px 0 0 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  Avg. predicted secondary-incident risk, ranked highest to lowest
                </p>
              </div>
              <button
                onClick={() => setSeeMoreOpen(false)}
                aria-label="Close"
                style={{
                  flex: "none", width: 32, height: 32, borderRadius: 8, border: "1px solid var(--border-default)",
                  background: "var(--bg-surface)", color: "var(--text-secondary)", cursor: "pointer",
                  display: "grid", placeItems: "center", fontSize: "1rem", lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ overflowY: "auto", padding: "10px 22px 20px" }}>
              {restTopRows.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "1px", marginBottom: omittedRows.length > 0 ? "16px" : 0 }}>
                  {restTopRows.map((row, i) => renderRow(row, i + INLINE_LIMIT + 1))}
                </div>
              )}
              {omittedRows.length > 0 && (
                <div>
                  <p style={{ color: "var(--text-muted)", fontSize: "0.72rem", margin: "0 0 6px 0" }}>
                    Below the coverage threshold — not ranked above, but not dropped either:
                  </p>
                  <table style={{ width: "100%", fontSize: "0.76rem", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
                        <th style={{ fontWeight: 600, paddingBottom: "4px" }}>Segment</th>
                        <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>n</th>
                        <th style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>Avg. risk</th>
                      </tr>
                    </thead>
                    <tbody>
                      {omittedRows.map((x) => (
                        <tr key={x.key} style={{ borderTop: "1px solid var(--border-default)" }}>
                          <td style={{ padding: "3px 0", color: "var(--text-muted)" }}>{x.label}</td>
                          <td style={{ padding: "3px 0", textAlign: "right", color: "var(--text-muted)" }}>{x.n}</td>
                          <td style={{ padding: "3px 0", textAlign: "right", color: "var(--text-muted)" }}>{(x.avgRisk * 100).toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </article>
  );
}
