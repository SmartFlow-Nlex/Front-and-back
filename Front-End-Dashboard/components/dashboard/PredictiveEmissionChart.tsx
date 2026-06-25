"use client";

import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";

const days = Array.from({ length: 57 }, (_, i) => (i + 1).toString());

const actualData = [
  330, 350, 345, 350, 360, 380, 385, 420, 410, 405,
  410, 415, 400, 435, 430, 410, 405, 400, 410, 385,
  390, 345, 350, 345, 340, 310, 305, 290, 285, 280,
  255, 280, 255, 250, 245, 250, 245, 260, 275, 290,
  280, 315, 320, 310, 350, 340, 380, 395, 400, 400,
  ...Array(7).fill(null)
];

const predictedData = [
  ...Array(40).fill(null),
  280, 330, 330, 315, 340, 335, 385, 400, 405, 400,
  395, 400, 405, 410, 412, 413, 415
];

export default function PredictiveEmissionChart() {
  const option: EChartsOption = {
    grid: { left: 60, right: 20, top: 20, bottom: 60 },
    tooltip: { trigger: "axis" },
    legend: {
      data: ["Actual Emissions", "Predicted Emissions"],
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
      name: "Emissions (tons CO₂)",
      nameLocation: "middle",
      nameGap: 45,
      min: 0,
      max: 600,
      interval: 150,
      axisLabel: { color: "#64748b" },
      splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
    },
    series: [
      {
        name: "Actual Emissions",
        type: "line",
        data: actualData,
        smooth: true,
        symbol: "none",
        lineStyle: { width: 2, color: "#ef4444" },
        itemStyle: { color: "#ef4444" },
      },
      {
        name: "Predicted Emissions",
        type: "line",
        data: predictedData,
        smooth: true,
        symbol: "none",
        lineStyle: { width: 2, color: "#f59e0b" },
        itemStyle: { color: "#f59e0b" },
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
              Predictive Emissions Forecast (80/20 Split)
            </h3>
            <p style={{ color: "#64748b", fontSize: "0.85rem", margin: "4px 0 0 0" }}>
              Training (80%) | Holdout Validation (20%) | Future Forecast (7 days)
            </p>
          </div>
          <div style={{ display: "flex", gap: "16px", alignItems: "center", fontSize: "0.85rem", color: "#64748b" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ width: "20px", height: "2px", background: "#ef4444" }}></div> Actual
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ width: "20px", height: "2px", background: "#f59e0b" }}></div> Predicted
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
