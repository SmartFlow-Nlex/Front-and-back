import calibrationJson from "./calibration.json";
import { ASSUMPTIONS } from "./assumptions";
import { assertNever, type CalibrationKey } from "./catalogue";

/* ══════════════════════════════════════════════════════════════════════════════
   DURATION SAMPLER

   Turns a calibration entry (quantiles from real NLEX events) into an event
   duration, in minutes:

     sampled - inverse-CDF draw. The CDF is piecewise linear between the knots
               (0,min) (.10,p10) (.25,p25) (.50,p50) (.75,p75) (.90,p90)
               (.99,p99) (1,max), where min and max are the observed extremes
               after exclusions. Seeded, so the same seed gives the same number.
     p50     - the median.
     p90     - the 90th percentile.
     manual  - the operator's own figure, validated.

   The calibration file is parsed defensively (no casts from JSON), so a
   hand-edited or regenerated file that breaks the contract fails loudly here
   rather than producing a silent NaN duration.
══════════════════════════════════════════════════════════════════════════════ */

export type QuantileSet = {
  readonly min: number;
  readonly p10: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
};

export type Exclusions = {
  readonly missing: number;
  readonly negative: number;
  readonly zero: number;
  readonly over1440: number;
};

export type DurationKind = "clearance_min" | "service_time_min_per_deployment_record";

export type CalibrationEntry = {
  readonly key: CalibrationKey;
  readonly label: string;
  readonly durationKind: DurationKind;
  readonly durationDefinition: string;
  readonly population: string;
  /** Events in the population. */
  readonly nEvents: number;
  /** Duration values before exclusions (events for accidents, deployment records for breakdowns). */
  readonly nBeforeExclusion: number;
  /** Values that remain and the quantiles describe. */
  readonly n: number;
  readonly excluded: Exclusions;
  readonly quantiles: QuantileSet;
};

export type CalibrationProvenance = {
  readonly generatedOn: string;
  readonly generator: string;
  readonly source: string;
  readonly sourceFiles: readonly { readonly file: string; readonly rows: number }[];
  readonly csvRowTotals: { readonly accident: number; readonly breakdown: number };
  readonly exclusionRule: string;
  readonly quantileMethod: string;
  readonly knownLimitations: readonly string[];
};

export type Calibration = {
  readonly provenance: CalibrationProvenance;
  readonly entries: Readonly<Record<CalibrationKey, CalibrationEntry>>;
};

/* ─────────────────────────────────────────────────────────────────────────────
   Parsing (unknown -> typed, no casts)
───────────────────────────────────────────────────────────────────────────── */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, want: string): never {
  throw new Error(`calibration.json: ${path} must be ${want}`);
}

function readRecord(parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const v = parent[key];
  if (!isRecord(v)) return fail(`${path}.${key}`, "an object");
  return v;
}

function readNumber(parent: Record<string, unknown>, key: string, path: string): number {
  const v = parent[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return fail(`${path}.${key}`, "a finite number");
  return v;
}

function readString(parent: Record<string, unknown>, key: string, path: string): string {
  const v = parent[key];
  if (typeof v !== "string" || v.length === 0) return fail(`${path}.${key}`, "a non-empty string");
  return v;
}

function readArray(parent: Record<string, unknown>, key: string, path: string): readonly unknown[] {
  const v = parent[key];
  if (!Array.isArray(v)) return fail(`${path}.${key}`, "an array");
  return v;
}

function readDurationKind(parent: Record<string, unknown>, key: string, path: string): DurationKind {
  const v = readString(parent, key, path);
  if (v === "clearance_min" || v === "service_time_min_per_deployment_record") return v;
  return fail(`${path}.${key}`, "clearance_min or service_time_min_per_deployment_record");
}

function parseQuantiles(raw: Record<string, unknown>, path: string): QuantileSet {
  const q: QuantileSet = {
    min: readNumber(raw, "min", path),
    p10: readNumber(raw, "p10", path),
    p25: readNumber(raw, "p25", path),
    p50: readNumber(raw, "p50", path),
    p75: readNumber(raw, "p75", path),
    p90: readNumber(raw, "p90", path),
    p99: readNumber(raw, "p99", path),
    max: readNumber(raw, "max", path),
  };
  const ordered = [q.min, q.p10, q.p25, q.p50, q.p75, q.p90, q.p99, q.max];
  if (q.min <= 0) fail(`${path}.min`, "greater than 0 (zero and negative durations are excluded upstream)");
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i] < ordered[i - 1]) fail(path, "non-decreasing from min to max");
  }
  return q;
}

