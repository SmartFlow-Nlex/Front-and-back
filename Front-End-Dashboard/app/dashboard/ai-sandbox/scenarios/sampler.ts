import calibrationJson from "./calibration.json";
import { ASSUMPTIONS } from "./assumptions";
import {
  BREAKDOWN_CAUSES,
  BREAKDOWN_FAMILIES,
  BREAKDOWN_VEHICLES,
  CALIBRATION_KEYS,
  assertNever,
  calibrationKeyFor,
  causeKey,
  causeVehicleKey,
  vehicleKey,
  type BreakdownCause,
  type BreakdownFamilyKey,
  type CalibrationKey,
  type EntryKey,
  type HierarchyKey,
  type ScenarioVariant,
  type VehicleKind,
} from "./catalogue";

/* ══════════════════════════════════════════════════════════════════════════════
   DURATION SAMPLER

   Turns a calibration entry (quantiles from real NLEX events) into an event
   duration, in minutes:

     sampled - inverse-CDF draw. The CDF is piecewise linear between the knots
               (0,min) (.10,p10) (.25,p25) (.50,p50) (.75,p75) (.90,p90)
               (.99,p99) (1,max), where min and max are the observed extremes
               after exclusions. Seeded, so the same seed gives the same number.
               Capped by default at the p99 of the first level in the cap
               chain (see selectBreakdown) with at least CAP_MIN_N events (not always the entry's own
               p99: a thin cell would give a noisy cap); reported as `capped`.
     p50     - the median.
     p90     - the 90th percentile.
     manual  - the operator's own figure, validated, never capped.

   A breakdown's duration is its TOTAL (response + service), and it also carries
   the response share: the fraction of that total spent waiting for the
   responder. That is what splits its two phases.

   Which entry an event draws from: breakdowns walk a hierarchy
   (cause x vehicle -> cause -> vehicle -> family) and use the first level that
   has at least LOW_SAMPLE_N usable events; the level used is returned.

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

export type DurationKind = "clearance_min" | "response_plus_service_min_per_event";
export type CalibrationLevel = "cause_vehicle" | "cause" | "vehicle" | "label" | "family";

export type ResponseShareModel = {
  readonly n: number;
  /** Per-event share of the total spent waiting for the responder, 0..1. */
  readonly quantiles: QuantileSet;
  readonly mean: number;
  /** Fraction of events whose share is exactly 1 (service recorded as 0 min). */
  readonly fractionExactlyOne: number;
};

export type CalibrationEntry = {
  readonly key: EntryKey;
  readonly level: CalibrationLevel;
  readonly label: string;
  readonly durationKind: DurationKind;
  readonly durationDefinition: string;
  readonly population: string;
  /** Events in the population. */
  readonly nEvents: number;
  /** Duration values before exclusions (events with a usable record for breakdowns, events for accidents). */
  readonly nBeforeExclusion: number;
  /** Usable values: what the quantiles describe. */
  readonly n: number;
  readonly excluded: Exclusions;
  readonly quantiles: QuantileSet;
  /** Present exactly for breakdown entries. */
  readonly responseShare: ResponseShareModel | null;
};

export type HierarchyCell =
  | { readonly level: "family"; readonly family: BreakdownFamilyKey; readonly n: number; readonly qualifies: boolean }
  | { readonly level: "cause"; readonly family: BreakdownFamilyKey; readonly cause: BreakdownCause; readonly n: number; readonly qualifies: boolean }
  | { readonly level: "vehicle"; readonly family: BreakdownFamilyKey; readonly vehicle: VehicleKind; readonly n: number; readonly qualifies: boolean }
  | { readonly level: "cause_vehicle"; readonly family: BreakdownFamilyKey; readonly cause: BreakdownCause; readonly vehicle: VehicleKind; readonly n: number; readonly qualifies: boolean };

