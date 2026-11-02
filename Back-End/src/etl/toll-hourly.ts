/**
 * Hourly toll transactions — the layout the corridor's traffic record is built from.
 *
 *   date,hour,exit_plaza,entry_plaza,entry_plaza_name,class_1,class_2,class_3,total,exit_plaza_name
 *
 * One row per entry plaza x exit plaza x hour: nlex_traffic_hourly_<year>.csv.
 * The 2022-2025 years were loaded by smartflow_scripts/1_data_loading/traffic
 * (build_fact.mjs -> load_fact.js, build_origin.mjs -> load_origin.js), which
 * rebuild every table from all the yearly files at once. Those files are not
 * kept alongside the app, so a new year could not be added from here: the
 * upload page did not even recognise the layout, and the traffic shape it did
 * recognise wrote to bronze.nlex_traffic_volume, which no dashboard reads.
 *
 * This loads a file of this layout the way those scripts did, and only for
 * the days it contains:
 *
 *   gold.fact_traffic_hourly           trips keyed on the plaza where they PAID
 *                                      (build_fact.mjs, exactly the same key)
 *   gold.fact_traffic_hourly_origin    the same trips keyed on their ENTRY plaza
 *                                      (build_origin.mjs, exactly the same key)
 *   gold.daily_traffic_volume_corrected  the daily series the volume models train
 *                                      on: each day's rounded sum of the first
 *   gold.fact_vkm_hourly               the km those trips drove on NLEX, on the first's key
 *                                      (trip-km.ts), plus trips paid off NLEX, on their
 *                                      NLEX entry plaza with status 'off_nlex'
 *   gold.fact_emissions_hourly         emissions from it: EMISSIONS_SELECT below
 *   public.nlex_traffic_volume         the Descriptive tab's view, refreshed
 *
 * Every plaza-hour in the file REPLACES the warehouse's figure for it, so
 * uploading the same file twice gives the same record, not double traffic, and
 * a file holding only some plazas (a correction) leaves the others alone.
 *
 * Two kinds of row are held back:
 *   - Rows dated after RECORD_END, where the corridor's record stops, or after
 *     today if that comes first. A record of traffic that has not happened yet
 *     would put "observed" volume where the forecasts should be.
 *   - Rows whose exit is not one of the 20 NLEX exits (Lingunan). The 2025
 *     file had them removed before loading (drop_lingunan.py); the resolver
 *     cannot place them, so they are reported, never guessed.
 */
import type { PoolClient } from "pg";
import { db } from "../config/db.js";
import { resolvePlaza, type ResolvedPlaza } from "./canonical-exit.js";
import type { RawRow } from "./parser.js";
import { compareToll, type UploadComparison } from "./compare.js";
import { UndoJournal, type UndoKey } from "./undo.js";
import { tripKm } from "./trip-km.js";

/* The keys the load replaces by, for its undo journal (undo.ts). */
const FACT_KEY: UndoKey = { cols: ["date", "hour", "exit_canonical", "status", "direction", "role", "toll_system"], nullable: ["direction", "role", "toll_system"] };
const ORIGIN_KEY: UndoKey = { cols: ["date", "hour", "entry_canonical", "status", "direction"], nullable: ["direction"] };
const DAY_KEY: UndoKey = { cols: ["date"] };

export const TOLL_HOURLY_COLUMNS = [
  "date", "hour", "exit_plaza", "entry_plaza", "entry_plaza_name",
  "class_1", "class_2", "class_3", "total", "exit_plaza_name",
] as const;

type Sums = [number, number, number, number];
/** Vehicle-km of classes 1..3. */
export type Vkm = [number, number, number];