function parseEntry(key: CalibrationKey, raw: Record<string, unknown>): CalibrationEntry {
  const path = `families.${key}`;
  const ex = readRecord(raw, "excluded", path);
  const excluded: Exclusions = {
    missing: readNumber(ex, "missing", `${path}.excluded`),
    negative: readNumber(ex, "negative", `${path}.excluded`),
    zero: readNumber(ex, "zero", `${path}.excluded`),
    over1440: readNumber(ex, "over_1440", `${path}.excluded`),
  };
  const n = readNumber(raw, "n", path);
  const nBeforeExclusion = readNumber(raw, "n_values_before_exclusion", path);
  const excludedTotal = excluded.missing + excluded.negative + excluded.zero + excluded.over1440;
  if (n <= 0) fail(`${path}.n`, "greater than 0");
  if (n + excludedTotal !== nBeforeExclusion) fail(path, "consistent: n + excluded must equal n_values_before_exclusion");
  return {
    key,
    label: readString(raw, "label", path),
    durationKind: readDurationKind(raw, "duration_kind", path),
    durationDefinition: readString(raw, "duration_definition", path),
    population: readString(raw, "population", path),
    nEvents: readNumber(raw, "n_events", path),
    nBeforeExclusion,
    n,
    excluded,
    quantiles: parseQuantiles(raw, path),
  };
}

function readStringArray(parent: Record<string, unknown>, key: string, path: string): readonly string[] {
  return readArray(parent, key, path).map((v, i) => (typeof v === "string" ? v : fail(`${path}.${key}[${i}]`, "a string")));
}

function parseProvenance(raw: Record<string, unknown>): CalibrationProvenance {
  const path = "provenance";
  const totals = readRecord(raw, "csv_row_totals", path);
  return {
    generatedOn: readString(raw, "generated_on", path),
    generator: readString(raw, "generator", path),
    source: readString(raw, "source", path),
    sourceFiles: readArray(raw, "source_files", path).map((f, i) => {
      if (!isRecord(f)) return fail(`${path}.source_files[${i}]`, "an object");
      return { file: readString(f, "file", `${path}.source_files[${i}]`), rows: readNumber(f, "rows", `${path}.source_files[${i}]`) };
    }),
    csvRowTotals: { accident: readNumber(totals, "accident", `${path}.csv_row_totals`), breakdown: readNumber(totals, "breakdown", `${path}.csv_row_totals`) },
    exclusionRule: readString(raw, "exclusion_rule", path),
    quantileMethod: readString(raw, "quantile_method", path),
    knownLimitations: readStringArray(raw, "known_limitations", path),
  };
}

export function parseCalibration(raw: unknown): Calibration {
  if (!isRecord(raw)) return fail("(root)", "an object");
  const families = readRecord(raw, "families", "(root)");
  const at = (key: CalibrationKey): CalibrationEntry => parseEntry(key, readRecord(families, key, "families"));
  // Written out, not looped: a key added to CALIBRATION_KEYS without a line here is a compile error.
  const entries: Record<CalibrationKey, CalibrationEntry> = {
    breakdown_in_lane: at("breakdown_in_lane"),
    breakdown_shoulder: at("breakdown_shoulder"),
    minor_collision: at("minor_collision"),
    minor_collision_rear_end: at("minor_collision_rear_end"),
    minor_collision_sideswipe: at("minor_collision_sideswipe"),
    minor_collision_hit_and_run: at("minor_collision_hit_and_run"),
    multi_vehicle_collision: at("multi_vehicle_collision"),
    self_accident: at("self_accident"),
  };
  return { provenance: parseProvenance(readRecord(raw, "provenance", "(root)")), entries };
}

