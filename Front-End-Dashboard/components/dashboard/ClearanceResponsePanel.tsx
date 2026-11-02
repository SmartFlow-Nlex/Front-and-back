"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import { Siren } from "lucide-react";
import DashboardChart from "./DashboardChart";
import { Shell, Empty, ActionCard, Foot, SourceBadge } from "./prescriptiveShell";
import { useThemeTokens } from "./useThemeTokens";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Incident → Prescriptive: Clearance Response Protocol. A different question than the other two Prescriptive cards
// (where to place units; when to be on alert): once an incident is reported, when to escalate it. Data only since
// 2 Nov 2026: the rule is read off the measured Kaplan-Meier clearance curve (clearance-protocol.service.ts). The
// dispatch-count MILP it replaced rested on an assumed unit effect, costs, capacity, demand and response delay.

type SurvivalPoint = { minute: number; survival: number; atRisk: number };
type Chance = { p: number; lo: number; hi: number };

type ClearanceOk = {
  status: "ok";
  rule: { checkAtMinute: number; pastMinute: number; chance: Chance; openAtCheck: number; text: string };
  checkpoints: { label: "P25" | "P50" | "P80"; minute: number; stillOpen: number; openCount: number; medianRemainingMin: number | null; pastP95: Chance }[];
  survivalCurve: SurvivalPoint[];
  quantiles: { p50: number; p80: number; p95: number };
  kpi: { baselineMttr: number; rag: "green" | "amber" | "red"; targets: { greenMax: number; amberMax: number }; metricLabel: string; indicative: boolean };
  method: string[];
  scoringWindow: { from: string; to: string };
  sampleSize: number;
  censoredCount: number;
};
type ClearanceInsufficientData = { status: "insufficient_data"; sampleSize: number; scoringWindow: { from: string; to: string }; message: string };
type ClearanceResult = ClearanceOk | ClearanceInsufficientData;

const fmtMin = (m: number) => `${m.toFixed(0)} min`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/* Loading on every control change (19 Oct 2026, testers IN-15..IN-21: "not loading or reflecting changes"):
     - Retried, 3 s then 8 s apart, and cancellable: a cold backend answered the first request with a 503 or a
       dropped connection, and the panel used to sit on that error until a reload.
     - Changes are settled for DEBOUNCE_MS first, and a superseded request is aborted, not just ignored.
     - After SLOW_MS a note says a slow first read is still working.
     - Labels read `shown`, the filters the answer on screen was computed for, not the ones set now. */
const DEBOUNCE_MS = 250;
const SLOW_MS = 5000;
const RETRY_WAITS_MS = [3000, 8000];

function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { window.clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}

async function fetchClearance(url: string, signal: AbortSignal): Promise<ClearanceResult> {
  let last: unknown = null;
  for (let i = 0; i <= RETRY_WAITS_MS.length; i++) {
    try {
      const res = await fetch(url, { cache: "no-store", signal });
      // The body is read on errors too: the backend's 400/503 carry a message worth showing.
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success) return json.data as ClearanceResult;
      // The 503 already starts "Clearance protocol unavailable:", which the error state prints itself.
      const msg = typeof json?.message === "string" ? json.message.replace(/^clearance protocol unavailable:\s*/i, "") : null;
      last = new Error(msg || `the server answered ${res.status}`);
      if (res.status >= 400 && res.status < 500) break; // a bad request will not get better by asking again
    } catch (e) {
      if (signal.aborted) throw e;
      // fetch's own TypeError ("Failed to fetch") means the backend never answered at all.
      last = e instanceof TypeError ? new Error("couldn't reach the backend") : e;
    }
    if (i < RETRY_WAITS_MS.length) await abortableWait(RETRY_WAITS_MS[i], signal);
  }
  throw last instanceof Error ? last : new Error("no response from the server");
}

type ClearanceType = "accident" | "breakdown";
type Severity = "all" | "pdo" | "injury" | "fatal";
type Weather = "all" | "dry" | "wet";
/** The filters an answer on screen was computed for -- not necessarily the ones set now. */
type Shown = { type: ClearanceType; severity: Severity; weather: Weather };
const SEVERITY_LABEL: Record<Severity, string> = { all: "all", pdo: "PDO", injury: "injury", fatal: "fatal" };
const WEATHER_LABEL: Record<Weather, string> = { all: "all weather", dry: "dry", wet: "wet" };
const RAG_COLOR: Record<"green" | "amber" | "red", string> = { green: "var(--color-success)", amber: "var(--color-warning)", red: "var(--color-danger)" };