export type CalibrationProvenance = {
  readonly generatedOn: string;
  readonly generator: string;
  readonly source: string;
  readonly sourceFiles: readonly { readonly file: string; readonly rows: number }[];
  readonly csvRowTotals: { readonly accident: number; readonly breakdown: number };
  readonly exclusionRule: string;
  readonly quantileMethod: string;
  readonly breakdownEventRule: readonly string[];
  readonly knownLimitations: readonly string[];
};

export type Calibration = {
  readonly provenance: CalibrationProvenance;
  /** Always present: one per family, plus one per minor-collision label. */
  readonly entries: Readonly<Record<CalibrationKey, CalibrationEntry>>;
  /** Present only for breakdown cells with at least `hierarchyMinN` usable events. */
  readonly hierarchy: Readonly<Partial<Record<HierarchyKey, CalibrationEntry>>>;
  readonly hierarchyMinN: number;
  /** Every cell, qualifying or not, so a skipped level can say why. */
  readonly hierarchyCells: readonly HierarchyCell[];
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

function readBoolean(parent: Record<string, unknown>, key: string, path: string): boolean {
  const v = parent[key];
  if (typeof v !== "boolean") return fail(`${path}.${key}`, "a boolean");
  return v;
}

function readArray(parent: Record<string, unknown>, key: string, path: string): readonly unknown[] {
  const v = parent[key];
  if (!Array.isArray(v)) return fail(`${path}.${key}`, "an array");
  return v;
}

function readStringArray(parent: Record<string, unknown>, key: string, path: string): readonly string[] {
  return readArray(parent, key, path).map((v, i) => (typeof v === "string" ? v : fail(`${path}.${key}[${i}]`, "a string")));
}

/** Narrows a string to one member of `allowed` without a cast. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  for (const a of allowed) if (value === a) return a;
  return fail(path, `one of ${allowed.join(", ")}`);
}

const LEVELS = ["cause_vehicle", "cause", "vehicle", "label", "family"] as const;
const DURATION_KINDS = ["clearance_min", "response_plus_service_min_per_event"] as const;

function parseKnots(raw: Record<string, unknown>, path: string): QuantileSet {
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
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i] < ordered[i - 1]) fail(path, "non-decreasing from min to max");
  }
  return q;
}

function parseDurationQuantiles(raw: Record<string, unknown>, path: string): QuantileSet {
  const q = parseKnots(raw, path);
  if (q.min <= 0) fail(`${path}.min`, "greater than 0 (zero and negative durations are excluded upstream)");
  return q;
}

function parseShare(raw: Record<string, unknown>, path: string): ResponseShareModel {
  const q = parseKnots(raw, path);
  if (q.min < 0 || q.max > 1) fail(path, "a share between 0 and 1");
  return {
    n: readNumber(raw, "n", path),
    quantiles: q,
    mean: readNumber(raw, "mean", path),
    fractionExactlyOne: readNumber(raw, "fraction_exactly_1", path),
  };
}

function parseEntry(key: EntryKey, raw: Record<string, unknown>): CalibrationEntry {
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
  const durationKind = oneOf(raw.duration_kind, DURATION_KINDS, `${path}.duration_kind`);
  const shareRaw = raw.response_share;
  let responseShare: ResponseShareModel | null = null;
  if (durationKind === "response_plus_service_min_per_event") {
    if (!isRecord(shareRaw)) return fail(`${path}.response_share`, "an object for a breakdown entry");
    responseShare = parseShare(shareRaw, `${path}.response_share`);
    if (responseShare.n !== n) fail(`${path}.response_share.n`, "equal to n");
  } else if (shareRaw !== null && shareRaw !== undefined) {
    return fail(`${path}.response_share`, "null for an accident entry");
  }
  return {
    key,
    level: oneOf(raw.level, LEVELS, `${path}.level`),
    label: readString(raw, "label", path),
    durationKind,
    durationDefinition: readString(raw, "duration_definition", path),
    population: readString(raw, "population", path),
    nEvents: readNumber(raw, "n_events", path),
    nBeforeExclusion,
    n,
    excluded,
    quantiles: parseDurationQuantiles(raw, path),
    responseShare,
  };
}

function parseCell(raw: unknown, i: number): HierarchyCell {
  const path = `provenance.hierarchy.cells[${i}]`;
  if (!isRecord(raw)) return fail(path, "an object");
  const family = oneOf(raw.family, BREAKDOWN_FAMILIES, `${path}.family`);
  const n = readNumber(raw, "n", path);
  const qualifies = readBoolean(raw, "qualifies", path);
  const level = oneOf(raw.level, ["family", "cause", "vehicle", "cause_vehicle"] as const, `${path}.level`);
  switch (level) {
    case "family":
      return { level, family, n, qualifies };
    case "cause":
      return { level, family, cause: oneOf(raw.cause, BREAKDOWN_CAUSES, `${path}.cause`), n, qualifies };
    case "vehicle":
      return { level, family, vehicle: oneOf(raw.vehicle, BREAKDOWN_VEHICLES, `${path}.vehicle`), n, qualifies };
    case "cause_vehicle":
      return {
        level,
        family,
        cause: oneOf(raw.cause, BREAKDOWN_CAUSES, `${path}.cause`),
        vehicle: oneOf(raw.vehicle, BREAKDOWN_VEHICLES, `${path}.vehicle`),
        n,
        qualifies,
      };
    default:
      return assertNever(level);
  }
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
    breakdownEventRule: readStringArray(raw, "breakdown_event_rule", path),
    knownLimitations: readStringArray(raw, "known_limitations", path),
  };
}

/** The JSON key a hierarchy cell's entry is stored under, or null for the family cell (a base entry). */
function cellEntryKey(cell: HierarchyCell): HierarchyKey | null {
  switch (cell.level) {
    case "family":
      return null;
    case "cause":
      return causeKey(cell.family, cell.cause);
    case "vehicle":
      return vehicleKey(cell.family, cell.vehicle);
    case "cause_vehicle":
      return causeVehicleKey(cell.family, cell.cause, cell.vehicle);
    default:
      return assertNever(cell);
  }
}

export function parseCalibration(raw: unknown): Calibration {
  if (!isRecord(raw)) return fail("(root)", "an object");
  const families = readRecord(raw, "families", "(root)");
  const provenanceRaw = readRecord(raw, "provenance", "(root)");
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

  // The hierarchy block: minimum n, and a row for every cell, qualifying or not.
  const hierarchyRaw = readRecord(provenanceRaw, "hierarchy", "provenance");
  const hierarchyMinN = readNumber(hierarchyRaw, "min_n", "provenance.hierarchy");
  const hierarchyCells = readArray(hierarchyRaw, "cells", "provenance.hierarchy").map(parseCell);

  // Entries exist exactly for the qualifying non-family cells, and only for those.
  const hierarchy: Partial<Record<HierarchyKey, CalibrationEntry>> = {};
  const expectedKeys = new Set<string>();
  for (const cell of hierarchyCells) {
    const key = cellEntryKey(cell);
    if (key === null) continue;
    const present = families[key];
    if (cell.qualifies) {
      if (cell.n < hierarchyMinN) fail(`hierarchy cell ${key}`, `qualifying only with n >= ${hierarchyMinN}`);
      if (!isRecord(present)) return fail(`families.${key}`, "present: the cell qualifies");
      const entry = parseEntry(key, present);
      if (entry.n !== cell.n) fail(`families.${key}.n`, `equal to its hierarchy cell (${cell.n})`);
      hierarchy[key] = entry;
      expectedKeys.add(key);
    } else if (present !== undefined) {
      fail(`families.${key}`, `absent: its cell has n = ${cell.n}, below ${hierarchyMinN}`);
    }
  }
  const known = new Set<string>([...CALIBRATION_KEYS, ...expectedKeys]);
  for (const key of Object.keys(families)) {
    if (!known.has(key)) fail(`families.${key}`, "a known entry (unexpected key)");
  }
  return { provenance: parseProvenance(provenanceRaw), entries, hierarchy, hierarchyMinN, hierarchyCells };
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
   Hierarchy selection
───────────────────────────────────────────────────────────────────────────── */
export type SkippedLevel = {
  readonly level: "cause_vehicle" | "cause" | "vehicle";
  readonly key: HierarchyKey;
  /** Usable events in that cell, or null when the cell does not exist (e.g. a variant with no such cause). */
  readonly n: number | null;
  readonly reason: "below_min_n" | "no_cell";
};

/** One entry in a selection's chain, with the level it sits at. */
export type ChainLink = {
  readonly entry: CalibrationEntry;
  readonly level: CalibrationLevel;
};

/** The entry a sampled duration's cap is taken from: its p99, and where that p99 comes from. */
export type CapSource = {
  readonly key: EntryKey;
  readonly level: CalibrationLevel;
  /** Usable events behind the entry. At least CAP_MIN_N. */
  readonly n: number;
  /** The entry's p99, in minutes. */
  readonly minutes: number;
};

export type CalibrationSelection = {
  readonly entry: CalibrationEntry;
  readonly level: CalibrationLevel;
  /** Levels tried first and passed over, in order, with why. Empty when the first choice was used. */
  readonly skipped: readonly SkippedLevel[];
  /**
   * The CAP chain: the chosen entry, then (for a breakdown) the vehicle level, then
   * the cause level, then the family, keeping only entries that exist and dropping
   * repeats. The quantiles come from the first link; the cap comes from the first
   * link with enough events (see `cap`). This is not the quantile fallback order:
   * see selectBreakdown.
   */
  readonly chain: readonly ChainLink[];
  /** The cap for a sampled draw: the first link of `chain` with n >= CAP_MIN_N. Null when no link has that many. */
  readonly cap: CapSource | null;
};

/** The first link with at least `capMinN` usable events, as a cap source. Pure. */
export function capFromChain(chain: readonly ChainLink[], capMinN: number): CapSource | null {
  for (const link of chain) {
    if (link.entry.n >= capMinN) return { key: link.entry.key, level: link.level, n: link.entry.n, minutes: link.entry.quantiles.p99 };
  }
  return null;
}

function cellN(cal: Calibration, family: BreakdownFamilyKey, cause: BreakdownCause | null, vehicle: VehicleKind | null): number | null {
  for (const c of cal.hierarchyCells) {
    if (c.family !== family) continue;
    switch (c.level) {
      case "family":
        break;
      case "cause":
        if (cause !== null && vehicle === null && c.cause === cause) return c.n;
        break;
      case "vehicle":
        if (vehicle !== null && cause === null && c.vehicle === vehicle) return c.n;
        break;
      case "cause_vehicle":
        if (cause !== null && vehicle !== null && c.cause === cause && c.vehicle === vehicle) return c.n;
        break;
      default:
        return assertNever(c);
    }
  }
  return null;
}

/** The chosen entry, everything below it in the chain, and the cap taken from that chain. */
function withCap(chain: readonly ChainLink[], skipped: readonly SkippedLevel[], capMinN: number): CalibrationSelection {
  const first = chain[0];
  return { entry: first.entry, level: first.level, skipped, chain, cap: capFromChain(chain, capMinN) };
}

function selectBreakdown(cal: Calibration, family: BreakdownFamilyKey, cause: BreakdownCause, vehicle: VehicleKind, capMinN: number): CalibrationSelection {
  const tries: readonly { readonly level: SkippedLevel["level"]; readonly key: HierarchyKey; readonly n: number | null }[] = [
    { level: "cause_vehicle", key: causeVehicleKey(family, cause, vehicle), n: cellN(cal, family, cause, vehicle) },
    { level: "cause", key: causeKey(family, cause), n: cellN(cal, family, cause, null) },
    { level: "vehicle", key: vehicleKey(family, vehicle), n: cellN(cal, family, null, vehicle) },
  ];
  // The QUANTILES come from the first of cause x vehicle, cause, vehicle that has an entry (else the family).
  // Levels passed over on the way are reported as skipped, with why.
  const skipped: SkippedLevel[] = [];
  let resolved: ChainLink | null = null;
  for (const t of tries) {
    const entry = cal.hierarchy[t.key];
    if (entry !== undefined) {
      resolved = { entry, level: t.level };
      break;
    }
    skipped.push({ level: t.level, key: t.key, n: t.n, reason: t.n === null ? "no_cell" : "below_min_n" });
  }
  /* The CAP is walked in a different order: the resolved level, then VEHICLE, then CAUSE, then the family.
   * Obstruction time is driven mainly by what has to be recovered (ASSUMPTIONS.SAMPLED_CAP), so a thin
   * cause x vehicle cell inherits its vehicle's cap; the cause level pools cars and trucks and is
   * dominated by the trucks, which is the wrong ceiling for a car. */
  const link = (key: HierarchyKey, level: CalibrationLevel): ChainLink | null => {
    const entry = cal.hierarchy[key];
    return entry === undefined ? null : { entry, level };
  };
  const familyLink: ChainLink = { entry: cal.entries[family], level: "family" };
  const chain: ChainLink[] = [];
  for (const l of [resolved, link(vehicleKey(family, vehicle), "vehicle"), link(causeKey(family, cause), "cause"), familyLink]) {
    if (l !== null && !chain.some((c) => c.entry.key === l.entry.key)) chain.push(l);
  }
  return withCap(chain, skipped, capMinN);
}

/**
 * The calibration entry a variant draws from, and the cap on a sampled draw.
 *
 * Breakdowns use the first of cause x vehicle, cause, vehicle, family that has at
 * least hierarchyMinN usable events. Every other family uses its own entry (a minor
 * collision, its label's). Quantiles always come from that entry.
 *
 * The CAP comes from the first entry in the cap chain with at least capMinN usable
 * events, because a p99 needs enough tail observations to be stable
 * (ASSUMPTIONS.CAP_MIN_N). For a breakdown the chain is the chosen entry, then the
 * vehicle level, then the cause level, then the family; a minor collision's is its
 * label, then minor_collision.
 *
 * Pure: takes the calibration (and capMinN), so a test can hand it a modified one.
 */
export function selectFromCalibration(cal: Calibration, variant: ScenarioVariant, capMinN: number = ASSUMPTIONS.CAP_MIN_N.value): CalibrationSelection {
  switch (variant.family) {
    case "breakdown_in_lane":
    case "breakdown_shoulder":
      return selectBreakdown(cal, variant.family, variant.cause, variant.vehicle, capMinN);
    case "minor_collision": {
      const label = cal.entries[calibrationKeyFor(variant)];
      return withCap([{ entry: label, level: label.level }, { entry: cal.entries.minor_collision, level: "family" }], [], capMinN);
    }
    case "multi_vehicle_collision":
    case "self_accident": {
      const entry = cal.entries[calibrationKeyFor(variant)];
      return withCap([{ entry, level: entry.level }], [], capMinN);
    }
    default:
      return assertNever(variant);
  }
}

export function selectCalibration(variant: ScenarioVariant): CalibrationSelection {
  return selectFromCalibration(getCalibration(), variant);
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

/** XORed into an event's seed for its response-share draw, so the share is independent of the duration draw. */
export const SHARE_SEED_SALT = 0x5bd1e995;

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
   * Cap on a SAMPLED duration, in minutes.
   *   undefined - the p99 of the first level in the cap chain with at least CAP_MIN_N events (the default)
   *   a number  - that cap
   *   null      - no cap
   * Never applied to p50, p90 or manual, which are deliberate choices.
   */
  readonly capMinutes?: number | null;
};

export type DrawnDuration = {
  /** Total duration of the event. Always finite and greater than 0. */
  readonly minutes: number;
  /** Fraction of `minutes` spent waiting for the responder (breakdowns); null for accident families. */
  readonly responseShare: number | null;
  /** What was drawn before any cap: equals `minutes` unless `capped`. */
  readonly uncappedMinutes: number;
  /** True when a sampled draw exceeded the cap and was clamped to it. */
  readonly capped: boolean;
  /** The cap in force for a sampled draw; null when uncapped or not a sampled draw. */
  readonly capMinutes: number | null;
  readonly mode: DurationMode["kind"];
};

function checkCap(cap: number | null): number | null {
  if (cap !== null && (!Number.isFinite(cap) || cap <= 0)) throw new RangeError(`capMinutes must be a positive number or null, got ${cap}`);
  return cap;
}

/**
 * One duration from one entry. The cap is explicit (null = none) and applies to a
 * sampled draw only; `resolveDuration` is what picks it from the cap chain.
 */
export function drawDuration(entry: CalibrationEntry, mode: DurationMode, capMinutes: number | null): DrawnDuration {
  const medianShare = entry.responseShare === null ? null : entry.responseShare.quantiles.p50;
  switch (mode.kind) {
    case "sampled": {
      const raw = inverseCdf(entry.quantiles, makeRng(mode.seed)());
      const cap = checkCap(capMinutes);
      const minutes = cap !== null && raw > cap ? cap : raw;
      const responseShare =
        entry.responseShare === null ? null : inverseCdf(entry.responseShare.quantiles, makeRng(mode.seed ^ SHARE_SEED_SALT)());
      return { minutes, responseShare, uncappedMinutes: raw, capped: minutes !== raw, capMinutes: cap, mode: mode.kind };
    }
    case "p50":
      return { minutes: entry.quantiles.p50, responseShare: medianShare, uncappedMinutes: entry.quantiles.p50, capped: false, capMinutes: null, mode: mode.kind };
    case "p90":
      return { minutes: entry.quantiles.p90, responseShare: medianShare, uncappedMinutes: entry.quantiles.p90, capped: false, capMinutes: null, mode: mode.kind };
    case "manual":
      if (!Number.isFinite(mode.minutes) || mode.minutes <= 0) throw new RangeError(`manual minutes must be a positive number, got ${mode.minutes}`);
      return { minutes: mode.minutes, responseShare: medianShare, uncappedMinutes: mode.minutes, capped: false, capMinutes: null, mode: mode.kind };
    default:
      return assertNever(mode);
  }
}

export type ResolvedDuration = DrawnDuration & {
  /** The entry the duration was drawn from. */
  readonly calibrationKey: EntryKey;
  /** Which level of the hierarchy that entry sits at. */
  readonly level: CalibrationLevel;
  /** Usable events behind the entry. */
  readonly n: number;
  /** True when that entry has fewer usable events than ASSUMPTIONS.LOW_SAMPLE_N. */
  readonly lowSample: boolean;
  /** Levels tried first and passed over, and why. */
  readonly skippedLevels: readonly SkippedLevel[];
  /**
   * Where the cap in force came from: the entry, its level and its n. All null when
   * there is no cap in force (not a sampled draw, an explicit `capMinutes`, or no
   * level in the chain has enough events).
   */
  readonly capKey: EntryKey | null;
  readonly capLevel: CalibrationLevel | null;
  readonly capN: number | null;
};

/** Resolve an event's duration: pick its entry through the hierarchy, take the cap from the chain, then draw. */
export function resolveDuration(variant: ScenarioVariant, mode: DurationMode, options?: SampleOptions): ResolvedDuration {
  const selection = selectCalibration(variant);
  const requested = options?.capMinutes;
  const fromChain = requested === undefined && mode.kind === "sampled" ? selection.cap : null;
  const capMinutes = requested === undefined ? (fromChain === null ? null : fromChain.minutes) : requested;
  return {
    ...drawDuration(selection.entry, mode, capMinutes),
    calibrationKey: selection.entry.key,
    level: selection.level,
    n: selection.entry.n,
    lowSample: isLowSample(selection.entry),
    skippedLevels: selection.skipped,
    capKey: fromChain === null ? null : fromChain.key,
    capLevel: fromChain === null ? null : fromChain.level,
    capN: fromChain === null ? null : fromChain.n,
  };
}

/** Convenience: a seeded draw for a variant. */
export function sampleDuration(variant: ScenarioVariant, seed: number, options?: SampleOptions): ResolvedDuration {
  return resolveDuration(variant, { kind: "sampled", seed }, options);
}
