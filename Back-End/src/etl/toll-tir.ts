/**
 * NLEX's own hourly toll export — the layout the client delivered the actual 2022-2025 record in.
 *
 *   TrxDate,Trx_Hour,Entry_Plaza,Exit_Plaza,Bound,Class,Trx_Count
 *
 * One row per date x hour x entry plaza x exit plaza x class, plaza CODES only (the client: "I didn't put the
 * plaza names, you can infer them from the previous file"). A year is ~9.5 million rows and ~300 MB, so it is
 * read as a stream and summed straight into the same aggregate an nlex_traffic_hourly file makes
 * (toll-hourly.ts): nothing ever holds the whole file in memory, and from there on the load is exactly the
 * one every toll file gets — the same keys, the same four gold tables, the same undo journal.
 *
 * The client's rule (confirmed 2026-10-23, replacing the 2026-08-20 and 2026-10-19 answers): only Class 0 is
 * disregarded. Everything else is a real paid trip and is kept:
 *   - Entry plaza 0 (no entry recorded; at a barrier such as Balintawak 104, usually an RFID read), and
 *   - the same entry and exit plaza, at a barrier (the ordinary paid trip there) or anywhere else.
 * Both are counted, for the gate log, but no longer dropped. "No Ticket" (plaza 197) is kept, as before.
 *
 * And two of the record's own:
 *   - A file is one year. A handful of rows dated in the next year (12 to 52 per file, the last hour's
 *     stragglers) are held back: each plaza-hour a file holds REPLACES the warehouse's figure, so a few stray
 *     rows would overwrite that day's whole record with a sliver of it.
 *   - An exit code with no name (the SCTEX/TPLEX exits, 302/306/308) is not one of the 20 NLEX exits and is
 *     held back, as Lingunan always has been.
 *
 * Level adjustment (gold.toll_level_adjustment). The 2022-2024 files hold about three times the closed-system
 * traffic of 2025, uniformly at every exit, class, month and hour, and about three times the client's own
 * earlier daily figures for the same plaza pairs; 2025 matches both those and NLEX's published January 2025
 * counts. The client cannot re-extract those years (23 Oct 2026), so a row in the table scales the counts paid at
 * that plaza in that year and class to his own daily files' level (factors v2, 23 Oct 2026: every NLEX plaza where
 * trips are paid, barriers included now that entry-0 rows are kept), and the gate log says so. Delete the rows and load the file again to have
 * it exactly as delivered.
 */
import fs from "fs";
import { db } from "../config/db.js";
import type { RawRow } from "./parser.js";
import { aggregateTollHourly, loadCutoff, type Cutoff, type TollHourlyAggregate } from "./toll-hourly.js";
import { OTHER_EXPRESSWAY_PLAZAS } from "./trip-km.js";

export const TIR_COLUMNS = ["TrxDate", "Trx_Hour", "Entry_Plaza", "Exit_Plaza", "Bound", "Class", "Trx_Count"] as const;

/** Plaza code -> name: the earlier files' names (nlex_traffic_hourly_2026.csv, nlex_traffic_data_2022-2025.csv), plus the
    codes they never named, from the client's plaza reference (plaza_code_ref.csv, 23 Oct 2026). Those are SCTEX, SFEX
    and NLEX Connector plazas, not NLEX exits, so trips paid there stay held back; and Dau 168/173/174. */
