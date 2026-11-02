"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cachedJson } from "../../../lib/cached-json";
import { attachCategoryClick } from "../../../lib/chart-click";
import { useChartTheme, applyChartTheme, seriesRamp, seriesPair } from "../../../lib/chart-theme";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { CalendarClock, Clock, Leaf, Timer, Truck, Wind, X } from "lucide-react";
import DashboardChart from "../../../components/dashboard/DashboardChart";
import ChartSkeleton, { KpiSkeleton } from "../../../components/dashboard/ChartSkeleton";
import CustomSelect from "../../../components/dashboard/CustomSelect";
import PageHeader from "../../../components/dashboard/PageHeader";
import InfoTooltip from "../../../components/dashboard/InfoTooltip";
import ModeTabLabel, { modeIndex } from "../../../components/dashboard/ModeTabLabel";
import StateNote from "../../../components/stage/StateNote";
import { areaFade } from "../../../lib/chart-kit";
import PredictiveEmissionChart from "../../../components/dashboard/PredictiveEmissionChart";
import FleetMixForecastChart from "../../../components/dashboard/FleetMixForecastChart";
import PrescriptiveEmissionsPanel from "../../../components/dashboard/PrescriptiveEmissionsPanel";
import DateRangePicker from "../traffic/components/DateRangePicker";
import { rangeDays, grainBlockedReason, bestGrainFor, bucketLabelFor, timeAxisLabels } from "../../../lib/granularity";
import styles from "../traffic/traffic.module.css";
import CountUpValue from "../../../components/dashboard/CountUpValue";
import RampKey from "../../../components/dashboard/RampKey";
import { POLLUTANT_NAMES, Term, spelled } from "../../../components/dashboard/emissionsTerms";
import { fmtHeatNumber, heatTip, heatValue } from "../../../lib/heat-tooltip";

/** The heat grid's unit, shared by a cell's tooltip and the colour key's readout. */
const HEAT_UNIT = "t CO₂ / h";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

const CLASS_SHORT = ["Class 1 · Light", "Class 2 · Medium", "Class 3 · Heavy"];
const AQI_BANDS = ["Good (AQI 1–2)", "Moderate (AQI 3)", "Poor (AQI 4–5)"] as const;
/** The Fleet Mix chart's reference row: each class's share of the vehicles counted. */
const BASELINE_LABEL = "Vehicles (baseline)";
/** What the class-vs-class cards say once the Class filter leaves only one class to compare. */
const ONE_CLASS_NOTE = "This card compares the three vehicle classes. Set Class to All classes to see it.";

/* The chart kit's 28% → 0% area fade. Its gradient object types `type` as a
   plain string where ECharts wants the literal "linear", hence the cast. */
const fadeArea = (c: string) => areaFade(c) as unknown as { color: string };

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

// ---------- Data contract ----------
type Analytics = {
  range: { from: string; to: string };
  /** vehicleClass: the class the response is narrowed to, or null for all three. */
  meta: { minDate: string; maxDate: string; source?: string; exits?: number; vehicleClass?: number | null };
  kpis: {
    totalCo2T: number;
    co2LowT?: number;
    co2HighT?: number;
    vehicleKm?: number;
    prevCo2T: number;
    /** Idling CO2 behind accidents that blocked a lane in the Range (Back-End emissions-source.ts). */
    delayCarbonT?: number;
    delayCarbonPct?: number;
    delayIncidents?: number;
    delayLongIncidents?: number;
    delayLongSharePct?: number;
    avgAqi: number | null;
    aqiSamples: number;
    avgPm25: number | null;
  };
  /** nb + sb + bothdir = the day: bothdir is the plazas the record does not split by direction. */
  dailyTrend: { d: string; c1: number; c2: number; c3: number; nb: number; sb: number; bothdir?: number }[];
  /** Present only for ranges of 14 days or less; null otherwise. */
  hourlyTrend: { d: string; hour: number; c1: number; c2: number; c3: number; nb: number; sb: number; bothdir?: number }[] | null;
  heatmap: { dow: number; hour: number; v: number }[];
  classes: { class: number; label: string; co2_g_per_km: number; volume: number; co2_t: number; pm25_kg: number; no2_kg: number }[];
  aqiMonthly: { m: string; good: number; moderate: number; poor: number; pm25: number | null }[];
};

type Granularity = "hourly" | "daily" | "weekly" | "monthly";
/**
 * Two controls, two jobs.
 *
 * `classView` lives on the hero chart and only decides which of its stacked
 * series are drawn — it never refetches, so the rest of the tab is untouched.
 * `classFilter` sits with the date range and narrows the query itself, so every
 * panel reports that class.
 */
type ClassChoice = "All" | "1" | "2" | "3";
type RangeMode = "3" | "12" | "all" | "custom";
type Detail = { title: string; subtitle?: string; rows: [string, string][]; note?: string };

