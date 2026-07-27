"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";

export default function PredictiveEventChart() {
  const [chartData, setChartData] = useState<{
    exits: string[];
    baselineForecast: number[];
    eventSurgeForecast: number[];
    eventName: string;
  } | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("http://localhost:4000/api/traffic/forecast");
        const json = await res.json();
        
        if (json.success && json.data.events && json.data.events.length > 0) {
          const raw = json.data.events;
          
          const exits: string[] = [];
          const baselineForecast: number[] = [];
          const eventSurgeForecast: number[] = [];
          let eventName = raw[0].event;

          raw.forEach((d: any) => {
            exits.push(d.exit);
            baselineForecast.push(d.baseline);
            eventSurgeForecast.push(d.surge);
          });

          setChartData({ exits, baselineForecast, eventSurgeForecast, eventName });
        }
      } catch (err) {
        console.error("Failed to fetch ML event forecast", err);
      }
    }
    fetchData();
  }, []);

  if (!chartData) {
    return (
      <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px", marginTop: "24px" }}>
        <div>Loading ML Event Surge Forecast from AWS...</div>
      </article>
    );
  }

  const { exits, baselineForecast, eventSurgeForecast, eventName } = chartData;

  const option: EChartsOption = {
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
    },
    legend: {
      data: ["Baseline Forecast", "Event Surge Forecast (Prophet)"],
      bottom: 0,
    },
    grid: { left: 60, right: 20, top: 20, bottom: 60 },
    xAxis: {
      type: "category",
      data: exits,
      axisLabel: { color: "#64748b" },
      axisLine: { lineStyle: { color: "#cbd5e1" } },
    },
    yAxis: {
      type: "value",
      name: "Volume (Vehicles)",
      nameLocation: "middle",
      nameGap: 50,
      axisLabel: {
        color: "#64748b",
        formatter: (val: number) => `${(val / 1000).toFixed(0)}k`,
      },
      splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
    },
    series: [
      {
        name: "Baseline Forecast",
        type: "bar",
        data: baselineForecast,
        itemStyle: { color: "#94a3b8" },
        barWidth: "30%",
      },
      {
        name: "Event Surge Forecast (Prophet)",
        type: "bar",
        data: eventSurgeForecast,
        itemStyle: { color: "#e11d48" }, // Distinctive surge color
        barWidth: "30%",
        label: {
          show: true,
          position: "top",
          formatter: (params: any) => {
            const index = params.dataIndex;
            const diff = eventSurgeForecast[index] - baselineForecast[index];
            const pct = Math.round((diff / baselineForecast[index]) * 100);
            return `{surge|+${pct}%}`;
          },
          rich: {
            surge: {
              color: "#e11d48",
              fontWeight: "bold",
              fontSize: 12,
            },
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
              Spatial Exit-Impact Map (Prophet)
            </h3>
            <p style={{ color: "#64748b", fontSize: "0.9rem", margin: "6px 0 0 0" }}>
              Predicted event surge impacts (Upcoming Event: "{eventName}") on key exits compared to baseline.
            </p>
          </div>
        </div>
      </div>

      <div style={{ height: "350px", width: "100%" }}>
        <DashboardChart option={option} height={350} />
      </div>
    </article>
  );
}
