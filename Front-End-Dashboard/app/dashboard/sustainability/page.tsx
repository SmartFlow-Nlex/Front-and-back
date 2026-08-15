"use client";

import { useEffect, useMemo, useState } from "react";
import { attachCategoryClick } from "../../../lib/chart-click";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { Leaf } from "lucide-react";
import DashboardChart from "../../../components/dashboard/DashboardChart";
import PageHeader from "../../../components/dashboard/PageHeader";
import PredictiveEmissionChart from "../../../components/dashboard/PredictiveEmissionChart";
import DateRangePicker from "../traffic/components/DateRangePicker";
import styles from "../traffic/traffic.module.css";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Vehicle classes are ordered light → heavy, so they wear an ordinal single-hue
// ramp (validated): darker = heavier fleet.
const CLASS_RAMP = ["#8fa8ee", "#3e67ef", "#1d3aa8"];
const CLASS_SHORT = ["Class 1 · Light", "Class 2 · Medium", "Class 3 · Heavy"];
// Categorical pair for weekday/weekend and NB/SB comparisons (validated)
const BLUE = "#3e67ef";
const ORANGE = "#e06b47";
// Measured air quality bands, ordered good → poor (validated ordinal warm ramp):
// darker = more polluted.
const AQI_RAMP = ["#e3a06b", "#c96a33", "#8d4118"];
const AQI_BANDS = ["Good (AQI 1–2)", "Moderate (AQI 3)", "Poor (AQI 4–5)"] as const;

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

// ---------- Data contract ----------
type Analytics = {
  range: { from: string; to: string };
  meta: { minDate: string; maxDate: string };
  kpis: {
    totalCo2T: number;
    prevCo2T: number;
    avgAqi: number | null;
    aqiSamples: number;
    avgPm25: number | null;
  };
  dailyTrend: { d: string; c1: number; c2: number; c3: number; nb: number; sb: number }[];
  heatmap: { dow: number; hour: number; v: number }[];
  classes: { class: number; label: string; co2_g_per_km: number; volume: number; co2_t: number; pm25_kg: number; no2_kg: number }[];
  aqiMonthly: { m: string; good: number; moderate: number; poor: number; pm25: number | null }[];
};

type Granularity = "daily" | "weekly" | "monthly";
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

