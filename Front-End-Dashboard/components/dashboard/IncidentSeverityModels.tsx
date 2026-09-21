"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Mirrors src/services/incident-severity.service.ts's response shape — also
// duplicated in SecondaryIncidentRiskPanel.tsx, which fetches the same
// endpoint independently so the two halves of this pipeline's output (the
// curve here, the risk/severity panel there) can be laid out anywhere on
// the page without threading shared state between them. Kept in sync by
// hand, same convention already used for the Python/TS pairs elsewhere in
// this module.
//
// This card shows one view: the clearance curve by severity (PDO / Injury /
// Fatal) against a baseline. The endpoint still returns the other cuts the
// pipeline computes — "source" (Road/Motorcycle Crash), "both" (their 2x3
// cross) and "km" (quantile corridor bins) — but they are deliberately not
// rendered here; `dimension` tells them apart if one is ever brought back.
// n rides along with every point so the tooltip can show how many incidents
// stand behind each curve.
type SurvivalCurvePoint = { group: string; dimension: string; timeMin: number; survivalProbability: number; n: number };

type SeverityData = {
  survivalCurve: SurvivalCurvePoint[];
  trainedAt: string | null;
};

const GROUP_COLOR: Record<string, string> = {
  "Baseline (average incident)": "#475569",
  "Property Damage Only": "#16a34a",
  Injury: "#f59e0b",
  Fatal: "#dc2626",
};

const SEVERITY_GROUPS = ["Baseline (average incident)", "Property Damage Only", "Injury", "Fatal"];

