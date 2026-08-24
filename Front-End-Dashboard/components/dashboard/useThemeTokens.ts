"use client";

import { useEffect, useState } from "react";

/**
 * Reads the app's CSS theme tokens as literal colour values.
 *
 * Plain DOM styling can use `var(--bg-surface)` directly, but ECharts resolves
 * nothing — it needs a real colour string. Hardcoding one meant the chart stayed
 * on the light palette in dark mode: white tooltips, near-black axis labels on a
 * near-black card, and a bright legend strip.
 *
 * Re-reads on both ways the theme can change:
 *   - an explicit choice, which sets data-theme on <html>
 *   - the "System" setting, which follows prefers-color-scheme with no attribute
 */

export type ThemeTokens = {
  isDark: boolean;
  surface: string;
  surfaceHover: string;
  body: string;
  border: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  chartText: string;
  chartAxis: string;
  chartSplit: string;
  tooltipBg: string;
  tooltipText: string;
};

const FALLBACK: ThemeTokens = {
  isDark: false,
  surface: "#ffffff",
  surfaceHover: "#f8f9fc",
  body: "#f3f5f9",
  border: "#e7ebf4",
  borderStrong: "#d4dbea",
  textPrimary: "#071a44",
  textSecondary: "#4b5e7d",
  textMuted: "#627188",
  chartText: "#4b5e7d",
  chartAxis: "#c9d3e4",
  chartSplit: "#eaeef6",
  tooltipBg: "#ffffff",
  tooltipText: "#071a44",
};

function read(): ThemeTokens {
  if (typeof window === "undefined") return FALLBACK;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;

  const attr = document.documentElement.getAttribute("data-theme");
  const isDark =
    attr === "dark" ||
    (attr !== "light" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);

  return {
    isDark: Boolean(isDark),
    surface: v("--bg-surface", FALLBACK.surface),
    surfaceHover: v("--bg-surface-hover", FALLBACK.surfaceHover),
    body: v("--bg-body", FALLBACK.body),
    border: v("--border-default", FALLBACK.border),
    borderStrong: v("--border-strong", FALLBACK.borderStrong),
    textPrimary: v("--text-primary", FALLBACK.textPrimary),
    textSecondary: v("--text-secondary", FALLBACK.textSecondary),
    textMuted: v("--text-muted", FALLBACK.textMuted),
    chartText: v("--chart-text", FALLBACK.chartText),
    chartAxis: v("--chart-axis", FALLBACK.chartAxis),
    chartSplit: v("--chart-split", FALLBACK.chartSplit),
    tooltipBg: v("--chart-tooltip-bg", FALLBACK.tooltipBg),
    tooltipText: v("--chart-tooltip-text", FALLBACK.tooltipText),
  };
}

export function useThemeTokens(): ThemeTokens {
  // Start from the light fallback so server and first client render agree;
  // the effect corrects it before paint matters.
  const [tokens, setTokens] = useState<ThemeTokens>(FALLBACK);

  useEffect(() => {
    const sync = () => setTokens(read());
    sync();

    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", sync);

    return () => {
      mo.disconnect();
      mq?.removeEventListener?.("change", sync);
    };
  }, []);

  return tokens;
}

/** Zone tints. The light values wash out on a dark card, so they are lifted. */
export function zoneTints(isDark: boolean) {
  return isDark
    ? {
        past: "rgba(56, 118, 245, 0.10)",
        present: "rgba(249, 146, 66, 0.12)",
        future: "rgba(52, 199, 123, 0.12)",
        divider: "#4a5568",
      }
    : {
        past: "rgba(37, 99, 235, 0.05)",
        present: "rgba(249, 115, 22, 0.08)",
        future: "rgba(22, 163, 74, 0.08)",
        divider: "#94a3b8",
      };
}
