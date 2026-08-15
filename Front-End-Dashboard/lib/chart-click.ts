"use client";

/**
 * Make clicking anywhere on a chart resolve to the category under the cursor.
 *
 * Most of the dashboard's line series are drawn with `symbol: "none"` for a
 * clean look, which also means they render no clickable data points. ECharts'
 * ordinary `click` event only fires when a rendered item is hit, so on those
 * charts a click either did nothing or landed on a decorative element such as
 * the peak markPoint — which reports `dataIndex: 0`. The result was a detail
 * popup that always described the first category (midnight on the hour charts)
 * no matter where you clicked.
 *
 * This attaches a zrender-level handler as a FALLBACK: if ECharts' own click
 * fired for the same gesture, that one wins and this does nothing. That matters
 * because the native event carries richer payloads — the traffic heatmap's
 * handler reads `p.value` as [hour, dow, volume], which a synthesised
 * `{ dataIndex }` cannot provide.
 */

type MinimalChart = {
  on: (ev: string, cb: () => void) => void;
  getZr: () => {
    on: (ev: string, cb: (e: ZrEvent) => void) => void;
    off: (ev: string, cb: (e: ZrEvent) => void) => void;
  };
  containPixel: (finder: Record<string, unknown>, pixel: number[]) => boolean;
  convertFromPixel: (finder: Record<string, unknown>, pixel: number[]) => number | number[];
};

type ZrEvent = { offsetX: number; offsetY: number };

export type CategoryClick = { dataIndex: number; seriesIndex: number };

/** A native click and the zrender click come from one gesture, same tick. */
const NATIVE_WINDOW_MS = 50;

/**
 * @param chart    the ECharts instance (from onChartReady)
 * @param handler  called with the category index under the cursor, only when
 *                 ECharts' own click did not already fire for this gesture
 * @param maxIndex optional upper bound so a click past the last point clamps
 * @returns        cleanup function
 */
export function attachCategoryClick(
  chart: MinimalChart,
  handler: (p: CategoryClick) => void,
  maxIndex?: number
): () => void {
  // Timestamp rather than a boolean: the native and zrender handlers fire from
  // the same dispatch and their order is not guaranteed, so a flag that one
  // clears and the other sets would be order-dependent.
  let lastNativeClick = 0;
  chart.on("click", () => {
    lastNativeClick = Date.now();
  });

  const zr = chart.getZr();

  const onClick = (e: ZrEvent) => {
    const point = [e.offsetX, e.offsetY];

    // Defer past the current tick so the native handler, whichever order it
    // runs in, has recorded itself before this decides whether to act.
    setTimeout(() => {
      if (Date.now() - lastNativeClick < NATIVE_WINDOW_MS) return;

      // Ignore the legend, title and anything outside the plotting area.
      try {
        if (!chart.containPixel({ gridIndex: 0 }, point)) return;
      } catch {
        return; // no cartesian grid (pie, gauge, ...)
      }

      let converted: number | number[];
      try {
        converted = chart.convertFromPixel({ seriesIndex: 0 }, point);
      } catch {
        return;
      }
      if (converted == null) return;

      // On a category axis this is [categoryIndex, value].
      const raw = Array.isArray(converted) ? converted[0] : converted;
      if (!Number.isFinite(raw)) return;

      let dataIndex = Math.round(raw);
      if (dataIndex < 0) dataIndex = 0;
      if (maxIndex != null && dataIndex > maxIndex) dataIndex = maxIndex;

      handler({ dataIndex, seriesIndex: 0 });
    }, 0);
  };

  zr.on("click", onClick);
  return () => zr.off("click", onClick);
}