type Props = {
  // Same Range control every other Prescriptive card takes.
  months?: "3" | "12" | "all";
  from?: string;
  to?: string;
};

/** #rrggbb -> "r, g, b", for an rgba() string -- canvas-rendered ECharts shapes (markLine/markArea/series) can't
 *  resolve CSS var() or color-mix(), so a token read as a real hex via useThemeTokens is converted by hand. */
function hexToRgbTriplet(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "0, 0, 0";
  return [m[1], m[2], m[3]].map((h) => parseInt(h, 16)).join(", ");
}

export default function ClearanceResponsePanel({ months = "12", from, to }: Props) {
  const T = useThemeTokens();
  const [type, setType] = useState<ClearanceType>("accident");
  const [severity, setSeverity] = useState<Severity>("injury");
  const [weather, setWeather] = useState<Weather>("all");
  const [data, setData] = useState<ClearanceResult | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  // Bumped by Try again: re-runs the effect with the same filters.
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt((n) => n + 1);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    // Cleared here, not just on success, so a retry after a change shows "Updating…", not the last error.
    setError(null);
    setSlow(false);
    const params: Shown = { type, severity, weather };
    const qs = new URLSearchParams();
    qs.set("type", type);
    if (type === "accident") qs.set("severity", severity);
    qs.set("weather", weather);
    if (months) qs.set("months", months);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const slowTimer = window.setTimeout(() => setSlow(true), SLOW_MS);
    // Settles quick clicks into one request (and, on mount, React's development double-mount).
    const start = window.setTimeout(() => {
      fetchClearance(`${BACKEND}/api/incident/clearance-protocol?${qs}`, ctrl.signal)
        .then((d) => {
          if (ctrl.signal.aborted) return;
          setData(d);
          setShown(params);
        })
        .catch((e) => {
          if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : "failed to load the clearance response protocol");
        })
        .finally(() => {
          if (ctrl.signal.aborted) return;
          window.clearTimeout(slowTimer);
          setLoading(false);
          setSlow(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      ctrl.abort();
      window.clearTimeout(start);
      window.clearTimeout(slowTimer);
    };
  }, [type, severity, weather, months, from, to, attempt]);

  const hint =
    "When to escalate an incident that is still open, read off how long past incidents of the same kind took to clear (a Kaplan-Meier curve; day-long ones kept as still open, not dropped). Of the incidents still open at the median clearance time, the share that ran past the 80th percentile is the chance an open one will too. Type, severity and weather pick which past incidents count.";

  const controls = (
    <div className="inc-controls">
      <div className="inc-seg" role="group" aria-label="Incident type">
        {(["accident", "breakdown"] as const).map((v) => (
          <button key={v} onClick={() => setType(v)} aria-pressed={type === v} className={type === v ? "is-on" : ""}>
            {v === "accident" ? "Accident" : "Breakdown"}
          </button>
        ))}
      </div>
      {type === "accident" && (
        <div className="inc-seg" role="group" aria-label="Severity">
          {(["all", "pdo", "injury", "fatal"] as const).map((v) => (
            <button key={v} onClick={() => setSeverity(v)} aria-pressed={severity === v} className={severity === v ? "is-on" : ""}>
              {v === "all" ? "All" : v === "pdo" ? "PDO" : v === "injury" ? "Injury" : "Fatal"}
            </button>
          ))}
        </div>
      )}
      <div className="inc-seg" role="group" aria-label="Weather">
        {(["all", "dry", "wet"] as const).map((v) => (
          <button key={v} onClick={() => setWeather(v)} aria-pressed={weather === v} className={weather === v ? "is-on" : ""}>
            {v === "all" ? "All" : v === "dry" ? "Dry" : "Wet"}
          </button>
        ))}
      </div>
    </div>
  );

  const updating = loading && !error;
  const slowNote = "Reading this combination for the first time. Right after the server starts that can take up to a minute; it retries on its own.";
  const statusLine = (
    <>
      {updating && slow && <p className="inc-status-line" role="status">Still updating. {slowNote}</p>}
      {error && (
        <p className="inc-status-line is-warn" role="alert">
          Couldn&apos;t refresh with the current filters ({error}). Showing the last loaded result, which does not match them.
          <button type="button" className="btn-muted" onClick={retry}>Try again</button>
        </p>
      )}
    </>
  );

  if (loading && data === null) {
    return (
      <Shell title="Clearance Response Protocol" hint={hint} right={controls}>
        <Empty msg="Loading clearance response protocol…" note={slow ? slowNote : undefined} />
      </Shell>
    );
  }
  if (!data) {
    // Only reachable with no successful load yet, so there is nothing stale to fall back to.
    return (
      <Shell title="Clearance Response Protocol" hint={hint} right={controls}>
        <Empty kind="error" msg={`Clearance protocol unavailable: ${error ?? "no response from the server."}`} onRetry={retry} />
      </Shell>
    );
  }
  if (data.status === "insufficient_data") {
    return (
      <Shell title="Clearance Response Protocol" hint={hint} updating={updating} right={controls}>
        {statusLine}
        <div className="inc-busy-body" aria-busy={updating}>
          <Empty kind="nodata" msg={data.message} />
        </div>
      </Shell>
    );
  }
  // `shown` is always set alongside `data`; the fallback only satisfies the type checker.
  const at: Shown = shown ?? { type, severity, weather };
  const typeLabel = at.type === "breakdown" ? "breakdowns" : `${at.severity === "all" ? "" : `${SEVERITY_LABEL[at.severity]} `}accidents`;
  const rule = data.rule;
  const q = data.quantiles;

  const curve = data.survivalCurve;
  const longest = curve.length > 0 ? curve[curve.length - 1].minute : 60;
  /* Axis capped near P99 (2 Nov 2026): a handful of day-long clearances stretched it to ~1,400 min and squeezed the
     0-300 min where nearly every incident ends into a sliver. Where the curve never drops to 1% (censoring), the
     cap falls back to 1.5x P95. */
  const p99 = curve.find((pt) => pt.survival <= 0.01)?.minute ?? q.p95 * 1.5;
  const maxMinute = Math.min(longest, Math.max(p99, q.p95 * 1.15, rule.checkAtMinute * 1.2, 60));
  const capped = maxMinute < longest;

  // ECharts draws on canvas, which can't resolve a CSS var() or color-mix(); useThemeTokens reads the real values.
  type MLPoint = { xAxis: number; lineStyle?: { type?: "dashed" | "solid"; color?: string; width?: number }; label?: { show: boolean; formatter?: string; color?: string; fontSize?: number; position?: "insideEndTop" | "insideStartTop" | "insideMiddleTop" } };
  const markLineData: MLPoint[] = [
    // Short labels, staggered down the line, so close quantiles do not collide; the minutes are in the key above.
    { xAxis: q.p80, lineStyle: { type: "dashed", color: T.textMuted, width: 1.5 }, label: { show: true, formatter: "P80", color: T.textMuted, fontSize: 11, position: "insideMiddleTop" } },
    { xAxis: q.p95, lineStyle: { type: "dashed", color: T.textMuted, width: 1.5 }, label: { show: true, formatter: "P95", color: T.textMuted, fontSize: 11, position: "insideStartTop" } },
    { xAxis: rule.checkAtMinute, lineStyle: { type: "solid", color: T.accent, width: 2 }, label: { show: true, formatter: "P50 · check", color: T.accent, fontSize: 11, position: "insideEndTop" } },
  ];
  type MAPoint = { xAxis: number; itemStyle?: { color: string } };
  const markAreaData: [MAPoint, MAPoint][] = [
    [{ xAxis: 0, itemStyle: { color: `rgba(${hexToRgbTriplet(T.success)}, 0.1)` } }, { xAxis: data.kpi.targets.greenMax }],
  ];

  const option: EChartsOption = {
    grid: { left: 56, right: 24, top: 24, bottom: 48 },
    tooltip: {
      trigger: "axis",
      // Rendered into the tooltip's own DOM node (not canvas), so var() here resolves.
      formatter: (params: unknown) => {
        const items = params as { dataIndex: number; value: [number, number] }[];
        if (items.length === 0) return "";
        const point = curve[items[0].dataIndex];
        if (!point) return "";
        return `<b>${point.minute.toFixed(0)} min since report</b><br/>${(point.survival * 100).toFixed(1)}% still uncleared<br/><span style="color:var(--text-muted)">${point.atRisk} at risk</span>`;
      },
    },
    xAxis: { type: "value", name: "Minutes since report", nameLocation: "middle", nameGap: 28, min: 0, max: maxMinute, axisLabel: { color: T.chartText }, splitLine: { show: false } },
    yAxis: {
      type: "value", name: "Still uncleared", nameLocation: "middle", nameGap: 44, min: 0, max: 1,
      axisLabel: { color: T.chartText, formatter: (v: number) => `${Math.round(v * 100)}%` },
      splitLine: { lineStyle: { color: T.chartSplit } },
    },
    series: [
      {
        type: "line",
        step: "end",
        showSymbol: false,
        data: curve.filter((p) => p.minute <= maxMinute).map((p) => [p.minute, p.survival]),
        lineStyle: { width: 2.5, color: T.accent },
        itemStyle: { color: T.accent },
        markLine: { silent: true, symbol: "none", label: { show: false }, data: markLineData },
        markArea: { silent: true, data: markAreaData },
      },
    ],
  };

  return (
    <Shell title="Clearance Response Protocol" hint={hint} updating={updating} right={controls}>
      {statusLine}
      <div className="inc-busy-body" aria-busy={updating}>
        <ActionCard
          lead
          icon={Siren}
          tag={<SourceBadge kind="history" detail={`${data.sampleSize} measured clearance times of ${typeLabel}, ${WEATHER_LABEL[at.weather]}, Kaplan-Meier`} />}
          title={rule.text}
          facts={[
            {
              label: "How sure",
              value: (
                <>
                  95% range <b>{pct(rule.chance.lo)}–{pct(rule.chance.hi)}</b>, from the {rule.openAtCheck} of {data.sampleSize} still open at {fmtMin(rule.checkAtMinute)}
                </>
              ),
            },
            { label: "Measured", value: <>P50 <b>{fmtMin(q.p50)}</b> · P80 <b>{fmtMin(q.p80)}</b> · P95 <b>{fmtMin(q.p95)}</b> · n = {data.sampleSize}</> },
            {
              label: "Vs target",
              value: (
                <>
                  Mean {fmtMin(data.kpi.baselineMttr)},{" "}
                  <span style={{ color: RAG_COLOR[data.kpi.rag], fontWeight: 700, textTransform: "uppercase" }}>{data.kpi.rag}</span> against{" "}
                  {data.kpi.targets.greenMax} / {data.kpi.targets.amberMax} min{data.kpi.indicative ? " (indicative: not lane clearance)" : ""}
                </>
              ),
            },
          ]}
          details={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {data.method.map((m) => (
                <li key={m} style={{ marginBottom: 4 }}>{m}</li>
              ))}
            </ul>
          }
        />

        <p className="inc-curve-key" aria-hidden="true">
          <span><i className="is-esc" />Check at P50, {fmtMin(q.p50)}</span>
          <span><i className="is-q" />P80 {fmtMin(q.p80)}</span>
          <span><i className="is-q" />P95 {fmtMin(q.p95)}</span>
        </p>
        <DashboardChart option={option} height={300} />
        {capped && (
          <p className="inc-caption inc-axis-note">
            Axis capped near P99 ({fmtMin(maxMinute)}); the longest clearance in this set took {fmtMin(longest)}.
          </p>
        )}

        <div className="inc-table-wrap">
          <table className="inc-table">
            <thead>
              <tr>
                <th>Still open at</th>
                <th>Share of all</th>
                <th>Median time left</th>
                <th>Runs past P95 ({fmtMin(q.p95)})</th>
              </tr>
            </thead>
            <tbody>
              {data.checkpoints.map((c) => (
                <tr key={c.label} className={c.label === "P50" ? "is-staffed" : undefined}>
                  <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{fmtMin(c.minute)} <span className="is-muted">({c.label})</span></td>
                  <td className="is-muted">{pct(c.stillOpen)} · {c.openCount} events</td>
                  <td>{c.medianRemainingMin == null ? "—" : `${fmtMin(c.medianRemainingMin)} more`}</td>
                  <td style={{ fontWeight: 600 }}>
                    {pct(c.pastP95.p)} <span className="is-muted" style={{ fontWeight: 400 }}>({pct(c.pastP95.lo)}–{pct(c.pastP95.hi)})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Which filters these numbers answer, so a result still on screen from before a change is never mistaken for the new one. */}
        <Foot>
          {at.type === "breakdown" ? "Breakdowns" : `${SEVERITY_LABEL[at.severity][0].toUpperCase()}${SEVERITY_LABEL[at.severity].slice(1)} accidents`},{" "}
          {WEATHER_LABEL[at.weather]} · n = {data.sampleSize} ({data.censoredCount} still open at 24 h) · {data.scoringWindow.from} to {data.scoringWindow.to} · {data.kpi.metricLabel}
        </Foot>
      </div>
    </Shell>
  );
}
