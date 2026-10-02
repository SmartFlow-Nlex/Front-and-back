/**
 * Canonical Exit Resolver — Transform Layer / Data Cleaning Engine (Standardization)
 *
 * Toll-plaza names arrive from the source in many shapes for the same physical
 * facility. Observed across the 2022–2025 hourly extracts (98 distinct strings):
 *
 *   "Meycauayan SB (Entry OS)"  "MEYCAUAYAN NB (ENTRY OS)"   case differs
 *   "TAMBOBONG NB "             "TAMBUBONG NB ENTRY"          spelling + trailing space
 *   "SANTA RITA NB ENTRY"       "Sta Rita NB (Exit CS)"       long/short form
 *   "CIUDAD DE VICTORIA SB"     "CDV SB (Entry OS)"           expansion vs abbreviation
 *
 * Left alone these fragment one exit into several, which quietly breaks any
 * per-exit aggregate. This module reduces every variant to a single canonical
 * exit and, separately, reports the direction and toll-system role that were
 * embedded in the string.
 *
 * ── On OS vs CS ───────────────────────────────────────────────────────────────
 * NLEX runs two toll systems. Open System (OS) plazas collect at the barrier, so
 * the transaction is recorded at the ENTRY plaza. Closed System (CS) plazas issue
 * a ticket at entry and collect at the EXIT. That is why a name like
 * "Meycauayan SB (Entry OS)" legitimately appears in the exit_plaza column — it
 * is the transaction point, not a data error. Each source row is therefore ONE
 * tolled trip counted once, which is what makes SUM(total) a true trip count and
 * avoids the entry/exit double-counting the previous dataset suffered from.
 *
 * ── On connecting expressways ─────────────────────────────────────────────────
 * The entry side also carries facilities that are NOT NLEX exits — Tarlac,
 * Concepcion, Bamban, Clark, Dinalupihan, Tipo, SFEX, Floridablanca, Porac,
 * San Miguel, Mabiga, New Clark City. These are SCTEX/TPLEX origins for vehicles
 * that then exit on NLEX. The trip IS NLEX traffic and must be kept; only the
 * ORIGIN lies off-corridor. They are classified "connecting" rather than
 * rejected, so the corridor filter cannot silently delete real volume.
 *
 * Nothing here guesses. An unrecognised name resolves to `null` with
 * `status: "unresolved"` so it surfaces in the gate log instead of being dropped.
 */

export type PlazaRole = "Entry" | "Exit" | null;
export type TollSystem = "OS" | "CS" | null;
export type Direction = "NB" | "SB" | "NB/SB" | null;

export type ResolveStatus =
  | "nlex"          // resolved to one of the 20 canonical NLEX exits
  | "connecting"    // valid trip origin on a connecting expressway (SCTEX/TPLEX/SFEX)
  | "no_ticket"     // source's own "No Ticket" category — a real bucket, not a null
  | "unresolved";   // unknown; surfaced, never silently dropped

export interface ResolvedPlaza {
  raw: string;
  base: string;            // name with direction/role/system stripped
  canonical: string | null; // canonical NLEX exit, or the facility name when connecting
  direction: Direction;
  role: PlazaRole;
  system: TollSystem;
  status: ResolveStatus;
}

/**
 * Source spelling -> canonical NLEX exit.
 *
 * Keys are UPPERCASE and whitespace-collapsed; see `normalize()`. Values match
 * gold.exit_name_map.canonical_exit exactly, so the warehouse and the ETL cannot
 * drift apart. Every entry below was observed in the 2022–2025 files.
 */
const NLEX_ALIASES: Record<string, string> = {
  // straightforward
  ANGELES: "Angeles",
  BALAGTAS: "Balagtas",
  MARILAO: "Marilao",
  MEXICO: "Mexico",
  PULILAN: "Pulilan",
  DAU: "Dau",
  "SAN FERNANDO": "San Fernando",
  "SAN SIMON": "San Simon",

  // spelling / long-form variants
  MEYCAUAYAN: "Meycauayan",
  MEYCAUYAN: "Meycauayan",
  TAMBOBONG: "Tambubong",
  TAMBUBONG: "Tambubong",
  "STA RITA": "Sta. Rita Guiguinto",
  "SANTA RITA": "Sta. Rita Guiguinto",
  "STA. RITA": "Sta. Rita Guiguinto",
  "STA INES": "Sta. Ines",
  "SANTA INES": "Sta. Ines",
  "STA. INES": "Sta. Ines",
  TABANG: "Tabang Guiguinto",
  "TABANG SPUR ROAD": "Tabang Guiguinto",

  // abbreviation / expansion
  CDV: "CDV/PH Arena",
  "CIUDAD DE VICTORIA": "CDV/PH Arena",
  VALENZUELA: "Paso de Blas Valenzuela",
  "PASO DE BLAS": "Paso de Blas Valenzuela",

  // multi-word facilities
  "BALINTAWAK BARRIER": "Balintawak",
  "BALINTAWAK BARR": "Balintawak",
  BALINTAWAK: "Balintawak",
  "BOCAUE BARRIER": "Bocaue Barrier",
  "BOCAUE BARR": "Bocaue Barrier",
  "BOCAUE IC": "Bocaue Interchange",
  "BOCAUE INTERCHANGE": "Bocaue Interchange",
  SCTEX: "SCTEX",
  "SCTEX SPUR ROAD": "SCTEX",
  // The SCTEX Spur Road is an interchange with no toll gate of its own, which is
  // why "Sctex"/"SCTEX Spur Road" has zero transactions in every dataset we hold.
  // Mabiga is the plaza that actually collects for that connection, so its rows
  // ARE the SCTEX exit's data. Determined by the project owner 2026-09-01 from
  // the NLEX Exits reference; not inferable from the extracts alone.
  //
  // NOTE: Mabiga appears only as an ENTRY (0 rows in the transaction/exit column
  // across all four years), so this makes SCTEX visible as an ORIGIN. It does not
  // create exit-side transactions, and it changes no volume total — those trips
  // are already counted at the NLEX exit where they were tolled.
  MABIGA: "SCTEX",

  // Harbor Link facilities — confirmed by project owner 2026-08-29
  MINDANAO: "NLEX Harbor Link",
  KARUHATAN: "NLEX Harbor Link",
  "KARUHATAN IC": "NLEX Harbor Link",
  R10: "NLEX Harbor Link",
  CALOOCAN: "NLEX Harbor Link",
  "MACARTHUR RAMP ON": "NLEX Harbor Link",
  "MACARTHUR RAMP OFF": "NLEX Harbor Link",
  "NLEX HARBOR LINK": "NLEX Harbor Link",
};

