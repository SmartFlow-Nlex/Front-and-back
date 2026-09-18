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

/**
 * The three states the corridor is ever in, and the shades each is drawn with.
 *
 * The map paints six palette values, but they are three bands: one green, two
 * ambers, three reds. The shading carries severity WITHIN a state; the state is
 * what the rest of the dashboard counts, and classify() in lib/corridor-status
 * draws the same lines - 0 clear, 1-2 slow, 3 and above congested.
 *
 * So the key names three things and shows each one's range, rather than listing
 * six shades and leaving the reader to work out that four of them mean the same
 * thing as the number in the panel beside it.
 */
const STATUS_KEY = [
  { status: "Clear", levels: [0] as const },
  { status: "Slow", levels: [1, 2] as const },
  { status: "Congested", levels: [3, 4, 5] as const },
];

export const FORECAST_KEY = [
  { state: "Low", label: "Clear", level: 0 as const },
  { state: "Med", label: "Slow", level: 2 as const },
  { state: "High", label: "Congested", level: 4 as const },
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
      <h4>Traffic</h4>
      {STATUS_KEY.map((g) => (
        <div key={g.status} className="wz-legend-row">
          {/* One swatch per state, carrying that state's shades: a reader can
              see the darker reds belong to congested rather than hunting for
              them in a list of six. */}
          <span
            className="wz-line"
            style={{
              background:
                g.levels.length === 1
                  ? palette.level[g.levels[0]]
                  : `linear-gradient(90deg, ${g.levels.map((l) => palette.level[l]).join(", ")})`,
            }}
          />{" "}
          {g.status}
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
