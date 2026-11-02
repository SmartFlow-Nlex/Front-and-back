// Shared vocabulary for the incident predictive tab: the model roster, the
// response shape, and the formatters. Extracted so the forecast chart, the
// narrative, and the visual-analysis panels cannot drift apart — a model must
// keep the same label and hue in every one of them.

// The seven candidates, keyed as the pipeline names them (MODEL_NAMES in
// train_incident_models.py). This is the incident roster, not the traffic one:
// there is no Prophet, Holt-Winters or Holts Linear on ml_predictive_incidents.
export type ModelKey =
  | "XGBoost"
  | "RandomForest"
  | "LSTM"
  | "GRU"
  | "Poisson_GLM"
  | "NegBinomial_GLM"
  | "SARIMAX";

// Night Corridor: green, amber and red belong to road state, so no model line
// uses them (XGBoost was green #16a34a, SARIMAX red #ef4444). The hues are
// categorical only; no visible text names a model by its colour.
export const MODELS: { key: ModelKey; label: string; color: string }[] = [
  { key: "XGBoost", label: "XGBoost", color: "#6366f1" },
  // Deep fuchsia, not the amber it used to be: VOLUME_COLOR below is #f59e0b,
  // so the exposure overlay and this model line were drawn in the same hue and
  // could not be told apart once both were on.
  { key: "RandomForest", label: "Random Forest", color: "#a21caf" },
  { key: "Poisson_GLM", label: "Poisson GLM", color: "#8b5cf6" },
  { key: "NegBinomial_GLM", label: "Neg. Binomial GLM", color: "#0891b2" },
  { key: "SARIMAX", label: "SARIMAX", color: "#0d9488" },
  { key: "LSTM", label: "LSTM", color: "#db2777" },
  { key: "GRU", label: "GRU", color: "#64748b" },
];

export const META = Object.fromEntries(MODELS.map((m) => [m.key, m])) as Record<
  ModelKey,
  (typeof MODELS)[number]
>;

export const ACTUAL_COLOR = "#2563eb";
export const RAIN_COLOR = "#38bdf8";
/**
 * Exposure overlay. Amber rather than another blue: rainfall already owns the
 * cyan end of the palette and the incident lines own the blues, so volume needs
 * a hue that cannot be mistaken for either at a glance.
 */
export const VOLUME_COLOR = "#f59e0b";

export type DailyPoint = {
  date: string;
  actual: number | null;
  predicted: number | null;
  // "train" rows are in-sample fitted values over the training period. They
  // feed the hourly drill-down so a past day still has model curves, and are
  // deliberately excluded from the daily chart's model lines and from every
  // accuracy metric — a fitted value is not a forecast.
  predictionType: "train" | "validation" | "future" | null;
  sameDayLastYear: number | null;
  rainfallMm: number | null;
  /** The day's wettest hour (mm in that hour), for PAGASA's hourly rain classes. */
  rainfallPeakHourMm?: number | null;
  /** Backend's own wet-day flag: mean hourly rainfall for the day > 0.3 mm. */
  isWet: boolean | null;
  /**
   * Daily vehicle volume — the exposure the incident count is generated from.
   * Observed only. Null on uncovered days, which breaks the line rather than
   * drawing a zero.
   */
  volume?: number | null;
  /** Future rows only: the traffic module's volume forecast, the input the volume-aware models read that day. */
  volumeForecast?: number | null;
  models: Partial<Record<ModelKey, number | null>>;
  /**
   * The same models refit with the volume features removed. Present only when
   * the pipeline stored a volume-free twin; absent on older tables, which is
   * what lets the chart tell "no twin exists" apart from "the twin predicted
   * nothing" and fall back to treating Volume as an overlay-only control.
   */
  modelsNoVolume?: Partial<Record<ModelKey, number | null>>;
  /**
   * The same models refit with rain_mm removed. Present only when the
   * pipeline stored a weather-free twin, mirroring modelsNoVolume above —
   * what lets the Weather toggle switch the forecast itself, not just the
   * rainfall overlay.
   */
  modelsNoWeather?: Partial<Record<ModelKey, number | null>>;
};

export type ModelMetric = {
  model: string;
  MAE: number | null;
  RMSE: number | null;
  WMAPE: number | null;
  MASE: number | null;
  R2: number | null;
  Adjusted_R2: number | null;
  Train_R2: number | null;
  Gap: number | null;
  Diagnosis: string | null;
  isChampion: boolean;
  // "window": computed live from the rows inside the current Range/Weather
  // slice. "holdout": that slice had no scored rows, so these numbers are the
  // pipeline's full-holdout figures instead.
  source: "window" | "holdout";
  n: number;
};

export type CorridorForecastPoint = {
  exitId: number;
  exitName: string;
  /** MEASURED km (Balintawak = 12); print it through fmtKm. */
  km: number;
  historicalCount: number;
  historicalShare: number;
  predictedIncidents: number;
};

