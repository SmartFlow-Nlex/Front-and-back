"use client";

import { useEffect, useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import DashboardChart from "../../../components/dashboard/DashboardChart";
import PredictiveIncidentChart from "../../../components/dashboard/PredictiveIncidentChart";
import DateRangePicker from "../traffic/components/DateRangePicker";
import styles from "../traffic/traffic.module.css";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Categorical hues — one per incident source, fixed assignment
const BLUE = "#3e67ef"; // road crashes
const PURPLE = "#7c3aed"; // motorcycle crashes
const ORANGE = "#e06b47"; // stalled vehicles
// Sequential ramp (magnitude: heatmap, hotspot bar)
const SEQ = ["#eef2fb", "#8fa8ee", "#3e67ef", "#1d3aa8"];

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

const SOURCE_LABEL: Record<"road" | "moto" | "stalled", string> = {
  road: "Road crashes",
  moto: "Motorcycle crashes",
  stalled: "Stalled vehicles",
};

// ---------- Data contract ----------
type Analytics = {
  range: { from: string; to: string };
  meta: { minDate: string; maxDate: string };
  kpis: {
    totalIncidents: number;
    prevTotalIncidents: number;
    injuries: number;
    fatalities: number;
    avgResponseMin: number | null;
    rainyCrashes: number;
    weatherKnown: number;
  };
  dailyTrend: { d: string; road: number; moto: number; stalled: number }[];
  hotspots: { km_bin: number; total: number; road: number; moto: number; stalled: number; injuries: number; fatalities: number }[];
  heatmap: { dow: number; hour: number; v: number }[];
  causes: { label: string; total: number; injuries: number; fatalities: number }[];
  types: { label: string; total: number; injuries: number; fatalities: number }[];
  weather: {
    wetHours: number;
    dryHours: number;
    incidents: { wet: Record<"road" | "moto" | "stalled", number>; dry: Record<"road" | "moto" | "stalled", number> };
    jam: { wet: { speed: number; jam_level: number } | null; dry: { speed: number; jam_level: number } | null };
  };
};

type Granularity = "daily" | "weekly" | "monthly";
type RangeMode = "3" | "12" | "all" | "custom";
type WeatherFilter = "all" | "dry" | "wet";
type Detail = { title: string; subtitle?: string; rows: [string, string][]; note?: string };

// ---------- Predictive Forecast Contract (pipeline-driven) ----------
type PredictiveData = {
  chartData: {
    dates: string[];
    actualData: (number | null)[];
    predictedData: (number | null)[];
    trainingEnd: number;
    validationEnd: number;
    forecastAvailable: boolean;
  };
  summary: {
    totalPredictedNext7Days: number | null;
    highestRiskSegment: string;
    peakRiskDate: string;
    modelUsed: string;
  };
  metrics: {
    mae: number;
    poissonDeviance: number;
  };
  modelComparison: {
    model: string;
    MAE: number;
    Poisson_Deviance: number;
    rank: number;
    isChampion: boolean;
  }[];
  featureImportance: {
    feature: string;
    importance: number;
  }[];
  modelInfo: {
    championModel: string;
    trainingPeriod: string;
    validationPeriod: string;
    forecastHorizon: string;
    targetVariable: string;
    trainingSamples: number;
    validationSamples: number;
  };
  highRiskSegments: {
    exit: string;
    km: number;
    predictedCount: number;
    riskLevel: string;
    probability: number;
    recommendedAction: string;
  }[];
};

// ---------- Spatial Analytics Contract ----------
type SpatialData = {
  mttc: {
    overallMedian: number | null;
    slowestType: string | null;
    fastestType: string | null;
    secondaryRatePct: number | null;
    byType: { type: string; n: number; p25: number; median: number; p75: number }[];
  };
  hotspotSegments: {
    rank: number;
    name: string;
    km: number;
    total: number;
    giStarZ: number;
    persistenceIndexPct: number;
    flagged: boolean;
  }[];
};

// ---------- Formatting ----------
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmt1 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);
const fmtPct = (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
const kmLabel = (bin: number) => `Km ${bin}–${bin + 4}`;
const weekdayOf = (dateStr: string) =>
  new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" });

function weekStart(dateStr: string): string {
  const dt = new Date(`${dateStr}T00:00:00`);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

// ---------- Prescriptive mock (unchanged tab) ----------
const prescriptiveResourceOption: EChartsOption = {
  grid: { left: 46, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: ["Ambulance", "Tow Truck", "Patrol", "Fire"] },
  yAxis: { type: "value" },
  tooltip: { trigger: "axis" },
  series: [{ type: "bar", data: [3, 5, 8, 2], itemStyle: { color: "#4f7de5", borderRadius: [8, 8, 0, 0] } }],
};

export default function IncidentPage() {
  const [activeTab, setActiveTab] = useState<"Descriptive" | "Predictive" | "Prescriptive">("Descriptive");

  // Global filters
  const [rangeMode, setRangeMode] = useState<RangeMode>("12");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [weather, setWeather] = useState<WeatherFilter>("all");

  // Chart-local interactivity
  const [grain, setGrain] = useState<Granularity>("monthly");
  const [timeView, setTimeView] = useState<"hour" | "dow">("hour");
  const [causeMode, setCauseMode] = useState<"Causes" | "Types">("Causes");
  const [allHotspotsOpen, setAllHotspotsOpen] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);

  const [data, setData] = useState<Analytics | null>(null);
  const [predictiveData, setPredictiveData] = useState<PredictiveData | null>(null);
  const [predictiveLoading, setPredictiveLoading] = useState(false);
  const [predictiveError, setPredictiveError] = useState<string | null>(null);
  const [spatialData, setSpatialData] = useState<SpatialData | null>(null);

  useEffect(() => {
    if (activeTab === "Predictive" && !predictiveData && !predictiveLoading && !predictiveError) {
      setPredictiveLoading(true);
      fetch(`${BACKEND}/api/incident/predictive`)
        .then((res) => {
          if (!res.ok) throw new Error("API responded with an error");
          return res.json();
        })
        .then((res) => {
          if (res.success) {
            setPredictiveData(res.data);
          } else {
            throw new Error(res.message || "Failed to parse forecast data");
          }
        })
        .catch((err) => {
          console.error("Failed to load predictive incidents", err);
          setPredictiveError(err instanceof Error ? err.message : "Unknown error");
        })
        .finally(() => setPredictiveLoading(false));
    }
  }, [activeTab, predictiveData, predictiveLoading, predictiveError]);

  // Fetch spatial analytics once (not filter-dependent)
  useEffect(() => {
    fetch(`${BACKEND}/api/incident/spatial`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => { if (json.success) setSpatialData(json.data); })
      .catch((e) => console.warn("Spatial analytics unavailable:", e));
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (rangeMode === "custom" && (!customFrom || !customTo)) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (rangeMode === "custom") {
      qs.set("from", customFrom);
      qs.set("to", customTo);
    } else {
      qs.set("months", rangeMode);
    }
    if (weather !== "all") qs.set("weather", weather);
    fetch(`${BACKEND}/api/incident/analytics?${qs}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setData(json.data);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [rangeMode, customFrom, customTo, weather]);

  // ---------- Derived ----------
  const derived = useMemo(() => {
    if (!data) return null;
    const { kpis, hotspots, weather } = data;
    const deltaPct =
      kpis.prevTotalIncidents > 0
        ? ((kpis.totalIncidents - kpis.prevTotalIncidents) / kpis.prevTotalIncidents) * 100
        : 0;
    const hotspotTotal = hotspots.reduce((s, h) => s + h.total, 0);
    const topHotspot = hotspots[0] ?? null;

    // Crash rate per day of each weather, wet vs dry (crashes = road + moto).
    // Exposure-normalized: wet hours are far rarer than dry, so raw counts can't be compared.
    const wetCrashes = weather.incidents.wet.road + weather.incidents.wet.moto;
    const dryCrashes = weather.incidents.dry.road + weather.incidents.dry.moto;
    const wetRate = weather.wetHours > 0 ? (wetCrashes / weather.wetHours) * 24 : 0;
    const dryRate = weather.dryHours > 0 ? (dryCrashes / weather.dryHours) * 24 : 0;
    const rainMultiplier = dryRate > 0 ? wetRate / dryRate : null;

    return { deltaPct, topHotspot, hotspotTotal, wetRate, dryRate, rainMultiplier };
  }, [data]);

  // ---------- Trend ----------
  type TrendRow = { label: string; road: number; moto: number; stalled: number; total: number };
  const trendRows = useMemo<TrendRow[]>(() => {
    if (!data) return [];
    const keyOf = grain === "daily" ? (d: string) => d : grain === "weekly" ? weekStart : (d: string) => d.slice(0, 7);
    const acc = new Map<string, { road: number; moto: number; stalled: number }>();
    for (const r of data.dailyTrend) {
      const k = keyOf(r.d);
      const cur = acc.get(k) ?? { road: 0, moto: 0, stalled: 0 };
      acc.set(k, { road: cur.road + r.road, moto: cur.moto + r.moto, stalled: cur.stalled + r.stalled });
    }
    return [...acc.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([label, v]) => ({ label, ...v, total: v.road + v.moto + v.stalled }));
  }, [data, grain]);

  const trendOption = useMemo<EChartsOption | null>(() => {
    if (trendRows.length === 0) return null;
    const labels = trendRows.map((r) => r.label);
    const boundaryKey = grain === "monthly" ? (l: string) => l : (l: string) => l.slice(0, 7);
    const labelInterval = (i: number) => i === 0 || boundaryKey(labels[i]) !== boundaryKey(labels[i - 1]);

    const mk = (name: string, key: "road" | "moto" | "stalled", color: string) => ({
      name,
      type: "line" as const,
      data: trendRows.map((r) => r[key]),
      symbol: "none",
      smooth: true,
      itemStyle: { color },
      lineStyle: { width: 2.5, color },
    });

    const series = [mk("Road crashes", "road", BLUE), mk("Motorcycle crashes", "moto", PURPLE), mk("Stalled vehicles", "stalled", ORANGE)];

    return {
      grid: { left: 52, right: 16, top: 30, bottom: 22 },
      xAxis: { type: "category", data: labels, axisLabel: { interval: labelInterval, fontSize: 10, hideOverlap: true }, axisTick: { show: false } },
      yAxis: { type: "value", splitNumber: 3, axisLabel: { fontSize: 10 } },
      tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : fmtInt(Number(v))) },
      legend: { show: true, top: 0, right: 8, itemWidth: 14, textStyle: { fontSize: 11 } },
      series,
    };
  }, [trendRows, grain]);

  // Weekday/weekend hourly profile + day-of-week averages, normalized per day
  // so 5 weekdays vs 2 weekend days compare fairly.
  const timeProfile = useMemo(() => {
    if (!data || data.heatmap.length === 0) return null;
    const dowCount = [0, 0, 0, 0, 0, 0, 0]; // index = JS getDay()
    const end = new Date(`${data.range.to}T00:00:00`);
    for (const d = new Date(`${data.range.from}T00:00:00`); d <= end; d.setDate(d.getDate() + 1)) dowCount[d.getDay()]++;
    const weekdayDays = dowCount[1] + dowCount[2] + dowCount[3] + dowCount[4] + dowCount[5];
    const weekendDays = dowCount[0] + dowCount[6];
    const totalDays = weekdayDays + weekendDays;

    const wkHour = Array<number>(24).fill(0);
    const weHour = Array<number>(24).fill(0);
    const dowTotals = Array<number>(7).fill(0);
    for (const r of data.heatmap) {
      if (r.dow >= 1 && r.dow <= 5) wkHour[r.hour] += r.v;
      else weHour[r.hour] += r.v;
      dowTotals[r.dow] += r.v;
    }

    const weekday = wkHour.map((v) => (weekdayDays > 0 ? v / weekdayDays : 0));
    const weekend = weHour.map((v) => (weekendDays > 0 ? v / weekendDays : 0));
    const allHour = wkHour.map((v, h) => (totalDays > 0 ? (v + weHour[h]) / totalDays : 0));
    const hourTotals = wkHour.map((v, h) => v + weHour[h]);
    const peakHour = allHour.indexOf(Math.max(...allHour));
    const quietHour = allHour.indexOf(Math.min(...allHour));

    // Mon..Sun display order
    const dowAvg = DOW_ORDER.map((d) => (dowCount[d] > 0 ? dowTotals[d] / dowCount[d] : 0));
    const dowTotalOrdered = DOW_ORDER.map((d) => dowTotals[d]);
    const dowDaysOrdered = DOW_ORDER.map((d) => dowCount[d]);
    const busiestDow = dowAvg.indexOf(Math.max(...dowAvg));

    return { weekday, weekend, hourTotals, peakHour, quietHour, dowAvg, dowTotalOrdered, dowDaysOrdered, busiestDow };
  }, [data]);

  const timeTakeaway = timeProfile
    ? `Peak around ${fmtHour(timeProfile.peakHour)} · quietest around ${fmtHour(timeProfile.quietHour)} · busiest day: ${DOW_LABELS[timeProfile.busiestDow]}`
    : null;

  const timeOption = useMemo<EChartsOption | null>(() => {
    if (!timeProfile) return null;

    if (timeView === "hour") {
      const peakIdx = timeProfile.weekday.indexOf(Math.max(...timeProfile.weekday));
      return {
        grid: { left: 44, right: 16, top: 34, bottom: 24 },
        xAxis: { type: "category", boundaryGap: false, data: Array.from({ length: 24 }, (_, h) => fmtHour(h)), axisLabel: { interval: 3, fontSize: 10 }, axisTick: { show: false } },
        yAxis: { type: "value", name: "avg incidents / day", nameGap: 10, nameTextStyle: { fontSize: 9, align: "left" }, splitNumber: 3, axisLabel: { fontSize: 10 } },
        tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : `${fmt1(Number(v))} / day`) },
        legend: { show: true, top: 0, right: 8, itemWidth: 14, textStyle: { fontSize: 11 } },
        series: [
          {
            name: "Weekdays",
            type: "line",
            data: timeProfile.weekday.map((v) => Number(v.toFixed(2))),
            symbol: "none",
            smooth: true,
            itemStyle: { color: BLUE },
            lineStyle: { width: 2.5, color: BLUE },
            markPoint: {
              symbol: "circle",
              symbolSize: 8,
              itemStyle: { color: BLUE, borderColor: "#fff", borderWidth: 2 },
              label: { show: true, position: "top", fontSize: 10, color: "#475069", formatter: `Peak · ${fmtHour(peakIdx)}` },
              data: [{ name: "Peak", coord: [peakIdx, Number(timeProfile.weekday[peakIdx].toFixed(2))] }],
            },
          },
          {
            name: "Weekends",
            type: "line",
            data: timeProfile.weekend.map((v) => Number(v.toFixed(2))),
            symbol: "none",
            smooth: true,
            itemStyle: { color: ORANGE },
            lineStyle: { width: 2.5, color: ORANGE },
          },
        ],
      };
    }

    const maxIdx = timeProfile.busiestDow;
    return {
      grid: { left: 44, right: 16, top: 34, bottom: 24 },
      xAxis: { type: "category", data: DOW_LABELS, axisLabel: { interval: 0, fontSize: 10 }, axisTick: { show: false } },
      yAxis: { type: "value", name: "avg incidents / day", nameGap: 10, nameTextStyle: { fontSize: 9, align: "left" }, splitNumber: 3, axisLabel: { fontSize: 10 } },
      tooltip: {
        formatter: (p) => {
          const i = (p as { dataIndex: number }).dataIndex;
          return `<b>${DOW_LABELS[i]}</b><br/>${fmt1(timeProfile.dowAvg[i])} incidents per ${DOW_LABELS[i]} on average<br/>${fmtInt(timeProfile.dowTotalOrdered[i])} total across ${fmtInt(timeProfile.dowDaysOrdered[i])} ${DOW_LABELS[i]}s`;
        },
      },
      series: [
        {
          type: "bar",
          data: timeProfile.dowAvg.map((v, i) => ({
            value: Number(v.toFixed(2)),
            itemStyle: { color: i === maxIdx ? BLUE : "#8fa8ee", borderRadius: [4, 4, 0, 0] },
            label: i === maxIdx ? { show: true, position: "top", fontSize: 10, color: "#475069", formatter: () => fmt1(v) } : undefined,
          })),
          barMaxWidth: 26,
        },
      ],
    };
  }, [timeProfile, timeView]);

  const hotspotChart = useMemo<{ option: EChartsOption; rows: Analytics["hotspots"] } | null>(() => {
    if (!data || data.hotspots.length === 0) return null;
    const top = data.hotspots.slice(0, 10);
    const display = [...top].reverse();
    const maxV = top[0]?.total ?? 1;
    return {
      rows: display,
      option: {
        grid: { left: 84, right: 46, top: 2, bottom: 20 },
        xAxis: { type: "value", splitNumber: 3, axisLabel: { fontSize: 10 } },
        yAxis: { type: "category", data: display.map((r) => kmLabel(r.km_bin)), axisLabel: { interval: 0, fontSize: 10 }, axisTick: { show: false } },
        tooltip: {
          formatter: (p) => {
            const i = (p as { dataIndex: number }).dataIndex;
            const r = display[i];
            return `<b>${kmLabel(r.km_bin)}</b><br/>${fmtInt(r.total)} incidents · ${fmtInt(r.injuries)} injured · ${fmtInt(r.fatalities)} fatalities`;
          },
        },
        series: [
          {
            type: "bar",
            data: display.map((r) => ({
              value: r.total,
              itemStyle: { color: SEQ[Math.min(3, 1 + Math.floor((r.total / maxV) * 2.99))], borderRadius: [0, 3, 3, 0] },
            })),
            barMaxWidth: 12,
            barCategoryGap: "25%",
          },
        ],
      },
    };
  }, [data]);

  const causeChart = useMemo<{ option: EChartsOption; rows: Analytics["causes"] } | null>(() => {
    if (!data) return null;
    const src = causeMode === "Causes" ? data.causes : data.types;
    if (src.length === 0) return null;
    const top = src.slice(0, 9);
    const display = [...top].reverse();
    return {
      rows: display,
      option: {
        grid: { left: 150, right: 42, top: 2, bottom: 20 },
        xAxis: { type: "value", splitNumber: 3, axisLabel: { fontSize: 10 } },
        yAxis: { type: "category", data: display.map((r) => (r.label.length > 24 ? `${r.label.slice(0, 24)}…` : r.label)), axisLabel: { interval: 0, fontSize: 10 }, axisTick: { show: false } },
        tooltip: {
          formatter: (p) => {
            const i = (p as { dataIndex: number }).dataIndex;
            const r = display[i];
            return `<b>${r.label}</b><br/>${fmtInt(r.total)} incidents · ${fmtInt(r.injuries)} injured · ${fmtInt(r.fatalities)} fatalities`;
          },
        },
        series: [
          {
            type: "bar",
            data: display.map((r) => ({ value: r.total, itemStyle: { color: "#8fa8ee", borderRadius: [0, 3, 3, 0] } })),
            barMaxWidth: 12,
            barCategoryGap: "25%",
          },
        ],
      },
    };
  }, [data, causeMode]);

  const weatherChart = useMemo<EChartsOption | null>(() => {
    if (!data || !derived) return null;
    const w = data.weather;
    if (w.wetHours === 0 && w.dryHours === 0) return null;
    const cats = ["Road crashes", "Motorcycle crashes", "Stalled vehicles"] as const;
    const keys = ["road", "moto", "stalled"] as const;
    // Per day of that weather = incidents / hours-of-exposure × 24, so rare wet
    // hours compare fairly against abundant dry hours.
    const rate = (n: number, hours: number) => (hours > 0 ? Number(((n / hours) * 24).toFixed(1)) : 0);
    return {
      grid: { left: 52, right: 16, top: 30, bottom: 40 },
      xAxis: { type: "category", data: [...cats], axisLabel: { fontSize: 10, interval: 0 }, axisTick: { show: false } },
      yAxis: { type: "value", name: "avg incidents / day", nameGap: 8, nameTextStyle: { fontSize: 9 }, splitNumber: 3, axisLabel: { fontSize: 10 } },
      tooltip: {
        trigger: "axis",
        formatter: (p) => {
          const items = p as { seriesName: string; dataIndex: number; value: number }[];
          const i = items[0].dataIndex;
          const k = keys[i];
          return `<b>${cats[i]}</b><br/>Dry weather: ${items.find((x) => x.seriesName === "Dry weather")?.value} per day — ${fmtInt(w.incidents.dry[k])} incidents over ${fmtInt(w.dryHours)} dry hrs<br/>Wet weather: ${items.find((x) => x.seriesName === "Wet weather")?.value} per day — ${fmtInt(w.incidents.wet[k])} incidents over ${fmtInt(w.wetHours)} wet hrs`;
        },
      },
      legend: { show: true, top: 0, right: 8, itemWidth: 14, textStyle: { fontSize: 11 } },
      series: [
        { name: "Dry weather", type: "bar", data: keys.map((k) => rate(w.incidents.dry[k], w.dryHours)), itemStyle: { color: BLUE, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 26 },
        { name: "Wet weather", type: "bar", data: keys.map((k) => rate(w.incidents.wet[k], w.wetHours)), itemStyle: { color: ORANGE, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 26 },
      ],
    };
  }, [data, derived]);

  // ---------- Click-to-inspect ----------
  const filtersNote = `${weather === "all" ? "All weather" : weather === "wet" ? "Wet hours only (rainfall > 0.3 mm)" : "Dry hours only"}${data ? ` · ${data.range.from} to ${data.range.to}` : ""}`;

  const onTrendClick = (p: { dataIndex: number }) => {
    const r = trendRows[p.dataIndex];
    if (!r) return;
    const totals = trendRows.map((x) => x.total);
    const avg = totals.reduce((s, v) => s + v, 0) / totals.length;
    const rank = 1 + totals.filter((v) => v > r.total).length;
    const periodWord = grain === "daily" ? "day" : grain === "weekly" ? "week" : "month";
    const title = grain === "daily" ? `${weekdayOf(r.label)}, ${r.label}` : grain === "weekly" ? `Week of ${r.label}` : r.label;
    setDetail({
      title,
      subtitle: `Incidents · ${periodWord}ly`,
      rows: [
        ["Total incidents", fmtInt(r.total)],
        ["Road crashes", fmtInt(r.road)],
        ["Motorcycle crashes", fmtInt(r.moto)],
        ["Stalled vehicles", fmtInt(r.stalled)],
        ["vs range average", avg > 0 ? fmtPct(((r.total - avg) / avg) * 100) : "—"],
        ["Rank in range", `#${rank} of ${totals.length} ${periodWord}s`],
      ],
      note: filtersNote,
    });
  };

  const onTimeClick = (p: { dataIndex: number }) => {
    if (!timeProfile) return;
    if (timeView === "hour") {
      const h = p.dataIndex;
      const totals = [...timeProfile.hourTotals].sort((a, b) => b - a);
      const rank = 1 + totals.findIndex((x) => x <= timeProfile.hourTotals[h]);
      setDetail({
        title: `${fmtHour(h)} – ${fmtHour((h + 1) % 24)}`,
        subtitle: "Incident frequency in this hour of day",
        rows: [
          ["Avg on a weekday", `${fmt1(timeProfile.weekday[h])} incidents`],
          ["Avg on a weekend day", `${fmt1(timeProfile.weekend[h])} incidents`],
          ["Total in range", fmtInt(timeProfile.hourTotals[h])],
          ["Rank among hours", `#${rank} of 24`],
        ],
        note: filtersNote,
      });
    } else {
      const i = p.dataIndex;
      const avgs = [...timeProfile.dowAvg].sort((a, b) => b - a);
      const rank = 1 + avgs.findIndex((x) => x <= timeProfile.dowAvg[i]);
      setDetail({
        title: DOW_LABELS[i],
        subtitle: "Incident frequency on this day of week",
        rows: [
          ["Avg per day", `${fmt1(timeProfile.dowAvg[i])} incidents`],
          ["Total in range", `${fmtInt(timeProfile.dowTotalOrdered[i])} across ${fmtInt(timeProfile.dowDaysOrdered[i])} ${DOW_LABELS[i]}s`],
          ["Rank among days", `#${rank} of 7`],
        ],
        note: filtersNote,
      });
    }
  };

  const showHotspotDetail = (r: Analytics["hotspots"][number]) => {
    if (!derived) return;
    setDetail({
      title: kmLabel(r.km_bin),
      subtitle: "Incident hotspot (5-km segment)",
      rows: [
        ["Total incidents", fmtInt(r.total)],
        ["Road crashes", fmtInt(r.road)],
        ["Motorcycle crashes", fmtInt(r.moto)],
        ["Stalled vehicles", fmtInt(r.stalled)],
        ["Injuries", fmtInt(r.injuries)],
        ["Fatalities", fmtInt(r.fatalities)],
        ["Share of located incidents", derived.hotspotTotal > 0 ? `${((r.total / derived.hotspotTotal) * 100).toFixed(1)}%` : "—"],
      ],
      note: `Km-post parsed from the operations log location field. ${filtersNote}`,
    });
  };

  const onHotspotClick = (p: { dataIndex: number }) => {
    const r = hotspotChart?.rows[p.dataIndex];
    if (r) showHotspotDetail(r);
  };

  const onCauseClick = (p: { dataIndex: number }) => {
    if (!causeChart || !data) return;
    const r = causeChart.rows[p.dataIndex];
    if (!r) return;
    const pool = causeMode === "Causes" ? data.causes : data.types;
    const total = pool.reduce((s, x) => s + x.total, 0);
    setDetail({
      title: r.label,
      subtitle: causeMode === "Causes" ? "Reported cause" : "Accident type (crashes only)",
      rows: [
        ["Incidents", fmtInt(r.total)],
        ["Share", total > 0 ? `${((r.total / total) * 100).toFixed(1)}%` : "—"],
        ["Injuries", fmtInt(r.injuries)],
        ["Fatalities", fmtInt(r.fatalities)],
      ],
      note: filtersNote,
    });
  };

  const onWeatherClick = (p: { dataIndex: number; seriesName?: string }) => {
    if (!data || !derived) return;
    const keys = ["road", "moto", "stalled"] as const;
    const k = keys[p.dataIndex];
    const w = data.weather;
    setDetail({
      title: `${SOURCE_LABEL[k]} — weather impact`,
      subtitle: "Wet = expressway-average rainfall > 0.3 mm in that hour",
      rows: [
        ["Incidents in dry hours", `${fmtInt(w.incidents.dry[k])} over ${fmtInt(w.dryHours)} hrs`],
        ["Incidents in wet hours", `${fmtInt(w.incidents.wet[k])} over ${fmtInt(w.wetHours)} hrs`],
        ["Rate in dry weather", w.dryHours > 0 ? `${((w.incidents.dry[k] / w.dryHours) * 24).toFixed(1)} per day` : "—"],
        ["Rate in wet weather", w.wetHours > 0 ? `${((w.incidents.wet[k] / w.wetHours) * 24).toFixed(1)} per day` : "—"],
        ["Avg jam speed (dry)", w.jam.dry ? `${w.jam.dry.speed} km/h` : "—"],
        ["Avg jam speed (wet)", w.jam.wet ? `${w.jam.wet.speed} km/h` : "—"],
      ],
      note: "Rates are exposure-normalized: incidents ÷ hours with that weather, scaled to a 24-hour day. Wet hours are much rarer than dry, so raw counts can't be compared directly.",
    });
  };

  const chartFrame = (option: EChartsOption | null, emptyNote: string, onClick?: (p: never) => void) => {
    if (loading && !data) return <div className={styles.placeholder}>Loading…</div>;
    if (error) return <div className={styles.placeholder}>Live data unavailable — is the backend running on port 4000?</div>;
    if (!option) return <div className={styles.placeholder}>{emptyNote}</div>;
    return (
      <ReactECharts
        option={option}
        notMerge
        lazyUpdate
        style={{ width: "100%", height: "100%" }}
        opts={{ renderer: "canvas" }}
        onEvents={onClick ? { click: onClick as (p: unknown) => void } : undefined}
      />
    );
  };

  const kpiValue = (v: string | null) => (loading && !data ? "…" : v ?? "—");

  // ---------- Predictive / Prescriptive share the same shell ----------
  if (activeTab !== "Descriptive") {
    return (
      <div style={{ display: "block", width: "100%", padding: "20px 24px", boxSizing: "border-box" }}>
        {/* Filter / tab row */}
        <div className={styles.filterRow}>
          <span className={styles.filterLabel}>
            {activeTab === "Predictive" ? "Forecasts from the AI model" : "Recommended resource allocation"}
          </span>
          <span className={styles.spacer} />
          <div className={styles.modeTabs}>
            {(["Descriptive", "Predictive", "Prescriptive"] as const).map((t) => (
              <button key={t} className={`${styles.modeTab} ${activeTab === t ? styles.modeTabActive : ""}`} onClick={() => setActiveTab(t)}>
                {activeTab === t && <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 6, marginBottom: -1 }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                {t}
              </button>
            ))}
          </div>
        </div>

        {activeTab === "Predictive" ? (
          <section style={{ display: "block", width: "100%" }} className="space-y-5">
            {predictiveLoading ? (
              <div style={{ padding: "60px 0", textAlign: "center", color: "#64748b", fontSize: "1rem" }}>Loading AI Forecasts…</div>
            ) : predictiveError ? (
              <div style={{ padding: "24px", textAlign: "center", color: "#dc2626", background: "#fef2f2", borderRadius: "12px", border: "1px solid #fecaca" }}>
                <strong style={{ display: "block", marginBottom: "6px" }}>Error Loading Forecasts</strong>
                {predictiveError}
              </div>
            ) : predictiveData ? (
              <>
                {/* ── Forecast unavailable notice ── */}
                {!predictiveData.chartData.forecastAvailable && (
                  <div style={{ padding: "14px 20px", background: "#fffbeb", borderRadius: "12px", border: "1px solid #fde68a", display: "flex", alignItems: "center", gap: "10px", fontSize: "0.85rem", color: "#92400e" }}>
                    <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#d97706" strokeWidth="1.5"/><path d="M10 6v5M10 13.5v.5" stroke="#d97706" strokeWidth="1.5" strokeLinecap="round"/></svg>
                    <span><strong>Future forecast data pending.</strong> Showing Training &amp; Validation results only. Future forecasting will become available once the Python pipeline exports forecast data.</span>
                  </div>
                )}

                {/* ── Summary KPI row ── */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "14px", width: "100%" }}>
                  {[
                    { label: "Predicted Incidents (7 Days)", value: predictiveData.summary.totalPredictedNext7Days != null ? String(predictiveData.summary.totalPredictedNext7Days) : "Pending", accent: "#3e67ef" },
                    { label: "Highest‑Risk Segment",        value: predictiveData.summary.highestRiskSegment,               accent: "#e06b47" },
                    { label: "Peak Risk Date",              value: predictiveData.summary.peakRiskDate,                     accent: "#1e293b" },
                    { label: "Model Used",                  value: predictiveData.summary.modelUsed,                        accent: "#1e293b" },
                  ].map((c) => (
                    <div key={c.label} style={{ background: "#fff", borderRadius: "12px", padding: "18px 20px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0" }}>
                      <p style={{ fontSize: "0.73rem", color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "6px" }}>{c.label}</p>
                      <p style={{ fontSize: "1.55rem", fontWeight: 700, color: c.accent, lineHeight: 1.15 }}>{c.value}</p>
                    </div>
                  ))}
                </div>

                {/* ── Model Information Card ── */}
                <div style={{ background: "#fff", borderRadius: "12px", padding: "20px 28px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", boxSizing: "border-box", width: "100%" }}>
                  <h4 style={{ fontSize: "0.9rem", fontWeight: 700, color: "#475569", marginBottom: "14px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Model Information</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
                    {[
                      { label: "Champion Model",       value: predictiveData.modelInfo.championModel },
                      { label: "Training Period",      value: predictiveData.modelInfo.trainingPeriod },
                      { label: "Validation Period",    value: predictiveData.modelInfo.validationPeriod },
                      { label: "Forecast Horizon",     value: predictiveData.modelInfo.forecastHorizon },
                      { label: "Target Variable",      value: predictiveData.modelInfo.targetVariable },
                      { label: "Training Samples",     value: predictiveData.modelInfo.trainingSamples > 0 ? fmtInt(predictiveData.modelInfo.trainingSamples) : "N/A" },
                      { label: "Validation Samples",   value: predictiveData.modelInfo.validationSamples > 0 ? fmtInt(predictiveData.modelInfo.validationSamples) : "N/A" },
                    ].map((item) => (
                      <div key={item.label}>
                        <p style={{ fontSize: "0.72rem", color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "3px" }}>{item.label}</p>
                        <p style={{ fontSize: "0.95rem", fontWeight: 600, color: "#1e293b", lineHeight: 1.3 }}>{item.value}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── Walk-Forward Forecast Chart ── */}
                <div style={{ background: "#fff", borderRadius: "12px", padding: "24px 28px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", boxSizing: "border-box", width: "100%" }}>
                  {/* Chart header */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px", flexWrap: "wrap", gap: "8px" }}>
                    <div>
                      <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "#1e293b", margin: 0 }}>Predictive Incident Walk-Forward Forecast ({predictiveData.summary.modelUsed})</h3>
                      <p style={{ fontSize: "0.82rem", color: "#64748b", margin: "4px 0 0" }}>
                        {predictiveData.chartData.forecastAvailable
                          ? "Historical incidents, validation period, and future incident forecast."
                          : "Historical incidents and validation period. Future forecast pending pipeline export."}
                      </p>
                    </div>
                    {/* Region legend */}
                    <div style={{ display: "flex", gap: "16px", alignItems: "center", flexShrink: 0 }}>
                      {[
                        { color: "rgba(59,130,246,0.18)", border: "#93c5fd", label: "Past (Training)" },
                        { color: "rgba(249,115,22,0.15)", border: "#fdba74", label: "Present (Holdout)" },
                        ...(predictiveData.chartData.forecastAvailable
                          ? [{ color: "rgba(34,197,94,0.15)", border: "#86efac", label: "Future (Forecast)" }]
                          : []),
                      ].map((r) => (
                        <span key={r.label} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.78rem", color: "#475569" }}>
                          <span style={{ display: "inline-block", width: "14px", height: "14px", background: r.color, border: `1px solid ${r.border}`, borderRadius: "3px" }} />
                          {r.label}
                        </span>
                      ))}
                    </div>
                  </div>
                  {/* Chart canvas */}
                  <div style={{ width: "100%", height: "460px" }}>
                    <PredictiveIncidentChart
                      dates={predictiveData.chartData.dates}
                      actualData={predictiveData.chartData.actualData}
                      predictedData={predictiveData.chartData.predictedData}
                      trainingEnd={predictiveData.chartData.trainingEnd}
                      validationEnd={predictiveData.chartData.validationEnd}
                      forecastAvailable={predictiveData.chartData.forecastAvailable}
                    />
                  </div>
                </div>

                {/* ── ML Validation Metrics (from pipeline — NOT recalculated) ── */}
                <div style={{ background: "#fff", borderRadius: "12px", padding: "20px 28px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", boxSizing: "border-box", width: "100%" }}>
                  <h4 style={{ fontSize: "0.9rem", fontWeight: 700, color: "#475569", marginBottom: "14px", textTransform: "uppercase", letterSpacing: "0.05em" }}>ML Validation Metrics — {predictiveData.summary.modelUsed}</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "20px" }}>
                    {[
                      { label: "Mean Absolute Error",     value: predictiveData.metrics.mae > 0 ? predictiveData.metrics.mae.toFixed(6) : "—",              unit: "",          highlight: false },
                      { label: "Poisson Deviance",        value: predictiveData.metrics.poissonDeviance > 0 ? predictiveData.metrics.poissonDeviance.toFixed(6) : "—", unit: "",  highlight: true  },
                    ].map((m) => (
                      <div key={m.label}>
                        <p style={{ fontSize: "0.72rem", color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>{m.label}</p>
                        <p style={{ fontSize: "1.6rem", fontWeight: 700, color: m.highlight ? "#16a34a" : "#1e293b", lineHeight: 1.1 }}>
                          {m.value}
                          {m.unit && <span style={{ fontSize: "0.8rem", fontWeight: 400, color: "#94a3b8", marginLeft: "4px" }}>{m.unit}</span>}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── Model Comparison Table ── */}
                {predictiveData.modelComparison.length > 0 && (
                  <div style={{ background: "#fff", borderRadius: "12px", padding: "20px 28px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", boxSizing: "border-box", width: "100%" }}>
                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, color: "#475569", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Model Comparison</h4>
                    <p style={{ fontSize: "0.82rem", color: "#94a3b8", marginBottom: "14px" }}>All trained models ranked by Poisson Deviance. Champion model highlighted.</p>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                        <thead>
                          <tr style={{ background: "#f8fafc" }}>
                            {["Rank", "Model", "MAE", "Poisson Deviance"].map((h) => (
                              <th key={h} style={{ padding: "10px 14px", fontWeight: 600, color: "#64748b", textAlign: "left", borderBottom: "1px solid #e2e8f0", fontSize: "0.77rem", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const allKnownModels = ["Random Forest", "Negative Binomial", "GWR", "Spatial LSTM", "XGBoost", "LSTM", "GRU", "SARIMAX", "Naive Forecast baseline"];
                            const displayModels = [...predictiveData.modelComparison];
                            allKnownModels.forEach(m => {
                              if (!displayModels.find(dm => dm.model === m)) {
                                displayModels.push({ model: m, MAE: null as any, Poisson_Deviance: null as any, rank: 99, isChampion: false });
                              }
                            });
                            displayModels.sort((a, b) => {
                              if (a.isChampion && !b.isChampion) return -1;
                              if (!a.isChampion && b.isChampion) return 1;
                              if (a.MAE !== null && b.MAE === null) return -1;
                              if (a.MAE === null && b.MAE !== null) return 1;
                              return a.rank - b.rank;
                            });
                            displayModels.forEach((m, idx) => { m.rank = idx + 1; });
                            return displayModels.map((m, i) => (
                              <tr key={i} style={{ borderBottom: "1px solid #f1f5f9", background: m.isChampion ? "#f0fdf4" : "transparent" }}>
                                <td style={{ padding: "11px 14px", width: "48px", color: "#64748b", fontWeight: 700 }}>
                                  #{m.rank}
                                  {m.isChampion && (
                                    <span style={{ display: "inline-block", marginLeft: "8px", padding: "2px 8px", borderRadius: "20px", fontSize: "0.7rem", fontWeight: 700, background: "#dcfce7", color: "#16a34a" }}>🏆</span>
                                  )}
                                </td>
                                <td style={{ padding: "11px 14px", fontWeight: m.isChampion ? 700 : 500, color: m.isChampion ? "#16a34a" : "#1e293b" }}>{m.model}</td>
                                <td style={{ padding: "11px 14px", color: "#64748b", fontVariantNumeric: "tabular-nums" }}>{m.MAE !== null ? m.MAE.toFixed(6) : <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: "20px", fontSize: "0.7rem", fontWeight: 600, background: "#f1f5f9", color: "#64748b" }}>Pending evaluation</span>}</td>
                                <td style={{ padding: "11px 14px", color: "#64748b", fontVariantNumeric: "tabular-nums" }}>{m.Poisson_Deviance !== null ? m.Poisson_Deviance.toFixed(6) : <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: "20px", fontSize: "0.7rem", fontWeight: 600, background: "#f1f5f9", color: "#64748b" }}>Pending evaluation</span>}</td>
                              </tr>
                            ));
                          })()}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* ── Model Specific Visualization (Adapts to Champion Model) ── */}
                {predictiveData.modelInfo.championModel.includes("GWR") ? (
                  <div style={{ background: "#fff", borderRadius: "12px", padding: "24px 28px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", boxSizing: "border-box", width: "100%" }}>
                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, color: "#475569", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.05em" }}>GWR Coefficient Map — {predictiveData.summary.modelUsed}</h4>
                    <p style={{ fontSize: "0.82rem", color: "#94a3b8", marginBottom: "14px" }}>Spatial distribution of coefficients showing local incident probability variations.</p>
                    <div style={{ width: "100%", height: "240px", background: "#f8fafc", borderRadius: "8px", border: "1px dashed #cbd5e1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontSize: "0.9rem" }}>
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: "12px", color: "#cbd5e1" }}><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"></polygon><line x1="9" y1="3" x2="9" y2="18"></line><line x1="15" y1="6" x2="15" y2="21"></line></svg>
                      GWR Coefficient Map visual pending pipeline map export
                    </div>
                  </div>
                ) : predictiveData.modelInfo.championModel.includes("LSTM") ? (
                  <div style={{ background: "#fff", borderRadius: "12px", padding: "24px 28px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", boxSizing: "border-box", width: "100%" }}>
                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, color: "#475569", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Forecast Performance Visualization — {predictiveData.summary.modelUsed}</h4>
                    <p style={{ fontSize: "0.82rem", color: "#94a3b8", marginBottom: "14px" }}>Temporal and spatial forecast accuracy analysis.</p>
                    <div style={{ width: "100%", height: "240px", background: "#f8fafc", borderRadius: "8px", border: "1px dashed #cbd5e1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontSize: "0.9rem" }}>
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: "12px", color: "#cbd5e1" }}><path d="M3 3v18h18"></path><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"></path></svg>
                      LSTM Forecast Performance visual pending pipeline export
                    </div>
                  </div>
                ) : predictiveData.featureImportance.length > 0 ? (
                  <div style={{ background: "#fff", borderRadius: "12px", padding: "24px 28px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", boxSizing: "border-box", width: "100%" }}>
                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, color: "#475569", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Feature Importance — {predictiveData.summary.modelUsed}</h4>
                    <p style={{ fontSize: "0.82rem", color: "#94a3b8", marginBottom: "14px" }}>Top features used by the champion model for incident prediction.</p>
                    {predictiveData.modelInfo.championModel.includes("Random Forest") && (
                      <p style={{ fontSize: "0.75rem", color: "#94a3b8", marginBottom: "14px", fontStyle: "italic" }}>
                        Weather features (temperature, rainfall, wind speed, humidity) are currently non-functional — weather data join is pending. Importance scores for these four features should not be trusted until resolved.
                      </p>
                    )}
                    <div style={{ width: "100%", height: `${Math.max(240, predictiveData.featureImportance.filter(f => f.importance > 0).length * 32 + 40)}px` }}>
                      <ReactECharts
                        option={{
                          grid: { left: 160, right: 40, top: 4, bottom: 20 },
                          xAxis: { type: "value", axisLabel: { fontSize: 10, color: "#94a3b8" }, splitLine: { lineStyle: { color: "#f1f5f9", type: "dashed" } } },
                          yAxis: {
                            type: "category",
                            data: predictiveData.featureImportance.filter(f => f.importance > 0).reverse().map(f => f.feature.replace(/_/g, " ")),
                            axisLabel: { fontSize: 11, color: "#475569", interval: 0 },
                            axisTick: { show: false },
                          },
                          tooltip: {
                            formatter: (p: unknown) => {
                              const item = p as { name: string; value: number };
                              return `<b>${item.name}</b><br/>Importance: ${(item.value * 100).toFixed(2)}%`;
                            },
                          },
                          series: [{
                            type: "bar",
                            data: predictiveData.featureImportance.filter(f => f.importance > 0).reverse().map((f, i, arr) => ({
                              value: f.importance,
                              itemStyle: {
                                color: i === arr.length - 1 ? "#3e67ef" : "#8fa8ee",
                                borderRadius: [0, 4, 4, 0],
                              },
                            })),
                            barMaxWidth: 16,
                            barCategoryGap: "30%",
                          }],
                        } as EChartsOption}
                        notMerge
                        lazyUpdate
                        style={{ width: "100%", height: "100%" }}
                        opts={{ renderer: "canvas" }}
                      />
                    </div>
                  </div>
                ) : null}

                {/* ── Response Time Distribution ── */}
                <div style={{ background: "#fff", borderRadius: "12px", padding: "24px 28px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", boxSizing: "border-box", width: "100%" }}>
                  <h4 style={{ fontSize: "0.9rem", fontWeight: 700, color: "#475569", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Response Time Distribution</h4>
                  <p style={{ fontSize: "0.82rem", color: "#94a3b8", marginBottom: "14px" }}>Median Time to Clear (MTTC) by incident type · P25–P75 shown on tooltip</p>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "14px", width: "100%", marginBottom: "20px" }}>
                    {[
                      { label: "Overall Median MTTC", value: spatialData?.mttc.overallMedian != null ? `${spatialData.mttc.overallMedian} min` : "—", accent: "#3e67ef" },
                      { label: "Slowest Incident Type", value: spatialData?.mttc.slowestType ?? "—", accent: "#e06b47" },
                      { label: "Fastest Incident Type", value: spatialData?.mttc.fastestType ?? "—", accent: "#1e293b" },
                      { label: "Secondary Incident Rate", value: spatialData?.mttc.secondaryRatePct != null ? `${spatialData.mttc.secondaryRatePct}%` : "—", accent: "#1e293b" },
                    ].map((c) => (
                      <div key={c.label} style={{ background: "#fff", borderRadius: "12px", padding: "18px 20px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0" }}>
                        <p style={{ fontSize: "0.73rem", color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "6px" }}>{c.label}</p>
                        <p style={{ fontSize: "1.55rem", fontWeight: 700, color: c.accent, lineHeight: 1.15 }}>{c.value}</p>
                      </div>
                    ))}
                  </div>

                  {spatialData && spatialData.mttc.byType.length > 0 ? (
                    <div style={{ width: "100%", height: `${Math.max(200, spatialData.mttc.byType.length * 36 + 40)}px` }}>
                      <ReactECharts
                        option={{
                          grid: { left: 160, right: 60, top: 10, bottom: 20 },
                          xAxis: { type: "value", name: "Minutes", nameTextStyle: { color: "#94a3b8", fontSize: 10 }, axisLabel: { fontSize: 10, color: "#94a3b8", formatter: (v: number) => `${v} min` }, splitLine: { lineStyle: { color: "#f1f5f9", type: "dashed" } } },
                          yAxis: {
                            type: "category",
                            data: [...spatialData.mttc.byType].reverse().map(d => d.type),
                            axisLabel: { fontSize: 11, color: "#475569", interval: 0 },
                            axisTick: { show: false },
                          },
                          tooltip: {
                            trigger: "axis",
                            formatter: (params: any) => {
                              const i = params[0].dataIndex;
                              const rev = [...spatialData.mttc.byType].reverse();
                              const row = rev[i];
                              return `<b>${row.type}</b><br/>Median: <b>${row.median} min</b><br/>IQR: ${row.p25}–${row.p75} min<br/>n=${row.n.toLocaleString()} incidents`;
                            }
                          },
                          series: [{
                            type: "bar",
                            data: [...spatialData.mttc.byType].reverse().map((d, i, arr) => ({
                              value: d.median,
                              itemStyle: { color: i === arr.length - 1 ? "#3e67ef" : "#8fa8ee", borderRadius: [0, 4, 4, 0] }
                            })),
                            barMaxWidth: 16,
                            barCategoryGap: "30%",
                          }],
                        } as EChartsOption}
                        notMerge
                        lazyUpdate
                        style={{ width: "100%", height: "100%" }}
                        opts={{ renderer: "canvas" }}
                      />
                    </div>
                  ) : (
                    <div style={{ padding: "32px 0", textAlign: "center", color: "#94a3b8", fontSize: "0.9rem" }}>
                      {spatialData ? "No response time data found in the selected tables." : "Loading response time data…"}
                    </div>
                  )}
                </div>

                {/* ── High‑Risk Segment Table ── */}
                {predictiveData.highRiskSegments.length > 0 && (
                  <div style={{ background: "#fff", borderRadius: "12px", padding: "20px 28px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", boxSizing: "border-box", width: "100%" }}>
                    <h3 style={{ fontSize: "0.9rem", fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>High‑Risk Segment Analysis</h3>
                    <p style={{ fontSize: "0.82rem", color: "#94a3b8", marginBottom: "14px" }}>Segments ranked by incident frequency during the validation period.</p>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                        <thead>
                          <tr style={{ background: "#f8fafc" }}>
                            {["Exit / Segment", "Incident Count", "Risk Level", "Probability", "Recommended Action"].map((h) => (
                              <th key={h} style={{ padding: "10px 14px", fontWeight: 600, color: "#64748b", textAlign: "left", borderBottom: "1px solid #e2e8f0", fontSize: "0.77rem", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {predictiveData.highRiskSegments.map((seg, i) => (
                            <tr key={i} style={{ borderBottom: "1px solid #f1f5f9" }}>
                              <td style={{ padding: "11px 14px", fontWeight: 500, color: "#1e293b" }}>{seg.exit} <span style={{ color: "#94a3b8", fontWeight: 400, fontSize: "0.82rem" }}>(Km {seg.km})</span></td>
                              <td style={{ padding: "11px 14px", color: "#3e67ef", fontWeight: 700 }}>{seg.predictedCount}</td>
                              <td style={{ padding: "11px 14px" }}>
                                <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: "20px", fontSize: "0.75rem", fontWeight: 600,
                                  background: seg.riskLevel === "High" ? "#fee2e2" : seg.riskLevel === "Medium" ? "#fef3c7" : "#e0f2fe",
                                  color:      seg.riskLevel === "High" ? "#dc2626" : seg.riskLevel === "Medium" ? "#d97706" : "#0284c7" }}>{seg.riskLevel}</span>
                              </td>
                              <td style={{ padding: "11px 14px", color: "#64748b" }}>{Math.round(seg.probability * 100)}%</td>
                              <td style={{ padding: "11px 14px", color: "#64748b" }}>{seg.recommendedAction}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* ── Location-Based Hotspot Analysis ── */}
                <div style={{ background: "#fff", borderRadius: "12px", padding: "20px 28px", boxShadow: "0 1px 3px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", boxSizing: "border-box", width: "100%", marginTop: "24px" }}>
                  <h3 style={{ fontSize: "0.9rem", fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "4px" }}>Location-Based Hotspot Analysis</h3>
                  <p style={{ fontSize: "0.82rem", color: "#94a3b8", marginBottom: "14px" }}>
                    Segments ranked by spatial incident clustering (Z-score approximation from exit-level frequency), independent of the probability model above.
                    {" "}<em style={{ fontSize: "0.78rem" }}>Flagged = Z ≥ 1.96 (statistically significant cluster). Full Getis-Ord Gi* pending KDE/spatial pipeline run.</em>
                  </p>
                  {spatialData && spatialData.hotspotSegments.length > 0 ? (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                        <thead>
                          <tr style={{ background: "#f8fafc" }}>
                            {["Rank", "Exit / Segment", "Incident Total", "Gi* Z-Score", "Hotspot Persistence Index", "Infrastructure Risk Flag"].map((h) => (
                              <th key={h} style={{ padding: "10px 14px", fontWeight: 600, color: "#64748b", textAlign: "left", borderBottom: "1px solid #e2e8f0", fontSize: "0.77rem", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {spatialData.hotspotSegments.map((seg, i) => {
                            const maxZ = Math.max(...spatialData.hotspotSegments.map(s => s.giStarZ), 0.01);
                            const intensity = Math.min(1, Math.max(0, seg.giStarZ / maxZ));
                            const cellBg = `rgba(62, 103, 239, ${intensity * 0.22})`;
                            return (
                              <tr key={i} style={{ borderBottom: "1px solid #f1f5f9" }}>
                                <td style={{ padding: "11px 14px", width: "48px", color: "#64748b", fontWeight: 700 }}>#{seg.rank}</td>
                                <td style={{ padding: "11px 14px", fontWeight: 500, color: "#1e293b" }}>{seg.name} <span style={{ color: "#94a3b8", fontWeight: 400, fontSize: "0.82rem" }}>(Km {seg.km})</span></td>
                                <td style={{ padding: "11px 14px", color: "#3e67ef", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{seg.total.toLocaleString()}</td>
                                <td style={{ padding: "11px 14px", color: "#3e67ef", fontWeight: 700, background: cellBg, fontVariantNumeric: "tabular-nums" }}>{seg.giStarZ > 0 ? "+" : ""}{seg.giStarZ.toFixed(2)}</td>
                                <td style={{ padding: "11px 14px", color: "#64748b" }}>{seg.persistenceIndexPct.toFixed(1)}%</td>
                                <td style={{ padding: "11px 14px" }}>
                                  <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: "20px", fontSize: "0.75rem", fontWeight: 600,
                                    background: seg.flagged ? "#fee2e2" : "#e0f2fe",
                                    color:      seg.flagged ? "#dc2626" : "#0284c7" }}>
                                    {seg.flagged ? "Flagged" : "None"}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={{ padding: "32px 0", textAlign: "center", color: "#94a3b8", fontSize: "0.9rem" }}>
                      {spatialData ? "No exit-level incident data found." : "Loading hotspot data…"}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ padding: "60px 0", textAlign: "center", color: "#94a3b8", fontSize: "1rem" }}>No prediction data available. Ensure the Python training pipeline has been run.</div>
            )}
          </section>
        ) : (
          /* ── Prescriptive tab ── */
          <article className={`${styles.chartCard} ${styles.chart1}`}>
            <div className={styles.chartHead}>
              <div className={styles.headText}>
                <h3>Recommended Resource Deployment</h3>
              </div>
            </div>
            <div className={styles.chartBody}>
              <DashboardChart option={prescriptiveResourceOption} height={280} />
            </div>
          </article>
        )}
      </div>
    );
  }

  return (
    <section className={styles.page}>
      {/* Row A — global filters */}
      <div className={styles.filterRow}>
        <div className={styles.filterGroup}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-muted)" }}><rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.4" /><path d="M2 6h12" stroke="currentColor" strokeWidth="1.4" /><path d="M5.5 2V4M10.5 2V4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          <span className={styles.filterLabel}>Range</span>
          <div className={styles.segmented}>
            {(["3", "12", "all", "custom"] as const).map((m) => (
              <button key={m} className={rangeMode === m ? "active" : ""} onClick={() => setRangeMode(m)}>
                {rangeMode === m && <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                {m === "3" ? "3 mo" : m === "12" ? "12 mo" : m === "all" ? "All" : "Custom"}
              </button>
            ))}
          </div>
          {rangeMode === "custom" && (
            <DateRangePicker
              startDate={customFrom}
              endDate={customTo}
              onChange={(start, end) => {
                setCustomFrom(start);
                setCustomTo(end);
              }}
            />
          )}
        </div>

        <div className={styles.filterGroup}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-muted)" }}><path d="M4.5 11.5a3 3 0 1 1 .4-5.97 4 4 0 0 1 7.75 1.1A2.5 2.5 0 0 1 12 11.5H4.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M6 13.2v1M9 13.2v1M12 13.2v1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          <span className={styles.filterLabel}>Weather</span>
          <div className={styles.segmented}>
            {(["all", "dry", "wet"] as const).map((w) => (
              <button key={w} className={weather === w ? "active" : ""} onClick={() => setWeather(w)}>
                {weather === w && <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                {w === "all" ? "All" : w === "dry" ? "Dry" : "Wet"}
              </button>
            ))}
          </div>
        </div>

        {loading && data && <span className={styles.updating}>Updating…</span>}
        <span className={styles.spacer} />

        <div className={styles.modeTabs}>
          {(["Descriptive", "Predictive", "Prescriptive"] as const).map((t) => (
            <button key={t} className={`${styles.modeTab} ${activeTab === t ? styles.modeTabActive : ""}`} onClick={() => setActiveTab(t)}>
              {activeTab === t && <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 6, marginBottom: -1 }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Row B — KPI tiles */}
      <div className={styles.kpiRow}>
        <article className={styles.kpiTile}>
          <h3>Total Incidents</h3>
          <div className={styles.kpiValue}>{kpiValue(data ? fmtInt(data.kpis.totalIncidents) : null)}</div>
          <p className={styles.kpiHint}>
            {derived ? (
              <span className={derived.deltaPct <= 0 ? styles.deltaUp : styles.deltaDown}>{fmtPct(derived.deltaPct)}</span>
            ) : "—"}{" "}
            vs previous period
          </p>
        </article>
        <article className={styles.kpiTile}>
          <h3>Injuries</h3>
          <div className={styles.kpiValue}>{kpiValue(data ? fmtInt(data.kpis.injuries) : null)}</div>
          <p className={styles.kpiHint}>{data ? `${fmtInt(data.kpis.fatalities)} fatalities in range` : "—"}</p>
        </article>
        <article className={styles.kpiTile}>
          <h3>Avg Response Time</h3>
          <div className={styles.kpiValue}>{kpiValue(data?.kpis.avgResponseMin != null ? `${data.kpis.avgResponseMin} min` : null)}</div>
          <p className={styles.kpiHint}>reported → responder on scene</p>
        </article>
        <article className={styles.kpiTile}>
          <h3>Top Hotspot</h3>
          <div className={styles.kpiValue}>{kpiValue(derived?.topHotspot ? kmLabel(derived.topHotspot.km_bin) : null)}</div>
          <p className={styles.kpiHint}>
            {derived?.topHotspot && derived.hotspotTotal > 0
              ? `${((derived.topHotspot.total / derived.hotspotTotal) * 100).toFixed(1)}% of located incidents`
              : "—"}
          </p>
        </article>
        <article className={styles.kpiTile}>
          <h3>Crash Rate in Rain</h3>
          <div className={styles.kpiValue}>{kpiValue(derived?.rainMultiplier != null ? `${derived.rainMultiplier.toFixed(2)}×` : null)}</div>
          <p className={styles.kpiHint}>
            {derived ? `${derived.wetRate.toFixed(1)} vs ${derived.dryRate.toFixed(1)} crashes/day, wet vs dry` : "—"}
          </p>
        </article>
      </div>

      {/* Row C — hero: frequency story */}
      <article className={`${styles.chartCard} ${styles.chart1} ${styles.hero}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>Incident Trend</h3>
          </div>
        </div>
        <div className={styles.heroFilters}>
          <div className={styles.heroFilterGroup}>
            <span className={styles.heroFilterLabel}>Granularity</span>
            <div className={styles.segmentedSmall}>
              {(["daily", "weekly", "monthly"] as const).map((g) => (
                <button key={g} className={grain === g ? "active" : ""} onClick={() => setGrain(g)}>
                  {grain === g && <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                  {g.charAt(0).toUpperCase() + g.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className={styles.chartBody}>{chartFrame(trendOption, "No incident data for the selected filters", onTrendClick)}</div>
      </article>

      {/* Row D — frequency + location stories */}
      <article className={`${styles.chartCard} ${styles.chart2}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>When Incidents Happen</h3>
            {timeTakeaway && <p className={styles.subtitle}>{timeTakeaway}</p>}
          </div>
          <div className={styles.segmentedSmall}>
            {(["hour", "dow"] as const).map((v) => (
              <button key={v} className={timeView === v ? "active" : ""} onClick={() => setTimeView(v)}>
                {timeView === v && <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                {v === "hour" ? "By hour" : "By day"}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.chartBody}>{chartFrame(timeOption, "No data for the selected filters", onTimeClick)}</div>
      </article>

      <article className={`${styles.chartCard} ${styles.chart3}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>Hotspots by Km Segment</h3>
          </div>
          <button className={styles.secondaryButton} onClick={() => setAllHotspotsOpen(true)}>
            View all
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 12l4-4-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
        <div className={styles.chartBody}>{chartFrame(hotspotChart?.option ?? null, "No located incidents in range", onHotspotClick)}</div>
      </article>

      {/* Row E — severity + weather stories */}
      <article className={`${styles.chartCard} ${styles.chart4}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>{causeMode === "Causes" ? "Top Incident Causes" : "Top Accident Types"}</h3>
          </div>
          <div className={styles.segmentedSmall}>
            {(["Causes", "Types"] as const).map((m) => (
              <button key={m} className={causeMode === m ? "active" : ""} onClick={() => setCauseMode(m)}>
                {causeMode === m && <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.chartBody}>{chartFrame(causeChart?.option ?? null, "No data for the selected filters", onCauseClick)}</div>
      </article>

      <article className={`${styles.chartCard} ${styles.chart5}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>Incidents per Day: Dry vs Wet Weather</h3>
          </div>
        </div>
        <div className={styles.chartBody}>{chartFrame(weatherChart, "No weather data in range", onWeatherClick)}</div>
      </article>

      {/* Click-to-inspect detail modal */}
      {detail && (
        <div className={styles.detailBackdrop} role="dialog" aria-modal="true" aria-label={detail.title} onClick={() => setDetail(null)}>
          <div className={styles.detailModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.detailAccent} />
            <div className={styles.detailHeader}>
              <div className={styles.detailIcon}>🚨</div>
              <div className={styles.detailTitles}>
                <h3>{detail.title}</h3>
                {detail.subtitle && <p>{detail.subtitle}</p>}
              </div>
              <button className={styles.detailClose} onClick={() => setDetail(null)} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4.5 4.5L13.5 13.5M13.5 4.5L4.5 13.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </div>
            <div className={styles.detailBody}>
              {detail.rows.map(([k, v], i) => (
                <div key={k} className={`${styles.detailRow} ${i % 2 === 0 ? styles.detailRowAlt : ""}`}>
                  <span className={styles.detailKey}>{k}</span>
                  <span className={styles.detailVal}>{v}</span>
                </div>
              ))}
            </div>
            {detail.note && (
              <div className={styles.detailFooter}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" /><path d="M8 7v4M8 5.2v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                <p>{detail.note}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* View-all hotspots modal */}
      {allHotspotsOpen && data && derived && (
        <div className={styles.detailBackdrop} role="dialog" aria-modal="true" aria-label="All hotspots" onClick={() => setAllHotspotsOpen(false)}>
          <div className={`${styles.detailModal} ${styles.impactModal}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.detailAccent} />
            <div className={styles.detailHeader}>
              <div className={styles.detailIcon}>📍</div>
              <div className={styles.detailTitles}>
                <h3>Hotspots — Full Ranking</h3>
                <p>{data.hotspots.length} five-km segments · click a row for details</p>
              </div>
              <button className={styles.detailClose} onClick={() => setAllHotspotsOpen(false)} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4.5 4.5L13.5 13.5M13.5 4.5L4.5 13.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </div>
            <div className={styles.plazaTableWrap}>
              <table className={styles.plazaTable}>
                <thead>
                  <tr><th>#</th><th>Segment</th><th>Total</th><th>Road</th><th>Moto</th><th>Stalled</th><th>Injured</th><th>Fatal</th></tr>
                </thead>
                <tbody>
                  {data.hotspots.map((r, i) => (
                    <tr key={r.km_bin} className={styles.clickableRow} onClick={() => { setAllHotspotsOpen(false); showHotspotDetail(r); }}>
                      <td className={styles.plazaRank}>{i + 1}</td>
                      <td>{kmLabel(r.km_bin)}</td>
                      <td className={styles.plazaNum}>{fmtInt(r.total)}</td>
                      <td className={styles.plazaNum}>{fmtInt(r.road)}</td>
                      <td className={styles.plazaNum}>{fmtInt(r.moto)}</td>
                      <td className={styles.plazaNum}>{fmtInt(r.stalled)}</td>
                      <td className={styles.plazaNum}>{fmtInt(r.injuries)}</td>
                      <td className={styles.plazaNum}>{fmtInt(r.fatalities)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
