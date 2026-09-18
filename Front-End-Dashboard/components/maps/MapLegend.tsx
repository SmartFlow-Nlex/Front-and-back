"use client";

import { useChartTheme } from "../../lib/chart-theme";
import { mapPalette } from "../../lib/map-palette";
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

const DENSITY = [
  { level: 1 as const, label: "Light" },
  { level: 2 as const, label: "Moderate" },
  { level: 3 as const, label: "Heavy" },
  { level: 4 as const, label: "Severe" },
  { level: 5 as const, label: "Standstill" },
];

/**
 * What the forecast map draws, in the order a reader scans it.
 *
 * The levels are indices into the shared map palette — the same numbers
 * TrafficMapPanel maps these states to — so the key and the road cannot drift
 * apart. Exported because the panel's own legend draws from it too.
 */
export const FORECAST_KEY = [
  { state: "Low", label: "Clear", level: 0 as const },
  { state: "Med", label: "Building", level: 2 as const },
  { state: "High", label: "Heavy", level: 4 as const },
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
            <span className="wz-line" style={{ background: palette.level[k.level] }} /> {k.label}
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
      <h4>Traffic density</h4>
      {DENSITY.map((d) => (
        <div key={d.level} className="wz-legend-row">
          <span className="wz-line" style={{ background: palette.level[d.level] }} /> {d.label}
        </div>
      ))}

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
