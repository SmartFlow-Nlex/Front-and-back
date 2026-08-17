"use client";

import styles from "../../app/dashboard/traffic/traffic.module.css";

/**
 * Placeholder shaped like the chart that is about to replace it.
 *
 * The three analytics pages each fire ten parallel queries, so there is a real
 * second or two where every card is empty. A centred "Loading…" made that look
 * like breakage; a chart-shaped skeleton reads as work in progress and keeps the
 * card at its final height, so nothing jumps when the data lands.
 *
 * Bar heights are fixed rather than random: a skeleton that reshuffles on every
 * render draws attention to itself, which is the opposite of the point.
 */

const BAR_HEIGHTS = [46, 68, 34, 82, 58, 74, 42, 90, 62, 50, 78, 38];

export default function ChartSkeleton({ bars = 12 }: { bars?: number }) {
  return (
    <div className={styles.skeletonChart} aria-hidden="true">
      <div className={`${styles.skeleton} ${styles.skeletonLine}`} style={{ width: "38%" }} />
      <div className={styles.skeletonBars}>
        {Array.from({ length: bars }, (_, i) => (
          <span
            key={i}
            className={styles.skeleton}
            style={{ height: `${BAR_HEIGHTS[i % BAR_HEIGHTS.length]}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/** Value-sized skeleton for a KPI card, so the tiles do not collapse while loading. */
export function KpiSkeleton() {
  return <div className={`${styles.skeleton} ${styles.skeletonKpi}`} aria-hidden="true" />;
}
