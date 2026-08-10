"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type DailyPoint = {
  date: string;
  actual: number | null;
  predicted: number | null;
  predictionType: "validation" | "future" | null;
};

type PredictiveData = {
  summary: {
    totalPredictedNext7Days: number;
    peakRiskDate: string | null;
    championModel: string | null;
  };
  daily: DailyPoint[];
  featureImportance: { feature: string; importance: number }[];
  modelInfo: {
    championModel: string | null;
    forecastHorizon: number;
    trainedAt: string | null;
    metrics: Record<string, unknown> | null;
  };
};

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtDate = (d: string | null) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

export default function PredictiveIncidentChart() {
  const [data, setData] = useState<PredictiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`${BACKEND}/api/incident/predictive`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        // A non-2xx (e.g. 503 when the DB is unreachable or the pipeline
        // hasn't run yet) still has a parseable body — check success, not
        // just res.ok, so the message from the API reaches the UI.
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setData(json.data as PredictiveData);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load predictive forecast");
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
      <article className="chart-card wide" style={{ height: "480px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>Loading ML forecast from AWS…</div>
      </article>
    );
  }

  if (error || !data) {
    return (
      <article className="chart-card wide" style={{ height: "480px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "420px" }}>
          <div style={{ fontWeight: 700, color: "#b91c1c", marginBottom: "6px" }}>Predictive analytics unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>{error ?? "Database not reachable"}</div>
        </div>
      </article>
    );
  }

  const { summary, daily, featureImportance, modelInfo } = data;
  // The pipeline forecasts forward from the last day it has actuals for, not
  // from today — the source data lags real time, so that reference point has
  // to be shown, not implied.
  const lastActualDate = [...daily].reverse().find((d) => d.actual != null)?.date ?? null;
  const dates = daily.map((d) => fmtDate(d.date));
  const actualData = daily.map((d) => d.actual);
  const predictedData = daily.map((d) => d.predicted);
  const validationStart = daily.findIndex((d) => d.predictionType === "validation");
  const futureStart = daily.findIndex((d) => d.predictionType === "future");
  const lastIndex = dates.length - 1;

  const option: EChartsOption = {
    grid: { left: 50, right: 20, top: 20, bottom: 60 },
    tooltip: { trigger: "axis" },
    legend: { data: ["Actual Count", "Predicted Count"], bottom: 0, icon: "circle" },
    xAxis: {
      type: "category",
      data: dates,
      name: "Date",
      nameLocation: "middle",
      nameGap: 30,
      axisLabel: { color: "#64748b" },
      axisLine: { lineStyle: { color: "#cbd5e1" } },
    },
    yAxis: {
      type: "value",
      name: "Incident Count",
      nameLocation: "middle",
      nameGap: 30,
      min: 0,
      axisLabel: { color: "#64748b" },
      splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
    },
    series: [
      {
        name: "Actual Count",
        type: "line",
        data: actualData,
        smooth: true,
        symbol: "none",
        connectNulls: true,
        lineStyle: { width: 2, color: "#3e67ef" },
        itemStyle: { color: "#3e67ef" },
      },
      {
        name: "Predicted Count",
        type: "line",
        data: predictedData,
        smooth: true,
        symbol: "none",
        connectNulls: true,
        lineStyle: { width: 2, color: "#22c55e" },
        itemStyle: { color: "#22c55e" },
        // Shade the validation/future zones only when both boundaries were found —
        // a partially-populated table shouldn't draw a bogus zone.
        ...(validationStart >= 0 && futureStart >= 0
          ? {
              markArea: {
                silent: true,
                data: [
                  [
                    { xAxis: dates[validationStart], itemStyle: { color: "rgba(255, 250, 205, 0.3)" } },
                    { xAxis: dates[futureStart] },
                  ],
                  [
                    { xAxis: dates[futureStart], itemStyle: { color: "rgba(144, 238, 144, 0.1)" } },
                    { xAxis: dates[lastIndex] },
                  ],
                ],
              },
              markLine: {
                silent: true,
                symbol: "none",
                label: { show: false },
                lineStyle: { type: "dashed", color: "#94a3b8" },
                data: [{ xAxis: dates[validationStart] }, { xAxis: dates[futureStart] }],
              },
            }
          : {}),
      },
    ],
  };

  return (
    <article className="chart-card wide" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div className="chart-head" style={{ borderBottom: "none", paddingBottom: 0, marginBottom: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <h3 style={{ fontSize: "1.15rem", color: "#1e293b", fontWeight: 700, margin: 0 }}>
              Predictive Incident Forecast (80/20 Split)
            </h3>
            <p style={{ color: "#64748b", fontSize: "0.85rem", margin: "4px 0 0 0" }}>
              Training (80%) | Holdout Validation (20%) | {modelInfo.forecastHorizon || 7}-Day Forecast (as of last recorded data: {fmtDate(lastActualDate)})
            </p>
          </div>
          <div style={{ display: "flex", gap: "16px", alignItems: "center", fontSize: "0.85rem", color: "#64748b" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ width: "20px", height: "2px", background: "#3e67ef" }}></div> Actual
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ width: "20px", height: "2px", background: "#22c55e" }}></div> Predicted
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
        <div style={{ background: "#f8fafc", padding: "12px 14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
          <div style={{ fontSize: "0.72rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>
            Predicted Incidents (Next {modelInfo.forecastHorizon || 7} Days)
          </div>
          <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "#0f172a" }}>{fmtInt(summary.totalPredictedNext7Days)}</div>
          <div style={{ fontSize: "0.72rem", color: "#94a3b8", marginTop: "2px" }}>from {fmtDate(lastActualDate)}</div>
        </div>
        <div style={{ background: "#f8fafc", padding: "12px 14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
          <div style={{ fontSize: "0.72rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>
            Peak Risk Date
          </div>
          <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "#0f172a" }}>{fmtDate(summary.peakRiskDate)}</div>
        </div>
        <div style={{ background: "#f8fafc", padding: "12px 14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
          <div style={{ fontSize: "0.72rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>
            Model Used
          </div>
          <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "#0f172a" }}>{summary.championModel ?? "—"}</div>
        </div>
      </div>

      <div style={{ height: "320px" }}>
        <DashboardChart option={option} height={320} />
      </div>

      {featureImportance.length > 0 && (
        <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "16px", border: "1px solid #e2e8f0" }}>
          <h4 style={{ margin: "0 0 12px 0", fontSize: "0.95rem", color: "#334155", fontWeight: 600 }}>Feature Importance</h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {featureImportance.slice(0, 8).map((f) => {
              const max = Math.max(...featureImportance.map((x) => x.importance), 1e-9);
              const pct = (f.importance / max) * 100;
              return (
                <div key={f.feature} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div style={{ width: "160px", fontSize: "0.8rem", color: "#334155", flexShrink: 0 }}>{f.feature}</div>
                  <div style={{ flex: 1, background: "#e2e8f0", borderRadius: "4px", height: "8px", overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: "#3e67ef", borderRadius: "4px" }} />
                  </div>
                  <div style={{ width: "50px", textAlign: "right", fontSize: "0.78rem", color: "#64748b" }}>{f.importance.toFixed(3)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
}
