"use client";

import { useState } from "react";
import InfoTooltip from "./InfoTooltip";
import type { CorridorForecastPoint, KmSegmentForecastPoint } from "./incidentPredictive.shared";
import { fmtInt } from "./incidentPredictive.shared";

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

type Props = {
  corridorForecast: CorridorForecastPoint[] | null;
  // Same apportionment as corridorForecast, grouped by fixed 5km corridor
  // segments instead of nearest exit — see the toggle below for why this is
  // a genuinely different (not redundant) view: the corridor's inter-exit
  // gaps run up to ~11.6km, and the exit view snaps every incident in that
  // whole stretch to whichever endpoint is nearest.
  kmSegmentForecast: KmSegmentForecastPoint[] | null;
  unclassifiedLocationShare: number | null;
  forecastHorizon: number;
  // The chart's own Volume/Weather toggle state — the backend re-derives
  // corridorForecast's total from the corresponding volume-free/weather-free
  // series whenever either is off, so this card's number moves with the
  // toggles above it instead of always describing the full-feature forecast.
  showVolume: boolean;
  showWeather: boolean;
  // Pretty label of whichever model this was apportioned from — the Models
  // toolbar's active pick, or the champion when nothing was picked yet.
  // Null only alongside a null corridorForecast.
  forecastModelLabel: string | null;
  loading: boolean;
};

