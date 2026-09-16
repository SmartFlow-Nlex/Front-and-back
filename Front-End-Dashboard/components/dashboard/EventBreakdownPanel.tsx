"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import { useChartTheme, seriesRamp } from "../../lib/chart-theme";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Mirrors src/services/incident-events.service.ts's response shape.
// No accident-vs-breakdown monthly trend here anymore: it was a duplicate of
// /analytics's Incident Trend chart (verified identical month-by-month counts
// once both endpoints respected the same Range and read the same client
// tables), so this panel is response-time analytics only.
type DeploymentTimeStat = {
  group: string;
  n: number;
  avgResponseMin: number | null;
  medianResponseMin: number | null;
  avgServiceMin: number | null;
};
type EventBreakdownData = {
  breakdownCauses: { mainCause: string; subCause: string; count: number }[];
  responseTimeByService: DeploymentTimeStat[];
  responseTimeByCause: DeploymentTimeStat[];
};

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

type Props = {
  // Same Range control as the rest of the Descriptive page. Defaults to this
  // panel's original fixed 12mo when unset.
  months?: "3" | "12" | "all";
  from?: string;
  to?: string;
};

export default function EventBreakdownPanel({ months = "12", from, to }: Props) {
  const chartTheme = useChartTheme();
  const RAMP = seriesRamp("incident", chartTheme);

  const [data, setData] = useState<EventBreakdownData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [responseView, setResponseView] = useState<"cause" | "service">("cause");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams();
    if (months) qs.set("months", months);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    fetch(`${BACKEND}/api/incident/event-breakdown?${qs}`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setData(json.data as EventBreakdownData);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load event breakdown");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [months, from, to]);

  if (loading) {
    return (
      <article className="chart-card wide" style={{ height: "320px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>Loading event breakdown…</div>
      </article>
    );
  }

  if (error || !data || (data.responseTimeByCause.length === 0 && data.responseTimeByService.length === 0)) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "420px" }}>
          <div style={{ fontWeight: 700, color: "#334155", marginBottom: "6px" }}>Response time breakdown unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            {error ?? "No breakdown dispatch data has been ingested yet."}
          </div>
        </div>
      </article>
    );
  }

  const responseRows = (responseView === "service" ? data.responseTimeByService : data.responseTimeByCause)
    .filter((r) => r.medianResponseMin != null)
    .slice(0, 10);
  const displayRows = [...responseRows].reverse();

  const responseOption: EChartsOption = {
    grid: { left: 110, right: 42, top: 8, bottom: 8 },
    xAxis: { type: "value", name: "median response (min)", nameTextStyle: { fontSize: 9 }, splitNumber: 3, axisLabel: { fontSize: 10 } },
    yAxis: { type: "category", data: displayRows.map((r) => r.group), axisLabel: { fontSize: 10 }, axisTick: { show: false } },
    tooltip: {
      axisPointer: { type: "shadow" },
      formatter: (p) => {
        const i = (p as { dataIndex: number }).dataIndex;
        const r = displayRows[i];
        return `<b>${r.group}</b><br/>Median response: ${r.medianResponseMin} min<br/>` +
          `Avg response: ${r.avgResponseMin ?? "—"} min<br/>Avg on-scene service time: ${r.avgServiceMin ?? "—"} min<br/>` +
          `${fmtInt(r.n)} dispatches`;
      },
    },
    series: [
      {
        type: "bar",
        data: displayRows.map((r) => ({ value: r.medianResponseMin, itemStyle: { color: RAMP[1], borderRadius: [0, 3, 3, 0] } })),
        barMaxWidth: 16,
      },
    ],
  };

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "18px" }}>
      <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
        Response Time Breakdown
        <InfoTooltip text="Dispatch response times (AAP, Patrol Vehicle, RAMFA, and others) from the breakdown log, by cause or by service." />
      </h3>

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", marginBottom: "8px" }}>
          <h4 style={{ margin: 0, fontSize: "0.85rem", color: "#0f172a", fontWeight: 700 }}>Median Dispatch Response Time</h4>
          <div style={{ display: "inline-flex", gap: "2px", padding: "3px", background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef", borderRadius: "999px" }}>
            {(["cause", "service"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setResponseView(v)}
                style={{
                  padding: "4px 12px", borderRadius: "999px", border: "none", cursor: "pointer",
                  background: responseView === v ? "#4f46e5" : "transparent",
                  color: responseView === v ? "#fff" : "#4b5e7d",
                  fontWeight: 600, fontSize: "0.72rem",
                }}
              >
                {v === "cause" ? "By Cause" : "By Service"}
              </button>
            ))}
          </div>
        </div>
        <DashboardChart option={responseOption} height={Math.max(160, displayRows.length * 32)} />
        <p style={{ color: "#94a3b8", fontSize: "0.72rem", margin: "6px 0 0 0" }}>
          Built from breakdown_data&apos;s per-dispatch records — only the subset of breakdowns with a logged AAP/
          Patrol Vehicle/RAMFA dispatch are included; responses over 24h are treated as data-entry noise and excluded.
        </p>
      </div>
    </article>
  );
}
