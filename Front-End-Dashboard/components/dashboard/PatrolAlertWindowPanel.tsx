"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Shell, Empty, ActionCard } from "./prescriptiveShell";
import InfoTooltip from "./InfoTooltip";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);

// Single-hue sequential ramp for the shape bars: the incident magnitude ramp
// (--inc-heat-lo -> --inc-heat-hi, app/styles/nc-incident.css), which follows
// the theme. It replaced a fixed light-grey-to-navy RGB ramp whose peak end
// vanished on the Night Corridor dark stage.
function heatShade(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  return `color-mix(in oklab, var(--inc-heat-hi) ${(clamped * 100).toFixed(1)}%, var(--inc-heat-lo))`;
}

// Color by RANK within the table's own values, not by linear position between
// min and max. Real incident-by-hour data isn't evenly spread: a handful of
// quiet overnight hours sit well below a wide daytime "plateau" that's all
// bunched within a narrow band near the top -- linear min-max scaling then
// spends most of the ramp on the rare very-low hours and crams the entire
// plateau into a sliver near the dark end, so only the single tallest peak
// stands out and every other busy hour looks the same (confirmed against the
// actual data: that's exactly the "still not strong enough" result). Ranking
// first guarantees the ramp's steps are spread evenly across however the real
// values are distributed, however clustered -- whatever shape the data takes
// on a given Range, not just the one shape this was eyeballed against.
// O(n^2) over ~168 cells (7 days x 24h) is a few thousand comparisons, far
// below anything worth a sort-and-binary-search for.
function percentileOf(v: number, all: number[]): number {
  let lower = 0;
  let equal = 0;
  for (const x of all) {
    if (x < v) lower++;
    else if (x === v) equal++;
  }
  return all.length <= 1 ? 0 : (lower + equal / 2) / (all.length - 1);
}

// Same Mon..Sun display order the Descriptive tab's own Time-of-Day chart
// uses (DOW_ORDER/DOW_LABELS in incident/page.tsx) — kept in sync by hand so
// this card's day order matches that chart's, not JS's Sun-first getDay().
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
// Full names for the Confidence fact below -- "Mon 53, Tue 53, ..." tested as
// confusing (what is 53?) without spelling out that it's a day count.
const DOW_FULL: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

type HeatmapPoint = { dow: number; hour: number; v: number };
type AnalyticsSlice = { heatmap: HeatmapPoint[]; range: { from: string; to: string } };

// Built on the Descriptive tab's own Hour x Day-of-week incident frequency
// (/api/incident/analytics' `heatmap`, the exact table its Time-of-Day chart
// already renders as Weekday/Weekend lines) -- not a separately-modeled
// hourly forecast, since the predictive pipeline only ever outputs a DAILY
// count (see incident.service.ts's own comment on why getIncidentHourlyFromDb
// spreads a daily total rather than forecasting hourly). This panel turns
// that same measured profile into an operational answer the Descriptive
// chart doesn't give, broken out by each of the 7 days rather than just a
// weekday/weekend split: not just *when* incidents peak, but the *window* of
// hours patrol should treat as elevated-risk, defined per day as every hour
// whose average sits above that specific day's own mean -- the same "above
// its own median/mean, not a fixed threshold" rule the rest of the
// Prescriptive tab uses, so a Friday with a sharper evening spike gets a
// different window than a flatter Tuesday instead of both being forced into
// one "weekday" bucket.
type Profile = { hours: number[]; mean: number; peakHour: number; windows: [number, number][] };

function buildProfile(hourly: number[]): Profile {
  // The hours given, not an assumed 24: a shorter series was averaged as if the missing hours were zero (TC-UT-12).
  const n = hourly.length || 1;
  const mean = hourly.reduce((s, v) => s + v, 0) / n;
  const peakHour = hourly.indexOf(Math.max(...hourly));
  const windows: [number, number][] = [];
  let start: number | null = null;
  for (let h = 0; h < hourly.length; h++) {
    const elevated = hourly[h] > mean;
    if (elevated && start === null) start = h;
    if (!elevated && start !== null) {
      windows.push([start, h]);
      start = null;
    }
  }
  if (start !== null) windows.push([start, hourly.length]);
  return { hours: hourly, mean, peakHour, windows };
}

