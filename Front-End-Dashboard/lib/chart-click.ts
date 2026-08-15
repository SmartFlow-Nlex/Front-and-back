"use client";

/**
 * Make clicking anywhere on a chart resolve to the category under the cursor.
 *
 * Most of the dashboard's line series are drawn with `symbol: "none"` for a
 * clean look, which also means they have no clickable data points. ECharts'
 * ordinary `click` event only fires when a rendered item is hit, so on those
 * charts a click either did nothing or landed on a decorative element such as
 * the peak markPoint — which reports `dataIndex: 0`. The result was a detail
 * popup that always described the first category (midnight on the hour charts)
 * no matter where you clicked.
 *
 * This attaches a zrender-level handler instead and converts the click position
 * back to an axis index, so the popup matches the point under the cursor.
 */

type MinimalChart = {
  getZr: () => { on: (ev: string, cb: (e: ZrEvent) => void) => void; off: (ev: string, cb: (e: ZrEvent) => void) => void };
  containPixel: (finder: Record<string, unknown>, pixel: number[]) => boolean;
  convertFromPixel: (finder: Record<string, unknown>, pixel: number[]) => number | number[];
};

type ZrEvent = { offsetX: number; offsetY: number };

export type CategoryClick = { dataIndex: number; seriesIndex: number };

/**
 * @param chart      the ECharts instance (from onChartReady)
 * @param handler    called with the category index under the cursor
 * @param maxIndex   optional upper bound, so a click past the last point clamps
 *                   instead of producing an index with no data behind it
 * @returns          a cleanup function that removes the listener
 */
export function attachCategoryClick(
  chart: MinimalChart,
  handler: (p: CategoryClick) => void,
  maxIndex?: number
): () => void {
  const zr = chart.getZr();

  const onClick = (e: ZrEvent) => {
    const point = [e.offsetX, e.offsetY];

    // Ignore clicks on the legend, title or outside the plotting area.
    try {
      if (!chart.containPixel({ gridIndex: 0 }, point)) return;
    } catch {
      return; // no cartesian grid on this chart (pie, gauge, ...)
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
  };

  zr.on("click", onClick);
  return () => zr.off("click", onClick);
}
