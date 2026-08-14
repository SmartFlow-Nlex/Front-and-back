"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { EChartsOption } from "echarts";
import { AlertTriangle } from "lucide-react";
import DashboardChart from "../../../../components/dashboard/DashboardChart";
import PageHeader from "../../../../components/dashboard/PageHeader";
import styles from "../../traffic/traffic.module.css";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Same seven models, same labels, same hues as the daily forecast chart
// (PredictiveIncidentChart) — a model must not change colour between the chart
// you clicked and the chart you land on. This is the incident model set, which
// is not the traffic one: no Prophet, no Holt-Winters.
type ModelKey =
  | "XGBoost"
  | "RandomForest"
  | "Poisson_GLM"
  | "NegBinomial_GLM"
  | "SARIMAX"
  | "LSTM"
  | "GRU";

const MODELS: { key: ModelKey; label: string; color: string }[] = [
  { key: "XGBoost", label: "XGBoost", color: "#16a34a" },
  { key: "RandomForest", label: "Random Forest", color: "#f59e0b" },
  { key: "Poisson_GLM", label: "Poisson GLM", color: "#8b5cf6" },
  { key: "NegBinomial_GLM", label: "Neg. Binomial GLM", color: "#0891b2" },
  { key: "SARIMAX", label: "SARIMAX", color: "#ef4444" },
  { key: "LSTM", label: "LSTM", color: "#db2777" },
  { key: "GRU", label: "GRU", color: "#64748b" },
];
const META = Object.fromEntries(MODELS.map((m) => [m.key, m])) as Record<ModelKey, (typeof MODELS)[number]>;

const ACTUAL_COLOR = "#2563eb";
const RAIN_COLOR = "#38bdf8";
const TEMP_COLOR = "#f97316";
// Wet hours are shaded behind the bars rather than recolouring them: a bar's
// height is its incident count, and if its colour also carried the weather then
// a tall wet bar and a tall dry bar would stop being comparable at a glance.
const WET_BAND = "rgba(56, 189, 248, 0.14)";

type WeatherFilter = "all" | "dry" | "wet";

type HourPoint = {
  hour: number;
  rainfallMm: number | null;
  temperatureC: number | null;
  isWet: boolean | null;
  road: number;
  moto: number;
  stalled: number;
  total: number;
};

type ModelSeries = {
  key: ModelKey;
  dayPredicted: number | null;
  isChampion: boolean;
  hours: (number | null)[];
};

type HourlyData = {
  date: string;
  weekday: string;
  // "train" = in-sample fitted values for a past day. This page shows them
  // (that is why they exist), labelled as fitted rather than forecast.
  predictionType: "train" | "validation" | "future" | null;
  isFuture: boolean;
  championModel: ModelKey | null;
  profileSource: "observed" | "weekday-profile" | null;
  dayActual: number;
  models: ModelSeries[];
  hours: HourPoint[];
  sourceCoverage: Record<"road" | "moto" | "stalled", { lastLogged: string | null; covered: boolean }>;
  hasIncidentLog: boolean;
  weather: { hoursRecorded: number; wetHours: number; dryHours: number; totalRainfallMm: number; threshold: number };
  totals: { all: number; wet: number; dry: number; unknownWeather: number };
};

const SOURCE_LABEL: Record<"road" | "moto" | "stalled", string> = {
  road: "Road crashes",
  moto: "Motorcycle crashes",
  stalled: "Stalled vehicles",
};

const CHIPS: { key: WeatherFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "dry", label: "Dry" },
  { key: "wet", label: "Wet" },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);
const fmtShortDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function HourlyIncidentContent() {
  // The day arrives as ?date=YYYY-MM-DD rather than a path segment: the app is
  // built with `output: 'export'` (next.config.mjs) for the Electron desktop
  // bundle, and a dynamic [date] segment under static export would require
  // generateStaticParams() to enumerate every date at build time.
  const searchParams = useSearchParams();
  const date = searchParams.get("date");
  const validDate = typeof date === "string" && DATE_RE.test(date);

  // The daily chart's Range/Weather selection rides along in the URL so going
  // back restores the exact view you drilled from, instead of resetting to the
  // default 12-month window.
  const months = searchParams.get("months");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const weatherParam = searchParams.get("weather");

  const [data, setData] = useState<HourlyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherFilter>(
    weatherParam === "dry" || weatherParam === "wet" ? weatherParam : "all"
  );
  const [selected, setSelected] = useState<ModelKey[]>([]);
  const [showWeatherOverlay, setShowWeatherOverlay] = useState(true);

  const backHref = useMemo(() => {
    const qs = new URLSearchParams({ tab: "Predictive" });
    if (months) qs.set("months", months);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (weatherParam) qs.set("weather", weatherParam);
    return `/dashboard/incident?${qs}`;
  }, [months, from, to, weatherParam]);

  useEffect(() => {
    if (!validDate) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`${BACKEND}/api/incident/hourly?date=${date}`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        const payload = json.data as HourlyData;
        setData(payload);
        // Open on the champion, matching the daily chart's default, but only
        // among models that actually have a prediction for this day.
        const withPrediction = payload.models.filter((m) => m.dayPredicted != null).map((m) => m.key);
        setSelected(
          withPrediction.length === 0
            ? []
            : [withPrediction.find((k) => k === payload.championModel) ?? withPrediction[0]]
        );
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load hourly breakdown");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [date, validDate]);

  const toggleModel = useCallback((key: ModelKey) => {
    setSelected((prev) => {
      if (!prev.includes(key)) return MODELS.filter((m) => m.key === key || prev.includes(m.key)).map((m) => m.key);
      if (prev.length === 1) return prev; // keep at least one curve on the chart
      return prev.filter((k) => k !== key);
    });
  }, []);

  const backLink = (
    <Link href={backHref} className={styles.secondaryButton}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Back to daily
    </Link>
  );

  if (!validDate) {
    return (
      <section className={styles.page}>
        <PageHeader icon={AlertTriangle} title="Hourly Breakdown" subtitle="No day selected" actions={backLink} />
        <div className={styles.spanFull}>
          <article className={styles.chartCard}>
            <div className={styles.placeholder}>
              {date
                ? `“${date}” is not a valid date — expected YYYY-MM-DD.`
                : "Open this page by clicking a day on the incident forecast chart."}
            </div>
          </article>
        </div>
      </section>
    );
  }

  // An hour survives the filter only when its weather is known and matches.
  // Unknown-weather hours drop out of both Dry and Wet rather than defaulting
  // into one — the backend reports them separately for the same reason.
  const passes = (h: HourPoint) => (weather === "all" ? true : h.isWet === (weather === "wet"));

  const missingSources = data
    ? (Object.keys(data.sourceCoverage) as ("road" | "moto" | "stalled")[]).filter((k) => !data.sourceCoverage[k].covered)
    : [];

  const modelsWithPrediction = data?.models.filter((m) => m.dayPredicted != null) ?? [];
  const activeModels = selected.filter((k) => modelsWithPrediction.some((m) => m.key === k));
  const hasActualBars = Boolean(data && data.hours.some((h) => passes(h) && h.total > 0));

  const option: EChartsOption | null = !data
    ? null
    : {
        grid: { left: 64, right: showWeatherOverlay ? 64 : 24, top: 30, bottom: 76 },
        legend: {
          data: [
            "Actual Incidents",
            ...activeModels.map((k) => `${META[k].label} Prediction`),
            ...(showWeatherOverlay ? ["Rainfall (mm)", "Temperature (°C)"] : []),
          ],
          bottom: 0,
          icon: "circle",
          itemGap: 16,
          textStyle: { fontSize: 12 },
        },
        tooltip: {
          trigger: "axis",
          formatter: (p: unknown) => {
            const items = p as { dataIndex: number; marker: string; seriesName: string; value: number | null }[];
            const h = data.hours[items[0]?.dataIndex ?? 0];
            if (!h) return "";
            const wetLabel = h.isWet === null ? "no reading" : h.isWet ? "wet hour" : "dry hour";
            let tip = `<b>${fmtHour(h.hour)}</b> <span style="color:#94a3b8">(${wetLabel})</span><br/>`;
            items.forEach((it) => {
              if (it.value == null) return;
              const unit =
                it.seriesName === "Rainfall (mm)" ? " mm" : it.seriesName === "Temperature (°C)" ? " °C" : "";
              tip += `${it.marker} ${it.seriesName}: <b>${it.value}${unit}</b><br/>`;
            });
            if (passes(h) && h.total > 0) {
              tip += `<span style="color:#94a3b8;font-size:11px">Road ${h.road} · Moto ${h.moto} · Stalled ${h.stalled}</span>`;
            }
            return tip;
          },
        },
        xAxis: {
          type: "category",
          data: data.hours.map((h) => fmtHour(h.hour)),
          axisLabel: { color: "#64748b", fontSize: 10, interval: 1, rotate: 45 },
          axisLine: { lineStyle: { color: "#cbd5e1" } },
          axisTick: { show: false },
        },
        yAxis: [
          {
            type: "value",
            name: "Incidents",
            nameLocation: "middle",
            nameGap: 42,
            nameTextStyle: { fontSize: 11, color: "#64748b" },
            min: 0,
            minInterval: 1,
            axisLabel: { color: "#64748b", fontSize: 11 },
            splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
          },
          {
            type: "value",
            name: "Rainfall (mm) / Temp (°C)",
            nameLocation: "middle",
            nameGap: 46,
            nameTextStyle: { fontSize: 10, color: RAIN_COLOR },
            min: 0,
            position: "right",
            show: showWeatherOverlay,
            axisLabel: { color: RAIN_COLOR, fontSize: 11 },
            splitLine: { show: false },
          },
        ],
        series: [
          {
            name: "Actual Incidents",
            type: "bar",
            // null, not 0 — a filtered-out hour has no bar at all, which reads
            // differently from an hour that genuinely had zero incidents.
            data: data.hours.map((h) => (passes(h) ? h.total : null)),
            barMaxWidth: 22,
            itemStyle: { color: ACTUAL_COLOR, borderRadius: [4, 4, 0, 0] },
            z: 3,
            // Wet hours shaded from the real rainfall series, so the weather
            // stays legible even in the All view where nothing is filtered out.
            markArea: {
              silent: true,
              itemStyle: { color: WET_BAND },
              data: data.hours
                .filter((h) => h.isWet === true)
                .map((h) => [{ xAxis: h.hour - 0.5 }, { xAxis: h.hour + 0.5 }] as [{ xAxis: number }, { xAxis: number }]),
            },
          },
          ...activeModels.map((k) => ({
            name: `${META[k].label} Prediction`,
            type: "line" as const,
            data: data.models.find((m) => m.key === k)?.hours ?? [],
            smooth: true,
            symbol: "circle" as const,
            symbolSize: 5,
            connectNulls: true,
            z: 4,
            lineStyle: { width: 2.2, color: META[k].color },
            itemStyle: { color: META[k].color },
          })),
          ...(showWeatherOverlay
            ? [
                {
                  name: "Rainfall (mm)",
                  type: "bar" as const,
                  yAxisIndex: 1,
                  data: data.hours.map((h) => h.rainfallMm),
                  barMaxWidth: 10,
                  itemStyle: { color: RAIN_COLOR, opacity: 0.45 },
                  z: 1,
                },
                {
                  name: "Temperature (°C)",
                  type: "line" as const,
                  yAxisIndex: 1,
                  data: data.hours.map((h) => h.temperatureC),
                  smooth: true,
                  symbol: "none" as const,
                  connectNulls: false,
                  lineStyle: { width: 1.8, color: TEMP_COLOR, type: "dashed" as const },
                  itemStyle: { color: TEMP_COLOR },
                  z: 2,
                },
              ]
            : []),
        ],
      };

  // Peak / quietest are read off the hours actually on screen, so they answer
  // the question the chart is being read for rather than restating the day.
  const visibleHours = data?.hours.filter(passes) ?? [];
  const peak = visibleHours.reduce<HourPoint | null>((a, h) => (a == null || h.total > a.total ? h : a), null);
  const quiet = visibleHours.reduce<HourPoint | null>((a, h) => (a == null || h.total < a.total ? h : a), null);
  const shownTotal =
    data == null ? 0 : weather === "all" ? data.totals.all : weather === "wet" ? data.totals.wet : data.totals.dry;

  const tile = (label: string, value: string, hint: string, color?: string) => (
    <div style={{ background: "#f8fafc", padding: "12px 14px", borderRadius: 8, border: "1px solid #e2e8f0", minWidth: 0 }}>
      <div style={{ fontSize: "0.72rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: "1.1rem", fontWeight: 700, color: color ?? "#0f172a" }}>{value}</div>
      <div style={{ fontSize: "0.72rem", color: "#94a3b8", marginTop: 2 }}>{hint}</div>
    </div>
  );

  return (
    <section className={styles.page}>
      <PageHeader
        icon={AlertTriangle}
        title={`Hourly Breakdown — ${fmtShortDate(date)}`}
        subtitle={
          data
            ? data.profileSource === "weekday-profile"
              ? `No hourly ground truth exists for this date — each model's daily total is distributed over the typical ${data.weekday} shape from the last 90 days.`
              : "Observed hourly incidents for this day, with each model's daily prediction distributed over the typical shape for this weekday."
            : "Loading…"
        }
        actions={backLink}
      />

      {/* Weather slice — which hours count. Distinct from the Rain & Temp
          overlay below, which only controls what is drawn. */}
      <div className={styles.filterRow}>
        <div className={styles.filterGroup}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-muted)" }}>
            <path d="M4.5 11.5a3 3 0 1 1 .4-5.97 4 4 0 0 1 7.75 1.1A2.5 2.5 0 0 1 12 11.5H4.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M6 13.2v1M9 13.2v1M12 13.2v1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <span className={styles.filterLabel}>Weather</span>
          <div className={styles.segmented}>
            {CHIPS.map((c) => {
              // A chip that would show nothing is disabled rather than silently
              // emptying the chart — a day with no rain has no Wet hours, and
              // that is information, not a failure.
              const empty =
                data != null &&
                ((c.key === "wet" && data.weather.wetHours === 0) || (c.key === "dry" && data.weather.dryHours === 0));
              return (
                <button
                  key={c.key}
                  className={weather === c.key ? "active" : ""}
                  disabled={empty}
                  title={empty ? `No ${c.key} hours recorded on this day` : undefined}
                  onClick={() => setWeather(c.key)}
                >
                  {weather === c.key && (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}>
                      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>
        {data && (
          <span className={styles.kpiHint}>
            {data.weekday} · wet = rainfall &gt; {data.weather.threshold} mm/hr ·{" "}
            {data.predictionType === "train"
              ? "in-sample fitted"
              : data.predictionType === "validation"
                ? "walk-forward validation"
                : data.predictionType === "future"
                  ? "forecast"
                  : "no model prediction for this day"}
          </span>
        )}
        <span className={styles.spacer} />
      </div>

      <div className={styles.spanFull}>
        <article className={styles.chartCard}>
          {/* Model chips + overlay toggle, mirroring the daily chart's toolbar */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "#94a3b8", flex: "none" }}>
              <path d="M2 11.5l3.5-4 3 3L13.5 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M10.5 4h3v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={{ fontSize: "0.74rem", fontWeight: 700, color: "#4b5e7d", letterSpacing: "0.02em", whiteSpace: "nowrap" }}>
              Models
            </span>
            <div
              style={{
                display: "inline-flex", flexWrap: "wrap", gap: 2, padding: 3,
                background: "#fff", border: "1px solid #dce2ef", borderRadius: 999,
              }}
            >
              {MODELS.map((m) => {
                const available = modelsWithPrediction.some((x) => x.key === m.key);
                const on = activeModels.includes(m.key);
                const locked = on && activeModels.length === 1;
                return (
                  <button
                    key={m.key}
                    onClick={() => available && toggleModel(m.key)}
                    aria-pressed={on}
                    disabled={!available}
                    title={
                      !available
                        ? "No stored prediction for this day — the pipeline has not written a row for this date"
                        : locked
                          ? "At least one model must stay selected"
                          : `${on ? "Hide" : "Show"} ${m.label}`
                    }
                    style={{
                      display: "inline-flex", alignItems: "center", border: 0,
                      padding: "5px 12px", borderRadius: 999,
                      fontSize: "0.76rem", fontWeight: 600, whiteSpace: "nowrap",
                      cursor: !available ? "not-allowed" : locked ? "default" : "pointer",
                      transition: "all 0.15s",
                      background: on ? m.color : "transparent",
                      color: !available ? "#cbd5e1" : on ? "#fff" : "#4b5e7d",
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

            <button
              onClick={() => setShowWeatherOverlay((v) => !v)}
              aria-pressed={showWeatherOverlay}
              title="Overlay recorded rainfall and temperature"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "7px 14px", borderRadius: 999,
                fontSize: "0.76rem", fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer",
                background: showWeatherOverlay ? RAIN_COLOR : "transparent",
                color: showWeatherOverlay ? "#fff" : "#4b5e7d",
                border: showWeatherOverlay ? "1px solid transparent" : "1px solid #dce2ef",
                boxShadow: showWeatherOverlay ? `0 1px 4px ${RAIN_COLOR}55` : "none",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8 1.4v1.6M8 13v1.6M14.6 8H13M3 8H1.4M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1M12.7 12.7l-1.1-1.1M4.4 4.4L3.3 3.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Rain &amp; Temp
            </button>
          </div>

          {/* Absence of a log is stated, never drawn as zeros. */}
          {data && !data.hasIncidentLog && (
            <div
              style={{
                display: "flex", gap: 10, alignItems: "flex-start",
                background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10,
                padding: "10px 14px", margin: "0 0 14px", fontSize: "0.8rem", color: "#78350f",
              }}
            >
              <span style={{ flexShrink: 0 }}>⚠️</span>
              <span>
                No incident log covers this date — the operations log ends{" "}
                <b>{data.sourceCoverage.stalled.lastLogged ?? "earlier"}</b>. Weather and the model curves are shown;
                the absent bars mean <b>no data</b>, not zero incidents.
              </span>
            </div>
          )}

          {data && data.hasIncidentLog && missingSources.length > 0 && (
            <div
              style={{
                display: "flex", gap: 10, alignItems: "flex-start",
                background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10,
                padding: "10px 14px", margin: "0 0 14px", fontSize: "0.8rem", color: "#075985",
              }}
            >
              <span style={{ flexShrink: 0 }}>ℹ️</span>
              <span>
                Partial coverage: {missingSources.map((k) => SOURCE_LABEL[k]).join(" and ")}{" "}
                {missingSources.length === 1 ? "is" : "are"} not logged this far
                {missingSources.length === 1 && data.sourceCoverage[missingSources[0]].lastLogged
                  ? ` (ends ${data.sourceCoverage[missingSources[0]].lastLogged})`
                  : ""}
                . Bars include only the sources that are.
              </span>
            </div>
          )}

          <div className={styles.chartBody} style={{ minHeight: 420 }}>
            {loading && <div className={styles.placeholder}>Loading hourly breakdown…</div>}
            {error && <div className={styles.placeholder}>Hourly breakdown unavailable — {error}</div>}
            {!loading && !error && option && <DashboardChart option={option} height={420} />}
          </div>

          {data && (
            <div
              style={{
                display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                gap: 12, marginTop: 16,
              }}
            >
              {tile(
                weather === "all" ? "Day Actual" : `Actual (${weather})`,
                hasActualBars || data.hasIncidentLog ? String(shownTotal) : "—",
                data.hasIncidentLog ? "incidents logged" : "no log for this date"
              )}
              {activeModels.map((k) => {
                const m = data.models.find((x) => x.key === k);
                return (
                  <div key={k}>
                    {tile(
                      `${META[k].label} Predicted`,
                      m?.dayPredicted != null ? m.dayPredicted.toFixed(1) : "—",
                      m?.isChampion ? "daily total · champion" : "daily total",
                      META[k].color
                    )}
                  </div>
                );
              })}
              {tile(
                "Peak Hour",
                peak && peak.total > 0 ? fmtHour(peak.hour) : "—",
                peak && peak.total > 0 ? `${peak.total} incident${peak.total === 1 ? "" : "s"}` : "no incidents in view"
              )}
              {tile(
                "Quietest Hour",
                quiet && hasActualBars ? fmtHour(quiet.hour) : "—",
                quiet && hasActualBars ? `${quiet.total} incident${quiet.total === 1 ? "" : "s"}` : "no incidents in view"
              )}
              {tile("Rainfall", `${data.weather.totalRainfallMm} mm`, `${data.weather.wetHours} wet · ${data.weather.dryHours} dry hrs`)}
            </div>
          )}

          {data && data.totals.unknownWeather > 0 && (
            <p className={styles.kpiHint} style={{ marginTop: 10, whiteSpace: "normal" }}>
              {data.totals.unknownWeather} incident{data.totals.unknownWeather === 1 ? "" : "s"} fell in hours with no
              weather reading, so they appear under All but in neither Dry nor Wet.
            </p>
          )}

          {data && (
            <p className={styles.kpiHint} style={{ marginTop: 8, whiteSpace: "normal", lineHeight: 1.5 }}>
              Model curves are a <b>derived</b> hourly shape, not an hourly forecast: the pipeline predicts one total
              per day, spread here across the typical {data.weekday} profile. Weather is recorded observation from{" "}
              <code>hourly_weather</code> ({data.weather.hoursRecorded} of 24 hours reported), not forecast.
            </p>
          )}
        </article>
      </div>
    </section>
  );
}

// useSearchParams() forces this subtree to render client-side, which the static
// export requires be wrapped in a Suspense boundary — without it `next build`
// fails the page rather than warning.
export default function HourlyIncidentPage() {
  return (
    <Suspense
      fallback={
        <section className={styles.page}>
          <PageHeader icon={AlertTriangle} title="Hourly Breakdown" />
          <div className={styles.spanFull}>
            <article className={styles.chartCard}>
              <div className={styles.placeholder}>Loading…</div>
            </article>
          </div>
        </section>
      }
    >
      <HourlyIncidentContent />
    </Suspense>
  );
}
