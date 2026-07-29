"use client";

import { useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";

const days = Array.from({ length: 57 }, (_, i) => (i + 1).toString());

const baseActual = [
  3950, 4100, 4200, 4300, 4400, 4500, 4700, 5100, 5100, 5150,
  5100, 5200, 5400, 5200, 5300, 5100, 4800, 5000, 4400, 4500,
  3900, 3900, 3700, 3400, 3200, 3000, 2900, 2900, 2400, 2500,
  2100, 2400, 2200, 2200, 2500, 2600, 2600, 2500, 2600, 2650,
  3100, 2950, 3050, 3600, 3500, 4100, 4350, 4100, 4800, 4500,
  ...Array(7).fill(null)
];

const basePredicted = [
  ...Array(40).fill(null),
  3150, 2900, 3000, 3550, 3450, 4000, 4250, 4100, 4800, 4500,
  4900, 5100, 5200, 5300, 5400, 5450, 5400
];

export default function PredictiveVolumeChart() {
  const [adjustment, setAdjustment] = useState(0);

  // Apply scenario adjustment only to the future forecast (days 51 to 57)
  // which are indices 50 to 56.
  const adjustedPredicted = basePredicted.map((val, index) => {
    if (val === null) return null;
    if (index >= 50) {
      return val * (1 + adjustment / 100);
    }
    return val;
  });

  const option: EChartsOption = {
    grid: { left: 60, right: 20, top: 20, bottom: 60 },
    tooltip: { trigger: "axis" },
    legend: {
      data: ["Actual Volume", "Predicted Volume"],
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
      name: "Vehicle Volume",
      nameLocation: "middle",
      nameGap: 45,
      min: 0,
      max: 6000,
      interval: 1500,
      axisLabel: { color: "#64748b" },
      splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
    },
    series: [
      {
        name: "Actual Volume",
        type: "line",
        data: baseActual,
        smooth: true,
        symbol: "none",
        lineStyle: { width: 2, color: "#3e67ef" },
        itemStyle: { color: "#3e67ef" },
      },
      {
        name: "Predicted Volume",
        type: "line",
        data: adjustedPredicted,
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
    <article className="chart-card wide" style={{ height: "560px", padding: "20px" }}>
      <div className="chart-head" style={{ borderBottom: "none", paddingBottom: 0, marginBottom: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
          <div>
            <h3 style={{ fontSize: "1.15rem", color: "#1e293b", fontWeight: 700, margin: 0 }}>
              Predictive Volume Forecast (80/20 Split)
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

      <div className="scenario-container">
        <div className="scenario-header">
          <span>Scenario Adjustment</span>
          <span>
            {adjustment > 0 ? `+${adjustment}%` : adjustment < 0 ? `${adjustment}%` : "Baseline"}
          </span>
        </div>
        <input
          type="range"
          className="scenario-slider"
          min="-30"
          max="30"
          value={adjustment}
          onChange={(e) => setAdjustment(Number(e.target.value))}
        />
        <div className="scenario-labels">
          <span>-30%</span>
          <span>Baseline</span>
          <span>+30%</span>
        </div>
      </div>
    </article>
  );
}
