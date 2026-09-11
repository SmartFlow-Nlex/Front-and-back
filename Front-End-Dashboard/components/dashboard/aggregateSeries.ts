/**
 * Time-bucket aggregation for the forecast chart.
 *
 * Before this existed the granularity control was decorative: Monthly and Yearly
 * both plotted the same ~2,400 daily points and differed only by which divider
 * lines were drawn. That is a control claiming a capability it does not have, and
 * at 0.6px per point the line was an unreadable band regardless.
 *
 * Two decisions worth stating:
 *
 *  - Buckets carry the MEAN daily volume, not the sum. A sum would make February
 *    look like a dip purely because it is shorter, which is an artefact of the
 *    calendar rather than anything about traffic.
 *
 *  - A bucket is assigned to Past / Present / Future by majority of its days. The
 *    zone boundary rarely lands on a period edge, so some bucket always straddles
 *    it; majority keeps the scored band honest to within at most half a bucket.
 *
 * What this does NOT claim: aggregating daily forecasts up to a month does not
 * produce a validated monthly forecast. The metrics describe 14-day-ahead DAILY
 * error and nothing else. This is a viewing aid.
 */

export type Granularity = "Hourly" | "Daily" | "Weekly" | "Monthly" | "Yearly";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Monday-anchored week start, derived from a YYYY-MM-DD string. */
function weekStartIso(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function bucketOf(iso: string, g: Granularity): { key: string; label: string } | null {
  if (!iso) return null;
  if (g === "Weekly") {
    const ws = weekStartIso(iso);
    const [y, m, d] = ws.split("-");
    return { key: `W${ws}`, label: `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}` };
  }
  if (g === "Monthly") {
    const [y, m] = iso.split("-");
    return { key: `M${y}-${m}`, label: `${MONTHS[Number(m) - 1]} ${y}` };
  }
  if (g === "Yearly") {
    const y = iso.slice(0, 4);
    return { key: `Y${y}`, label: y };
  }
  return null;
}

/** Wettest single day in the bucket. The rainfall COLOUR bands are PAGASA daily
 *  advisory thresholds, so applying them to a bucket mean describes an intensity
 *  no day necessarily had: over 2022-2025, the mean's band differed from the
 *  wettest day's band in 60.6% of weeks, and 6.3% of weeks were painted below
 *  "Heavy" while containing a day above 30 mm. Height stays the mean (comparable
 *  with volume, and unaffected by unequal bucket lengths); colour uses this. */
const maxOf = (vals: (number | null)[]): number | null => {
  const ok = vals.filter((v): v is number => v != null && isFinite(v));
  return ok.length === 0 ? null : Math.max(...ok);
};

const meanOf = (vals: (number | null)[]): number | null => {
  const ok = vals.filter((v): v is number => v != null && isFinite(v));
  return ok.length === 0 ? null : ok.reduce((s, v) => s + v, 0) / ok.length;
};

export type AggInput<K extends string> = {
  granularity: Granularity;
  isoDates: string[];
  baseActual: (number | null)[];
  models: Record<K, (number | null)[]>;
  rainfall: (number | null)[];
  holdoutStart: number;
  futureStart: number;
};

export type AggOutput<K extends string> = {
  dates: string[];
  isoDates: string[];
  baseActual: (number | null)[];
  models: Record<K, (number | null)[]>;
  rainfall: (number | null)[];
  /** Wettest single day per bucket. Drives the band COLOUR; the bar height uses
   *  `rainfall` (the mean). See maxOf above for why the two must differ. */
  rainfallPeak: (number | null)[];
  holdoutStart: number;
  futureStart: number;
  bucketDays: number[];
};

/** Returns null when no aggregation applies, so callers keep the daily arrays. */
export function aggregateSeries<K extends string>(input: AggInput<K>): AggOutput<K> | null {
  const { granularity, isoDates, baseActual, models, rainfall, holdoutStart, futureStart } = input;
  if (granularity === "Daily" || granularity === "Hourly") return null;
  if (isoDates.length === 0) return null;

  const order: string[] = [];
  const groups = new Map<string, { label: string; idx: number[] }>();

  isoDates.forEach((iso, i) => {
    const b = bucketOf(iso, granularity);
    if (!b) return;
    let g = groups.get(b.key);
    if (!g) {
      g = { label: b.label, idx: [] };
      groups.set(b.key, g);
      order.push(b.key);
    }
    g.idx.push(i);
  });
  if (order.length === 0) return null;

  const keys = Object.keys(models) as K[];
  const outModels = Object.fromEntries(keys.map((k) => [k, [] as (number | null)[]])) as Record<
    K,
    (number | null)[]
  >;

  const dates: string[] = [];
  const outIso: string[] = [];
  const outActual: (number | null)[] = [];
  const outRain: (number | null)[] = [];
  const outRainPeak: (number | null)[] = [];
  const bucketDays: number[] = [];
  const zones: number[] = [];

  order.forEach((key) => {
    const g = groups.get(key)!;
    dates.push(g.label);
    outIso.push(isoDates[g.idx[0]]);
    bucketDays.push(g.idx.length);
    outActual.push(meanOf(g.idx.map((i) => baseActual[i])));
    outRain.push(meanOf(g.idx.map((i) => rainfall[i])));
    outRainPeak.push(maxOf(g.idx.map((i) => rainfall[i])));
    keys.forEach((k) => outModels[k].push(meanOf(g.idx.map((i) => models[k][i]))));

    // majority zone for this bucket
    let past = 0, present = 0, future = 0;
    g.idx.forEach((i) => {
      if (i >= futureStart) future++;
      else if (i >= holdoutStart) present++;
      else past++;
    });
    zones.push(future >= present && future >= past ? 2 : present >= past ? 1 : 0);
  });

  const firstOf = (z: number) => {
    const i = zones.indexOf(z);
    return i === -1 ? dates.length : i;
  };

  return {
    dates,
    isoDates: outIso,
    baseActual: outActual,
    models: outModels,
    rainfall: outRain,
    /** Wettest day per bucket — drives the band colour, never the bar height. */
    rainfallPeak: outRainPeak,
    holdoutStart: firstOf(1),
    futureStart: firstOf(2),
    bucketDays,
  };
}
