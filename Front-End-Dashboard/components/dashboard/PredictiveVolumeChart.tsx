"use client";

import { useCallback, useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";

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
const MODELS: ModelMeta[] = [
  { key: "LSTM", label: "LSTM", note: "Rank #1", accepted: true, color: "#16a34a", rmse: "2,475", mae: "1,931", wmape: "3.85%", r2: "0.9911" },
  { key: "Prophet", label: "Prophet", note: "Rank #2", accepted: true, color: "#f59e0b", rmse: "4,378", mae: "3,432", wmape: "6.84%", r2: "0.9725" },
  { key: "HoltWinters", label: "Holt-Winters", note: "Rejected", accepted: false, color: "#8b5cf6", rmse: "312,178", mae: "264,098", wmape: "34.10%", r2: "-0.5590" },
  { key: "SARIMAX", label: "SARIMAX", note: "Rejected", accepted: false, color: "#ef4444", rmse: "485,700", mae: "421,761", wmape: "64.97%", r2: "-1.2412" },
  { key: "HoltsLinear", label: "Holts Linear", note: "Rejected", accepted: false, color: "#db2777", rmse: "612,210", mae: "539,351", wmape: "76.45%", r2: "-2.8960" },
];

const META = Object.fromEntries(MODELS.map((m) => [m.key, m])) as Record<ModelType, ModelMeta>;
const ACTUAL_COLOR = "#2563eb";

// The API hands back a DATE column that pg has already localised, so read the
// calendar parts back out in local time to recover the original YYYY-MM-DD.
const toIsoDate = (value: string) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const fmtVeh = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);

type HourlyPoint = { hour: number; actual: number | null; predicted: number | null };
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
  is_holdout: boolean;
  is_future: boolean;
};

