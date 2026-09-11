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

/**
 * X-axis label for a trend bucket, given the grain.
 *
 * The bucket keys are storage formats — "2026-01" for a month, "2026-01-05" for
 * a day or a week start, "2026-01-05 14:00" for an hour — and they were reaching
 * the axis almost untouched. Monthly rendered "2026-01" literally; daily and
 * weekly were sliced back to "2026-01"; two of the three tabs had no formatter at
 * all and printed the raw key.
 *
 * The grain also decides WHICH buckets get a label: the charts only draw one
 * where the period changes, so for daily and weekly the labelled bucket is the
 * first of a month and should read as that month, not as its date. That is why
 * daily and weekly share the monthly format rather than showing a day number
 * that would look arbitrary.
 */
export function axisLabelFor(grain: Grain): (key: string) => string {
  if (grain === "hourly") {
    // Labelled at day boundaries, so the day is the useful part.
    return (key) => {
      const d = new Date(`${key.slice(0, 10)}T00:00:00`);
      return Number.isNaN(d.getTime())
        ? key
        : d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
    };
  }
  return (key) => {
    // Month keys have no day; give them one so Date can parse them.
    const iso = key.length === 7 ? `${key}-01` : key.slice(0, 10);
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime())
      ? key
      : d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  };
}

/**
 * Full description of a bucket, for a tooltip.
 *
 * Deliberately more precise than the axis label. The axis only labels the bucket
 * that starts a month, so for daily and weekly it names the month — but a tooltip
 * is pointing at one specific bucket, and "Jan 2026" would not say which day of
 * January was under the cursor.
 */
export function bucketLabelFor(grain: Grain): (key: string) => string {
  return (key) => {
    const iso = key.length === 7 ? `${key}-01` : key.slice(0, 10);
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return key;

    if (grain === "monthly") {
      return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    }
    const day = d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
    if (grain === "weekly") return `Week of ${day}`;
    if (grain === "hourly") {
      const hour = Number(key.slice(11, 13));
      const h = Number.isNaN(hour)
        ? ""
        : `, ${hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`}`;
      return `${day}${h}`;
    }
    return d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  };
}
