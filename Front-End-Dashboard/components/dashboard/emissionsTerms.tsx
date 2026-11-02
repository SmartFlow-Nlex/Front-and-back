/* Full names for the pollutant abbreviations the Emissions tab prints (17 Oct 2026, testers EM-10: "full
   pollutant name on hover"). <Term> is for HTML text; spelled() is for ECharts tooltips and labels, which
   draw on a canvas or in a tooltip string and cannot carry an <abbr>. These are the only abbreviations the
   tab shows: CO2 is the modelled record, NOx and PM2.5 come from the per-class factors, and AQI is the
   OpenWeatherMap model estimate. */

export const POLLUTANT_NAMES = {
  "CO₂": "Carbon dioxide",
  NOx: "Nitrogen oxides",
  "PM2.5": "Fine particulate matter: particles 2.5 micrometres across or smaller",
  AQI: "Air Quality Index: OpenWeatherMap's 1 (good) to 5 (very poor) scale",
} as const;

export type PollutantCode = keyof typeof POLLUTANT_NAMES;

/** The abbreviation, with its full name on hover. */
export function Term({ t }: { t: PollutantCode }) {
  return (
    <abbr className="nc-em-abbr" title={POLLUTANT_NAMES[t]}>
      {t}
    </abbr>
  );
}

/** "NOx · nitrogen oxides", for text drawn by a chart. */
export const spelled = (t: PollutantCode) => `${t} · ${POLLUTANT_NAMES[t].split(":")[0].toLowerCase()}`;
