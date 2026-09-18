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
    /* Congestion levels, banded to match how the rest of the app CLASSIFIES
       them. Brighter in dark so they hold up against the wash, deeper in light
       so they do not glow out against white.

       The bands are not free. corridor-status.ts classify() draws the line at
       level >= 3 for congested and treats 1-2 as slow, and the Live Corridor
       Status panel paints three colours from that. This palette used to
       disagree with it at both ends: level 1 took the SAME green as level 0
       while classify() already called it slow, and level 3 took an orange
       while classify() already called it congested. The same jam was then
       green on the map and amber in the panel - which is precisely what a
       reader notices, because the two sit one scroll apart reading the same
       feed.

       So: 0 is clear, 1-2 are the slow band, 3-5 are the congested band, and
       the anchor of each band is the exact colour the corridor legend uses
       (#23a55a, #e08a2e, #e04434). The map keeps two shades inside a band, so
       Standstill still reads heavier than Heavy; it simply can no longer land
       in a different band from the word the panel puts on it. */
    level: isDark
      ? { 0: "#34d399", 1: "#fbbf24", 2: "#f59e0b", 3: "#f87171", 4: "#ef4444", 5: "#dc2626" }
      : { 0: "#23a55a", 1: "#e8a83f", 2: "#e08a2e", 3: "#e8695a", 4: "#e04434", 5: "#b3261e" },

    /* The three colours the corridor is drawn in, everywhere it is drawn.
     *
     * The six-step ramp above shaded severity within a state, which put four
     * reds and two ambers on a road that every other view of the same data
     * describes in three words. The shading was information nothing else in the
     * dashboard carried, and it cost the one thing that matters on a map read
     * at a glance: being able to match a colour to the count beside it.
     *
     * These are the values the Live Corridor Status road already uses, so the
     * two maps and the panel are now literally the same three colours rather
     * than three sets that happened to agree. */
    status: isDark
      ? { clear: "#34d399", slow: "#f59e0b", congested: "#ef4444" }
      : { clear: "#23a55a", slow: "#e08a2e", congested: "#e04434" },
  };
}

export type MapPalette = ReturnType<typeof mapPalette>;

/**
 * Waze's own jam scale, as Waze publishes it.
 *
 * This is the SOURCE's vocabulary, not the dashboard's. The corridor is drawn
 * in three states because that is what every view of it counts — and because
 * the forecast model only has three to give — but the live feed underneath
 * carries six levels, and a reader who wants to know what "slow" is made of
 * deserves to be able to look. The Live Corridor Status map has offered this
 * as a reference for a while; it lives here now so the map legends can offer
 * exactly the same one rather than a second copy that drifts.
 */
export const JAM_SCALE: { level: 0 | 1 | 2 | 3 | 4 | 5; band: string; label: string }[] = [
  { level: 0, band: "100–80% of free-flow speed", label: "free flow" },
  { level: 1, band: "80–61%", label: "light" },
  { level: 2, band: "60–41%", label: "moderate" },
  { level: 3, band: "40–21%", label: "heavy" },
  { level: 4, band: "20–1%", label: "severe" },
  { level: 5, band: "blocked road", label: "blocked" },
];

/** Which of the three states a Waze level counts as. Mirrors classify(). */
export const STATUS_OF_LEVEL = (level: number): "clear" | "slow" | "congested" =>
  level <= 0 ? "clear" : level >= 3 ? "congested" : "slow";
