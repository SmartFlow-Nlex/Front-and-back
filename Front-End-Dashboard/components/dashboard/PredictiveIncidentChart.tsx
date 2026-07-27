"use client";

import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";

/**
 * PredictiveIncidentChart — Walk-forward forecast visualization.
 *
 * Renders three shaded regions:
 *   Training (blue)  → Validation (orange) → Forecast (green, if available)
 *
 * The chart consumes data directly from the Python training pipeline outputs.
 * No forecasting is performed client-side.
 */

interface PredictiveIncidentChartProps {
  dates: string[];                    // Date labels (YYYY-MM-DD)
  actualData: (number | null)[];      // Actual incident counts per day
  predictedData: (number | null)[];   // Model predictions (null where unavailable)
  trainingEnd: number;                // 0-based index of last training day
  validationEnd: number;              // 0-based index of last validation day
  forecastAvailable?: boolean;        // Whether forecast region has data
}

export default function PredictiveIncidentChart({
  dates,
  actualData,
  predictedData,
  trainingEnd,
  validationEnd,
  forecastAvailable = false,
}: PredictiveIncidentChartProps) {
  if (dates.length === 0) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontSize: "0.9rem" }}>
        No chart data available. Run the Python training pipeline to generate results.
      </div>
    );
  }

  // Check if any predicted data exists in the validation region
  const hasValidationPredictions = predictedData.some(
    (v, i) => v !== null && i > trainingEnd && i <= validationEnd
  );

  // Check if any forecast data exists beyond the validation region
  const hasForecastData = forecastAvailable && predictedData.some(
    (v, i) => v !== null && i > validationEnd
  );

  // Split predicted into validation and forecast segments for different styling
  const validationPredicted: (number | null)[] = dates.map((_, i) =>
    i >= trainingEnd && i <= validationEnd ? predictedData[i] ?? null : null
  );
  const forecastPredicted: (number | null)[] = dates.map((_, i) =>
    i >= validationEnd ? predictedData[i] ?? null : null
  );

  // Bridge point: connect validation → forecast with last validation value
  if (hasValidationPredictions && hasForecastData) {
    const lastValIdx = validationEnd;
    if (validationPredicted[lastValIdx] != null && forecastPredicted[lastValIdx] == null) {
      forecastPredicted[lastValIdx] = validationPredicted[lastValIdx];
    }
  }

  // Format date labels for display (shorter format for x-axis)
  const displayDates = dates.map(d => {
    if (d.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const dt = new Date(`${d}T00:00:00`);
      return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }
    return d;
  });

  const trainLabel = displayDates[trainingEnd] ?? "";
  const valLabel = displayDates[validationEnd] ?? "";

  // Background shading series — flat area fill per region
  const bgSeries = (
    name: string,
    startIdx: number,
    endIdx: number,
    color: string,
  ) => ({
    name,
    type: "line" as const,
    data: dates.map((_, i) => (i >= startIdx && i <= endIdx ? 9999 : null)),
    symbol: "none",
    lineStyle: { opacity: 0 },
    areaStyle: { color, origin: "start" as const, opacity: 1 },
    silent: true,
    legendHoverLink: false,
    z: 1,
    tooltip: { show: false },
  });

  // Build legend data dynamically
  const legendData = ["Actual Incidents"];
  if (hasValidationPredictions) legendData.push("Predicted Incidents");
  if (hasForecastData) legendData.push("Future Forecast");

  // Build mark lines for region boundaries
  const markLineData: { xAxis: string; name: string }[] = [];
  if (trainingEnd > 0 && trainingEnd < dates.length - 1) {
    markLineData.push({ xAxis: displayDates[trainingEnd], name: "Validation →" });
  }
  if (hasForecastData && validationEnd < dates.length - 1) {
    markLineData.push({ xAxis: valLabel, name: "Forecast →" });
  }

  // Determine max y value for chart scaling
  const allValues = [...actualData, ...predictedData].filter((v): v is number => v !== null);
  const maxY = allValues.length > 0 ? Math.ceil(Math.max(...allValues) * 1.15) : 20;

  const option: EChartsOption = {
    backgroundColor: "#ffffff",
    animation: true,
    grid: { left: 60, right: 24, top: 16, bottom: 80, containLabel: false },

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
        // Find corresponding full date for context
        const idx = displayDates.indexOf(day);
        const fullDate = idx >= 0 ? dates[idx] : day;
        let html = `<div style="font-weight:700;margin-bottom:8px;color:#334155;font-size:13px">${fullDate}</div>`;
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
      data: legendData,
    },



    xAxis: {
      type: "category",
      data: displayDates,
      boundaryGap: false,
      axisLabel: {
        color: "#94a3b8",
        fontSize: 11,
        interval: 1, // Display every 2 days (skip 1) exactly like the Traffic Volume chart
        hideOverlap: true,
      },
      axisLine: { lineStyle: { color: "#e2e8f0" } },
      axisTick: { show: false },
      splitLine: { show: false },
    },

    yAxis: {
      type: "value",
      name: "Incident Count",
      nameLocation: "middle",
      nameGap: 44,
      nameTextStyle: { color: "#94a3b8", fontSize: 11, fontWeight: 400 },
      min: 0,
      max: maxY,
      axisLabel: { color: "#94a3b8", fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: "#f1f5f9", type: "dashed", width: 1 } },
    },

    series: [
      // ── Background regions (z: 1 — behind everything) ──
      bgSeries("_train_bg", 0, trainingEnd, "rgba(59,130,246,0.07)"),
      bgSeries("_val_bg", trainingEnd, validationEnd, "rgba(249,115,22,0.08)"),
      ...(hasForecastData
        ? [bgSeries("_fore_bg", validationEnd, dates.length - 1, "rgba(34,197,94,0.08)")]
        : []),

      // ── Actual Incidents — solid blue line ──
      {
        name: "Actual Incidents",
        type: "line",
        data: actualData,
        smooth: true,
        showSymbol: false,
        z: 10,
        lineStyle: { width: 3, color: "#3b82f6", type: "solid", cap: "round" },
        itemStyle: { color: "#3b82f6" },
        markLine: markLineData.length > 0 ? {
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
          data: markLineData,
        } : undefined,
      },

      // ── Validation Predicted — solid green (only if predictions exist) ──
      ...(hasValidationPredictions ? [{
        name: "Predicted Incidents",
        type: "line" as const,
        data: validationPredicted,
        smooth: true,
        showSymbol: false,
        z: 11,
        lineStyle: { width: 3, color: "#22c55e", type: "solid" as const, cap: "round" as const },
        itemStyle: { color: "#22c55e" },
      }] : []),

      // ── Forecast — dashed green (only if forecast data exists) ──
      ...(hasForecastData ? [{
        name: "Future Forecast",
        type: "line" as const,
        data: forecastPredicted,
        smooth: true,
        showSymbol: false,
        z: 11,
        lineStyle: { width: 3, color: "#22c55e", type: "dashed" as const, cap: "round" as const, dashOffset: 4 },
        itemStyle: { color: "#22c55e" },
      }] : []),
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