let cached: Calibration | null = null;

/** The parsed calibration file. Parsed on first use and memoised. */
export function getCalibration(): Calibration {
  if (cached === null) cached = parseCalibration(calibrationJson);
  return cached;
}

export function getCalibrationEntry(key: CalibrationKey): CalibrationEntry {
  return getCalibration().entries[key];
}

/** True when the entry has fewer usable values than the small-sample threshold (see ASSUMPTIONS.LOW_SAMPLE_N). */
export function isLowSample(entry: CalibrationEntry): boolean {
  return entry.n < ASSUMPTIONS.LOW_SAMPLE_N.value;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Seeded randomness
───────────────────────────────────────────────────────────────────────────── */

/**
 * Scrambles a seed before it seeds the generator. Callers will naturally pass
 * consecutive integers (event 1, event 2, ...), and the first output of a cheap
 * PRNG seeded that way is visibly correlated; a finaliser hash removes that.
 */
export function mixSeed(seed: number): number {
  let x = seed >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Mulberry32, the generator the engine itself uses, behind a seed mix. Returns numbers in [0, 1). */
export function makeRng(seed: number): () => number {
  if (!Number.isInteger(seed)) throw new RangeError(`seed must be an integer, got ${seed}`);
  let a = mixSeed(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   Inverse CDF
───────────────────────────────────────────────────────────────────────────── */
const KNOT_PROBS = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1] as const;

function knotValues(q: QuantileSet): readonly number[] {
  return [q.min, q.p10, q.p25, q.p50, q.p75, q.p90, q.p99, q.max];
}

/** Value at cumulative probability u in [0, 1], linear between the knots. */
export function inverseCdf(q: QuantileSet, u: number): number {
  if (!(u >= 0 && u <= 1)) throw new RangeError(`u must be in [0, 1], got ${u}`);
  const values = knotValues(q);
  for (let i = 0; i < KNOT_PROBS.length - 1; i++) {
    const p0 = KNOT_PROBS[i];
    const p1 = KNOT_PROBS[i + 1];
    if (u <= p1) {
      const t = (u - p0) / (p1 - p0);
      return values[i] + t * (values[i + 1] - values[i]);
    }
  }
  return q.max;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Duration modes
───────────────────────────────────────────────────────────────────────────── */
export type DurationMode =
  | { readonly kind: "sampled"; readonly seed: number }
  | { readonly kind: "p50" }
  | { readonly kind: "p90" }
  | { readonly kind: "manual"; readonly minutes: number };

export type SampleOptions = {
  /**
   * Upper bound on a SAMPLED duration, in minutes. The last 1% of the
   * distribution runs from p99 out to the observed maximum (up to a day), so an
   * uncapped draw occasionally produces an event far longer than a sandbox run
   * can show. Draws above the cap are clamped to it. Not applied to p50, p90 or
   * manual, which are deliberate choices.
   */
  readonly capMinutes?: number;
};

/** Duration of an event, in minutes. Always finite and greater than 0. */
export function resolveDurationMinutes(entry: CalibrationEntry, mode: DurationMode, options?: SampleOptions): number {
  switch (mode.kind) {
    case "sampled": {
      const drawn = inverseCdf(entry.quantiles, makeRng(mode.seed)());
      const cap = options?.capMinutes;
      if (cap === undefined) return drawn;
      if (!Number.isFinite(cap) || cap <= 0) throw new RangeError(`capMinutes must be a positive number, got ${cap}`);
      return Math.min(drawn, cap);
    }
    case "p50":
      return entry.quantiles.p50;
    case "p90":
      return entry.quantiles.p90;
    case "manual":
      if (!Number.isFinite(mode.minutes) || mode.minutes <= 0) throw new RangeError(`manual minutes must be a positive number, got ${mode.minutes}`);
      return mode.minutes;
    default:
      return assertNever(mode);
  }
}

/** Convenience: a seeded draw by calibration key. */
export function sampleDurationMinutes(key: CalibrationKey, seed: number, options?: SampleOptions): number {
  return resolveDurationMinutes(getCalibrationEntry(key), { kind: "sampled", seed }, options);
}