// Same apportionment as CorridorForecastPoint, grouped by fixed 5km corridor
// segments instead of nearest exit — see buildKmSegmentForecast's doc
// comment in incident.service.ts for why that's a meaningfully finer view,
// not a duplicate of the exit one.
export type KmSegmentForecastPoint = {
  segmentStart: number;
  segmentEnd: number;
  label: string;
  historicalCount: number;
  historicalShare: number;
  predictedIncidents: number;
};

export type PredictiveData = {
  summary: {
    totalPredictedNext7Days: number;
    peakRiskDate: string | null;
    championModel: string | null;
  };
  daily: DailyPoint[];
  modelMetrics: ModelMetric[];
  featureImportance: { feature: string; importance: number }[];
  modelInfo: {
    championModel: string | null;
    forecastHorizon: number;
    trainedAt: string | null;
    metrics: Record<string, unknown> | null;
    scoredDays: number | null;
    trainedDays: number | null;
  };
  weatherMetrics: {
    weather: "all" | "dry" | "wet";
    days: number;
    models: { model: string; MAE: number; RMSE: number; R2: number | null; isChampion: boolean }[];
  } | null;
  /** Every model scored over only the dry, and only the wet, holdout days. */
  weatherSplit?: {
    dry: { days: number; models: { model: string; MAE: number; RMSE: number; R2: number | null; isChampion: boolean }[] };
    wet: { days: number; models: { model: string; MAE: number; RMSE: number; R2: number | null; isChampion: boolean }[] };
  };
  /**
   * Predicted incidents per exit/corridor — an apportionment of
   * summary.totalPredictedNext7Days by each exit's historical share of
   * incidents in the current Range, not a separately trained per-location
   * model. Null when the corridor's exit list or location data wasn't
   * available to build it.
   */
  corridorForecast: CorridorForecastPoint[] | null;
  /** Same apportionment, grouped by fixed 5km corridor segments instead of nearest exit. */
  kmSegmentForecast: KmSegmentForecastPoint[] | null;
  /** Fraction of the Range's incidents whose location matched no known exit. */
  unclassifiedLocationShare: number | null;
  /** How many published future days corridorForecast was apportioned over. */
  corridorForecastDays: number;
  /** The logged-incident window the per-exit shares were counted over. */
  corridorShareWindow?: { from: string; to: string | null } | null;
  /** Which model corridorForecast was apportioned from (toolbar pick, or the champion as a fallback). */
  corridorForecastModel: string | null;
  /**
   * Dedicated accident-only forecast, alongside the blended one (see
   * train_incident_models.py --series accident). Null until trained or on any
   * read failure. There is deliberately no breakdown series: it is derived as
   * blended total minus this accident forecast.
   */
  accidentSplit: {
    championModel: string | null;
    trainedAt: string | null;
    metrics: Record<string, unknown> | null;
    daily: { date: string; actual: number | null; predicted: number | null }[];
  } | null;
  scoringWindow: { start: string; end: string; n: number } | null;
  appliedFilters: {
    months: "3" | "12" | "all";
    weather: "all" | "dry" | "wet";
    contextFrom: string | null;
    contextTo: string | null;
  };
  dataBounds: { minDate: string; maxDate: string };
  windowBounds: {
    windowStart: string;
    validationStart: string | null;
    futureStart: string | null;
    windowEnd: string;
  };
  weatherApplicable: boolean;
  /**
   * How the champion's error grows with how far ahead a day was — a
   * rolling-origin study (measure_incident_horizon_accuracy.py), not derived
   * from modelInfo.metrics (one-step-ahead only). Empty when the study
   * hasn't been run yet. Same shape as traffic's own HorizonAccuracy.
   */
  horizonAccuracy: {
    model: string;
    hLo: number;
    hHi: number;
    n: number;
    wmape: number | null;
    mape: number | null;
    mase: number | null;
    mae: number | null;
    baselineWmape: number | null;
    usable: boolean;
    note: string | null;
  }[];
};

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
export const fmtNum = (v: number | null, dp = 3) => (v == null ? "—" : v.toFixed(dp));
export const fmtDate = (d: string | null) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
// Same as fmtDate but with a year — axis labels can afford to drop it (adjacent
// points disambiguate), a caption spanning years cannot.
export const fmtDateFull = (d: string | null) =>
  d
    ? new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "—";
// modelInfo.trainedAt is a full ISO timestamp, not a plain date — appending
// "T00:00:00" to it (as the two above do) would produce an invalid string.
/** A YYYY-MM-DD date moved by whole days, in UTC so no viewer time zone shifts it. */
export const isoShift = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** Today's date on the corridor (Asia/Manila), as YYYY-MM-DD. */
export const manilaTodayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
/** "1 Jul – 28 Sep 2026", or with both years when they differ. */
export const fmtDateRange = (from: string | null, to: string | null) => {
  if (!from || !to) return fmtDateFull(from ?? to);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const a = new Date(`${from}T00:00:00`).toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return from === to ? fmtDateFull(from) : `${a} – ${fmtDateFull(to)}`;
};
export const fmtTrainedAt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "unknown date";
