"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { attachCategoryClick } from "../../../lib/chart-click";
import { useChartTheme, applyChartTheme, seriesRamp, seriesPair } from "../../../lib/chart-theme";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { Activity, ArrowDownWideNarrow, ArrowUpNarrowWide, Building2, CalendarClock, Clock, Gauge, TrendingUp } from "lucide-react";
import { VolumeStaffingPanel, CongestionResponsePanel, EventInterventionPanel } from "../../../components/dashboard/PrescriptiveTrafficPanels";
import ForecastGlance from "../../../components/dashboard/ForecastGlance";
import ChartSkeleton, { KpiSkeleton } from "../../../components/dashboard/ChartSkeleton";
import CustomSelect from "../../../components/dashboard/CustomSelect";
import RampKey from "../../../components/dashboard/RampKey";
import PageHeader from "../../../components/dashboard/PageHeader";
import PredictiveVolumeChart from "../../../components/dashboard/PredictiveVolumeChart";
import PredictiveCongestionChart from "../../../components/dashboard/PredictiveCongestionChart";
import PredictiveEventChart from "../../../components/dashboard/PredictiveEventChart";
import styles from "./traffic.module.css";
import DateRangePicker from "./components/DateRangePicker";
import { rangeDays, grainBlockedReason, bestGrainFor, axisLabelFor, bucketLabelFor } from "../../../lib/granularity";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";


const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Postgres dow (0=Sun) -> Mon-first

// ---------- Data contract ----------
type Analytics = {
  range: { from: string; to: string };
  meta: { plazas: string[]; minDate: string; maxDate: string };
  kpis: {
    totalVolume: number;
    prevTotalVolume: number;
    days: number;
    prevDays: number;
    congestionIndex: number | null;
    prevCongestionIndex: number | null;
  };
  dailyTrend: { d: string; nb: number; sb: number }[];
  hourlyTrend: { d: string; hour: number; nb: number; sb: number }[] | null;
  byPlaza: { plaza: string; v: number }[];
  hourDow: { dow: number; hour: number; v: number }[];
  speedByHour: { hour: number; speed: number; jam_level: number }[];
  eventImpact: {
    label: string; date: string; dayVolume: number; baseline: number; deviationPct: number | null;
    plaza?: string; venueExit?: string; eventCount?: number; attendance?: number | null; onHoliday?: boolean; baselineDays?: number;
  }[];
  holidayImpact: {
    label: string; deviationPct: number; occurrences: number; baseline: number; volume: number;
    holidayType?: string; minBaselineDays?: number;
  }[];
  holidayYearly: { label: string; year: number; pct: number; volume: number }[];
};

type Granularity = "hourly" | "daily" | "weekly" | "monthly";
type RangeMode = "3" | "12" | "all" | "custom";
type Direction = "Both" | "NB" | "SB";
type VehicleClass = "All" | "Class 1" | "Class 2" | "Class 3";

// Click-to-inspect popup content
type Detail = { title: string; subtitle?: string; rows: [string, string][]; note?: string };

const weekdayOf = (dateStr: string) =>
  new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" });

// ---------- Formatting ----------
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtCompact = (n: number) =>
  Math.abs(n) >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : Math.abs(n) >= 10_000 ? `${(n / 1_000).toFixed(0)}K` : fmtInt(n);
const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);
const fmtPct = (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;

function movingAverage(values: number[], window: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < window - 1) return null;
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += values[j];
    return Math.round(sum / window);
  });
}

function weekStart(dateStr: string): string {
  const dt = new Date(`${dateStr}T00:00:00`);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); // back to Monday
  return dt.toISOString().slice(0, 10);
}

type TrendRow = { label: string; nb: number; sb: number; total: number };

function buildTrend(data: Analytics, grain: Granularity): TrendRow[] {
  if (grain === "hourly") {
    return (data.hourlyTrend ?? []).map((r) => ({
      label: `${r.d} ${String(r.hour).padStart(2, "0")}:00`,
      nb: r.nb,
      sb: r.sb,
      total: r.nb + r.sb,
    }));
  }
  if (grain === "daily") {
    return data.dailyTrend.map((r) => ({ label: r.d, nb: r.nb, sb: r.sb, total: r.nb + r.sb }));
  }
  const keyOf = grain === "weekly" ? (d: string) => weekStart(d) : (d: string) => d.slice(0, 7);
  const acc = new Map<string, { nb: number; sb: number }>();
  for (const r of data.dailyTrend) {
    const k = keyOf(r.d);
    const cur = acc.get(k) ?? { nb: 0, sb: 0 };
    acc.set(k, { nb: cur.nb + r.nb, sb: cur.sb + r.sb });
  }
  return [...acc.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([label, v]) => ({ label, nb: v.nb, sb: v.sb, total: v.nb + v.sb }));
}

const ROLLING_WINDOW: Record<Granularity, number> = { hourly: 24, daily: 7, weekly: 0, monthly: 0 };

