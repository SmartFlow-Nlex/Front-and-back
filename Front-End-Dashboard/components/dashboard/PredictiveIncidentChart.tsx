"use client";

import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";

const days = Array.from({ length: 57 }, (_, i) => (i + 1).toString());

const actualData = [
  8, 8, 11, 11, 11, 11, 11, 11, 12, 11,
  13, 12, 12, 12, 12, 12, 11, 10, 10, 10,
  10, 10, 9, 8, 8, 8, 7, 8, 7, 6,
  6, 6, 7, 5, 6, 6, 5, 6, 7, 8,
  8, 7, 7, 8, 8, 9, 10, 11, 11, 12,
  ...Array(7).fill(null)
];

const predictedData = [
  ...Array(40).fill(null),
  8, 8, 9, 8, 9, 9, 10, 11, 11, 12,
  12, 12, 12, 12, 12, 12, 12
];

export default function PredictiveIncidentChart() {
  const option: EChartsOption = {
    grid: { left: 50, right: 20, top: 20, bottom: 60 },
    tooltip: { trigger: "axis" },
    legend: {
      data: ["Actual Count", "Predicted Count"],
      bottom: 0,
      icon: "circle",
    },
    xAxis: {
      type: "category",
      data: days,
      name: "Days",
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
      max: 16,
      interval: 4,
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
        lineStyle: { width: 2, color: "#3e67ef" },
        itemStyle: { color: "#3e67ef" },
      },
      {
        name: "Predicted Count",
        type: "line",
        data: predictedData,
        smooth: true,
        symbol: "none",
        lineStyle: { width: 2, color: "#22c55e" },
        itemStyle: { color: "#22c55e" },
        markArea: {
          silent: true,
          data: [
            [
              { xAxis: "40", itemStyle: { color: "rgba(255, 250, 205, 0.3)" } },
              { xAxis: "50" },
            ],
            [
              { xAxis: "50", itemStyle: { color: "rgba(144, 238, 144, 0.1)" } },
              { xAxis: "57" },
            ],
          ],
        },
        markLine: {
          silent: true,
          symbol: "none",
          label: { show: false },
          lineStyle: { type: "dashed", color: "#94a3b8" },
          data: [{ xAxis: "40" }, { xAxis: "50" }],
        },
      },
    ],
  };

  return (
    <article className="chart-card wide" style={{ height: "480px", padding: "20px" }}>
      <div className="chart-head" style={{ borderBottom: "none", paddingBottom: 0, marginBottom: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
          <div>
            <h3 style={{ fontSize: "1.15rem", color: "#1e293b", fontWeight: 700, margin: 0 }}>
              Predictive Incident Forecast (80/20 Split)
            </h3>
            <p style={{ color: "#64748b", fontSize: "0.85rem", margin: "4px 0 0 0" }}>
              Training (80%) | Holdout Validation (20%) | Future Forecast (7 days)
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

      <div style={{ flex: 1, minHeight: 0 }}>
        <DashboardChart option={option} />
      </div>
    </article>
  );
}