function weekStart(dateStr: string): string {
  const dt = new Date(`${dateStr}T00:00:00`);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

// ---------- Prescriptive mock (unchanged tab) ----------
const prescriptiveEmissionReduction: EChartsOption = {
  grid: { left: 46, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: ["Strategy X", "Strategy Y", "Strategy Z"] },
  yAxis: { type: "value" },
  tooltip: { trigger: "axis" },
  series: [{ type: "bar", data: [8, 14, 22], itemStyle: { color: "#4bb782", borderRadius: [8, 8, 0, 0] } }],
};

export default function SustainabilityPage() {
  const [activeTab, setActiveTab] = useState<"Descriptive" | "Predictive" | "Prescriptive">("Descriptive");

  // Global filters
  const [rangeMode, setRangeMode] = useState<RangeMode>("12");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  // Chart-local interactivity
  const [grain, setGrain] = useState<Granularity>("monthly");
  const [timeView, setTimeView] = useState<"hour" | "dow">("hour");
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
    fetch(`${BACKEND}/api/emissions/analytics?${qs}`, { cache: "no-store" })
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
  }, [rangeMode, customFrom, customTo]);

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

    return { deltaPct, heavyVolPct, heavyCo2Pct, avgDailyT, totVol, totCo2 };
  }, [data]);

  // ---------- Hero: CO2 trend by class ----------
  type TrendRow = { label: string; c1: number; c2: number; c3: number; nb: number; sb: number; total: number };
  const trendRows = useMemo<TrendRow[]>(() => {
    if (!data) return [];
    const keyOf = grain === "daily" ? (d: string) => d : grain === "weekly" ? weekStart : (d: string) => d.slice(0, 7);
    const acc = new Map<string, { c1: number; c2: number; c3: number; nb: number; sb: number; days: number }>();
    for (const r of data.dailyTrend) {
      const k = keyOf(r.d);
      const cur = acc.get(k) ?? { c1: 0, c2: 0, c3: 0, nb: 0, sb: 0, days: 0 };
      acc.set(k, { c1: cur.c1 + r.c1, c2: cur.c2 + r.c2, c3: cur.c3 + r.c3, nb: cur.nb + r.nb, sb: cur.sb + r.sb, days: cur.days + 1 });
    }
    let rows = [...acc.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([label, v]) => ({ label, ...v, total: v.c1 + v.c2 + v.c3 }));
    // A partial first/last bucket (a "month" holding 2 days) reads as a fake
    // collapse in a stacked trend — trim incomplete edge buckets for rolled-up grains.
    if (grain !== "daily" && rows.length > 2) {
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
    const boundaryKey = grain === "monthly" ? (l: string) => l : (l: string) => l.slice(0, 7);
    const labelInterval = (i: number) => i === 0 || boundaryKey(labels[i]) !== boundaryKey(labels[i - 1]);

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
      grid: { left: 62, right: 16, top: 30, bottom: 22 },
      xAxis: { type: "category", data: labels, axisLabel: { interval: labelInterval, fontSize: 10, hideOverlap: true }, axisTick: { show: false } },
      yAxis: { type: "value", name: "tonnes CO₂", nameGap: 10, nameTextStyle: { fontSize: 9, align: "left" }, splitNumber: 3, axisLabel: { fontSize: 10, formatter: (v: number) => fmtCompact(v) } },
      tooltip: {
        trigger: "axis",
        formatter: (p) => {
          const items = p as { seriesName: string; dataIndex: number; value: number; marker: string }[];
          const i = items[0].dataIndex;
          const r = trendRows[i];
          const rows = items.map((x) => `${x.marker} ${x.seriesName}: ${fmtInt(x.value)} t`).join("<br/>");
          return `<b>${r.label}</b><br/>${rows}<br/>Total: <b>${fmtInt(r.total)} t</b>`;
        },
      },
      legend: { show: true, top: 0, right: 8, itemWidth: 14, textStyle: { fontSize: 11 } },
      series: [mk(CLASS_SHORT[0], "c1", CLASS_RAMP[0]), mk(CLASS_SHORT[1], "c2", CLASS_RAMP[1]), mk(CLASS_SHORT[2], "c3", CLASS_RAMP[2])],
    };
  }, [trendRows, grain]);

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

  const timeTakeaway = timeProfile
    ? `Peak around ${fmtHour(timeProfile.peakHour)} · quietest around ${fmtHour(timeProfile.quietHour)} · heaviest day: ${DOW_LABELS[timeProfile.busiestDow]}`
    : null;

  const timeOption = useMemo<EChartsOption | null>(() => {
    if (!timeProfile) return null;

    if (timeView === "hour") {
      const peakIdx = timeProfile.weekday.indexOf(Math.max(...timeProfile.weekday));
      return {
        grid: { left: 48, right: 16, top: 34, bottom: 24 },
        xAxis: { type: "category", boundaryGap: false, data: Array.from({ length: 24 }, (_, h) => fmtHour(h)), axisLabel: { interval: 3, fontSize: 10 }, axisTick: { show: false } },
        yAxis: { type: "value", name: "avg t CO₂ / day", nameGap: 10, nameTextStyle: { fontSize: 9, align: "left" }, splitNumber: 3, axisLabel: { fontSize: 10 } },
        tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : `${fmt1(Number(v))} t`) },
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
      grid: { left: 48, right: 16, top: 34, bottom: 24 },
      xAxis: { type: "category", data: DOW_LABELS, axisLabel: { interval: 0, fontSize: 10 }, axisTick: { show: false } },
      yAxis: { type: "value", name: "avg t CO₂ / day", nameGap: 10, nameTextStyle: { fontSize: 9, align: "left" }, splitNumber: 3, axisLabel: { fontSize: 10 } },
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
            itemStyle: { color: i === maxIdx ? BLUE : "#8fa8ee", borderRadius: [4, 4, 0, 0] },
            label: i === maxIdx ? { show: true, position: "top", fontSize: 10, color: "#475069", formatter: () => fmt1(v) } : undefined,
          })),
          barMaxWidth: 26,
        },
      ],
    };
  }, [timeProfile, timeView]);

  // ---------- Fleet mix vs pollution load ----------
  const fleetRows = useMemo(() => {
    if (!data || data.classes.length === 0 || !derived) return null;
    const cls = [...data.classes].sort((a, b) => a.class - b.class);
    const metric = (key: "volume" | "co2_t" | "no2_kg" | "pm25_kg") => {
      const tot = cls.reduce((s, c) => s + c[key], 0);
      return { values: cls.map((c) => c[key]), shares: cls.map((c) => (tot > 0 ? (c[key] / tot) * 100 : 0)), tot };
    };
    return {
      cls,
      rows: [
        { label: "Traffic volume", unit: "vehicles", ...metric("volume") },
        { label: "CO₂", unit: "t", ...metric("co2_t") },
        { label: "NO₂", unit: "kg", ...metric("no2_kg") },
        { label: "PM2.5", unit: "kg", ...metric("pm25_kg") },
      ],
    };
  }, [data, derived]);

  const fleetTakeaway =
    derived && derived.heavyVolPct > 0
      ? `Heavy vehicles (Class 2–3): ${derived.heavyVolPct.toFixed(1)}% of traffic → ${derived.heavyCo2Pct.toFixed(1)}% of CO₂`
      : null;

  const fleetOption = useMemo<EChartsOption | null>(() => {
    if (!fleetRows) return null;
    const rows = [...fleetRows.rows].reverse(); // display top-to-bottom: volume first
    return {
      grid: { left: 92, right: 16, top: 34, bottom: 24 },
      xAxis: { type: "value", max: 100, interval: 25, axisLabel: { fontSize: 10, formatter: "{value}%" } },
      yAxis: { type: "category", data: rows.map((r) => r.label), axisLabel: { interval: 0, fontSize: 10 }, axisTick: { show: false } },
      tooltip: {
        trigger: "axis",
        formatter: (p) => {
          const items = p as { seriesIndex: number; dataIndex: number; value: number; marker: string }[];
          const r = rows[items[0].dataIndex];
          const lines = items
            .map((x) => `${x.marker} ${CLASS_SHORT[x.seriesIndex]}: ${x.value.toFixed(1)}% (${fmtCompact(r.values[x.seriesIndex])} ${r.unit})`)
            .join("<br/>");
          return `<b>${r.label}</b><br/>${lines}`;
        },
      },
      legend: { show: true, top: 0, right: 8, itemWidth: 14, textStyle: { fontSize: 11 } },
      series: fleetRows.cls.map((c, ci) => ({
        name: CLASS_SHORT[ci],
        type: "bar" as const,
        stack: "share",
        data: rows.map((r) => Number(r.shares[ci].toFixed(1))),
        itemStyle: { color: CLASS_RAMP[ci], borderColor: "#fff", borderWidth: 1 },
        barMaxWidth: 18,
      })),
    };
  }, [fleetRows]);

  // ---------- Heavy-vehicle share of CO2 over time ----------
  const heavyShareRows = useMemo(() => {
    return trendRows.map((r) => ({
      label: r.label,
      share: r.total > 0 ? ((r.c2 + r.c3) / r.total) * 100 : 0,
    }));
  }, [trendRows]);

  const heavyShareTakeaway = useMemo(() => {
    if (heavyShareRows.length < 2) return null;
    const first = heavyShareRows[0].share;
    const last = heavyShareRows[heavyShareRows.length - 1].share;
    const dir = last - first > 0.5 ? "rising" : first - last > 0.5 ? "falling" : "steady";
    return `Now ${last.toFixed(1)}% — ${dir} across the range (from ${first.toFixed(1)}%)`;
  }, [heavyShareRows]);

  const heavyShareOption = useMemo<EChartsOption | null>(() => {
    if (heavyShareRows.length === 0) return null;
    const labels = heavyShareRows.map((r) => r.label);
    const boundaryKey = grain === "monthly" ? (l: string) => l : (l: string) => l.slice(0, 7);
    const labelInterval = (i: number) => i === 0 || boundaryKey(labels[i]) !== boundaryKey(labels[i - 1]);
    const avg = heavyShareRows.reduce((s, r) => s + r.share, 0) / heavyShareRows.length;
    return {
      grid: { left: 44, right: 16, top: 30, bottom: 22 },
      xAxis: { type: "category", data: labels, axisLabel: { interval: labelInterval, fontSize: 10, hideOverlap: true }, axisTick: { show: false } },
      yAxis: {
        type: "value",
        splitNumber: 3,
        axisLabel: { fontSize: 10, formatter: "{value}%" },
        min: (v: { min: number }) => Math.max(0, Math.floor(v.min - 2)),
        max: (v: { max: number }) => Math.ceil(v.max + 2),
      },
      tooltip: {
        trigger: "axis",
        formatter: (p) => {
          const items = p as { dataIndex: number; value: number }[];
          const r = trendRows[items[0].dataIndex];
          return `<b>${r.label}</b><br/>Heavy-vehicle share: <b>${items[0].value}%</b><br/>${fmtInt(r.c2 + r.c3)} t of ${fmtInt(r.total)} t CO₂`;
        },
      },
      series: [
        {
          type: "line",
          data: heavyShareRows.map((r) => Number(r.share.toFixed(1))),
          symbol: "none",
          smooth: true,
          itemStyle: { color: BLUE },
          lineStyle: { width: 2.5, color: BLUE },
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: "#9aa4b8", type: "dashed", width: 1 },
            label: { fontSize: 9, color: "#8a93a6", formatter: `avg ${avg.toFixed(1)}%`, position: "insideEndTop" },
            data: [{ yAxis: Number(avg.toFixed(1)) }],
          },
        },
      ],
    };
  }, [heavyShareRows, trendRows, grain]);

  // ---------- Measured air quality ----------
  const aqiOption = useMemo<EChartsOption | null>(() => {
    if (!data || data.aqiMonthly.length === 0) return null;
    const rows = data.aqiMonthly;
    const labels = rows.map((r) => monthLabel(r.m));
    const totals = rows.map((r) => r.good + r.moderate + r.poor);
    const share = (v: number, i: number) => (totals[i] > 0 ? Number(((v / totals[i]) * 100).toFixed(1)) : 0);
    const keys = ["good", "moderate", "poor"] as const;
    return {
      grid: { left: 40, right: 16, top: 34, bottom: 24 },
      xAxis: { type: "category", data: labels, axisLabel: { fontSize: 10, hideOverlap: true }, axisTick: { show: false } },
      yAxis: { type: "value", max: 100, splitNumber: 4, axisLabel: { fontSize: 10, formatter: "{value}%" } },
      tooltip: {
        trigger: "axis",
        formatter: (p) => {
          const items = p as { seriesIndex: number; dataIndex: number; value: number; marker: string }[];
          const i = items[0].dataIndex;
          const r = rows[i];
          const lines = items
            .map((x) => `${x.marker} ${AQI_BANDS[x.seriesIndex]}: ${x.value}% (${fmtInt(r[keys[x.seriesIndex]])} readings)`)
            .join("<br/>");
          return `<b>${labels[i]}</b><br/>${lines}<br/>Avg PM2.5: ${r.pm25 != null ? `${fmt1(r.pm25)} µg/m³` : "—"}`;
        },
      },
      legend: { show: true, top: 0, right: 8, itemWidth: 14, textStyle: { fontSize: 11 } },
      series: keys.map((k, ki) => ({
        name: AQI_BANDS[ki],
        type: "bar" as const,
        stack: "aqi",
        data: rows.map((r, i) => share(r[k], i)),
        itemStyle: { color: AQI_RAMP[ki], borderColor: "#fff", borderWidth: 1 },
        barMaxWidth: 22,
      })),
    };
  }, [data]);

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
      series: [{ type: "line", data: vals, symbol: "none", smooth: true, lineStyle: { width: 1.5, color: BLUE } }],
    };
  }, [data]);

  // ---------- Click-to-inspect ----------
  const filtersNote = data ? `Range: ${data.range.from} to ${data.range.to}` : "";

  const onTrendClick = (p: { dataIndex: number }) => {
    const r = trendRows[p.dataIndex];
    if (!r) return;
    const totals = trendRows.map((x) => x.total);
    const avg = totals.reduce((s, v) => s + v, 0) / totals.length;
    const rank = 1 + totals.filter((v) => v > r.total).length;
    const periodWord = grain === "daily" ? "day" : grain === "weekly" ? "week" : "month";
    const title = grain === "weekly" ? `Week of ${r.label}` : r.label;
    setDetail({
      title,
      subtitle: `Modeled CO₂ · ${periodWord}ly`,
      rows: [
        ["Total CO₂", `${fmtInt(r.total)} t`],
        [CLASS_SHORT[0], `${fmtInt(r.c1)} t`],
        [CLASS_SHORT[1], `${fmtInt(r.c2)} t`],
        [CLASS_SHORT[2], `${fmtInt(r.c3)} t`],
        ["Northbound / Southbound", `${fmtInt(r.nb)} t / ${fmtInt(r.sb)} t`],
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
    if (!fleetRows) return;
    const rows = [...fleetRows.rows].reverse();
    const r = rows[p.dataIndex];
    if (!r) return;
    setDetail({
      title: r.label,
      subtitle: "Share by vehicle class",
      rows: fleetRows.cls.map((c, ci) => [
        CLASS_SHORT[ci],
        `${r.shares[ci].toFixed(1)}% · ${fmtCompact(r.values[ci])} ${r.unit}`,
      ]) as [string, string][],
      note: `Emission factors (CO₂ g/km): ${fleetRows.cls.map((c, ci) => `${CLASS_SHORT[ci].split(" ")[0]} ${c.class}: ${fmtInt(c.co2_g_per_km)}`).join(" · ")}. ${filtersNote}`,
    });
  };

  const onHeavyShareClick = (p: { dataIndex: number }) => {
    const r = trendRows[p.dataIndex];
    if (!r) return;
    const share = r.total > 0 ? ((r.c2 + r.c3) / r.total) * 100 : 0;
    setDetail({
      title: grain === "weekly" ? `Week of ${r.label}` : r.label,
      subtitle: "Heavy-vehicle share of modeled CO₂",
      rows: [
        ["Heavy-vehicle share", `${share.toFixed(1)}%`],
        [CLASS_SHORT[1], `${fmtInt(r.c2)} t`],
        [CLASS_SHORT[2], `${fmtInt(r.c3)} t`],
        [CLASS_SHORT[0], `${fmtInt(r.c1)} t`],
        ["Total CO₂", `${fmtInt(r.total)} t`],
      ],
      note: `Heavy = Class 2 + Class 3 (buses, trucks). ${filtersNote}`,
    });
  };

  const onAqiClick = (p: { dataIndex: number }) => {
    if (!data) return;
    const r = data.aqiMonthly[p.dataIndex];
    if (!r) return;
    const tot = r.good + r.moderate + r.poor;
    setDetail({
      title: monthLabel(r.m),
      subtitle: "Measured air quality (OpenWeatherMap, hourly station readings)",
      rows: [
        [AQI_BANDS[0], `${fmtInt(r.good)} readings (${tot > 0 ? ((r.good / tot) * 100).toFixed(1) : "—"}%)`],
        [AQI_BANDS[1], `${fmtInt(r.moderate)} readings (${tot > 0 ? ((r.moderate / tot) * 100).toFixed(1) : "—"}%)`],
        [AQI_BANDS[2], `${fmtInt(r.poor)} readings (${tot > 0 ? ((r.poor / tot) * 100).toFixed(1) : "—"}%)`],
        ["Avg PM2.5", r.pm25 != null ? `${fmt1(r.pm25)} µg/m³` : "—"],
      ],
      note: `AQI is the 1–5 OpenWeatherMap scale measured at expressway stations — the observed counterpart to the modeled emissions. ${filtersNote}`,
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

  const kpiValue = (v: string | null) => (loading && !data ? "…" : v ?? "—");
  const aqiWord = (a: number) => (a < 1.5 ? "Good" : a < 2.5 ? "Fair" : a < 3.5 ? "Moderate" : a < 4.5 ? "Poor" : "Very poor");

  // ---------- Predictive / Prescriptive share the same shell ----------
  if (activeTab !== "Descriptive") {
    return (
      <section className={styles.page}>
        <PageHeader icon={Leaf} title="Emissions Overview" subtitle="Vehicle emissions and air quality trends across NLEX" />
        <div className={styles.filterRow}>
          {activeTab === "Prescriptive" && <span className={styles.filterLabel}>Projected emission reduction by strategy</span>}
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
          <div className={styles.spanFull}><PredictiveEmissionChart /></div>
        ) : (
          <article className={`${styles.chartCard} ${styles.chart1}`}>
            <div className={styles.chartHead}>
              <div className={styles.headText}>
                <h3>Projected % Emission Reduction by Strategy</h3>
              </div>
            </div>
            <div className={styles.chartBody}>
              <DashboardChart option={prescriptiveEmissionReduction} height={280} />
            </div>
          </article>
        )}
      </section>
    );
  }

  return (
    <section className={styles.page}>
      <PageHeader icon={Leaf} title="Emissions Overview" subtitle="Vehicle emissions and air quality trends across NLEX" />

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
          <h3>Total CO₂ (Modeled)</h3>
          <div className={styles.kpiValue} title={data ? `${fmtInt(data.kpis.totalCo2T)} tonnes` : undefined}>
            {kpiValue(data ? `${fmtCompact(data.kpis.totalCo2T)} t` : null)}
          </div>
          <p className={styles.kpiHint}>
            {derived ? (
              <span className={derived.deltaPct <= 0 ? styles.deltaUp : styles.deltaDown}>{fmtPct(derived.deltaPct)}</span>
            ) : "—"}{" "}
            vs previous period
          </p>
        </article>
        <article className={styles.kpiTile}>
          <h3>Avg Daily CO₂</h3>
          <div className={styles.kpiValue}>{kpiValue(derived ? `${fmtInt(derived.avgDailyT)} t` : null)}</div>
          <div className={styles.sparkBox}>
            {sparkOption && <ReactECharts option={sparkOption} style={{ width: "100%", height: "100%" }} opts={{ renderer: "canvas" }} />}
          </div>
        </article>
        <article className={styles.kpiTile}>
          <h3>Heavy-Vehicle Impact</h3>
          <div className={styles.kpiValue}>{kpiValue(derived ? `${derived.heavyCo2Pct.toFixed(1)}%` : null)}</div>
          <p className={styles.kpiHint}>
            {derived ? `of CO₂ from just ${derived.heavyVolPct.toFixed(1)}% of traffic` : "—"}
          </p>
        </article>
        <article className={styles.kpiTile}>
          <h3>Peak Emission Hour</h3>
          <div className={styles.kpiValue}>{kpiValue(timeProfile ? fmtHour(timeProfile.peakHour) : null)}</div>
          <p className={styles.kpiHint}>
            {timeProfile ? `${fmt1(timeProfile.allHour[timeProfile.peakHour])} t/day in that hour` : "—"}
          </p>
        </article>
        <article className={styles.kpiTile}>
          <h3>Measured Air Quality</h3>
          <div className={styles.kpiValue}>
            {kpiValue(data?.kpis.avgAqi != null ? `${data.kpis.avgAqi.toFixed(1)} / 5` : null)}
          </div>
          <p className={styles.kpiHint}>
            {data?.kpis.avgAqi != null
              ? `${aqiWord(data.kpis.avgAqi)} · avg PM2.5 ${data.kpis.avgPm25 != null ? fmt1(data.kpis.avgPm25) : "—"} µg/m³`
              : "no station readings in range"}
          </p>
        </article>
      </div>

      {/* Row C — hero: modeled CO2 trend by class */}
      <article className={`${styles.chartCard} ${styles.chart1} ${styles.hero}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>CO₂ Emissions Trend by Vehicle Class</h3>
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
        <div className={styles.chartBody}>{chartFrame(trendOption, "No emissions data for the selected range", onTrendClick)}</div>
      </article>

      {/* Row D — when + who */}
      <article className={`${styles.chartCard} ${styles.chart2}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>When Emissions Happen</h3>
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
        <div className={styles.chartBody}>{chartFrame(timeOption, "No data for the selected range", onTimeClick)}</div>
      </article>

      <article className={`${styles.chartCard} ${styles.chart3}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>Fleet Mix vs Pollution Load</h3>
            {fleetTakeaway && <p className={styles.subtitle}>{fleetTakeaway}</p>}
          </div>
        </div>
        <div className={styles.chartBody}>{chartFrame(fleetOption, "No data for the selected range", onFleetClick)}</div>
      </article>

      {/* Row E — where + measured reality */}
      <article className={`${styles.chartCard} ${styles.chart4}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>Heavy-Vehicle Share of CO₂</h3>
            {heavyShareTakeaway && <p className={styles.subtitle}>{heavyShareTakeaway}</p>}
          </div>
        </div>
        <div className={styles.chartBody}>{chartFrame(heavyShareOption, "No data for the selected range", onHeavyShareClick)}</div>
      </article>

      <article className={`${styles.chartCard} ${styles.chart5}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>Measured Air Quality by Month</h3>
          </div>
        </div>
        <div className={styles.chartBody}>{chartFrame(aqiOption, "No station readings in the selected range", onAqiClick)}</div>
      </article>

      {/* Click-to-inspect detail modal */}
      {detail && (
        <div className={styles.detailBackdrop} role="dialog" aria-modal="true" aria-label={detail.title} onClick={() => setDetail(null)}>
          <div className={styles.detailModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.detailAccent} />
            <div className={styles.detailHeader}>
              <div className={styles.detailIcon}>🌿</div>
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
