/**
 * Which time buckets a range is long enough to support.
 *
 * A trend needs at least two buckets to be a trend; one is a dot and zero is an
 * empty panel. Rolling a two-day range up to "monthly" produced a single bar
 * that could not be compared with anything, and the control gave no sign that
 * the choice was meaningless.
 *
 * The thresholds are two WHOLE buckets rather than two partial ones, because the
 * trend builders drop incomplete edge buckets — a "month" holding two days reads
 * as a collapse in a stacked chart, so it is trimmed. Asking for monthly over
 * 40 days would therefore leave a single complete month after trimming.
 */

export type Grain = "hourly" | "daily" | "weekly" | "monthly";

/** Whole days spanned by an inclusive from/to pair. */
export function rangeDays(from?: string, to?: string): number | null {
  if (!from || !to) return null;
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

const MIN_DAYS: Record<Exclude<Grain, "hourly">, number> = {
  daily: 2,
  weekly: 14,   // two whole weeks
  monthly: 60,  // two whole months, near enough
};

const LABEL: Record<Exclude<Grain, "hourly">, string> = {
  daily: "two days",
  weekly: "two weeks",
  monthly: "two months",
};

/**
 * Why this grain cannot be used for a range of `days`, or null if it can.
 * Returns a sentence for a tooltip rather than a boolean, so the control can say
 * what is wrong instead of just refusing.
 */
export function grainBlockedReason(grain: Grain, days: number | null): string | null {
  if (grain === "hourly") return null; // its own rule; the API decides
  if (days == null) return null;       // range unknown yet — do not restrict
  const need = MIN_DAYS[grain];
  return days < need
    ? `Needs at least ${LABEL[grain]} of data — this range is ${days} day${days === 1 ? "" : "s"}`
    : null;
}

/** The finest grain a range supports, used to demote an impossible selection. */
export function bestGrainFor(days: number | null, allowHourly: boolean): Grain {
  if (days == null) return "daily";
  if (days >= MIN_DAYS.monthly) return "monthly";
  if (days >= MIN_DAYS.weekly) return "weekly";
  return allowHourly ? "hourly" : "daily";
}
