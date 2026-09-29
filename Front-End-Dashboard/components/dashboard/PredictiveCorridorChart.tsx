"use client";

import { useState } from "react";
import { useThemeTokens } from "./useThemeTokens";
import InfoTooltip from "./InfoTooltip";
import NarrativePanel from "./NarrativePanel";
import type { CorridorForecastPoint, KmSegmentForecastPoint } from "./incidentPredictive.shared";
import { fmtInt } from "./incidentPredictive.shared";

// Sequential ramp (amber, light -> dark) for a magnitude job: each bar's
// shade tracks its own rank so the highest-risk segments read heavier at a
// glance, without a legend — the axis labels already name every category, and
// a single-series bar chart needs no legend box (see the dataviz skill: a
// legend is for telling series apart, and there is only one here).
//
// Amber because this ramp is Incident's, and only Incident's: its three
// consumers (the corridor ranking, SecondaryIncidentRiskPanel and
// PrescriptiveDeploymentPanel) all render on /dashboard/incident. It used to
// be indigo, which made every bar on the page the same colour as every other
// domain's — the page identity (Traffic blue / Incident amber / Emissions
// green) stopped at the tab strip and never reached the data.
//
// amber-600 rather than a paler step, for the reason the indigo version had a
// floor: validated against the card surface, the light end has to stay dark
// enough to read as a bar at all. amber-600 lands at 3.19:1 on white — better
// than the indigo-400 it replaces, which sat at 2.91:1 and was accepted only
// because the bars carry visible labels (they still do). The flat floor in
// shadeFor keeps even the smallest bar at least this dark rather than fading
// toward the surface.
const RAMP_LIGHT = { r: 217, g: 119, b: 6 }; // amber-600 -- the accessibility floor, see below
const RAMP_DARK = { r: 69, g: 26, b: 3 }; // amber-950 -- deepened from amber-900 for a wider visible range

// Exported so SecondaryIncidentRiskPanel's per-segment ranked bars can shade
// themselves the same way, rather than a second hand-tuned ramp that could
// silently drift from this one.
export function shadeFor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  // Square-root eased, not linear: these rankings are routinely long-tailed
  // (one segment can carry 30%+ of a corridor's forecast on its own), so a
  // linear map crowded every row past the top one or two into
  // indistinguishable near-identical shades -- three rows tying at 20% of
  // max used to render as literally the same colour. Easing stretches the
  // low-to-mid range across more of the ramp so intensity differences read
  // across the whole list, not just at the peak.
  const eased = Math.sqrt(clamped);
  // Floor at 0.15 (post-easing) so the smallest bar in a wide-range set
  // never reads as washed out — the ramp still tracks magnitude, just never
  // below this.
  const scaled = 0.15 + eased * 0.85;
  const r = Math.round(RAMP_LIGHT.r + (RAMP_DARK.r - RAMP_LIGHT.r) * scaled);
  const g = Math.round(RAMP_LIGHT.g + (RAMP_DARK.g - RAMP_LIGHT.g) * scaled);
  const b = Math.round(RAMP_LIGHT.b + (RAMP_DARK.b - RAMP_LIGHT.b) * scaled);
  return `rgb(${r}, ${g}, ${b})`;
}

// Inline rows shown before the reader has to reach for "See more" — kept
// small enough that the card's height doesn't dominate the tab, with the
// full ranking still one click away rather than gone.
const INLINE_LIMIT = 5;
const TOP_TIER = 5;

type Props = {
  corridorForecast: CorridorForecastPoint[] | null;
  // Same apportionment as corridorForecast, grouped by fixed 5km corridor
  // segments instead of nearest exit -- this is the only grouping the card
  // renders now (see the doc comment on buildKmSegmentForecast for why
  // segments, not exits: the corridor's inter-exit gaps run up to ~11.6km,
  // and an exit-only view snaps every incident in that whole stretch to
  // whichever endpoint is nearest). corridorForecast is kept on the props
  // only as the loading/availability signal, in lockstep with this one.
  kmSegmentForecast: KmSegmentForecastPoint[] | null;
  unclassifiedLocationShare: number | null;
  forecastHorizon: number;
  // The chart's own Volume/Weather toggle state — the backend re-derives
  // corridorForecast's total from the corresponding volume-free/weather-free
  // series whenever either is off, so this card's number moves with the
  // toggles above it instead of always describing the full-feature forecast.
  showVolume: boolean;
  showWeather: boolean;
  // Pretty label of whichever model this was apportioned from -- always the
  // pipeline's champion (see incident.service.ts: corridorForecastModel is
  // never per-request), not whatever's toggled in the Models chips above.
  // Null only alongside a null corridorForecast.
  forecastModelLabel: string | null;
  loading: boolean;
};