export interface TollHourlyAggregate {
  /** date \t hour \t exit \t direction \t role \t system \t status -> class_1..3, total */
  fact: Map<string, Sums>;
  /** date \t hour \t entry \t direction \t status -> class_1..3, total */
  origin: Map<string, Sums>;
  /** The fact key -> vehicle-km on NLEX. Trips paid off NLEX are keyed on their entry plaza, status "off_nlex". */
  vkm: Map<string, Vkm>;
  dates: string[];
  rowsAccepted: number;
  rowsRejected: number;
  /** Rows by why they were held back. */
  heldBack: { late: number; offCorridorExit: number; malformed: number };
  /** Rows counted in the record whose ENTRY could not be placed: not in the origin table. */
  unplacedOrigins: number;
  /** The dates held back for falling after the cutoff. */
  lateDates: { first: string; last: string; days: number } | null;
  rejectedSample: { row: Record<string, unknown>; reason: string }[];
  /** The last day loaded, and whether it is the record's end or today. */
  cutoff: Cutoff;
}

export type Cutoff = { date: string; why: "record end" | "today" };

/* Where the corridor's record ends. The other datasets in the warehouse —
 * incidents, the emissions source — stop on 2026-06-30, and traffic is kept
 * to the same window so the models train on days every source covers (the
 * project owner's call, 2026-10-01). A row after it is held back, not loaded.
 * Move this date when the record is meant to grow. */
export const RECORD_END = "2026-06-30";

/** Today in Manila, as YYYY-MM-DD. */
export function manilaToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The last day a load may write: the record's end, or today if that comes first. */
export function loadCutoff(now = new Date()): Cutoff {
  const today = manilaToday(now);
  return today < RECORD_END ? { date: today, why: "today" } : { date: RECORD_END, why: "record end" };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: unknown): number => (typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "")));

/**
 * One pass over the parsed rows: hold back what cannot be loaded, and
 * aggregate the rest to the warehouse grain. The keys are build_fact.mjs's and
 * build_origin.mjs's, character for character, so a 2026 day lands in the
 * same shape as a 2025 one.
 */
