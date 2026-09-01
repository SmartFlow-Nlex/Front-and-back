"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Mirrors src/services/incident-severity.service.ts's response shape — also
// duplicated in SecondaryIncidentRiskPanel.tsx, which fetches the same
// endpoint independently so the two halves of this pipeline's output (the
// curve here, the risk/severity panel there) can be laid out anywhere on
// the page without threading shared state between them. Kept in sync by
// hand, same convention already used for the Python/TS pairs elsewhere in
// this module.
type SurvivalCurvePoint = { group: string; timeMin: number; survivalProbability: number };

type SeverityData = {
  survivalCurve: SurvivalCurvePoint[];
  trainedAt: string | null;
};

const GROUP_COLOR: Record<string, string> = {
  "Baseline (average incident)": "#64748b",
  "Property Damage Only": "#16a34a",
  Injury: "#f59e0b",
  Fatal: "#dc2626",
};

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

  const groups = Array.from(new Set(data.survivalCurve.map((p) => p.group)));

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
  const severityGroups = groups.filter((g) => !g.startsWith("Baseline"));
  const medians = severityGroups
    .map((g) => ({ group: g, median: medianOf(g) }))
    .filter((x): x is { group: string; median: number } => x.median != null)
    .sort((a, b) => a.median - b.median);
  const fastest = medians[0];
  const slowest = medians[medians.length - 1];
  // "Prioritized by severity" is only a fair reading of the data when the
  // fastest-clearing group actually IS the more severe one — stated only
  // when true so a future retrain that finds the opposite (or no clear
  // pattern) doesn't get this component asserting a story the numbers no
  // longer support.
  const SEVERITY_RANK: Record<string, number> = { "Property Damage Only": 0, Injury: 1, Fatal: 2 };
  const prioritizedBySeverity =
    fastest && slowest && (SEVERITY_RANK[fastest.group] ?? -1) > (SEVERITY_RANK[slowest.group] ?? -1);

  const curveOption: EChartsOption = {
    grid: { left: 56, right: 24, top: 24, bottom: 56 },
    tooltip: {
      trigger: "axis",
      formatter: (params: unknown) => {
        const items = params as { seriesName: string; value: [number, number]; marker: string }[];
        if (items.length === 0) return "";
        let tip = `<b>${items[0].value[0].toFixed(0)} min since report</b><br/>`;
        items.forEach((p) => {
          tip += `${p.marker} ${p.seriesName}: <b>${(p.value[1] * 100).toFixed(1)}%</b> still unresolved<br/>`;
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
      splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
    },
    yAxis: {
      type: "value",
      name: "Probability still unresolved",
      nameLocation: "middle",
      nameGap: 44,
      min: 0,
      max: 1,
      axisLabel: { color: "#64748b", formatter: (v: number) => `${Math.round(v * 100)}%` },
      splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
    },
    series: groups.map((g, i) => {
      const median = medianOf(g);
      const isBaseline = g.startsWith("Baseline");
      return {
        name: g,
        type: "line",
        step: "end",
        showSymbol: false,
        lineStyle: { width: isBaseline ? 1.5 : 2.5, type: isBaseline ? "dashed" : "solid", color: GROUP_COLOR[g] ?? "#64748b" },
        itemStyle: { color: GROUP_COLOR[g] ?? "#64748b" },
        data: data.survivalCurve.filter((p) => p.group === g).map((p) => [p.timeMin, p.survivalProbability]),
        // The one horizontal reference every survival curve needs — "50%
        // resolved" — drawn once (first series only) so it isn't repeated
        // four times across the grid.
        ...(i === 0
          ? {
              markLine: {
                silent: true,
                symbol: "none",
                lineStyle: { color: "#94a3b8", type: "dotted", width: 1.5 },
                label: { formatter: "50% resolved", position: "insideEndTop", color: "#94a3b8", fontSize: 10 },
                data: [{ yAxis: 0.5 }],
              },
            }
          : {}),
        // Marks each group's own median directly on its curve — the reader
        // can see "this is the point this callout is talking about" instead
        // of taking the number on faith.
        ...(median != null && !isBaseline
          ? {
              markPoint: {
                symbol: "circle",
                symbolSize: 7,
                itemStyle: { color: GROUP_COLOR[g] ?? "#64748b", borderColor: "#fff", borderWidth: 1.5 },
                label: {
                  show: true,
                  formatter: `${median}m`,
                  position: "top",
                  color: GROUP_COLOR[g] ?? "#64748b",
                  fontSize: 10,
                  fontWeight: 700,
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
      <div>
        <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          Time to Clear, by Severity
        </h3>
        <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
          Cox Proportional Hazards, fit on report-to-response duration — no scene-cleared timestamp exists in the
          warehouse, so this reads as time until responders have attended, the best available proxy for
          clearance. Each curve is the probability an incident of that severity is <em>still</em> unresolved at a
          given number of minutes since it was reported; steeper = clears faster.
        </p>
      </div>
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
        <DashboardChart option={curveOption} height={360} />
      </div>
    </article>
  );
}