// Mostly presentational — no fetch of its own for corridorForecast, which is
// part of the same /api/incident/predictive response PredictiveIncidentChart
// already fetches (Range/Weather/Volume/Weather-scoped the same way), lifted
// here via a callback prop so this card doesn't duplicate that network call.
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
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [seeMoreOpen, setSeeMoreOpen] = useState(false);
  // Read before the early returns below -- a hook cannot sit after one.
  const T = useThemeTokens();

  /* The accent, darkened for light backgrounds. Mixing toward #0b1020 is what
     makes it readable on white, and exactly what makes it vanish on a dark
     card, so on dark it mixes toward white instead. */
  const accentInk = T.isDark
    ? "color-mix(in srgb, var(--page-accent, #4f46e5) 36%, #ffffff)"
    : "color-mix(in srgb, var(--page-accent, #4f46e5) 72%, #0b1020)";

  if (loading && corridorForecast === null) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ color: "var(--text-muted)" }}>Loading corridor breakdown…</div>
      </article>
    );
  }

  if (corridorForecast === null || corridorForecast.length === 0 || kmSegmentForecast == null || kmSegmentForecast.length === 0) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "420px" }}>
          <div style={{ fontWeight: 700, color: "var(--text-primary)", marginBottom: "6px" }}>Corridor breakdown unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
            No incidents in the current Range had a location that could be matched to a corridor segment.
          </div>
        </div>
      </article>
    );
  }

  type Row = { key: string; label: string; predictedIncidents: number; historicalShare: number; historicalCount: number };
  const rows: Row[] = kmSegmentForecast.map((x) => ({
    key: `seg-${x.segmentStart}`, label: x.label,
    predictedIncidents: x.predictedIncidents, historicalShare: x.historicalShare, historicalCount: x.historicalCount,
  }));
  const maxPredicted = Math.max(...rows.map((x) => x.predictedIncidents), 1);
  // Summed from the bars themselves rather than trusting totalPredictedNext7Days
  // to still match — that prop is summary.totalPredictedNext7Days, the fixed
  // full-horizon primary total, while these bars now reflect whatever
  // Volume/Weather/Future window was actually apportioned. Deriving the
  // caption's number from what's on screen means the two can never disagree.
  const displayedTotal = rows.reduce((s, x) => s + x.predictedIncidents, 0);

  // The headline this card is actually for: WHERE is the forecast
  // concentrated. Recomputed on every render from whatever the current
  // Range/Weather/Volume toggles produced, so it's never a stale finding
  // left over from a previous selection.
  const byValue = [...rows].sort((a, b) => b.predictedIncidents - a.predictedIncidents);
  const topRow = byValue[0];
  const topShare = topRow && displayedTotal > 0 ? topRow.predictedIncidents / displayedTotal : 0;
  const topN = Math.min(3, byValue.length);
  const topNShare =
    displayedTotal > 0 ? byValue.slice(0, topN).reduce((s, x) => s + x.predictedIncidents, 0) / displayedTotal : 0;

  // A leaderboard, ranked by value (busiest first) — the card's whole job is
  // "ranking," so with only one grouping left, this is the natural order.
  // Only the first INLINE_LIMIT rows show on the card itself (the first
  // TOP_TIER of those in the bigger "Top 3" style); the rest sit behind
  // "See more" rather than crowding the card with a 19-segment list.
  const orderedRows = byValue;
  const inlineRows = orderedRows.slice(0, INLINE_LIMIT);
  const restRows = orderedRows.slice(INLINE_LIMIT);
  const topTierRows = inlineRows.slice(0, TOP_TIER);
  const remainingInlineRows = inlineRows.slice(TOP_TIER);
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
        <span style={{ fontSize: isTop ? "0.9rem" : "0.74rem", fontWeight: isTop ? 800 : 600, color: isTop ? "var(--text-primary)" : "var(--text-muted)", textAlign: "right" }}>
          {displayIndex}
        </span>
        <span
          title={row.label}
          style={{ fontSize: isTop ? "0.85rem" : "0.76rem", fontWeight: isTop ? 700 : 500, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {row.label}
        </span>
        <div style={{ position: "relative" }}>
          <div style={{ height: barHeight, borderRadius: "999px", background: "var(--bg-surface-hover)", overflow: "hidden" }}>
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
                fontSize: "0.72rem", lineHeight: 1.5, minWidth: "180px", boxShadow: "0 10px 24px rgba(15,23,42,0.28)",
              }}
            >
              <div style={{ fontWeight: 700 }}>{row.label}</div>
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
            background: "var(--bg-surface)", border: `1.5px solid ${isTop ? "color-mix(in srgb, var(--page-accent, #4f46e5) 34%, transparent)" : "var(--border-default)"}`,
            fontSize: isTop ? "0.85rem" : "0.74rem", fontWeight: isTop ? 800 : 700, color: accentInk,
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
        background: on ? "color-mix(in srgb, var(--page-accent, #4f46e5) 12%, transparent)" : "var(--bg-surface-hover)",
        color: on ? accentInk : "var(--text-muted)",
        border: `1px solid ${on ? "color-mix(in srgb, var(--page-accent, #4f46e5) 28%, transparent)" : "var(--border-default)"}`,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: on ? "var(--page-accent, #4f46e5)" : "var(--border-strong)" }} />
      {label}: {on ? "ON" : "OFF"}
    </span>
  );

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: "1.05rem", color: "var(--text-primary)", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          Predicted Incidents Ranking
          <InfoTooltip text="Derived, not separately modeled: splits the total forecast above across fixed 5km corridor segments by each one's historical share of incidents — there's no per-segment trained model behind this chart. Always apportioned from the pipeline's champion model; follows the Volume/Weather toggles above, so switching either re-derives it from that selection's own forecast." />
        </h3>
        {/* Controls pinned top-right, on the title's own row — kept off the
            description below so a long description never has to compete
            with them for width and get squeezed into a sliver. */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0, flexWrap: "wrap" }} title="Matches the Volume/Weather toggles on the forecast chart above">
          {forecastModelLabel && (
            <span
              style={{
                display: "inline-flex", alignItems: "center", padding: "2px 9px",
                borderRadius: "999px", fontSize: "0.7rem", fontWeight: 600,
                background: "var(--bg-surface-hover)", color: "var(--text-secondary)",
                border: "1px solid var(--border-default)",
              }}
            >
              Model: {forecastModelLabel}
            </span>
          )}
          {badge("Volume", showVolume)}
          {badge("Weather", showWeather)}
        </div>
      </div>
      {unclassifiedPct != null && Number(unclassifiedPct) > 0 && (
        <p style={{ color: "var(--text-muted)", fontSize: "0.82rem", margin: 0 }}>
          {unclassifiedPct}% of logged locations in this Range couldn&apos;t be matched to a specific segment and are excluded from the split.
        </p>
      )}
      {topRow && (
        <div style={{ padding: "10px 14px", borderRadius: "10px", background: "color-mix(in srgb, var(--page-accent, #4f46e5) 9%, transparent)", border: "1px solid color-mix(in srgb, var(--page-accent, #4f46e5) 28%, transparent)" }}>
          <p style={{ margin: 0, fontSize: "0.85rem", color: accentInk }}>
            The <strong>{topRow.label}</strong> stretch leads the corridor at{" "}
            <strong>{fmtInt(topRow.predictedIncidents)}</strong> predicted incidents —{" "}
            <strong>{(topShare * 100).toFixed(0)}%</strong> of the {fmtInt(displayedTotal)}-incident total on its own.
            {topN > 1 && (
              <>
                {" "}
                The top {topN} segments together account for{" "}
                <strong>{(topNShare * 100).toFixed(0)}%</strong> of the whole corridor&apos;s forecast —{" "}
                {topNShare >= 0.5
                  ? "response resources concentrated at just a few stretches would cover most of what's expected"
                  : "risk is spread wider than a handful of hotspots"}.
              </>
            )}
          </p>
        </div>
      )}
      <div style={{ width: "100%" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "6px" }}>
          <div>
            <div style={{ fontSize: "0.68rem", fontWeight: 800, color: "var(--page-accent, #4f46e5)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              Segment forecast ranking
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              Predicted incidents · next {forecastHorizon} days
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "0.7rem", color: "var(--text-muted)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <span style={{ width: 10, height: 10, borderRadius: "999px", background: `linear-gradient(90deg, color-mix(in srgb, var(--page-accent, #4f46e5) 50%, ${T.isDark ? "#0d1117" : "white"}), var(--page-accent, #4f46e5))`, display: "inline-block" }} />
              darker = more predicted
            </span>
            <span>Hover a row to inspect its numbers</span>
          </div>
        </div>

        {topTierRows.length > 0 && (
          <>
            <div style={{ fontSize: "0.66rem", fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.04em", textTransform: "uppercase", margin: "10px 0 2px 0" }}>
              Top {topTierRows.length}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              {topTierRows.map((row, i) => renderRow(row, i + 1, "top"))}
            </div>
          </>
        )}

        {remainingInlineRows.length > 0 && (
          <>
            <div style={{ fontSize: "0.66rem", fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.04em", textTransform: "uppercase", margin: topTierRows.length > 0 ? "12px 0 2px 0" : "10px 0 2px 0" }}>
              Next {remainingInlineRows.length}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
              {remainingInlineRows.map((row, i) => renderRow(row, i + TOP_TIER + 1, "remaining"))}
            </div>
          </>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "26px minmax(120px, 240px) 1fr 64px", columnGap: "10px", marginTop: "6px" }}>
          <span />
          <span />
          <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-default)", paddingTop: "4px" }}>
            {axisTicks.map((t, i) => (
              <span key={i} style={{ fontSize: "0.66rem", color: "var(--text-muted)" }}>{fmtInt(t)}</span>
            ))}
          </div>
          <span />
          {/* Centered under the whole row (rank + label + track + value),
              not just the narrow track column the ticks sit in — a caption
              centered under only that sub-column reads as off-center
              relative to the card a reader is actually looking at. */}
          <div style={{ gridColumn: "1 / -1", textAlign: "center", fontSize: "0.66rem", color: "var(--text-muted)", marginTop: "2px" }}>
            Predicted incidents (next {forecastHorizon}d)
          </div>
        </div>

        {restRows.length > 0 && (
          <button
            type="button"
            onClick={() => setSeeMoreOpen(true)}
            style={{
              marginTop: "12px", width: "100%", padding: "8px 12px", borderRadius: "8px",
              border: "1px dashed var(--border-default)", background: "var(--bg-surface-hover)",
              color: accentInk, fontWeight: 600, fontSize: "0.78rem", cursor: "pointer",
            }}
          >
            See {restRows.length} more segment{restRows.length === 1 ? "" : "s"}
          </button>
        )}
      </div>

      {/* Ranked rows are the AI's only input -- same read-only contract as
          the forecast chart's own Narrative Explanation. Sent as one
          shared ranking-narrative payload rather than the forecast-error
          shape model-narrative expects, since "predicted incidents per
          segment" isn't a candidate-model comparison. */}
      <NarrativePanel
        metrics={orderedRows.map((r) => ({ model: r.label }))}
        endpoint="/api/ai-insight/ranking-narrative"
        subjectKey={JSON.stringify(["corridor-ranking", showVolume, showWeather, forecastModelLabel, orderedRows.map((r) => [r.key, r.predictedIncidents])])}
        horizonDays={forecastHorizon}
        contextLine={`Predicted incidents across ${orderedRows.length} corridor segments, next ${forecastHorizon} days.`}
        buildBody={() => ({
          cardTitle: "Predicted Incidents Ranking",
          groupBy: "segment",
          metricLabel: "Predicted incidents",
          metricUnit: "count",
          metricDescription:
            `Apportionment of the corridor's ${fmtInt(displayedTotal)}-incident, ${forecastHorizon}-day forecast across fixed 5km segments by each one's historical share of incidents — derived, not a per-segment trained model.`,
          horizonDays: forecastHorizon,
          totalLabel: `${fmtInt(displayedTotal)} incidents over the next ${forecastHorizon} days`,
          rows: orderedRows.map((r) => ({
            label: r.label,
            value: r.predictedIncidents,
            sharePct: displayedTotal > 0 ? (r.predictedIncidents / displayedTotal) * 100 : null,
          })),
        })}
      />

      {seeMoreOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="All ranked segments"
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
                <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "var(--text-primary)" }}>All segments, ranked</h3>
                <p style={{ margin: "4px 0 0 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  Ranks {INLINE_LIMIT + 1}–{orderedRows.length} of {orderedRows.length} · predicted incidents, next {forecastHorizon}d
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
              <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
                {restRows.map((row, i) => renderRow(row, i + INLINE_LIMIT + 1, "remaining"))}
              </div>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