/**
 * Off-corridor origins on connecting expressways. Kept, not rejected: the trip
 * exits on NLEX and is genuine NLEX volume — only the origin is elsewhere.
 */
const CONNECTING: Record<string, string> = {
  BAMBAN: "Bamban (SCTEX)",
  "CLARK NORTH B/ DMIA": "Clark North / DMIA (SCTEX)",
  "CLARK NORTH B / DMIA": "Clark North / DMIA (SCTEX)",
  "CLARK NORTH B/DMIA": "Clark North / DMIA (SCTEX)",
  "CLARK SOUTH B": "Clark South (SCTEX)",
  CONCEPCION: "Concepcion (SCTEX)",
  DINALUPIHAN: "Dinalupihan (SCTEX)",
  FLORIDABLANCA: "Floridablanca (SCTEX)",
  "NEW CLARK CITY INTERCHANGE": "New Clark City (SCTEX)",
  PORAC: "Porac (SCTEX)",
  "SAN MIGUEL": "San Miguel (TPLEX)",
  TARLAC: "Tarlac (TPLEX)",
  TIPO: "Tipo (SCTEX)",
  SFEX: "SFEX (Subic Freeport)",
  "SFEX (OUTBOUND TIPO)": "SFEX (Subic Freeport)",
};

/** Collapse case and whitespace so "TAMBOBONG NB " and "Tambobong NB" agree. */
function normalize(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toUpperCase();
}

/** Pull "(Entry OS)" / "(Exit CS)" / a trailing ENTRY|EXIT off the name. */
function extractRole(s: string): { rest: string; role: PlazaRole; system: TollSystem } {
  let role: PlazaRole = null;
  let system: TollSystem = null;

  const paren = s.match(/\((ENTRY|EXIT)\s*(OS|CS)?\)/);
  if (paren) {
    role = paren[1] === "ENTRY" ? "Entry" : "Exit";
    system = (paren[2] as TollSystem) ?? null;
    s = s.replace(paren[0], " ");
  }

  // Bare trailing "ENTRY"/"EXIT" with no parentheses, e.g. "DAU NB ENTRY".
  const trailing = s.match(/\b(ENTRY|EXIT)\s*$/);
  if (trailing) {
    if (!role) role = trailing[1] === "ENTRY" ? "Entry" : "Exit";
    s = s.replace(trailing[0], " ");
  }

  return { rest: s.replace(/\s+/g, " ").trim(), role, system };
}

/** Pull NB / SB / NB/SB out of the name. */
function extractDirection(s: string): { rest: string; direction: Direction } {
  const m = s.match(/\b(NB\s*\/\s*SB|SB\s*\/\s*NB|NB|SB)\b/);
  if (!m) return { rest: s, direction: null };
  const raw = m[1].replace(/\s+/g, "");
  const direction: Direction = raw === "NB" || raw === "SB" ? raw : "NB/SB";
  return { rest: s.replace(m[0], " ").replace(/\s+/g, " ").trim(), direction };
}

/**
 * Resolve one raw plaza string.
 *
 * Order matters: role and direction come off first, because they are the tokens
 * that fragment an otherwise-identical name. Whatever remains is the facility.
 */
export function resolvePlaza(raw: string | null | undefined): ResolvedPlaza {
  const rawStr = (raw ?? "").toString();
  const norm = normalize(rawStr);

  const empty: ResolvedPlaza = {
    raw: rawStr, base: "", canonical: null,
    direction: null, role: null, system: null, status: "unresolved",
  };
  if (!norm) return empty;

  // The source's own "no ticket issued" bucket. A real category — the trip
  // happened — so it is labelled rather than treated as a parse failure.
  if (norm === "NO TICKET") {
    return { ...empty, base: "NO TICKET", canonical: "No Ticket", status: "no_ticket" };
  }

  const r = extractRole(norm);
  const d = extractDirection(r.rest);
  const base = d.rest.replace(/\s+/g, " ").trim();

  const common = { raw: rawStr, base, direction: d.direction, role: r.role, system: r.system };

  const nlex = NLEX_ALIASES[base];
  if (nlex) return { ...common, canonical: nlex, status: "nlex" };

  const conn = CONNECTING[base];
  if (conn) return { ...common, canonical: conn, status: "connecting" };

  return { ...common, canonical: null, status: "unresolved" };
}

/** The 20 canonical NLEX exits this resolver can produce. */
export function canonicalExits(): string[] {
  return Array.from(new Set(Object.values(NLEX_ALIASES))).sort();
}
