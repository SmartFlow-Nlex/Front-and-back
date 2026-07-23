"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";

export default function PredictiveCongestionChart() {
  const [chartData, setChartData] = useState<{
    segments: string[];
    hours: string[];
    heatmapData: [number, number, number, number][]; // [xIndex, yIndex, value, probability]
  } | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("http://localhost:4000/api/traffic/forecast");
        const json = await res.json();
        
        if (json.success && json.data.congestion) {
          const raw = json.data.congestion;
          
          // Extract unique segments and hours
          const uniqueSegments = Array.from(new Set(raw.map((d: any) => d.segment))) as string[];
          const uniqueHoursSet = new Set(raw.map((d: any) => d.hours));
          const maxHour = Math.max(...Array.from(uniqueHoursSet) as number[]);
          const hours = Array.from({ length: maxHour }, (_, i) => `+${i + 1}h`);

          const heatmapData: [number, number, number, number][] = [];
          
          raw.forEach((d: any) => {
            const yIndex = uniqueSegments.indexOf(d.segment);
            const xIndex = d.hours - 1;
            
            let val = 0;
            if (d.state === 'High') val = 2;
            else if (d.state === 'Med') val = 1;

            heatmapData.push([xIndex, yIndex, val, d.probability]);
          });

          setChartData({ segments: uniqueSegments, hours, heatmapData });
        }
      } catch (err) {
        console.error("Failed to fetch ML congestion forecast", err);
      }
    }
    fetchData();
  }, []);

  if (!chartData) {
    return (
      <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px", marginTop: "24px" }}>
        <div>Loading ML Congestion Forecast from AWS...</div>
      </article>
    );
  }

  const { segments, hours, heatmapData } = chartData;

  const option: EChartsOption = {
    tooltip: {
      position: "top",
      formatter: (params: any) => {
        const xName = hours[params.data[0]];
        const yName = segments[params.data[1]];
        const val = params.data[2];
        const prob = params.data[3];
        const status = val === 2 ? "Severe Bottleneck" : val === 1 ? "Heavy Traffic" : "Free Flow";
        const color = val === 2 ? "#ef4444" : val === 1 ? "#eab308" : "#22c55e";
        return `
          <b>${yName}</b><br/>
          Time: ${xName}<br/>
          Prediction: <span style="color:${color}; font-weight:bold;">${status}</span><br/>
          Confidence: ${(prob * 100).toFixed(1)}%
        `;
      },
    },
    grid: { left: 100, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: "category",
      data: hours,
      name: "Future Hours",
      nameLocation: "middle",
      nameGap: 25,
      splitArea: { show: true },
      axisLabel: { color: "#64748b" },
      axisLine: { lineStyle: { color: "#cbd5e1" } },
    },
    yAxis: {
      type: "category",
      data: segments,
      splitArea: { show: true },
      axisLabel: { color: "#64748b" },
      axisLine: { lineStyle: { color: "#cbd5e1" } },
    },
    visualMap: {
      show: false,
      min: 0,
      max: 2,
      inRange: {
        color: ["#dcfce7", "#fef08a", "#fecaca"], // Light green, light yellow, light red
      },
    },
    series: [
      {
        name: "Congestion Probability",
        type: "heatmap",
        data: heatmapData,
        label: {
          show: true,
          formatter: (params: any) => {
            const val = params.data[2];
            return val === 2 ? "High" : val === 1 ? "Med" : "Low";
          },
          color: "#334155",
          fontSize: 10,
        },
        itemStyle: {
          borderColor: "#ffffff",
          borderWidth: 2,
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowColor: "rgba(0, 0, 0, 0.5)",
          },
        },
      },
    ],
  };

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px", marginTop: "24px" }}>
      <div className="chart-head" style={{ borderBottom: "none", paddingBottom: 0, margin: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
          <div>
            <h3 style={{ fontSize: "1.25rem", color: "#0f172a", fontWeight: 700, margin: 0 }}>
              Predictive Congestion State Map (XGBoost)
            </h3>
            <p style={{ color: "#64748b", fontSize: "0.9rem", margin: "6px 0 0 0" }}>
              12-hour spatial forecast of segment congestion probabilities identifying future bottleneck states.
            </p>
          </div>
          <div style={{ display: "flex", gap: "16px", alignItems: "center", fontSize: "0.85rem", color: "#64748b" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ width: "16px", height: "16px", background: "#dcfce7", border: "1px solid #22c55e", borderRadius: "4px" }}></div> Low Risk (Free Flow)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ width: "16px", height: "16px", background: "#fef08a", border: "1px solid #eab308", borderRadius: "4px" }}></div> Med Risk (Heavy)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ width: "16px", height: "16px", background: "#fecaca", border: "1px solid #ef4444", borderRadius: "4px" }}></div> High Risk (Severe)
            </div>
          </div>
        </div>
      </div>

      <div style={{ height: "400px", width: "100%" }}>
        <DashboardChart option={option} height={400} />
      </div>
    </article>
  );
}
