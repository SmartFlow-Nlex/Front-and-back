"use client";

import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";

type Props = {
  option: EChartsOption;
  height?: number;
  /** ECharts event handlers, e.g. `{ click: (p) => ... }` for drill-downs. */
  onEvents?: Record<string, (params: never) => void>;
};

export default function DashboardChart({ option, height = 260, onEvents }: Props) {
  return (
    <ReactECharts
      option={option}
      notMerge
      lazyUpdate
      style={{ width: "100%", height }}
      opts={{ renderer: "canvas" }}
      onEvents={onEvents}
    />
  );
}
