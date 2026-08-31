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

export default function MapLegend() {
  const { isDark } = useChartTheme();
  const palette = mapPalette(isDark);

  return (
    <div className="map-legend">
      <h4>Traffic density</h4>
      {DENSITY.map((d) => (
        <div key={d.level} className="wz-legend-row">
          <span className="wz-line" style={{ background: palette.level[d.level] }} /> {d.label}
        </div>
      ))}

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
