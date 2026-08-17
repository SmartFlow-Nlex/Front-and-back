"use client";

import { useEffect, useState } from "react";

/**
 * Chart colours that follow the active theme.
 *
 * ECharts bakes colours into its option object, so it has no idea a CSS variable
 * changed. Left alone, every plot keeps near-black axis text and pale gridlines
 * after switching to dark, which is exactly the eye-strain problem the theme is
 * meant to solve. This reads the current values out of the stylesheet and
 * re-reads them when the theme changes, so options rebuild with the right ink.
 *
 * Series hues (blue, orange, the class ramp) are deliberately NOT themed: they
 * are categorical identity and must mean the same thing in both modes. Only the
 * chart's furniture — text, axes, gridlines, tooltips — changes.
 */

export type ChartTheme = {
  text: string;
  axis: string;
  split: string;
  tooltipBg: string;
  tooltipText: string;
  /** Lightest step of a sequential ramp; near-white in light, near-black in dark. */
  seqLightest: string;
  isDark: boolean;
};

const FALLBACK: ChartTheme = {
  text: "#4b5e7d",
  axis: "#c9d3e4",
  split: "#eaeef6",
  tooltipBg: "#ffffff",
  tooltipText: "#071a44",
  seqLightest: "#eef2fb",
  isDark: false,
};

function read(): ChartTheme {
  if (typeof window === "undefined") return FALLBACK;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  const explicit = document.documentElement.getAttribute("data-theme");
  const isDark =
    explicit === "dark" ||
    (explicit !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  return {
    text: v("--chart-text", FALLBACK.text),
    axis: v("--chart-axis", FALLBACK.axis),
    split: v("--chart-split", FALLBACK.split),
    tooltipBg: v("--chart-tooltip-bg", FALLBACK.tooltipBg),
    tooltipText: v("--chart-tooltip-text", FALLBACK.tooltipText),
    seqLightest: v("--chart-seq-lightest", FALLBACK.seqLightest),
    isDark,
  };
}

/**
 * Current chart theme, refreshed on an explicit change and on OS changes while
 * the setting is "System". Include the returned object in a chart option's
 * dependency list so the option rebuilds.
 */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState<ChartTheme>(FALLBACK);

  useEffect(() => {
    const refresh = () => setTheme(read());
    refresh();

    window.addEventListener("smartflow:themechange", refresh);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", refresh);

    return () => {
      window.removeEventListener("smartflow:themechange", refresh);
      mq.removeEventListener("change", refresh);
    };
  }, []);

  return theme;
}

/**
 * Axis, grid and tooltip defaults to spread into any cartesian ECharts option.
 * Applying these consistently is also what makes the plots look like one system
 * rather than a dozen separately-styled charts.
 */
export function chartBase(t: ChartTheme) {
  return {
    textStyle: { color: t.text },
    axisCommon: {
      axisLine: { lineStyle: { color: t.axis } },
      axisTick: { lineStyle: { color: t.axis } },
      axisLabel: { color: t.text },
      splitLine: { lineStyle: { color: t.split } },
      nameTextStyle: { color: t.text },
    },
    tooltip: {
      backgroundColor: t.tooltipBg,
      borderColor: t.split,
      textStyle: { color: t.tooltipText },
      extraCssText: "box-shadow: 0 6px 20px rgba(0,0,0,0.18); border-radius: 10px;",
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Merges `patch` under `base`, so anything a chart set explicitly wins. */
function underlay(base: any, patch: any): any {
  if (base == null) return patch;
  if (Array.isArray(base)) return base.map((b) => underlay(b, patch));
  if (typeof base !== "object") return base;
  const out: any = { ...patch, ...base };
  for (const k of Object.keys(patch)) {
    if (
      base[k] != null && typeof base[k] === "object" && !Array.isArray(base[k]) &&
      patch[k] != null && typeof patch[k] === "object" && !Array.isArray(patch[k])
    ) {
      out[k] = underlay(base[k], patch[k]);
    }
  }
  return out;
}

/**
 * Applies the theme's furniture (text, axes, gridlines, tooltip) to a chart
 * option without disturbing anything the chart set deliberately.
 *
 * Done once in each page's chartFrame rather than inside sixteen separate option
 * builders — one place to change, and no chart can be forgotten.
 */
export function applyChartTheme<T extends Record<string, any>>(option: T, t: ChartTheme): T {
  const base = chartBase(t);
  const out: any = { ...option };

  out.textStyle = underlay(option.textStyle, base.textStyle);
  if (option.xAxis) out.xAxis = underlay(option.xAxis, base.axisCommon);
  if (option.yAxis) out.yAxis = underlay(option.yAxis, base.axisCommon);
  // A chart with no tooltip configured should not gain one.
  if (option.tooltip) out.tooltip = underlay(option.tooltip, base.tooltip);

  return out as T;
}
