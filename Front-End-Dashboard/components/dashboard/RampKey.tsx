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
/**
 * The colour at a point along the ramp.
 *
 * The strip is a CSS gradient, so the browser knows this colour but will not
 * tell us — and reading it back off a canvas would mean rasterising the strip.
 * Interpolating the stops in sRGB reproduces what the gradient draws, which is
 * what matters: the swatch has to be the shade the reader is pointing at, or it
 * cannot be matched against a cell in the heatmap.
 */
function colourAt(colors: string[], t: number): string {
  if (colors.length === 0) return "transparent";
  if (colors.length === 1) return colors[0];
  const pos = Math.min(1, Math.max(0, t)) * (colors.length - 1);
  const i = Math.min(colors.length - 2, Math.floor(pos));
  const f = pos - i;
  const rgb = (hex: string) => {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return [0, 2, 4].map((k) => parseInt(full.slice(k, k + 2), 16));
  };
  const [a, b] = [rgb(colors[i]), rgb(colors[i + 1])];
  const mix = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${mix.join(", ")})`;
}

export default function RampKey({
  colors,
  min,
  max,
  format,
  lowLabel,
  highLabel,
  onScrub,
}: {
  colors: string[];
  min: number;
  max: number;
  /** How to render the value under the cursor. */
  format: (v: number) => string;
  lowLabel: string;
  highLabel: string;
  /** Fraction along the ramp under the cursor, or null when it leaves. */
  onScrub?: (t: number | null) => void;
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
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setAt(t);
    onScrub?.(t);
  };

  const value = at == null ? null : min + at * (max - min);
  const hovered = at == null ? null : colourAt(colors, at);

  return (
    <div className={styles.rampKey}>
      <span className={styles.rampKeyEnd}>{lowLabel}</span>

      <span
        ref={barRef}
        className={styles.rampKeyBar}
        style={{ background: `linear-gradient(to right, ${colors.join(", ")})` }}
        onMouseMove={(e) => track(e.clientX)}
        onMouseLeave={() => { setAt(null); onScrub?.(null); }}
        role="img"
        aria-label={`Colour scale from ${format(min)} to ${format(max)}`}
      >
        {at != null && (
          <>
            <span className={styles.rampKeyMarker} style={{ left: `${at * 100}%` }} />
            <span className={styles.rampKeyReadout} style={{ left: `${at * 100}%` }}>
              <i style={{ background: hovered ?? "transparent" }} />
              {value != null ? format(value) : ""}
            </span>
          </>
        )}
      </span>

      <span className={styles.rampKeyEnd}>{highLabel}</span>
    </div>
  );
}
