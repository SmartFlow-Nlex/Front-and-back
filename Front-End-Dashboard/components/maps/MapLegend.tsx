"use client";

import { useChartTheme } from "../../lib/chart-theme";
import { mapPalette } from "../../lib/map-palette";
import { lookOf } from "../../lib/waze-report-look";
import { WAZE_REPORT_TYPES } from "../../lib/waze-reports";

/**
 * The one legend, shared by the panel and the maximised view.
 *
 * There were two, and they disagreed. The collapsed one listed four densities
 * and drew them in colours of its own — var(--color-success), #eab308, #f97316,
 * var(--color-danger) — none of which are the hues the map paints with, and it
 * had no Standstill at all, so a level 5 ribbon appeared on the map in a colour
 * the key never mentioned. The maximised one read the real palette but dropped
 * the direction and the plaza.
 *
 * Everything here is derived: the densities from the map's own palette, the
 * reports from WAZE_REPORT_TYPES, which is also what the map draws and the
 * Active Reports tile counts. A key that describes a different map from the one
 * beside it is worse than no key.
 */

const DENSITY = [
  { level: 1 as const, label: "Light" },
  { level: 2 as const, label: "Moderate" },
  { level: 3 as const, label: "Heavy" },
  { level: 4 as const, label: "Severe" },
  { level: 5 as const, label: "Standstill" },
];

/** The same mark the plaza pins carry. */
const PLAZA_ICON = (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20V9.5a1 1 0 0 1 .55-.9l7-3.5a1 1 0 0 1 .9 0l7 3.5a1 1 0 0 1 .55.9V20" />
    <path d="M2 20h20M9 20v-5h6v5" />
  </svg>
);

export default function MapLegend({ showNotReported = false }: { showNotReported?: boolean }) {
  const { isDark } = useChartTheme();
  const palette = mapPalette(isDark);

  return (
    <div className="map-legend">
      <h4>Traffic density</h4>
      {DENSITY.map((d) => (
        <div key={d.level} className="map-legend-row">
          <span className="map-legend-line" style={{ background: palette.level[d.level] }} />
          {d.label}
        </div>
      ))}
      {/* Only where it can actually appear. On the live map an unreported
          stretch is drawn as free flow, so grey never shows; on the forecast,
          where most segments have no prediction, it is most of the road. */}
      {showNotReported && (
        <div className="map-legend-row">
          <span className="map-legend-line" style={{ background: palette.noData }} />
          Not reported
        </div>
      )}

      <h4>Direction</h4>
      <div className="map-legend-row">
        <span className="map-legend-dir">&#10095;</span> Northbound &middot; to Central Luzon
      </div>
      <div className="map-legend-row">
        <span className="map-legend-dir flip">&#10095;</span> Southbound &middot; to Metro Manila
      </div>

      <h4>Waze reports</h4>
      {WAZE_REPORT_TYPES.map((k) => {
        const v = lookOf(k);
        const Icon = v.icon;
        return (
          <div key={k} className="map-legend-row">
            <span className="map-legend-chip" style={{ background: v.colour }}>
              <Icon size={11} />
            </span>
            {v.label}
          </div>
        );
      })}
      <div className="map-legend-row">
        <span className="map-legend-chip" style={{ background: "#0e7490" }}>{PLAZA_ICON}</span>
        Toll plaza
      </div>
    </div>
  );
}
