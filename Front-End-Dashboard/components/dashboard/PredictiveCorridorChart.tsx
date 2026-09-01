"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import type { CorridorForecastPoint } from "./incidentPredictive.shared";
import { fmtInt, fmtNum } from "./incidentPredictive.shared";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// The one exception to this file's "no fetch of its own" rule below: weather
// incident risk comes from train_incident_weather_speed_models.py's own
// pipeline (gold.ml_weather_speed_metadata), not from the Range/Weather-scoped
// /api/incident/predictive response corridorForecast rides in on. Piping it
// through the page's existing prop chain would mean threading a second,
// unrelated fetch through PredictiveIncidentChart's parent for one caption
// here — a small, independent fetch of just this one field is the smaller
// change. Mirrors src/services/incident-weather-speed.service.ts's response
// shape; kept in sync by hand.
type WeatherIncidentRisk = {
  auc: number | null;
  base_rate: number;
  scenarios: { rain_mm: number; probability: number }[];
};

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

// Mostly presentational — no fetch for corridorForecast itself, which is
// part of the same /api/incident/predictive response PredictiveIncidentChart
// already fetches (Range/Weather/Volume/Weather/Models-toolbar-scoped the
// same way), lifted here via a callback prop so this card doesn't duplicate
// that network call. The one exception is the small weather-incident-risk
// fetch below — see its type's doc comment for why that one field is
// independent.
export default function PredictiveCorridorChart({
  corridorForecast,
  unclassifiedLocationShare,
  forecastHorizon,
  showVolume,
  showWeather,
  forecastModelLabel,
  loading,
}: Props) {
  const [weatherRisk, setWeatherRisk] = useState<WeatherIncidentRisk | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND}/api/incident/weather-speed`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled || !json.success) return;
        const risk = json.data?.metadata?.weather_incident_risk as WeatherIncidentRisk | undefined;
        if (risk) setWeatherRisk(risk);
      })
      .catch(() => {
        // Supplementary data — the corridor chart above is the point of this
        // card, so a failed fetch here just omits the risk section rather
        // than blocking or erroring the whole card.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Already sorted descending by the backend; reversed here because ECharts'
  // category y-axis draws its data array bottom-to-top, and the ranked list
  // should read highest-risk at the top.
  const ranked = [...corridorForecast].reverse();
  const maxPredicted = Math.max(...corridorForecast.map((x) => x.predictedIncidents), 1);
  // Summed from the bars themselves rather than trusting totalPredictedNext7Days
  // to still match — that prop is summary.totalPredictedNext7Days, the fixed
  // full-horizon primary total, while these bars now reflect whatever
  // Volume/Weather/Future window was actually apportioned. Deriving the
  // caption's number from what's on screen means the two can never disagree.
  const displayedTotal = corridorForecast.reduce((s, x) => s + x.predictedIncidents, 0);

  // The headline this card is actually for: WHERE is the forecast
  // concentrated. Recomputed on every render from whatever corridorForecast
  // currently holds, so it tracks the Range/Weather/Volume/Models toggles
  // above exactly the way the chart and displayedTotal already do — never a
  // stale finding left over from a previous filter selection.
  const topHotspot = corridorForecast[0];
  const topShare = displayedTotal > 0 ? topHotspot.predictedIncidents / displayedTotal : 0;
  const topN = Math.min(3, corridorForecast.length);
  const topNShare =
    displayedTotal > 0
      ? corridorForecast.slice(0, topN).reduce((s, x) => s + x.predictedIncidents, 0) / displayedTotal
      : 0;

  const option: EChartsOption = {
    grid: { left: 190, right: 56, top: 16, bottom: 28 },
    tooltip: {
      trigger: "item",
      formatter: (p: unknown) => {
        const point = p as { name: string; value: number; dataIndex: number };
        const x = ranked[point.dataIndex];
        return (
          `<b>${x.exitName}</b> (Km ${x.km})<br/>` +
          `Predicted: <b>${fmtInt(x.predictedIncidents)}</b> incidents<br/>` +
          `Historical share: ${(x.historicalShare * 100).toFixed(1)}% (${fmtInt(x.historicalCount)} logged incidents)`
        );
      },
    },
    xAxis: {
      type: "value",
      name: `Predicted incidents (next ${forecastHorizon}d)`,
      nameLocation: "middle",
      nameGap: 28,
      min: 0,
      axisLabel: { color: "#64748b" },
      splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
    },
    yAxis: {
      type: "category",
      data: ranked.map((x) => x.exitName),
      axisLabel: { color: "#334155", fontSize: 11 },
      axisLine: { lineStyle: { color: "#cbd5e1" } },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        data: ranked.map((x) => ({
          value: x.predictedIncidents,
          itemStyle: {
            color: shadeFor(x.predictedIncidents / maxPredicted),
            // The one bar the callout above is actually talking about —
            // outlined so a reader can trace the claim straight to its bar
            // instead of having to re-scan a 20-row list for it.
            ...(x.exitId === topHotspot.exitId
              ? { borderColor: "#f59e0b", borderWidth: 2 }
              : {}),
          },
        })),
        barMaxWidth: 16,
        // 4px rounded data-end on the value side only (the far end from the
        // axis baseline), not on the anchored end.
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        label: {
          show: true,
          position: "right",
          color: "#334155",
          fontSize: 11,
          fontWeight: 600,
          formatter: (p: unknown) => fmtInt((p as { value: number }).value),
        },
        emphasis: { itemStyle: { opacity: 0.85 } },
      },
    ],
  };

  const height = Math.max(320, ranked.length * 26 + 60);
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
      <div style={{ minWidth: "260px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
            Predicted Incidents Corridor
          </h3>
          <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
            Derived, not separately modeled: the {fmtInt(displayedTotal)}-incident{" "}
            {forecastModelLabel ? `${forecastModelLabel} ` : ""}forecast above is split across exits by each
            corridor&apos;s historical share of incidents in the current Range — there is no per-exit trained model
            behind this chart. The total itself follows the Models toolbar and the Volume/Weather toggles above:
            switching the model, or turning either toggle off, re-derives it from that selection&apos;s own forecast,
            the same way the chart&apos;s lines and metrics table do.
            {unclassifiedPct != null && Number(unclassifiedPct) > 0 && (
              <> {unclassifiedPct}% of logged locations in this Range couldn&apos;t be matched to a specific exit and are excluded from the split.</>
            )}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0, flexWrap: "wrap" }} title="Matches the Models toolbar and Volume/Weather toggles on the forecast chart above">
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
      <div style={{ padding: "10px 14px", borderRadius: "10px", background: "#eef2ff", border: "1px solid #c7d2fe" }}>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#312e81" }}>
          <strong>{topHotspot.exitName}</strong> (Km {topHotspot.km}) leads the corridor at{" "}
          <strong>{fmtInt(topHotspot.predictedIncidents)}</strong> predicted incidents —{" "}
          <strong>{(topShare * 100).toFixed(0)}%</strong> of the {fmtInt(displayedTotal)}-incident total on its own.
          {topN > 1 && (
            <>
              {" "}
              The top {topN} exits together account for <strong>{(topNShare * 100).toFixed(0)}%</strong> of the
              whole corridor&apos;s forecast — {topNShare >= 0.5 ? "response resources concentrated at just a few exits would cover most of what's expected" : "risk is spread wider than a handful of hotspots"}.
            </>
          )}
        </p>
      </div>
      <div style={{ width: "100%" }}>
        <DashboardChart option={option} height={height} />
      </div>
      {weatherRisk && (
        <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "12px" }}>
          <h4 style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#0f172a", fontWeight: 700 }}>Weather incident risk</h4>
          <p style={{ color: "#94a3b8", fontSize: "0.72rem", margin: "0 0 6px 0" }}>
            Logistic regression — probability of a high-incident day (top quartile corridor-wide) as rainfall
            rises. AUC {weatherRisk.auc != null ? fmtNum(weatherRisk.auc, 3) : "—"} · base rate{" "}
            {(weatherRisk.base_rate * 100).toFixed(1)}% on a chronological holdout.
          </p>
          <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
            {weatherRisk.scenarios.map((s) => (
              <div key={s.rain_mm} style={{ padding: "6px 12px", borderRadius: "8px", background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>{s.rain_mm}mm rain</div>
                <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "#0f172a" }}>{(s.probability * 100).toFixed(1)}%</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}
