"use client";

import { useEffect, useMemo, useState } from "react";
import { attachCategoryClick } from "../../../lib/chart-click";
import { useChartTheme, applyChartTheme, seriesRamp, seriesPair } from "../../../lib/chart-theme";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { AlertTriangle, ArrowDownWideNarrow, ArrowUpNarrowWide, CloudRain, HeartPulse, MapPin, Timer } from "lucide-react";
import DashboardChart from "../../../components/dashboard/DashboardChart";
import ChartSkeleton, { KpiSkeleton } from "../../../components/dashboard/ChartSkeleton";
import PageHeader from "../../../components/dashboard/PageHeader";
import PredictiveIncidentChart from "../../../components/dashboard/PredictiveIncidentChart";
import DateRangePicker from "../traffic/components/DateRangePicker";
import { rangeDays, grainBlockedReason, bestGrainFor, axisLabelFor, bucketLabelFor } from "../../../lib/granularity";
import styles from "../traffic/traffic.module.css";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";


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
  // Chart furniture follows the active theme; series hues stay fixed.
  const chartTheme = useChartTheme();

  /* This tab's colour family. The ramp is ordinal — lightest to darkest — and
     both modes are selected steps validated against their own surface, not an
     automatic flip. A pair of nominal series takes the outer two steps, which is
     where the separation margin lives. See lib/chart-theme. */
  const RAMP = seriesRamp("incident", chartTheme);
  const [PAIR_A, PAIR_B] = seriesPair("incident", chartTheme);
  const SEQ = [chartTheme.seqLightest, ...RAMP];
  const [activeTab, setActiveTab] = useState<"Descriptive" | "Predictive" | "Prescriptive">("Descriptive");

  // Global filters
  const [rangeMode, setRangeMode] = useState<RangeMode>("12");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [weather, setWeather] = useState<WeatherFilter>("all");

  // Chart-local interactivity
  const [hotspotSort, setHotspotSort] = useState<"desc" | "asc">("desc");
  const [causeSort, setCauseSort] = useState<"desc" | "asc">("desc");
  const [grain, setGrain] = useState<Granularity>("monthly");
  const [timeView, setTimeView] = useState<"hour" | "dow">("hour");
  const [causeMode, setCauseMode] = useState<"Causes" | "Types">("Causes");
  const [allHotspotsOpen, setAllHotspotsOpen] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);

  const [data, setData] = useState<Analytics | null>(null);
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

  /* How long a window is on screen, and what that allows.

     Measured from the range the API resolved rather than the raw custom inputs,
     so the 3-month and 12-month presets are governed by the same rule. */
  const spanDays = rangeDays(data?.range.from, data?.range.to);

  // A grain that stops being possible is demoted rather than left selected: the
  // control disables it, so without this the chart would sit on an impossible
  // bucket with no way to change it.
  useEffect(() => {
    if (spanDays == null) return;
    if (grainBlockedReason(grain, spanDays)) {
      setGrain(bestGrainFor(spanDays, false) as typeof grain);
    }
  }, [spanDays, grain]);

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

    const series = [mk("Road crashes", "road", RAMP[2]), mk("Motorcycle crashes", "moto", RAMP[1]), mk("Stalled vehicles", "stalled", RAMP[0])];

    return {
      grid: { left: 52, right: 16, top: 10, bottom: 52 },
      xAxis: { type: "category", data: labels, axisLabel: { formatter: axisLabelFor(grain), interval: labelInterval, fontSize: 10, hideOverlap: true }, axisTick: { show: false } },
      yAxis: { type: "value", splitNumber: 3, axisLabel: { fontSize: 10 } },
      tooltip: { trigger: "axis", axisPointer: { label: { formatter: (o) => bucketLabelFor(grain)(String((o as { value: unknown }).value)) } }, valueFormatter: (v) => (v == null ? "—" : fmtInt(Number(v))) },
      legend: { show: true, bottom: 0, left: "center", itemWidth: 14, itemHeight: 8, itemGap: 18, padding: 0, textStyle: { fontSize: 11 } },
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
        grid: { left: 44, right: 16, top: 10, bottom: 54 },
        xAxis: { type: "category", boundaryGap: false, data: Array.from({ length: 24 }, (_, h) => fmtHour(h)), axisLabel: { interval: 3, fontSize: 10 }, axisTick: { show: false } },
        yAxis: { type: "value", name: "avg incidents / day", nameGap: 10, nameTextStyle: { fontSize: 9, align: "left" }, splitNumber: 3, axisLabel: { fontSize: 10 } },
        tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : `${fmt1(Number(v))} / day`) },
        legend: { show: true, bottom: 0, left: "center", itemWidth: 14, itemHeight: 8, itemGap: 18, padding: 0, textStyle: { fontSize: 11 } },
        series: [
          {
            name: "Weekdays",
            type: "line",
            data: timeProfile.weekday.map((v) => Number(v.toFixed(2))),
            symbol: "none",
            smooth: true,
            itemStyle: { color: RAMP[2] },
            lineStyle: { width: 2.5, color: RAMP[2] },
            markPoint: {
              symbol: "circle",
              symbolSize: 8,
              itemStyle: { color: RAMP[2], borderColor: "#fff", borderWidth: 2 },
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
            itemStyle: { color: RAMP[0] },
            lineStyle: { width: 2.5, color: RAMP[0] },
          },
        ],
      };
    }

    const maxIdx = timeProfile.busiestDow;
    return {
      grid: { left: 44, right: 16, top: 10, bottom: 54 },
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
            itemStyle: { color: i === maxIdx ? RAMP[2] : RAMP[0], borderRadius: [4, 4, 0, 0] },
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
    const display = hotspotSort === "desc" ? [...top].reverse() : [...top];
    const maxV = top[0]?.total ?? 1;
    return {
      rows: display,
      option: {
        grid: { left: 84, right: 46, top: 8, bottom: 46 },
        xAxis: { type: "value", splitNumber: 3, axisLabel: { fontSize: 10 } },
        yAxis: { type: "category", data: display.map((r) => kmLabel(r.km_bin)), axisLabel: { interval: 0, fontSize: 10 }, axisTick: { show: false } },
        tooltip: {
          axisPointer: { type: "shadow" },
          formatter: (p) => {
            const i = (p as { dataIndex: number }).dataIndex;
            const r = display[i];
            return `<b>${kmLabel(r.km_bin)}</b><br/>${fmtInt(r.total)} incidents · ${fmtInt(r.injuries)} injured · ${fmtInt(r.fatalities)} fatalities`;
          },
        },
        legend: { show: true, bottom: 0, left: "center", itemWidth: 14, itemHeight: 8, itemGap: 18, padding: 0, textStyle: { fontSize: 11 } },
        series: [
          {
            name: "Incidents by segment",
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
  }, [data, hotspotSort]);

  const causeChart = useMemo<{ option: EChartsOption; rows: Analytics["causes"] } | null>(() => {
    if (!data) return null;
    const src = causeMode === "Causes" ? data.causes : data.types;
    if (src.length === 0) return null;
    const top = src.slice(0, 9);
    const display = causeSort === "desc" ? [...top].reverse() : [...top];
    return {
      rows: display,
      option: {
        grid: { left: 150, right: 42, top: 8, bottom: 46 },
        xAxis: { type: "value", splitNumber: 3, axisLabel: { fontSize: 10 } },
        yAxis: { type: "category", data: display.map((r) => (r.label.length > 24 ? `${r.label.slice(0, 24)}…` : r.label)), axisLabel: { interval: 0, fontSize: 10 }, axisTick: { show: false } },
        tooltip: {
          axisPointer: { type: "shadow" },
          formatter: (p) => {
            const i = (p as { dataIndex: number }).dataIndex;
            const r = display[i];
            return `<b>${r.label}</b><br/>${fmtInt(r.total)} incidents · ${fmtInt(r.injuries)} injured · ${fmtInt(r.fatalities)} fatalities`;
          },
        },
        legend: { show: true, bottom: 0, left: "center", itemWidth: 14, itemHeight: 8, itemGap: 18, padding: 0, textStyle: { fontSize: 11 } },
        series: [
          {
            name: "Incidents",
            type: "bar",
            data: display.map((r) => ({ value: r.total, itemStyle: { color: RAMP[0], borderRadius: [0, 3, 3, 0] } })),
            barMaxWidth: 12,
            barCategoryGap: "25%",
          },
        ],
      },
    };
  }, [data, causeMode, causeSort]);

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
      grid: { left: 52, right: 16, top: 10, bottom: 68 },
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
      legend: { show: true, bottom: 0, left: "center", itemWidth: 14, itemHeight: 8, itemGap: 18, padding: 0, textStyle: { fontSize: 11 } },
      series: [
        { name: "Dry weather", type: "bar", data: keys.map((k) => rate(w.incidents.dry[k], w.dryHours)), itemStyle: { color: RAMP[2], borderRadius: [3, 3, 0, 0] }, barMaxWidth: 26 },
        { name: "Wet weather", type: "bar", data: keys.map((k) => rate(w.incidents.wet[k], w.wetHours)), itemStyle: { color: RAMP[0], borderRadius: [3, 3, 0, 0] }, barMaxWidth: 26 },
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
    if (loading && !data) return <ChartSkeleton />;
    if (error) return <div className={styles.placeholder}>Live data unavailable — is the backend running on port 4000?</div>;
    if (!option) return <div className={styles.placeholder}>{emptyNote}</div>;
    return (
      <ReactECharts
        option={applyChartTheme(option, chartTheme)}
        notMerge
        lazyUpdate
        style={{ width: "100%", height: "100%" }}
        opts={{ renderer: "canvas" }}
        onEvents={onClick ? { click: onClick as (p: unknown) => void } : undefined}
        // Lines are drawn with symbol:"none", so they have no clickable points
        // and ECharts' item click never fires with the right index. Resolve the
        // category from the cursor position instead.
        onChartReady={
          onClick
            ? (chart) => attachCategoryClick(chart as never, onClick as never)
            : undefined
        }
      />
    );
  };

  // A skeleton rather than an ellipsis: the tile keeps its height, so the KPI
  // row does not resize under the cursor as the numbers arrive.
  const kpiValue = (v: string | null) =>
    loading && !data ? <KpiSkeleton /> : (v ?? "—");

  // ---------- Global filter controls ----------
  // Rendered on both the Descriptive shell and the Predictive one so the strip
  // above the page means the same thing whichever tab is open. Defined once
  // rather than duplicated, so a change to Range or Weather can't drift between
  // the two branches.
  const rangeFilter = (
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
          minDate={data?.meta.minDate}
          maxDate={data?.meta.maxDate}
          endDate={customTo}
          onChange={(start, end) => {
            setCustomFrom(start);
            setCustomTo(end);
          }}
        />
      )}
    </div>
  );

  const weatherFilter = (
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
  );

  // ---------- Predictive / Prescriptive share the same shell ----------
  if (activeTab !== "Descriptive") {
    return (
      <section className={`${styles.page} viz-incident`}>
        <PageHeader icon={AlertTriangle} title="Incident Overview" subtitle="Road crashes, hazards, and response patterns across NLEX" />
        <div className={styles.filterRow}>
          {activeTab === "Predictive" && (
            <>
              {rangeFilter}
              {weatherFilter}
            </>
          )}
          {activeTab === "Prescriptive" && <span className={styles.filterLabel}>Recommended resource allocation</span>}
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
          // Filters above are display-only on this tab for now — the chart keeps
          // its original fixed window. Pass months/from/to/weather through to
          // wire them up; the API and the component already accept them.
          <div className={styles.spanFull}>
            <PredictiveIncidentChart />
          </div>
        ) : (
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
      </section>
    );
  }

  return (
    <section className={`${styles.page} viz-incident`}>
      <PageHeader icon={AlertTriangle} title="Incident Overview" subtitle="Road crashes, hazards, and response patterns across NLEX" />

      {/* Row A — global filters */}
      <div className={styles.filterRow}>
        {rangeFilter}
        {weatherFilter}

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
          <span className={styles.kpiIcon} aria-hidden="true"><AlertTriangle size={15} /></span>
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
          <span className={styles.kpiIcon} aria-hidden="true"><HeartPulse size={15} /></span>
          <h3>Injuries</h3>
          <div className={styles.kpiValue}>{kpiValue(data ? fmtInt(data.kpis.injuries) : null)}</div>
          <p className={styles.kpiHint}>{data ? `${fmtInt(data.kpis.fatalities)} fatalities in range` : "—"}</p>
        </article>
        <article className={styles.kpiTile}>
          <span className={styles.kpiIcon} aria-hidden="true"><Timer size={15} /></span>
          <h3>Avg Response Time</h3>
          <div className={styles.kpiValue}>{kpiValue(data?.kpis.avgResponseMin != null ? `${data.kpis.avgResponseMin} min` : null)}</div>
          <p className={styles.kpiHint}>reported → responder on scene</p>
        </article>
        <article className={styles.kpiTile}>
          <span className={styles.kpiIcon} aria-hidden="true"><MapPin size={15} /></span>
          <h3>Top Hotspot</h3>
          <div className={styles.kpiValue}>{kpiValue(derived?.topHotspot ? kmLabel(derived.topHotspot.km_bin) : null)}</div>
          <p className={styles.kpiHint}>
            {derived?.topHotspot && derived.hotspotTotal > 0
              ? `${((derived.topHotspot.total / derived.hotspotTotal) * 100).toFixed(1)}% of located incidents`
              : "—"}
          </p>
        </article>
        <article className={styles.kpiTile}>
          <span className={styles.kpiIcon} aria-hidden="true"><CloudRain size={15} /></span>
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
                <button
                  key={g}
                  className={grain === g ? "active" : ""}
                  disabled={Boolean(grainBlockedReason(g, spanDays))}
                  title={grainBlockedReason(g, spanDays) ?? undefined}
                  onClick={() => setGrain(g)}
                >
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
          <button
            type="button"
            className={styles.sortBtn}
            onClick={() => setHotspotSort(hotspotSort === "desc" ? "asc" : "desc")}
            title={hotspotSort === "desc" ? "Sorted highest first — click for lowest first" : "Sorted lowest first — click for highest first"}
            aria-label={`Sort order: ${hotspotSort === "desc" ? "highest first" : "lowest first"}. Activate to reverse.`}
          >
            {hotspotSort === "desc" ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
          </button>
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
          <button
            type="button"
            className={styles.sortBtn}
            onClick={() => setCauseSort(causeSort === "desc" ? "asc" : "desc")}
            title={causeSort === "desc" ? "Sorted highest first — click for lowest first" : "Sorted lowest first — click for highest first"}
            aria-label={`Sort order: ${causeSort === "desc" ? "highest first" : "lowest first"}. Activate to reverse.`}
          >
            {causeSort === "desc" ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
          </button>
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
