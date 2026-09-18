"use client";

import { useChartTheme } from "../../lib/chart-theme";
import { JAM_SCALE, mapPalette, STATUS_OF_LEVEL } from "../../lib/map-palette";
import { lookOf } from "../../lib/waze-report-look";
import { WAZE_REPORT_TYPES } from "../../lib/waze-reports";

/**
 * The one legend, shared by the panel and the maximised view.
 *
 * This is the maximised view's key, which reads better than the panel's did:
 * the two things a reader needs — what the colours on the road mean and what
 * the pins are — and nothing else. The panel's version had grown a direction
 * section and a plaza row on top of that, which is more to read than the map
 * needs explaining, and it drew its densities in colours that were not even the
 * map's.
 *
 * Nothing here is written by hand. The densities come from the map's own
 * palette and the reports from WAZE_REPORT_TYPES, which is also the list the
 * map draws and the Active Reports tile counts, so the key cannot describe a
 * map other than the one beside it.
 */

/** The three states the corridor is ever in, in the colours it is drawn in. */
const STATUS_KEY = ["clear", "slow", "congested"] as const;

const STATUS_LABEL: Record<(typeof STATUS_KEY)[number], string> = {
  clear: "Clear",
  slow: "Slow",
  congested: "Congested",
};

export const FORECAST_KEY = [
  { state: "Low", label: "Clear", status: "clear" as const },
  { state: "Med", label: "Slow", status: "slow" as const },
  { state: "High", label: "Congested", status: "congested" as const },
];

export default function MapLegend({ variant = "live" }: { variant?: "live" | "forecast" }) {
  const { isDark } = useChartTheme();
  const palette = mapPalette(isDark);

  /* A forecast has no Waze reports in it — those are live observations — and
     no density scale either: the model answers in three states. Showing the
     live key beside it would be describing a different map. */
  if (variant === "forecast") {
    return (
      <div className="map-legend">
        <h4>Predicted congestion</h4>
        {FORECAST_KEY.map((k) => (
          <div key={k.state} className="wz-legend-row">
            <span className="wz-line" style={{ background: palette.status[k.status] }} /> {k.label}
          </div>
        ))}
        <h4 className="wz-legend-gap">On the map</h4>
        <div className="wz-legend-row">
          <span className="mc-legend-pin" aria-hidden="true" /> NLEX exit
        </div>
      </div>
    );
  }

  return (
    <div className="map-legend">
      <h4>Traffic</h4>
      {STATUS_KEY.map((k) => (
        <div key={k} className="wz-legend-row">
          <span className="wz-line" style={{ background: palette.status[k] }} /> {STATUS_LABEL[k]}
        </div>
      ))}

      {/* The three states are what the road is drawn in and what the panel
          counts. Waze's own six levels are what they are made of — offered
          here rather than spread across the key, so the legend still answers
          "what am I looking at" in three lines. */}
      <details className="wz-scale">
        <summary>Waze levels 0–5</summary>
        <p>
          A level is how far traffic has fallen below free-flow speed on that stretch — not a
          count of vehicles.
        </p>
        <ul>
          {JAM_SCALE.map((r) => (
            <li key={r.level}>
              <span className="wz-scale-chip" style={{ background: palette.level[r.level] }}>
                {r.level}
              </span>
              <span className="wz-scale-band">{r.band}</span>
              <span className="wz-scale-word">{r.label}</span>
              <span className={`wz-scale-status is-${STATUS_OF_LEVEL(r.level)}`}>
                {STATUS_OF_LEVEL(r.level)}
              </span>
            </li>
          ))}
        </ul>
      </details>

      {/* Only where it can appear. On the live map an unreported stretch is
          drawn as free flow, so grey never shows; on the forecast, which covers
          seven segments of nineteen, it is most of the road. */}
      <h4 className="wz-legend-gap">Waze reports</h4>
      {WAZE_REPORT_TYPES.map((k) => {
        const v = lookOf(k);
        const Icon = v.icon;
        return (
          <div key={k} className="wz-legend-row">
            <span className={`wz-chip ${v.tone}`}><Icon size={11} /></span> {v.label}
          </div>
        );
      })}
    </div>
  );
}