export function aggregateTollHourly(rows: Iterable<RawRow>, cutoff: Cutoff = loadCutoff()): TollHourlyAggregate {
  const cache = new Map<string, ResolvedPlaza>();
  const resolve = (s: string): ResolvedPlaza => {
    let v = cache.get(s);
    if (v === undefined) { v = resolvePlaza(s); cache.set(s, v); }
    return v;
  };

  const fact = new Map<string, Sums>();
  const origin = new Map<string, Sums>();
  const vkm = new Map<string, Vkm>();
  /** Trips nothing says the distance of, by fact key: charged the mean of the known trips at the plaza (below). */
  const unknownKm = new Map<string, Vkm>();
  /** plaza (the fact key less date and hour) -> known km and trips, by class; "" is the whole file. */
  const knownKm = new Map<string, [Vkm, Vkm]>();
  const addVkm = (key: string, i: number, v: number) => {
    const a = vkm.get(key);
    if (a) a[i] += v; else { const n: Vkm = [0, 0, 0]; n[i] = v; vkm.set(key, n); }
  };
  const addKnown = (plaza: string, i: number, trips: number, km: number) => {
    let a = knownKm.get(plaza);
    if (!a) { a = [[0, 0, 0], [0, 0, 0]]; knownKm.set(plaza, a); }
    a[0][i] += trips * km; a[1][i] += trips;
  };
  const dates = new Set<string>();
  const lateDates = new Set<string>();
  const heldBack = { late: 0, offCorridorExit: 0, malformed: 0 };
  const samples: Record<string, { row: Record<string, unknown>; reason: string }[]> = { late: [], offCorridorExit: [], malformed: [] };
  const lateReason = cutoff.why === "today"
    ? `dated after today (${cutoff.date}): traffic that has not happened yet is not loaded`
    : `dated after ${cutoff.date}, where the corridor's record ends`;
  const keep = (kind: keyof typeof samples, row: RawRow, reason: string) => {
    if (samples[kind].length < 4) samples[kind].push({ row: { ...row }, reason });
  };
  let accepted = 0;
  let unplacedOrigins = 0;

  for (const row of rows) {
    const date = String(row.date ?? "");
    const hour = num(row.hour);
    const c = [num(row.class_1), num(row.class_2), num(row.class_3), num(row.total)];
    if (!ISO_DATE.test(date) || !Number.isInteger(hour) || hour < 0 || hour > 23 || c.some((x) => !Number.isFinite(x) || x < 0)) {
      heldBack.malformed++;
      keep("malformed", row, "malformed: a date, hour or count that cannot be read");
      continue;
    }
    if (date > cutoff.date) {
      heldBack.late++;
      lateDates.add(date);
      keep("late", row, lateReason);
      continue;
    }
    const entryCode = num(row.entry_plaza), exitCode = num(row.exit_plaza);
    if (row.off_nlex) {
      // Paid on SCTEX, SFEX or the Connector: not in the traffic record, but the part driven on NLEX is NLEX emissions.
      const en = resolve(String(row.entry_plaza_name ?? ""));
      const t = tripKm(entryCode, exitCode, en, resolve(String(row.exit_plaza_name ?? "")));
      if (en.status === "nlex" && t.kind === "known" && t.km > 0) {
        const key = `${date}\t${hour}\t${en.canonical}\t${en.direction ?? ""}\t${en.role ?? ""}\t${en.system ?? ""}\toff_nlex`;
        for (let i = 0; i < 3; i++) if (c[i] > 0) addVkm(key, i, c[i] * t.km);
      }
      continue;
    }
    const ex = resolve(String(row.exit_plaza_name ?? ""));
    if (ex.status === "unresolved") {
      heldBack.offCorridorExit++;
      keep("offCorridorExit", row, `exit "${row.exit_plaza_name}" is not one of the 20 NLEX exits`);
      continue;
    }

    accepted++;
    dates.add(date);
    // Keyed on the transaction plaza: OS collects at entry, CS at exit, so this
    // column is where the trip was counted, once. (build_fact.mjs)
    const fk = `${date}\t${hour}\t${ex.canonical}\t${ex.direction ?? ""}\t${ex.role ?? ""}\t${ex.system ?? ""}\t${ex.status}`;
    const fa = fact.get(fk);
    if (fa) { fa[0] += c[0]; fa[1] += c[1]; fa[2] += c[2]; fa[3] += c[3]; } else fact.set(fk, [c[0], c[1], c[2], c[3]]);

    const en = resolve(String(row.entry_plaza_name ?? ""));
    if (!vkm.has(fk)) vkm.set(fk, [0, 0, 0]);
    const t = tripKm(entryCode, exitCode, en, ex);
    const plaza = fk.slice(fk.indexOf("\t", date.length + 1) + 1);
    for (let i = 0; i < 3; i++) {
      if (c[i] === 0) continue;
      if (t.kind === "unknown") {
        const u = unknownKm.get(fk);
        if (u) u[i] += c[i]; else { const n: Vkm = [0, 0, 0]; n[i] = c[i]; unknownKm.set(fk, n); }
      } else {
        addVkm(fk, i, c[i] * t.km);
        addKnown(plaza, i, c[i], t.km);
        addKnown("", i, c[i], t.km);
      }
    }

    if (en.status === "unresolved") { unplacedOrigins++; continue; }
    const name = en.canonical ?? en.base;
    const ok = `${date}\t${hour}\t${name}\t${en.direction ?? ""}\t${en.status}`;
    const oa = origin.get(ok);
    if (oa) { oa[0] += c[0]; oa[1] += c[1]; oa[2] += c[2]; oa[3] += c[3]; } else origin.set(ok, [c[0], c[1], c[2], c[3]]);
  }

  for (const [fk, trips] of unknownKm) {
    const plaza = knownKm.get(fk.slice(fk.indexOf("\t", fk.indexOf("\t") + 1) + 1));
    const all = knownKm.get("");
    for (let i = 0; i < 3; i++) {
      if (trips[i] === 0) continue;
      const k = plaza && plaza[1][i] > 0 ? plaza : all;
      if (k && k[1][i] > 0) addVkm(fk, i, trips[i] * (k[0][i] / k[1][i]));
    }
  }

  const ld = [...lateDates].sort();
  return {
    fact,
    origin,
    vkm,
    dates: [...dates].sort(),
    rowsAccepted: accepted,
    rowsRejected: heldBack.late + heldBack.offCorridorExit + heldBack.malformed,
    heldBack,
    unplacedOrigins,
    lateDates: ld.length ? { first: ld[0], last: ld[ld.length - 1], days: ld.length } : null,
    rejectedSample: [...samples.late, ...samples.offCorridorExit, ...samples.malformed],
    cutoff,
  };
}

