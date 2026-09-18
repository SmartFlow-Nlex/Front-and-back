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
 * The road's colours, grouped by the status each one counts as.
 *
 * Two true things were being shown one at a time. The map draws Waze's own
 * five-level scale and all five turn up on this corridor, so a three-row key
 * would have described a map that is not the one beside it. But every other
 * view of the same feed — the corridor panel, the hero strip, the tallies —
 * speaks in three states, and nothing said which colour was which. A reader
 * counting four reds on the map against "4 congested" in the panel had no way
 * to check the two agreed.
 *
 * The grouping is classify() in lib/corridor-status.ts, not a guess: level 0 is
 * clear, 1-2 slow, 3 and above congested. Level 0 is in the list because the
 * live map draws unreported stretches at it.
 */
const DENSITY_GROUPS = [
  { status: "Clear", levels: [{ level: 0 as const, label: "Free flow" }] },
  {
    status: "Slow",
    levels: [
      { level: 1 as const, label: "Light" },
      { level: 2 as const, label: "Moderate" },
    ],
  },
  {
    status: "Congested",
    levels: [
      { level: 3 as const, label: "Heavy" },
      { level: 4 as const, label: "Severe" },
      { level: 5 as const, label: "Standstill" },
    ],
  },
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
      {DENSITY_GROUPS.map((g) => (
        <div key={g.status} className="wz-legend-group">
          <span className="wz-legend-status">{g.status}</span>
          {g.levels.map((d) => (
            <div key={d.level} className="wz-legend-row">
              <span className="wz-line" style={{ background: palette.level[d.level] }} /> {d.label}
            </div>
          ))}
        </div>
      ))}
      <p className="wz-legend-note">
        Counted as three states across the dashboard: the corridor panel&apos;s clear, slow and
        congested are these colours grouped.
      </p>

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
