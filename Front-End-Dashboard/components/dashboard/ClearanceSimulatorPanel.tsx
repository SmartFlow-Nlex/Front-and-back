"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import { fmtInt } from "./incidentPredictive.shared";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Reframed from a literal "Full Closure vs Single-Lane Clearance" simulator —
// nothing in the warehouse logs a closure type, so building that toggle
// would mean inventing an effect size nothing here measures. What the data
// DOES support: real, trained clearance-time distributions (Cox PH survival
// curves) for every severity/source/corridor-position combination the Time
// to Clear chart already shows. This panel turns that into a genuine
// what-if — pick any two real scenarios, see the actual measured difference
// in how long each takes to clear — instead of simulating a variable this
// project has never recorded.
type SurvivalCurvePoint = { group: string; dimension: string; timeMin: number; survivalProbability: number; n: number };
type SeverityData = { survivalCurve: SurvivalCurvePoint[] };

// Same fixed ordering IncidentSeverityModels.tsx/IncidentTypePriorityPanel.tsx
// use, so the scenario pickers list groups in a sensible order (severity,
// then source, then crossed, then corridor position) rather than whatever
// order the backend happened to write them in — plus "km", whose group list
// is data-driven (quantile bins) rather than fixed, so it's read from
// whatever the backend actually wrote instead of hardcoded here.
const FIXED_GROUPS = [
  "Property Damage Only", "Injury", "Fatal",
  "Road Crash", "Motorcycle Crash",
  "Road Crash — Property Damage Only", "Road Crash — Injury", "Road Crash — Fatal",
  "Motorcycle Crash — Property Damage Only", "Motorcycle Crash — Injury", "Motorcycle Crash — Fatal",
];

function medianOf(pts: SurvivalCurvePoint[], group: string): number | null {
  const g = pts.filter((p) => p.group === group).sort((a, b) => a.timeMin - b.timeMin);
  return g.find((p) => p.survivalProbability <= 0.5)?.timeMin ?? null;
}
function nOf(pts: SurvivalCurvePoint[], group: string): number {
  return pts.find((p) => p.group === group)?.n ?? 0;
}
// Curves are step functions (held constant until the next timestamp, same
// "step: end" reading IncidentSeverityModels.tsx's chart uses) — the value
// at any minute is whatever the last point at or before it recorded.
function survivalAt(pts: SurvivalCurvePoint[], group: string, atMin: number): number | null {
  const g = pts.filter((p) => p.group === group).sort((a, b) => a.timeMin - b.timeMin);
  let val: number | null = null;
  for (const p of g) {
    if (p.timeMin <= atMin) val = p.survivalProbability;
    else break;
  }
  return val;
}

const CHECKPOINTS = [30, 60, 90];
const COLOR_A = "#4f46e5";
const COLOR_B = "#dc2626";