export interface TollHourlyLoad {
  days: number;
  factRows: number;
  originRows: number;
  dailyRows: number;
  emissionRows: number;
  /** The Descriptive view; false with the reason in `errors` if its refresh failed. */
  viewRefreshed: boolean;
  /** The file against what is already loaded for the same plaza-hours. */
  comparison: UploadComparison | null;
  /** The committed load's undo journal (undo.ts). */
  undoBatch: number | null;
  committed: boolean;
  errors: string[];
  durationMs: number;
}

/* Rows go up as arrays, one parameter per column, so a batch is one statement
   no matter how many rows it carries. */
const BATCH = 20_000;
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Emissions per row: vehicle-km by class x each class's factor. Rows of trips paid off NLEX carry vehicle-km and no
 * vehicles, because those vehicles are not in the traffic record. A SELECT with `v` as gold.fact_vkm_hourly, so the
 * upload and scripts/build-vehicle-km.ts write the same thing.
 */
export const EMISSIONS_COLUMNS = "date, hour, exit_canonical, direction, class_1, class_2, class_3, total, vkm_1, vkm_2, vkm_3, co2_tonnes, co_kg, no2_kg, pm25_kg";
const byClass = (col: string) => `v.vkm_1 * f1.${col} + v.vkm_2 * f2.${col} + v.vkm_3 * f3.${col}`;
export const EMISSIONS_SELECT = `
  SELECT v.date, v.hour, v.exit_canonical, v.direction,
         COALESCE(t.class_1, 0), COALESCE(t.class_2, 0), COALESCE(t.class_3, 0), COALESCE(t.total, 0),
         v.vkm_1, v.vkm_2, v.vkm_3,
         (${byClass("co2_g_per_km")}) / 1e6, (${byClass("co_g_per_km")}) / 1e3, (${byClass("no2_g_per_km")}) / 1e3, (${byClass("pm25_g_per_km")}) / 1e3
    FROM gold.fact_vkm_hourly v
    LEFT JOIN gold.fact_traffic_hourly t
      ON t.date = v.date AND t.hour = v.hour AND t.exit_canonical = v.exit_canonical AND t.status = v.status
     AND COALESCE(t.direction, '') = COALESCE(v.direction, '') AND COALESCE(t.role, '') = COALESCE(v.role, '')
     AND COALESCE(t.toll_system, '') = COALESCE(v.toll_system, '')
   CROSS JOIN (SELECT * FROM bronze.nlex_emission_factors WHERE vehicle_class = 1) f1
   CROSS JOIN (SELECT * FROM bronze.nlex_emission_factors WHERE vehicle_class = 2) f2
   CROSS JOIN (SELECT * FROM bronze.nlex_emission_factors WHERE vehicle_class = 3) f3`;

/* Staged into temp tables first, then swapped in by key: delete exactly the
   plaza-hours the file holds, insert its figures for them. */