// Mostly presentational — no fetch of its own for corridorForecast, which is
// part of the same /api/incident/predictive response PredictiveIncidentChart
// already fetches (Range/Weather/Volume/Weather/Models-toolbar-scoped the
// same way), lifted here via a callback prop so this card doesn't duplicate
// that network call.
export default function PredictiveCorridorChart({
  corridorForecast,
  kmSegmentForecast,
  unclassifiedLocationShare,
  forecastHorizon,
  showVolume,
  showWeather,
  forecastModelLabel,
  loading,
}: Props) {
  const [view, setView] = useState<"exit" | "km">("exit");
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  if (loading && corridorForecast === null) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>Loading corridor breakdown…</div>
      </article>
    );
  }

  if (corridorForecast === null || corridorForecast.length === 0) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "420px" }}>
          <div style={{ fontWeight: 700, color: "#334155", marginBottom: "6px" }}>Corridor breakdown unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            No incidents in the current Range had a location that could be matched to a corridor exit.
          </div>
        </div>
      </article>
    );
  }

  // Common shape both views reduce to, so one chart/callout implementation
  // serves either grouping instead of two near-duplicate ones.
  type Row = { key: string; label: string; tooltipDetail: string; predictedIncidents: number; historicalShare: number; historicalCount: number };
  const useKmView = view === "km" && kmSegmentForecast != null && kmSegmentForecast.length > 0;

  const exitRows: Row[] = corridorForecast.map((x) => ({
    key: `exit-${x.exitId}`, label: x.exitName, tooltipDetail: `Km ${x.km}`,
    predictedIncidents: x.predictedIncidents, historicalShare: x.historicalShare, historicalCount: x.historicalCount,
  }));
  const kmRows: Row[] = (kmSegmentForecast ?? []).map((x) => ({
    key: `seg-${x.segmentStart}`, label: x.label, tooltipDetail: "",
    predictedIncidents: x.predictedIncidents, historicalShare: x.historicalShare, historicalCount: x.historicalCount,
  }));

  const rows = useKmView ? kmRows : exitRows;
  const maxPredicted = Math.max(...rows.map((x) => x.predictedIncidents), 1);
  // Summed from the bars themselves rather than trusting totalPredictedNext7Days
  // to still match — that prop is summary.totalPredictedNext7Days, the fixed
  // full-horizon primary total, while these bars now reflect whatever
  // Volume/Weather/Future window was actually apportioned. Deriving the
  // caption's number from what's on screen means the two can never disagree.
  // Identical whichever view is active — both are the same apportionment of
  // the same total, just grouped differently.
  const displayedTotal = corridorForecast.reduce((s, x) => s + x.predictedIncidents, 0);

  // The headline this card is actually for: WHERE is the forecast
  // concentrated. Recomputed on every render from whatever the active view's
  // rows currently hold, so it tracks the Range/Weather/Volume/Models
  // toggles above (and the Exit/Km toggle here) exactly the way the chart
  // and displayedTotal already do — never a stale finding left over from a
  // previous selection. Ranked by value regardless of which view is
  // display-ordered by, since the callout's job is "what's the biggest
  // finding," not "what's first on screen."
  const byValue = [...rows].sort((a, b) => b.predictedIncidents - a.predictedIncidents);
  const topRow = byValue[0];
  const topShare = topRow && displayedTotal > 0 ? topRow.predictedIncidents / displayedTotal : 0;
  const topN = Math.min(3, byValue.length);
  const topNShare =
    displayedTotal > 0 ? byValue.slice(0, topN).reduce((s, x) => s + x.predictedIncidents, 0) / displayedTotal : 0;

  // Exit view is a leaderboard: display order is rank (busiest first), split
  // into a "top 3" tier and a "remaining" tier below a divider — same
  // byValue ordering the callout above already ranks by. Km view keeps its
  // natural corridor order instead (Km 0 first) with no tiering, since the
  // whole point of that view is walking the corridor and seeing where the
  // 0-incident stretches are, not who's #1.
  const orderedRows = useKmView ? kmRows : byValue;
  const topTierRows = useKmView ? [] : orderedRows.slice(0, 3);
  const remainingRows = useKmView ? orderedRows : orderedRows.slice(3);
  const axisTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxPredicted * f));

  const renderRow = (row: Row, displayIndex: number, tier: "top" | "remaining") => {
    const pct = maxPredicted > 0 ? Math.max((row.predictedIncidents / maxPredicted) * 100, row.predictedIncidents > 0 ? 2 : 0) : 0;
    const isHighest = topRow != null && row.key === topRow.key;
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
          gridTemplateColumns: "26px minmax(120px, 240px) 1fr 64px",
          columnGap: "10px",
          alignItems: "center",
          padding: isTop ? "6px 8px" : "3px 8px",
          borderRadius: "8px",
          background: hoveredKey === row.key ? "rgba(79,70,229,0.06)" : "transparent",
          cursor: "default",
        }}
      >
        <span style={{ fontSize: isTop ? "0.9rem" : "0.74rem", fontWeight: isTop ? 800 : 600, color: isTop ? "#0f172a" : "#94a3b8", textAlign: "right" }}>
          {displayIndex}
        </span>
        <span
          title={row.tooltipDetail ? `${row.label} (${row.tooltipDetail})` : row.label}
          style={{ fontSize: isTop ? "0.85rem" : "0.76rem", fontWeight: isTop ? 700 : 500, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {row.label}
        </span>
        <div style={{ position: "relative" }}>
          <div style={{ height: barHeight, borderRadius: "999px", background: "#eef1f7", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                borderRadius: "999px",
                background: shadeFor(row.predictedIncidents / maxPredicted),
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
              <div>{fmtInt(row.predictedIncidents)} predicted incidents · next {forecastHorizon}d</div>
              <div style={{ color: "#94a3b8" }}>
                Historical share: {(row.historicalShare * 100).toFixed(1)}% ({fmtInt(row.historicalCount)} logged)
              </div>
            </div>
          )}
        </div>
        <span
          style={{
            justifySelf: "end", padding: isTop ? "4px 12px" : "2px 9px", borderRadius: "8px",
            background: "#fff", border: `1.5px solid ${isTop ? "#c7d2fe" : "#e2e8f0"}`,
            fontSize: isTop ? "0.85rem" : "0.74rem", fontWeight: isTop ? 800 : 700, color: "#1e1b4b",
          }}
        >
          {fmtInt(row.predictedIncidents)}
        </span>
      </div>
    );
  };

  const unclassifiedPct = unclassifiedLocationShare != null ? (unclassifiedLocationShare * 100).toFixed(1) : null;

  const badge = (label: string, on: boolean) => (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 9px",
        borderRadius: "999px", fontSize: "0.7rem", fontWeight: 600,
        background: on ? "rgba(79,70,229,0.1)" : "var(--bg-surface-hover, #f1f5f9)",
        color: on ? "#4338ca" : "#94a3b8",
        border: `1px solid ${on ? "rgba(79,70,229,0.25)" : "#e2e8f0"}`,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: on ? "#4f46e5" : "#cbd5e1" }} />
      {label}: {on ? "ON" : "OFF"}
    </span>
  );

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          Predicted Incidents Ranking
          <InfoTooltip text="Derived, not separately modeled: splits the total forecast above across exits or km segments by each one's historical share of incidents — there's no per-location trained model behind this chart. Follows the Models toolbar and Volume/Weather toggles above: switching either re-derives it from that selection's own forecast." />
        </h3>
        {/* Controls pinned top-right, on the title's own row — kept off the
            description below so a long description never has to compete
            with them for width and get squeezed into a sliver. */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0, flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", gap: "2px", padding: "3px", background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef", borderRadius: "999px" }}>
            {(["exit", "km"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                disabled={v === "km" && (kmSegmentForecast == null || kmSegmentForecast.length === 0)}
                title={v === "km" ? "Grouped by fixed 5km corridor segments instead of nearest exit — shows the long inter-exit stretches an exit-only view snaps entirely to whichever endpoint is closest" : "Grouped by exit — the specific interchange to dispatch resources to"}
                style={{
                  padding: "4px 12px", borderRadius: "999px", border: "none", cursor: "pointer",
                  background: view === v ? "#4f46e5" : "transparent",
                  color: view === v ? "#fff" : "#4b5e7d",
                  fontWeight: 600, fontSize: "0.72rem", whiteSpace: "nowrap",
                  opacity: v === "km" && (kmSegmentForecast == null || kmSegmentForecast.length === 0) ? 0.4 : 1,
                }}
              >
                {v === "exit" ? "By Exit" : "By Km"}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }} title="Matches the Models toolbar and Volume/Weather toggles on the forecast chart above">
            {forecastModelLabel && (
              <span
                style={{
                  display: "inline-flex", alignItems: "center", padding: "2px 9px",
                  borderRadius: "999px", fontSize: "0.7rem", fontWeight: 600,
                  background: "var(--bg-surface-hover, #f1f5f9)", color: "#334155",
                  border: "1px solid #e2e8f0",
                }}
              >
                Model: {forecastModelLabel}
              </span>
            )}
            {badge("Volume", showVolume)}
            {badge("Weather", showWeather)}
          </div>
        </div>
      </div>
      {((unclassifiedPct != null && Number(unclassifiedPct) > 0) || useKmView) && (
        <p style={{ color: "#64748b", fontSize: "0.82rem", margin: 0 }}>
          {unclassifiedPct != null && Number(unclassifiedPct) > 0 && (
            <>{unclassifiedPct}% of logged locations in this Range couldn&apos;t be matched to a specific exit and are excluded from the split.</>
          )}
          {useKmView && (
            <> Listed top-to-bottom in corridor order (Km 0 first, Km{" "}
            {kmSegmentForecast?.[kmSegmentForecast.length - 1]?.segmentEnd ?? "76"} last), not by rank — a
            0-incident stretch stays visible instead of being dropped.</>
          )}
        </p>
      )}
      {topRow && (
        <div style={{ padding: "10px 14px", borderRadius: "10px", background: "#eef2ff", border: "1px solid #c7d2fe" }}>
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#312e81" }}>
            {useKmView ? (
              <>The <strong>{topRow.label}</strong> stretch</>
            ) : (
              <><strong>{topRow.label}</strong></>
            )}{" "}
            leads the corridor at <strong>{fmtInt(topRow.predictedIncidents)}</strong> predicted incidents —{" "}
            <strong>{(topShare * 100).toFixed(0)}%</strong> of the {fmtInt(displayedTotal)}-incident total on its own.
            {topN > 1 && (
              <>
                {" "}
                The top {topN} {useKmView ? "segments" : "exits"} together account for{" "}
                <strong>{(topNShare * 100).toFixed(0)}%</strong> of the whole corridor&apos;s forecast —{" "}
                {topNShare >= 0.5
                  ? `response resources concentrated at just a few ${useKmView ? "stretches" : "exits"} would cover most of what's expected`
                  : "risk is spread wider than a handful of hotspots"}.
              </>
            )}
          </p>
        </div>
      )}
      <div style={{ width: "100%" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "6px" }}>
          <div>
            <div style={{ fontSize: "0.68rem", fontWeight: 800, color: "#4f46e5", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              {useKmView ? "Segment" : "Exit"} forecast ranking
            </div>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
              Predicted incidents · next {forecastHorizon} days
            </div>
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

        <div style={{ display: "grid", gridTemplateColumns: "26px minmax(120px, 240px) 1fr 64px", columnGap: "10px", marginTop: "6px" }}>
          <span />
          <span />
          <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid #e2e8f0", paddingTop: "4px" }}>
            {axisTicks.map((t, i) => (
              <span key={i} style={{ fontSize: "0.66rem", color: "#94a3b8" }}>{fmtInt(t)}</span>
            ))}
          </div>
          <span />
          {/* Centered under the whole row (rank + label + track + value),
              not just the narrow track column the ticks sit in — a caption
              centered under only that sub-column reads as off-center
              relative to the card a reader is actually looking at. */}
          <div style={{ gridColumn: "1 / -1", textAlign: "center", fontSize: "0.66rem", color: "#94a3b8", marginTop: "2px" }}>
            Predicted incidents (next {forecastHorizon}d)
          </div>
        </div>
      </div>
    </article>
  );
}
