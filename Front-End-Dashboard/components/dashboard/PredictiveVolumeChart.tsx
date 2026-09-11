"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import ModelNarrative, { type MetricRow } from "./ModelNarrative";
import { aggregateSeries } from "./aggregateSeries";
import { useThemeTokens, zoneTints } from "./useThemeTokens";
import WeatherEvidencePanel, { EvidenceHeading } from "./WeatherEvidencePanel";
import { BarChart3, ShieldCheck, ChevronRight } from "lucide-react";

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
/**
 * Chronological split arm served by this dashboard.
 *
 * Both arms remain in the warehouse under gold.*.split_label and the 90/10 run is
 * documented in the evaluation report; only 80/20 is SHOWN. Its 294-day scored
 * window spans Mar-Dec, whereas 90/10's 140 days cover Aug-Dec alone, failing the
 * manuscript's own condition (p86) that the test set still cover "a sufficiently
 * diverse time frame". Re-scoring the 80/20 predictions on the 90/10 window
 * reproduces 90/10's figures exactly, so that arm's better numbers come from an
 * easier window rather than a better split.
 *
 * Sent explicitly rather than left to the backend default, so a change to
 * DEFAULT_SPLIT there cannot silently swap what this chart displays.
 */
const SPLIT_ARM = "80_20";

const ACTUAL_COLOR = "#2563eb";

// Same pattern the other dashboard pages use. The literal URL was refactored out
// of this file but the constant was never declared here, so every fetch threw a
// ReferenceError, was swallowed by the catch, and the chart sat on "Loading…".
const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";
const VALIDATED_HORIZON = 14; // must match retrain_honest.py HORIZON

type HorizonBucket = {
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
};
// Show every stored training day. The blue line is meant to BE the trained
// dataset, and only at full width do the 80/20 proportions read correctly.
const ALL_PAST = 100000;

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
  /** True split sizes over the WHOLE table. The rows above are trimmed to the
   *  selected range, so holdoutStart is "past days drawn", not "days trained". */
  split: SplitSummary | null;
};

