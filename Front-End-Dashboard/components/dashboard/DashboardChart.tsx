"use client";

import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";

type Props = {
  option: EChartsOption;
  height?: number;
};

export default function DashboardChart({ option, height = 260 }: Props) {
  return (
    <ReactECharts
      option={option}
      notMerge
      lazyUpdate
      style={{ width: "100%", height }}
      opts={{ renderer: "canvas" }}
    />
  );
}
