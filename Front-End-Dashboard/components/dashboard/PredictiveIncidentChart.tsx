"use client";

import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";

interface PredictiveIncidentChartProps {
  days: string[];
  actualData: (number | null)[];
  predictedData: (number | null)[];
  trainingEnd?: number;   // 0-based last index of training zone  (default 40)
  validationEnd?: number; // 0-based last index of validation zone (default 50)
}

export default function PredictiveIncidentChart({
  days,
  actualData,
  predictedData,
  trainingEnd   = 40,
  validationEnd = 50,
}: PredictiveIncidentChartProps) {

  // Split predicted into validation segment and forecast segment
  // so we can style them differently (solid vs dashed)
  const validationData: (number | null)[] = days.map((_, i) =>
    i >= trainingEnd && i <= validationEnd ? predictedData[i] ?? null : null
  );
  const forecastData: (number | null)[] = days.map((_, i) =>
    i >= validationEnd ? predictedData[i] ?? null : null
  );

  // Create a "bridge" point at the validation/forecast boundary so the lines connect
  // — duplicate the last validation value as the first forecast value
  const lastValIdx = validationEnd;
  if (validationData[lastValIdx] != null && forecastData[lastValIdx] == null) {
    forecastData[lastValIdx] = validationData[lastValIdx];
  }

  const trainLabel = days[trainingEnd]   ?? "";
  const valLabel   = days[validationEnd] ?? "";

  // Background series — renders a flat area fill per region using very low opacity
  const bgSeries = (
    name: string,
    startIdx: number,
    endIdx: number,
    color: string,
  ) => ({
    name,
    type: "line" as const,
    data: days.map((_, i) => (i >= startIdx && i <= endIdx ? 9999 : null)),
    symbol: "none",
    lineStyle:  { opacity: 0 },
    areaStyle:  { color, origin: "start" as const, opacity: 1 },
    silent:     true,
    legendHoverLink: false,
    z: 1,
    tooltip:    { show: false },
  });

  const option: EChartsOption = {
    backgroundColor: "#ffffff",
    animation: true,
    grid: { left: 60, right: 24, top: 16, bottom: 52, containLabel: false },

    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "line",
        lineStyle: { color: "#cbd5e1", width: 1.5, type: "solid" },
      },
      backgroundColor: "#ffffff",
      borderColor: "#e2e8f0",
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: "#1e293b", fontSize: 13 },
      formatter: (params: unknown) => {
        const p = params as { axisValue: string; seriesName: string; value: number | null; color: string }[];
        const day = p[0]?.axisValue ?? "";
        let html = `<div style="font-weight:700;margin-bottom:8px;color:#334155;font-size:13px">${day}</div>`;
        for (const item of p) {
          if (!item.seriesName || item.seriesName.startsWith("_")) continue;
          if (item.value == null) continue;
          html += `<div style="display:flex;align-items:center;gap:8px;margin-top:5px">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${item.color}"></span>
            <span style="color:#64748b;font-size:12px">${item.seriesName}</span>
            <span style="font-weight:700;margin-left:auto;padding-left:16px;font-size:13px">${item.value}</span>
          </div>`;
        }
        return `<div style="min-width:200px">${html}</div>`;
      },
    },

    legend: {
      bottom: 4,
      icon: "circle",
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 20,
      textStyle: { color: "#475569", fontSize: 12 },
      data: ["Actual Incidents", "Validation Predicted", "Forecast"],
    },

    xAxis: {
      type: "category",
      data: days,
      boundaryGap: false,
      axisLabel: {
        color: "#94a3b8",
        fontSize: 11,
        interval: Math.max(0, Math.floor(days.length / 10) - 1),
      },
      axisLine:  { lineStyle: { color: "#e2e8f0" } },
      axisTick:  { show: false },
      splitLine: { show: false },
    },

    yAxis: {
      type: "value",
      name: "Incident Count",
      nameLocation: "middle",
      nameGap: 44,
      nameTextStyle: { color: "#94a3b8", fontSize: 11, fontWeight: 400 },
      min: 0,
      axisLabel: { color: "#94a3b8", fontSize: 11 },
      axisLine:  { show: false },
      axisTick:  { show: false },
      splitLine: { lineStyle: { color: "#f1f5f9", type: "dashed", width: 1 } },
    },

    series: [
      // ── Background regions (z: 1 — rendered first, behind everything) ──
      bgSeries("_train_bg", 0,              trainingEnd,   "rgba(59,130,246,0.07)"),
      bgSeries("_val_bg",   trainingEnd,    validationEnd, "rgba(249,115,22,0.08)"),
      bgSeries("_fore_bg",  validationEnd,  days.length - 1, "rgba(34,197,94,0.08)"),

      // ── Actual Incidents — solid blue, z: 10 ──
      {
        name: "Actual Incidents",
        type: "line",
        data: actualData,
        smooth: true,
        showSymbol: false,
        z: 10,
        lineStyle: { width: 3.5, color: "#3b82f6", type: "solid", cap: "round" },
        itemStyle: { color: "#3b82f6" },
        // Vertical separators sit on this series' markLine
        markLine: {
          silent: true,
          symbol: ["none", "none"],
          label: {
            show: true,
            fontSize: 10,
            color: "#94a3b8",
            fontWeight: 600,
            formatter: (p: { name: string }) => p.name,
          },
          lineStyle: { type: "dashed", color: "#94a3b8", width: 1.2, opacity: 0.8 },
          data: [
            { xAxis: trainLabel, name: "Validation →" },
            { xAxis: valLabel,   name: "Forecast →"   },
          ],
        },
      },

      // ── Validation Predicted — solid green, z: 11 ──
      {
        name: "Validation Predicted",
        type: "line",
        data: validationData,
        smooth: true,
        showSymbol: false,
        z: 11,
        lineStyle: { width: 3.5, color: "#22c55e", type: "solid", cap: "round" },
        itemStyle: { color: "#22c55e" },
      },

      // ── Forecast — dashed green, z: 11 ──
      {
        name: "Forecast",
        type: "line",
        data: forecastData,
        smooth: true,
        showSymbol: false,
        z: 11,
        lineStyle: { width: 3.5, color: "#22c55e", type: "dashed", cap: "round", dashOffset: 4 },
        itemStyle: { color: "#22c55e" },
      },
    ],
  };

  return (
    <ReactECharts
      option={option}
      notMerge
      lazyUpdate
      style={{ width: "100%", height: "100%" }}
      opts={{ renderer: "canvas" }}
    />
  );
}
