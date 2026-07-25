"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
const GRAY = "#9aa4b8";

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
type SourceFilter = "all" | "road" | "moto" | "stalled";
type Detail = { title: string; subtitle?: string; rows: [string, string][]; note?: string };

// ---------- Formatting ----------
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
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

export default function IncidentPage() {
  const [activeTab, setActiveTab] = useState<"Descriptive" | "Predictive" | "Prescriptive">("Descriptive");

  // Global filters
  const [rangeMode, setRangeMode] = useState<RangeMode>("12");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");

  // Chart-local interactivity
  const [grain, setGrain] = useState<Granularity>("monthly");
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
    if (source !== "all") qs.set("source", source);
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
  }, [rangeMode, customFrom, customTo, source]);

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

    // Crash rate per 1,000 hours, wet vs dry (crashes = road + moto)
    const wetCrashes = weather.incidents.wet.road + weather.incidents.wet.moto;
    const dryCrashes = weather.incidents.dry.road + weather.incidents.dry.moto;
    const wetRate = weather.wetHours > 0 ? (wetCrashes / weather.wetHours) * 1000 : 0;
    const dryRate = weather.dryHours > 0 ? (dryCrashes / weather.dryHours) * 1000 : 0;
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

    const series =
      source === "all"
        ? [mk("Road crashes", "road", BLUE), mk("Motorcycle crashes", "moto", PURPLE), mk("Stalled vehicles", "stalled", ORANGE)]
        : [mk(SOURCE_LABEL[source], source, source === "road" ? BLUE : source === "moto" ? PURPLE : ORANGE)];

    return {
      grid: { left: 52, right: 16, top: 30, bottom: 22 },
      xAxis: { type: "category", data: labels, axisLabel: { interval: labelInterval, fontSize: 10, hideOverlap: true }, axisTick: { show: false } },
      yAxis: { type: "value", splitNumber: 3, axisLabel: { fontSize: 10 } },
      tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : fmtInt(Number(v))) },
      legend: { show: source === "all", top: 0, right: 8, itemWidth: 14, textStyle: { fontSize: 11 } },
      series,
    };
  }, [trendRows, grain, source]);

  const heatmapOption = useMemo<EChartsOption | null>(() => {
    if (!data || data.heatmap.length === 0) return null;
    const heatData: [number, number, number][] = data.heatmap.map((r) => [r.hour, DOW_ORDER.indexOf(r.dow), r.v]);
    const heatMax = Math.max(...data.heatmap.map((r) => r.v));
    return {
      grid: { left: 40, right: 10, top: 6, bottom: 44 },
      xAxis: { type: "category", data: Array.from({ length: 24 }, (_, h) => fmtHour(h)), splitArea: { show: true }, axisLabel: { interval: 3, fontSize: 10 }, axisTick: { show: false } },
      yAxis: { type: "category", data: DOW_LABELS, inverse: true, splitArea: { show: true }, axisLabel: { interval: 0, fontSize: 10 }, axisTick: { show: false } },
      tooltip: {
        formatter: (p) => {
          const v = (p as unknown as { value: [number, number, number] }).value;
          return `${DOW_LABELS[v[1]]} ${fmtHour(v[0])}<br/><b>${fmtInt(v[2])}</b> incidents in range`;
        },
      },
      visualMap: { type: "continuous", min: 0, max: heatMax, calculable: false, orient: "horizontal", left: "center", bottom: 0, itemWidth: 8, itemHeight: 110, padding: 0, inRange: { color: SEQ }, textStyle: { fontSize: 9 }, formatter: (v) => fmtInt(Number(v)) },
      series: [{ type: "heatmap", data: heatData, emphasis: { itemStyle: { borderColor: "#1d3aa8", borderWidth: 1 } } }],
    };
  }, [data]);

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
    const rate = (n: number, hours: number) => (hours > 0 ? Number(((n / hours) * 1000).toFixed(1)) : 0);
    return {
      grid: { left: 52, right: 16, top: 30, bottom: 40 },
      xAxis: { type: "category", data: [...cats], axisLabel: { fontSize: 10, interval: 0 }, axisTick: { show: false } },
      yAxis: { type: "value", name: "per 1,000 hrs", nameGap: 8, nameTextStyle: { fontSize: 9 }, splitNumber: 3, axisLabel: { fontSize: 10 } },
      tooltip: {
        trigger: "axis",
        formatter: (p) => {
          const items = p as { seriesName: string; dataIndex: number; value: number }[];
          const i = items[0].dataIndex;
          const k = keys[i];
          return `<b>${cats[i]}</b><br/>Dry: ${fmtInt(w.incidents.dry[k])} incidents over ${fmtInt(w.dryHours)} hrs (${items.find((x) => x.seriesName === "Dry hours")?.value}/1,000 hrs)<br/>Wet: ${fmtInt(w.incidents.wet[k])} incidents over ${fmtInt(w.wetHours)} hrs (${items.find((x) => x.seriesName === "Wet hours")?.value}/1,000 hrs)`;
        },
      },
      legend: { show: true, top: 0, right: 8, itemWidth: 14, textStyle: { fontSize: 11 } },
      series: [
        { name: "Dry hours", type: "bar", data: keys.map((k) => rate(w.incidents.dry[k], w.dryHours)), itemStyle: { color: BLUE, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 26 },
        { name: "Wet hours", type: "bar", data: keys.map((k) => rate(w.incidents.wet[k], w.wetHours)), itemStyle: { color: ORANGE, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 26 },
      ],
    };
  }, [data, derived]);

  // ---------- Click-to-inspect ----------
  const filtersNote = `Filters: ${source === "all" ? "all incident types" : SOURCE_LABEL[source]}${data ? ` · ${data.range.from} to ${data.range.to}` : ""}`;

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

  const onHeatmapClick = (p: { value: [number, number, number] }) => {
    if (!data) return;
    const [hour, dowIdx, v] = p.value;
    const all = data.heatmap.map((r) => r.v).sort((a, b) => b - a);
    const rank = 1 + all.findIndex((x) => x <= v);
    const max = all[0] ?? 1;
    setDetail({
      title: `${DOW_LABELS[dowIdx]} · ${fmtHour(hour)}`,
      subtitle: "Incident frequency for this hour-slot",
      rows: [
        ["Incidents in range", fmtInt(v)],
        ["Share of peak slot", `${((v / max) * 100).toFixed(0)}% of ${fmtInt(max)}`],
        ["Rank", `#${rank} of ${all.length} hour-slots`],
      ],
      note: filtersNote,
    });
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
        ["Dry rate", w.dryHours > 0 ? `${((w.incidents.dry[k] / w.dryHours) * 1000).toFixed(1)} per 1,000 hrs` : "—"],
        ["Wet rate", w.wetHours > 0 ? `${((w.incidents.wet[k] / w.wetHours) * 1000).toFixed(1)} per 1,000 hrs` : "—"],
        ["Avg jam speed (dry)", w.jam.dry ? `${w.jam.dry.speed} km/h` : "—"],
        ["Avg jam speed (wet)", w.jam.wet ? `${w.jam.wet.speed} km/h` : "—"],
      ],
      note: "Rates are exposure-normalized: incidents divided by the number of hours with that weather, so wet and dry compare fairly.",
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
      <section className={styles.page}>
        <div className={styles.filterRow}>
          <span className={styles.filterLabel}>
            {activeTab === "Predictive" ? "Forecasts from the AI model" : "Recommended resource allocation"}
          </span>
          <span className={styles.spacer} />
          <div className={styles.modeTabs}>
            {(["Descriptive", "Predictive", "Prescriptive"] as const).map((t) => (
              <button key={t} className={`${styles.modeTab} ${activeTab === t ? styles.modeTabActive : ""}`} onClick={() => setActiveTab(t)}>
                {t}
              </button>
            ))}
          </div>
        </div>
        {activeTab === "Predictive" ? (
          <article className={`${styles.chartCard} ${styles.chart1}`}>
            <PredictiveIncidentChart />
          </article>
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
    <section className={styles.page}>
      {/* Row A — global filters */}
      <div className={styles.filterRow}>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Range</span>
          <div className={styles.segmented}>
            {(["3", "12", "all", "custom"] as const).map((m) => (
              <button key={m} className={rangeMode === m ? "active" : ""} onClick={() => setRangeMode(m)}>
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
          <span className={styles.filterLabel}>Type</span>
          <CustomSelect
            value={source}
            onChange={(v) => setSource(v as SourceFilter)}
            options={[
              { label: "All incidents", value: "all" },
              { label: "Road crashes", value: "road" },
              { label: "Motorcycle crashes", value: "moto" },
              { label: "Stalled vehicles", value: "stalled" },
            ]}
          />
        </div>

        {loading && data && <span className={styles.updating}>Updating…</span>}
        <span className={styles.spacer} />

        <div className={styles.modeTabs}>
          {(["Descriptive", "Predictive", "Prescriptive"] as const).map((t) => (
            <button key={t} className={`${styles.modeTab} ${activeTab === t ? styles.modeTabActive : ""}`} onClick={() => setActiveTab(t)}>
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
            {derived ? `${derived.wetRate.toFixed(1)} vs ${derived.dryRate.toFixed(1)} crashes/1,000 hrs` : "—"}
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
            <h3>Incident Frequency by Hour × Day of Week</h3>
          </div>
        </div>
        <div className={styles.chartBody}>{chartFrame(heatmapOption, "No data for the selected filters", onHeatmapClick)}</div>
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
            <h3>Incident Rate: Dry vs Wet Hours</h3>
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
