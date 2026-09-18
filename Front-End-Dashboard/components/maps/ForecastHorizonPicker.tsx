"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock } from "lucide-react";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

/** One row per day for the week ahead, already pointing at that day's
 *  worst hour. Served by /api/map-comparison/forecast/peaks. */
export type DailyPeak = {
  day: string;
  hoursAhead: number;
  at: string;
  congested: number;
  confidence: number;
};

/* The ranges the forecast picker offers, and how finely each is stepped.
   Hour by hour is right for half a day and useless for a week: 168 options in
   a dropdown is a list nobody reads, so the longer ranges step coarser. */
export const HORIZON_RANGES = [
  { key: "12h", label: "Next 12 h", hours: 12, step: 1 },
  { key: "24h", label: "Next 24 h", hours: 24, step: 2 },
  { key: "7d", label: "Next 7 days", hours: 168, step: 6 },
] as const;

export type HorizonRangeKey = (typeof HORIZON_RANGES)[number]["key"];

/** The hour a horizon lands on, rounded down.
 *
 *  The model forecasts an hour bucket, not a moment, so a label of 12:26 PM
 *  implied a precision the prediction does not have. */
function hourOf(hoursAhead: number): Date {
  const t = new Date(Date.now() + hoursAhead * 3_600_000);
  t.setMinutes(0, 0, 0);
  return t;
}

const timeOf = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "Today", "Tomorrow", or the date — what a person calls the day. */
function dayOf(d: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today.getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** Day and time together, for anywhere the day is not already established. */
export function clockFor(hoursAhead: number): string {
  const t = hourOf(hoursAhead);
  const day = dayOf(t);
  return day === "Today" ? timeOf(t) : `${day} · ${timeOf(t)}`;
}

/** The hours worth offering for a range, clamped to what the warehouse holds. */
export function horizonOptionsFor(range: HorizonRangeKey, maxHorizon: number | null): number[] {
  const r = HORIZON_RANGES.find((x) => x.key === range) ?? HORIZON_RANGES[0];
  const reach = Math.min(r.hours, maxHorizon ?? r.hours);
  const out: number[] = [];
  for (let h = 1; h <= reach; h += r.step) out.push(h);
  // Always offer the far end of what is available, even when the step would
  // have skipped over it.
  if (reach >= 1 && out[out.length - 1] !== reach) out.push(reach);
  return out;
}

/**
 * Which hour the Forecasted Traffic map is showing.
 *
 * One component, rendered by both the panel and its expanded view, so the two
 * cannot offer different options or drift out of step — they are handed the
 * same state and produce the same control.
 *
 * It offers only ranges the warehouse can answer. gold.ml_predictive_congestion
 * holds whatever the pipeline was last asked to write, so a range beyond that
 * is shown but disabled and says why rather than drawing an empty corridor.
 */
export default function ForecastHorizonPicker({
  horizon,
  setHorizon,
  range,
  setRange,
  maxHorizon,
  compact = false,
}: {
  horizon: number;
  setHorizon: (h: number) => void;
  range: HorizonRangeKey;
  setRange: (r: HorizonRangeKey) => void;
  maxHorizon: number | null;
  /** Drops the heading, for a header bar that already has one. */
  compact?: boolean;
}) {
  const options = useMemo(() => horizonOptionsFor(range, maxHorizon), [range, maxHorizon]);

  /* A week, one row per day.
   *
   * Hourly across seven days is twenty-nine rows that mostly repeat: nobody
   * scrolls a dropdown hunting for 11 PM on Tuesday. What the week view is for
   * is which day is bad and when, so each row names a date and the hour that
   * day is most likely to be congested — the peak the backend computes from
   * the same rows the map draws. */
  const [peaks, setPeaks] = useState<DailyPeak[] | null>(null);

  useEffect(() => {
    if (range !== "7d") return;
    let cancelled = false;
    fetch(`${BACKEND}/api/map-comparison/forecast/peaks`, { cache: "no-store" })
      .then((r) => r.json())
      .then((b) => {
        if (!cancelled) setPeaks(b?.success ? (b.data as DailyPeak[]) : null);
      })
      .catch(() => {
        // Falls through to the hourly list below, which always works.
        if (!cancelled) setPeaks(null);
      });
    return () => {
      cancelled = true;
    };
  }, [range, maxHorizon]);

  const usePeaks = range === "7d" && peaks !== null && peaks.length > 0;

  /* Grouped by day.
   *
   * A week of options is twenty-nine rows, and flat they repeated the same
   * date four times over with the offset leading every line — so picking
   * "Monday evening" meant reading "+61 h" first and counting dates. Native
   * optgroups give the day once as a heading and leave the row to say the
   * time, which is what is actually being chosen. */
  const groups = useMemo(() => {
    const byDay: { day: string; items: { h: number; time: string }[] }[] = [];
    for (const h of options) {
      const t = hourOf(h);
      const day = dayOf(t);
      const last = byDay[byDay.length - 1];
      if (last && last.day === day) last.items.push({ h, time: timeOf(t) });
      else byDay.push({ day, items: [{ h, time: timeOf(t) }] });
    }
    return byDay;
  }, [options]);

  // If the range or the data no longer covers the chosen hour, fall back to
  // one that exists rather than requesting a gap.
  useEffect(() => {
    if (options.length > 0 && !options.includes(horizon)) setHorizon(options[0]);
  }, [options, horizon, setHorizon]);

  const chosen = hourOf(horizon);

  return (
    <div className={`mc-horizon${compact ? " is-compact" : ""}`}>
      {!compact && (
        <span className="mc-horizon-head">
          <Clock size={13} className="mc-purple-text" /> Forecast time
        </span>
      )}

      <div className="mc-horizon-ranges" role="group" aria-label="Forecast range">
        {HORIZON_RANGES.map((r) => {
          const reach = maxHorizon ?? 0;
          const ok = reach >= r.hours;
          return (
            <button
              key={r.key}
              type="button"
              className={`mc-horizon-range${range === r.key ? " is-active" : ""}`}
              aria-pressed={range === r.key}
              disabled={!ok}
              title={
                ok
                  ? `Pick any hour within ${r.label.toLowerCase()}`
                  : `The forecast currently reaches +${reach} h. Run the congestion pipeline further ahead to use this.`
              }
              onClick={() => {
                setRange(r.key);
                setHorizon(Math.min(horizon, r.hours));
              }}
            >
              {r.label}
            </button>
          );
        })}
      </div>

      <label className="mc-horizon-pick">
        <span className="sr-only">Forecast hour</span>
        <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
          {usePeaks
            ? peaks!.map((p) => {
                const t = new Date(p.at);
                return (
                  // The date leads because that is what is being chosen; the
                  // hour is the answer to "when that day", and the count says
                  // why that hour and not another.
                  <option key={p.day} value={p.hoursAhead}>
                    {`${dayOf(t)}  ·  ${timeOf(t)}  ·  ${p.congested} congested`}
                  </option>
                );
              })
            : groups.map((g) => (
                <optgroup key={g.day} label={g.day}>
                  {g.items.map((o) => (
                    <option key={o.h} value={o.h}>
                      {`${o.time}  ·  +${o.h} h`}
                    </option>
                  ))}
                </optgroup>
              ))}
        </select>
      </label>

      {/* A native select shows only the chosen row's text, which inside a day
          group no longer names the day. This says which one, so the closed
          control is never ambiguous. The expanded header states it in its own
          subtitle, so it is not repeated there. */}
      {!compact && !usePeaks && <span className="mc-horizon-when">{dayOf(chosen)}</span>}
    </div>
  );
}
