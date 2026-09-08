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
// dimension separates toggled views rather than one many-line chart:
// "baseline" is the single reference curve shown in every view, "severity"
// is PDO/Injury/Fatal, "source" is Road/Motorcycle Crash (added as a second
// factor after checking it turned out to be the largest clearance-time
// split found anywhere in this data — see fit_cox_ph's doc comment in
// train_incident_severity_models.py for the sanity check that ruled out
// also adding a stalled-vehicle split: that table's response-time field is
// near-uniform random noise over 0-8 minutes, not real), and "both" is the
// 2x3 cross of the two, which is what actually explains why the pooled
// severity view and the pooled source view each look the way they do (see
// the "both"-view callout below). n rides along with every point because
// the crossed cells get thin — as few as 25 incidents for Motorcycle Fatal.
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
  "Road Crash": "#2563eb",
  "Motorcycle Crash": "#7c3aed",
  // Crossed view: shaded by source (blue family = Road, purple family =
  // Motorcycle), light-to-dark tracking severity (PDO -> Injury -> Fatal) —
  // so the color itself carries both factors instead of six arbitrary hues.
  "Road Crash — Property Damage Only": "#93c5fd",
  "Road Crash — Injury": "#3b82f6",
  "Road Crash — Fatal": "#1e3a8a",
  "Motorcycle Crash — Property Damage Only": "#d8b4fe",
  "Motorcycle Crash — Injury": "#a855f7",
  "Motorcycle Crash — Fatal": "#581c87",
};

const VIEW_GROUPS: Record<"severity" | "source" | "both", string[]> = {
  severity: ["Baseline (average incident)", "Property Damage Only", "Injury", "Fatal"],
  source: ["Baseline (average incident)", "Road Crash", "Motorcycle Crash"],
  both: [
    "Baseline (average incident)",
    "Road Crash — Property Damage Only", "Road Crash — Injury", "Road Crash — Fatal",
    "Motorcycle Crash — Property Damage Only", "Motorcycle Crash — Injury", "Motorcycle Crash — Fatal",
  ],
};

type View = "severity" | "source" | "both" | "km";