export default function ClearanceSimulatorPanel() {
  const [data, setData] = useState<SeverityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scenarioA, setScenarioA] = useState<string | null>(null);
  const [scenarioB, setScenarioB] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND}/api/incident/severity`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setData({ survivalCurve: json.data.survivalCurve });
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load clearance-time scenarios");
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
        <div style={{ color: "#64748b" }}>Loading clearance-time simulator…</div>
      </article>
    );
  }

  const curve = data?.survivalCurve ?? [];
  const kmGroups = Array.from(new Set(curve.filter((p) => p.dimension === "km").map((p) => p.group)));
  const allGroups = [...FIXED_GROUPS, ...kmGroups].filter((g) => curve.some((p) => p.group === g));

  if (error || !data || allGroups.length === 0) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "440px" }}>
          <div style={{ fontWeight: 700, color: "#334155", marginBottom: "6px" }}>Clearance-time simulator unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            {error ?? "The severity pipeline hasn't written its output yet — run train_incident_severity_models.py --write-db."}
          </div>
        </div>
      </article>
    );
  }

  const a = scenarioA ?? "Property Damage Only";
  const b = scenarioB ?? "Fatal";
  const medianA = medianOf(curve, a);
  const medianB = medianOf(curve, b);
  const nA = nOf(curve, a);
  const nB = nOf(curve, b);
  const diff = medianA != null && medianB != null ? medianB - medianA : null;

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
      type: "value", name: "Minutes since report", nameLocation: "middle", nameGap: 28, min: 0,
      axisLabel: { color: "#64748b" }, splitLine: { show: false },
    },
    yAxis: {
      type: "value", name: "Probability still unresolved", nameLocation: "middle", nameGap: 44, min: 0, max: 1,
      axisLabel: { color: "#64748b", formatter: (v: number) => `${Math.round(v * 100)}%` },
      splitLine: { lineStyle: { color: "#eef1f7" } },
    },
    series: [a, b].map((g, i) => ({
      name: g,
      type: "line",
      step: "end",
      showSymbol: false,
      lineStyle: { width: 2.5, color: i === 0 ? COLOR_A : COLOR_B },
      itemStyle: { color: i === 0 ? COLOR_A : COLOR_B },
      data: curve.filter((p) => p.group === g).sort((x, y) => x.timeMin - y.timeMin).map((p) => [p.timeMin, p.survivalProbability]),
      markLine: {
        silent: true, symbol: "none",
        lineStyle: { color: "#cbd5e1", type: "dotted", width: 1.5 },
        label: { formatter: "50% resolved", position: "insideEndTop", color: "#94a3b8", fontSize: 10 },
        data: i === 0 ? [{ yAxis: 0.5 }] : [],
      },
    })),
  };

  const picker = (label: string, value: string, onChange: (v: string) => void, color: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: "3px", flex: "1 1 220px" }}>
      <span style={{ fontSize: "0.7rem", fontWeight: 700, color, textTransform: "uppercase", letterSpacing: "0.03em" }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "6px 10px", borderRadius: "8px", border: "1px solid #dce2ef", background: "#fff",
          fontSize: "0.82rem", color: "#334155", fontWeight: 600,
        }}
      >
        {allGroups.map((g) => (
          <option key={g} value={g}>{g}</option>
        ))}
      </select>
    </div>
  );

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          Interactive &ldquo;What-If&rdquo; Incident Simulator
          <InfoTooltip text="A solution for the Predictive tab's own Time to Clear curves: pick any two severity, source, or corridor-position scenarios and compare their real, trained clearance-time distributions side by side. Not a simulation of an untested variable — no closure-type is logged anywhere in this warehouse, so this compares scenarios the data actually distinguishes rather than inventing an effect size for one it doesn't." />
        </h3>
      </div>
      <p style={{ color: "#64748b", fontSize: "0.82rem", margin: 0 }}>
        Each curve is the same Cox PH survival model the Time to Clear chart uses, scored on held-out incidents —
        pick two scenarios to weigh clearance speed against each other directly.
      </p>

      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
        {picker("Scenario A", a, (v) => setScenarioA(v), COLOR_A)}
        {picker("Scenario B", b, (v) => setScenarioB(v), COLOR_B)}
      </div>

      {medianA != null && medianB != null && diff != null && (
        <div style={{ padding: "10px 14px", borderRadius: "10px", background: "#eef2ff", border: "1px solid #c7d2fe" }}>
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#312e81" }}>
            <strong>{a}</strong> clears in a median of <strong>{medianA} min</strong> (n={fmtInt(nA)}) vs{" "}
            <strong>{b}</strong> at <strong>{medianB} min</strong> (n={fmtInt(nB)}) — a difference of{" "}
            <strong>{Math.abs(diff)} min</strong> ({diff >= 0 ? "B slower" : "A slower"}).
          </p>
        </div>
      )}

      <DashboardChart option={curveOption} height={340} />

      <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "12px" }}>
        <h4 style={{ margin: "0 0 8px 0", fontSize: "0.85rem", color: "#0f172a", fontWeight: 700 }}>Still unresolved, at each checkpoint</h4>
        <table style={{ width: "100%", fontSize: "0.78rem", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ color: "#94a3b8", textAlign: "left" }}>
              <th style={{ fontWeight: 600, paddingBottom: "4px" }}>Scenario</th>
              {CHECKPOINTS.map((t) => (
                <th key={t} style={{ fontWeight: 600, paddingBottom: "4px", textAlign: "right" }}>{t} min</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[{ label: a, color: COLOR_A }, { label: b, color: COLOR_B }].map((s) => (
              <tr key={s.label} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={{ padding: "4px 0", color: s.color, fontWeight: 700 }}>{s.label}</td>
                {CHECKPOINTS.map((t) => {
                  const v = survivalAt(curve, s.label, t);
                  return (
                    <td key={t} style={{ padding: "4px 0", textAlign: "right", color: "#334155" }}>
                      {v != null ? `${(v * 100).toFixed(1)}%` : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}
