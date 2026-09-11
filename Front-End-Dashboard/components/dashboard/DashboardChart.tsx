"use client";

import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { useChartTheme, applyChartTheme } from "../../lib/chart-theme";

type Props = {
  option: EChartsOption;
  height?: number;
  /** ECharts event handlers, e.g. `{ click: (p) => ... }` for drill-downs. */
  onEvents?: Record<string, (params: never) => void>;
};

export default function DashboardChart({ option, height = 260, onEvents }: Props) {
  // Themed here rather than at each call site, so every chart drawn through this
  // component — including the predictive ones — follows light/dark automatically.
  const chartTheme = useChartTheme();

  return (
    <ReactECharts
      option={applyChartTheme(option, chartTheme)}
      notMerge
      lazyUpdate
      style={{ width: "100%", height }}
      opts={{ renderer: "canvas" }}
      onEvents={onEvents}
    />
  );
}