// ---------- Formatting ----------
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmt1 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtCompact = (n: number) => Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);
const fmtPct = (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
/** One bucket of a grain, as a word: "month" for monthly. */
const heroPeriodOf = (g: Granularity) => (g === "hourly" ? "hour" : g === "daily" ? "day" : g === "weekly" ? "week" : "month");

function weekStart(dateStr: string): string {
  const dt = new Date(`${dateStr}T00:00:00`);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

export default function SustainabilityPage() {
  // Chart furniture follows the active theme; series hues stay fixed.
  const chartTheme = useChartTheme();

  /* This tab's colour family. The ramp is ordinal — lightest to darkest — and
     both modes are selected steps validated against their own surface, not an
     automatic flip. A pair of nominal series takes the outer two steps, which is
     where the separation margin lives. See lib/chart-theme. */
  const RAMP = seriesRamp("emissions", chartTheme);
  const [PAIR_A, PAIR_B] = seriesPair("emissions", chartTheme);
  const SEQ = [chartTheme.seqLightest, ...RAMP];
  const [activeTab, setActiveTab] = useState<"Descriptive" | "Predictive" | "Prescriptive">("Descriptive");

  // Global filters
  const [rangeMode, setRangeMode] = useState<RangeMode>("12");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  // Chart-local interactivity
  const [grain, setGrain] = useState<Granularity>("monthly");
  const [timeView, setTimeView] = useState<"hour" | "dow">("hour");
  const [classView, setClassView] = useState<ClassChoice>("All");
  const [classFilter, setClassFilter] = useState<ClassChoice>("All");
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
    if (classFilter !== "All") qs.set("vehicleClass", classFilter);
    // Memoised per query string: switching tabs or returning to this page
    // renders from memory instead of refetching. Five minutes, refreshed
    // quietly in the background once stale. See lib/cached-json.
    cachedJson<{ success: boolean; message?: string; data: Analytics }>(`${BACKEND}/api/emissions/analytics?${qs}`)
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
  }, [rangeMode, customFrom, customTo, classFilter]);

  /* How long a window is on screen, and what that allows.

     Measured from the range the API resolved rather than the raw custom inputs,
     so the 3-month and 12-month presets are governed by the same rule. */
  const spanDays = rangeDays(data?.range.from, data?.range.to);
  // The API decides: it omits the series entirely past 14 days.
  const hourlyAvailable = Boolean(data?.hourlyTrend);

  // A grain that stops being possible is demoted rather than left selected: the
  // control disables it, so without this the chart would sit on an impossible
  // bucket with no way to change it.
  useEffect(() => {
    if (spanDays == null) return;
    if (grainBlockedReason(grain, spanDays)) {
      setGrain(bestGrainFor(spanDays, hourlyAvailable) as typeof grain);
    }
  }, [spanDays, grain, hourlyAvailable]);

  // ---------- Derived ----------
  const derived = useMemo(() => {
    if (!data) return null;
    const { kpis, classes } = data;
    const deltaPct = kpis.prevCo2T > 0 ? ((kpis.totalCo2T - kpis.prevCo2T) / kpis.prevCo2T) * 100 : 0;

    const totVol = classes.reduce((s, c) => s + c.volume, 0);
    const totCo2 = classes.reduce((s, c) => s + c.co2_t, 0);
    const heavy = classes.filter((c) => c.class >= 2);
    const heavyVolPct = totVol > 0 ? (heavy.reduce((s, c) => s + c.volume, 0) / totVol) * 100 : 0;
    const heavyCo2Pct = totCo2 > 0 ? (heavy.reduce((s, c) => s + c.co2_t, 0) / totCo2) * 100 : 0;

    const days = data.dailyTrend.length;
    const avgDailyT = days > 0 ? kpis.totalCo2T / days : 0;

    /* The class-vs-class panels (heavy share, fleet mix) compare classes, so once the Class filter narrows
       the response to one class they have nothing to compare: every share is 0% or 100%. */
    const oneClass = data.meta.vehicleClass != null;
    // The per-km factors, as the API reports them, for the heavy-share explanations.
    const factorText = [...classes]
      .sort((a, b) => a.class - b.class)
      .map((c) => `Class ${c.class} ${fmtInt(c.co2_g_per_km)}`)
      .join(", ");

    return { deltaPct, heavyVolPct, heavyCo2Pct, avgDailyT, totVol, totCo2, oneClass, factorText };
  }, [data]);

    // ---------- Hero: CO2 trend by class ----------
  type TrendRow = { label: string; c1: number; c2: number; c3: number; nb: number; sb: number; bothdir?: number; total: number };
  const trendRows = useMemo<TrendRow[]>(() => {
    if (!data) return [];
    // Hourly reads a different series entirely — the API only sends it for short
    // ranges, so the control is disabled when it is absent.
    const src =
      grain === "hourly"
        ? (data.hourlyTrend ?? []).map((r) => ({
            ...r,
            d: `${r.d} ${String(r.hour).padStart(2, "0")}:00`,
          }))
        : data.dailyTrend;

    const keyOf =
      grain === "hourly" || grain === "daily"
        ? (d: string) => d
        : grain === "weekly"
          ? weekStart
          : (d: string) => d.slice(0, 7);
    const acc = new Map<string, { c1: number; c2: number; c3: number; nb: number; sb: number; bothdir: number; days: number }>();
    for (const r of src) {
      const k = keyOf(r.d);
      const cur = acc.get(k) ?? { c1: 0, c2: 0, c3: 0, nb: 0, sb: 0, bothdir: 0, days: 0 };
      acc.set(k, { c1: cur.c1 + r.c1, c2: cur.c2 + r.c2, c3: cur.c3 + r.c3, nb: cur.nb + r.nb, sb: cur.sb + r.sb, bothdir: cur.bothdir + ("bothdir" in r ? (r.bothdir ?? 0) : 0), days: cur.days + 1 });
    }
    let rows = [...acc.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([label, v]) => ({ label, ...v, total: v.c1 + v.c2 + v.c3 }));
    // A partial first/last bucket (a "month" holding 2 days) reads as a fake
    // collapse in a stacked trend — trim incomplete edge buckets for rolled-up grains.
    if (grain !== "daily" && grain !== "hourly" && rows.length > 2) {
      const expected = (label: string) =>
        grain === "weekly"
          ? 7
          : new Date(Number(label.slice(0, 4)), Number(label.slice(5, 7)), 0).getDate();
      if (rows[0].days < expected(rows[0].label)) rows = rows.slice(1);
      if (rows.length > 2 && rows[rows.length - 1].days < expected(rows[rows.length - 1].label)) rows = rows.slice(0, -1);
    }
    return rows;
  }, [data, grain]);

  const trendOption = useMemo<EChartsOption | null>(() => {
    if (trendRows.length === 0) return null;
    const labels = trendRows.map((r) => r.label);
    const timeAxis = timeAxisLabels(labels, grain);

    const mk = (name: string, key: "c1" | "c2" | "c3", color: string) => ({
      name,
      type: "line" as const,
      stack: "co2",
      data: trendRows.map((r) => Number(r[key].toFixed(1))),
      symbol: "none",
      smooth: false,
      itemStyle: { color },
      lineStyle: { width: 1, color },
      areaStyle: { color, opacity: 0.85 },
    });

    return {
      grid: { left: 62, right: 16, top: 22, bottom: classView === "All" ? 52 : 26 },
      xAxis: { type: "category", data: labels, axisLabel: { formatter: timeAxis.formatter, interval: timeAxis.interval, hideOverlap: true }, axisTick: { show: false } },
      yAxis: { type: "value", name: "tonnes CO₂", nameGap: 12, nameTextStyle: { align: "left" }, splitNumber: 3, axisLabel: { formatter: (v: number) => `${fmtCompact(v)} t` } },
      tooltip: {
        trigger: "axis",
        formatter: (p) => {
          const items = p as { seriesName: string; dataIndex: number; value: number; marker: string }[];
          const i = items[0].dataIndex;
          const r = trendRows[i];
          const rows = items.map((x) => `${x.marker} ${x.seriesName}: ${fmtInt(x.value)} t`).join("<br/>");
          return `<b>${bucketLabelFor(grain)(r.label)}</b><br/>${rows}<br/>Total: <b>${fmtInt(r.total)} t</b>`;
        },
      },
      /* Only while all three classes are drawn. Picking a single class filters
         the series list down to one, and the legend then named the one line on
         the chart -- which the Class control the reader just used already told
         them. */
      legend: { show: classView === "All", bottom: 0, left: "center", itemWidth: 14, itemHeight: 8, itemGap: 18, padding: 0 },
      // Drawn from data already in hand: the response carries c1, c2 and c3 per
      // bucket, so this hides series rather than asking for different numbers.
      series: [mk(CLASS_SHORT[0], "c1", RAMP[0]), mk(CLASS_SHORT[1], "c2", RAMP[1]), mk(CLASS_SHORT[2], "c3", RAMP[2])]
        .filter((_, i) => classView === "All" || classView === String(i + 1)),
    };
    // chartTheme picks the ramp, so a theme switch redraws the series.
  }, [trendRows, grain, classView, chartTheme]);

  // ---------- When emissions happen (weekday/weekend hourly profile) ----------
  const timeProfile = useMemo(() => {
    if (!data || data.heatmap.length === 0) return null;
    const dowCount = [0, 0, 0, 0, 0, 0, 0];
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

    const dowAvg = DOW_ORDER.map((d) => (dowCount[d] > 0 ? dowTotals[d] / dowCount[d] : 0));
    const dowTotalOrdered = DOW_ORDER.map((d) => dowTotals[d]);
    const dowDaysOrdered = DOW_ORDER.map((d) => dowCount[d]);
    const busiestDow = dowAvg.indexOf(Math.max(...dowAvg));

    return { weekday, weekend, allHour, hourTotals, peakHour, quietHour, dowAvg, dowTotalOrdered, dowDaysOrdered, busiestDow };
  }, [data]);

  // The peak hour is the card's answer (drawn above this line); the takeaway
  // carries the rest of the same computed finding.
  const timeTakeaway = timeProfile
    ? `Quietest around ${fmtHour(timeProfile.quietHour)} · heaviest day: ${DOW_LABELS[timeProfile.busiestDow]}`
    : null;

  const timeOption = useMemo<EChartsOption | null>(() => {
    if (!timeProfile) return null;

    if (timeView === "hour") {
      const peakIdx = timeProfile.weekday.indexOf(Math.max(...timeProfile.weekday));
      return {
        grid: { left: 48, right: 16, top: 22, bottom: 54 },
        xAxis: { type: "category", boundaryGap: false, data: Array.from({ length: 24 }, (_, h) => fmtHour(h)), axisLabel: { interval: 3 }, axisTick: { show: false } },
        yAxis: { type: "value", name: "avg t CO₂ / day", nameGap: 12, nameTextStyle: { align: "left" }, splitNumber: 3, axisLabel: { formatter: (v: number) => `${v} t` } },
        tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : `${fmt1(Number(v))} t`) },
        legend: { show: true, bottom: 0, left: "center", itemWidth: 14, itemHeight: 8, itemGap: 18, padding: 0 },
        series: [
          {
            name: "Weekdays",
            type: "line",
            data: timeProfile.weekday.map((v) => Number(v.toFixed(2))),
            symbol: "none",
            smooth: true,
            itemStyle: { color: PAIR_A },
            lineStyle: { width: 2, color: PAIR_A },
            markPoint: {
              symbol: "circle",
              symbolSize: 8,
              itemStyle: { color: PAIR_A, borderColor: chartTheme.tooltipBg, borderWidth: 2 },
              // "Weekday": the card's answer is the all-days peak (4 PM on the 12-month Range), this line's
              // is 6 PM, and an unqualified "Peak" here read as a contradiction (17 Oct 2026 review).
              label: { show: true, position: "top", fontSize: 12, color: chartTheme.ink, fontFamily: chartTheme.fontFamily, formatter: `Weekday peak · ${fmtHour(peakIdx)}` },
              data: [{ name: "Peak", coord: [peakIdx, Number(timeProfile.weekday[peakIdx].toFixed(2))] }],
            },
          },
          {
            name: "Weekends",
            type: "line",
            data: timeProfile.weekend.map((v) => Number(v.toFixed(2))),
            symbol: "none",
            smooth: true,
            itemStyle: { color: PAIR_B },
            lineStyle: { width: 2, color: PAIR_B },
          },
        ],
      };
    }

    const maxIdx = timeProfile.busiestDow;
    return {
      grid: { left: 48, right: 16, top: 22, bottom: 54 },
      xAxis: { type: "category", data: DOW_LABELS, axisLabel: { interval: 0 }, axisTick: { show: false } },
      yAxis: { type: "value", name: "avg t CO₂ / day", nameGap: 12, nameTextStyle: { align: "left" }, splitNumber: 3, axisLabel: { formatter: (v: number) => `${v} t` } },
      tooltip: {
        formatter: (p) => {
          const i = (p as { dataIndex: number }).dataIndex;
          return `<b>${DOW_LABELS[i]}</b><br/>${fmt1(timeProfile.dowAvg[i])} t CO₂ per ${DOW_LABELS[i]} on average<br/>${fmtInt(timeProfile.dowTotalOrdered[i])} t total across ${fmtInt(timeProfile.dowDaysOrdered[i])} ${DOW_LABELS[i]}s`;
        },
      },
      series: [
        {
          type: "bar",
          data: timeProfile.dowAvg.map((v, i) => ({
            value: Number(v.toFixed(1)),
            itemStyle: { color: i === maxIdx ? PAIR_A : RAMP[0], borderRadius: [4, 4, 0, 0] },
            label: i === maxIdx ? { show: true, position: "top", fontSize: 12, color: chartTheme.ink, fontFamily: chartTheme.fontFamily, formatter: () => `${fmt1(v)} t` } : undefined,
          })),
          barMaxWidth: 26,
        },
      ],
    };
    // chartTheme picks the series hues and label ink.
  }, [timeProfile, timeView, chartTheme]);

  // ---------- Fleet mix vs pollution load ----------
  /* The vehicle row is off by default (19 Oct 2026, testers EM-5, a second round: "traffic volume looks out
     of place here", from two testers, after the 17 Oct pass had only renamed and faded it). It is still the
     yardstick the chart's question needs ("which classes pollute out of proportion to their numbers"), since
     every pollutant here is vehicles x km x a per-class factor; but a count of vehicles among three
     pollutant bars kept reading as a fourth pollutant. So the comparison now travels with each pollutant bar
     instead (its tooltip gives every class's share against its share of vehicles, as a multiple), and the
     faded vehicle bar is one toggle away for a reader who wants to see it drawn. */
  const [fleetBaseline, setFleetBaseline] = useState(false);
  /* Sort and filter (testers EM-5): pollutants in their listed order or by heavy-vehicle (Class 2 + 3)
     share, and all three classes or the heavy two alone, which starts their segments at 0% so their
     widths can be read off the axis rather than estimated mid-stack. */
  const [fleetSort, setFleetSort] = useState<"listed" | "heavy">("listed");
  const [fleetClasses, setFleetClasses] = useState<"all" | "heavy">("all");
  const fleetRows = useMemo(() => {
    if (!data || data.classes.length === 0 || !derived || derived.oneClass) return null;
    const cls = [...data.classes].sort((a, b) => a.class - b.class);
    const metric = (key: "volume" | "co2_t" | "no2_kg" | "pm25_kg") => {
      const tot = cls.reduce((s, c) => s + c[key], 0);
      return { values: cls.map((c) => c[key]), shares: cls.map((c) => (tot > 0 ? (c[key] / tot) * 100 : 0)), tot };
    };
    // `code` is what the axis prints; `name` is the full pollutant name printed under it.
    const pollutant = (code: "CO₂" | "NOx" | "PM2.5", key: "co2_t" | "no2_kg" | "pm25_kg", unit: string) => ({
      label: code,
      name: POLLUTANT_NAMES[code].split(":")[0],
      full: spelled(code),
      unit,
      isBase: false,
      ...metric(key),
    });
    return {
      cls,
      base: { label: BASELINE_LABEL, name: "toll-plaza counts", full: "Share of the vehicles counted at the toll plazas", unit: "vehicles", isBase: true, ...metric("volume") },
      pollutants: [pollutant("CO₂", "co2_t", "t"), pollutant("NOx", "no2_kg", "kg"), pollutant("PM2.5", "pm25_kg", "kg")],
    };
  }, [data, derived]);

  /** The rows as drawn, top to bottom: the baseline first when it is on, then the pollutants in the chosen order. */
  const fleetShown = useMemo(() => {
    if (!fleetRows) return null;
    const heavyOf = (r: { shares: number[] }) => (r.shares[1] ?? 0) + (r.shares[2] ?? 0);
    const ordered = fleetSort === "heavy" ? [...fleetRows.pollutants].sort((a, b) => heavyOf(b) - heavyOf(a)) : fleetRows.pollutants;
    return fleetBaseline ? [fleetRows.base, ...ordered] : ordered;
  }, [fleetRows, fleetSort, fleetBaseline]);

  // The heavy CO2 share is the card's answer; the takeaway sets it against
  // the heavy share of vehicles, which is the baseline.
  const fleetTakeaway =
    derived && !derived.oneClass && derived.heavyVolPct > 0
      ? `From just ${derived.heavyVolPct.toFixed(1)}% of vehicles · ${fleetBaseline ? "compare each bar with the faded vehicle baseline" : "hover a bar to set each class against its share of vehicles"}`
      : null;

  const fleetOption = useMemo<EChartsOption | null>(() => {
    if (!fleetRows || !fleetShown) return null;
    const rows = [...fleetShown].reverse(); // a category axis draws index 0 at the bottom
    const veh = fleetRows.base.shares;
    const classIdx = fleetClasses === "heavy" ? [1, 2] : [0, 1, 2];
    return {
      grid: { left: 150, right: 16, top: 10, bottom: 54 },
      xAxis: { type: "value", max: 100, interval: 25, axisLabel: { formatter: "{value}%" } },
      yAxis: {
        type: "category",
        data: rows.map((r) => r.label),
        axisTick: { show: false },
        /* The full pollutant name printed under each code (testers EM-5: "full pollutant name on hover"):
           on the axis rather than only on hover, so it reads on a touch screen too. The baseline's name
           is in the quieter ink, so the eye lands on the pollutants first. */
        axisLabel: {
          interval: 0,
          color: chartTheme.ink,
          lineHeight: 16,
          formatter: (v: string) => {
            const r = rows.find((x) => x.label === v);
            if (!r) return v;
            return r.isBase ? `{base|Vehicles}\n{sub|${r.name}}` : `{code|${v}}\n{sub|${r.name}}`;
          },
          rich: {
            code: { color: chartTheme.ink, fontSize: 13, fontWeight: 600, fontFamily: chartTheme.fontFamily, lineHeight: 17 },
            base: { color: chartTheme.text, fontSize: 13, fontStyle: "italic", fontFamily: chartTheme.fontFamily, lineHeight: 17 },
            sub: { color: chartTheme.text, fontSize: 12, fontFamily: chartTheme.fontFamily, lineHeight: 15 },
          },
        },
      },
      tooltip: {
        axisPointer: { type: "shadow" },
        trigger: "axis",
        formatter: (p) => {
          const items = p as { seriesName: string; dataIndex: number; value: number; marker: string }[];
          const r = rows[items[0].dataIndex];
          const lines = items
            .map((x) => {
              const ci = CLASS_SHORT.indexOf(x.seriesName);
              // Each class against its share of the vehicles: the comparison the baseline bar used to carry.
              const vs = !r.isBase && veh[ci] > 0 ? ` · <b>${(x.value / veh[ci]).toFixed(1)}×</b> its ${veh[ci].toFixed(1)}% of vehicles` : "";
              return `${x.marker} ${x.seriesName}: ${x.value.toFixed(1)}% (${fmtCompact(r.values[ci])} ${r.unit})${vs}`;
            })
            .join("<br/>");
          const foot = r.isBase
            ? `<br/><span style="opacity:.75">The yardstick: a pollutant bar wider than this for a class means that class pollutes out of proportion to its numbers.</span>`
            : `<br/><span style="opacity:.75">Above 1× a class emits more than its share of the vehicles.</span>`;
          return `<b>${r.full}</b><br/>${lines}${foot}`;
        },
      },
      legend: { show: true, bottom: 0, left: "center", itemWidth: 14, itemHeight: 8, itemGap: 18, padding: 0 },
      // Series follow the class, not the filter: a class keeps its ramp step whether or not Class 1 is drawn.
      series: classIdx.map((ci) => ({
        name: CLASS_SHORT[ci],
        type: "bar" as const,
        stack: "share",
        // The baseline drawn at reduced strength: it is the reference, not a result.
        data: rows.map((r) => ({ value: Number(r.shares[ci].toFixed(1)), itemStyle: r.isBase ? { opacity: 0.4 } : undefined })),
        itemStyle: { color: RAMP[ci], borderColor: chartTheme.tooltipBg, borderWidth: 1 },
        barMaxWidth: 18,
      })),
    };
    // chartTheme supplies the stack divider colour.
  }, [fleetRows, fleetShown, fleetClasses, chartTheme]);

  // ---------- Heavy-vehicle share of CO2 over time ----------
  /* Reconciled with the Heavy-Vehicle Impact tile (17 Oct 2026, testers EM-6.2: "the chart does not match
     the tile"). Both were right and measured different things: the tile is the share over the whole Range
     (55.8% for the last 12 months), while this card's big figure is the latest period alone (57.1% for
     June 2026), and its dashed line was an unweighted mean of the periods, a third number again. The line
     is now the tile's own figure, labelled as such, and the headline says which period it is. */
  const heavyShareRows = useMemo(() => {
    if (derived?.oneClass) return [];
    return trendRows.map((r) => ({
      label: r.label,
      share: r.total > 0 ? ((r.c2 + r.c3) / r.total) * 100 : 0,
    }));
  }, [trendRows, derived]);

  const heavyShareTakeaway = useMemo(() => {
    if (heavyShareRows.length < 2 || !derived) return null;
    const first = heavyShareRows[0].share;
    const last = heavyShareRows[heavyShareRows.length - 1].share;
    const dir = last - first > 0.5 ? "rising" : first - last > 0.5 ? "falling" : "steady";
    // "x% in the latest period" is the card's answer, drawn above this line from the same last row.
    return `Whole Range: ${derived.heavyCo2Pct.toFixed(1)}%, the Heavy-Vehicle Impact tile's figure (dashed line) · ${dir} from ${first.toFixed(1)}% in the first ${heroPeriodOf(grain)}`;
  }, [heavyShareRows, derived, grain]);

  const heavyShareOption = useMemo<EChartsOption | null>(() => {
    if (heavyShareRows.length === 0 || !derived) return null;
    const labels = heavyShareRows.map((r) => r.label);
    const timeAxis = timeAxisLabels(labels, grain);
    const rangeShare = Number(derived.heavyCo2Pct.toFixed(1));
    return {
      grid: { left: 44, right: 16, top: 16, bottom: 26 },
      xAxis: { type: "category", data: labels, axisLabel: { formatter: timeAxis.formatter, interval: timeAxis.interval, hideOverlap: true }, axisTick: { show: false } },
      yAxis: {
        type: "value",
        splitNumber: 3,
        axisLabel: { formatter: "{value}%" },
        // Room for the Range line even when every period sits on one side of it.
        min: (v: { min: number }) => Math.max(0, Math.floor(Math.min(v.min, rangeShare) - 2)),
        max: (v: { max: number }) => Math.ceil(Math.max(v.max, rangeShare) + 2),
      },
      tooltip: {
        trigger: "axis",
        formatter: (p) => {
          const items = p as { dataIndex: number; value: number }[];
          const r = trendRows[items[0].dataIndex];
          return (
            `<b>${bucketLabelFor(grain)(r.label)}</b><br/>Heavy-vehicle (Class 2–3) share of CO₂: <b>${items[0].value}%</b><br/>` +
            `${fmtInt(r.c2 + r.c3)} t of ${fmtInt(r.total)} t CO₂ in this ${heroPeriodOf(grain)}<br/>` +
            `<span style="opacity:.75">Whole Range: ${rangeShare}% (the Heavy-Vehicle Impact tile)</span>`
          );
        },
      },
      /* No legend: one line, on a chart whose title and y-axis both already
         say it is the heavy-vehicle share. */
      series: [
        {
          name: "Heavy-vehicle share of CO₂",
          type: "line",
          data: heavyShareRows.map((r) => Number(r.share.toFixed(1))),
          symbol: "none",
          smooth: true,
          itemStyle: { color: PAIR_A },
          lineStyle: { width: 2, color: PAIR_A },
          areaStyle: fadeArea(PAIR_A),
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: chartTheme.text, type: "dashed", width: 1, opacity: 0.7 },
            label: { fontSize: 12, color: chartTheme.text, fontFamily: chartTheme.fontFamily, formatter: `whole Range ${rangeShare}%`, position: "insideEndTop" },
            data: [{ yAxis: rangeShare }],
          },
        },
      ],
    };
    // chartTheme colours the Range markLine's label.
  }, [heavyShareRows, trendRows, grain, derived, chartTheme]);

  // ---------- Measured air quality ----------
  const aqiOption = useMemo<EChartsOption | null>(() => {
    if (!data || data.aqiMonthly.length === 0) return null;
    const rows = data.aqiMonthly;
    const labels = rows.map((r) => monthLabel(r.m));
    const totals = rows.map((r) => r.good + r.moderate + r.poor);
    const share = (v: number, i: number) => (totals[i] > 0 ? Number(((v / totals[i]) * 100).toFixed(1)) : 0);
    const keys = ["good", "moderate", "poor"] as const;
    return {
      grid: { left: 40, right: 16, top: 10, bottom: 54 },
      xAxis: { type: "category", data: labels, axisLabel: { hideOverlap: true }, axisTick: { show: false } },
      yAxis: { type: "value", max: 100, splitNumber: 4, axisLabel: { formatter: "{value}%" } },
      tooltip: {
          axisPointer: { type: "shadow" },
        trigger: "axis",
        formatter: (p) => {
          const items = p as { seriesIndex: number; dataIndex: number; value: number; marker: string }[];
          const i = items[0].dataIndex;
          const r = rows[i];
          const lines = items
            .map((x) => `${x.marker} ${AQI_BANDS[x.seriesIndex]}: ${x.value}% (${fmtInt(r[keys[x.seriesIndex]])} readings)`)
            .join("<br/>");
          return `<b>${labels[i]}</b><br/>${lines}<br/>Avg ${spelled("PM2.5")}: ${r.pm25 != null ? `${fmt1(r.pm25)} µg/m³` : "—"}`;
        },
      },
      legend: { show: true, bottom: 0, left: "center", itemWidth: 14, itemHeight: 8, itemGap: 18, padding: 0 },
      series: keys.map((k, ki) => ({
        name: AQI_BANDS[ki],
        type: "bar" as const,
        stack: "aqi",
        data: rows.map((r, i) => share(r[k], i)),
        itemStyle: { color: RAMP[ki], borderColor: chartTheme.tooltipBg, borderWidth: 1 },
        barMaxWidth: 22,
      })),
    };
    // chartTheme supplies the ramp and the stack divider colour.
  }, [data, chartTheme]);

  // ---------- KPI sparkline (daily total CO2) ----------
  const sparkOption = useMemo<EChartsOption | null>(() => {
    if (!data || data.dailyTrend.length < 2) return null;
    // 7-day rolling mean — raw daily totals are too noisy at sparkline size
    const daily = data.dailyTrend.map((r) => r.c1 + r.c2 + r.c3);
    const vals = daily.map((_, i) => {
      const win = daily.slice(Math.max(0, i - 6), i + 1);
      return Number((win.reduce((s, v) => s + v, 0) / win.length).toFixed(1));
    });
    return {
      grid: { left: 0, right: 0, top: 2, bottom: 2 },
      xAxis: { type: "category", show: false, data: vals.map((_, i) => i) },
      yAxis: { type: "value", show: false, min: "dataMin" },
      series: [{ type: "line", data: vals, symbol: "none", smooth: true, lineStyle: { width: 1.5, color: PAIR_A }, areaStyle: fadeArea(PAIR_A) }],
    };
    // chartTheme picks the line colour.
  }, [data, chartTheme]);

  /* ---------- Hour × weekday heat grid (Night Corridor) ----------
     Presentation only: the same `heatmap` rows the "When Emissions Happen"
     card already reads, laid out as a grid. Each cell is that weekday-hour's
     total over the Range divided by how many of that weekday the Range holds,
     the same per-day averaging timeProfile uses. No click: the tooltip, and
     the colour key under it, which highlights the cells a shade stands for. */
  const heatGrid = useMemo(() => {
    if (!data || data.heatmap.length === 0) return null;
    const dowCount = [0, 0, 0, 0, 0, 0, 0];
    const end = new Date(`${data.range.to}T00:00:00`);
    for (const d = new Date(`${data.range.from}T00:00:00`); d <= end; d.setDate(d.getDate() + 1)) dowCount[d.getDay()]++;
    const cells = data.heatmap
      .filter((r) => DOW_ORDER.includes(r.dow) && r.hour >= 0 && r.hour < 24)
      .map((r) => ({
        hour: r.hour,
        row: DOW_ORDER.indexOf(r.dow),
        avg: dowCount[r.dow] > 0 ? r.v / dowCount[r.dow] : 0,
        total: r.v,
        days: dowCount[r.dow],
      }));
    if (cells.length === 0) return null;
    // From the values as drawn (2 dp), so the end cells sit inside the visualMap rather than just past it.
    const vals = cells.map((c) => Number(c.avg.toFixed(2)));
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const top = cells.reduce((a, b) => (b.avg > a.avg ? b : a));
    const low = cells.reduce((a, b) => (b.avg < a.avg ? b : a));
    // Dark runs quiet-dark to busy-bright, light runs paper to deep, both in
    // this tab's teal ramp so a busy cell is never read as a road state.
    const colors = chartTheme.isDark
      ? [chartTheme.seqLightest, RAMP[2], RAMP[1], RAMP[0]]
      : [chartTheme.seqLightest, RAMP[0], RAMP[1], RAMP[2]];
    /* Laid out like Traffic's hour x day heatmap (17 Oct 2026, testers EM-8): the same tooltip order (day
       and hour, then the value with its unit) and the shared RampKey under the grid. The visualMap stays
       hidden but continuous, so scrubbing the key can narrow it with selectDataRange; cells outside the
       band drop to one flat neutral, as on Traffic. */
    const neutral = chartTheme.isDark ? "rgba(244, 241, 234, 0.24)" : "rgba(11, 18, 32, 0.22)";
    const option: EChartsOption = {
      grid: { left: 44, right: 12, top: 8, bottom: 30 },
      xAxis: {
        type: "category",
        data: Array.from({ length: 24 }, (_, h) => fmtHour(h)),
        splitArea: { show: false },
        axisLabel: { interval: 2 },
        axisTick: { show: false },
      },
      yAxis: { type: "category", data: DOW_LABELS, inverse: true, axisTick: { show: false }, splitLine: { show: false } },
      visualMap: { show: false, type: "continuous", min, max, dimension: 2, calculable: false, inRange: { color: colors }, outOfRange: { color: neutral } },
      /* Through the shared heat-tooltip helpers (19 Oct 2026, testers EM-8: "copy Traffic's"), so a cell and
         the colour key's readout print the same figure with the same unit, as every heatmap on the dashboard
         does. confine keeps the box inside the card for the cells along the right edge. */
      tooltip: {
        trigger: "item",
        confine: true,
        formatter: (p) => {
          const c = cells[(p as { dataIndex: number }).dataIndex];
          if (!c) return "";
          const day = DOW_LABELS[c.row];
          return heatTip({
            title: `${day} ${fmtHour(c.hour)} – ${fmtHour((c.hour + 1) % 24)}`,
            value: heatValue(c.avg, HEAT_UNIT),
            detail: [`on an average ${day} over the Range`, `${fmtInt(c.total)} t across its ${fmtInt(c.days)} ${day}s`],
          });
        },
      },
      series: [
        {
          type: "heatmap",
          data: cells.map((c) => [c.hour, c.row, Number(c.avg.toFixed(2))]),
          itemStyle: { borderColor: chartTheme.tooltipBg, borderWidth: 2, borderRadius: 3 },
          emphasis: { itemStyle: { borderColor: chartTheme.ink, borderWidth: 1 } },
        },
      ],
    };
    return { option, min, max, top, low, colors };
  }, [data, chartTheme]);

  // ---------- Click-to-inspect ----------
  const filtersNote = data ? `Range: ${data.range.from} to ${data.range.to}` : "";

  const onTrendClick = (p: { dataIndex: number }) => {
    const r = trendRows[p.dataIndex];
    if (!r) return;
    const totals = trendRows.map((x) => x.total);
    const avg = totals.reduce((s, v) => s + v, 0) / totals.length;
    const rank = 1 + totals.filter((v) => v > r.total).length;
    const periodWord = heroPeriodOf(grain);
    const title = bucketLabelFor(grain)(r.label);
    setDetail({
      title,
      // The grain's own name: "day" + "ly" printed "dayly", and an hour read as a month.
      subtitle: `Modeled CO₂ · ${grain}`,
      rows: [
        ["Total CO₂", `${fmtInt(r.total)} t`],
        [CLASS_SHORT[0], `${fmtInt(r.c1)} t`],
        [CLASS_SHORT[1], `${fmtInt(r.c2)} t`],
        [CLASS_SHORT[2], `${fmtInt(r.c3)} t`],
        ["Northbound / Southbound", `${fmtInt(r.nb)} t / ${fmtInt(r.sb)} t`],
        ...(r.bothdir ? [["Plazas not split by direction", `${fmtInt(r.bothdir)} t`] as [string, string]] : []),
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
        subtitle: "Modeled CO₂ in this hour of day",
        rows: [
          ["Avg on a weekday", `${fmt1(timeProfile.weekday[h])} t`],
          ["Avg on a weekend day", `${fmt1(timeProfile.weekend[h])} t`],
          ["Total in range", `${fmtInt(timeProfile.hourTotals[h])} t`],
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
        subtitle: "Modeled CO₂ on this day of week",
        rows: [
          ["Avg per day", `${fmt1(timeProfile.dowAvg[i])} t`],
          ["Total in range", `${fmtInt(timeProfile.dowTotalOrdered[i])} t across ${fmtInt(timeProfile.dowDaysOrdered[i])} ${DOW_LABELS[i]}s`],
          ["Rank among days", `#${rank} of 7`],
        ],
        note: filtersNote,
      });
    }
  };

  const onFleetClick = (p: { dataIndex: number }) => {
    if (!fleetRows || !fleetShown) return;
    // The same top-to-bottom order the chart draws, reversed onto its category indices.
    const rows = [...fleetShown].reverse();
    const r = rows[p.dataIndex];
    if (!r) return;
    const veh = fleetRows.base.shares;
    setDetail({
      title: r.full,
      subtitle: r.isBase ? "The baseline: share of vehicles by class" : "Share by vehicle class, against each class's share of vehicles",
      rows: fleetRows.cls.map((c, ci) => [
        CLASS_SHORT[ci],
        `${r.shares[ci].toFixed(1)}% · ${fmtCompact(r.values[ci])} ${r.unit}${!r.isBase && veh[ci] > 0 ? ` · ${(r.shares[ci] / veh[ci]).toFixed(1)}× its ${veh[ci].toFixed(1)}% of vehicles` : ""}`,
      ]) as [string, string][],
      note: `Emission factors (CO₂ g/km): ${fleetRows.cls.map((c, ci) => `${CLASS_SHORT[ci].split(" ")[0]} ${c.class}: ${fmtInt(c.co2_g_per_km)}`).join(" · ")}. ${filtersNote}`,
    });
  };

  const onHeavyShareClick = (p: { dataIndex: number }) => {
    const r = trendRows[p.dataIndex];
    if (!r) return;
    const share = r.total > 0 ? ((r.c2 + r.c3) / r.total) * 100 : 0;
    setDetail({
      title: bucketLabelFor(grain)(r.label),
      subtitle: "Heavy-vehicle share of modeled CO₂",
      rows: [
        [`Heavy-vehicle share, this ${heroPeriodOf(grain)}`, `${share.toFixed(1)}%`],
        ...(derived ? [["Heavy-vehicle share, whole Range", `${derived.heavyCo2Pct.toFixed(1)}%`] as [string, string]] : []),
        [CLASS_SHORT[1], `${fmtInt(r.c2)} t`],
        [CLASS_SHORT[2], `${fmtInt(r.c3)} t`],
        [CLASS_SHORT[0], `${fmtInt(r.c1)} t`],
        ["Total CO₂", `${fmtInt(r.total)} t`],
      ],
      note: `Heavy = Class 2 + Class 3 (buses, trucks). The whole-Range share is the Heavy-Vehicle Impact tile's figure. ${filtersNote}`,
    });
  };

  const onAqiClick = (p: { dataIndex: number }) => {
    if (!data) return;
    const r = data.aqiMonthly[p.dataIndex];
    if (!r) return;
    const tot = r.good + r.moderate + r.poor;
    setDetail({
      title: monthLabel(r.m),
      subtitle: "Air quality estimates (OpenWeatherMap air pollution model, hourly)",
      rows: [
        [AQI_BANDS[0], `${fmtInt(r.good)} readings (${tot > 0 ? ((r.good / tot) * 100).toFixed(1) : "—"}%)`],
        [AQI_BANDS[1], `${fmtInt(r.moderate)} readings (${tot > 0 ? ((r.moderate / tot) * 100).toFixed(1) : "—"}%)`],
        [AQI_BANDS[2], `${fmtInt(r.poor)} readings (${tot > 0 ? ((r.poor / tot) * 100).toFixed(1) : "—"}%)`],
        [`Avg ${spelled("PM2.5")}`, r.pm25 != null ? `${fmt1(r.pm25)} µg/m³` : "—"],
      ],
      note: `AQI (Air Quality Index) is the 1–5 OpenWeatherMap scale, OpenWeatherMap's modelled estimate at each exit's location: a separate estimate from the toll-based emissions, not a roadside measurement. ${filtersNote}`,
    });
  };

  /* Scrubbing the heat grid's key highlights the matching cells, as on Traffic: the hidden visualMap is
     narrowed to a band around the value under the cursor, and released when the cursor leaves. */
  const heatChart = useRef<unknown>(null);
  const scrubHeat = (t: number | null) => {
    const chart = heatChart.current as { dispatchAction: (a: Record<string, unknown>) => void; isDisposed?: () => boolean } | null;
    if (!chart || chart.isDisposed?.() || !heatGrid) return;
    const { min: lo, max: hi } = heatGrid;
    if (t == null) {
      chart.dispatchAction({ type: "selectDataRange", visualMapIndex: 0, selected: [lo, hi] });
      return;
    }
    // A band rather than a point: an exact value would match almost nothing.
    const v = lo + t * (hi - lo);
    const pad = (hi - lo) * 0.08;
    chart.dispatchAction({ type: "selectDataRange", visualMapIndex: 0, selected: [Math.max(lo, v - pad), Math.min(hi, v + pad)] });
  };

  const chartFrame = (option: EChartsOption | null, emptyNote: string, onClick?: (p: never) => void, onReady?: (chart: unknown) => void) => {
    if (loading && !data) return <ChartSkeleton />;
    if (error)
      return (
        <div className="nc-em-state">
          <StateNote kind="error" size={44}>Live data unavailable — is the backend running on port 4000?</StateNote>
        </div>
      );
    if (!option)
      return (
        <div className="nc-em-state">
          <StateNote kind="nodata" size={44}>{emptyNote}</StateNote>
        </div>
      );
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
          onClick || onReady
            ? (chart) => {
                if (onClick) attachCategoryClick(chart as never, onClick as never);
                onReady?.(chart);
              }
            : undefined
        }
      />
    );
  };

  // A skeleton rather than an ellipsis: the tile keeps its height, so the KPI
  // row does not resize under the cursor as the numbers arrive.
  const kpiValue = (v: string | null) =>
    loading && !data ? <KpiSkeleton /> : <CountUpValue text={v ?? "—"} />;
  const aqiWord = (a: number) => (a < 1.5 ? "Good" : a < 2.5 ? "Fair" : a < 3.5 ? "Moderate" : a < 4.5 ? "Poor" : "Very poor");

  /* ---------- Card answers ----------
     Each card opens with its answer: one number with its unit, computed here
     from the rows already loaded, at render time. Nothing below is fetched or
     stored; when the rows are missing the answer is simply not drawn. */
  const visibleOf = (r: TrendRow) => (classView === "All" ? r.total : r[`c${classView}` as "c1" | "c2" | "c3"]);
  const lastTrend = trendRows.length > 0 ? trendRows[trendRows.length - 1] : null;
  const trendMean = trendRows.length > 0 ? trendRows.reduce((s, r) => s + visibleOf(r), 0) / trendRows.length : 0;
  const lastVsMean = lastTrend && trendMean > 0 ? ((visibleOf(lastTrend) - trendMean) / trendMean) * 100 : null;
  const heroPeriod = heroPeriodOf(grain);
  const lastShare = heavyShareRows.length > 0 ? heavyShareRows[heavyShareRows.length - 1].share : null;
  const aqiTotals =
    data && data.aqiMonthly.length > 0
      ? data.aqiMonthly.reduce((a, r) => ({ good: a.good + r.good, all: a.all + r.good + r.moderate + r.poor }), { good: 0, all: 0 })
      : null;
  const aqiGoodPct = aqiTotals && aqiTotals.all > 0 ? (aqiTotals.good / aqiTotals.all) * 100 : null;
  const aqiSpan =
    data && data.aqiMonthly.length > 0
      ? `${monthLabel(data.aqiMonthly[0].m)} – ${monthLabel(data.aqiMonthly[data.aqiMonthly.length - 1].m)}`
      : "";

  /* The Range control. Shown on the Prescriptive tab as well: its strategies
     are computed over this Range, and with the control only on the
     Descriptive tab the reader could neither see which Range the bars
     described nor change it without leaving the tab. */
  const rangeControl = (
    <div className={styles.filterGroup}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-muted)" }}><rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.4" /><path d="M2 6h12" stroke="currentColor" strokeWidth="1.4" /><path d="M5.5 2V4M10.5 2V4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      <span className={styles.filterLabel}>Range</span>
      <div className={styles.segmented}>
        {(["3", "12", "all", "custom"] as const).map((m) => (
          <button key={m} className={rangeMode === m ? "active" : ""} onClick={() => setRangeMode(m)} aria-pressed={rangeMode === m}>
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

  /* Active filters as removable chips. Each × calls the control's own setter
     with its default (12 months, all classes): exactly what choosing that
     option in the control itself does. */
  const rangeChipText =
    rangeMode === "12"
      ? null
      : rangeMode === "3"
        ? "3 mo"
        : rangeMode === "all"
          ? "All dates"
          : customFrom && customTo
            ? `${customFrom} – ${customTo}`
            : "Custom · pick dates";
  const classChipText = classFilter === "All" ? null : CLASS_SHORT[Number(classFilter) - 1];
  const filterChips = (withClass: boolean) => {
    const chips: { key: string; label: string; text: string; reset: string; clear: () => void }[] = [];
    if (rangeChipText) chips.push({ key: "range", label: "Range", text: rangeChipText, reset: "12 mo", clear: () => setRangeMode("12") });
    if (withClass && classChipText) chips.push({ key: "class", label: "Class", text: classChipText, reset: "all classes", clear: () => setClassFilter("All") });
    if (chips.length === 0) return null;
    return (
      <div className="nc-em-chips" role="group" aria-label="Active filters">
        {chips.map((c) => (
          <span key={c.key} className="nc-em-chip">
            <span className="nc-em-chip-key">{c.label}</span>
            {c.text}
            <button type="button" onClick={c.clear} aria-label={`Clear ${c.label.toLowerCase()} filter, back to ${c.reset}`} title={`Back to ${c.reset}`}>
              <X size={12} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
    );
  };

  /* The mode switch, directly under the page title: one segmented control
     with an accent underline that slides to the active mode. Same buttons,
     same order, same onClick as before. */
  const modeTabs = (
    <div className={styles.modeTabs} style={{ ["--mode-i" as string]: modeIndex(activeTab) }}>
      {(["Descriptive", "Predictive", "Prescriptive"] as const).map((t) => (
        <button key={t} className={`${styles.modeTab} ${activeTab === t ? styles.modeTabActive : ""}`} onClick={() => setActiveTab(t)} aria-pressed={activeTab === t}>
          <ModeTabLabel mode={t} />
        </button>
      ))}
      <span className={styles.modeIndicator} aria-hidden="true" />
    </div>
  );

  /* The sticky filter bar. Predictive has no filters (as before), so it has
     no bar; Prescriptive keeps the Range its strategies are computed over. */
  const filterBar =
    activeTab === "Descriptive" ? (
      <div className={styles.filterRow}>
        {rangeControl}

        <div className={styles.filterGroup}>
          {/* Narrows the query, so every panel on the tab reports this class.
                Distinct from the hero chart's own Show control, which only hides
                series in that one plot. */}
          <span className={styles.filterLabel}>Class</span>
          <CustomSelect
            value={classFilter}
            onChange={(v) => {
              setClassFilter(v as ClassChoice);
              // A local view of a class the tab no longer loads would be blank.
              if (v !== "All") setClassView("All");
            }}
            options={[
              { label: "All classes", value: "All" },
              { label: CLASS_SHORT[0], value: "1" },
              { label: CLASS_SHORT[1], value: "2" },
              { label: CLASS_SHORT[2], value: "3" },
            ]}
          />
        </div>

        {loading && data && <span className={styles.updating}>Updating…</span>}
        <span className={styles.spacer} />
        {filterChips(true)}
      </div>
    ) : activeTab === "Prescriptive" ? (
      <div className={styles.filterRow}>
        {rangeControl}
        <span className={styles.spacer} />
        {filterChips(false)}
      </div>
    ) : null;

  return (
    <section className={`${styles.page} viz-emissions nc-em-page`}>
      <PageHeader accent="emissions" icon={Leaf} title="Emissions Overview" subtitle="Vehicle emissions and air quality trends across NLEX" />
      {modeTabs}
      {filterBar}

      {activeTab === "Predictive" && (
        <div className={styles.modeStage} key="Predictive">
          <div className={styles.spanFull}><PredictiveEmissionChart /></div>
          {/* The diagram's second Emission Forecasting box. Below the CO2
              panel rather than beside it: the fleet mix is what DRIVES the
              emission forecast, so it reads as the explanation of the chart
              above rather than a competing headline. */}
          <div className={styles.spanFull}><FleetMixForecastChart /></div>
        </div>
      )}

      {activeTab === "Prescriptive" && (
        <div className={styles.modeStage} key="Prescriptive">
          {/* Ranked action cards, then the evidence card (title, chart, basis).
              The panel draws both, so its loading, error and no-data states
              keep the card's title. It reads the Range exactly as before. */}
          <PrescriptiveEmissionsPanel
            months={rangeMode === "custom" ? "12" : rangeMode}
            from={rangeMode === "custom" ? customFrom : undefined}
            to={rangeMode === "custom" ? customTo : undefined}
          />
        </div>
      )}

      {activeTab === "Descriptive" && (
        <div className={styles.modeStage} key="Descriptive">
          {/* KPI strip: answer, context, method (the ⓘ) on every tile */}
          <div className={`${styles.kpiRow} ds-rise nc-em-kpis`}>
            <article className={styles.kpiTile}>
              <span className={styles.kpiIcon} aria-hidden="true"><Leaf size={15} /></span>
              {/* One span per label: the tile's h3 is a flex row, and loose words beside an <abbr> would
                  each become a flex item with their spaces dropped. */}
              <h3><span>Total <Term t="CO₂" /> (Modeled)</span><InfoTooltip text="Tonnes of tailpipe CO₂ (carbon dioxide) over the Range: the kilometres each toll trip drove on NLEX, read from its entry and exit plaza, × the EMEP/EEA Guidebook 2023 factor for its vehicle class. Modeled, not a sensor reading: no CO₂ is metered on NLEX. Range: open-section trips have no exit on record, and a toll class is a mix of vehicles, so the low and high take the nearest exit with the lowest fitting factor and the farthest with the highest. The same record the CO₂ forecast is trained on, so the two agree." /></h3>
              <div className={styles.kpiValue} title={data ? `${fmtInt(data.kpis.totalCo2T)} tonnes` : undefined}>
                {kpiValue(data ? `${fmtCompact(data.kpis.totalCo2T)} t` : null)}
              </div>
              <p className={styles.kpiHint}>
                {derived ? (
                  <span className={derived.deltaPct <= 0 ? styles.deltaUp : styles.deltaDown}>{fmtPct(derived.deltaPct)}</span>
                ) : "—"}{" "}
                vs previous period
                {data?.kpis.co2LowT ? <> · range {fmtCompact(data.kpis.co2LowT)}–{fmtCompact(data.kpis.co2HighT ?? 0)} t</> : null}
              </p>
            </article>
            <article className={styles.kpiTile}>
              <span className={styles.kpiIcon} aria-hidden="true"><CalendarClock size={15} /></span>
              <h3><span>Avg Daily <Term t="CO₂" /></span><InfoTooltip text="Modeled CO₂ divided by the number of days in the Range." /></h3>
              <div className={styles.kpiValue}>{kpiValue(derived ? `${fmtInt(derived.avgDailyT)} t` : null)}</div>
              <div className={`${styles.sparkBox} nc-em-spark`}>
                {sparkOption && <ReactECharts option={applyChartTheme(sparkOption, chartTheme)} style={{ width: "100%", height: "100%" }} opts={{ renderer: "canvas" }} />}
              </div>
              {sparkOption && <p className={styles.kpiHint}>7-day rolling mean of daily CO₂</p>}
            </article>
            <article className={styles.kpiTile}>
              <span className={styles.kpiIcon} aria-hidden="true"><Truck size={15} /></span>
              {/* Says which window and which denominator (17 Oct 2026, testers EM-6.2): this is the whole
                  Range, and "traffic" meant the share of vehicles counted. */}
              <h3>Heavy-Vehicle Impact<InfoTooltip text={`Share of the modeled CO₂ over the whole Range that comes from Class 2–3 (buses and trucks), against their share of the vehicles counted at the toll plazas. Heavy classes emit far more per kilometre${derived ? ` (g CO₂/km: ${derived.factorText})` : ""}. The Heavy-Vehicle Share of CO₂ chart below breaks the same share down period by period; its dashed line is this figure.`} /></h3>
              <div className={styles.kpiValue}>{kpiValue(derived ? (derived.oneClass ? "—" : `${derived.heavyCo2Pct.toFixed(1)}%`) : null)}</div>
              <p className={styles.kpiHint}>
                {derived
                  ? derived.oneClass
                    ? "Compares classes · set Class to all"
                    : `of the Range's CO₂, from just ${derived.heavyVolPct.toFixed(1)}% of vehicles`
                  : "—"}
              </p>
            </article>
            <article className={styles.kpiTile}>
              <span className={styles.kpiIcon} aria-hidden="true"><Clock size={15} /></span>
              <h3>Peak Emission Hour<InfoTooltip text="The hour of the day with the highest modeled CO₂, which follows the volume peak weighted by fleet mix." /></h3>
              <div className={styles.kpiValue}>{kpiValue(timeProfile ? fmtHour(timeProfile.peakHour) : null)}</div>
              <p className={styles.kpiHint}>
                {timeProfile ? `${fmt1(timeProfile.allHour[timeProfile.peakHour])} t/day in that hour` : "—"}
              </p>
            </article>
            <article className={styles.kpiTile}>
              <span className={styles.kpiIcon} aria-hidden="true"><Timer size={15} /></span>
              <h3><span>Delay-Induced <Term t="CO₂" /></span><InfoTooltip text="Idling CO₂ from the queues behind accidents that blocked a lane in the Range. Each queue builds for as long as the lane is blocked (not for as long as the site takes to clear) and drains as it reopens (area λ×T²/2 at that segment's vehicles per hour), so long incidents carry most of it. Moving vehicles' CO₂ does not change with speed in this model: this is the part a delay adds. Counted over all vehicles, so it is not shown for a single class." /></h3>
              <div className={styles.kpiValue}>{kpiValue(data?.kpis.delayCarbonT != null ? `${fmtInt(data.kpis.delayCarbonT)} t` : data ? "—" : null)}</div>
              <p className={styles.kpiHint}>
                {data?.kpis.delayCarbonT != null
                  ? `${(data.kpis.delayCarbonPct ?? 0).toFixed(2)}% of CO₂ · ${(data.kpis.delayLongSharePct ?? 0).toFixed(0)}% from ${fmtInt(data.kpis.delayLongIncidents ?? 0)} lane blockages over 3\u00a0h`
                  : data?.meta.vehicleClass != null
                    ? "Not split by class · set Class to all"
                    : "—"}
              </p>
            </article>
            <article className={styles.kpiTile}>
              <span className={styles.kpiIcon} aria-hidden="true"><Wind size={15} /></span>
              {/* Was described as the "latest" readings; the figure is the Range's average (17 Oct 2026). */}
              <h3>Estimated Air Quality<InfoTooltip text="Average AQI (Air Quality Index, OpenWeatherMap's 1 = good to 5 = very poor scale) over the Range, from OpenWeatherMap's hourly air pollution estimates at each exit's location, with their average PM2.5 (fine particulate matter). OpenWeatherMap's model, not a roadside instrument, and not split by vehicle class: shown beside the modeled CO₂ for context. It is the air level from every source nearby, weather included, so it is not a check on the emission totals." /></h3>
              <div className={styles.kpiValue} title={POLLUTANT_NAMES.AQI}>
                {kpiValue(data?.kpis.avgAqi != null ? `${data.kpis.avgAqi.toFixed(1)} / 5` : null)}
              </div>
              <p className={styles.kpiHint}>
                {data?.kpis.avgAqi != null ? (
                  <>
                    {aqiWord(data.kpis.avgAqi)} · avg <Term t="PM2.5" /> {data.kpis.avgPm25 != null ? fmt1(data.kpis.avgPm25) : "—"} µg/m³
                  </>
                ) : (
                  "no estimates in range"
                )}
              </p>
            </article>
          </div>

          {/* Main time series, full width: modeled CO2 trend by class */}
          <article className={`${styles.chartCard} ${styles.chart1} ${styles.hero}`}>
            <div className={styles.chartHead}>
              <div className={styles.headText}>
                <h3><Term t="CO₂" /> Emissions Trend by Vehicle Class<InfoTooltip text="Modeled CO₂ (carbon dioxide) per hour, day, week or month, split by vehicle class so you can see which classes drive the total. Hourly is offered for ranges up to two weeks." /></h3>
                {lastTrend && (
                  <p className="nc-em-answer">
                    <b>{fmtInt(visibleOf(lastTrend))} t</b>
                    <span>CO₂ in the latest {heroPeriod} · {bucketLabelFor(grain)(lastTrend.label)}</span>
                  </p>
                )}
                {lastTrend && (
                  <p className={styles.subtitle}>
                    {lastVsMean != null ? `${fmtPct(lastVsMean)} vs the range average · ` : ""}
                    {filtersNote}
                  </p>
                )}
              </div>
            </div>
            <div className={styles.heroFilters}>
              <div className={styles.heroFilterGroup}>
                <span className={styles.heroFilterLabel}>Show</span>
                <CustomSelect
                  value={classView}
                  onChange={(v) => setClassView(v as ClassChoice)}
                  // Locked once the tab itself is filtered to one class: the other two
                  // series hold nothing at that point, so there is nothing left for
                  // this control to show or hide.
                  disabled={classFilter !== "All"}
                  title={
                    classFilter !== "All"
                      ? "The tab is filtered to one class — set Class back to all to choose what this chart shows"
                      : undefined
                  }
                  options={[
                    { label: "All classes", value: "All" },
                    { label: CLASS_SHORT[0], value: "1" },
                    { label: CLASS_SHORT[1], value: "2" },
                    { label: CLASS_SHORT[2], value: "3" },
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
                      aria-pressed={grain === g}
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
            </div>
            <div className={styles.chartBody}>{chartFrame(trendOption, "No emissions data for the selected range", onTrendClick)}</div>
          </article>

          {/* Breakdowns, two columns: when + who */}
          <article className={`${styles.chartCard} ${styles.chart2} nc-em-half`}>
            <div className={styles.chartHead}>
              <div className={styles.headText}>
                <h3>When Emissions Happen<InfoTooltip text="Modeled CO₂ by hour of day and day of week — when the corridor's emissions concentrate." /></h3>
                {timeProfile && (
                  <p className="nc-em-answer">
                    <b>{fmtHour(timeProfile.peakHour)}</b>
                    <span>peak hour, all days</span>
                  </p>
                )}
                {timeTakeaway && <p className={styles.subtitle}>{timeTakeaway}</p>}
              </div>
              <div className={styles.segmentedSmall}>
                {(["hour", "dow"] as const).map((v) => (
                  <button key={v} className={timeView === v ? "active" : ""} onClick={() => setTimeView(v)} aria-pressed={timeView === v}>
                    {timeView === v && <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    {v === "hour" ? "By hour" : "By day"}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.chartBody}>{chartFrame(timeOption, "No data for the selected range", onTimeClick)}</div>
          </article>

          <article className={`${styles.chartCard} ${styles.chart3} nc-em-half`}>
            <div className={styles.chartHead}>
              <div className={styles.headText}>
                <h3>Fleet Mix vs Pollution Load<InfoTooltip text="Each vehicle class's share of three modeled pollutants: CO₂ (carbon dioxide), NOx (nitrogen oxides) and PM2.5 (fine particulate matter). All three are modeled as vehicles × km × a per-class factor, so where a class's pollutant share is larger than its share of the vehicles counted, it pollutes out of proportion to its numbers. Hover a bar for that multiple; Vehicle baseline draws the vehicle shares as a faded bar on top. Click a class in the legend to hide it." /></h3>
                {fleetTakeaway && derived && (
                  <p className="nc-em-answer">
                    <b>{derived.heavyCo2Pct.toFixed(1)}%</b>
                    <span>of <Term t="CO₂" /> from heavy vehicles (Class 2–3)</span>
                  </p>
                )}
                {fleetTakeaway && <p className={styles.subtitle}>{fleetTakeaway}</p>}
              </div>
            </div>
            {fleetRows && !error && (
              <div className={`${styles.heroFilters} nc-em-fleet-ctl`} role="group" aria-label="Fleet mix view">
                <div className={styles.heroFilterGroup}>
                  <span className={styles.heroFilterLabel}>Sort</span>
                  <div className={styles.segmentedSmall}>
                    {([["listed", "Listed"], ["heavy", "Heavy share"]] as const).map(([k, label]) => (
                      <button
                        key={k}
                        className={fleetSort === k ? "active" : ""}
                        aria-pressed={fleetSort === k}
                        onClick={() => setFleetSort(k)}
                        title={k === "heavy" ? "Pollutants ordered by the share that comes from Class 2 + 3, largest first" : "CO₂, NOx, PM2.5"}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={styles.heroFilterGroup}>
                  <span className={styles.heroFilterLabel}>Classes</span>
                  <div className={styles.segmentedSmall}>
                    {([["all", "All"], ["heavy", "Class 2–3"]] as const).map(([k, label]) => (
                      <button
                        key={k}
                        className={fleetClasses === k ? "active" : ""}
                        aria-pressed={fleetClasses === k}
                        onClick={() => setFleetClasses(k)}
                        title={k === "heavy" ? "Only the heavy classes, starting from 0% so their shares read straight off the axis" : "All three classes, stacked to 100%"}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={styles.segmentedSmall}>
                  <button
                    className={fleetBaseline ? "active" : ""}
                    aria-pressed={fleetBaseline}
                    onClick={() => setFleetBaseline((v) => !v)}
                    title="Draw each class's share of the vehicles counted as a faded bar on top: the yardstick for the pollutant bars"
                  >
                    Vehicle baseline
                  </button>
                </div>
              </div>
            )}
            <div className={styles.chartBody}>{chartFrame(fleetOption, derived?.oneClass ? ONE_CLASS_NOTE : "No data for the selected range", onFleetClick)}</div>
          </article>

          {/* where it is heading + measured reality */}
          <article className={`${styles.chartCard} ${styles.chart4} nc-em-half`}>
            <div className={styles.chartHead}>
              <div className={styles.headText}>
                <h3>Heavy-Vehicle Share of <Term t="CO₂" /><InfoTooltip text="The share of modeled CO₂ from Class 2–3 (buses and trucks) in each hour, day, week or month, at the trend chart's granularity. The big figure is the latest period; the dashed line is the share over the whole Range, the same figure as the Heavy-Vehicle Impact tile, so the two differ by exactly how far the latest period sits from the Range. Incomplete first and last weeks or months are left off, as on the trend chart." /></h3>
                {heavyShareTakeaway && lastShare != null && trendRows.length > 0 && (
                  <p className="nc-em-answer">
                    <b>{lastShare.toFixed(1)}%</b>
                    <span>in the latest {heroPeriod} · {bucketLabelFor(grain)(trendRows[trendRows.length - 1].label)}</span>
                  </p>
                )}
                {heavyShareTakeaway && <p className={styles.subtitle}>{heavyShareTakeaway}</p>}
              </div>
            </div>
            <div className={styles.chartBody}>{chartFrame(heavyShareOption, derived?.oneClass ? ONE_CLASS_NOTE : "No data for the selected range", onHeavyShareClick)}</div>
          </article>

          <article className={`${styles.chartCard} ${styles.chart5} nc-em-half`}>
            <div className={styles.chartHead}>
              <div className={styles.headText}>
                {/* The ⓘ promised pollutant levels; the bars are the share of readings in each AQI band (17 Oct 2026). */}
                <h3>Estimated Air Quality by Month<InfoTooltip text="For each month, the share of OpenWeatherMap's hourly estimates along the corridor in each AQI (Air Quality Index, OpenWeatherMap's 1–5 scale) band; the tooltip adds that month's average PM2.5 (fine particulate matter). OpenWeatherMap's model, not a roadside instrument. The source's levels shift sharply between March and April 2025, so compare across that date with care." /></h3>
                {aqiGoodPct != null && aqiTotals && (
                  <p className="nc-em-answer">
                    <b>{aqiGoodPct.toFixed(1)}%</b>
                    <span>of readings {AQI_BANDS[0]}</span>
                  </p>
                )}
                {aqiGoodPct != null && aqiTotals && (
                  <p className={styles.subtitle}>
                    {fmtInt(aqiTotals.all)} hourly estimates · {aqiSpan}
                  </p>
                )}
              </div>
            </div>
            <div className={styles.chartBody}>{chartFrame(aqiOption, "No estimates in the selected range", onAqiClick)}</div>
          </article>

          {/* Heat grid: the hour × weekday data the page already loads */}
          <article className={`${styles.chartCard} ${styles.chart1} nc-em-heat`}>
            <div className={styles.chartHead}>
              <div className={styles.headText}>
                <h3><Term t="CO₂" /> by Hour and Weekday<InfoTooltip text="Average modeled CO₂ in each hour of each weekday over the Range: that slot's total divided by the number of those weekdays in the Range. Point along the colour key below to read a shade's value and pick out the matching hours." /></h3>
                {heatGrid && (
                  <p className="nc-em-answer">
                    <b>{DOW_LABELS[heatGrid.top.row]} · {fmtHour(heatGrid.top.hour)}</b>
                    <span>busiest hour of the week, {fmt1(heatGrid.top.avg)} t on average</span>
                  </p>
                )}
                {heatGrid && (
                  <p className={styles.subtitle}>
                    Quietest: {DOW_LABELS[heatGrid.low.row]} · {fmtHour(heatGrid.low.hour)}, {fmt1(heatGrid.low.avg)} t · {filtersNote}
                  </p>
                )}
              </div>
            </div>
            <div className={`${styles.chartBody} nc-em-heat-body`}>
              {chartFrame(heatGrid?.option ?? null, "No data for the selected range", undefined, (c) => { heatChart.current = c; })}
            </div>
            {heatGrid && data && !error && (
              <RampKey
                colors={heatGrid.colors}
                min={heatGrid.min}
                max={heatGrid.max}
                format={(v) => heatValue(v, HEAT_UNIT)}
                lowLabel={`Less · ${fmtHeatNumber(heatGrid.min)} t`}
                highLabel={`${fmtHeatNumber(heatGrid.max)} t · More`}
                onScrub={scrubHeat}
              />
            )}
          </article>
        </div>
      )}

      {/* Click-to-inspect detail modal (opened from the Descriptive charts) */}
      {activeTab === "Descriptive" && detail && (
        <div className={styles.detailBackdrop} role="dialog" aria-modal="true" aria-label={detail.title} onClick={() => setDetail(null)}>
          <div className={styles.detailModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.detailAccent} />
            <div className={styles.detailHeader}>
              <div className={styles.detailIcon}><Leaf size={18} aria-hidden="true" /></div>
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
    </section>
  );
}
