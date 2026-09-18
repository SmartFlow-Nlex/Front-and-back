"use client";

import { useEffect, useMemo } from "react";
import { Clock } from "lucide-react";

/* The ranges the forecast picker offers, and how finely each is stepped.
   Hour by hour is right for half a day and useless for a week: 168 options in
   a dropdown is a list nobody reads, so the longer ranges step coarser. */
export const HORIZON_RANGES = [
  { key: "12h", label: "Next 12 h", hours: 12, step: 1 },
  { key: "24h", label: "Next 24 h", hours: 24, step: 2 },
  { key: "7d", label: "Next 7 days", hours: 168, step: 6 },
] as const;

export type HorizonRangeKey = (typeof HORIZON_RANGES)[number]["key"];

/**
 * The wall-clock hour a given number of hours ahead lands on.
 *
 * Rounded down to the hour on purpose. The model forecasts an hour bucket, not
 * a moment, so "+9 h · 12:26 PM" implied a precision the prediction does not
 * have and made a list of consecutive hours read as a list of odd times.
 */
export function clockFor(hoursAhead: number): string {
  const t = new Date(Date.now() + hoursAhead * 3_600_000);
  t.setMinutes(0, 0, 0);

  const now = new Date();
  const sameDay = t.toDateString() === now.toDateString();
  const time = t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;

  /* Past today, the weekday alone is not enough: a week out there are two
     Saturdays in the list and "Sat 10:00 AM" appears twice, meaning different
     days. The date is what tells them apart. */
  const day = t.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${day} · ${time}`;
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

  // If the range or the data no longer covers the chosen hour, fall back to
  // one that exists rather than requesting a gap.
  useEffect(() => {
    if (options.length > 0 && !options.includes(horizon)) setHorizon(options[0]);
  }, [options, horizon, setHorizon]);

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
        <span className="sr-only">Hours ahead</span>
        <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
          {options.map((h) => (
            <option key={h} value={h}>
              {`+${h} h · ${clockFor(h)}`}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