export const PLAZA_CODES: Readonly<Record<number, string>> = {
  104: "Balintawak Barr NB (Entry OS)",
  108: "Valenzuela NB (Entry OS)",
  109: "Valenzuela SB (Entry OS)",
  110: "Meycauayan NB (Entry OS)",
  111: "Meycauayan SB (Entry OS)",
  114: "CDV NB (Exit CS)",
  116: "Marilao NB (Entry OS)",
  117: "Marilao SB (Entry OS)",
  120: "BOCAUE IC NB ENTRY",
  121: "Bocaue Barr SB (Entry OS)",
  123: "Bocaue Barr SB (Exit CS)",
  124: "CIUDAD DE VICTORIA NB ENTRY",
  125: "Bocaue IC SB (Exit CS)",
  128: "Bocaue IC NB (Exit CS)",
  131: "TABANG ENTRY",
  133: "Tabang NB (Exit CS)",
  136: "Sta Rita NB (Exit CS)",
  137: "SANTA RITA SB ENTRY",
  138: "SANTA RITA NB ENTRY",
  139: "Sta Rita SB (Exit CS)",
  141: "Karuhatan IC NB (Entry OS)",
  142: "Pulilan NB (Exit CS)",
  143: "PULILAN SB ENTRY",
  144: "PULILAN NB ENTRY",
  145: "Pulilan SB (Exit CS)",
  148: "San Simon NB (Exit CS)",
  149: "SAN SIMON SB ENTRY",
  150: "SAN SIMON NB ENTRY",
  151: "San Simon SB (Exit CS)",
  153: "Karuhatan IC SB (Entry OS)",
  156: "San Fernando NB (Exit CS)",
  157: "SAN FERNANDO SB ENTRY",
  158: "SAN FERNANDO NB ENTRY",
  159: "San Fernando SB (Exit CS)",
  160: "Mexico NB/SB (Exit CS)",
  162: "MEXICO ENTRY",
  163: "ANGELES ENTRY",
  164: "Angeles NB/SB (Exit CS)",
  167: "CDV SB (Entry OS)",
  168: "Dau Barrier (Exit CS)",  // client reference, 23 Oct 2026
  169: "DAU SB ENTRY",
  172: "Tambobong NB Exit",
  173: "Dau Inter NB",  // client reference, 23 Oct 2026
  174: "Dau Inter SB (Entry OS)",  // client reference, 23 Oct 2026
  175: "Lingunan SB (Entry OS)",
  176: "Dau NB (Exit OS)",
  177: "DAU NB ENTRY",
  178: "Dau SB (Exit OS)",
  179: "DAU SB ENTRY",
  181: "Mindanao (Entry OS)",
  183: "Karuhatan (Entry OS)",
  184: "TAMBUBONG NB ENTRY",
  186: "BALAGTAS ENTRY",
  187: "Balagtas (Exit CS)",
  189: "Sta Ines (Exit CS)",
  190: "STA INES ENTRY",
  192: "SFEX (Inbound)",  // client reference, 23 Oct 2026
  193: "SFEX (Outbound)",  // client reference, 23 Oct 2026
  195: "SFEX (OUTBOUND TIPO)",
  197: "No Ticket",
  199: "TAMBUBONG SB ENTRY",
  202: "Tipo Exit",  // client reference, 23 Oct 2026
  203: "TIPO ENTRY",
  213: "Dinalupihan Exit",  // client reference, 23 Oct 2026
  214: "DINALUPIHAN ENTRY",
  231: "Floridablanca Exit",  // client reference, 23 Oct 2026
  232: "FLORIDABLANCA ENTRY",
  245: "Porac Exit",  // client reference, 23 Oct 2026
  246: "PORAC ENTRY",
  247: "MABIGA SB ENTRY",
  248: "Mabiga SB Exit",  // client reference, 23 Oct 2026
  250: "Clark South A Exit",  // client reference, 23 Oct 2026
  251: "Clark South A Entry",  // client reference, 23 Oct 2026
  253: "Clark South B Exit",  // client reference, 23 Oct 2026
  254: "CLARK SOUTH B ENTRY",
  256: "Mabiga NB Exit",  // client reference, 23 Oct 2026
  257: "Mabiga NB Entry",  // client reference, 23 Oct 2026
  259: "Clark North Exit",  // client reference, 23 Oct 2026
  260: "CLARK NORTH B/ DMIA ENTRY",
  262: "Dolores Exit",  // client reference, 23 Oct 2026
  263: "Dolores Entry",  // client reference, 23 Oct 2026
  270: "Bamban Exit",  // client reference, 23 Oct 2026
  271: "NEW CLARK CITY INTERCHANGE ENTRY",
  273: "Concepcion Exit",  // client reference, 23 Oct 2026
  274: "CONCEPCION ENTRY",
  286: "San Miguel Exit",  // client reference, 23 Oct 2026
  287: "SAN MIGUEL ENTRY",
  289: "Luisita Exit",  // client reference, 23 Oct 2026
  290: "Luisita Entry",  // client reference, 23 Oct 2026
  292: "Tarlac Exit",  // client reference, 23 Oct 2026
  293: "TARLAC ENTRY",
  302: "R10 Interchange",  // client reference, 23 Oct 2026
  306: "España Main NB",  // client reference, 23 Oct 2026
  308: "España Main SB",  // client reference, 23 Oct 2026
};

