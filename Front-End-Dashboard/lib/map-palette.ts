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
export function mapPalette(isDark: boolean, hasMapboxToken: boolean = true) {
  const mapboxStyle = isDark
    ? "mapbox://styles/mapbox/dark-v11"
    : "mapbox://styles/mapbox/light-v11";

  const openCartoStyle = isDark
    ? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
    : "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

  return {
    style: hasMapboxToken ? mapboxStyle : openCartoStyle,
    /* A wash over the base map. Every road in Central Luzon is drawn at much
       the same weight, so dimming all of it is what actually makes NLEX the
       subject — far more than thickening the corridor could. */
    scrim: isDark ? "#070b14" : "#f1f5f9",
    scrimOpacity: isDark ? 0.55 : 0.6,
    /* A tint under the corridor rather than a coloured glow around it. The
       bright halo competed with the congestion colours it was meant to frame. */
    halo: isDark ? "#38bdf8" : "#0f172a",
    haloOpacity: isDark ? 0.14 : 0.08,
    /* A stretch the feed said nothing about. Distinct from every congestion
       colour on purpose: "not reported" is not a traffic condition. */
    noData: isDark ? "#475569" : "#cbd5e1",
    /* The roadway. White in light, near-black in dark: in both it separates
       the two ribbons and holds them against the base map. */
    casing: isDark ? "#0f172a" : "#ffffff",
    arrow: isDark ? "#e2e8f0" : "#ffffff",
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