async function insertFact(c: PoolClient, entries: [string, Sums][]): Promise<number> {
  for (let i = 0; i < entries.length; i += BATCH) {
    const cols: unknown[][] = [[], [], [], [], [], [], [], [], [], [], []];
    for (const [k, s] of entries.slice(i, i + BATCH)) {
      const [date, hour, exit, direction, role, system, status] = k.split("\t");
      cols[0].push(date); cols[1].push(Number(hour)); cols[2].push(exit);
      cols[3].push(direction || null); cols[4].push(role || null); cols[5].push(system || null); cols[6].push(status);
      cols[7].push(r2(s[0])); cols[8].push(r2(s[1])); cols[9].push(r2(s[2])); cols[10].push(r2(s[3]));
    }
    await c.query(
      `INSERT INTO th_fact
         (date, hour, exit_canonical, direction, role, toll_system, status, class_1, class_2, class_3, total)
       SELECT * FROM unnest($1::date[], $2::smallint[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                            $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[])`,
      cols,
    );
  }
  return entries.length;
}

async function insertVkm(c: PoolClient, table: string, entries: [string, Vkm][]): Promise<number> {
  for (let i = 0; i < entries.length; i += BATCH) {
    const cols: unknown[][] = [[], [], [], [], [], [], [], [], [], []];
    for (const [k, v] of entries.slice(i, i + BATCH)) {
      const [date, hour, exit, direction, role, system, status] = k.split("\t");
      cols[0].push(date); cols[1].push(Number(hour)); cols[2].push(exit);
      cols[3].push(direction || null); cols[4].push(role || null); cols[5].push(system || null); cols[6].push(status);
      cols[7].push(r2(v[0])); cols[8].push(r2(v[1])); cols[9].push(r2(v[2]));
    }
    await c.query(
      `INSERT INTO ${table}
         (date, hour, exit_canonical, direction, role, toll_system, status, vkm_1, vkm_2, vkm_3)
       SELECT * FROM unnest($1::date[], $2::smallint[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                            $8::numeric[], $9::numeric[], $10::numeric[])`,
      cols,
    );
  }
  return entries.length;
}

async function insertOrigin(c: PoolClient, entries: [string, Sums][]): Promise<number> {
  for (let i = 0; i < entries.length; i += BATCH) {
    const cols: unknown[][] = [[], [], [], [], [], [], [], [], []];
    for (const [k, s] of entries.slice(i, i + BATCH)) {
      const [date, hour, entry, direction, status] = k.split("\t");
      cols[0].push(date); cols[1].push(Number(hour)); cols[2].push(entry); cols[3].push(direction || null); cols[4].push(status);
      cols[5].push(r2(s[0])); cols[6].push(r2(s[1])); cols[7].push(r2(s[2])); cols[8].push(r2(s[3]));
    }
    await c.query(
      `INSERT INTO th_origin
         (date, hour, entry_canonical, direction, status, class_1, class_2, class_3, total)
       SELECT * FROM unnest($1::date[], $2::smallint[], $3::text[], $4::text[], $5::text[],
                            $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[])`,
      cols,
    );
  }
  return entries.length;
}

/**
 * Write the aggregate, replacing the plaza-hours it covers, in one transaction:
 * every table moves together or none does. `dryRun` does all of it and rolls
 * back, which is how a load is rehearsed against the real warehouse.
 */
export { insertVkm };

