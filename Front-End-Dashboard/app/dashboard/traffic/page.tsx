"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import DashboardChart from "../../../components/dashboard/DashboardChart";
import PredictiveVolumeChart from "../../../components/dashboard/PredictiveVolumeChart";
import styles from "./traffic.module.css";
import DateRangePicker from "./components/DateRangePicker";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Categorical hues (NB/SB and event emphasis)
const BLUE = "#3e67ef";
const ORANGE = "#e06b47";
// Sequential ramp (magnitude: heatmap, plaza bar)
const SEQ = ["#eef2fb", "#8fa8ee", "#3e67ef", "#1d3aa8"];
// Severity ramp for speed (low speed = severe)
const SEVERITY = ["#d0483e", "#e8a13a", "#1d9d61"];
const GRAY = "#9aa4b8";

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
  eventImpact: { label: string; date: string; dayVolume: number; baseline: number; deviationPct: number | null }[];
  holidayImpact: { label: string; deviationPct: number; occurrences: number; baseline: number; volume: number }[];
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

// ---------- Prescriptive mock (unchanged tab) ----------
const prescriptiveImpactOption: EChartsOption = {
  grid: { left: 46, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: ["Strategy A", "Strategy B", "Strategy C"] },
  yAxis: { type: "value" },
  tooltip: { trigger: "axis" },
  series: [{ type: "bar", data: [15, 25, 40], itemStyle: { color: "#29b471", borderRadius: [8, 8, 0, 0] } }],
};

