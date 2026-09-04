"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import ModelNarrative, { type MetricRow } from "./ModelNarrative";
import { aggregateSeries } from "./aggregateSeries";
import { useThemeTokens, zoneTints } from "./useThemeTokens";
import WeatherEvidencePanel from "./WeatherEvidencePanel";

type ModelType = "LSTM" | "Prophet" | "HoltWinters" | "SARIMAX" | "HoltsLinear";

type ModelMeta = {
  key: ModelType;
  label: string;
  note: string;
  accepted: boolean;
  color: string;
  rmse: string;
  mae: string;
  wmape: string;
  r2: string;
  mape?: string;
  smape?: string;
  mase?: string;
  rmsse?: string;
  me?: string;
  mpe?: string;
  adjusted_r2?: string;
  mse?: string;
  train_r2?: string;
  val_r2?: string;
  gap?: string;
  diagnosis?: string;
};

// Ranked best → worst. Each model owns a distinct hue so several can share the
// chart at once without the reader having to guess which line is which.
//
// No numbers here — this is the pre-fetch/fetch-failed state. gold.ml_model_metrics
// is the only source of truth for rank/wmape/etc; hardcoding a snapshot here has
// twice gone stale silently and shown fabricated figures on screen when the API
// call failed. "—" makes a missing fetch visibly missing instead of confidently wrong.
const MODELS: ModelMeta[] = [
  { key: "LSTM", label: "LSTM", note: "Loading…", accepted: false, color: "#16a34a", rmse: "—", mae: "—", wmape: "—", r2: "—" },
  { key: "Prophet", label: "Prophet", note: "Loading…", accepted: false, color: "#f59e0b", rmse: "—", mae: "—", wmape: "—", r2: "—" },
  { key: "HoltWinters", label: "Holt-Winters", note: "Loading…", accepted: false, color: "#8b5cf6", rmse: "—", mae: "—", wmape: "—", r2: "—" },
  { key: "SARIMAX", label: "SARIMAX", note: "Loading…", accepted: false, color: "#ef4444", rmse: "—", mae: "—", wmape: "—", r2: "—" },
  { key: "HoltsLinear", label: "Holts Linear", note: "Loading…", accepted: false, color: "#db2777", rmse: "—", mae: "—", wmape: "—", r2: "—" },
];

const META = Object.fromEntries(MODELS.map((m) => [m.key, m])) as Record<ModelType, ModelMeta>;
const ACTUAL_COLOR = "#2563eb";
// Same pattern the other dashboard pages use. The literal URL was refactored out
// of this file but the constant was never declared here, so every fetch threw a
// ReferenceError, was swallowed by the catch, and the chart sat on "Loading…".
const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";
const VALIDATED_HORIZON = 14; // must match retrain_honest.py HORIZON

// The API hands back a DATE column that pg has already localised, so read the
// calendar parts back out in local time to recover the original YYYY-MM-DD.
const toIsoDate = (value: string) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const fmtVeh = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);

type HourlyPoint = { hour: number; actual: number | null; predicted: number | null; rainfall?: number | null; temperature?: number | null };
type HourlyForecast = {
  date: string;
  weekday: string;
  isFuture: boolean;
  dayActual: number | null;
  dayPredicted: number | null;
  profileSource: "observed" | "weekday-profile" | null;
  weather: "all" | "dry" | "wet";
  observedHours: number;
  hours: HourlyPoint[];
};

type ForecastRow = {
  date: string;
  actual_volume: number | null;
  pred_lstm: number | null;
  pred_prophet: number | null;
  pred_holtwinters: number | null;
  pred_sarimax: number | null;
  pred_holts_linear: number | null;
  // Weather-free counterparts. Holt-Winters and Holts Linear are univariate, so
  // they have no variant — their line is the same either way.
  pred_prophet_nw: number | null;
  pred_sarimax_nw: number | null;
  pred_lstm_nw: number | null;
  is_holdout: boolean;
  is_future: boolean;
  weather_rainfall: number | null;
  weather_temp: number | null;
};

type ChartData = {
  dates: string[];
  isoDates: string[];
  baseActual: (number | null)[];
  models: Record<ModelType, (number | null)[]>;
  modelsNoWeather: Record<ModelType, (number | null)[]>;
  holdoutStart: number;
  futureStart: number;
  rainfall: (number | null)[];
  temperature: (number | null)[];
};

/** Reads the day's shape off whichever series exists — actuals when observed,
    otherwise the forecast curve. */
const hourExtreme = (hours: HourlyPoint[], pick: "max" | "min") => {
  const series = hours
    .map((p) => ({ hour: p.hour, v: p.actual ?? p.predicted }))
    .filter((p): p is { hour: number; v: number } => p.v != null);
  if (series.length === 0) return null;
  return series.reduce((best, p) => ((pick === "max" ? p.v > best.v : p.v < best.v) ? p : best));
};
const extremeLabel = (hours: HourlyPoint[], pick: "max" | "min") => {
  const p = hourExtreme(hours, pick);
  return p ? `${fmtHour(p.hour)} · ${fmtVeh(p.v)}` : "—";
};

type Props = {
  months?: "3" | "12" | "all";
  from?: string;
  to?: string;
  weather?: "all" | "dry" | "wet";
};