/** Is this file the client's hourly export? Read from its first line only. */
export function isTirFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const first = buf.toString("utf8", 0, n).replace(/^﻿/, "").split(/\r?\n/)[0];
    const cols = first.split(",").map((c) => c.trim().replace(/^"|"$/g, "").toLowerCase());
    return TIR_COLUMNS.every((c) => cols.includes(c.toLowerCase()));
  } catch {
    return false;
  }
}

/** Every line of a large text file, read in chunks: the file is never held whole. */
function* lines(filePath: string): Generator<string> {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(8 * 1024 * 1024);
  let rest = "";
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const text = rest + buf.toString("utf8", 0, n);
      const parts = text.split("\n");
      rest = parts.pop() ?? "";
      for (const p of parts) yield p.endsWith("\r") ? p.slice(0, -1) : p;
    }
    if (rest) yield rest;
  } finally {
    fs.closeSync(fd);
  }
}

/** year -> "exitCode|class" -> factor */
export type LevelAdjustment = Map<number, Map<string, number>>;

/** The level adjustments on record (gold.toll_level_adjustment); none if the table does not exist. */
export async function readLevelAdjustment(): Promise<LevelAdjustment> {
  const out: LevelAdjustment = new Map();
  try {
    if (!db) return out;
    const r = await db.query<{ year: number; exit_plaza: number; class: number; factor: string }>(
      "SELECT year, exit_plaza, class, factor FROM gold.toll_level_adjustment",
    );
    for (const row of r.rows) {
      const y = Number(row.year);
      if (!out.has(y)) out.set(y, new Map());
      out.get(y)!.set(`${row.exit_plaza}|${row.class}`, Number(row.factor));
    }
  } catch {
    /* no table: nothing is adjusted */
  }
  return out;
}

export interface TirStats {
  lines: number;
  class0: number;
  badClass: number;
  entryZero: number;
  samePlaza: number;
  spill: number;
  spillYears: string[];
  /** Rows paid at an SCTEX/SFEX/Connector plaza, held back (see OTHER_EXPRESSWAY_PLAZAS). */
  otherExpressway: number;
  /** Trips (not rows) per rule, for the gate log: class0 and otherExpressway are not loaded; entryZero and samePlaza
      are kept and counted. */
  trips: { class0: number; entryZero: number; samePlaza: number; otherExpressway: number };
  /** The year the file covers. */
  year: string | null;
  /** Rows whose counts were scaled, the scaled trips before and after, and the range of factors used. */
  adjusted: { rows: number; before: number; after: number; minFactor: number; maxFactor: number } | null;
}

/**
 * Stream the file into the toll aggregate, applying the client's rules on the way. The aggregate is then
 * loaded by loadTollHourly exactly as any nlex_traffic_hourly file is.
 */
