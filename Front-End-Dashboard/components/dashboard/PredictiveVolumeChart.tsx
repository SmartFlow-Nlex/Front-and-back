"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";

export default function PredictiveVolumeChart() {
  const [chartData, setChartData] = useState<{
    dates: string[];
    baseActual: (number | null)[];
    basePredicted: (number | null)[];
  } | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("http://localhost:4000/api/traffic/forecast");
        const json = await res.json();
        
        if (json.success && json.data.volumes) {
          const dates: string[] = [];
          const baseActual: (number | null)[] = [];
          const basePredicted: (number | null)[] = [];

          json.data.volumes.forEach((v: any) => {
            const dateStr = new Date(v.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            dates.push(dateStr);
            baseActual.push(v.actual_volume);
            basePredicted.push(v.predicted_volume);
          });

          setChartData({ dates, baseActual, basePredicted });
        }
      } catch (err) {
        console.error("Failed to fetch ML forecast", err);
      }
    }
    fetchData();
  }, []);

  if (!chartData) {
    return (
      <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
        <div>Loading ML Forecast from AWS...</div>
      </article>
    );
  }

  const { dates, baseActual, basePredicted } = chartData;

  const option: EChartsOption = {
    grid: { left: 80, right: 20, top: 20, bottom: 60 },
    tooltip: { trigger: "axis", formatter: (params: any) => {
      let tooltip = `<b>${params[0].name}</b><br/>`;
      params.forEach((param: any) => {
        if (param.value !== null && param.value !== undefined) {
          tooltip += `${param.marker} ${param.seriesName}: <b>${Number(param.value).toLocaleString(undefined, {maximumFractionDigits: 0})}</b><br/>`;
        }
      });
      return tooltip;
    }},
    legend: {
      data: ["Actual Volume", "Predicted Volume"],
      bottom: 0,
      icon: "circle",
    },
    xAxis: {
      type: "category",
      data: dates,
      name: "Time",
      nameLocation: "middle",
      nameGap: 30,
      axisLabel: { color: "#64748b" },
      axisLine: { lineStyle: { color: "#cbd5e1" } },
    },
    yAxis: {
      type: "value",
      name: "Total Vehicle Volume",
      nameLocation: "middle",
      nameGap: 60,
      axisLabel: { color: "#64748b", formatter: (val) => `${(val / 1000).toFixed(0)}k` },
      splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
    },
    series: [
      {
        name: "Actual Volume",
        type: "line",
        data: baseActual,
        smooth: true,
        symbol: "none",
        lineStyle: { width: 2.5, color: "#2563eb" },
        itemStyle: { color: "#2563eb" },
      },
      {
        name: "Predicted Volume",
        type: "line",
        data: basePredicted,
        smooth: true,
        symbol: "none",
        lineStyle: { width: 2.5, color: "#16a34a" },
        itemStyle: { color: "#16a34a" },
        markArea: {
          silent: true,
          data: [
            // PAST
            [
              { xAxis: dates[0], itemStyle: { color: "rgba(37, 99, 235, 0.05)" } },
              { xAxis: dates[39] },
            ],
            // PRESENT
            [
              { xAxis: dates[39], itemStyle: { color: "rgba(249, 115, 22, 0.08)" } },
              { xAxis: dates[49] },
            ],
            // FUTURE
            [
              { xAxis: dates[49], itemStyle: { color: "rgba(22, 163, 74, 0.08)" } },
              { xAxis: dates[dates.length - 1] },
            ],
          ],
        },
        markLine: {
          silent: true,
          symbol: "none",
          label: { show: false },
          lineStyle: { type: "dashed", color: "#94a3b8" },
          data: [{ xAxis: dates[39] }, { xAxis: dates[49] }],
        },
      },
    ],
  };

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <div className="chart-head" style={{ borderBottom: "none", paddingBottom: 0, margin: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
          <div>
            <h3 style={{ fontSize: "1.25rem", color: "#0f172a", fontWeight: 700, margin: 0 }}>
              Traffic Volume Walk-Forward Forecast (LSTM Model)
            </h3>
            <p style={{ color: "#64748b", fontSize: "0.9rem", margin: "6px 0 0 0" }}>
              NLEX Traffic Volume prediction showing Training (Past), Validation (Present), and Forecast (Future) periods.
            </p>
          </div>
          <div style={{ display: "flex", gap: "16px", alignItems: "center", fontSize: "0.85rem", color: "#64748b" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ width: "16px", height: "16px", background: "rgba(37, 99, 235, 0.1)", border: "1px solid #2563eb", borderRadius: "4px" }}></div> Past (Training)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ width: "16px", height: "16px", background: "rgba(249, 115, 22, 0.1)", border: "1px solid #f97316", borderRadius: "4px" }}></div> Present (Holdout)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ width: "16px", height: "16px", background: "rgba(22, 163, 74, 0.1)", border: "1px solid #16a34a", borderRadius: "4px" }}></div> Future (Forecast)
            </div>
          </div>
        </div>
      </div>

      <div style={{ height: "450px", width: "100%" }}>
        <DashboardChart option={option} height={450} />
      </div>

      {/* Model Performance Metrics Table */}
      <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "16px", border: "1px solid #e2e8f0" }}>
        <h4 style={{ margin: "0 0 12px 0", fontSize: "0.95rem", color: "#334155", fontWeight: 600 }}>Real-World ML Validation Metrics (LSTM)</h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px" }}>
          <div style={{ background: "white", padding: "12px", borderRadius: "6px", border: "1px solid #e2e8f0", boxShadow: "0 1px 2px rgba(0,0,0,0.02)" }}>
            <div style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>Root Mean Square Error</div>
            <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>2,398 <span style={{fontSize:"0.8rem", color: "#94a3b8", fontWeight: 400}}>veh</span></div>
          </div>
          <div style={{ background: "white", padding: "12px", borderRadius: "6px", border: "1px solid #e2e8f0", boxShadow: "0 1px 2px rgba(0,0,0,0.02)" }}>
            <div style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>Mean Absolute Error</div>
            <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>1,847 <span style={{fontSize:"0.8rem", color: "#94a3b8", fontWeight: 400}}>veh</span></div>
          </div>
          <div style={{ background: "white", padding: "12px", borderRadius: "6px", border: "1px solid #e2e8f0", boxShadow: "0 1px 2px rgba(0,0,0,0.02)" }}>
            <div style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>WMAPE (Error Rate)</div>
            <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#22c55e" }}>3.73%</div>
          </div>
          <div style={{ background: "white", padding: "12px", borderRadius: "6px", border: "1px solid #e2e8f0", boxShadow: "0 1px 2px rgba(0,0,0,0.02)" }}>
            <div style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>R² Score</div>
            <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#22c55e" }}>0.981</div>
          </div>
        </div>
      </div>
    </article>
  );
}