export default function PredictiveVolumeChart({ months = "all", from, to, weather = "all" }: Props) {
  // Several models can be on screen at once; the list never empties so the
  // chart always has something to compare the ground truth against.
  const [selected, setSelected] = useState<ModelType[]>(["LSTM"]);
  const [chartData, setChartData] = useState<ChartData | null>(null);
  // Raw metric rows, kept unmodified so the narrative can read fields the
  // metrics TABLE does not display (rejected_reason, aic/bic, the _nw twins).
  const [rawMetrics, setRawMetrics] = useState<MetricRow[]>([]);
  const [showAllMetrics, setShowAllMetrics] = useState(false);
  const [showWeather, setShowWeather] = useState(true);

  // How much of each zone to display, in days. These trim the view only — the
  // scored window and the forecast horizon are fixed by the model run, so
  // narrowing PAST here can never change a metric.
  //
  // Granularity & zone window controls
  const [granularity, setGranularity] = useState<"Hourly" | "Daily" | "Weekly" | "Monthly" | "Yearly">("Daily");
  // ECharts needs literal colours, so the CSS tokens are resolved at runtime.
  const T = useThemeTokens();
  const ZONE = zoneTints(T.isDark);

  const [futureDays, setFutureDays] = useState<number>(14);

  // Drill-down: which day is expanded to its 24-hour breakdown
  const [drillDate, setDrillDate] = useState<string | null>(null);
  const [hourlyByModel, setHourlyByModel] = useState<Partial<Record<ModelType, HourlyForecast>>>({});
  const [hourlyLoading, setHourlyLoading] = useState(false);
  const [hourlyError, setHourlyError] = useState<string | null>(null);

  // Derived, not stored. Keeping this as state meant the table kept showing the
  // weather-driven numbers after the chart had switched to the weather-free lines,
  // so the table and the plot above it described different forecasts.
  const metricsMeta = useMemo<Record<ModelType, ModelMeta>>(() => {
    const next: Record<ModelType, ModelMeta> = { ...META };
    if (!rawMetrics.length) return next;

    const byName = new Map(rawMetrics.map((m) => [m.model_name, m]));
    const DB_NAME: Record<ModelType, string> = {
      LSTM: "LSTM", Prophet: "Prophet", HoltWinters: "HoltWinters",
      SARIMAX: "SARIMAX", HoltsLinear: "Holts_Linear",
    };
    const TWIN: Partial<Record<ModelType, string>> = {
      Prophet: "Prophet_nw", SARIMAX: "SARIMAX_nw", LSTM: "LSTM_nw",
    };
    // Rank is assigned across the FULL candidate set, so a subset shows gaps.
    // Printing the denominator turns a confusing "Rank #2" with no #1 in sight
    // into an honest "#2 of 8".
    const total = rawMetrics.length;
    const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);

    (Object.keys(next) as ModelType[]).forEach((k) => {
      const twin = TWIN[k];
      const row = (!showWeather && twin ? byName.get(twin) : undefined) ?? byName.get(DB_NAME[k]);
      if (!row) return;
      const r = row as unknown as Record<string, unknown>;
      const f = (key: string, d = 4) => { const v = num(r[key]); return v == null ? "—" : v.toFixed(d); };
      const pct = (key: string) => { const v = num(r[key]); return v == null ? "—" : v.toFixed(2) + "%"; };
      const int = (key: string) => { const v = num(r[key]); return v == null ? "—" : Math.round(v).toLocaleString("en-US"); };
      next[k] = {
        ...next[k],
        rmse: int("rmse"), mae: int("mae"), wmape: pct("wmape"), r2: f("r2"),
        mape: pct("mape"), smape: pct("smape"), mase: f("mase", 3), rmsse: f("rmsse"),
        adjusted_r2: f("adjusted_r2"), mse: int("mse"),
        train_r2: f("train_r2"), val_r2: f("val_r2"), gap: f("gap"),
        diagnosis: (r["diagnosis"] as string) || "—",
        note: row.accepted ? `Rank #${row.rank} of ${total}` : "Rejected",
        accepted: !!row.accepted,
      };
    });
    return next;
  }, [rawMetrics, showWeather]);

  const toggleModel = useCallback((key: ModelType) => {
    setSelected((prev) => {
      if (!prev.includes(key)) return MODELS.filter((m) => m.key === key || prev.includes(m.key)).map((m) => m.key);
      if (prev.length === 1) return prev; // keep at least one line on the chart
      return prev.filter((k) => k !== key);
    });
  }, []);

  useEffect(() => {
    // A half-filled custom range would query a nonsense window
    if (from !== undefined && (!from || !to)) return;
    let cancelled = false;

    async function fetchData() {
      try {
        const qs = new URLSearchParams();
        if (from && to) {
          qs.set("from", from);
          qs.set("to", to);
        } else {
          /* Always the full history, whatever the page's Range says.
             This chart's subject is the model's own split — how much data
             trained it against how much tested it — and that split is fixed by
             the training run, not by a viewing window. Asking for 12 months
             returned less training data than the holdout is long, so the bands
             came out roughly even and the chart showed a model tested on half
             its data. The Range control still governs the descriptive charts,
             where it means what it says. */
          qs.set("months", "all");
        }
        if (weather && weather !== "all") {
          qs.set("weather", weather);
        }
        const res = await fetch(`${BACKEND}/api/traffic/forecast?${qs}`);
        const json = await res.json();
        if (cancelled || !json.success || !json.data?.volumes) return;

        const rows = json.data.volumes as ForecastRow[];

        // Both variants are kept in state so toggling Weather is instant and does
        // not refetch. Prophet/SARIMAX/LSTM differ; the two univariate models
        // reuse the same series because weather was never an input to them.
        const models: Record<ModelType, (number | null)[]> = {
          LSTM: [], Prophet: [], HoltWinters: [], SARIMAX: [], HoltsLinear: [],
        };
        const modelsNoWeather: Record<ModelType, (number | null)[]> = {
          LSTM: [], Prophet: [], HoltWinters: [], SARIMAX: [], HoltsLinear: [],
        };

        rows.forEach((v) => {
          models.LSTM.push(v.pred_lstm);
          models.Prophet.push(v.pred_prophet);
          models.HoltWinters.push(v.pred_holtwinters);
          models.SARIMAX.push(v.pred_sarimax);
          models.HoltsLinear.push(v.pred_holts_linear);

          modelsNoWeather.LSTM.push(v.pred_lstm_nw ?? v.pred_lstm);
          modelsNoWeather.Prophet.push(v.pred_prophet_nw ?? v.pred_prophet);
          modelsNoWeather.SARIMAX.push(v.pred_sarimax_nw ?? v.pred_sarimax);
          modelsNoWeather.HoltWinters.push(v.pred_holtwinters);
          modelsNoWeather.HoltsLinear.push(v.pred_holts_linear);
        });

        // Zone boundaries come from the data itself — hardcoded indices break
        // the moment the walk-forward window is re-run with a different split.
        const holdoutStart = rows.findIndex((v) => v.is_holdout);
        const futureStart = rows.findIndex((v) => v.is_future);

        const metricsData = json.data.modelMetrics ?? json.data.metrics;
        if (metricsData) setRawMetrics(metricsData as MetricRow[]);

        setChartData({
          // The year MUST be part of the category value, not just its label. Zone
          // bands and divider lines are anchored by category NAME, so once the
          // window spans more than a year "Aug 9" existed three times over and
          // ECharts pinned Past/Present/Future to the wrong occurrence — the
          // shading landed months away from the data it was meant to describe.
          // Same defect silently sent click-to-drill to the wrong day.
          dates: rows.map((v) =>
            new Date(v.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })),
          isoDates: rows.map((v) => toIsoDate(v.date)),
          baseActual: rows.map((v) => v.actual_volume),
          models,
          modelsNoWeather,
          holdoutStart: holdoutStart === -1 ? rows.length : holdoutStart,
          futureStart: futureStart === -1 ? rows.length : futureStart,
          rainfall: rows.map((v) => v.weather_rainfall != null ? Number(v.weather_rainfall) : null),
          temperature: rows.map((v) => v.weather_temp != null ? Number(v.weather_temp) : null),
        });
      } catch (err) {
        console.error("Failed to fetch ML forecast", err);
      }
    }
    fetchData();
    return () => {
      cancelled = true;
    };
  }, [months, from, to, weather]);

  // Pull the 24-hour breakdown for every selected model whenever a day is open.
  useEffect(() => {
    if (!drillDate) return;
    let cancelled = false;
    setHourlyLoading(true);
    setHourlyError(null);

    Promise.all(
      selected.map(async (model) => {
        const r = await fetch(`http://localhost:4000/api/traffic/forecast/hourly?date=${drillDate}&model=${model}&weather=${weather}`);
        const json = await r.json();
        if (!json.success) throw new Error(json.message ?? "Request failed");
        return [model, json.data as HourlyForecast] as const;
      })
    )
      .then((entries) => {
        if (cancelled) return;
        setHourlyByModel(Object.fromEntries(entries) as Partial<Record<ModelType, HourlyForecast>>);
      })
      .catch((e) => !cancelled && setHourlyError(e instanceof Error ? e.message : "Failed to load hourly data"))
      .finally(() => !cancelled && setHourlyLoading(false));

    return () => {
      cancelled = true;
    };
  }, [drillDate, selected, weather]);

  const closeDrill = () => {
    setDrillDate(null);
    setHourlyByModel({});
    setHourlyError(null);
  };

  // ---------- Shared chrome ----------
  const modelToolbar = (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: "0 1 auto", minWidth: 0 }}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-muted)", flex: "none" }}>
        <path d="M2 11.5l3.5-4 3 3L13.5 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.5 4h3v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span style={{ fontSize: "0.74rem", fontWeight: 700, color: "var(--text-secondary, #4b5e7d)", letterSpacing: "0.02em", whiteSpace: "nowrap" }}>
        Models
      </span>
      {/* Same segmented-pill control the Range/Weather filters use, with each
          selected model tinted its own series colour. */}
      <div
        style={{
          display: "inline-flex", flexWrap: "wrap", gap: "2px", padding: "3px",
          background: "var(--bg-surface)", border: "1px solid #dce2ef", borderRadius: "999px",
        }}
      >
        {MODELS.map((baseM) => {
          const m = metricsMeta[baseM.key];
          const on = selected.includes(m.key);
          const locked = on && selected.length === 1;
          return (
            <button
              key={m.key}
              onClick={() => toggleModel(m.key)}
              aria-pressed={on}
              title={locked ? "At least one model must stay selected" : `${on ? "Hide" : "Show"} ${m.label}`}
              style={{
                display: "inline-flex", alignItems: "center", border: 0,
                padding: "5px 12px", borderRadius: "999px",
                fontSize: "0.76rem", fontWeight: 600, whiteSpace: "nowrap",
                cursor: locked ? "default" : "pointer", transition: "all 0.15s",
                background: on ? m.color : "transparent",
                color: on ? "var(--bg-surface)" : "var(--text-secondary, #4b5e7d)",
                boxShadow: on ? `0 1px 4px ${m.color}40` : "none",
              }}
            >
              {on && (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}>
                  <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {m.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  const metricsTable = (
    <div style={{ background: "var(--bg-surface-hover)", borderRadius: "8px", padding: "16px", border: "1px solid var(--border-default)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <h4 style={{ margin: "0", fontSize: "0.95rem", color: "var(--text-primary)", fontWeight: 600 }}>
          Real-World ML Validation Metrics
        </h4>
        <button
          onClick={() => setShowAllMetrics(!showAllMetrics)}
          style={{
            display: "inline-flex", alignItems: "center", gap: "6px", padding: "4px 10px", borderRadius: "6px",
            background: showAllMetrics ? "var(--bg-surface-hover)" : "var(--bg-surface)", border: "1px solid var(--border-strong)",
            color: "var(--text-secondary)", fontSize: "0.75rem", fontWeight: 600, cursor: "pointer", transition: "all 0.15s"
          }}
        >
          {showAllMetrics ? "Show Less" : "Show All Metrics"}
        </button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", minWidth: showAllMetrics ? "1000px" : "600px" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              <th style={{ padding: "6px 10px", fontWeight: 600 }}>Model</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>RMSE (veh)</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MAE (veh)</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>WMAPE</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>R² Score</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }} title="Error relative to a seasonal-naive forecast. Below 1.0 beats it; above 1.0 does not.">MASE</th>
              {showAllMetrics && (
                <>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MAPE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>sMAPE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>RMSSE</th>
                                    <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Adj R²</th>
                                  </>
              )}
            </tr>
          </thead>
          <tbody>
            {MODELS.map(baseM => metricsMeta[baseM.key]).filter((m) => selected.includes(m.key)).map((m) => (
              <tr key={m.key} style={{ background: "var(--bg-surface)", borderTop: "1px solid var(--border-default)" }}>
                <td style={{ padding: "10px", fontWeight: 700, color: "var(--text-primary)" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: m.color }} />
                    {m.label}
                    <span style={{ fontSize: "0.72rem", fontWeight: 500, color: m.accepted ? "var(--color-success)" : "var(--color-danger)" }}>{m.note}</span>
                  </span>
                </td>
                <td style={{ padding: "10px", textAlign: "right", color: "var(--text-primary)" }}>{m.rmse}</td>
                <td style={{ padding: "10px", textAlign: "right", color: "var(--text-primary)" }}>{m.mae}</td>
                <td style={{ padding: "10px", textAlign: "right", fontWeight: 700, color: m.color }}>{m.wmape}</td>
                <td style={{ padding: "10px", textAlign: "right", fontWeight: 700, color: m.color }}>{m.r2}</td>
                <td style={{ padding: "10px", textAlign: "right", fontWeight: 700,
                  color: m.mase && m.mase !== "—" ? (parseFloat(m.mase) < 1 ? "var(--color-success)" : "var(--color-danger)") : "var(--text-secondary)" }}>
                  {m.mase ?? "—"}
                </td>
                {showAllMetrics && (
                  <>
                    <td style={{ padding: "10px", textAlign: "right", color: "var(--text-secondary)" }}>{m.mape ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "var(--text-secondary)" }}>{m.smape ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "var(--text-secondary)" }}>{m.rmsse ?? "—"}</td>
                                        <td style={{ padding: "10px", textAlign: "right", color: "var(--text-secondary)" }}>{m.adjusted_r2 ?? "—"}</td>
                                      </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  if (!chartData) {
    return (
      <article className="chart-card wide" style={{ padding: "24px" }}>
        <div style={{ color: "var(--text-secondary)" }}>Loading ML forecast from AWS…</div>
      </article>
    );
  }

  // Weather ON => the weather-driven forecasts; OFF => the weather-free controls.
  // The toggle therefore changes the prediction itself, not just the overlay.
  const rawModels = showWeather ? chartData.models : chartData.modelsNoWeather;

  // Trim to the requested zone widths. Slicing every series by the same window
  // keeps the zone boundaries aligned with the data after the cut.
  // All three zones (Past · Present · Future) are always fully visible.
  /* How much training history to show.
   *
   * The zones are the model's own split: everything before holdoutStart trained
   * it, the holdout tested it, and the future is the forecast. In the warehouse
   * that is 2,488 / 434 / 56 rows — roughly 85/15 of the scored period. The
   * chart only tells that story if the training band is drawn several times
   * wider than the test band.
   *
   * Daily used to clip the past to a flat 90 days while the holdout ran 434, so
   * the picture inverted: a sliver of training beside ten months of testing,
   * which reads as a model tested on most of its data. The clip exists because
   * 2,400 raw points in 1,400px is an unreadable band, so it stays — but sized
   * from the holdout rather than fixed, which keeps the proportion honest at
   * every granularity. */
  const proportionalPast = Math.max(90, (chartData.futureStart - chartData.holdoutStart) * 4);
  const lo = Math.max(0, chartData.holdoutStart - proportionalPast);
  const hi = Math.min(chartData.dates.length, chartData.futureStart + futureDays);
  const cut = <T,>(a: T[]) => a.slice(lo, hi);

  const dailyDates = cut(chartData.dates);
  const dailyIso = cut(chartData.isoDates);
  const dailyActual = cut(chartData.baseActual);
  const dailyRain = cut(chartData.rainfall);
  const dailyHoldoutStart = chartData.holdoutStart - lo;
  const dailyFutureStart = chartData.futureStart - lo;
  const dailyModels = Object.fromEntries(
    (Object.keys(rawModels) as ModelType[]).map((k) => [k, cut(rawModels[k])])
  ) as Record<ModelType, (number | null)[]>;

  // Coarser views genuinely aggregate now. Previously Monthly and Yearly plotted
  // the identical daily series and differed only by decorative dividers, which
  // made the control a claim the chart could not back up — and at ~2,400 points
  // in ~1,400px the line was an unreadable band either way.
  const agg = aggregateSeries<ModelType>({
    granularity,
    isoDates: dailyIso,
    baseActual: dailyActual,
    models: dailyModels,
    rainfall: dailyRain,
    holdoutStart: dailyHoldoutStart,
    futureStart: dailyFutureStart,
  });

  const dates = agg ? agg.dates : dailyDates;
  const isoDates = agg ? agg.isoDates : dailyIso;
  const baseActual = agg ? agg.baseActual : dailyActual;
  const rainfall = agg ? agg.rainfall : dailyRain;
  const models = agg ? agg.models : dailyModels;
  const holdoutStart = agg ? agg.holdoutStart : dailyHoldoutStart;
  const futureStart = agg ? agg.futureStart : dailyFutureStart;

  const isAggregated = agg != null;
  const drillIndex = drillDate ? isoDates.indexOf(drillDate) : -1;
  const drillLabel = drillIndex >= 0 ? dates[drillIndex] : drillDate ?? "";

  // Clicking a point (or its x-axis label) opens that day's hourly breakdown
  const openDay = (index: number) => {
    if (isAggregated) return; // a point is a period here, not a single day
    if (index >= 0 && index < isoDates.length) setDrillDate(isoDates[index]);
  };
  const onChartClick = (params: { componentType?: string; dataIndex?: number; value?: string }) => {
    if (params.componentType === "xAxis") return openDay(dates.indexOf(String(params.value)));
    if (typeof params.dataIndex === "number") openDay(params.dataIndex);
  };

  const zoneLabel = (text: string) => ({
    show: true,
    position: "insideTop" as const,
    color: "var(--text-muted)",
    fontSize: 11,
    fontWeight: 600 as const,
    formatter: text,
  });

  const weeklyPeriods: { weekNum: number; start: string; end: string }[] = [];
  let weekNum = 1;
  for (let i = 0; i < dates.length; i += 7) {
    const endIdx = Math.min(i + 6, dates.length - 1);
    if (dates[i] && dates[endIdx]) {
      weeklyPeriods.push({ weekNum, start: dates[i], end: dates[endIdx] });
      weekNum++;
    }
  }

  const monthlyPeriods: { monthNum: number; name: string; start: string; end: string }[] = [];
  let currentMonth = "";
  let monthStartIdx = 0;
  let monthNum = 1;

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i] || "";
    const monthName = d.split(" ")[0] || d;

    if (i === 0) currentMonth = monthName;

    const monthChanged = monthName !== currentMonth;
    if (monthChanged) {
      const endIdx = i - 1;
      monthlyPeriods.push({
        monthNum,
        name: currentMonth,
        start: dates[monthStartIdx],
        end: dates[endIdx],
      });
      currentMonth = monthName;
      monthStartIdx = i;
      monthNum++;
    }

    if (i === dates.length - 1) {
      monthlyPeriods.push({
        monthNum,
        name: currentMonth,
        start: dates[monthStartIdx],
        end: dates[i],
      });
    }
  }

  const yearlyPeriods: { yearNum: number; name: string; start: string; end: string }[] = [];
  let currentYear = "";
  let yearStartIdx = 0;
  let yearNum = 1;

  for (let i = 0; i < dates.length; i++) {
    const yearName = isoDates[i] ? isoDates[i].split("-")[0] : "2026";
    if (i === 0) currentYear = yearName;

    const yearChanged = yearName !== currentYear;
    if (yearChanged) {
      const endIdx = i - 1;
      yearlyPeriods.push({
        yearNum,
        name: currentYear,
        start: dates[yearStartIdx],
        end: dates[endIdx],
      });
      currentYear = yearName;
      yearStartIdx = i;
      yearNum++;
    }

    if (i === dates.length - 1) {
      yearlyPeriods.push({
        yearNum,
        name: currentYear,
        start: dates[yearStartIdx],
        end: dates[i],
      });
    }
  }

  // Weather overlay (only when toggled on). Temperature was dropped: it carries
  // almost no signal here (Pearson r = -0.06 against volume) and a second axis
  // for it made the chart harder to read than it was worth.
  //
  // Rainfall is shaded by intensity so the bars read as a weather condition at a
  // glance rather than as anonymous blue blocks. Thresholds follow PAGASA's
  // rainfall advisory bands.
  const RAIN_BANDS = [
    { max: 7.5, label: "Light", color: "rgba(56, 189, 248, 0.45)" },
    { max: 15, label: "Moderate", color: "rgba(14, 165, 233, 0.65)" },
    { max: 30, label: "Heavy", color: "rgba(2, 132, 199, 0.8)" },
    { max: Infinity, label: "Intense", color: "rgba(30, 64, 175, 0.9)" },
  ];
  const rainBand = (mm: number) => RAIN_BANDS.find((b) => mm < b.max) ?? RAIN_BANDS[RAIN_BANDS.length - 1];

  const weatherSeries: NonNullable<EChartsOption["series"]> = showWeather ? [
    {
      name: "Rainfall (mm)",
      type: "bar",
      yAxisIndex: 1,
      data: rainfall.map((mm) =>
        mm == null ? null : { value: mm, itemStyle: { color: rainBand(mm).color } }
      ),
      barMaxWidth: 16,
      z: 2,
      itemStyle: { borderRadius: [3, 3, 0, 0] },
    },
  ] : [];

  // Only worth spending a second label line on the year when the window actually
  // crosses one — at the 80/20 split it usually does, at "3 mo" it usually doesn't.
  // Which indices get a date label. A plain fixed stride left the Future block
  // undated: at 594 points the stride is 50, so the last tick landed on index 550
  // while the forecast began at 566 — the entire projection had no date under it.
  // The first forecast day and the final day are therefore always labelled, and any
  // stride tick that would collide with them is dropped instead of overlapping.
  const labelIndices = (() => {
    const n = dates.length;
    const keep = new Set<number>();
    if (n === 0) return keep;
    const stride = Math.max(1, Math.ceil(n / 12));
    for (let i = 0; i < n; i += stride) keep.add(i);
    const mustLabel = [futureStart, n - 1].filter((i) => i >= 0 && i < n);
    const mustSet = new Set(mustLabel);
    const minGap = Math.max(2, Math.floor(stride * 0.6));
    for (const m of mustLabel) {
      // Only thin the regular stride ticks. Guarding mustSet matters because the
      // start and end of the forecast sit close together, and without it the
      // second forced label silently deleted the first.
      for (const k of Array.from(keep)) {
        if (!mustSet.has(k) && Math.abs(k - m) < minGap) keep.delete(k);
      }
      keep.add(m);
    }
    return keep;
  })();

  const spansMultipleYears =
    isoDates.length > 0 && isoDates[0]?.slice(0, 4) !== isoDates[isoDates.length - 1]?.slice(0, 4);

  const dailyOption: EChartsOption = {
    grid: { left: 80, right: showWeather ? 80 : 24, top: 28, bottom: 104 },
    tooltip: {
      trigger: "axis",
      backgroundColor: T.tooltipBg,
      borderColor: T.border,
      textStyle: { color: T.tooltipText },
      formatter: (params: unknown) => {
        const items = params as { name: string; marker: string; seriesName: string; value: number | null }[];
        if (!items || items.length === 0) return "";
        let tip = `<b>${items[0].name}</b>${isAggregated ? " · period average" : ""}<br/>`;
        items.forEach((p) => {
          if (p.value != null) {
            if (p.seriesName === "Rainfall (mm)") {
              const mm = Number(p.value);
              tip += `${p.marker} Rainfall: <b>${mm.toFixed(1)} mm</b> \u00B7 ${rainBand(mm).label}<br/>`;
            } else {
              tip += `${p.marker} ${p.seriesName}: <b>${fmtVeh(Number(p.value))}</b><br/>`;
            }
          }
        });
        return `${tip}<span style="color:#94a3b8;font-size:11px">${
          isAggregated ? "Switch to Daily to open a day" : "Click to view hourly"
        }</span>`;
      },
    },
    legend: {
      /* The forecast is its own series and needs its own key, or the dashed
         line in the Future band is unexplained. Named "Forecast" against the
         fitted line's "Prediction", which is the distinction that matters:
         one is the model scored on days that happened, the other is the part
         that has not happened yet. */
      data: [
        "Actual Volume",
        ...selected.flatMap((k) => [
          `${metricsMeta[k].label} Prediction`,
          `${metricsMeta[k].label} Forecast`,
        ]),
        ...(showWeather ? ["Rainfall (mm)"] : []),
      ],
      bottom: 0,
      icon: "circle",
      itemGap: 16,
      textStyle: { fontSize: 12, color: T.chartText },
    },
    dataZoom: [
      /* Full width. The chart's subject is the split — how much data trained
         the model, how much it was tested on, and what it forecasts — and that
         proportion only reads if all three zones are on screen at once.
         An earlier attempt opened on the tail to make the forecast bigger; it
         made the forecast legible by hiding the training period that gives it
         meaning, which is a worse trade. The forecast is found by its dashed
         line and its green band instead. */
      { type: "slider", start: 0, end: 100, height: 18, bottom: 44,
        borderColor: T.border, fillerColor: T.isDark ? "rgba(56,118,245,0.18)" : "rgba(37,99,235,0.08)",
        handleStyle: { color: "#3876f5" }, textStyle: { color: T.textMuted, fontSize: 10 },
        backgroundColor: T.isDark ? "rgba(255,255,255,0.03)" : "transparent",
        dataBackground: { lineStyle: { color: T.chartAxis }, areaStyle: { color: T.chartSplit } } },
    ],
    xAxis: {
      type: "category",
      data: dates,
      triggerEvent: true,
      axisLine: { lineStyle: { color: T.chartAxis } },
      axisLabel: {
        color: T.chartText,
        // Space labels by how many points there actually are, not a fixed modulo.
        // The 80/20 split pushed the series to ~744 days; `index % 5` then asked
        // for 149 labels in ~1,300px and they collapsed into an unreadable smear.
        // Targeting a fixed COUNT keeps it legible at every range and granularity.
        interval: (index: number) => labelIndices.has(index),
        // Label shapes differ by granularity: "Mar 7, 2025" when daily or weekly,
        // but "Apr 2024" once aggregated by month. Blind destructuring on ", "
        // printed an undefined second line under every monthly tick.
        formatter: (value: string) => {
          const split = value.lastIndexOf(", ");
          if (split === -1) return value;            // label already carries its year
          return spansMultipleYears
            ? value.slice(0, split) + "\n" + value.slice(split + 2)
            : value.slice(0, split);
        },
        lineHeight: 14,
      },
    },
    yAxis: [
      {
        type: "value",
        name: isAggregated ? "Avg Daily Volume (per period)" : "Total Vehicle Volume",
        nameLocation: "middle",
        nameGap: 60,
        axisLabel: { color: T.chartText, formatter: (val: number) => `${(val / 1000).toFixed(0)}k` },
        splitLine: { lineStyle: { color: T.chartSplit, type: "dashed" } },
        scale: true,
      },
      {
        type: "value",
        name: showWeather ? "Daily rainfall (mm)" : "",
        nameLocation: "middle",
        nameGap: 50,
        nameTextStyle: { color: T.isDark ? "#38bdf8" : "#0284c7", fontSize: 11, fontWeight: "bold" },
        position: "right",
        axisLabel: { show: showWeather, color: T.isDark ? "#38bdf8" : "#0284c7", formatter: (val: number) => `${val.toFixed(0)}` },
        axisLine: { show: showWeather, lineStyle: { color: T.isDark ? "#38bdf8" : "#0284c7" } },
        splitLine: { show: false },
        min: 0,
        max: (value: { max: number }) => Math.ceil(value.max * 1.2) || 10,
      },
    ],
    series: [
      {
        name: "Actual Volume",
        type: "line",
        yAxisIndex: 0,
        data: baseActual,
        smooth: true,
        connectNulls: true,
        symbol: "circle",
        symbolSize: dates.length > 400 ? 0 : 5,
        z: 3,
        lineStyle: { width: dates.length > 400 ? 1 : 2.5, color: ACTUAL_COLOR },
        itemStyle: { color: ACTUAL_COLOR },
        emphasis: { scale: 2.2 },
        markArea: {
          silent: true,
          data: [
            { name: "Past", from: 0, to: holdoutStart - 1, color: ZONE.past },
            { name: "Present", from: holdoutStart, to: futureStart - 1, color: ZONE.present },
            { name: "Future", from: futureStart, to: dates.length - 1, color: ZONE.future },
          ]
            .filter((z) => z.from <= z.to && dates[z.from] != null && dates[z.to] != null)
            .map((z) => [
              { xAxis: dates[z.from], itemStyle: { color: z.color }, label: zoneLabel(z.name) },
              { xAxis: dates[z.to] },
            ]),
        },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { type: "dashed", color: ZONE.divider },
          data: [
            ...[holdoutStart, futureStart]
              .filter((i) => dates[i] != null)
              .map((i) => ({ xAxis: dates[i], label: { show: false } })),
            // Period dividers for Weekly/Monthly granularity. These are thinned to
            // at most ~12 across the window: at the full 744-day range Monthly drew
            // 24 unlabelled green lines over the data, which read as noise rather
            // than as month boundaries. Any divider that survives the thinning is
            // labelled, so a line on the chart always says what it marks.
            ...(() => {
              const periods =
                granularity === "Weekly" ? weeklyPeriods.map((w) => ({ at: w.start, tag: `W${w.weekNum}` }))
                : granularity === "Monthly" ? monthlyPeriods.map((m) => ({ at: m.start, tag: `M${m.monthNum}` }))
                : [];
              if (periods.length === 0) return [];
              const stride = Math.max(1, Math.ceil(periods.length / 12));
              const tint = granularity === "Weekly" ? "#3b82f6" : "#16a34a";
              const ink = granularity === "Weekly" ? "#1d4ed8" : "var(--color-success)";
              const wash = granularity === "Weekly" ? "rgba(239,246,255,0.92)" : "rgba(240,253,244,0.92)";
              return periods
                .filter((_, i) => i % stride === 0)
                .map((p) => ({
                  xAxis: p.at,
                  lineStyle: { type: "dashed" as const, color: tint, width: 1, opacity: 0.45 },
                  label: {
                    show: true,
                    position: "insideEndTop" as const,
                    formatter: p.tag,
                    color: ink,
                    fontSize: 9,
                    fontWeight: 700 as const,
                    backgroundColor: wash,
                    padding: [1, 3],
                    borderRadius: 2,
                  },
                }));
            })(),
            ...(dates[futureStart + VALIDATED_HORIZON] != null
              ? [{
                  xAxis: dates[futureStart + VALIDATED_HORIZON],
                  lineStyle: { type: "dotted" as const, color: "#f59e0b", width: 2 },
                  label: {
                    show: true, position: "end" as const, formatter: "beyond validated 14d",
                    color: "var(--color-warning)", fontSize: 10, fontWeight: 600 as const,
                  },
                }]
              : []),
          ],
        },
      },
      /* Each model draws twice: what it fitted against days it could be scored
         on, and what it forecasts for days that have not happened.

         They were one line before, in one weight, so the reader could not see
         where hindsight stopped and prediction began — the most important
         boundary on the chart, and the one the Past/Present/Future bands are
         there to mark. The forecast is dashed and drawn heavier, and the two
         share a point at the boundary so the line stays continuous. */
      ...selected.flatMap((key) => {
        const colour = metricsMeta[key].color;
        const fitted = models[key].map((v, i) => (i <= futureStart ? v : null));
        const forecast = models[key].map((v, i) => (i >= futureStart ? v : null));
        const dense = dates.length > 400;

        return [
          {
            name: `${metricsMeta[key].label} Prediction`,
            type: "line" as const,
            yAxisIndex: 0,
            data: fitted,
            smooth: true,
            connectNulls: true,
            symbol: "circle",
            symbolSize: 5,
            lineStyle: { width: dense ? 1.2 : 2.2, color: colour },
            itemStyle: { color: colour },
            emphasis: { scale: 2.2 },
          },
          {
            name: `${metricsMeta[key].label} Forecast`,
            type: "line" as const,
            yAxisIndex: 0,
            data: forecast,
            smooth: true,
            connectNulls: true,
            symbol: "circle",
            symbolSize: 6,
            // Heavier than the fitted line even when the series is dense: it is
            // the shortest stretch on the chart and the one worth finding.
            lineStyle: { width: dense ? 2.4 : 3.2, color: colour, type: "dashed" as const },
            itemStyle: { color: colour },
            emphasis: { scale: 2.4 },
            z: 5,
          },
        ];
      }),
      ...weatherSeries,
    ],
  };

  // ---------- Hourly drill-down ----------
  const anyHourly = selected.map((k) => hourlyByModel[k]).find(Boolean);
  const hourLabels = Array.from({ length: 24 }, (_, h) => fmtHour(h));
  const hasActualHours = Boolean(anyHourly?.hours.some((h) => h.actual != null));

  const hourlyWeatherSeries: Record<string, unknown>[] = (showWeather && anyHourly) ? [
    {
      name: "Rainfall (mm)",
      type: "bar",
      yAxisIndex: 1,
      data: anyHourly.hours.map((h) => h.rainfall != null ? h.rainfall : null),
      barMaxWidth: 16,
      z: 2,
      itemStyle: {
        color: "rgba(56, 189, 248, 0.35)",
        borderColor: "#0284c7",
        borderWidth: 1,
        borderRadius: [3, 3, 0, 0],
      },
    },
    {
      name: "Temperature (\u00B0C)",
      type: "line",
      yAxisIndex: 2,
      data: anyHourly.hours.map((h) => h.temperature != null ? h.temperature : null),
      smooth: true,
      connectNulls: true,
      symbol: "circle",
      symbolSize: 4,
      lineStyle: { width: 2, color: "#f97316", type: "dashed" as const },
      itemStyle: { color: "#f97316" },
      z: 2,
    },
  ] : [];

  const hourlyOption: EChartsOption | null = anyHourly
    ? {
        grid: { left: 80, right: showWeather ? 80 : 24, top: 28, bottom: 84 },
        tooltip: {
          trigger: "axis",
          formatter: (params: unknown) => {
            const items = params as { name: string; marker: string; seriesName: string; value: number | null }[];
            let tip = `<b>${items[0].name}</b><br/>`;
            items.forEach((p) => {
              if (p.value != null) {
                if (p.seriesName === "Rainfall (mm)") {
                  tip += `${p.marker} ${p.seriesName}: <b>${Number(p.value).toFixed(1)} mm</b><br/>`;
                } else if (p.seriesName === "Temperature (\u00B0C)") {
                  tip += `${p.marker} ${p.seriesName}: <b>${Number(p.value).toFixed(1)}\u00B0C</b><br/>`;
                } else {
                  tip += `${p.marker} ${p.seriesName}: <b>${fmtVeh(Number(p.value))}</b><br/>`;
                }
              }
            });
            return tip;
          },
        },
        legend: {
          data: [
            ...(hasActualHours ? ["Actual Volume"] : []),
            ...selected.filter((k) => hourlyByModel[k]?.hours.some((h) => h.predicted != null)).map((k) => `${metricsMeta[k].label} Prediction`),
            ...(showWeather ? ["Rainfall (mm)", "Temperature (\u00B0C)"] : []),
          ],
          bottom: 0,
          icon: "circle",
          itemGap: 16,
          textStyle: { fontSize: 12 },
        },
        xAxis: {
          type: "category",
          data: hourLabels,
          axisLabel: { color: "var(--text-secondary)", interval: 1, rotate: 45 },
          axisLine: { lineStyle: { color: "var(--border-strong)" } },
        },
        yAxis: [
          {
            type: "value",
            name: "Vehicle Volume",
            nameLocation: "middle",
            nameGap: 60,
            axisLabel: { color: "var(--text-secondary)", formatter: (val: number) => `${(val / 1000).toFixed(0)}k` },
            splitLine: { lineStyle: { color: "var(--border-default)", type: "dashed" } },
          },
          {
            type: "value",
            name: showWeather ? "Rainfall (mm)" : "",
            nameLocation: "middle",
            nameGap: 50,
            nameTextStyle: { color: "#0284c7", fontSize: 11, fontWeight: "bold" },
            position: "right",
            axisLabel: { show: showWeather, color: "#0284c7", formatter: (val: number) => `${val.toFixed(0)}` },
            axisLine: { show: showWeather, lineStyle: { color: "#0284c7" } },
            splitLine: { show: false },
            min: 0,
            max: (value: { max: number }) => Math.max(Math.ceil(value.max * 2.5), 10),
          },
          {
            type: "value",
            show: false,
            min: 15,
            max: 45,
          },
        ],
        series: [
          ...(hasActualHours
            ? [
                {
                  name: "Actual Volume",
                  type: "bar" as const,
                  yAxisIndex: 0,
                  data: anyHourly.hours.map((h) => h.actual),
                  itemStyle: { color: ACTUAL_COLOR, borderRadius: [4, 4, 0, 0] as [number, number, number, number] },
                  barMaxWidth: 26,
                  z: 1,
                },
              ]
            : []),
          ...selected
            .filter((k) => hourlyByModel[k]?.hours.some((h) => h.predicted != null))
            .map((k) => ({
              name: `${metricsMeta[k].label} Prediction`,
              type: "line" as const,
              yAxisIndex: 0,
              data: hourlyByModel[k]!.hours.map((h) => h.predicted),
              smooth: true,
              symbol: "circle",
              symbolSize: 5,
              z: 3,
              lineStyle: { width: 2.2, color: metricsMeta[k].color },
              itemStyle: { color: metricsMeta[k].color },
            })),
          ...hourlyWeatherSeries,
        ],
      }
    : null;

  if (drillDate) {
    return (
      <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "18px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ fontSize: "1.05rem", color: "var(--text-primary)", fontWeight: 700, margin: 0, letterSpacing: "-0.01em", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              Hourly Breakdown — {drillLabel}
              {anyHourly && (
                <span style={{ fontSize: "0.8rem", padding: "2px 8px", background: "var(--border-default)", color: "var(--text-secondary)", borderRadius: "12px", fontWeight: 600 }}>
                  {anyHourly.weekday}
                </span>
              )}
              {anyHourly?.isFuture && (
                <span style={{ fontSize: "0.8rem", padding: "2px 8px", background: "var(--color-success-bg)", color: "var(--color-success)", borderRadius: "12px", fontWeight: 600 }}>
                  Forecast
                </span>
              )}
            </h3>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.82rem", margin: "4px 0 0 0", maxWidth: "80ch" }}>
              {anyHourly?.profileSource === "weekday-profile"
                ? `No hourly ground truth exists for a future date — each model's daily total is distributed over the typical ${anyHourly.weekday} shape from the last 90 days.`
                : "Observed hourly volume for this day, with each model's daily prediction distributed across the same shape."}
            </p>
            {weather !== "all" && (
              <p style={{ color: anyHourly && anyHourly.observedHours === 0 ? "var(--color-warning)" : "var(--text-secondary)", fontSize: "0.78rem", margin: "4px 0 0 0" }}>
                {anyHourly && anyHourly.observedHours === 0
                  ? `No ${weather} hours recorded for this date — weather data only covers up to 1 Jul 2026. Bars are hidden; the model curve is unaffected.`
                  : `Showing ${weather} hours only (${anyHourly?.observedHours ?? 0} of 24). The models carry no weather dimension, so their curves are unfiltered.`}
              </p>
            )}
          </div>
          <button
            onClick={closeDrill}
            style={{
              display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 14px", borderRadius: "8px",
              border: "1px solid #cbd5e1", background: "var(--bg-surface)", color: "var(--text-primary)",
              fontSize: "0.85rem", fontWeight: 600, cursor: "pointer", flex: "none",
            }}
          >
            ← Back to daily
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {modelToolbar}
          <button
            onClick={() => setShowWeather(!showWeather)}
            style={{
              display: "inline-flex", alignItems: "center", gap: "6px", padding: "5px 14px",
              borderRadius: "999px", border: "1px solid #dce2ef",
              fontSize: "0.76rem", fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
              background: showWeather ? "linear-gradient(135deg, #38bdf8, #0ea5e9)" : "var(--bg-surface, #fff)",
              color: showWeather ? "var(--bg-surface)" : "var(--text-secondary, #4b5e7d)",
              boxShadow: showWeather ? "0 1px 6px rgba(56,189,248,0.35)" : "none",
            }}
          >
            {showWeather ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ marginRight: 2 }}>
                <path d="M12 2v2m0 16v2M4 12H2m20 0h-2m-2.93-7.07l-1.41 1.41m-9.32 9.32l-1.41 1.41m0-12.14l1.41 1.41m9.32 9.32l1.41 1.41M17 12a5 5 0 11-10 0 5 5 0 0110 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ marginRight: 2 }}>
                <path d="M12 2v2m0 16v2M4 12H2m20 0h-2" stroke="currentColor" strokeWidth="2" />
                <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
              </svg>
            )}
            Weather
          </button>
        </div>

        {hourlyLoading && !anyHourly ? (
          <div style={{ height: "420px", display: "grid", placeItems: "center", color: "var(--text-secondary)" }}>Loading hourly breakdown…</div>
        ) : hourlyError ? (
          <div style={{ height: "420px", display: "grid", placeItems: "center", color: "var(--color-danger)" }}>{hourlyError}</div>
        ) : hourlyOption ? (
          <div style={{ height: "420px", width: "100%" }}>
            <DashboardChart option={hourlyOption} height={420} />
          </div>
        ) : null}

        {anyHourly && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
            <div style={{ background: "var(--bg-surface-hover)", padding: "12px 14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>Day Actual</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>{anyHourly.dayActual != null ? fmtVeh(anyHourly.dayActual) : "—"}</div>
            </div>
            {selected.map((k) => {
              const h = hourlyByModel[k];
              return (
                <div key={k} style={{ background: "var(--bg-surface-hover)", padding: "12px 14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                  <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>{metricsMeta[k].label} Predicted</div>
                  <div style={{ fontSize: "1.1rem", fontWeight: 700, color: metricsMeta[k].color }}>{h?.dayPredicted != null ? fmtVeh(h.dayPredicted) : "—"}</div>
                </div>
              );
            })}
            <div style={{ background: "var(--bg-surface-hover)", padding: "12px 14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>Peak Hour</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>{extremeLabel(anyHourly.hours, "max")}</div>
            </div>
            <div style={{ background: "var(--bg-surface-hover)", padding: "12px 14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>Quietest Hour</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>{extremeLabel(anyHourly.hours, "min")}</div>
            </div>
          </div>
        )}
      </article>
    );
  }

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "18px" }}>
      {/* Title and model chips share one row and only stack when the card is
          too narrow to hold both. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
        <div style={{ minWidth: "260px" }}>
          <h3 style={{ fontSize: "1.05rem", color: "var(--text-primary)", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
            Traffic Volume Walk-Forward Forecast
          </h3>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
            Click any point to view that day&apos;s hourly breakdown · Toggle models to overlay predictions
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {modelToolbar}
          <button
            onClick={() => setShowWeather(!showWeather)}
            style={{
              display: "inline-flex", alignItems: "center", gap: "6px", padding: "5px 14px",
              borderRadius: "999px", border: "1px solid #dce2ef",
              fontSize: "0.76rem", fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
              background: showWeather ? "linear-gradient(135deg, #38bdf8, #0ea5e9)" : "var(--bg-surface, #fff)",
              color: showWeather ? "var(--bg-surface)" : "var(--text-secondary, #4b5e7d)",
              boxShadow: showWeather ? "0 1px 6px rgba(56,189,248,0.35)" : "none",
            }}
          >
            {showWeather ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ marginRight: 2 }}>
                <path d="M12 2v2m0 16v2M4 12H2m20 0h-2m-2.93-7.07l-1.41 1.41m-9.32 9.32l-1.41 1.41m0-12.14l1.41 1.41m9.32 9.32l1.41 1.41M17 12a5 5 0 11-10 0 5 5 0 0110 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ marginRight: 2 }}>
                <path d="M12 2v2m0 16v2M4 12H2m20 0h-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
              </svg>
            )}
            Weather
          </button>
        </div>
      </div>

      {/* Zone window & Granularity controls */}
      <div style={{
        display: "flex", alignItems: "center", gap: "20px", flexWrap: "wrap",
        padding: "10px 14px", borderRadius: "10px", background: "var(--bg-surface-hover)",
        border: "1px solid var(--border-default)", fontSize: "0.76rem",
      }}>
        {/* GRANULARITY control pill */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
          <b style={{ color: "#3b82f6", letterSpacing: "0.04em", fontSize: "0.75rem", textTransform: "uppercase" }}>
            GRANULARITY
          </b>
          <div style={{
            display: "inline-flex", alignItems: "center", padding: "2px",
            borderRadius: "999px", background: "var(--bg-surface)", border: "1px solid #dce2ef",
          }}>
            {/* Hourly (grayed out) */}
            <span
              title="Click any daily point on the chart to view 24-hour hourly breakdown"
              style={{
                padding: "3px 10px", borderRadius: "999px", color: "var(--text-muted)",
                fontWeight: 600, fontSize: "0.72rem", cursor: "not-allowed", opacity: 0.5,
              }}
            >
              Hourly
            </span>
            {(["Daily", "Weekly", "Monthly"] as const).map((g) => (
              <button
                key={g}
                onClick={() => {
                  /* The window no longer depends on granularity: it is sized
                     from the holdout where `lo` is computed, so every view
                     shows the same split in the same proportion. */
                  setGranularity(g);
                }}
                title={
                  g === "Daily"
                    ? "One point per day — the resolution the models actually forecast"
                    : `Averaged per ${g.replace("ly", "").toLowerCase()} — a viewing aid, not a separate forecast`
                }
                style={{
                  padding: "3px 10px", borderRadius: "999px", cursor: "pointer", border: "none",
                  background: "transparent",
                  color: granularity === g ? "#3876f5" : "var(--text-secondary)",
                  fontWeight: granularity === g ? 700 : 600, fontSize: "0.72rem",
                }}
              >
                {granularity === g ? `✓ ${g}` : g}
              </button>
            ))}
          </div>
        </span>

        {/* Past */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(37,99,235,0.25)" }} />
          <b style={{ color: "var(--text-primary)" }}>Past</b>
        </span>

        {/* Present */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(249,115,22,0.35)" }} />
          <b style={{ color: "var(--text-primary)" }}>Present</b>
          <span style={{ color: "var(--text-secondary)" }}>
            {chartData.futureStart - chartData.holdoutStart}d scored · fixed by evaluation
          </span>
        </span>

        {/* Future */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(22,163,74,0.3)" }} />
          <b style={{ color: "var(--text-primary)" }}>Future</b>
          {[
            { label: "2 wk", d: 14 },
            { label: "1 mo", d: 28 },
          ].map((item) => (
            <button key={item.label} onClick={() => setFutureDays(item.d)}
              disabled={item.d > chartData.dates.length - chartData.futureStart}
              style={{
                padding: "3px 10px", borderRadius: "999px",
                cursor: item.d > chartData.dates.length - chartData.futureStart ? "not-allowed" : "pointer",
                border: futureDays === item.d ? "1px solid #16a34a" : "1px solid #dce2ef",
                background: futureDays === item.d ? "#16a34a" : "var(--bg-surface)",
                color: futureDays === item.d ? "var(--bg-surface)" : "var(--text-secondary)", fontWeight: 600, fontSize: "0.72rem",
                opacity: item.d > chartData.dates.length - chartData.futureStart ? 0.4 : 1,
              }}>{item.label}</button>
          ))}
          <span style={{ color: "var(--text-secondary)" }}>· validated at 14d</span>
        </span>
      </div>

      <div style={{ height: "450px", width: "100%", cursor: "pointer" }}>
        <DashboardChart option={dailyOption} height={450} onEvents={{ click: onChartClick as (p: never) => void }} />
      </div>

      {/* Without this key the rainfall bars are anonymous blue blocks — a reader
          has no way to tell a drizzle from a storm, or why they should care. */}
      {showWeather && (
        <div style={{
          display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap",
          padding: "10px 14px", borderRadius: "10px", background: "var(--bg-surface-hover)",
          border: "1px solid var(--border-default)", fontSize: "0.75rem", color: "var(--text-secondary)",
        }}>
          <span style={{ fontWeight: 700, color: "var(--text-primary)" }}>Daily rainfall</span>
          {RAIN_BANDS.map((b, i) => (
            <span key={b.label} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <span style={{
                width: 14, height: 10, borderRadius: 2, background: b.color,
                border: "1px solid rgba(2,132,199,0.5)", display: "inline-block",
              }} />
              {b.label}
              <span style={{ color: "var(--text-muted)" }}>
                {i === 0 ? `< ${b.max} mm`
                  : b.max === Infinity ? `≥ ${RAIN_BANDS[i - 1].max} mm`
                  : `${RAIN_BANDS[i - 1].max}–${b.max} mm`}
              </span>
            </span>
          ))}
          <span style={{ color: "var(--text-secondary)", borderLeft: "1px solid var(--border-default)", paddingLeft: "14px" }}>
            Taller bar = wetter day. Heavy rain typically coincides with lower traffic volume.
          </span>
        </div>
      )}

      {/* Answers "why is only rainfall plotted?" with the numbers for all four. */}
      {showWeather && <WeatherEvidencePanel plotted="total_rain" />}

      {metricsTable}

      {/* Narrative is composed from the same rows that feed the table above, so the
          prose can never drift away from the numbers beside it. Window bounds come
          from the scored rows themselves rather than from a constant. */}
      <ModelNarrative
        selected={selected}
        metrics={rawMetrics}
        showWeather={showWeather}
        scoredDays={chartData ? chartData.futureStart - chartData.holdoutStart : null}
        windowStart={chartData ? chartData.isoDates[chartData.holdoutStart] ?? null : null}
        windowEnd={chartData ? chartData.isoDates[chartData.futureStart - 1] ?? null : null}
        horizonDays={VALIDATED_HORIZON}
      />
    </article>
  );
}