export function aggregateTir(filePath: string, adjust: LevelAdjustment, cutoff: Cutoff = loadCutoff()): { agg: TollHourlyAggregate; stats: TirStats } {
  const stats: TirStats = {
    lines: 0, class0: 0, badClass: 0, entryZero: 0, samePlaza: 0, otherExpressway: 0, spill: 0, spillYears: [], year: null,
    trips: { class0: 0, entryZero: 0, samePlaza: 0, otherExpressway: 0 }, adjusted: null,
  };
  const nameOf = (code: string): string => PLAZA_CODES[Number(code)] ?? "";

  // Which year the file is: counted on a first pass over the dates alone (cheap next to the aggregation).
  const perYear = new Map<string, number>();
  let header: string[] | null = null;
  for (const line of lines(filePath)) {
    if (!header) { header = line.replace(/^﻿/, "").split(",").map((c) => c.trim()); continue; }
    const y = line.slice(0, 4);
    if (/^\d{4}$/.test(y)) perYear.set(y, (perYear.get(y) ?? 0) + 1);
  }
  const year = [...perYear.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  stats.year = year;
  stats.spillYears = [...perYear.keys()].filter((y) => y !== year).sort();
  const yearAdjust = year ? adjust.get(Number(year)) : undefined;
  let adj = { rows: 0, before: 0, after: 0, minFactor: Infinity, maxFactor: -Infinity };
  // Trips by class before and after, for the trips the table has no factor for (below).
  const scaled = { before: [0, 0, 0], after: [0, 0, 0] };

  const ix = (name: string) => header!.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iDate = ix("TrxDate"), iHour = ix("Trx_Hour"), iEntry = ix("Entry_Plaza"), iExit = ix("Exit_Plaza"), iClass = ix("Class"), iCount = ix("Trx_Count");

  function* rows(): Generator<RawRow> {
    let first = true;
    for (const line of lines(filePath)) {
      if (first) { first = false; continue; }
      if (!line) continue;
      stats.lines++;
      const f = line.split(",");
      const date = f[iDate]?.trim() ?? "";
      if (year && date.slice(0, 4) !== year) { stats.spill++; continue; }
      const cls = f[iClass]?.trim() ?? "";
      let count = Number(f[iCount]);
      if (cls === "0") { stats.class0++; stats.trips.class0 += count || 0; continue; }
      if (cls !== "1" && cls !== "2" && cls !== "3") { stats.badClass++; continue; }
      const entry = (f[iEntry] ?? "").trim();
      const exit = (f[iExit] ?? "").trim();
      if (OTHER_EXPRESSWAY_PLAZAS.has(Number(exit))) {
        stats.otherExpressway++; stats.trips.otherExpressway += count || 0;
        // Held back from the traffic record; the aggregate takes only the km it drove on NLEX.
        yield {
          date, hour: f[iHour], exit_plaza: exit, entry_plaza: entry, exit_plaza_name: nameOf(exit), entry_plaza_name: nameOf(entry),
          class_1: cls === "1" ? count : 0, class_2: cls === "2" ? count : 0, class_3: cls === "3" ? count : 0, total: count, off_nlex: 1,
        } as RawRow;
        continue;
      }
      if (entry === "0") { stats.entryZero++; stats.trips.entryZero += count || 0; }
      else if (entry === exit) { stats.samePlaza++; stats.trips.samePlaza += count || 0; }
      const factor = yearAdjust?.get(`${exit}|${cls}`);
      if (factor !== undefined && Number.isFinite(count)) {
        scaled.before[Number(cls) - 1] += count;
        adj.rows++; adj.before += count; count = count * factor; adj.after += count;
        scaled.after[Number(cls) - 1] += count;
        if (factor < adj.minFactor) adj.minFactor = factor;
        if (factor > adj.maxFactor) adj.maxFactor = factor;
      }
      yield {
        date,
        hour: f[iHour],
        exit_plaza: exit,
        entry_plaza: entry,
        exit_plaza_name: nameOf(exit),
        entry_plaza_name: nameOf(entry),
        class_1: cls === "1" ? count : 0,
        class_2: cls === "2" ? count : 0,
        class_3: cls === "3" ? count : 0,
        total: count,
      } as RawRow;
    }
  }

  const agg = aggregateTollHourly(rows(), cutoff);
  if (adj.rows > 0) stats.adjusted = adj;
  /* The level adjustment has factors for NLEX plazas only. A trip paid off NLEX is scaled as that class was over the
     rest of the file, or its km would sit at the unscaled level beside scaled neighbours. */
  for (const [key, v] of agg.vkm) {
    if (!key.endsWith("\toff_nlex")) continue;
    for (let i = 0; i < 3; i++) if (scaled.before[i] > 0) v[i] *= scaled.after[i] / scaled.before[i];
  }
  return { agg, stats };
}