export default function TrafficPage() {
  // Chart furniture follows the active theme; series hues stay fixed.
  const chartTheme = useChartTheme();

  /* This tab's colour family. The ramp is ordinal — lightest to darkest — and
     both modes are selected steps validated against their own surface, not an
     automatic flip. A pair of nominal series takes the outer two steps, which is
     where the separation margin lives. See lib/chart-theme. */
  const RAMP = seriesRamp("traffic", chartTheme);
  const [PAIR_A, PAIR_B] = seriesPair("traffic", chartTheme);
  const SEQ = [chartTheme.seqLightest, ...RAMP];
  // Speed is a status reading, not a series, so it keeps the reserved
  // good/warning/critical colours rather than the tab hue.
  const SEVERITY = ["#d0483e", "#e8a13a", "#1d9d61"];
  const [activeTab, setActiveTab] = useState<"Descriptive" | "Predictive" | "Prescriptive">("Descriptive");

  // Global filters (Row A)
  const [rangeMode, setRangeMode] = useState<RangeMode>("12");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [plazaSel, setPlazaSel] = useState<string[]>([]); // empty = All
  const [direction, setDirection] = useState<Direction>("Both");
  const [vClass, setVClass] = useState<VehicleClass>("All");
  const [weather, setWeather] = useState<"all" | "dry" | "wet">("all");

  // Chart-local interactivity
  const [plazaSort, setPlazaSort] = useState<"desc" | "asc">("desc");
  const [impactSort, setImpactSort] = useState<"desc" | "asc">("desc");
  const [grain, setGrain] = useState<Granularity>("daily");
  const [splitDirection, setSplitDirection] = useState(false);
  const [impactMode, setImpactMode] = useState<"Events" | "Holidays">("Holidays");
  const [allPlazasOpen, setAllPlazasOpen] = useState(false);
  const [impactListOpen, setImpactListOpen] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);

  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Custom mode waits until both dates are picked
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
    if (plazaSel.length > 0) qs.set("plazas", plazaSel.join(","));
    if (vClass !== "All") qs.set("vehicleClass", vClass);
    if (weather !== "all") qs.set("weather", weather);
    fetch(`${BACKEND}/api/traffic/analytics?${qs}`, { cache: "no-store" })
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
  }, [rangeMode, customFrom, customTo, plazaSel, vClass, weather]);

  // Hourly grain exists only when the server shipped hourly rows (spans <= ~3 months)
  const hourlyAvailable = !!data?.hourlyTrend;
  useEffect(() => {
    if (grain === "hourly" && data && !data.hourlyTrend) setGrain("daily");
  }, [data, grain]);

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
      setGrain(bestGrainFor(spanDays, hourlyAvailable) as typeof grain);
    }
  }, [spanDays, grain, hourlyAvailable]);

  // ---------- Derived values ----------
  const derived = useMemo(() => {
    if (!data) return null;
    const { kpis, dailyTrend, byPlaza, hourDow } = data;

    const curAdt = kpis.days > 0 ? kpis.totalVolume / kpis.days : 0;
    const prevAdt = kpis.prevDays > 0 ? kpis.prevTotalVolume / kpis.prevDays : 0;
    const volumeDeltaPct = prevAdt > 0 ? ((curAdt - prevAdt) / prevAdt) * 100 : 0;

    const weekdayByHour = new Map<number, { sum: number; n: number }>();
    for (const r of hourDow) {
      if (r.dow === 0 || r.dow === 6) continue;
      const cur = weekdayByHour.get(r.hour) ?? { sum: 0, n: 0 };
      weekdayByHour.set(r.hour, { sum: cur.sum + r.v, n: cur.n + 1 });
    }
    let peakHour = 0;
    let peakHourVolume = 0;
    for (const [h, b] of weekdayByHour) {
      const avg = b.sum / b.n;
      if (avg > peakHourVolume) {
        peakHourVolume = avg;
        peakHour = h;
      }
    }

    const plazaTotal = byPlaza.reduce((s, r) => s + r.v, 0);
    const busiest = byPlaza[0];

    const congestionDelta =
      kpis.congestionIndex != null && kpis.prevCongestionIndex != null
        ? kpis.congestionIndex - kpis.prevCongestionIndex
        : null;

    const sparkline = dailyTrend.slice(-30).map((r) => r.nb + r.sb);

    return { curAdt, volumeDeltaPct, peakHour, peakHourVolume, busiest, plazaTotal, congestionDelta, sparkline };
  }, [data]);

    // ---------- Chart options ----------
  const trendRows = useMemo(() => (data ? buildTrend(data, grain) : []), [data, grain]);

  const trendOption = useMemo<EChartsOption | null>(() => {
    if (!data) return null;
    const rows = trendRows;
    if (rows.length === 0) return null;
    const window = ROLLING_WINDOW[grain];
    const labels = rows.map((r) => r.label);

    // Show an x label only where the period changes (month for daily/weekly,
    // day for hourly) — no repeated labels.
    const boundaryKey =
      grain === "hourly" ? (l: string) => l.slice(0, 10) : grain === "monthly" ? (l: string) => l : (l: string) => l.slice(0, 7);
    const labelInterval = (index: number) =>
      index === 0 || boundaryKey(labels[index]) !== boundaryKey(labels[index - 1]);
    const axisFmt = axisLabelFor(grain);

    // The raw series behind a moving average is context, not a second identity,
    // so it takes the ramp's lightest step rather than a hue of its own.
    const FAINT = RAMP[0];
    const nbLine = { name: "Northbound", type: "line" as const, data: rows.map((r) => r.nb), symbol: "none" as const, itemStyle: { color: PAIR_A }, lineStyle: { width: 2.5, color: PAIR_A }, endLabel: { show: true, formatter: "NB", color: PAIR_A, fontWeight: 700 } };
    const sbLine = { name: "Southbound", type: "line" as const, data: rows.map((r) => r.sb), symbol: "none" as const, itemStyle: { color: PAIR_B }, lineStyle: { width: 2.5, color: PAIR_B }, endLabel: { show: true, formatter: "SB", color: PAIR_B, fontWeight: 700 } };

    const series: EChartsOption["series"] = splitDirection
      // Direction picks which carriageway to keep. Both data series are already
      // in hand, so this is a choice about what to draw, not another request.
      ? direction === "NB" ? [nbLine] : direction === "SB" ? [sbLine] : [nbLine, sbLine]
      : window > 0
        ? [
          { name: grain === "hourly" ? "Hourly volume" : "Daily volume", type: "line", data: rows.map((r) => r.total), symbol: "none", itemStyle: { color: FAINT }, lineStyle: { width: 1, color: FAINT } },
          { name: `${window === 24 ? "24-hour" : "7-day"} average`, type: "line", data: movingAverage(rows.map((r) => r.total), window), symbol: "none", itemStyle: { color: PAIR_A }, lineStyle: { width: 3, color: PAIR_A } },
        ]
        : [{ name: "Volume", type: "line", data: rows.map((r) => r.total), symbol: rows.length <= 24 ? "circle" : "none", symbolSize: 7, itemStyle: { color: PAIR_A }, lineStyle: { width: 3, color: PAIR_A } }];

    // Hoisted: the grid should reserve the bottom strip only when the legend is
    // actually drawn in it, and both need the same answer.
    const showLegend = (splitDirection && direction === "Both") || window > 0;

    return {
      grid: { left: 52, right: splitDirection ? 44 : 16, top: 14, bottom: showLegend ? 52 : 26 },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { formatter: axisFmt, interval: labelInterval, fontSize: 10, hideOverlap: true },
        axisTick: { show: false },
      },
      // scale:true so the weekly rhythm is visible instead of a flat line on a zero base
      yAxis: { type: "value", scale: true, splitNumber: 3, axisLabel: { formatter: (v: number) => fmtCompact(v), fontSize: 10 } },
      tooltip: { trigger: "axis", axisPointer: { label: { formatter: (o) => bucketLabelFor(grain)(String((o as { value: unknown }).value)) } }, valueFormatter: (v) => (v == null ? "—" : fmtInt(Number(v))) },
      // A legend whenever there is more than one line. The old condition hid it
      // precisely when the chart split into northbound and southbound — the case
      // that needs it most, since two lines with no key are unreadable.
      // Split down to one carriageway leaves a single line, which its own end
      // label already names — a one-item legend would just be furniture.
      legend: { show: showLegend, bottom: 0, left: "center", itemWidth: 14, itemHeight: 8, itemGap: 18, padding: 0, textStyle: { fontSize: 11 } },
      series,
    };
  }, [data, grain, splitDirection, direction, trendRows]);

  const heatmapOption = useMemo<EChartsOption | null>(() => {
    if (!data || data.hourDow.length === 0) return null;
    const heatData: [number, number, number][] = data.hourDow.map((r) => [r.hour, DOW_ORDER.indexOf(r.dow), r.v]);
    const heatMax = Math.max(...data.hourDow.map((r) => r.v));
    return {
      // Legend lives in a slim strip below the plot, never on it
      grid: { left: 40, right: 10, top: 6, bottom: 26 },
      xAxis: { type: "category", data: Array.from({ length: 24 }, (_, h) => fmtHour(h)), splitArea: { show: true }, axisLabel: { interval: 3, fontSize: 10 }, axisTick: { show: false } },
      // inverse:true puts Mon at the top, Sun at the bottom
      yAxis: { type: "category", data: DOW_LABELS, inverse: true, splitArea: { show: true }, axisLabel: { interval: 0, fontSize: 10 }, axisTick: { show: false } },
      tooltip: {
        formatter: (p) => {
          const v = (p as unknown as { value: [number, number, number] }).value;
          return `${DOW_LABELS[v[1]]} ${fmtHour(v[0])}<br/><b>${fmtInt(v[2])}</b> vehicles/hr on average`;
        },
      },
      visualMap: {
        show: false,
        type: "continuous",
        min: 0,
        max: heatMax,
        calculable: false,
        // The lightest step is the theme's 'empty' tone: near-white on light,
        // near-black on dark, so low values recede in both instead of glowing.
        inRange: { color: [chartTheme.seqLightest, ...SEQ.slice(1)] },
        // The same neutral the speed chart uses when scrubbed. Keeping the ramp
        // at low opacity left every cell a slightly different washed-out blue,
        // which on the dark surface turned the grid into grey-blue mud and made
        // the highlighted cells harder to pick out, not easier. One flat grey
        // gives the lit band something uniform to stand against.
        outOfRange: { color: chartTheme.axis },
        formatter: (v) => fmtCompact(Number(v)),
      },
      series: [{ type: "heatmap", data: heatData, emphasis: { itemStyle: { borderColor: RAMP[2], borderWidth: 1 } } }],
    };
    // chartTheme is a dependency because the ramp's lightest step comes from it.
  }, [data, chartTheme]);

  const plazaChart = useMemo<{
    option: EChartsOption;
    rows: { plaza: string; v: number; isOthers: boolean }[];
    others: { plaza: string; v: number }[];
  } | null>(() => {
    if (!data || data.byPlaza.length === 0) return null;
    const top = data.byPlaza.slice(0, 10).map((r) => ({ ...r, isOthers: false }));
    const others = data.byPlaza.slice(10);
    const othersSum = others.reduce((s, r) => s + r.v, 0);
    // `top` arrives largest-first. A category axis draws index 0 at the bottom,
    // so reversing puts the largest at the top ("highest first") and leaving it
    // as-is puts the smallest there ("lowest first").
    const ranked = plazaSort === "desc" ? [...top].reverse() : [...top];
    // "Others" is a residual bucket, not a plaza, so it is pinned to the bottom
    // rather than sorted with the rest. Ranking it alongside them sent it to the
    // top in ascending order, where the largest bar on the chart sat in the slot
    // that means "smallest".
    const othersRow = { plaza: `Others (${others.length})`, v: othersSum, isOthers: true };
    const display = othersSum > 0 ? [othersRow, ...ranked] : ranked;
    const rows = display;
    // Scaled against the largest real plaza, not against the Others total.
    const maxV = top[0]?.v ?? 1;
    return {
      rows: display,
      others,
      option: {
        grid: { left: 120, right: 46, top: 8, bottom: 18 },
        xAxis: { type: "value", splitNumber: 3, axisLabel: { formatter: (v: number) => fmtCompact(v), fontSize: 10 } },
        // interval:0 — every plaza name must be readable, that IS the chart
        yAxis: { type: "category", data: display.map((r) => r.plaza), axisLabel: { interval: 0, fontSize: 10 }, axisTick: { show: false } },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v) => `${fmtInt(Number(v))} vehicles` },
        /* No legend. There is one series, so it drew a single chip reading
           "Volume by plaza" beneath a chart whose axis already says that, and
           the bars are shaded on a four-step sequential ramp, so its lone
           swatch matched no bar in particular and implied a category that does
           not exist. The strip it held is returned to the plot. */
        series: [
          {
            name: "Volume by plaza",
            type: "bar",
            data: display.map((r) => ({
              value: r.v,
              itemStyle: {
                // The residual bucket is neutral. On the ramp it came out darkest
                // of all — the shade this chart uses for the busiest plaza — which
                // is the wrong signal for a row that is not a plaza at all.
                color: r.isOthers
                  ? chartTheme.axis
                  : SEQ[Math.min(3, 1 + Math.floor((r.v / maxV) * 2.99))],
                borderRadius: [0, 3, 3, 0],
              },
            })),
            barMaxWidth: 12,
            barCategoryGap: "25%",
          },
        ],
      },
    };
  }, [data, plazaSort, chartTheme]);

  const speedOption = useMemo<EChartsOption | null>(() => {
    if (!data || data.speedByHour.length === 0) return null;
    const speeds = data.speedByHour.map((r) => r.speed);
    // Framed on the data rather than on zero. Every hour here sits well under the
    // 20 km/h congestion threshold, so an axis stretched to hold that line spent
    // most of its height on empty space the readings never reach.
    const lo = Math.max(0, Math.floor(Math.min(...speeds)) - 1);
    const hi = Math.ceil(Math.max(...speeds)) + 1;
    return {
      grid: { left: 36, right: 14, top: 10, bottom: 26 },
      xAxis: { type: "category", data: data.speedByHour.map((r) => fmtHour(r.hour)), axisLabel: { interval: 3, fontSize: 10 }, axisTick: { show: false } },
      yAxis: { type: "value", min: lo, max: hi, splitNumber: 4, axisLabel: { formatter: "{value}", fontSize: 10 }, name: "km/h", nameGap: 6, nameTextStyle: { fontSize: 10 } },
      tooltip: {
        trigger: "axis",
        formatter: (p) => {
          const item = (p as { dataIndex: number }[])[0];
          const r = data.speedByHour[item.dataIndex];
          return `${fmtHour(r.hour)}<br/>Avg speed in jams: <b>${r.speed} km/h</b><br/>Avg jam level: ${r.jam_level} / 5`;
        },
      },
      visualMap: {
        show: false, type: "continuous", seriesIndex: 0, calculable: false,
        min: Math.min(...speeds), max: Math.max(...speeds), inRange: { color: SEVERITY },
        // Scrubbing greys the rest of the line out. A neutral reads more clearly
        // as "not this" on a single line than a washed-out version of the same
        // ramp, which just looks like a lighter reading.
        outOfRange: { color: chartTheme.axis },
      },
      series: [
        {
          type: "line",
          data: speeds,
          smooth: 0.35,
          symbol: "circle",
          symbolSize: 7,
          // A ring around each point so it stays visible where the line runs
          // through a step of the same colour.
          itemStyle: { borderColor: chartTheme.tooltipBg, borderWidth: 1.5 },
          lineStyle: { width: 3.5 },
        },
      ],
    };
  }, [data, chartTheme]);

  type ImpactRow = {
    label: string;
    full: string;
    pct: number;
    baseline?: number;
    volume?: number;
    event?: Analytics["eventImpact"][number];
    holiday?: Analytics["holidayImpact"][number];
  };

  const impactChart = useMemo<{ option: EChartsOption; rows: ImpactRow[] } | null>(() => {
    if (!data) return null;
    const rows: ImpactRow[] =
      impactMode === "Events"
        ? data.eventImpact
          .filter((e) => e.deviationPct != null)
          .map((e) => ({ label: `${e.label.length > 17 ? `${e.label.slice(0, 17)}…` : e.label} · ${e.date.slice(5)}`, full: `${e.label} (${e.date})`, pct: e.deviationPct as number, event: e, baseline: e.baseline, volume: e.dayVolume }))
        : data.holidayImpact.map((h) => ({ label: h.label.length > 22 ? `${h.label.slice(0, 22)}…` : h.label, full: `${h.label} · ${h.occurrences} occurrence(s)`, pct: h.deviationPct, holiday: h, baseline: h.baseline, volume: h.volume }));
    if (rows.length === 0) return null;
    // Only the most-deviant entries fit legibly in the card; the rest add noise
    const display = [...rows]
      .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
      .slice(0, 9)
      .sort((a, b) => (impactSort === "desc" ? a.pct - b.pct : b.pct - a.pct));
    return {
      rows: display,
      option: {
        grid: { left: 128, right: 42, top: 8, bottom: 46 },
        xAxis: { type: "value", splitNumber: 3, axisLabel: { formatter: (v: number) => `${v}%`, fontSize: 10 } },
        yAxis: { type: "category", data: display.map((r) => r.label), axisLabel: { interval: 0, fontSize: 10 }, axisTick: { show: false } },
        tooltip: {
          axisPointer: { type: "shadow" },
          formatter: (p) => {
            const i = (p as { dataIndex: number }).dataIndex;
            const r = display[i];
            let tip = `<b>${r.full}</b><br/>${fmtPct(r.pct)} vs same-weekday baseline`;
            if (r.baseline != null && r.baseline > 0) {
              tip += `<br/>Baseline: <b>${fmtInt(r.baseline)}</b> vehicles`;
            }
            if (r.volume != null && r.volume > 0) {
              tip += `<br/>Actual: <b>${fmtInt(r.volume)}</b> vehicles`;
            }
            return tip;
          },
        },
        /* Named explicitly, and not clickable.
           The legend listed every series it could find, so "Deviation" - the
           series that draws the real bars - sat in the key beside the two
           colour labels wearing a palette colour that appears on no bar.
           Clicking made it worse: hiding "Deviation" blanked the chart, while
           hiding either colour label did nothing at all, since those two
           series carry no data. This is a key, not a filter, so it names the
           two colours and ignores clicks. */
        legend: {
          show: true, bottom: 0, left: "center", itemWidth: 14, itemHeight: 8,
          itemGap: 18, padding: 0, textStyle: { fontSize: 11 },
          data: ["Above baseline", "Below baseline"],
          selectedMode: false,
        },
        series: [
          // Two zero-width entries purely so the legend can name what the two bar
          // colours mean; the real bars are the third series below.
          { name: "Above baseline", type: "bar", data: [], itemStyle: { color: PAIR_B } },
          { name: "Below baseline", type: "bar", data: [], itemStyle: { color: PAIR_A } },
          {
            name: "Deviation",
            type: "bar",
            data: display.map((r) => ({
              value: r.pct,
              itemStyle: { color: r.pct >= 0 ? PAIR_B : PAIR_A, borderRadius: r.pct >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4] },
            })),
            barMaxWidth: 12,
            markLine: { symbol: "none", silent: true, lineStyle: { color: chartTheme.axis, width: 1 }, data: [{ xAxis: 0 }], label: { show: false } },
          },
        ],
      },
    };
  }, [data, impactMode, impactSort]);

  // Separate from `takeaways` because it depends on the Events/Holidays toggle.
    const sparkOption = useMemo<EChartsOption | null>(() => {
    if (!derived || derived.sparkline.length === 0) return null;
    return {
      grid: { left: 0, right: 0, top: 2, bottom: 2 },
      xAxis: { type: "category", show: false, data: derived.sparkline.map((_, i) => i) },
      yAxis: { type: "value", show: false, min: "dataMin" },
      series: [{ type: "line", data: derived.sparkline, symbol: "none", lineStyle: { width: 1.5, color: PAIR_A }, areaStyle: { color: RAMP[0], opacity: 0.18 } }],
    };
  }, [derived]);

  // ---------- Click-to-inspect handlers ----------
  const filtersNote = `Filters: ${plazaSel.length > 0 ? `${plazaSel.length} plaza(s)` : "all plazas"} · ${vClass === "All" ? "all classes" : vClass}${data ? ` · ${data.range.from} to ${data.range.to}` : ""}`;

  const onTrendClick = (p: { dataIndex: number }) => {
    const i = p.dataIndex;
    const r = trendRows[i];
    if (!r) return;
    const totals = trendRows.map((x) => x.total);
    const avg = totals.reduce((s, v) => s + v, 0) / totals.length;
    const rank = 1 + totals.filter((v) => v > r.total).length;
    const prev = i > 0 ? trendRows[i - 1] : null;
    const periodWord = grain === "hourly" ? "hour" : grain === "daily" ? "day" : grain === "weekly" ? "week" : "month";
    const title =
      grain === "daily"
        ? `${weekdayOf(r.label)}, ${r.label}`
        : grain === "hourly"
          ? `${weekdayOf(r.label.slice(0, 10))}, ${r.label}`
          : grain === "weekly"
            ? `Week of ${r.label}`
            : r.label;
    const rows: [string, string][] = [
      ["Total volume", `${fmtInt(r.total)} vehicles`],
      ["Northbound", `${fmtInt(r.nb)} (${r.total > 0 ? ((r.nb / r.total) * 100).toFixed(1) : "0"}%)`],
      ["Southbound", `${fmtInt(r.sb)} (${r.total > 0 ? ((r.sb / r.total) * 100).toFixed(1) : "0"}%)`],
      ["vs range average", avg > 0 ? fmtPct(((r.total - avg) / avg) * 100) : "—"],
      [`vs previous ${periodWord}`, prev && prev.total > 0 ? fmtPct(((r.total - prev.total) / prev.total) * 100) : "—"],
      ["Rank in range", `#${rank} of ${totals.length} ${periodWord}s by volume`],
    ];
    setDetail({ title, subtitle: `Entry volume · ${periodWord}ly`, rows, note: filtersNote });
  };

  const onHeatmapClick = (p: { value: [number, number, number] }) => {
    if (!data) return;
    const [hour, dowIdx, v] = p.value;
    const all = data.hourDow.map((r) => r.v).sort((a, b) => b - a);
    const rank = 1 + all.findIndex((x) => x <= v);
    const max = all[0] ?? 1;
    const sameHour = data.hourDow.filter((r) => r.hour === hour);
    const wd = sameHour.filter((r) => r.dow >= 1 && r.dow <= 5);
    const we = sameHour.filter((r) => r.dow === 0 || r.dow === 6);
    const avgOf = (rs: typeof sameHour) => (rs.length ? rs.reduce((s, r) => s + r.v, 0) / rs.length : 0);
    const rows: [string, string][] = [
      ["Average volume", `${fmtInt(v)} vehicles/hr`],
      ["Share of weekly peak", `${((v / max) * 100).toFixed(0)}% of ${fmtInt(max)}`],
      ["Rank", `#${rank} of ${all.length} hour-slots`],
      [`Weekday avg at ${fmtHour(hour)}`, `${fmtInt(avgOf(wd))} vehicles/hr`],
      [`Weekend avg at ${fmtHour(hour)}`, `${fmtInt(avgOf(we))} vehicles/hr`],
    ];
    setDetail({ title: `${DOW_LABELS[dowIdx]} · ${fmtHour(hour)}`, subtitle: "Average entry volume for this hour-slot", rows, note: filtersNote });
  };

  const onPlazaClick = (p: { dataIndex: number }) => {
    if (!plazaChart || !data || !derived) return;
    const r = plazaChart.rows[p.dataIndex];
    if (!r) return;
    const share = derived.plazaTotal > 0 ? ((r.v / derived.plazaTotal) * 100).toFixed(1) : "0";
    if (r.isOthers) {
      const preview = plazaChart.others.slice(0, 5).map((o) => o.plaza).join(", ");
      setDetail({
        title: r.plaza,
        subtitle: `${plazaChart.others.length} remaining plazas combined`,
        rows: [
          ["Combined volume", `${fmtInt(r.v)} vehicles`],
          ["Share of selected volume", `${share}%`],
          ["Avg per day", `${fmtInt(r.v / Math.max(1, data.kpis.days))} vehicles`],
          ["Includes", `${preview}${plazaChart.others.length > 5 ? `, +${plazaChart.others.length - 5} more` : ""}`],
        ],
        note: `Use "View all plazas" for the full ranking. ${filtersNote}`,
      });
      return;
    }
    const rank = 1 + data.byPlaza.findIndex((x) => x.plaza === r.plaza);
    setDetail({
      title: r.plaza,
      subtitle: "Toll plaza entry volume",
      rows: [
        ["Volume in range", `${fmtInt(r.v)} vehicles`],
        ["Share of selected volume", `${share}%`],
        ["Avg per day", `${fmtInt(r.v / Math.max(1, data.kpis.days))} vehicles`],
        ["Rank", `#${rank} of ${data.byPlaza.length} plazas`],
      ],
      note: filtersNote,
    });
  };

  const onSpeedClick = (p: { dataIndex: number }) => {
    if (!data) return;
    const r = data.speedByHour[p.dataIndex];
    if (!r) return;
    const fastest = data.speedByHour.reduce((a, b) => (b.speed > a.speed ? b : a));
    const slowest = data.speedByHour.reduce((a, b) => (b.speed < a.speed ? b : a));
    setDetail({
      title: `${fmtHour(r.hour)} — jam conditions`,
      subtitle: "Averages across Waze jam reports in the selected range",
      rows: [
        ["Avg speed in jams", `${r.speed} km/h`],
        ["Avg jam level", `${r.jam_level} / 5`],
        ["vs 20 km/h threshold", `${(r.speed - 20).toFixed(1)} km/h`],
        ["Fastest hour", `${fmtHour(fastest.hour)} · ${fastest.speed} km/h`],
        ["Slowest hour", `${fmtHour(slowest.hour)} · ${slowest.speed} km/h`],
      ],
      note: "Jam data covers the whole expressway (not filterable by plaza or vehicle class).",
    });
  };

  const showEventDetail = (e: Analytics["eventImpact"][number]) => {
    setDetail({
      title: e.label,
      subtitle: `${e.eventCount && e.eventCount > 1 ? `${e.eventCount} events` : "Event"} · ${weekdayOf(e.date)}, ${e.date}`,
      rows: [
        [`${e.plaza ?? "Plaza"} entries that day`, `${fmtInt(e.dayVolume)} vehicles`],
        ["Same-weekday baseline", `${fmtInt(e.baseline)} vehicles`],
        ["Deviation", e.deviationPct != null ? fmtPct(e.deviationPct) : "—"],
        ...(e.attendance ? ([["Reported attendance", `${fmtInt(e.attendance)}`]] as [string, string][]) : []),
        ...(e.baselineDays ? ([["Days behind baseline", `${e.baselineDays}`]] as [string, string][]) : []),
        ...(e.onHoliday ? ([["Note", "This date is also a holiday"]] as [string, string][]) : []),
      ],
      note: `${
        e.onHoliday
          ? "This date is also a public holiday, so the deviation reflects the holiday as much as the event. "
          : ""
      }Baseline = average entries at ${e.plaza ?? "the same exit"} on the same weekday within ±45 days, excluding other event days and holidays. Figures are NLEX entries, so they capture traffic joining the expressway at the venue's own exit rather than arrivals.`,
    });
  };

  const showHolidayDetail = (h: Analytics["holidayImpact"][number]) => {
    const yearly = (data?.holidayYearly ?? []).filter((y) => y.label === h.label).sort((a, b) => a.year - b.year);
    setDetail({
      title: h.label,
      subtitle: "Holiday traffic vs normal days",
      rows: [
        ...(h.holidayType ? ([["Holiday type", h.holidayType]] as [string, string][]) : []),
        ["Avg holiday volume", h.volume > 0 ? `${fmtInt(h.volume)} vehicles` : "—"],
        ["Same-weekday baseline", h.baseline > 0 ? `${fmtInt(h.baseline)} vehicles` : "—"],
        ["Avg deviation (all years)", fmtPct(h.deviationPct)],
        ...yearly.map((y): [string, string] => [String(y.year), `${fmtPct(y.pct)} · ${fmtInt(y.volume)} vehicles`]),
      ],
      note: "Each occurrence is compared with its own local baseline: the average volume on the same weekday within ±45 days of that date, excluding holidays and event days. Comparing locally rather than against all-history keeps the 2020–2021 pandemic period from distorting other years.",
    });
  };

  const onImpactClick = (p: { dataIndex: number }) => {
    if (!impactChart) return;
    const r = impactChart.rows[p.dataIndex];
    if (!r) return;
    if (r.event) showEventDetail(r.event);
    else if (r.holiday) showHolidayDetail(r.holiday);
  };

  // `categoryFallback: false` for charts whose handler needs the native event
  // payload (the heatmap reads p.value as [hour, dow, volume]); a synthesised
  // { dataIndex } would not satisfy it.
  const chartFrame = (
    option: EChartsOption | null,
    emptyNote: string,
    onClick?: (p: never) => void,
    categoryFallback = true,
    // Lets a caller keep the instance so it can drive the chart from outside —
    // the colour keys use it to highlight a band.
    onReady?: (chart: unknown) => void,
  ) => {
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
        onChartReady={(chart) => {
          if (onClick && categoryFallback) attachCategoryClick(chart as never, onClick as never);
          onReady?.(chart);
        }}
      />
    );
  };

  // A skeleton rather than an ellipsis: the tile keeps its height, so the KPI
  // row does not resize under the cursor as the numbers arrive.
  /* Scrubbing a colour key highlights the matching part of its chart.

     The visualMaps are still there, just not drawn — so selectDataRange, the
     action the visible control used to fire, still works. Narrowing the range
     leaves matching cells at full strength and fades the rest, which is the
     highlight the old visualMap gave and the static strip had lost. */
  const heatChart = useRef<unknown>(null);
  const speedChart = useRef<unknown>(null);

  const scrub = (
    ref: React.MutableRefObject<unknown>,
    lo: number,
    hi: number,
  ) => (t: number | null) => {
    const chart = ref.current as
      | { dispatchAction: (a: Record<string, unknown>) => void }
      | null;
    if (!chart) return;
    if (t == null) {
      chart.dispatchAction({ type: "selectDataRange", visualMapIndex: 0, selected: [lo, hi] });
      return;
    }
    // A band rather than a point: an exact value would match almost nothing.
    const v = lo + t * (hi - lo);
    const pad = (hi - lo) * 0.08;
    chart.dispatchAction({
      type: "selectDataRange",
      visualMapIndex: 0,
      selected: [Math.max(lo, v - pad), Math.min(hi, v + pad)],
    });
  };

  /* The key needs the same domain the chart coloured against, or pointing at a
     shade would report a value the heatmap never used. */
  const heatMaxValue = useMemo(
    () => (data ? Math.max(0, ...data.hourDow.map((r) => r.v)) : 0),
    [data],
  );
  const speedRange = useMemo<[number, number]>(() => {
    const sp = (data?.speedByHour ?? []).map((r) => r.speed).filter((v) => v > 0);
    return sp.length ? [Math.min(...sp), Math.max(...sp)] : [0, 0];
  }, [data]);

  const kpiValue = (v: string | null) =>
    loading && !data ? <KpiSkeleton /> : (v ?? "—");

  /* What fraction of a day's traffic lands in its busiest hour. Measured, not
     assumed: both terms come from the descriptive aggregate the KPI row
     already shows. The staffing LP turns a daily volume forecast into a
     peak-hour demand with it. */
  const peakShare =
    derived && derived.curAdt > 0 && derived.peakHourVolume > 0
      ? derived.peakHourVolume / derived.curAdt
      : null;

  // ---------- Predictive / Prescriptive share the same shell ----------
  if (activeTab !== "Descriptive") {
    return (
      <section className={`${styles.page} viz-traffic`}>
        <PageHeader icon={TrendingUp} title="Traffic Overview" subtitle="Volume, congestion, and speed patterns across NLEX" />
        <div className={styles.filterRow} style={{ flexWrap: "wrap", rowGap: 8 }}>
          {/* Predictive carries the same Range/Weather controls as Descriptive */}
          {activeTab === "Predictive" && (
            <>
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
            </>
          )}
          {activeTab === "Prescriptive" && (
            <span className={styles.filterNote}>
              Staffing, congestion response and event ranking, computed from the Predictive tab&apos;s own forecast —
              Range does not apply.
            </span>
          )}
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
          <>
            {/* The diagram's System Output boxes, stated first: next-day
                volume, seasonal peak, congestion state, event surge. The three
                cards beneath are the Models, KPI and Visualization boxes that
                back them up. */}
            <div className={styles.spanFull}>
              <ForecastGlance />
            </div>
            <div className={styles.spanFull}>
              <PredictiveVolumeChart
                months={rangeMode === "custom" ? "all" : rangeMode}
                from={rangeMode === "custom" ? customFrom : undefined}
                to={rangeMode === "custom" ? customTo : undefined}
                weather={weather}
              />
            </div>
            <div className={styles.spanHalf}><PredictiveCongestionChart /></div>
            <div className={styles.spanHalf}><PredictiveEventChart /></div>
          </>
        ) : (
          /* Three panels, one per row of the analytics diagram, each acting on
             the Predictive tab's own forecast rather than a separate model.
             The peak-hour share comes from the descriptive hour-by-weekday
             profile already computed for the KPI row, so the staffing panel
             and the "Peak Hour" tile cannot disagree about when the peak is. */
          <>
            <div className={styles.spanFull}>
              <VolumeStaffingPanel peakShare={peakShare} />
            </div>
            <div className={styles.spanFull}>
              <CongestionResponsePanel />
            </div>
            <div className={styles.spanFull}>
              <EventInterventionPanel />
            </div>
          </>
        )}
      </section>
    );
  }

  return (
    <section className={`${styles.page} viz-traffic`}>
      <PageHeader icon={TrendingUp} title="Traffic Overview" subtitle="Volume, congestion, and speed patterns across NLEX" />

      {/* Row A — global filters */}
      <div className={styles.filterRow}>
        <div className={styles.filterGroup}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: 'var(--text-muted)' }}><rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.4" /><path d="M2 6h12" stroke="currentColor" strokeWidth="1.4" /><path d="M5.5 2V4M10.5 2V4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
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
          <span className={styles.kpiIcon} aria-hidden="true"><Activity size={15} /></span>
          <h3>Total Volume</h3>
          <div className={styles.kpiValue} title={data ? `${fmtInt(data.kpis.totalVolume)} vehicles` : undefined}>
            {kpiValue(data ? fmtCompact(data.kpis.totalVolume) : null)}
          </div>
          <p className={styles.kpiHint}>
            {derived ? (
              <span className={derived.volumeDeltaPct >= 0 ? styles.deltaUp : styles.deltaDown}>{fmtPct(derived.volumeDeltaPct)}</span>
            ) : "—"}{" "}
            vs previous period
          </p>
        </article>
        <article className={styles.kpiTile}>
          <span className={styles.kpiIcon} aria-hidden="true"><CalendarClock size={15} /></span>
          <h3>Avg Daily Volume</h3>
          <div className={styles.kpiValue}>{kpiValue(derived ? fmtInt(derived.curAdt) : null)}</div>
          <div className={styles.sparkBox}>
            {sparkOption && <ReactECharts option={sparkOption} style={{ width: "100%", height: "100%" }} opts={{ renderer: "canvas" }} />}
          </div>
        </article>
        <article className={styles.kpiTile}>
          <span className={styles.kpiIcon} aria-hidden="true"><Clock size={15} /></span>
          <h3>Peak Hour (Weekdays)</h3>
          <div className={styles.kpiValue}>{kpiValue(derived ? fmtHour(derived.peakHour) : null)}</div>
          <p className={styles.kpiHint}>{derived ? `${fmtInt(derived.peakHourVolume)} vehicles/hr avg` : "—"}</p>
        </article>
        <article className={styles.kpiTile}>
          <span className={styles.kpiIcon} aria-hidden="true"><Building2 size={15} /></span>
          <h3>Busiest Plaza</h3>
          <div className={styles.kpiValue}>{kpiValue(derived?.busiest ? derived.busiest.plaza : null)}</div>
          <p className={styles.kpiHint}>
            {derived?.busiest && derived.plazaTotal > 0 ? `${((derived.busiest.v / derived.plazaTotal) * 100).toFixed(1)}% of selected volume` : "—"}
          </p>
        </article>
        <article className={styles.kpiTile}>
          <span className={styles.kpiIcon} aria-hidden="true"><Gauge size={15} /></span>
          <h3>Congestion Index</h3>
          <div className={styles.kpiValue}>{kpiValue(data?.kpis.congestionIndex != null ? `${data.kpis.congestionIndex.toFixed(2)} / 5` : null)}</div>
          <p className={styles.kpiHint}>
            {derived?.congestionDelta != null ? (
              <>
                <span className={derived.congestionDelta <= 0 ? styles.deltaUp : styles.deltaDown}>
                  {derived.congestionDelta >= 0 ? "+" : ""}{derived.congestionDelta.toFixed(2)}
                </span>{" "}
                vs prev · Waze jam level
              </>
            ) : data ? "no prior data" : "—"}
          </p>
        </article>
      </div>

      {/* Row C — hero chart */}
      <article className={`${styles.chartCard} ${styles.chart1} ${styles.hero}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>Volume Trend</h3>
          </div>
        </div>
        <div className={styles.heroFilters}>
          <div className={styles.heroFilterGroup}>
            <span className={styles.heroFilterLabel}>Direction</span>
            <div className={styles.segmentedSmall}>
              {(["Both", "NB", "SB"] as const).map((d) => (
                <button
                  key={d}
                  className={direction === d ? "active" : ""}
                  // Only meaningful once the chart is split: unsplit it draws a
                  // single combined line, which is Both by definition and has no
                  // carriageway to choose between.
                  disabled={!splitDirection}
                  title={!splitDirection ? "Turn on Split NB / SB to choose a direction" : undefined}
                  onClick={() => setDirection(d)}
                >
                  {direction === d && <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.heroFilterDivider} />
          <div className={styles.heroFilterGroup}>
            <span className={styles.heroFilterLabel}>Class</span>
            <CustomSelect
              value={vClass}
              onChange={(v) => setVClass(v as VehicleClass)}
              options={[
                { label: "All classes", value: "All" },
                { label: "Class 1", value: "Class 1" },
                { label: "Class 2", value: "Class 2" },
                { label: "Class 3", value: "Class 3" },
              ]}
            />
          </div>
          <div className={styles.heroFilterDivider} />
          <div className={styles.heroFilterGroup}>
            <span className={styles.heroFilterLabel}>Granularity</span>
            <div className={styles.segmentedSmall}>
              {(["hourly", "daily", "weekly", "monthly"] as const).map((g) => (
                <button
                  key={g}
                  className={grain === g ? "active" : ""}
                  disabled={(g === "hourly" && !hourlyAvailable) || Boolean(grainBlockedReason(g, spanDays))}
                  title={
                    g === "hourly" && !hourlyAvailable
                      ? "Hourly detail is available for ranges up to 2 weeks"
                      : grainBlockedReason(g, spanDays) ?? undefined
                  }
                  onClick={() => setGrain(g)}
                >
                  {grain === g && <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                  {g.charAt(0).toUpperCase() + g.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.heroFilterGroup} style={{ marginLeft: "auto" }}>
            <label className={styles.heroToggle}>
              <input
                type="checkbox"
                checked={splitDirection}
                onChange={(e) => {
                  const on = e.target.checked;
                  setSplitDirection(on);
                  // Turning split off returns the control to Both, so it is never
                  // left disabled while holding NB or SB — a state the reader
                  // could see but not change.
                  if (!on) setDirection("Both");
                }}
              />
              <span className={styles.heroToggleTrack}><span className={styles.heroToggleThumb} /></span>
              Split NB / SB
            </label>
          </div>
        </div>
        <div className={styles.chartBody}>{chartFrame(trendOption, "No volume data for the selected filters", onTrendClick)}</div>
      </article>

      {/* Row D */}
      <article className={`${styles.chartCard} ${styles.chart2}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>Average Volume by Hour × Day of Week</h3>
          </div>
        </div>
        <div className={styles.chartBody}>{chartFrame(heatmapOption, "No data for the selected filters", onHeatmapClick, false, (c) => { heatChart.current = c; })}</div>
        <RampKey
          colors={SEQ}
          min={0}
          max={heatMaxValue}
          format={(v) => `${fmtCompact(v)} vehicles`}
          lowLabel="Quieter"
          highLabel="Busier"
          onScrub={scrub(heatChart, 0, heatMaxValue)}
        />
      </article>

      <article className={`${styles.chartCard} ${styles.chart3}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>Volume by Plaza</h3>
          </div>
          <button
            type="button"
            className={styles.sortBtn}
            onClick={() => setPlazaSort(plazaSort === "desc" ? "asc" : "desc")}
            title={plazaSort === "desc" ? "Sorted highest first — click for lowest first" : "Sorted lowest first — click for highest first"}
            aria-label={`Sort order: ${plazaSort === "desc" ? "highest first" : "lowest first"}. Activate to reverse.`}
          >
            {plazaSort === "desc" ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
          </button>
          <button className={styles.secondaryButton} onClick={() => setAllPlazasOpen(true)}>
            View all plazas
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 12l4-4-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
        <div className={styles.chartBody}>{chartFrame(plazaChart?.option ?? null, "No data for the selected filters", onPlazaClick)}</div>
      </article>

      {/* Row E */}
      <article className={`${styles.chartCard} ${styles.chart4}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>Average Speed in Jams by Hour</h3>
          </div>
        </div>
        <div className={styles.chartBody}>{chartFrame(speedOption, "No congestion data in the selected range", onSpeedClick, true, (c) => { speedChart.current = c; })}</div>
        <RampKey
          colors={SEVERITY}
          min={speedRange[0]}
          max={speedRange[1]}
          format={(v) => `${v.toFixed(0)} km/h`}
          lowLabel="Slower"
          highLabel="Faster"
          onScrub={scrub(speedChart, speedRange[0], speedRange[1])}
        />
      </article>

      <article className={`${styles.chartCard} ${styles.chart5}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>{impactMode === "Events" ? "Arena Event Impact (venue exit entries)" : "Holiday Impact vs Normal Days"}</h3>
          </div>
          <button
            type="button"
            className={styles.sortBtn}
            onClick={() => setImpactSort(impactSort === "desc" ? "asc" : "desc")}
            title={impactSort === "desc" ? "Sorted highest first — click for lowest first" : "Sorted lowest first — click for highest first"}
            aria-label={`Sort order: ${impactSort === "desc" ? "highest first" : "lowest first"}. Activate to reverse.`}
          >
            {impactSort === "desc" ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
          </button>
          <button className={styles.secondaryButton} onClick={() => setImpactListOpen(true)}>
            View all
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 12l4-4-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <div className={styles.segmented}>
            {(["Events", "Holidays"] as const).map((m) => (
              <button key={m} className={impactMode === m ? "active" : ""} onClick={() => setImpactMode(m)}>
                {impactMode === m && <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.chartBody}>{chartFrame(impactChart?.option ?? null, "No impact data available", onImpactClick)}</div>
      </article>

      {/* Click-to-inspect detail modal */}
      {detail && (
        <div className={styles.detailBackdrop} role="dialog" aria-modal="true" aria-label={detail.title} onClick={() => setDetail(null)}>
          <div className={styles.detailModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.detailAccent} />
            <div className={styles.detailHeader}>
              <div className={styles.detailIcon}>📊</div>
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

      {/* View-all-plazas modal */}
      {allPlazasOpen && data && (
        <div className={styles.detailBackdrop} role="dialog" aria-modal="true" aria-label="All plazas" onClick={() => setAllPlazasOpen(false)}>
          <div className={`${styles.detailModal} ${styles.plazaModal}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.detailAccent} />
            <div className={styles.detailHeader}>
              <div className={styles.detailIcon}>🏢</div>
              <div className={styles.detailTitles}>
                <h3>Volume by Plaza — Full Ranking</h3>
                <p>{data.byPlaza.length} toll plazas</p>
              </div>
              <button className={styles.detailClose} onClick={() => setAllPlazasOpen(false)} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4.5 4.5L13.5 13.5M13.5 4.5L4.5 13.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </div>
            <div className={styles.plazaTableWrap}>
              <table className={styles.plazaTable}>
                <thead>
                  <tr><th>#</th><th>Plaza</th><th>Volume</th><th>Share</th></tr>
                </thead>
                <tbody>
                  {data.byPlaza.map((r, i) => (
                    <tr key={r.plaza}>
                      <td className={styles.plazaRank}>{i + 1}</td>
                      <td>{r.plaza}</td>
                      <td className={styles.plazaNum}>{fmtInt(r.v)}</td>
                      <td className={styles.plazaNum}>{derived && derived.plazaTotal > 0 ? `${((r.v / derived.plazaTotal) * 100).toFixed(1)}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* View-all events/holidays modal */}
      {impactListOpen && data && (
        <div className={styles.detailBackdrop} role="dialog" aria-modal="true" aria-label={`All ${impactMode.toLowerCase()}`} onClick={() => setImpactListOpen(false)}>
          <div className={`${styles.detailModal} ${impactMode === "Events" ? styles.impactModal : styles.plazaModal}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.detailAccent} />
            <div className={styles.detailHeader}>
              <div className={styles.detailIcon}>{impactMode === "Events" ? "🎤" : "🎉"}</div>
              <div className={styles.detailTitles}>
                <h3>{impactMode === "Events" ? "Arena Events — Full List" : "Holidays — Full List"}</h3>
                <p>
                  {impactMode === "Events"
                    ? `${data.eventImpact.length} events vs same-weekday baseline · click a row for details`
                    : `${data.holidayImpact.length} holidays · click a row for details`}
                </p>
              </div>
              <button className={styles.detailClose} onClick={() => setImpactListOpen(false)} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4.5 4.5L13.5 13.5M13.5 4.5L4.5 13.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </div>
            <div className={styles.plazaTableWrap}>
              {impactMode === "Events" ? (
                <table className={styles.plazaTable}>
                  <thead>
                    <tr><th>Date</th><th>Event</th><th>Plaza volume</th><th>Baseline</th><th>Deviation</th></tr>
                  </thead>
                  <tbody>
                    {data.eventImpact.map((e) => (
                      <tr
                        key={`${e.date}-${e.label}`}
                        className={styles.clickableRow}
                        onClick={() => { setImpactListOpen(false); showEventDetail(e); }}
                      >
                        <td className={styles.plazaNum} style={{ whiteSpace: "nowrap" }}>{e.date}</td>
                        <td className={styles.eventName}>{e.label}</td>
                        <td className={styles.plazaNum}>{fmtInt(e.dayVolume)}</td>
                        <td className={styles.plazaNum}>{fmtInt(e.baseline)}</td>
                        <td className={styles.plazaNum}>
                          {e.deviationPct != null ? (
                            <span className={e.deviationPct >= 0 ? styles.devPos : styles.devNeg}>{fmtPct(e.deviationPct)}</span>
                          ) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className={styles.plazaTable}>
                  <thead>
                    <tr><th>Holiday</th><th>Avg volume</th><th>Baseline</th><th>Deviation</th><th>Days</th></tr>
                  </thead>
                  <tbody>
                    {[...data.holidayImpact].sort((a, b) => b.deviationPct - a.deviationPct).map((h) => (
                      <tr
                        key={h.label}
                        className={styles.clickableRow}
                        onClick={() => { setImpactListOpen(false); showHolidayDetail(h); }}
                      >
                        <td>{h.label}</td>
                        <td className={styles.plazaNum}>{h.volume > 0 ? fmtInt(h.volume) : "—"}</td>
                        <td className={styles.plazaNum}>{h.baseline > 0 ? fmtInt(h.baseline) : "—"}</td>
                        <td className={styles.plazaNum}>
                          <span className={h.deviationPct >= 0 ? styles.devPos : styles.devNeg}>{fmtPct(h.deviationPct)}</span>
                        </td>
                        <td className={styles.plazaNum}>{h.occurrences}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
