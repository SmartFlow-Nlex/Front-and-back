"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Shell, Empty, ActionCard, SourceBadge } from "./prescriptiveShell";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);

// Single-hue sequential ramp for the heat strip: the incident magnitude ramp
// (--inc-heat-lo -> --inc-heat-hi, app/styles/nc-incident.css), which follows the theme.
function heatShade(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  return `color-mix(in oklab, var(--inc-heat-hi) ${(clamped * 100).toFixed(1)}%, var(--inc-heat-lo))`;
}

// Shade by RANK among the week's 168 hours, not by linear position between min and max: the hourly counts bunch
// near the top of their range, so linear scaling would spend the ramp on a few quiet overnight hours.
function percentileOf(v: number, all: number[]): number {
  let lower = 0;
  let equal = 0;
  for (const x of all) {
    if (x < v) lower++;
    else if (x === v) equal++;
  }
  return all.length <= 1 ? 0 : (lower + equal / 2) / (all.length - 1);
}

// Mon..Sun, the Descriptive tab's Time-of-Day order (DOW_ORDER/DOW_LABELS in incident/page.tsx), not JS's Sun-first getDay().
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DOW_FULL: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

type HeatmapPoint = { dow: number; hour: number; v: number };
type AnalyticsSlice = { heatmap: HeatmapPoint[]; range: { from: string; to: string } };

/* Alert hours by test, not by eye (2 Nov 2026, "no assumptions"). An hour used to be an alert hour when its average
   sat above the day's mean, so a Tuesday 9 AM a hair above average counted, however few incidents it rested on. Now
   each weekday-hour's incidents over the Range's N such days are a Poisson count k, its rate k / N incidents per day,
   and its exact (Garwood) 95% interval comes from the Poisson distribution itself. An hour is an alert hour only when
   the interval's LOWER bound is above that weekday's own mean hourly rate: the data says, at 95%, that the hour runs
   above that day's normal. Everything is the Range's own counts; nothing is set by hand. */
function poissonCdf(k: number, lam: number): number {
  if (k < 0) return 0;
  if (lam <= 0) return 1;
  // Summed in log space so a large rate (a long Range) does not underflow exp(-lam).
  let logT = -lam;
  let m = logT;
  let s = 1;
  for (let i = 1; i <= k; i++) {
    logT += Math.log(lam) - Math.log(i);
    if (logT > m) {
      s = s * Math.exp(m - logT) + 1;
      m = logT;
    } else s += Math.exp(logT - m);
  }
  return Math.min(1, Math.exp(m) * s);
}

const ciCache = new Map<number, [number, number]>();