type ChartData = {
  dates: string[];
  isoDates: string[];
  baseActual: (number | null)[];
  models: Record<ModelType, (number | null)[]>;
  holdoutStart: number;
  futureStart: number;
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
  const [metricsMeta, setMetricsMeta] = useState<Record<ModelType, ModelMeta>>(META);
  const [showAllMetrics, setShowAllMetrics] = useState(false);

  // Drill-down: which day is expanded to its 24-hour breakdown
  const [drillDate, setDrillDate] = useState<string | null>(null);
  const [hourlyByModel, setHourlyByModel] = useState<Partial<Record<ModelType, HourlyForecast>>>({});
  const [hourlyLoading, setHourlyLoading] = useState(false);
  const [hourlyError, setHourlyError] = useState<string | null>(null);

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
          qs.set("months", months);
        }
        const res = await fetch(`http://localhost:4000/api/traffic/forecast?${qs}`);
        const json = await res.json();
        if (cancelled || !json.success || !json.data.volumes) return;

        const rows = json.data.volumes as ForecastRow[];
        const models: Record<ModelType, (number | null)[]> = {
          LSTM: [], Prophet: [], HoltWinters: [], SARIMAX: [], HoltsLinear: [],
        };

        rows.forEach((v) => {
          models.LSTM.push(v.pred_lstm);
          models.Prophet.push(v.pred_prophet);
          models.HoltWinters.push(v.pred_holtwinters);
          models.SARIMAX.push(v.pred_sarimax);
          models.HoltsLinear.push(v.pred_holts_linear);
        });

        // Zone boundaries come from the data itself — hardcoded indices break
        // the moment the walk-forward window is re-run with a different split.
        const holdoutStart = rows.findIndex((v) => v.is_holdout);
                const futureStart = rows.findIndex((v) => v.is_future);

        if (json.data.metrics) {
          setMetricsMeta(prev => {
            const next = { ...prev };
            json.data.metrics.forEach((dbM: any) => {
              const key = dbM.model_name === 'Holt-Winters' ? 'HoltWinters' :
                          dbM.model_name === 'Holts_Linear' ? 'HoltsLinear' :
                          dbM.model_name;
              if (next[key as ModelType]) {
                next[key as ModelType] = {
                  ...next[key as ModelType],
                  rmse: Math.round(dbM.rmse).toLocaleString("en-US"),
                  mae: Math.round(dbM.mae).toLocaleString("en-US"),
                  wmape: dbM.wmape.toFixed(2) + "%",
                  r2: dbM.r2.toFixed(4),
                  mape: dbM.mape != null ? dbM.mape.toFixed(2) + "%" : "—",
                  smape: dbM.smape != null ? dbM.smape.toFixed(2) + "%" : "—",
                  mase: dbM.mase != null ? dbM.mase.toFixed(4) : "—",
                  rmsse: dbM.rmsse != null ? dbM.rmsse.toFixed(4) : "—",
                  adjusted_r2: dbM.adjusted_r2 != null ? dbM.adjusted_r2 : "—",
                  mse: dbM.mse != null ? Math.round(dbM.mse).toLocaleString("en-US") : "—",
                  train_r2: dbM.train_r2 != null ? dbM.train_r2.toFixed(4) : "—",
                  val_r2: dbM.val_r2 != null ? dbM.val_r2.toFixed(4) : "—",
                  gap: dbM.r2_gap != null ? dbM.r2_gap.toFixed(4) : "—",
                  diagnosis: dbM.diagnosis || "—",
                  note: dbM.accepted ? `Rank #${dbM.rank}` : "Rejected",
                  accepted: dbM.accepted
                };
              }
            });
            return next;
          });
        }

        setChartData({
          dates: rows.map((v) => new Date(v.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })),
          isoDates: rows.map((v) => toIsoDate(v.date)),
          baseActual: rows.map((v) => v.actual_volume),
          models,
          holdoutStart: holdoutStart === -1 ? rows.length : holdoutStart,
          futureStart: futureStart === -1 ? rows.length : futureStart,
        });
      } catch (err) {
        console.error("Failed to fetch ML forecast", err);
      }
    }
    fetchData();
    return () => {
      cancelled = true;
    };
  }, [months, from, to]);

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
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "#94a3b8", flex: "none" }}>
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
          background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef", borderRadius: "999px",
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
                color: on ? "#fff" : "var(--text-secondary, #4b5e7d)",
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
    <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "16px", border: "1px solid #e2e8f0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <h4 style={{ margin: "0", fontSize: "0.95rem", color: "#334155", fontWeight: 600 }}>
          Real-World ML Validation Metrics
        </h4>
        <button
          onClick={() => setShowAllMetrics(!showAllMetrics)}
          style={{
            display: "inline-flex", alignItems: "center", gap: "6px", padding: "4px 10px", borderRadius: "6px",
            background: showAllMetrics ? "#e2e8f0" : "#fff", border: "1px solid #cbd5e1",
            color: "#475569", fontSize: "0.75rem", fontWeight: 600, cursor: "pointer", transition: "all 0.15s"
          }}
        >
          {showAllMetrics ? "Show Less" : "Show All Metrics"}
        </button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", minWidth: showAllMetrics ? "1000px" : "520px" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#64748b", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              <th style={{ padding: "6px 10px", fontWeight: 600 }}>Model</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>RMSE (veh)</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MAE (veh)</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>WMAPE</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>R² Score</th>
              {showAllMetrics && (
                <>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MAPE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>sMAPE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MASE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>RMSSE</th>
                                    <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Adj R²</th>
                                  </>
              )}
            </tr>
          </thead>
          <tbody>
            {MODELS.map(baseM => metricsMeta[baseM.key]).filter((m) => selected.includes(m.key)).map((m) => (
              <tr key={m.key} style={{ background: "#fff", borderTop: "1px solid #e2e8f0" }}>
                <td style={{ padding: "10px", fontWeight: 700, color: "#0f172a" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: m.color }} />
                    {m.label}
                    <span style={{ fontSize: "0.72rem", fontWeight: 500, color: m.accepted ? "#15803d" : "#b91c1c" }}>{m.note}</span>
                  </span>
                </td>
                <td style={{ padding: "10px", textAlign: "right", color: "#0f172a" }}>{m.rmse}</td>
                <td style={{ padding: "10px", textAlign: "right", color: "#0f172a" }}>{m.mae}</td>
                <td style={{ padding: "10px", textAlign: "right", fontWeight: 700, color: m.color }}>{m.wmape}</td>
                <td style={{ padding: "10px", textAlign: "right", fontWeight: 700, color: m.color }}>{m.r2}</td>
                {showAllMetrics && (
                  <>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.mape ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.smape ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.mase ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.rmsse ?? "—"}</td>
                                        <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.adjusted_r2 ?? "—"}</td>
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
        <div style={{ color: "#64748b" }}>Loading ML forecast from AWS…</div>
      </article>
    );
  }

  const { dates, isoDates, baseActual, models, holdoutStart, futureStart } = chartData;
  const drillIndex = drillDate ? isoDates.indexOf(drillDate) : -1;
  const drillLabel = drillIndex >= 0 ? dates[drillIndex] : drillDate ?? "";

  // Clicking a point (or its x-axis label) opens that day's hourly breakdown
  const openDay = (index: number) => {
    if (index >= 0 && index < isoDates.length) setDrillDate(isoDates[index]);
  };
  const onChartClick = (params: { componentType?: string; dataIndex?: number; value?: string }) => {
    if (params.componentType === "xAxis") return openDay(dates.indexOf(String(params.value)));
    if (typeof params.dataIndex === "number") openDay(params.dataIndex);
  };

  const zoneLabel = (text: string) => ({
    show: true,
    position: "insideTop" as const,
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: 600 as const,
    formatter: text,
  });

  const dailyOption: EChartsOption = {
    grid: { left: 80, right: 24, top: 28, bottom: 76 },
    tooltip: {
      trigger: "axis",
      formatter: (params: unknown) => {
        const items = params as { name: string; marker: string; seriesName: string; value: number | null }[];
        let tip = `<b>${items[0].name}</b><br/>`;
        items.forEach((p) => {
          if (p.value != null) tip += `${p.marker} ${p.seriesName}: <b>${fmtVeh(Number(p.value))}</b><br/>`;
        });
        return `${tip}<span style="color:#94a3b8;font-size:11px">Click to view hourly</span>`;
      },
    },
    legend: {
      data: ["Actual Volume", ...selected.map((k) => `${metricsMeta[k].label} Prediction`)],
      bottom: 0,
      icon: "circle",
      itemGap: 16,
      textStyle: { fontSize: 12 },
    },
    xAxis: {
      type: "category",
      data: dates,
      // Labels are click targets too — a wider hit area than the line symbols
      triggerEvent: true,
      axisLabel: { color: "#64748b" },
      axisLine: { lineStyle: { color: "#cbd5e1" } },
    },
    yAxis: {
      type: "value",
      name: "Total Vehicle Volume",
      nameLocation: "middle",
      nameGap: 60,
      axisLabel: { color: "#64748b", formatter: (val: number) => `${(val / 1000).toFixed(0)}k` },
      splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
      scale: true,
    },
    series: [
      {
        name: "Actual Volume",
        type: "line",
        data: baseActual,
        smooth: true,
        connectNulls: true,
        symbol: "circle",
        symbolSize: 5,
        z: 3,
        lineStyle: { width: 2.5, color: ACTUAL_COLOR },
        itemStyle: { color: ACTUAL_COLOR },
        emphasis: { scale: 2.2 },
        // Zones ride on the ground-truth series so they stay put no matter
        // which models are toggled on.
        markArea: {
          silent: true,
          data: [
            [{ xAxis: dates[0], itemStyle: { color: "rgba(37, 99, 235, 0.05)" }, label: zoneLabel("Past") }, { xAxis: dates[Math.max(holdoutStart - 1, 0)] }],
            [{ xAxis: dates[holdoutStart], itemStyle: { color: "rgba(249, 115, 22, 0.08)" }, label: zoneLabel("Present") }, { xAxis: dates[Math.max(futureStart - 1, 0)] }],
            [{ xAxis: dates[futureStart], itemStyle: { color: "rgba(22, 163, 74, 0.08)" }, label: zoneLabel("Future") }, { xAxis: dates[dates.length - 1] }],
          ],
        },
        markLine: {
          silent: true,
          symbol: "none",
          label: { show: false },
          lineStyle: { type: "dashed", color: "#94a3b8" },
          data: [{ xAxis: dates[holdoutStart] }, { xAxis: dates[futureStart] }],
        },
      },
      ...selected.map((key) => ({
        name: `${metricsMeta[key].label} Prediction`,
        type: "line" as const,
        data: models[key],
        smooth: true,
        connectNulls: true,
        symbol: "circle",
        symbolSize: 5,
        lineStyle: { width: 2.2, color: metricsMeta[key].color },
        itemStyle: { color: metricsMeta[key].color },
        emphasis: { scale: 2.2 },
      })),
    ],
  };

  // ---------- Hourly drill-down ----------
  const anyHourly = selected.map((k) => hourlyByModel[k]).find(Boolean);
  const hourLabels = Array.from({ length: 24 }, (_, h) => fmtHour(h));
  const hasActualHours = Boolean(anyHourly?.hours.some((h) => h.actual != null));

  const hourlyOption: EChartsOption | null = anyHourly
    ? {
        grid: { left: 80, right: 24, top: 28, bottom: 84 },
        tooltip: {
          trigger: "axis",
          formatter: (params: unknown) => {
            const items = params as { name: string; marker: string; seriesName: string; value: number | null }[];
            let tip = `<b>${items[0].name}</b><br/>`;
            items.forEach((p) => {
              if (p.value != null) tip += `${p.marker} ${p.seriesName}: <b>${fmtVeh(Number(p.value))}</b><br/>`;
            });
            return tip;
          },
        },
        legend: {
          data: [
            ...(hasActualHours ? ["Actual Volume"] : []),
            ...selected.filter((k) => hourlyByModel[k]?.hours.some((h) => h.predicted != null)).map((k) => `${metricsMeta[k].label} Prediction`),
          ],
          bottom: 0,
          icon: "circle",
          itemGap: 16,
          textStyle: { fontSize: 12 },
        },
        xAxis: {
          type: "category",
          data: hourLabels,
          axisLabel: { color: "#64748b", interval: 1, rotate: 45 },
          axisLine: { lineStyle: { color: "#cbd5e1" } },
        },
        yAxis: {
          type: "value",
          name: "Vehicle Volume",
          nameLocation: "middle",
          nameGap: 60,
          axisLabel: { color: "#64748b", formatter: (val: number) => `${(val / 1000).toFixed(0)}k` },
          splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
        },
        series: [
          ...(hasActualHours
            ? [
                {
                  name: "Actual Volume",
                  type: "bar" as const,
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
              data: hourlyByModel[k]!.hours.map((h) => h.predicted),
              smooth: true,
              symbol: "circle",
              symbolSize: 5,
              z: 2,
              lineStyle: { width: 2.2, color: metricsMeta[k].color },
              itemStyle: { color: metricsMeta[k].color },
            })),
        ],
      }
    : null;

  if (drillDate) {
    return (
      <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "18px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              Hourly Breakdown — {drillLabel}
              {anyHourly && (
                <span style={{ fontSize: "0.8rem", padding: "2px 8px", background: "#e2e8f0", color: "#475569", borderRadius: "12px", fontWeight: 600 }}>
                  {anyHourly.weekday}
                </span>
              )}
              {anyHourly?.isFuture && (
                <span style={{ fontSize: "0.8rem", padding: "2px 8px", background: "#dcfce7", color: "#15803d", borderRadius: "12px", fontWeight: 600 }}>
                  Forecast
                </span>
              )}
            </h3>
            <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 0 0", maxWidth: "80ch" }}>
              {anyHourly?.profileSource === "weekday-profile"
                ? `No hourly ground truth exists for a future date — each model's daily total is distributed over the typical ${anyHourly.weekday} shape from the last 90 days.`
                : "Observed hourly volume for this day, with each model's daily prediction distributed across the same shape."}
            </p>
            {weather !== "all" && (
              <p style={{ color: anyHourly && anyHourly.observedHours === 0 ? "#b45309" : "#64748b", fontSize: "0.78rem", margin: "4px 0 0 0" }}>
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
              border: "1px solid #cbd5e1", background: "#fff", color: "#334155",
              fontSize: "0.85rem", fontWeight: 600, cursor: "pointer", flex: "none",
            }}
          >
            ← Back to daily
          </button>
        </div>

        {modelToolbar}

        {hourlyLoading && !anyHourly ? (
          <div style={{ height: "420px", display: "grid", placeItems: "center", color: "#64748b" }}>Loading hourly breakdown…</div>
        ) : hourlyError ? (
          <div style={{ height: "420px", display: "grid", placeItems: "center", color: "#b91c1c" }}>{hourlyError}</div>
        ) : hourlyOption ? (
          <div style={{ height: "420px", width: "100%" }}>
            <DashboardChart option={hourlyOption} height={420} />
          </div>
        ) : null}

        {anyHourly && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
            <div style={{ background: "#f8fafc", padding: "12px 14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.72rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>Day Actual</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>{anyHourly.dayActual != null ? fmtVeh(anyHourly.dayActual) : "—"}</div>
            </div>
            {selected.map((k) => {
              const h = hourlyByModel[k];
              return (
                <div key={k} style={{ background: "#f8fafc", padding: "12px 14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                  <div style={{ fontSize: "0.72rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>{metricsMeta[k].label} Predicted</div>
                  <div style={{ fontSize: "1.1rem", fontWeight: 700, color: metricsMeta[k].color }}>{h?.dayPredicted != null ? fmtVeh(h.dayPredicted) : "—"}</div>
                </div>
              );
            })}
            <div style={{ background: "#f8fafc", padding: "12px 14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.72rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>Peak Hour</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>{extremeLabel(anyHourly.hours, "max")}</div>
            </div>
            <div style={{ background: "#f8fafc", padding: "12px 14px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.72rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>Quietest Hour</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#0f172a" }}>{extremeLabel(anyHourly.hours, "min")}</div>
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
          <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
            Traffic Volume Walk-Forward Forecast
          </h3>
          <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
            Click any point to view that day&apos;s hourly breakdown · Toggle models to overlay predictions
          </p>
        </div>
        {modelToolbar}
      </div>

      <div style={{ height: "450px", width: "100%", cursor: "pointer" }}>
        <DashboardChart option={dailyOption} height={450} onEvents={{ click: onChartClick as (p: never) => void }} />
      </div>

      {metricsTable}
    </article>
  );
}