export default function IncidentSeverityModels() {
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
        <div style={{ color: "#64748b" }}>Loading severity/clearance models…</div>
      </article>
    );
  }

  if (error || !data || data.survivalCurve.length === 0) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "420px" }}>
          <div style={{ fontWeight: 700, color: "#334155", marginBottom: "6px" }}>Severity/clearance models unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            {error ?? "The severity pipeline hasn't written its output yet — run train_incident_severity_models.py --write-db."}
          </div>
        </div>
      </article>
    );
  }

  // Median clearance per group: the first minute (curve is already time-
  // ordered per group, straight from the backend's ORDER BY) where the
  // probability of still being unresolved drops to 1-in-2 or lower. Real
  // numbers computed from whatever the last training run wrote, not
  // hardcoded — so the callout below can never drift from the chart it's
  // describing.
  const medianOf = (g: string): number | null => {
    const pts = data.survivalCurve.filter((p) => p.group === g);
    return pts.find((p) => p.survivalProbability <= 0.5)?.timeMin ?? null;
  };
  const gapFor = (dimGroups: string[]) => {
    const m = dimGroups
      .filter((g) => !g.startsWith("Baseline"))
      .map((g) => ({ group: g, median: medianOf(g) }))
      .filter((x): x is { group: string; median: number } => x.median != null)
      .sort((a, b) => a.median - b.median);
    return { fastest: m[0], slowest: m[m.length - 1] };
  };

  const groups = SEVERITY_GROUPS.filter((g) => data.survivalCurve.some((p) => p.group === g));
  const { fastest, slowest } = gapFor(groups);
  // "Prioritized by severity" is only a fair reading of the data when the
  // fastest-clearing group actually IS the more severe one — stated only
  // when true so a future retrain that finds the opposite (or no clear
  // pattern) doesn't get this component asserting a story the numbers no
  // longer support.
  const SEVERITY_RANK: Record<string, number> = { "Property Damage Only": 0, Injury: 1, Fatal: 2 };
  const prioritizedBySeverity =
    fastest && slowest && (SEVERITY_RANK[fastest.group] ?? -1) > (SEVERITY_RANK[slowest.group] ?? -1);
  const nOf = (g: string): number | null => data.survivalCurve.find((p) => p.group === g)?.n ?? null;

  const curveOption: EChartsOption = {
    // Hovering the legend or a line itself dims every other series
    // (emphasis/blur below) instead of leaving all of them at full opacity
    // fighting for attention.
    grid: { left: 56, right: 24, top: 24, bottom: 64 },
    tooltip: {
      trigger: "axis",
      formatter: (params: unknown) => {
        const items = params as { seriesName: string; value: [number, number]; marker: string }[];
        if (items.length === 0) return "";
        let tip = `<b>${items[0].value[0].toFixed(0)} min since report</b><br/>`;
        items.forEach((p) => {
          const n = nOf(p.seriesName);
          tip += `${p.marker} ${p.seriesName}: <b>${(p.value[1] * 100).toFixed(1)}%</b> still unresolved` +
            `${n != null ? ` <span style="color:#94a3b8">(n=${n})</span>` : ""}<br/>`;
        });
        return tip;
      },
    },
    legend: { bottom: 0, icon: "circle", itemGap: 16, textStyle: { fontSize: 12 } },
    xAxis: {
      type: "value",
      name: "Minutes since report",
      nameLocation: "middle",
      nameGap: 28,
      min: 0,
      axisLabel: { color: "#64748b" },
      // Vertical gridlines add crossing clutter without helping a reader
      // compare curves (that comparison is vertical, along the y-axis) —
      // dropped in favor of the horizontal ones below.
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: "Probability still unresolved",
      nameLocation: "middle",
      nameGap: 44,
      min: 0,
      max: 1,
      axisLabel: { color: "#64748b", formatter: (v: number) => `${Math.round(v * 100)}%` },
      splitLine: { lineStyle: { color: "#eef1f7" } },
    },
    series: groups.map((g, i) => {
      const median = medianOf(g);
      const isBaseline = g.startsWith("Baseline");
      return {
        name: g,
        type: "line",
        step: "end",
        showSymbol: false,
        // Baseline used to read as barely-there (1.5px hairline, default
        // small dashes) against the solid, thicker group curves — bumped to
        // a near-equal width with a bolder, more open dash pattern so it
        // still reads as "the reference line," not just another curve, but
        // is no longer the thing you have to squint for.
        lineStyle: {
          width: isBaseline ? 2.25 : 2.5,
          type: isBaseline ? [7, 4] : "solid",
          color: GROUP_COLOR[g] ?? "#64748b",
          cap: "round",
          join: "round",
        },
        itemStyle: { color: GROUP_COLOR[g] ?? "#64748b" },
        z: isBaseline ? 3 : 2,
        // Hover (legend or the line itself) highlights this series and
        // blurs the rest to 15% opacity — the standard ECharts pattern for
        // keeping a busy multi-line chart legible on demand rather than all
        // at once.
        emphasis: { focus: "series", lineStyle: { width: isBaseline ? 3 : 3.5 } },
        blur: { lineStyle: { opacity: 0.15 } },
        data: data.survivalCurve.filter((p) => p.group === g).map((p) => [p.timeMin, p.survivalProbability]),
        // The one horizontal reference every survival curve needs — "50%
        // resolved" — drawn once (first series only) so it isn't repeated
        // across the grid.
        ...(i === 0
          ? {
              markLine: {
                silent: true,
                symbol: "none",
                lineStyle: { color: "#cbd5e1", type: "dotted", width: 1.5 },
                label: { formatter: "50% resolved", position: "insideEndTop", color: "#94a3b8", fontSize: 10 },
                data: [{ yAxis: 0.5 }],
              },
            }
          : {}),
        // Marks each group's own median directly on its curve — the reader
        // can see "this is the point this callout is talking about" instead
        // of taking the number on faith. Every median sits on the same y=0.5
        // line, so close medians collide if every label sits in the same
        // spot — alternating top/bottom by series index, plus a white halo
        // behind the text, keeps them legible instead of overlapping into a
        // smear.
        ...(median != null
          ? {
              markPoint: {
                // Baseline gets a hollow marker (white fill, colored ring)
                // instead of the solid dot every other group uses — visible
                // enough to read its median without it looking like just
                // one more group in the mix.
                symbol: "circle",
                symbolSize: isBaseline ? 8 : 7,
                itemStyle: isBaseline
                  ? { color: "#fff", borderColor: GROUP_COLOR[g] ?? "#64748b", borderWidth: 2 }
                  : { color: GROUP_COLOR[g] ?? "#64748b", borderColor: "#fff", borderWidth: 1.5 },
                label: {
                  show: true,
                  formatter: `${median}m`,
                  position: i % 2 === 0 ? "top" : "bottom",
                  color: GROUP_COLOR[g] ?? "#64748b",
                  fontSize: 10,
                  fontWeight: 700,
                  backgroundColor: "rgba(255,255,255,0.85)",
                  padding: [1, 3],
                  borderRadius: 3,
                },
                data: [{ name: `${g} median`, coord: [median, 0.5] }],
              },
            }
          : {}),
      };
    }),
  };

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          Time to Clear, by Severity
          <InfoTooltip text="How quickly incidents clear (report-to-response duration — the best available proxy, since no scene-cleared timestamp exists), broken down by severity. Each curve is the probability an incident is still unresolved at a given number of minutes since it was reported; a steeper curve clears faster. Weather and traffic volume are trained covariates inside this same model (weather condition, and a real train/test volume feature — see the model's own coefficient table), not separate views here, since neither one groups incidents into categories the way severity does." />
        </h3>
      </div>
      <p style={{ color: "#64748b", fontSize: "0.82rem", margin: 0 }}>
        Hover the legend or a curve to trace it against the others.
      </p>
      {fastest && slowest && fastest.group !== slowest.group && (
        <div style={{ padding: "10px 14px", borderRadius: "10px", background: "#eef2ff", border: "1px solid #c7d2fe" }}>
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#312e81" }}>
            <strong>{fastest.group}</strong> incidents clear fastest — a median of <strong>{fastest.median} min</strong>{" "}
            to response — versus <strong>{slowest.group}</strong> at <strong>{slowest.median} min</strong> (
            {slowest.median - fastest.median} min slower).{" "}
            {prioritizedBySeverity
              ? "Severity isn't the bottleneck here: the data reads as response being prioritized by how serious an incident is, not overwhelmed by it."
              : "That ordering doesn't track severity in a straightforward way — worth treating as a lead for further digging, not a settled explanation."}
          </p>
        </div>
      )}
      <div style={{ width: "100%" }}>
        <DashboardChart option={curveOption} height={368} />
      </div>
    </article>
  );
}
