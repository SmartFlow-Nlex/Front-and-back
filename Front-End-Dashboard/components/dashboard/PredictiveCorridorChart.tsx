"use client";

import { useEffect, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import { fmtInt, fmtNum } from "./incidentPredictive.shared";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Sequential ramp (indigo, light -> dark) for a magnitude job: each bar's
// shade tracks its own rank so the highest-risk exits read heavier at a
// glance, without a legend — the axis labels already name every category, and
// a single-series bar chart needs no legend box (see the dataviz skill: a
// legend is for telling series apart, and there is only one here).
// indigo-400 rather than a paler step: validated against the card surface
// (scripts/validate_palette.js in the dataviz skill), the paler indigo-200
// this started as fell to a 1.45:1 contrast ratio — nearly invisible as a bar
// shape, label or not. indigo-400 still WARNs at 2.91:1, which the skill
// treats as acceptable only with visible labels (shipped below) or a table
// view; a flat floor here (see shadeFor) keeps every bar, even the smallest,
// at least this dark rather than fading toward the surface.
const RAMP_LIGHT = { r: 129, g: 140, b: 248 }; // indigo-400
const RAMP_DARK = { r: 55, g: 48, b: 163 }; // indigo-800

// Exported so SecondaryIncidentRiskPanel's per-exit ranked bars can shade
// themselves the same way, rather than a second hand-tuned ramp that could
// silently drift from this one.
export function shadeFor(t: number): string {
  // Floor at 0.15 so the smallest bar in a wide-range set never reads as
  // washed out — the ramp still tracks magnitude, just never below this.
  const clamped = Math.max(0.15, Math.min(1, t));
  const r = Math.round(RAMP_LIGHT.r + (RAMP_DARK.r - RAMP_LIGHT.r) * clamped);
  const g = Math.round(RAMP_LIGHT.g + (RAMP_DARK.g - RAMP_LIGHT.g) * clamped);
  const b = Math.round(RAMP_LIGHT.b + (RAMP_DARK.b - RAMP_LIGHT.b) * clamped);
  return `rgb(${r}, ${g}, ${b})`;
}

// Mirrors src/services/incident-spatial.service.ts's response shape (the
// fields this card reads). Kept in sync by hand, same convention as the
// sibling SecondaryIncidentRiskPanel/IncidentSeverityModels.
type SegmentRisk = {
  exitId: number;
  exitName: string;
  km: number;
  forecastDate: string;
  predictedIncidents: number;
  lastObservedCount: number | null;
  rank: number;
  // false = the model never saw an incident at this exit, so its 0.0 means "no
  // data", not "forecast safe". Optional so an older payload renders as before.
  hasData?: boolean;
  historyEventCount?: number | null;
};
type SegmentRiskByKm = {
  label: string;
  kmStart: number;
  kmEnd: number;
  predictedIncidents: number;
  rank: number | null;
  // full = both bounding exits have history; partial = one does (the value is that
  // exit's alone); none = neither does (no forecast to show).
  coverage?: "full" | "partial" | "none";
  noDataExits?: string[];
};
type SpatialData = {
  segmentRisk: SegmentRisk[];
  segmentRiskByKm: SegmentRiskByKm[];
  metadata: {
    // n / n_exits count only exits that have incident history (the trainer skips
    // the no-data exits when scoring), so the caption below matches what is ranked.
    spatial_lstm?: { metrics?: { MAE?: number; baseline_mae_per_exit_mean?: number; n?: number; n_exits?: number } };
  } | null;
  trainedAt: string | null;
};

// Fetches its own data, like the other severity-pipeline cards: the Spatial
// LSTM is a single "as of the last training run" snapshot, so unlike the
// walk-forward chart above it has no Range/Weather/Volume/Models dependency
// to follow — there is nothing to lift out of that chart's response.
export default function PredictiveCorridorChart() {
  const [data, setData] = useState<SpatialData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"exit" | "km">("exit");
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND}/api/incident/spatial`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setData(json.data as SpatialData);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load spatial risk model");
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
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>Loading corridor risk model…</div>
      </article>
    );
  }

  if (error || !data || data.segmentRisk.length === 0) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "420px" }}>
          <div style={{ fontWeight: 700, color: "#334155", marginBottom: "6px" }}>Corridor risk model unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            {error ?? "The spatial pipeline hasn't written its output yet — run train_incident_spatial_models.py --write-db."}
          </div>
        </div>
      </article>
    );
  }

  // Common shape both views reduce to, so one chart/callout implementation
  // serves either grouping instead of two near-duplicate ones.
  // noData: the model has no incident history here (see SegmentRisk.hasData), so
  // there is no forecast to draw — the row says so instead of showing a bare 0.0,
  // which would read as "confirmed safe" for a stretch that is simply uncovered.
  // partialOf: a stretch where only one bounding exit has data; its value is that
  // exit's alone, and the exits named here are NOT averaged in as zeros.
  type Row = {
    key: string; label: string; tooltipDetail: string; value: number; lastObserved: number | null;
    noData: boolean; partialOf?: string[]; km: number; historyCount?: number | null;
  };
  const useKmView = view === "km" && data.segmentRiskByKm.length > 0;

  const exitRows: Row[] = data.segmentRisk.map((x) => ({
    key: `exit-${x.exitId}`, label: x.exitName, tooltipDetail: `Km ${x.km}`,
    value: x.predictedIncidents, lastObserved: x.lastObservedCount,
    noData: x.hasData === false, km: x.km, historyCount: x.historyEventCount ?? null,
  }));
  const kmRows: Row[] = [...data.segmentRiskByKm]
    .sort((a, b) => a.kmStart - b.kmStart)
    .map((x) => ({
      key: `seg-${x.kmStart}`, label: x.label, tooltipDetail: `Km ${x.kmStart}–${x.kmEnd}`,
      value: x.predictedIncidents, lastObserved: null,
      noData: x.coverage === "none", km: x.kmStart,
      partialOf: x.coverage === "partial" ? (x.noDataExits ?? []) : undefined,
    }));

  // Everything ranked, scaled and totalled below uses only rows that HAVE a
  // forecast — a no-data row must not take a rank, stretch the axis, or count
  // toward the corridor total.
  const rankedExitRows = exitRows.filter((x) => !x.noData);
  const noDataExitRows = exitRows.filter((x) => x.noData).sort((a, b) => a.km - b.km);
  const rankedKmRows = kmRows.filter((x) => !x.noData);

  const byValue = [...rankedExitRows].sort((a, b) => b.value - a.value);
  const maxValue = Math.max(...(useKmView ? rankedKmRows : rankedExitRows).map((x) => x.value), 1e-9);
  const exitTotal = rankedExitRows.reduce((s, x) => s + x.value, 0);
  const topN = Math.min(3, byValue.length);
  const topNShare = exitTotal > 0 ? byValue.slice(0, topN).reduce((s, x) => s + x.value, 0) / exitTotal : 0;

  // Exit view is a leaderboard (rank order, top-3 tier + the rest, then the exits
  // with no data); Km view keeps corridor order (Km 0 first) with no tiering,
  // since walking the corridor is that view's whole point — so its no-data
  // stretches stay where they are on the corridor.
  const topKmRow = [...rankedKmRows].sort((a, b) => b.value - a.value)[0];
  const headline = useKmView ? topKmRow : byValue[0];
  const topTierRows = useKmView ? [] : byValue.slice(0, 3);
  const remainingRows = useKmView ? kmRows : byValue.slice(3);
  const noDataGroupRows = useKmView ? [] : noDataExitRows;
  const noDataExitNames = noDataExitRows.map((x) => x.label);
  const axisTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => maxValue * f);

  const forecastDate = data.segmentRisk[0]?.forecastDate ?? null;
  const lstm = data.metadata?.spatial_lstm?.metrics;

  const renderRow = (row: Row, displayIndex: number, tier: "top" | "remaining") => {
    const pct = row.noData ? 0 : maxValue > 0 ? Math.max((row.value / maxValue) * 100, row.value > 0 ? 2 : 0) : 0;
    const isHighest = !row.noData && headline != null && row.key === headline.key;
    const isTop = tier === "top";
    const barHeight = isTop ? 20 : 13;
    return (
      <div
        key={row.key}
        onMouseEnter={() => setHoveredKey(row.key)}
        onMouseLeave={() => setHoveredKey((k) => (k === row.key ? null : k))}
        style={{
          position: "relative",
          display: "grid",
          gridTemplateColumns: "26px minmax(120px, 240px) 1fr 76px",
          columnGap: "10px",
          alignItems: "center",
          padding: isTop ? "6px 8px" : "3px 8px",
          borderRadius: "8px",
          background: hoveredKey === row.key ? "rgba(79,70,229,0.06)" : "transparent",
          cursor: "default",
        }}
      >
        <span style={{ fontSize: isTop ? "0.9rem" : "0.74rem", fontWeight: isTop ? 800 : 600, color: isTop ? "#0f172a" : "#94a3b8", textAlign: "right" }}>
          {row.noData ? "—" : displayIndex}
        </span>
        <span
          title={row.tooltipDetail ? `${row.label} (${row.tooltipDetail})` : row.label}
          style={{
            fontSize: isTop ? "0.85rem" : "0.76rem", fontWeight: isTop ? 700 : 500,
            color: row.noData ? "#64748b" : "#334155",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          {row.label}
          {row.partialOf && (
            <span
              style={{
                marginLeft: 6, fontSize: "0.58rem", fontWeight: 800, color: "#92400e", background: "#fffbeb",
                border: "1px solid #fde68a", borderRadius: "999px", padding: "0 5px", verticalAlign: "middle",
              }}
            >
              partial
            </span>
          )}
        </span>
        <div style={{ position: "relative" }}>
          {/* A hatched, empty track for a no-data row: it has no bar because there is nothing to size one by. */}
          <div
            style={{
              height: barHeight, borderRadius: "999px", overflow: "hidden",
              background: row.noData
                ? "repeating-linear-gradient(135deg, #f1f5f9 0 6px, #e2e8f0 6px 12px)"
                : "#eef1f7",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                borderRadius: "999px",
                background: shadeFor(row.value / maxValue),
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
                fontSize: "0.72rem", lineHeight: 1.5, minWidth: "180px", boxShadow: "0 10px 24px rgba(15,23,42,0.28)",
              }}
            >
              <div style={{ fontWeight: 700 }}>
                {row.label}{row.tooltipDetail ? ` (${row.tooltipDetail})` : ""}
              </div>
              {row.noData ? (
                <div>
                  No incident data. No accident or breakdown records are loaded {useKmView ? "for this stretch" : "for this exit"}, so
                  there is no forecast — a coverage gap in the loaded data, not a low-risk reading.
                </div>
              ) : (
                <>
                  <div>{fmtNum(row.value, 1)} predicted incidents · next 24h</div>
                  {row.partialOf && (
                    <div style={{ color: "#fcd34d" }}>
                      Partial: based on the bound with data only. {row.partialOf.join(" and ")} has no incident data and
                      is not averaged in as a zero.
                    </div>
                  )}
                  {row.lastObserved != null && (
                    <div style={{ color: "#94a3b8" }}>{fmtInt(row.lastObserved)} observed the last day</div>
                  )}
                  {row.historyCount != null && (
                    <div style={{ color: "#94a3b8" }}>{fmtInt(row.historyCount)} incidents on record here</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        <span
          style={{
            justifySelf: "end", padding: isTop ? "4px 12px" : "2px 9px", borderRadius: "8px",
            background: row.noData ? "#f8fafc" : "#fff",
            border: row.noData ? "1.5px dashed #cbd5e1" : `1.5px solid ${isTop ? "#c7d2fe" : "#e2e8f0"}`,
            fontSize: row.noData ? "0.68rem" : isTop ? "0.85rem" : "0.74rem",
            fontWeight: row.noData ? 700 : isTop ? 800 : 700,
            color: row.noData ? "#64748b" : "#1e1b4b",
            whiteSpace: "nowrap",
          }}
        >
          {row.noData ? "No data" : fmtNum(row.value, 1)}
        </span>
      </div>
    );
  };

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          Predicted Incidents Ranking
          <InfoTooltip text="A trained per-exit model, not a split of the forecast above: a Spatial LSTM (one network shared across all 20 exits, fed each exit's own recent incident history plus its nearest neighbours') forecasts each exit's next-day incident count. Accidents and breakdowns are both counted, placed by corridor_km. It is a snapshot from the last training run, so it does not follow the Range/Weather/Volume/Models controls above. By Km averages the two exits that bound each stretch — the model predicts at exits, not at arbitrary positions. An exit that has never had an incident recorded shows No data and is not ranked; in By Km it is left out of the average rather than counted as a zero." />
        </h3>
        <div style={{ display: "inline-flex", gap: "2px", padding: "3px", background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef", borderRadius: "999px" }}>
          {(["exit", "km"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              disabled={v === "km" && data.segmentRiskByKm.length === 0}
              title={v === "km" ? "Grouped by exit-to-exit stretch — each value is the average of the two exits that bound it" : "Grouped by exit — the specific interchange to dispatch resources to"}
              style={{
                padding: "4px 12px", borderRadius: "999px", border: "none", cursor: "pointer",
                background: view === v ? "#4f46e5" : "transparent",
                color: view === v ? "#fff" : "#4b5e7d",
                fontWeight: 600, fontSize: "0.72rem", whiteSpace: "nowrap",
                opacity: v === "km" && data.segmentRiskByKm.length === 0 ? 0.4 : 1,
              }}
            >
              {v === "exit" ? "By Exit" : "By Km"}
            </button>
          ))}
        </div>
      </div>
      <p style={{ color: "#64748b", fontSize: "0.82rem", margin: 0 }}>
        Spatial LSTM forecast{forecastDate ? ` for ${forecastDate}` : ""}, as of the last training run.
        {lstm?.MAE != null && lstm.baseline_mae_per_exit_mean != null && (
          <> Holdout error {fmtNum(lstm.MAE, 2)} incidents per exit-day, against {fmtNum(lstm.baseline_mae_per_exit_mean, 2)} for simply
          assuming each exit&apos;s historical average
          {lstm.n != null ? ` (${fmtInt(lstm.n)} exit-days${lstm.n_exits != null ? ` across the ${lstm.n_exits} exits with data` : ""})` : ""}.</>
        )}
        {useKmView && <> Listed in corridor order (Km 0 first), not by rank.</>}
      </p>
      {headline && (
        <div style={{ padding: "10px 14px", borderRadius: "10px", background: "#eef2ff", border: "1px solid #c7d2fe" }}>
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#312e81" }}>
            {useKmView ? <>The <strong>{headline.label}</strong> stretch</> : <strong>{headline.label}</strong>} is the highest-risk{" "}
            {useKmView ? "stretch" : "exit"} at <strong>{fmtNum(headline.value, 1)}</strong> predicted incidents.
            {!useKmView && topN > 1 && (
              <>
                {" "}The top {topN} exits together carry <strong>{(topNShare * 100).toFixed(0)}%</strong> of the corridor&apos;s predicted
                total — {topNShare >= 0.3
                  ? "response resources concentrated at just a few exits would cover a large share of what's expected"
                  : "risk is spread fairly evenly across the corridor rather than concentrated at a few hotspots"}.
              </>
            )}
          </p>
        </div>
      )}
      {noDataExitNames.length > 0 && (
        <div style={{ padding: "8px 12px", borderRadius: "10px", background: "#f8fafc", border: "1px dashed #cbd5e1" }}>
          <p style={{ margin: 0, fontSize: "0.8rem", color: "#475569" }}>
            <strong>{noDataExitNames.join(" and ")}</strong> {noDataExitNames.length > 1 ? "have" : "has"} no incident data:
            no accident or breakdown records are loaded {noDataExitNames.length > 1 ? "for either" : "for it"}, so the model has
            nothing to forecast from. That is missing coverage, not a confirmed-safe stretch — {noDataExitNames.length > 1 ? "they are" : "it is"} left out of
            the ranking and the totals above{useKmView ? ", and stretches that touch " + (noDataExitNames.length > 1 ? "them are" : "it is") + " marked partial or no data" : ""}.
          </p>
        </div>
      )}
      <div style={{ width: "100%" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "6px" }}>
          <div>
            <div style={{ fontSize: "0.68rem", fontWeight: 800, color: "#4f46e5", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              {useKmView ? "Segment" : "Exit"} risk ranking
            </div>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Predicted incidents · next 24h</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "0.7rem", color: "#94a3b8" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <span style={{ width: 10, height: 10, borderRadius: "999px", background: "linear-gradient(90deg, #818cf8, #3730a3)", display: "inline-block" }} />
              darker = more predicted
            </span>
            <span>Hover a row to inspect its numbers</span>
          </div>
        </div>

        {topTierRows.length > 0 && (
          <>
            <div style={{ fontSize: "0.66rem", fontWeight: 700, color: "#94a3b8", letterSpacing: "0.04em", textTransform: "uppercase", margin: "10px 0 2px 0" }}>
              Top {topTierRows.length}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              {topTierRows.map((row, i) => renderRow(row, i + 1, "top"))}
            </div>
          </>
        )}

        {remainingRows.length > 0 && (
          <>
            <div style={{ fontSize: "0.66rem", fontWeight: 700, color: "#94a3b8", letterSpacing: "0.04em", textTransform: "uppercase", margin: topTierRows.length > 0 ? "12px 0 2px 0" : "10px 0 2px 0" }}>
              {useKmView ? "All segments, in corridor order" : "Remaining exits"}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
              {remainingRows.map((row, i) => renderRow(row, useKmView ? i + 1 : i + 4, "remaining"))}
            </div>
          </>
        )}

        {noDataGroupRows.length > 0 && (
          <>
            <div style={{ fontSize: "0.66rem", fontWeight: 700, color: "#94a3b8", letterSpacing: "0.04em", textTransform: "uppercase", margin: "12px 0 2px 0" }}>
              No incident data — not ranked
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
              {noDataGroupRows.map((row) => renderRow(row, 0, "remaining"))}
            </div>
          </>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "26px minmax(120px, 240px) 1fr 76px", columnGap: "10px", marginTop: "6px" }}>
          <span />
          <span />
          <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid #e2e8f0", paddingTop: "4px" }}>
            {axisTicks.map((t, i) => (
              <span key={i} style={{ fontSize: "0.66rem", color: "#94a3b8" }}>{fmtNum(t, 1)}</span>
            ))}
          </div>
          <span />
          <div style={{ gridColumn: "1 / -1", textAlign: "center", fontSize: "0.66rem", color: "#94a3b8", marginTop: "2px" }}>
            Predicted incidents (next 24h)
          </div>
        </div>
      </div>
    </article>
  );
}