type SplitSummary = {
  trainDays: number;
  holdoutDays: number;
  futureDays: number;
  trainStart: string | null;
  trainEnd: string | null;
  trainPct: number | null;
  holdoutPct: number | null;
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
  /* Several models can be on screen at once; the list never empties so the
     chart always has something to compare the ground truth against.

     Which one it OPENS on is decided once the forecast arrives, below. It was
     hardcoded to LSTM -- the model the pipeline rejects. On the current
     retrain LSTM is rank 7 of 8 at MASE 1.653, meaning its forecast is worse
     than repeating last week's values, while Prophet is the only accepted
     model at MASE 0.969. Opening on LSTM put the weakest candidate in front of
     every reader who never touched the buttons, and disagreed with the
     Prescriptive tab, which plans against the accepted champion. LSTM stays
     selectable: being outperformed is a finding worth showing. */
  const [selected, setSelected] = useState<ModelType[]>(["LSTM"]);
  const [apiChampion, setApiChampion] = useState<string | null>(null);
  // Set once the reader picks a model, so a late fetch cannot override a
  // deliberate choice.
  const modelChosenByUser = useRef(false);
  const [chartData, setChartData] = useState<ChartData | null>(null);
  // Raw metric rows, kept unmodified so the narrative can read fields the
  // metrics TABLE does not display (rejected_reason, aic/bic, the _nw twins).
  const [rawMetrics, setRawMetrics] = useState<MetricRow[]>([]);
  // Error as a function of how far ahead a day is. Served from
  // gold.ml_horizon_accuracy, measured by a rolling-origin run at h=90 — NOT
  // extrapolated from the h=14 headline figure.
  const [horizonAcc, setHorizonAcc] = useState<HorizonBucket[]>([]);
  const [showAllMetrics, setShowAllMetrics] = useState(false);
  const [showWeather, setShowWeather] = useState(true);

  // How much of each zone to display, in days. These trim the view only — the
  // scored window and the forecast horizon are fixed by the model run, so
  // narrowing PAST here can never change a metric.
  //
  // Granularity & zone window controls
  const [granularity, setGranularity] = useState<"Hourly" | "Daily" | "Weekly" | "Monthly" | "Yearly">("Weekly");
  // ECharts needs literal colours, so the CSS tokens are resolved at runtime.
  const T = useThemeTokens();
  const ZONE = zoneTints(T.isDark);

  const [pastDays, setPastDays] = useState<number>(ALL_PAST);
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

  /* Open on whatever the API calls champion, mapped back to this chart's key.
     If the name does not map -- an unknown model, or no accepted model in the
     run -- the existing selection stands rather than guessing. */
  useEffect(() => {
    if (modelChosenByUser.current || !apiChampion) return;
    const key = apiChampion.toLowerCase().replace(/[^a-z]/g, "");
    const BY_DB: Record<string, ModelType> = {
      prophet: "Prophet", holtwinters: "HoltWinters", sarimax: "SARIMAX",
      lstm: "LSTM", holtslinear: "HoltsLinear",
    };
    const match = BY_DB[key];
    if (match) setSelected([match]);
  }, [apiChampion]);

  const toggleModel = useCallback((key: ModelType) => {
    modelChosenByUser.current = true;
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
          qs.set("months", months);
        }
        // Which evaluation arm to serve. Both are stored in the warehouse and
        // the whole panel — chart, metrics table, split chips — follows this.
        qs.set("split", SPLIT_ARM);
        if (weather && weather !== "all") {
          qs.set("weather", weather);
        }
        const res = await fetch(`${BACKEND}/api/traffic/forecast?${qs}`);
        const json = await res.json();
        if (cancelled || !json.success || !json.data?.volumes) return;

        /* The API names the champion from the same metrics table this chart
           renders. Capturing it here means the chart opens on the model the
           Prescriptive panels plan against -- they read championModel off this
           very payload -- instead of the two sides picking independently and
           drifting apart after a retrain. */
        setApiChampion(typeof json.data.championModel === "string" ? json.data.championModel : null);

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
        if (Array.isArray(json.data.horizonAccuracy)) {
          setHorizonAcc(json.data.horizonAccuracy as HorizonBucket[]);
        }

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
          split: (json?.data?.split ?? null) as SplitSummary | null,
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
  // The bucket the LAST projected day falls in — the weakest point of the
  // chosen window, which is the honest one to quote.
  const horizonBucketFor = (days: number): HorizonBucket | null =>
    horizonAcc.find((b) => days >= b.hLo && days <= b.hHi) ??
    (horizonAcc.length ? horizonAcc[horizonAcc.length - 1] : null);

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
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <EvidenceHeading icon={<BarChart3 size={14} strokeWidth={2.4} />} tint="#2563eb" title="Held-out accuracy">
          <InfoTooltip text="Scored on the Present zone: real daily counts the model never trained on. WMAPE is the headline error; MASE below 1 beats repeating last week's pattern. Show more adds the secondary error measures." />
        </EvidenceHeading>
        <button
          onClick={() => setShowAllMetrics(!showAllMetrics)}
          style={{ padding: 0, border: 0, background: "transparent", cursor: "pointer", fontSize: "0.74rem", fontWeight: 600, color: "var(--text-secondary)" }}
        >
          {showAllMetrics ? "Fewer columns" : "More columns"}
        </button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem", minWidth: showAllMetrics ? 820 : 520 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              <th style={{ padding: "6px 8px", fontWeight: 700 }}>Model</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>WMAPE</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }} title="Error relative to repeating last week. Below 1.0 beats it.">MASE</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>MAE (veh)</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>RMSE (veh)</th>
              <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>R²</th>
              {showAllMetrics && (
                <>
                  <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>MAPE</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>sMAPE</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>RMSSE</th>
                  <th style={{ padding: "6px 8px", fontWeight: 700, textAlign: "right" }}>Adj R²</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {MODELS.map(baseM => metricsMeta[baseM.key]).filter((m) => selected.includes(m.key)).map((m) => (
              <tr key={m.key} style={{ borderTop: "1px solid var(--border-default)" }}>
                <td style={{ padding: "8px", fontWeight: 700, color: "var(--text-primary)" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 9, height: 9, borderRadius: "50%", background: m.color }} />
                    {m.label}
                    <span style={{ fontSize: "0.7rem", fontWeight: 600, color: m.accepted ? "var(--color-success)" : "var(--color-danger)" }}>{m.note}</span>
                  </span>
                </td>
                <td style={{ padding: "8px", textAlign: "right", fontWeight: 700, color: m.color, fontVariantNumeric: "tabular-nums" }}>{m.wmape}</td>
                <td style={{ padding: "8px", textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums",
                  color: m.mase && m.mase !== "—" ? (parseFloat(m.mase) < 1 ? "var(--color-success)" : "var(--color-danger)") : "var(--text-secondary)" }}>
                  {m.mase ?? "—"}
                </td>
                <td style={{ padding: "8px", textAlign: "right", color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{m.mae}</td>
                <td style={{ padding: "8px", textAlign: "right", color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{m.rmse}</td>
                <td style={{ padding: "8px", textAlign: "right", color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{m.r2}</td>
                {showAllMetrics && (
                  <>
                    <td style={{ padding: "8px", textAlign: "right", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>{m.mape ?? "—"}</td>
                    <td style={{ padding: "8px", textAlign: "right", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>{m.smape ?? "—"}</td>
                    <td style={{ padding: "8px", textAlign: "right", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>{m.rmsse ?? "—"}</td>
                    <td style={{ padding: "8px", textAlign: "right", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>{m.adjusted_r2 ?? "—"}</td>
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
  const lo = Math.max(0, chartData.holdoutStart - pastDays);
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

  // Rainfall bars are sky-blue and the actual line was also blue, so two unrelated
  // quantities shared a hue. Actual moves to a neutral slate that reads as
  // "observation" against the saturated model colours.
  const actualColor = T.isDark ? "#cbd5e1" : "#334155";
  const rainfall = agg ? agg.rainfall : dailyRain;
  // Bar HEIGHT is the bucket mean; bar COLOUR comes from the bucket's wettest
  // day. The band thresholds are PAGASA DAILY advisories, so colouring by a
  // weekly mean described an intensity no day necessarily reached: over
  // 2022-2025, 60.6% of weeks fell in a different band from their wettest day,
  // and 6.3% were painted below "Heavy" while containing a day above 30 mm.
  // At Daily granularity the two arrays are identical.
  const rainfallPeak = agg ? agg.rainfallPeak : dailyRain;
  const models = agg ? agg.models : dailyModels;
  const holdoutStart = agg ? agg.holdoutStart : dailyHoldoutStart;
  const futureStart = agg ? agg.futureStart : dailyFutureStart;
  const isAggregated = agg != null;

  // Every aggregated value on this chart is a MEAN of its days, never a total.
  // Naming that once here keeps the axis titles, the banner and the rainfall
  // caption consistent — "per period" told the reader nothing about which
  // period or which statistic.
  const bucketDays = granularity === "Weekly" ? 7 : granularity === "Monthly" ? 30 : 1;
  const meanLabel =
    granularity === "Weekly" ? "7-day mean"
    : granularity === "Monthly" ? "monthly mean"
    : "";
  const bucketNoun = granularity === "Weekly" ? "week" : granularity === "Monthly" ? "month" : "day";
  const drillIndex = drillDate ? isoDates.indexOf(drillDate) : -1;
  const drillLabel = drillIndex >= 0 ? dates[drillIndex] : drillDate ?? "";

  // Holt-Winters and Holts Linear are univariate (no weather variant). Their line
  // is identical whether Weather is on or off, so showing it while Weather is ON
  // would falsely imply a weather-aware prediction — suppress it instead.
  const visibleModels = showWeather
    ? selected.filter((k) => k !== "HoltWinters" && k !== "HoltsLinear")
    : selected;

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
      data: rainfall.map((mm, i) =>
        mm == null ? null : {
          value: mm,
          itemStyle: { color: rainBand(rainfallPeak[i] ?? mm).color },
        }
      ),
      barMaxWidth: 16,
      z: 2,
      itemStyle: { borderRadius: [3, 3, 0, 0] },
    },
  ] : [];

  // Only worth spending a second label line on the year when the window actually
  // crosses one — at the 80/20 split it usually does, at "3 mo" it usually doesn't.
  //
  // Ticks are snapped to MONTH BOUNDARIES, not strided by index. The old version
  // labelled every ceil(n/12)-th data point, which put dates on arbitrary days
  // ("Feb 21, Mar 28, May 2" — a 35-day stride aligned with nothing) and, worse,
  // reshuffled the entire axis whenever granularity changed, because the point
  // count changed with it. Month starts exist at the same calendar positions in
  // Daily, Weekly and Monthly, so the axis now holds still when you toggle.
  const labelIndices = (() => {
    const n = dates.length;
    const keep = new Set<number>();
    if (n === 0) return keep;

    // First index of each calendar month present in the window.
    const monthStarts: number[] = [];
    let prevYm = "";
    for (let i = 0; i < n; i++) {
      const ym = isoDates[i]?.slice(0, 7) ?? "";
      if (ym && ym !== prevYm) {
        monthStarts.push(i);
        prevYm = ym;
      }
    }

    // Thin to ~12 ticks: monthly, else quarterly, half-yearly and so on.
    if (monthStarts.length > 0) {
      const step = monthStarts.length <= 12 ? 1 : Math.ceil(monthStarts.length / 12);
      for (let i = 0; i < monthStarts.length; i += step) keep.add(monthStarts[i]);
    } else {
      // A window too short to contain a month boundary would otherwise render a
      // bare axis, so fall back to the old index stride.
      const stride = Math.max(1, Math.ceil(n / 12));
      for (let i = 0; i < n; i += stride) keep.add(i);
    }

    // The forecast block must be dated at both ends. Previously a fixed stride
    // left it undated entirely: at 594 points the last tick landed on index 550
    // while the forecast began at 566.
    const mustLabel = [futureStart, n - 1].filter((i) => i >= 0 && i < n);
    const mustSet = new Set(mustLabel);
    const minGap = Math.max(2, Math.floor(n / 24));
    for (const m of mustLabel) {
      // Only thin the regular ticks. Guarding mustSet matters because the start
      // and end of the forecast sit close together, and without it the second
      // forced label silently deleted the first.
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
        let tip = `<b>${items[0].name}</b>${isAggregated ? ` · ${meanLabel} (average of the ${bucketNoun}'s days)` : ""}<br/>`;
        items.forEach((p) => {
          if (p.value != null) {
            if (p.seriesName === "Rainfall (mm)") {
              const mm = Number(p.value);
              {
                // Aggregated: give the mean AND the day that set the colour,
                // so the tooltip can never contradict the bar it describes.
                const pk = rainfallPeak[(p as { dataIndex?: number }).dataIndex ?? -1];
                tip += isAggregated && pk != null
                  ? `${p.marker} Rainfall: <b>${mm.toFixed(1)} mm/day</b> mean, wettest day <b>${pk.toFixed(1)} mm</b> - ${rainBand(pk).label}<br/>`
                  : `${p.marker} Rainfall: <b>${mm.toFixed(1)} mm</b> \u00B7 ${rainBand(mm).label}<br/>`;
              }
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
    graphic: isAggregated
      ? [{
          type: "text", right: 18, top: 8, silent: true,
          style: {
            text: `every point = ${meanLabel}`,
            fontSize: 11, fontWeight: 600, fill: T.textMuted,
          },
        }]
      : [],
    legend: {
      data: [
        "Actual Volume",
        ...visibleModels.map((k) => `${metricsMeta[k].label} Prediction`),
        ...(showWeather ? ["Rainfall (mm)"] : []),
      ],
      bottom: 0,
      icon: "circle",
      itemGap: 16,
      textStyle: { fontSize: 12, color: T.chartText },
      // Names the statistic on every series in the place readers actually look.
      // Formatter is display-only: the underlying seriesName values still drive
      // tooltip matching and the click-to-drill handler, so renaming them here
      // cannot break either.
      formatter: (name: string) => (isAggregated ? `${name}  · ${meanLabel}` : name),
    },
    dataZoom: [
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
        name: isAggregated ? `Avg daily volume — ${meanLabel}` : "Total Vehicle Volume",
        nameLocation: "middle",
        nameGap: 60,
        axisLabel: { color: T.chartText, formatter: (val: number) => `${(val / 1000).toFixed(0)}k` },
        splitLine: { lineStyle: { color: T.chartSplit, type: "dashed" } },
        scale: true,
      },
      {
        type: "value",
        name: showWeather ? (isAggregated ? `Avg daily rainfall, mm — ${meanLabel}` : "Daily rainfall (mm)") : "",
        nameLocation: "middle",
        nameGap: 50,
        nameTextStyle: { color: T.isDark ? "#38bdf8" : "#0284c7", fontSize: 11, fontWeight: "bold" },
        position: "right",
        axisLabel: { show: showWeather, color: T.isDark ? "#38bdf8" : "#0284c7", formatter: (val: number) => `${val.toFixed(0)}` },
        axisLine: { show: showWeather, lineStyle: { color: T.isDark ? "#38bdf8" : "#0284c7" } },
        splitLine: { show: false },
        min: 0,
        // Headroom of 1.2 let the wettest day draw a bar across ~83% of the plot,
        // so rainfall crossed straight through the volume lines and dominated a
        // chart that is primarily about volume. At 4x the bars stay inside the
        // bottom quarter and read as a weather strip under the series. The axis
        // is still truthful — only the headroom changed, not the values.
        max: (value: { max: number }) => Math.ceil(value.max * 4) || 10,
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
        // Dark slate at full weight — this is the treatment that made the series
        // legible. Still thinner at daily density, where ~880 points would
        // otherwise fuse into a solid block.
        lineStyle: { width: dates.length > 400 ? 1.6 : 2.6, color: actualColor },
        itemStyle: { color: actualColor },
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
              // Period dividers (W1/W3/… or M1/M3/…) are on by request; flip
              // the constant to hide them.
              const SHOW_PERIOD_DIVIDERS = true;
              const periods = !SHOW_PERIOD_DIVIDERS ? []
                : granularity === "Weekly" ? weeklyPeriods.map((w) => ({ at: w.start, tag: `W${w.weekNum}` }))
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
      ...visibleModels.map((key) => ({
        name: `${metricsMeta[key].label} Prediction`,
        type: "line" as const,
        yAxisIndex: 0,
        data: models[key],
        smooth: true,
        connectNulls: true,
        symbol: "circle",
        symbolSize: 5,
        lineStyle: { width: dates.length > 400 ? 1.2 : 2.2, color: metricsMeta[key].color },
        itemStyle: { color: metricsMeta[key].color },
        emphasis: { scale: 2.2 },
      })),
      ...weatherSeries,
    ],
  };

  // ---------- Hourly drill-down ----------
  const anyHourly = visibleModels.map((k) => hourlyByModel[k]).find(Boolean);
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
            ...visibleModels.filter((k) => hourlyByModel[k]?.hours.some((h) => h.predicted != null)).map((k) => `${metricsMeta[k].label} Prediction`),
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
          ...visibleModels
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
            {visibleModels.map((k) => {
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

  /* The finding, computed from the same series the chart draws: the model on
     screen, its average over the chosen future window, the busiest point in
     it, and the error measured AT THAT RANGE by the rolling-origin study
     rather than the headline 14-day figure. */
  const primary = (visibleModels[0] ?? selected[0]) as ModelType;
  const futVals = models[primary]
    .map((v, idx) => ({ v, idx }))
    .slice(futureStart)
    .filter((x): x is { v: number; idx: number } => x.v != null);
  const futAvg = futVals.length ? futVals.reduce((a, x) => a + x.v, 0) / futVals.length : null;
  const futPeak = futVals.length ? futVals.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  const rangeBucket = horizonBucketFor(futureDays);
  const rangeErr = rangeBucket?.wmape != null ? `${rangeBucket.wmape.toFixed(1)}%` : metricsMeta[primary].wmape;
  const primaryMeta = metricsMeta[primary];
  const futureAvailable = chartData.dates.length - chartData.futureStart;

  const pill = (on: boolean, colour: string) => ({
    padding: "3px 10px", borderRadius: "999px", cursor: "pointer", border: `1px solid ${on ? colour : "#dce2ef"}`,
    background: on ? colour : "var(--bg-surface)", color: on ? "var(--bg-surface)" : "var(--text-secondary)",
    fontWeight: 600, fontSize: "0.72rem", whiteSpace: "nowrap" as const,
  });
  const groupLabel: React.CSSProperties = {
    fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-muted)", whiteSpace: "nowrap",
  };

  /* Layout, top to bottom: what am I looking at -> the finding -> the controls,
     on one row -> what the chart shows (the three zones) -> the chart -> the
     evidence, behind one disclosure whose summary still states the validation
     figures. The previous card put four rows of controls and a banner that
     repeated the subtitle between the title and the chart, then four boxed
     panels of evidence between this forecast and the other two. */
  return (
    <article className="chart-card wide" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: "14px" }}>
      {/* Row 1 */}
      <div>
        <h3 style={{ fontSize: "1.05rem", color: "var(--text-primary)", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          Traffic Volume Walk-Forward Forecast
          <InfoTooltip text="Daily corridor volume: the model's past fit, its held-out test period against real counts, and the forecast ahead. Pick a model above; the champion is preselected." />
        </h3>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
          {isAggregated
            ? <>Every point is a <b>{meanLabel}</b> — the average of that {bucketNoun}&apos;s days, not a total.</>
            : <>One point per day. Click any point for that day&apos;s hourly breakdown.</>}
        </p>
      </div>

      {/* Row 2: the finding. */}
      {futAvg != null && (
        <div style={{
          padding: "12px 14px", borderRadius: "10px", fontSize: "0.88rem", lineHeight: 1.5,
          background: "rgba(22,163,74,0.07)", border: "1px solid rgba(22,163,74,0.25)", color: "var(--text-primary)",
        }}>
          <b>Next {futureDays} days</b> · <b>{fmtVeh(futAvg)}</b> vehicles/day on average
          {futPeak && <> · peak {isAggregated ? bucketNoun : "day"} <b>{dates[futPeak.idx]}</b> ({fmtVeh(futPeak.v)})</>}
          {" "}· typical error <b>{rangeErr}</b>
          {primaryMeta.accepted ? "" : <span style={{ color: "var(--color-danger)" }}> · failed acceptance, shown for comparison</span>}
        </div>
      )}

      {/* Row 3: controls, one row. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px 20px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {modelToolbar}
          <button
            onClick={() => setShowWeather(!showWeather)}
            title={showWeather ? "Showing the weather-aware forecasts and rainfall bars" : "Showing the weather-free forecasts"}
            style={{
              display: "inline-flex", alignItems: "center", gap: "6px", padding: "5px 14px", borderRadius: "999px",
              border: "1px solid #dce2ef", fontSize: "0.76rem", fontWeight: 600, cursor: "pointer",
              background: showWeather ? "linear-gradient(135deg, #38bdf8, #0ea5e9)" : "var(--bg-surface, #fff)",
              color: showWeather ? "var(--bg-surface)" : "var(--text-secondary, #4b5e7d)",
            }}
          >
            Weather {showWeather ? "on" : "off"}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={groupLabel}>View</span>
            <span style={{ display: "inline-flex", padding: 2, borderRadius: 999, background: "var(--bg-surface)", border: "1px solid #dce2ef" }}>
              {(["Daily", "Weekly", "Monthly"] as const).map((g) => (
                <button key={g}
                  onClick={() => { setGranularity(g); setPastDays(g === "Daily" ? 90 : ALL_PAST); }}
                  title={g === "Daily" ? "One point per day — the resolution the models actually forecast" : `Averaged per ${g.replace("ly", "").toLowerCase()} — a viewing aid, not a separate forecast`}
                  style={{ padding: "3px 10px", borderRadius: 999, border: "none", background: granularity === g ? "#3876f5" : "transparent", color: granularity === g ? "#fff" : "var(--text-secondary)", fontWeight: 600, fontSize: "0.72rem", cursor: "pointer" }}>
                  {g}
                </button>
              ))}
            </span>
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={groupLabel}>Ahead</span>
            {[{ label: "2 wk", d: 14 }, { label: "1 mo", d: 28 }, { label: "2 mo", d: 60 }, { label: "3 mo", d: 90 }].map((item) => {
              const off = item.d > futureAvailable;
              return (
                <button key={item.label} onClick={() => setFutureDays(item.d)} disabled={off}
                  style={{ ...pill(futureDays === item.d, "#16a34a"), cursor: off ? "not-allowed" : "pointer", opacity: off ? 0.4 : 1 }}>
                  {item.label}
                </button>
              );
            })}
          </span>
        </div>
      </div>

      {/* Row 4: what the chart shows — the three zones, one slim line. */}
      <div style={{ display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap", fontSize: "0.74rem", color: "var(--text-secondary)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(37,99,235,0.25)" }} />
          <b style={{ color: "var(--text-primary)" }}>Past</b>
          trained · {chartData.holdoutStart.toLocaleString()}d shown
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(249,115,22,0.35)" }} />
          <b style={{ color: "var(--text-primary)" }}>Present</b>
          tested on real counts · {(chartData.futureStart - chartData.holdoutStart).toLocaleString()}d
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(22,163,74,0.3)" }} />
          <b style={{ color: "var(--text-primary)" }}>Future</b>
          forecast · {Math.min(futureDays, futureAvailable)}d
        </span>
      </div>

      {futureDays > VALIDATED_HORIZON && (
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 14px", borderRadius: 10,
          background: "rgba(249,115,22,0.08)", border: "1px solid rgba(249,115,22,0.28)",
          fontSize: "0.75rem", color: "var(--text-secondary)", lineHeight: 1.5,
        }}>
          <span style={{ fontSize: "0.9rem", lineHeight: 1 }}>⚠</span>
          <span>
            Beyond {VALIDATED_HORIZON} days only <b style={{ color: "var(--text-primary)" }}>{horizonAcc[0]?.model ?? "the accepted model"}</b> was
            measured, by a separate rolling-origin run at h={horizonAcc[horizonAcc.length - 1]?.hHi ?? 90}.
            {horizonAcc.length > 1 && (
              <> Error rises then flattens (d{horizonAcc[0].hLo}-{horizonAcc[0].hHi} {horizonAcc[0].wmape?.toFixed(2)}% → d{horizonAcc[horizonAcc.length - 1].hLo}-{horizonAcc[horizonAcc.length - 1].hHi} {horizonAcc[horizonAcc.length - 1].wmape?.toFixed(2)}% WMAPE)</>
            )}{" "}
            because it is structural — trend plus weekly and yearly seasonality — so it does not compound its own errors.{" "}
            {(() => {
              const b = horizonBucketFor(futureDays);
              return b?.mase != null && b.mase > 0.95 ? (
                <>At the {b.hLo}-{b.hHi} day range it clears the seasonal-naive benchmark by only <b style={{ color: "var(--color-warning)" }}>{(1 - b.mase).toFixed(3)} MASE</b>, so treat that stretch as indicative rather than reliable. </>
              ) : null;
            })()}
            The rejected models are still drawn if you toggle them, but nothing validates them at this range and{" "}
            <b style={{ color: "var(--text-primary)" }}>SARIMAX collapses to implausible values</b> past a few weeks. Weather across the projection is day-of-year climatology, not a forecast.
          </span>
        </div>
      )}

      {/* Row 5: the chart. */}
      <div style={{ height: "450px", width: "100%", cursor: isAggregated ? "default" : "pointer" }}>
        <DashboardChart option={dailyOption} height={450} onEvents={{ click: onChartClick as (p: never) => void }} />
      </div>

      {/* Rainfall key, one muted line under the bars it explains. */}
      {showWeather && (
        <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap", fontSize: "0.72rem", color: "var(--text-secondary)" }}>
          <span style={{ fontWeight: 700, color: "var(--text-primary)" }} title={isAggregated ? `Bar height is the ${bucketNoun}'s mean rainfall; bar colour is its wettest single day.` : "Taller bar = wetter day."}>Rainfall</span>
          {RAIN_BANDS.map((b, i) => (
            <span key={b.label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 12, height: 9, borderRadius: 2, background: b.color, border: "1px solid rgba(2,132,199,0.5)", display: "inline-block" }} />
              {b.label} <span style={{ color: "var(--text-muted)" }}>{i === 0 ? `< ${b.max} mm` : b.max === Infinity ? `≥ ${RAIN_BANDS[i - 1].max} mm` : `${RAIN_BANDS[i - 1].max}–${b.max} mm`}</span>
            </span>
          ))}
        </div>
      )}

      {/* Row 6: the model narrative and its AI explanation. This stays in the
          open -- the "explain" control is the way an operator asks what the
          figures mean, and a control nobody can see is not a control. The raw
          evidence (weather panel, metrics table) is what goes behind the
          disclosure below. */}
      <div style={{ borderTop: "1px solid var(--border-default)", paddingTop: 10 }}>
        <ModelNarrative
          selected={selected}
          metrics={rawMetrics}
          showWeather={showWeather}
          scoredDays={chartData ? chartData.futureStart - chartData.holdoutStart : null}
          windowStart={chartData ? chartData.isoDates[chartData.holdoutStart] ?? null : null}
          windowEnd={chartData ? chartData.isoDates[chartData.futureStart - 1] ?? null : null}
          horizonDays={VALIDATED_HORIZON}
        />
      </div>

      {/* Row 7: the evidence, behind one disclosure. The summary states the
          validation figures so they stay visible without opening it. */}
      <details style={{ fontSize: "0.78rem", color: "var(--text-secondary)", borderTop: "1px solid var(--border-default)", paddingTop: 10 }}>
        <summary
          className="evidence-summary"
          style={{ cursor: "pointer", listStyle: "none", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}
        >
          <span style={{
            display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: 8,
            background: "color-mix(in srgb, var(--color-success) 14%, transparent)", color: "var(--color-success)", flex: "none",
          }}>
            <ShieldCheck size={16} strokeWidth={2.4} />
          </span>
          <span style={{ fontSize: "0.98rem", fontWeight: 800, letterSpacing: "-0.01em", color: "var(--text-primary)" }}>
            Validation evidence
          </span>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 999,
            background: "var(--bg-surface-hover)", border: "1px solid var(--border-default)",
            fontSize: "0.74rem", fontWeight: 600, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums",
          }}>
            {primaryMeta.label} · WMAPE {primaryMeta.wmape} · MASE {primaryMeta.mase ?? "—"}
          </span>
          <span className="evidence-chevron" style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, fontSize: "0.74rem", fontWeight: 600, color: "var(--text-secondary)" }}>
            <span className="evidence-open-label">Show</span>
            <span className="evidence-close-label">Hide</span>
            <ChevronRight size={15} strokeWidth={2.4} />
          </span>
        </summary>
        <div style={{ display: "grid", gap: 16, marginTop: 12 }}>
          {metricsTable}
          {showWeather && (
            <div style={{ borderTop: "1px solid var(--border-default)", paddingTop: 14 }}>
              <WeatherEvidencePanel plotted="total_rain" />
            </div>
          )}
        </div>
      </details>
    </article>
  );
}