export default function IncidentSeverityModels() {
  const [data, setData] = useState<SeverityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("severity");

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

  // "km" has no fixed group list (it's data-driven quantile bins, handled
  // separately below via kmGroups/kmMedians/kmBarOption) rather than one of
  // VIEW_GROUPS's fixed lists, so it falls back to an empty list here rather
  // than indexing VIEW_GROUPS with a key it doesn't have.
  const groups: string[] = view === "km" ? [] : VIEW_GROUPS[view].filter((g) => data.survivalCurve.some((p) => p.group === g));
  const { fastest, slowest } = gapFor(groups);
  // "Prioritized by severity" is only a fair reading of the data when the
  // fastest-clearing group actually IS the more severe one — stated only
  // when true so a future retrain that finds the opposite (or no clear
  // pattern) doesn't get this component asserting a story the numbers no
  // longer support.
  const SEVERITY_RANK: Record<string, number> = { "Property Damage Only": 0, Injury: 1, Fatal: 2 };
  const prioritizedBySeverity =
    view === "severity" && fastest && slowest && (SEVERITY_RANK[fastest.group] ?? -1) > (SEVERITY_RANK[slowest.group] ?? -1);
  // Whether the OTHER view's gap is smaller than this one's — computed
  // regardless of which view is active so the source callout's "bigger
  // split than severity" claim is a live comparison, not an assumption
  // baked in from checking the numbers once by hand.
  const severityGap = (() => {
    const { fastest: f, slowest: s } = gapFor(VIEW_GROUPS.severity);
    return f && s ? s.median - f.median : null;
  })();
  const sourceGap = (() => {
    const { fastest: f, slowest: s } = gapFor(VIEW_GROUPS.source);
    return f && s ? s.median - f.median : null;
  })();
  // Does severity push clearance the same direction within each source, or
  // opposite directions? This is what actually explains the pooled
  // "by severity" view above: if Road and Motorcycle move opposite ways,
  // mixing them together is what makes the pooled trend look like a single
  // clean story when it's really two different (and canceling) ones.
  // "Flat" (<1 min difference) counts as neither direction, since noise at
  // that scale shouldn't be read as a trend.
  const trendFor = (source: string): "slower" | "faster" | "flat" | null => {
    const pdo = medianOf(`${source} — Property Damage Only`);
    const fatal = medianOf(`${source} — Fatal`);
    if (pdo == null || fatal == null) return null;
    const diff = fatal - pdo;
    if (Math.abs(diff) < 1) return "flat";
    return diff > 0 ? "slower" : "faster";
  };
  const roadTrend = trendFor("Road Crash");
  const motoTrend = trendFor("Motorcycle Crash");
  const oppositeTrends =
    roadTrend && motoTrend && roadTrend !== "flat" && motoTrend !== "flat" && roadTrend !== motoTrend;
  const nOf = (g: string): number | null => data.survivalCurve.find((p) => p.group === g)?.n ?? null;

  // Km groups are data-driven (quantile bins, not a fixed list like severity/
  // source), so derived from whatever the backend actually wrote rather than
  // hardcoded — and re-sorted by the km each label starts at, since the
  // backend's own ORDER BY (alphabetical on group_label) would otherwise put
  // "Km 17–31" before "Km 5–..." the way string sorting does with numbers.
  const kmStartOf = (label: string) => Number(label.match(/Km\s*(-?\d+)/)?.[1] ?? 0);
  const kmGroups = Array.from(new Set(data.survivalCurve.filter((p) => p.dimension === "km").map((p) => p.group)))
    .sort((a, b) => kmStartOf(a) - kmStartOf(b));
  const kmMedians = kmGroups
    .map((g) => ({ group: g, median: medianOf(g), n: nOf(g) }))
    .filter((x): x is { group: string; median: number; n: number } => x.median != null);
  // A monotonic trend across ALL segments (not just first-vs-last) is a much
  // stronger claim than "the two ends differ" — checked properly rather than
  // assumed, so a real-but-noisy middle segment can't get described as part
  // of a clean gradient it isn't.
  const kmMonotonicIncreasing = kmMedians.every((x, i) => i === 0 || x.median >= kmMedians[i - 1].median);
  const kmMonotonicDecreasing = kmMedians.every((x, i) => i === 0 || x.median <= kmMedians[i - 1].median);
  const kmFirst = kmMedians[0];
  const kmLast = kmMedians[kmMedians.length - 1];

  const kmBarOption: EChartsOption = {
    grid: { left: 56, right: 24, top: 24, bottom: 48 },
    tooltip: {
      trigger: "item",
      formatter: (p: unknown) => {
        const x = kmMedians[(p as { dataIndex: number }).dataIndex];
        return `<b>${x.group}</b><br/>Median: <b>${x.median} min</b> to response<br/>n=${x.n}`;
      },
    },
    xAxis: {
      type: "category",
      data: kmMedians.map((x) => x.group),
      name: "Corridor position",
      nameLocation: "middle",
      nameGap: 32,
      axisLabel: { color: "#64748b", fontSize: 11 },
      axisLine: { lineStyle: { color: "#cbd5e1" } },
    },
    yAxis: {
      type: "value",
      name: "Median minutes to response",
      nameLocation: "middle",
      nameGap: 40,
      min: 0,
      axisLabel: { color: "#64748b" },
      splitLine: { lineStyle: { color: "#eef1f7" } },
    },
    series: [
      {
        type: "bar",
        data: kmMedians.map((x) => x.median),
        barMaxWidth: 60,
        itemStyle: { color: "#4f46e5", borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: "top", color: "#334155", fontSize: 11, fontWeight: 600, formatter: (p: unknown) => `${(p as { value: number }).value}m` },
      },
    ],
  };

  // "Both" packs 7 legend entries (baseline + 6 crossed groups) against 3-4
  // for the other views — likely to wrap onto a second legend row, so it
  // gets extra bottom margin rather than crowding into the x-axis.
  const legendRows = view === "both" ? 2 : 1;

  const curveOption: EChartsOption = {
    // Well-presented multi-line reading: hovering the legend or a line
    // itself dims every other series (emphasis/blur below) instead of
    // leaving all of them at full opacity fighting for attention — the
    // busiest view ("Both", 7 series) is where this earns its keep most.
    grid: { left: 56, right: 24, top: 24, bottom: 64 + (legendRows - 1) * 30 },
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
        // four times across the grid.
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
        // line, so close medians (the "Both" view's clustered Road/Moto
        // groups especially) collide if every label sits in the same spot —
        // alternating top/bottom by series index, plus a white halo behind
        // the text, keeps them legible instead of overlapping into a smear.
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
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
            Time to Clear, by{" "}
            {view === "severity" ? "Severity" : view === "source" ? "Incident Source" : view === "both" ? "Severity and Source" : "Corridor Position"}
            <InfoTooltip text="How quickly incidents clear (report-to-response duration — the best available proxy, since no scene-cleared timestamp exists), broken down by severity, source, or corridor position. Each curve is the probability an incident is still unresolved at a given number of minutes since it was reported; steeper curve / lower bar = clears faster." />
          </h3>
          <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
            {view === "km" ? (
              <>
                Quantile bins (equal incident count, unequal km width), not fixed-width ones — km position holds
                only a handful of distinct values in this data, so an even grid would leave several bins empty.
              </>
            ) : (
              <>
                Hover the legend or a curve to trace it against the others.
                {view === "both" && " Some crossed groups are thin (as few as 25 incidents) — hover a curve to see its n."}
              </>
            )}
          </p>
        </div>
        <div style={{ display: "inline-flex", gap: "2px", padding: "3px", background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef", borderRadius: "999px", flexShrink: 0 }}>
          {(["severity", "source", "both", "km"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: "4px 12px", borderRadius: "999px", border: "none", cursor: "pointer",
                background: view === v ? "#4f46e5" : "transparent",
                color: view === v ? "#fff" : "#4b5e7d",
                fontWeight: 600, fontSize: "0.72rem", whiteSpace: "nowrap",
              }}
            >
              {v === "severity" ? "By Severity" : v === "source" ? "By Source" : v === "both" ? "By Both" : "By Km"}
            </button>
          ))}
        </div>
      </div>
      {view !== "both" && fastest && slowest && fastest.group !== slowest.group && (
        <div style={{ padding: "10px 14px", borderRadius: "10px", background: "#eef2ff", border: "1px solid #c7d2fe" }}>
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#312e81" }}>
            <strong>{fastest.group}</strong> incidents clear fastest — a median of <strong>{fastest.median} min</strong>{" "}
            to response — versus <strong>{slowest.group}</strong> at <strong>{slowest.median} min</strong> (
            {slowest.median - fastest.median} min slower).{" "}
            {view === "severity" &&
              (prioritizedBySeverity
                ? "Severity isn't the bottleneck here: the data reads as response being prioritized by how serious an incident is, not overwhelmed by it."
                : "That ordering doesn't track severity in a straightforward way — worth treating as a lead for further digging, not a settled explanation.")}
            {view === "source" && (
              <>
                What kind of incident this is turns out to move response time more than how bad it is
                {severityGap != null && sourceGap != null && sourceGap > severityGap
                  ? ` — this split is even wider than the one by severity (${sourceGap} min vs ${severityGap} min).`
                  : "."}
              </>
            )}
          </p>
        </div>
      )}
      {view === "both" && oppositeTrends && (
        <div style={{ padding: "10px 14px", borderRadius: "10px", background: "#eef2ff", border: "1px solid #c7d2fe" }}>
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#312e81" }}>
            Severity pulls clearance time in <strong>opposite directions</strong> depending on source: within{" "}
            <strong>Road Crashes</strong>, a Fatal incident takes {medianOf("Road Crash — Fatal")}min versus{" "}
            {medianOf("Road Crash — Property Damage Only")}min for Property Damage Only —{" "}
            <strong>{roadTrend === "slower" ? "slower" : "faster"}</strong> as severity rises. Within{" "}
            <strong>Motorcycle Crashes</strong>, it&apos;s the reverse: {medianOf("Motorcycle Crash — Fatal")}min vs{" "}
            {medianOf("Motorcycle Crash — Property Damage Only")}min —{" "}
            <strong>{motoTrend === "slower" ? "slower" : "faster"}</strong> as severity rises. This is why the
            pooled &ldquo;By Severity&rdquo; view reads as one clean trend: it&apos;s actually blending two
            different (and canceling) patterns, mostly driven by which source dominates each severity bucket.
          </p>
        </div>
      )}
      {view === "km" && kmFirst && kmLast && (
        <div style={{ padding: "10px 14px", borderRadius: "10px", background: "#eef2ff", border: "1px solid #c7d2fe" }}>
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#312e81" }}>
            {kmMonotonicIncreasing || kmMonotonicDecreasing ? (
              <>
                Clearance time moves <strong>steadily {kmMonotonicIncreasing ? "up" : "down"}</strong> along the
                corridor: <strong>{kmFirst.group}</strong> at {kmFirst.median} min versus{" "}
                <strong>{kmLast.group}</strong> at {kmLast.median} min, rising through every segment in between —
                not just a difference between the two ends.
              </>
            ) : (
              <>
                No clean corridor-position trend here: median clearance time doesn&apos;t rise or fall steadily from{" "}
                <strong>{kmFirst.group}</strong> ({kmFirst.median} min) to <strong>{kmLast.group}</strong> (
                {kmLast.median} min) — it moves both ways across the four segments. Position along the corridor
                isn&apos;t the driver here the way severity and source are.
              </>
            )}
          </p>
        </div>
      )}
      <div style={{ width: "100%" }}>
        <DashboardChart option={view === "km" ? kmBarOption : curveOption} height={view === "km" ? 340 : 368 + (legendRows - 1) * 30} />
      </div>
    </article>
  );
}