const windowLabel = ([start, end]: [number, number]) => `${fmtHour(start)} – ${fmtHour(end % 24)}`;
const windowSpanHours = ([start, end]: [number, number]) => end - start;

type DayRow = { label: string; dow: number; days: number; profile: Profile; primary: [number, number] | null };

type Props = {
  // Same Range control every other Prescriptive card takes — each day's
  // profile is measured over whichever window is selected, so a corridor
  // whose rhythm has shifted recently will show that shift here too.
  months?: "3" | "12" | "all";
  from?: string;
  to?: string;
};

export default function PatrolAlertWindowPanel({ months = "12", from, to }: Props) {
  const [data, setData] = useState<AnalyticsSlice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredCell, setHoveredCell] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Cleared here, not just on success -- otherwise a retry after a Range
    // change renders as a stale-refresh warning (the PREVIOUS attempt's
    // error) while it's still in flight, instead of "Updating…".
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
    "Hours patrol should treat as elevated-risk, one row per day of the week, from the Descriptive tab's own Hour x Day-of-week incident frequency — the same table its Time-of-Day chart draws Weekday/Weekend lines from, broken out further here since different weekdays (and Saturday vs Sunday) don't share one rhythm. A window is any run of hours whose average incident count sits above that specific day's own mean, so it's sized to this corridor's measured rhythm rather than a fixed span like 'rush hour.'";

  if (loading && data === null) {
    return (
      <Shell title="Patrol Alert Schedule" hint={hint}>
        <Empty msg="Loading patrol alert schedule…" />
      </Shell>
    );
  }
  // Only reachable with no successful load yet -- data === null -- so there is
  // nothing stale to fall back to; a later refresh failure with data already
  // loaded is handled below instead of wiping the panel. A genuinely empty
  // response (heatmap.length === 0) is treated the same way: no previous good
  // data exists either way.
  if (!data || data.heatmap.length === 0) {
    return (
      <Shell title="Patrol Alert Schedule" hint={hint}>
        <Empty kind={error ? "error" : "nodata"} msg={`Patrol alert schedule unavailable: ${error ?? "no hourly incident data for this Range."}`} />
      </Shell>
    );
  }

  // How many of each specific weekday (not just weekday-vs-weekend) fall in
  // the selected Range, so e.g. three Fridays' incidents are averaged over
  // three days, not folded into a five-day "weekday" denominator.
  const dowCount = Array(7).fill(0);
  const end = new Date(`${data.range.to}T00:00:00`);
  for (const d = new Date(`${data.range.from}T00:00:00`); d <= end; d.setDate(d.getDate() + 1)) dowCount[d.getDay()]++;

  const hourByDow: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of data.heatmap) hourByDow[r.dow][r.hour] += r.v;

  const rows: DayRow[] = DOW_ORDER.map((dow, i) => {
    const days = dowCount[dow];
    const hourly = hourByDow[dow].map((v) => (days > 0 ? v / days : 0));
    const profile = buildProfile(hourly);
    const primary =
      days === 0
        ? null
        : profile.windows.length > 0
          ? [...profile.windows].sort((a, b) => windowSpanHours(b) - windowSpanHours(a))[0]
          : ([profile.peakHour, (profile.peakHour + 1) % 24] as [number, number]);
    return { label: DOW_LABELS[i], dow, days, profile, primary };
  });

  const withWindow = rows.filter((r) => r.primary != null) as (DayRow & { primary: [number, number] })[];
  if (withWindow.length === 0) {
    return (
      <Shell title="Patrol Alert Schedule" hint={hint} updating={loading && !error}>
        <Empty kind="nodata" msg="Patrol alert schedule unavailable: no days in the selected Range have incident data." />
      </Shell>
    );
  }
  const widest = [...withWindow].sort((a, b) => windowSpanHours(b.primary) - windowSpanHours(a.primary))[0];
  const allHours = rows.flatMap((r) => r.profile.hours);
  const maxHour = Math.max(...allHours, 1e-9);
  const dayCountPhrase = rows.map((r) => `${r.days} ${DOW_FULL[r.label]}${r.days === 1 ? "" : "s"}`).join(", ");

  /* What the Confidence figures mean (19 Oct 2026, testers IN-14: "explain the confidence values, e.g. 52,
     53"). They were day counts, not a score: 12 months holds 52 or 53 of each weekday, and every hour's
     average is taken over that many days. A count alone does not say how steady the window is, so each row
     now carries a computed uncertainty too. An hour's incidents over N days are treated as a Poisson
     count, whose standard error is the square root of the count, so the average of the window's hours
     moves by about 1 / sqrt(incidents in the window) between one set of N such days and another. */
  const windowUncertainty = (r: DayRow): number | null => {
    if (!r.primary) return null;
    const [s, e] = r.primary;
    let total = 0;
    for (let h = s; h < e; h++) total += hourByDow[r.dow][h % 24];
    return total > 0 ? 1 / Math.sqrt(total) : null;
  };
  const fmtPm = (u: number | null) => (u == null ? "—" : `±${Math.max(1, Math.round(u * 100))}%`);
  const widestU = windowUncertainty(widest);
  const confidenceHint =
    "Not a score out of 100. The day figures (52, 53 …) are how many of that weekday the selected Range contains: 12 months holds 52 or 53 of each, 3 months about 13. Every hour's average is taken over that many days. The ± figure is computed: treating the window's incident count as Poisson (standard error = √count), it is how far the window's average would typically move with a different set of the same weekdays. More days, and more incidents in the window, make it smaller. Read it as a floor: holidays and events make real days vary more than a Poisson count does.";

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
        title={`${widest.label}: longest alert window`}
        facts={[
          { label: "Action", value: "Treat these hours as elevated-risk for patrol" },
          { label: "Where", value: "Whole corridor, all logged incidents" },
          {
            label: "When",
            value: (
              <>
                <b>{windowLabel(widest.primary)}</b> ({windowSpanHours(widest.primary)}h), peaking around <b>{fmtHour(widest.profile.peakHour)}</b>
              </>
            ),
          },
          { label: "Basis", value: "Hours whose average incident count sits above that day's own 24-hour mean — not a fixed rush-hour assumption" },
          {
            label: "Confidence",
            value: (
              <>
                <b>{widest.days} {DOW_FULL[widest.label]}{widest.days === 1 ? "" : "s"}</b> observed, so this window&apos;s average is good to about{" "}
                <b>{fmtPm(widestU)}</b> at best
                <InfoTooltip text={confidenceHint} />
                <span className="inc-facts-note">
                  The day figures are counts of that weekday in the Range, not a percentage. Every day&apos;s count and ± are in the table below.
                </span>
              </>
            ),
          },
        ]}
        details={
          <>
            <p style={{ margin: 0 }}>
              <strong>{widest.label}</strong> needs the longest alert window: <strong>{windowLabel(widest.primary)}</strong>{" "}
              ({windowSpanHours(widest.primary)}h), peaking around <strong>{fmtHour(widest.profile.peakHour)}</strong>.
              Every other day&apos;s own window is in the table below — none of them share a single rush-hour assumption.
            </p>
            <p style={{ margin: "8px 0 0" }}>
              Hours patrol should treat as elevated-risk, one row per day of the week, from the Descriptive tab&apos;s own Hour x
              Day-of-week incident frequency — the same table its Time-of-Day chart draws Weekday/Weekend lines from, broken out
              further here since different weekdays (and Saturday vs Sunday) don&apos;t share one rhythm. A window is any run of hours
              whose average incident count sits above that specific day&apos;s own mean, so it&apos;s sized to this corridor&apos;s
              measured rhythm rather than a fixed span like &apos;rush hour.&apos;
            </p>
            <p style={{ margin: "8px 0 0" }}>
              Each day&apos;s window is measured over however many of that weekday fell in the selected Range —
              {" "}{dayCountPhrase} — and recomputed from that day&apos;s own hourly rhythm; it is not a fixed
              rush-hour assumption shared across days. A day with fewer occurrences in the Range (e.g. a short
              Range spanning only one or two of it) has a noisier average and a less reliable window.
            </p>
          </>
        }
      />

      {/* Evidence: every day's own window and its 24-hour shape. */}
      <div className="inc-table-wrap">
        <table className="inc-table inc-sched">
          <thead>
            <tr>
              <th>Day</th>
              <th style={{ textAlign: "left" }}>Alert window</th>
              <th style={{ textAlign: "left" }}>Peak hour</th>
              <th style={{ textAlign: "left" }} title="How many of this weekday the Range contains, and the window average's computed uncertainty">
                Days · ±
              </th>
              <th style={{ textAlign: "left" }}>Shape (12 AM – 12 AM)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.dow}>
                <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{r.label}</td>
                {r.primary == null ? (
                  <>
                    <td colSpan={3} className="is-none">
                      No {r.label} in this Range
                    </td>
                    <td />
                  </>
                ) : (
                  <>
                    <td className={r.dow === widest.dow ? "is-widest" : undefined} style={{ textAlign: "left", whiteSpace: "nowrap" }}>
                      {windowLabel(r.primary)}
                    </td>
                    <td className="is-muted" style={{ textAlign: "left", whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{fmtHour(r.profile.peakHour)}</td>
                    <td className="is-muted" style={{ textAlign: "left", whiteSpace: "nowrap", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                      {r.days} days · {fmtPm(windowUncertainty(r))}
                    </td>
                    <td style={{ textAlign: "left" }}>
                      <div className="inc-shape">
                        {r.profile.hours.map((v, h) => {
                          const pct = Math.max((v / maxHour) * 100, 6);
                          const key = `${r.dow}-${h}`;
                          // Shade is by RANK among all 168 cells, computed against the
                          // table's shared allHours so a shade means the same relative
                          // rank in every row (see percentileOf) — reused here so the
                          // tooltip can say exactly what the color means, not just
                          // repeat the raw value.
                          const rank = percentileOf(v, allHours);
                          const inWindow = r.profile.windows.some(([s, e]) => h >= s && h < e);
                          const vsMean = r.profile.mean > 0 ? ((v - r.profile.mean) / r.profile.mean) * 100 : 0;
                          return (
                            <div
                              key={h}
                              onMouseEnter={() => setHoveredCell(key)}
                              onMouseLeave={() => setHoveredCell((k) => (k === key ? null : k))}
                            >
                              {/* Height is linear (true magnitude). */}
                              <i style={{ height: `${pct}%`, background: heatShade(rank) }} />
                              {hoveredCell === key && (
                                <div className="inc-shape-tip" role="tooltip">
                                  <b>{r.label}, {fmtHour(h)}</b>
                                  <span>{v.toFixed(2)} incidents/day avg</span>
                                  <span>Busier than {Math.round(rank * 100)}% of hours this week</span>
                                  <span className={inWindow ? "is-elevated" : undefined}>
                                    {inWindow
                                      ? "Elevated — inside this day's alert window"
                                      : `${vsMean >= 0 ? "+" : ""}${vsMean.toFixed(0)}% vs ${r.label}'s own average`}
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The shape bars encode two things and had no key (testers: "a legend explaining what each colour
          means"). Height and shade are said in words, with the ramp itself as the swatch. */}
      <p className="inc-caption inc-sched-key">
        <span className="inc-sched-key-ramp" aria-hidden="true" />
        Each bar is one hour: <b>height</b> is the average incidents per day at that hour, <b>shade</b> its rank among all
        168 hours of the week, quietest to busiest. The day in the accent colour has the longest alert window. Hover a bar for its numbers.
      </p>
    </Shell>
  );
}
