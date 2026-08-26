/**
 * Colours for the live map, in both themes.
 *
 * This lives apart from the map component because the legend in the maximised
 * view has to name the same colours the map paints. It used to keep its own
 * copy, so a change to one silently drifted from the other — and once the map
 * became theme-aware the legend was simply wrong in dark mode.
 */

/**
 * The map's palette, in both themes.
 *
 * The base style and every corridor colour used to be hardcoded light. On a
 * dark dashboard that left a bright grey rectangle in the middle of the page,
 * and the corridor colours were picked against a light background they no
 * longer sat on. Both now follow the app's theme.
 */
export function mapPalette(isDark: boolean) {
  return {
    style: isDark
      ? "mapbox://styles/mapbox/dark-v11"
      : "mapbox://styles/mapbox/light-v11",
    /* A wash over the base map. Every road in Central Luzon is drawn at much
       the same weight, so dimming all of it is what actually makes NLEX the
       subject — far more than thickening the corridor could. */
    scrim: isDark ? "#070b14" : "#f1f5f9",
    scrimOpacity: isDark ? 0.55 : 0.6,
    halo: isDark ? "#38bdf8" : "#0284c7",
    haloOpacity: isDark ? 0.22 : 0.18,
    bed: isDark ? "#1e293b" : "#334155",
    asphalt: isDark ? "#334155" : "#94a3b8",
    casing: isDark ? "#0b1220" : "#ffffff",
    rampCasing: isDark ? "#1e293b" : "#cbd5e1",
    ramp: isDark ? "#64748b" : "#94a3b8",
    arrow: isDark ? "#e2e8f0" : "#ffffff",
    arrowHalo: isDark ? "rgba(2,6,23,0.75)" : "rgba(15,23,42,0.45)",
    alert: isDark ? "#f87171" : "#dc2626",
    alertRing: isDark ? "#0b1220" : "#ffffff",
    /* Congestion levels. Brighter in dark so they hold up against the wash,
       deeper in light so they do not glow out against white. */
    level: isDark
      ? { 0: "#10b981", 1: "#10b981", 2: "#fbbf24", 3: "#fb923c", 4: "#f87171", 5: "#ef4444" }
      : { 0: "#059669", 1: "#059669", 2: "#d97706", 3: "#ea580c", 4: "#dc2626", 5: "#991b1b" },
  };
}

export type MapPalette = ReturnType<typeof mapPalette>;
