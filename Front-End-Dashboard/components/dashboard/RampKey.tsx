"use client";

import { useRef, useState } from "react";
import styles from "../../app/dashboard/traffic/traffic.module.css";

/**
 * Interactive colour key for a chart that encodes magnitude in colour.
 *
 * Replaces the ECharts visualMap, which kept rendering as a vertical bar across
 * the hour labels whatever orient and dimensions it was given. That swap fixed
 * the layout but lost the thing the visualMap was actually for: being able to
 * point at a shade and find out what value it stands for.
 *
 * This puts that back. Moving along the strip reads out the value at that point,
 * so a cell in the heatmap can be matched to a number by eye. Keyboard users get
 * the same readout from the endpoints, which are always visible.
 */
export default function RampKey({
  colors,
  min,
  max,
  format,
  lowLabel,
  highLabel,
}: {
  colors: string[];
  min: number;
  max: number;
  /** How to render the value under the cursor. */
  format: (v: number) => string;
  lowLabel: string;
  highLabel: string;
}) {
  const barRef = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<number | null>(null);

  const track = (clientX: number) => {
    const el = barRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    // Clamped, so a cursor that slips past the rounded end still reads the end
    // value rather than something off-scale.
    setAt(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  };

  const value = at == null ? null : min + at * (max - min);

  return (
    <div className={styles.rampKey}>
      <span className={styles.rampKeyEnd}>{lowLabel}</span>

      <span
        ref={barRef}
        className={styles.rampKeyBar}
        style={{ background: `linear-gradient(to right, ${colors.join(", ")})` }}
        onMouseMove={(e) => track(e.clientX)}
        onMouseLeave={() => setAt(null)}
        role="img"
        aria-label={`Colour scale from ${format(min)} to ${format(max)}`}
      >
        {at != null && (
          <>
            <span className={styles.rampKeyMarker} style={{ left: `${at * 100}%` }} />
            <span className={styles.rampKeyReadout} style={{ left: `${at * 100}%` }}>
              {value != null ? format(value) : ""}
            </span>
          </>
        )}
      </span>

      <span className={styles.rampKeyEnd}>{highLabel}</span>
    </div>
  );
}