function CustomSelect({ value, options, onChange }: { value: string; options: { label: string; value: string }[]; onChange: (val: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const clickOut = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", clickOut);
    return () => document.removeEventListener("mousedown", clickOut);
  }, [open]);

  const selectedLabel = options.find((o) => o.value === value)?.label || value;

  return (
    <div className={styles.customSelectWrap} ref={ref}>
      <button className={styles.customSelectBtn} onClick={() => setOpen(!open)} aria-expanded={open}>
        {selectedLabel}
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className={styles.customSelectMenu}>
          {options.map((o) => (
            <button
              key={o.value}
              className={`${styles.customSelectOption} ${value === o.value ? styles.customSelectOptionActive : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
              {value === o.value && (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ marginLeft: "auto", color: "var(--brand-primary)" }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TrafficPage() {
  const [activeTab, setActiveTab] = useState<"Descriptive" | "Predictive" | "Prescriptive">("Descriptive");

  // Global filters (Row A)
  const [rangeMode, setRangeMode] = useState<RangeMode>("12");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [plazaSel, setPlazaSel] = useState<string[]>([]); // empty = All
  const [direction, setDirection] = useState<Direction>("Both");
  const [vClass, setVClass] = useState<VehicleClass>("All");

  // Chart-local interactivity
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
    if (direction !== "Both") qs.set("direction", direction);
    if (vClass !== "All") qs.set("vehicleClass", vClass);
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
  }, [rangeMode, customFrom, customTo, plazaSel, direction, vClass]);

  // Hourly grain exists only when the server shipped hourly rows (spans <= ~3 months)
  const hourlyAvailable = !!data?.hourlyTrend;
  useEffect(() => {
    if (grain === "hourly" && data && !data.hourlyTrend) setGrain("daily");
  }, [data, grain]);

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
    const axisFmt =
      grain === "hourly"
        ? (v: string) => v.slice(5, 10)
        : grain === "monthly"
          ? (v: string) => v
          : (v: string) => v.slice(0, 7);

    const FAINT = "#c6d2ef";
    const series: EChartsOption["series"] = splitDirection
      ? [
        { name: "Northbound", type: "line", data: rows.map((r) => r.nb), symbol: "none", itemStyle: { color: BLUE }, lineStyle: { width: 2.5, color: BLUE }, endLabel: { show: true, formatter: "NB", color: BLUE, fontWeight: 700 } },
        { name: "Southbound", type: "line", data: rows.map((r) => r.sb), symbol: "none", itemStyle: { color: ORANGE }, lineStyle: { width: 2.5, color: ORANGE }, endLabel: { show: true, formatter: "SB", color: ORANGE, fontWeight: 700 } },
      ]
      : window > 0
        ? [
          { name: grain === "hourly" ? "Hourly volume" : "Daily volume", type: "line", data: rows.map((r) => r.total), symbol: "none", itemStyle: { color: FAINT }, lineStyle: { width: 1, color: FAINT } },
          { name: `${window === 24 ? "24-hour" : "7-day"} average`, type: "line", data: movingAverage(rows.map((r) => r.total), window), symbol: "none", itemStyle: { color: BLUE }, lineStyle: { width: 3, color: BLUE } },
        ]
        : [{ name: "Volume", type: "line", data: rows.map((r) => r.total), symbol: rows.length <= 24 ? "circle" : "none", symbolSize: 7, itemStyle: { color: BLUE }, lineStyle: { width: 3, color: BLUE } }];

    return {
      grid: { left: 52, right: splitDirection ? 44 : 16, top: 44, bottom: 22 },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { formatter: axisFmt, interval: labelInterval, fontSize: 10, hideOverlap: true },
        axisTick: { show: false },
      },
      // scale:true so the weekly rhythm is visible instead of a flat line on a zero base
      yAxis: { type: "value", scale: true, splitNumber: 3, axisLabel: { formatter: (v: number) => fmtCompact(v), fontSize: 10 } },
      tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : fmtInt(Number(v))) },
      legend: { show: !splitDirection && window > 0, top: 12, right: 8, itemWidth: 14, textStyle: { fontSize: 11 } },
      series,
    };
  }, [data, grain, splitDirection, trendRows]);

  const heatmapOption = useMemo<EChartsOption | null>(() => {
    if (!data || data.hourDow.length === 0) return null;
    const heatData: [number, number, number][] = data.hourDow.map((r) => [r.hour, DOW_ORDER.indexOf(r.dow), r.v]);
    const heatMax = Math.max(...data.hourDow.map((r) => r.v));
    return {
      // Legend lives in a slim strip below the plot, never on it
      grid: { left: 40, right: 10, top: 6, bottom: 44 },
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
        type: "continuous",
        min: 0,
        max: heatMax,
        calculable: false,
        orient: "horizontal",
        left: "center",
        bottom: 0,
        itemWidth: 8,
        itemHeight: 110,
        padding: 0,
        inRange: { color: SEQ },
        textStyle: { fontSize: 10 },
        formatter: (v) => fmtCompact(Number(v)),
      },
      series: [{ type: "heatmap", data: heatData, emphasis: { itemStyle: { borderColor: "#1d3aa8", borderWidth: 1 } } }],
    };
  }, [data]);

  const plazaChart = useMemo<{
    option: EChartsOption;
    rows: { plaza: string; v: number; isOthers: boolean }[];
    others: { plaza: string; v: number }[];
  } | null>(() => {
    if (!data || data.byPlaza.length === 0) return null;
    const top = data.byPlaza.slice(0, 10).map((r) => ({ ...r, isOthers: false }));
    const others = data.byPlaza.slice(10);
    const othersSum = others.reduce((s, r) => s + r.v, 0);
    const rows = othersSum > 0 ? [...top, { plaza: `Others (${others.length})`, v: othersSum, isOthers: true }] : top;
    const display = [...rows].reverse();
    const maxV = rows[0]?.v ?? 1;
    return {
      rows: display,
      others,
      option: {
        grid: { left: 120, right: 46, top: 2, bottom: 20 },
        xAxis: { type: "value", splitNumber: 3, axisLabel: { formatter: (v: number) => fmtCompact(v), fontSize: 10 } },
        // interval:0 — every plaza name must be readable, that IS the chart
        yAxis: { type: "category", data: display.map((r) => r.plaza), axisLabel: { interval: 0, fontSize: 10 }, axisTick: { show: false } },
        tooltip: { trigger: "axis", valueFormatter: (v) => `${fmtInt(Number(v))} vehicles` },
        series: [
          {
            type: "bar",
            data: display.map((r) => ({
              value: r.v,
              // sequential single hue: darker = larger
              itemStyle: { color: SEQ[Math.min(3, 1 + Math.floor((r.v / maxV) * 2.99))], borderRadius: [0, 3, 3, 0] },
            })),
            barMaxWidth: 12,
            barCategoryGap: "25%",
          },
        ],
      },
    };
  }, [data]);

  const speedOption = useMemo<EChartsOption | null>(() => {
    if (!data || data.speedByHour.length === 0) return null;
    const speeds = data.speedByHour.map((r) => r.speed);
    const CONGESTION_THRESHOLD = 20; // km/h — below this counts as heavy congestion
    const yMax = Math.max(CONGESTION_THRESHOLD + 5, Math.ceil(Math.max(...speeds) / 5) * 5);
    return {
      grid: { left: 36, right: 14, top: 18, bottom: 20 },
      xAxis: { type: "category", data: data.speedByHour.map((r) => fmtHour(r.hour)), axisLabel: { interval: 3, fontSize: 10 }, axisTick: { show: false } },
      yAxis: { type: "value", min: 0, max: yMax, splitNumber: 3, axisLabel: { formatter: "{value}", fontSize: 10 }, name: "km/h", nameGap: 6, nameTextStyle: { fontSize: 10 } },
      tooltip: {
        trigger: "axis",
        formatter: (p) => {
          const item = (p as { dataIndex: number }[])[0];
          const r = data.speedByHour[item.dataIndex];
          return `${fmtHour(r.hour)}<br/>Avg speed in jams: <b>${r.speed} km/h</b><br/>Avg jam level: ${r.jam_level} / 5`;
        },
      },
      visualMap: { show: false, type: "continuous", seriesIndex: 0, min: Math.min(...speeds), max: Math.max(...speeds), inRange: { color: SEVERITY } },
      series: [
        {
          type: "line",
          data: speeds,
          symbol: "circle",
          symbolSize: 5,
          lineStyle: { width: 2.5 },
          markLine: {
            symbol: "none",
            silent: true,
            lineStyle: { color: GRAY, width: 1, type: "dashed" },
            label: { formatter: "20 km/h — congestion threshold", position: "insideEndTop", fontSize: 9, color: GRAY },
            data: [{ yAxis: CONGESTION_THRESHOLD }],
          },
        },
      ],
    };
  }, [data]);

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
      .sort((a, b) => a.pct - b.pct);
    return {
      rows: display,
      option: {
        grid: { left: 128, right: 42, top: 2, bottom: 20 },
        xAxis: { type: "value", splitNumber: 3, axisLabel: { formatter: (v: number) => `${v}%`, fontSize: 10 } },
        yAxis: { type: "category", data: display.map((r) => r.label), axisLabel: { interval: 0, fontSize: 10 }, axisTick: { show: false } },
        tooltip: {
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
        series: [
          {
            type: "bar",
            data: display.map((r) => ({
              value: r.pct,
              itemStyle: { color: r.pct >= 0 ? ORANGE : BLUE, borderRadius: r.pct >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4] },
            })),
            barMaxWidth: 12,
            markLine: { symbol: "none", silent: true, lineStyle: { color: GRAY, width: 1 }, data: [{ xAxis: 0 }], label: { show: false } },
          },
        ],
      },
    };
  }, [data, impactMode]);

  const sparkOption = useMemo<EChartsOption | null>(() => {
    if (!derived || derived.sparkline.length === 0) return null;
    return {
      grid: { left: 0, right: 0, top: 2, bottom: 2 },
      xAxis: { type: "category", show: false, data: derived.sparkline.map((_, i) => i) },
      yAxis: { type: "value", show: false, min: "dataMin" },
      series: [{ type: "line", data: derived.sparkline, symbol: "none", lineStyle: { width: 1.5, color: BLUE }, areaStyle: { color: "rgba(62,103,239,.12)" } }],
    };
  }, [derived]);

  // ---------- Click-to-inspect handlers ----------
  const filtersNote = `Filters: ${plazaSel.length > 0 ? `${plazaSel.length} plaza(s)` : "all plazas"} · direction ${direction} · ${vClass === "All" ? "all classes" : vClass}${data ? ` · ${data.range.from} to ${data.range.to}` : ""}`;

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
      subtitle: `Philippine Arena event · ${weekdayOf(e.date)}, ${e.date}`,
      rows: [
        ["CDV plaza volume that day", `${fmtInt(e.dayVolume)} vehicles`],
        ["Same-weekday baseline", `${fmtInt(e.baseline)} vehicles`],
        ["Deviation", e.deviationPct != null ? fmtPct(e.deviationPct) : "—"],
      ],
      note: "Baseline = average CDV volume on the same weekday within ±45 days, excluding other event days.",
    });
  };

  const showHolidayDetail = (h: Analytics["holidayImpact"][number]) => {
    const yearly = (data?.holidayYearly ?? []).filter((y) => y.label === h.label).sort((a, b) => a.year - b.year);
    setDetail({
      title: h.label,
      subtitle: "Holiday traffic vs normal days",
      rows: [
        ["Avg holiday volume", h.volume > 0 ? `${fmtInt(h.volume)} vehicles` : "—"],
        ["Same-weekday baseline", h.baseline > 0 ? `${fmtInt(h.baseline)} vehicles` : "—"],
        ["Avg deviation (all years)", fmtPct(h.deviationPct)],
        ...yearly.map((y): [string, string] => [String(y.year), `${fmtPct(y.pct)} · ${fmtInt(y.volume)} vehicles`]),
      ],
      note: "Baseline = average volume on the same weekday on non-holiday dates. Special working days excluded.",
    });
  };

  const onImpactClick = (p: { dataIndex: number }) => {
    if (!impactChart) return;
    const r = impactChart.rows[p.dataIndex];
    if (!r) return;
    if (r.event) showEventDetail(r.event);
    else if (r.holiday) showHolidayDetail(r.holiday);
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

  // ---------- Predictive / Prescriptive keep the classic scrolling layout ----------
  if (activeTab !== "Descriptive") {
    return (
      <section className="ds-content ds-long">
        <h1 className="tab-title">Traffic Overview</h1>
        <div className="mode-tabs">
          {(["Descriptive", "Predictive", "Prescriptive"] as const).map((t) => (
            <button key={t} className={activeTab === t ? "active" : ""} onClick={() => setActiveTab(t)}>{t}</button>
          ))}
        </div>
        {activeTab === "Predictive" ? (
          <div className="chart-grid">
            <PredictiveVolumeChart />
          </div>
        ) : (
          <div className="chart-grid">
            <article className="chart-card wide"><div className="chart-head"><h3>Projected Impact of Strategies (Throughput Gain)</h3><span className="pill green">Optimized</span></div><DashboardChart option={prescriptiveImpactOption} /></article>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className={styles.page}>
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
          <h3>Avg Daily Volume</h3>
          <div className={styles.kpiValue}>{kpiValue(derived ? fmtInt(derived.curAdt) : null)}</div>
          <div className={styles.sparkBox}>
            {sparkOption && <ReactECharts option={sparkOption} style={{ width: "100%", height: "100%" }} opts={{ renderer: "canvas" }} />}
          </div>
        </article>
        <article className={styles.kpiTile}>
          <h3>Peak Hour (Weekdays)</h3>
          <div className={styles.kpiValue}>{kpiValue(derived ? fmtHour(derived.peakHour) : null)}</div>
          <p className={styles.kpiHint}>{derived ? `${fmtInt(derived.peakHourVolume)} vehicles/hr avg` : "—"}</p>
        </article>
        <article className={styles.kpiTile}>
          <h3>Busiest Plaza</h3>
          <div className={styles.kpiValue}>{kpiValue(derived?.busiest ? derived.busiest.plaza : null)}</div>
          <p className={styles.kpiHint}>
            {derived?.busiest && derived.plazaTotal > 0 ? `${((derived.busiest.v / derived.plazaTotal) * 100).toFixed(1)}% of selected volume` : "—"}
          </p>
        </article>
        <article className={styles.kpiTile}>
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
                <button key={d} className={direction === d ? "active" : ""} onClick={() => setDirection(d)}>
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
                  disabled={g === "hourly" && !hourlyAvailable}
                  title={g === "hourly" && !hourlyAvailable ? "Hourly detail is available for ranges up to 2 weeks" : undefined}
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
              <input type="checkbox" checked={splitDirection} onChange={(e) => setSplitDirection(e.target.checked)} />
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
        <div className={styles.chartBody}>{chartFrame(heatmapOption, "No data for the selected filters", onHeatmapClick)}</div>
      </article>

      <article className={`${styles.chartCard} ${styles.chart3}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>Volume by Plaza</h3>
          </div>
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
        <div className={styles.chartBody}>{chartFrame(speedOption, "No congestion data in the selected range", onSpeedClick)}</div>
      </article>

      <article className={`${styles.chartCard} ${styles.chart5}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>{impactMode === "Events" ? "Arena Event Impact (CDV Plaza)" : "Holiday Impact vs Normal Days"}</h3>
          </div>
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
                    ? `${data.eventImpact.length} events with CDV traffic data · click a row for details`
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
                    <tr><th>Date</th><th>Event</th><th>CDV volume</th><th>Baseline</th><th>Deviation</th></tr>
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