export async function loadTollHourly(agg: TollHourlyAggregate, opts: { dryRun?: boolean; replaceDays?: boolean } = {}): Promise<TollHourlyLoad> {
  /* replaceDays: the file is a complete record of every day it covers (NLEX's own yearly export), so it
     replaces those days whole — every plaza-hour of them, not only the ones it holds. Replacing by plaza-hour
     alone left the old figure wherever the export has no row (a toll holiday, a quiet hour at a small plaza). */
  const whole = Boolean(opts.replaceDays);
  const t0 = Date.now();
  const out: TollHourlyLoad = {
    days: agg.dates.length, factRows: 0, originRows: 0, dailyRows: 0, emissionRows: 0,
    viewRefreshed: false, comparison: null, undoBatch: null, committed: false, errors: [], durationMs: 0,
  };
  if (!db) { out.errors.push("No database connection is configured."); return out; }
  if (agg.dates.length === 0) { out.errors.push("Nothing to load: no row passed the gates."); return out; }

  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const days = agg.dates;

    await c.query(`CREATE TEMP TABLE th_fact (LIKE gold.fact_traffic_hourly) ON COMMIT DROP`);
    await c.query(`CREATE TEMP TABLE th_origin (LIKE gold.fact_traffic_hourly_origin) ON COMMIT DROP`);
    out.factRows = await insertFact(c, [...agg.fact.entries()]);
    out.originRows = await insertOrigin(c, [...agg.origin.entries()]);
    await c.query(`CREATE TEMP TABLE th_vkm (LIKE gold.fact_vkm_hourly) ON COMMIT DROP`);
    await insertVkm(c, "th_vkm", [...agg.vkm.entries()]);

    // Before anything is replaced: how the file compares with what is loaded,
    // and the undo journal of every row about to change.
    out.comparison = await compareToll(c);
    const journal = await UndoJournal.open(c, "toll_hourly");
    if (whole) {
      for (const table of ["gold.fact_traffic_hourly", "gold.fact_traffic_hourly_origin", "gold.fact_vkm_hourly"]) {
        await journal.saveOld(table, DAY_KEY, `FROM ${table} t WHERE t.date = ANY($1::date[])`, [days]);
        await journal.saveNew(table, DAY_KEY, `SELECT unnest($1::date[]) AS date`, [days]);
      }
      await c.query(`DELETE FROM gold.fact_traffic_hourly WHERE date = ANY($1::date[])`, [days]);
      await c.query(`DELETE FROM gold.fact_traffic_hourly_origin WHERE date = ANY($1::date[])`, [days]);
      await c.query(`DELETE FROM gold.fact_vkm_hourly WHERE date = ANY($1::date[])`, [days]);
    } else {
    await journal.saveOld("gold.fact_traffic_hourly", FACT_KEY, `
      FROM gold.fact_traffic_hourly t JOIN th_fact k
        ON t.date = k.date AND t.hour = k.hour AND t.exit_canonical = k.exit_canonical AND t.status = k.status
       AND t.direction IS NOT DISTINCT FROM k.direction AND t.role IS NOT DISTINCT FROM k.role
       AND t.toll_system IS NOT DISTINCT FROM k.toll_system`);
    await journal.saveNew("gold.fact_traffic_hourly", FACT_KEY, `SELECT * FROM th_fact`);
    await journal.saveOld("gold.fact_traffic_hourly_origin", ORIGIN_KEY, `
      FROM gold.fact_traffic_hourly_origin t JOIN th_origin k
        ON t.date = k.date AND t.hour = k.hour AND t.entry_canonical = k.entry_canonical AND t.status = k.status
       AND t.direction IS NOT DISTINCT FROM k.direction`);
    await journal.saveNew("gold.fact_traffic_hourly_origin", ORIGIN_KEY, `SELECT * FROM th_origin`);
    await journal.saveOld("gold.fact_vkm_hourly", FACT_KEY, `
      FROM gold.fact_vkm_hourly t JOIN th_vkm k
        ON t.date = k.date AND t.hour = k.hour AND t.exit_canonical = k.exit_canonical AND t.status = k.status
       AND t.direction IS NOT DISTINCT FROM k.direction AND t.role IS NOT DISTINCT FROM k.role
       AND t.toll_system IS NOT DISTINCT FROM k.toll_system`);
    await journal.saveNew("gold.fact_vkm_hourly", FACT_KEY, `SELECT * FROM th_vkm`);
    }
    for (const table of ["gold.daily_traffic_volume_corrected", "gold.fact_emissions_hourly"]) {
      await journal.saveOld(table, DAY_KEY, `FROM ${table} t WHERE t.date = ANY($1::date[])`, [days]);
      await journal.saveNew(table, DAY_KEY, `SELECT unnest($1::date[]) AS date`, [days]);
    }

    await c.query(`
      DELETE FROM gold.fact_traffic_hourly f USING th_fact t
       WHERE f.date = t.date AND f.hour = t.hour AND f.exit_canonical = t.exit_canonical
         AND f.direction IS NOT DISTINCT FROM t.direction AND f.role IS NOT DISTINCT FROM t.role
         AND f.toll_system IS NOT DISTINCT FROM t.toll_system AND f.status = t.status`);
    await c.query(`INSERT INTO gold.fact_traffic_hourly SELECT * FROM th_fact`);
    await c.query(`
      DELETE FROM gold.fact_traffic_hourly_origin f USING th_origin t
       WHERE f.date = t.date AND f.hour = t.hour AND f.entry_canonical = t.entry_canonical
         AND f.direction IS NOT DISTINCT FROM t.direction AND f.status = t.status`);
    await c.query(`INSERT INTO gold.fact_traffic_hourly_origin SELECT * FROM th_origin`);
    await c.query(`
      DELETE FROM gold.fact_vkm_hourly f USING th_vkm t
       WHERE f.date = t.date AND f.hour = t.hour AND f.exit_canonical = t.exit_canonical
         AND f.direction IS NOT DISTINCT FROM t.direction AND f.role IS NOT DISTINCT FROM t.role
         AND f.toll_system IS NOT DISTINCT FROM t.toll_system AND f.status = t.status`);
    await c.query(`INSERT INTO gold.fact_vkm_hourly SELECT * FROM th_vkm`);

    // The daily series and CO2 are recomputed for every day the file touched,
    // from the whole fact table, so a partial file leaves them consistent.
    const daily = await c.query(
      `INSERT INTO gold.daily_traffic_volume_corrected (date, total_volume)
       SELECT date, ROUND(SUM(total))::bigint FROM gold.fact_traffic_hourly
        WHERE date = ANY($1::date[]) GROUP BY date
       ON CONFLICT (date) DO UPDATE SET total_volume = EXCLUDED.total_volume`,
      [days],
    );
    out.dailyRows = daily.rowCount ?? 0;

    // Emissions from the same rows' vehicle-km.
    await c.query(`DELETE FROM gold.fact_emissions_hourly WHERE date = ANY($1::date[])`, [days]);
    const em = await c.query(`INSERT INTO gold.fact_emissions_hourly (${EMISSIONS_COLUMNS}) ${EMISSIONS_SELECT} WHERE v.date = ANY($1::date[])`, [days]);
    out.emissionRows = em.rowCount ?? 0;
    await journal.close();

    if (opts.dryRun) {
      await c.query("ROLLBACK");
    } else {
      await c.query("COMMIT");
      out.committed = true;
      out.undoBatch = journal.batchId;
    }
  } catch (e: any) {
    await c.query("ROLLBACK").catch(() => {});
    out.errors.push(`Load rolled back, nothing was written: ${e.message}`);
    out.factRows = out.originRows = out.dailyRows = out.emissionRows = 0;
  } finally {
    c.release();
  }

  // Outside the transaction: the view is rebuilt from the committed fact rows.
  if (out.committed) {
    try {
      await db.query("REFRESH MATERIALIZED VIEW public.nlex_traffic_volume");
      await db.query("ANALYZE gold.fact_traffic_hourly");
      await db.query("ANALYZE gold.fact_traffic_hourly_origin");
      await db.query("ANALYZE gold.fact_vkm_hourly");
      out.viewRefreshed = true;
    } catch (e: any) {
      out.errors.push(`Loaded, but the Descriptive view did not refresh (run REFRESH MATERIALIZED VIEW public.nlex_traffic_volume): ${e.message}`);
    }
  }
  out.durationMs = Date.now() - t0;
  return out;
}