/** Exact 95% interval for a Poisson count k: P(X >= k | lower) = 2.5% and P(X <= k | upper) = 2.5%. */
function poissonCi(k: number): [number, number] {
  const hit = ciCache.get(k);
  if (hit) return hit;
  // Bisection on a function that rises with the rate; 80 halvings is far below any displayed digit.
  const root = (f: (lam: number) => number, lo: number, hi: number) => {
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
  const lower = k === 0 ? 0 : root((l) => 1 - poissonCdf(k - 1, l) - 0.025, 0, k);
  const upper = root((u) => 0.025 - poissonCdf(k, u), k, k + 10 + 6 * Math.sqrt(k + 1));
  const ci: [number, number] = [lower, upper];
  ciCache.set(k, ci);
  return ci;
}

type Profile = { hours: number[]; lo: number[]; hi: number[]; mean: number; peakHour: number; alert: boolean[]; windows: [number, number][] };

/** counts[h] = incidents at hour h over `days` such weekdays. Rates are per day; an alert hour's 95% lower bound clears the day's mean. */
function buildProfile(counts: number[], days: number): Profile {
  const n = counts.length || 1;
  const d = days > 0 ? days : 1;
  const mean = counts.reduce((s, v) => s + v, 0) / n / d;
  const hours = counts.map((k) => k / d);
  const ci = counts.map((k) => poissonCi(k));
  const lo = ci.map((c) => c[0] / d);
  const hi = ci.map((c) => c[1] / d);
  const alert = lo.map((l) => days > 0 && l > mean);
  const peakHour = hours.indexOf(Math.max(...hours));
  const windows: [number, number][] = [];
  let start: number | null = null;
  for (let h = 0; h < counts.length; h++) {
    if (alert[h] && start === null) start = h;
    if (!alert[h] && start !== null) {
      windows.push([start, h]);
      start = null;
    }
  }
  if (start !== null) windows.push([start, counts.length]);
  return { hours, lo, hi, mean, peakHour, alert, windows };
}

const windowLabel = ([start, end]: [number, number]) => `${fmtHour(start)} – ${fmtHour(end % 24)}`;
const windowSpanHours = ([start, end]: [number, number]) => end - start;

type DayRow = { label: string; dow: number; days: number; profile: Profile; primary: [number, number] | null };

type Props = {
  // Same Range control every other Prescriptive card takes: each weekday's hours are measured over the selected window.
  months?: "3" | "12" | "all";
  from?: string;
  to?: string;
};

export default function PatrolAlertWindowPanel({ months = "12", from, to }: Props) {
  const [data, setData] = useState<AnalyticsSlice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Cleared here, not just on success, so a retry after a Range change shows "Updating…", not the last error.
    setError(null);
    const qs = new URLSearchParams();
    if (months) qs.set("months", months);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    fetch(`${BACKEND}/api/incident/analytics?${qs}`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setData({ heatmap: json.data.heatmap, range: json.data.range });
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load the hourly incident profile");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [months, from, to]);

  const hint =
    "The hours to put patrol on alert, per weekday, from past incidents in the Range. Each hour's rate comes with its 95% range from the incident count itself (Poisson); an hour is an alert hour only when even the low end of that range is above the weekday's average hour. Based on past incidents, not the forecast: the incident model forecasts daily totals, not hours.";

  if (loading && data === null) {
    return (
      <Shell title="Patrol Alert Schedule" hint={hint}>
        <Empty msg="Loading patrol alert schedule…" />
      </Shell>
    );
  }
  // Only reachable with no successful load yet, or an empty response: nothing stale to fall back to.
  if (!data || data.heatmap.length === 0) {
    return (
      <Shell title="Patrol Alert Schedule" hint={hint}>
        <Empty kind={error ? "error" : "nodata"} msg={`Patrol alert schedule unavailable: ${error ?? "no hourly incident data for this Range."}`} />
      </Shell>
    );
  }

  // How many of each weekday fall in the Range: the N each hour's count is a rate over.
  const dowCount = Array(7).fill(0);
  const end = new Date(`${data.range.to}T00:00:00`);
  for (const d = new Date(`${data.range.from}T00:00:00`); d <= end; d.setDate(d.getDate() + 1)) dowCount[d.getDay()]++;

  const countByDow: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of data.heatmap) countByDow[r.dow][r.hour] += r.v;

  const rows: DayRow[] = DOW_ORDER.map((dow, i) => {
    const days = dowCount[dow];
    const hourly = countByDow[dow];
    const profile = buildProfile(hourly, days);
    const primary =
      profile.windows.length > 0
        ? [...profile.windows].sort((a, b) => windowSpanHours(b) - windowSpanHours(a))[0]
        : null;
    return { label: DOW_LABELS[i], dow, days, profile, primary };
  });

  const observed = rows.filter((r) => r.days > 0);
  if (observed.length === 0) {
    return (
      <Shell title="Patrol Alert Schedule" hint={hint} updating={loading && !error}>
        <Empty kind="nodata" msg="Patrol alert schedule unavailable: no days in the selected Range have incident data." />
      </Shell>
    );
  }
  const alertCount = rows.reduce((t, r) => t + r.profile.alert.filter(Boolean).length, 0);
  const withWindow = rows.filter((r) => r.primary != null) as (DayRow & { primary: [number, number] })[];
  const widest = withWindow.length > 0 ? [...withWindow].sort((a, b) => windowSpanHours(b.primary) - windowSpanHours(a.primary))[0] : null;
  // The single hour furthest above its day's normal, judged by its LOW end: the surest alert of the week.
  let surest: { r: DayRow; h: number } | null = null;
  for (const r of rows) {
    for (let h = 0; h < 24; h++) {
      if (!r.profile.alert[h]) continue;
      const lift = r.profile.lo[h] / r.profile.mean;
      if (!surest || lift > surest.r.profile.lo[surest.h] / surest.r.profile.mean) surest = { r, h };
    }
  }
  const allHours = rows.flatMap((r) => r.profile.hours);
  const minDays = Math.min(...observed.map((r) => r.days));
  const maxDays = Math.max(...observed.map((r) => r.days));
  const rate = (v: number) => v.toFixed(v < 10 ? 2 : 1);

  return (
    <Shell title="Patrol Alert Schedule" hint={hint} updating={loading && !error}>
      {error && (
        <div role="alert" style={{ fontSize: "0.78rem", color: "var(--color-warning)" }}>
          Couldn&apos;t refresh with the current Range ({error}) — showing the last loaded result.
        </div>
      )}
      <ActionCard
        lead
        icon={Clock}
        tag={<SourceBadge kind="history" detail="Past incidents by hour and weekday in the Range; the incident model forecasts daily totals, not hours" />}
        title={alertCount > 0 ? `Put patrol on alert in ${alertCount} hours a week` : "No hour is clearly above normal"}
        facts={[
          {
            label: "Longest",
            value: widest
              ? <><b>{widest.label} {windowLabel(widest.primary)}</b> ({windowSpanHours(widest.primary)} h)</>
              : "None in this Range",
          },
          {
            label: "Surest",
            value: surest
              ? (
                <>
                  <b>{surest.r.label} {fmtHour(surest.h)}</b>: {rate(surest.r.profile.lo[surest.h])}–{rate(surest.r.profile.hi[surest.h])} incidents/day
                  vs a {rate(surest.r.profile.mean)} {surest.r.label} hour
                </>
              )
              : "—",
          },
          {
            label: "How sure",
            value: <>95%: each alert hour&apos;s low end is above its weekday&apos;s average ({minDays === maxDays ? minDays : `${minDays}–${maxDays}`} of each weekday)</>,
          },
        ]}
        details={
          <p style={{ margin: 0 }}>
            For each weekday and hour, the incidents in the Range are a count over that many of the weekday. Its 95% range is the
            exact Poisson interval of that count, divided by the days. An alert hour is one whose range sits wholly above the
            weekday&apos;s average hour, so a busy-looking hour resting on few incidents does not qualify. No threshold or rush
            hour is set by hand.
          </p>
        }
      />

      {/* The week at a glance: one row per weekday, one cell per hour, shaded by rank among all 168 hours; alert hours
          outlined. The table below has the numbers. */}
      <div className="inc-week" role="img" aria-label={`Incidents by hour and weekday; alert hours outlined. ${withWindow.map((r) => `${DOW_FULL[r.label]} ${r.profile.windows.map(windowLabel).join(", ")}`).join("; ")}`}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={`h${h}`} className="inc-week-hour">{h % 3 === 0 ? fmtHour(h).replace(" ", "") : ""}</span>
        ))}
        {rows.map((r) => (
          <div key={`w${r.dow}`} className="inc-week-row">
            <span className={`inc-week-day${widest && r.dow === widest.dow ? " is-widest" : ""}`}>{r.label}</span>
            {r.profile.hours.map((v, h) => {
              const a = r.profile.alert;
              return (
                <i
                  key={h}
                  className={`inc-week-cell${a[h] ? " is-window" : ""}${a[h] && !a[h - 1] ? " is-start" : ""}${a[h] && !a[h + 1] ? " is-end" : ""}`}
                  style={{ background: r.days > 0 ? heatShade(percentileOf(v, allHours)) : undefined }}
                  title={`${r.label} ${fmtHour(h)}: ${rate(v)} incidents/day (95%: ${rate(r.profile.lo[h])}–${rate(r.profile.hi[h])}) vs ${rate(r.profile.mean)} average${a[h] ? " · alert hour" : ""}`}
                />
              );
            })}
          </div>
        ))}
      </div>

      <div className="inc-table-wrap">
        <table className="inc-table inc-sched">
          <thead>
            <tr>
              <th>Day</th>
              <th style={{ textAlign: "left" }}>Alert hours</th>
              <th style={{ textAlign: "left" }}>Busiest hour, per day (95%)</th>
              <th style={{ textAlign: "left" }}>Average hour</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const p = r.profile;
              return (
                <tr key={r.dow}>
                  <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{r.label}</td>
                  {r.days === 0 ? (
                    <td colSpan={3} className="is-none">No {r.label} in this Range</td>
                  ) : (
                    <>
                      <td className={widest && r.dow === widest.dow ? "is-widest" : r.primary ? undefined : "is-none"} style={{ textAlign: "left" }}>
                        {p.windows.length > 0 ? p.windows.map(windowLabel).join(", ") : "None clearly above normal"}
                      </td>
                      <td className="is-muted" style={{ textAlign: "left", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                        {fmtHour(p.peakHour)}: {rate(p.hours[p.peakHour])} ({rate(p.lo[p.peakHour])}–{rate(p.hi[p.peakHour])})
                      </td>
                      <td className="is-muted" style={{ textAlign: "left", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                        {rate(p.mean)} · {r.days} days
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="inc-caption inc-sched-key">
        <span className="inc-sched-key-ramp" aria-hidden="true" />
        Shade: incidents per day at that hour, ranked quietest to busiest across the week. <b>Outlined</b>: alert hours. Hover a cell for its numbers.
      </p>
    </Shell>
  );
}
