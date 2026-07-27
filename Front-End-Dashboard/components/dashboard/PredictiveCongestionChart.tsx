"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";

export default function PredictiveCongestionChart() {
  const [chartData, setChartData] = useState<{
    segments: string[];
    hours: string[];
    heatmapData: [number, number, number, number][]; // [xIndex, yIndex, value, probability]
    alerts: string[];
  } | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("http://localhost:4000/api/traffic/forecast");
        const json = await res.json();
        
        if (json.success && json.data.congestion) {
          const raw = json.data.congestion;
          
          const uniqueSegments = Array.from(new Set(raw.map((d: any) => d.segment))) as string[];
          const uniqueHoursSet = new Set(raw.map((d: any) => d.hours));
          const maxHour = Math.max(...Array.from(uniqueHoursSet) as number[]);
          const hours = Array.from({ length: maxHour }, (_, i) => `+${i + 1}h`);

          const heatmapData: [number, number, number, number][] = [];
          const alerts: string[] = [];
          
          raw.forEach((d: any) => {
            const yIndex = uniqueSegments.indexOf(d.segment);
            const xIndex = d.hours - 1;
            
            let val = 0;
            if (d.state === 'High') {
              val = 2;
              if (d.probability >= 0.8) {
                alerts.push(`⚠️ Alert: A severe bottleneck is forming at ${d.segment} in +${d.hours}h with ${(d.probability * 100).toFixed(1)}% probability. Proactive deployment is recommended.`);
              }
            } else if (d.state === 'Med') {
              val = 1;
            }

            heatmapData.push([xIndex, yIndex, val, d.probability]);
          });

          setChartData({ segments: uniqueSegments, hours, heatmapData, alerts });
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

  const { segments, hours, heatmapData, alerts } = chartData;
  const displayAlerts = alerts.length > 0 ? alerts.slice(0, 3) : ["✅ No severe bottlenecks detected in the next 12 hours. Normal flow expected."];

  const option: EChartsOption = {
    tooltip: {
      position: "top",
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      borderColor: '#e2e8f0',
      borderWidth: 1,
      textStyle: { color: '#334155' },
      extraCssText: 'box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); border-radius: 8px;',
      formatter: (params: any) => {
        const xName = hours[params.data[0]];
        const yName = segments[params.data[1]];
        const val = params.data[2];
        const prob = params.data[3];
        const status = val === 2 ? "Severe Bottleneck" : val === 1 ? "Heavy Traffic" : "Free Flow";
        const color = val === 2 ? "#ef4444" : val === 1 ? "#eab308" : "#22c55e";
        const speed = val === 2 ? "&lt; 30 km/h" : val === 1 ? "30 - 60 km/h" : "&gt; 60 km/h";
        
        return `
          <div style="padding: 4px; font-family: Inter, sans-serif;">
            <b style="font-size: 1.1em; color: #0f172a;">${yName}</b><br/>
            <div style="margin-top: 6px; display: grid; grid-template-columns: 130px 1fr; gap: 4px;">
              <span style="color: #64748b;">Time:</span> <span style="font-weight: 500;">${xName}</span>
              <span style="color: #64748b;">Prediction:</span> <span style="color:${color}; font-weight:700;">${status}</span>
              <span style="color: #64748b;">Predicted Speed:</span> <span style="font-weight: 500;">${speed}</span>
              <span style="color: #64748b;">AI Confidence:</span> <span style="font-weight: 500;">${(prob * 100).toFixed(1)}%</span>
            </div>
          </div>
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
      axisLabel: { color: "#64748b", fontWeight: 500 },
      axisLine: { lineStyle: { color: "#cbd5e1" } },
    },
    yAxis: {
      type: "category",
      data: segments,
      splitArea: { show: true },
      axisLabel: { color: "#64748b", fontWeight: 500 },
      axisLine: { lineStyle: { color: "#cbd5e1" } },
    },
    visualMap: {
      show: false,
      min: 0,
      max: 2,
      inRange: {
        color: ["#86efac", "#fde047", "#f87171"],
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
          fontSize: 11,
          fontWeight: 600,
        },
        itemStyle: {
          borderColor: "#ffffff",
          borderWidth: 2,
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 15,
            shadowColor: "rgba(0, 0, 0, 0.4)",
            borderColor: "#334155",
            borderWidth: 2
          },
        },
      },
    ],
  };

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "24px", marginTop: "24px", background: "linear-gradient(to bottom, #ffffff, #f8fafc)" }}>
      <div className="chart-head" style={{ borderBottom: "none", paddingBottom: 0, margin: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "flex-start" }}>
          <div>
            <h3 style={{ fontSize: "1.25rem", color: "#0f172a", fontWeight: 700, margin: 0, display: "flex", alignItems: "center", gap: "8px" }}>
              Predictive Congestion State Map <span style={{ fontSize: "0.8rem", padding: "2px 8px", background: "#f1f5f9", borderRadius: "12px", border: "1px solid #cbd5e1", color: "#475569" }}>XGBoost</span>
            </h3>
            <p style={{ color: "#64748b", fontSize: "0.9rem", margin: "6px 0 0 0" }}>
              12-hour spatial forecast of segment congestion probabilities identifying future bottleneck states.
            </p>
          </div>
          <div style={{ display: "flex", gap: "16px", alignItems: "center", fontSize: "0.85rem", color: "#64748b", fontWeight: 500 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ width: "16px", height: "16px", background: "#86efac", border: "1px solid #22c55e", borderRadius: "4px" }}></div> Low Risk (Free Flow)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ width: "16px", height: "16px", background: "#fde047", border: "1px solid #eab308", borderRadius: "4px" }}></div> Med Risk (Heavy)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{ width: "16px", height: "16px", background: "#f87171", border: "1px solid #ef4444", borderRadius: "4px" }}></div> High Risk (Severe)
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 600px", height: "400px" }}>
          <DashboardChart option={option} height={400} />
        </div>
        
        {/* Actionable Insights Panel */}
        <div style={{ flex: "0 0 300px", display: "flex", flexDirection: "column", gap: "12px", background: "#ffffff", padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.1)" }}>
          <h4 style={{ margin: 0, fontSize: "1rem", color: "#0f172a", fontWeight: 700, borderBottom: "2px solid #f1f5f9", paddingBottom: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "1.2rem" }}>🎯</span> Operational Insights
          </h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", overflowY: "auto", maxHeight: "330px", paddingRight: "4px" }}>
            {displayAlerts.map((alert, idx) => {
              const isDanger = alert.includes("⚠️");
              return (
                <div key={idx} style={{ 
                  padding: "12px", 
                  background: isDanger ? "#fef2f2" : "#f0fdf4", 
                  border: `1px solid ${isDanger ? "#fecaca" : "#bbf7d0"}`, 
                  borderRadius: "6px",
                  fontSize: "0.85rem",
                  color: isDanger ? "#991b1b" : "#166534",
                  lineHeight: "1.5",
                  fontWeight: 500
                }}>
                  {alert}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </article>
  );
}
