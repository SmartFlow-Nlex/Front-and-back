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

/* The forecast's three states, in the colours the forecast map draws them.
   The live map has its own rows below: it colours queues rather than segments,
   so the two keys genuinely differ and a shared list would misdescribe one. */
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
      {/* The live map colours the QUEUES, not the road.
          Each coloured stretch is one Waze jam drawn over the length it
          actually covers, so green never appears here: Waze emits a record
          only where there is congestion, and a stretch with no record is left
          as plain roadway. Listing "Clear" in green would be promising a
          colour this map cannot draw, so the third row is the roadway itself
          and says what its absence of colour means. */}
      <h4>Traffic</h4>
      <div className="wz-legend-row">
        <span className="wz-line" style={{ background: palette.status.congested }} /> Congested
      </div>
      <div className="wz-legend-row">
        <span className="wz-line" style={{ background: palette.status.slow }} /> Slow
      </div>
      <div className="wz-legend-row">
        <span className="wz-line" style={{ background: palette.roadway }} /> No queue reported
      </div>

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
