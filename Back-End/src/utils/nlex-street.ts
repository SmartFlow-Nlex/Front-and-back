/* "On NLEX", as SQL, in one place.
 *
 * corridor_match only says a jam is near an exit, and near is not enough: the
 * local road network runs within metres of the corridor for most of its length.
 * A live sample had two jams at a dead stop on "Tulaoc", a barangay road 133 m
 * off the expressway, surfacing in the Corridor Overview as
 * "Slowest stretch: San Simon, avg speed 0 km/h" while the map beside it drew
 * San Simon green. The map was right. It applies this test; the overview did
 * not.
 *
 * This is isNlexCorridorStreet from the dashboard's lib/nlex-corridor.ts
 * written as SQL, because the aggregation happens in the query. The three
 * places that count jams share it so they cannot drift: corridor-status,
 * getLiveCorridorOverview, and the map feed itself.
 *
 * The exclusions are all roads Waze brands with the expressway's own name
 * while not being the mainline -- service roads, crossings, exit roads, the
 * spur roads, and the other tollways that connect to it.
 */
const EXCLUDED = [
  "service",
  "crossing",
  "exit rd",
  "halili",
  "dulalia",
  "tullahan",
  "libtong",
  "slex",
  "skyway",
  "sctex",
  "tplex",
  "cavitex",
] as const;

/**
 * A SQL boolean for "this row's street is the NLEX mainline".
 *
 * @param col the street column, qualified if the query aliases the table
 *            (`"j.street"`), bare otherwise (`"street"`).
 */
export function nlexStreetSql(col: string): string {
  const not = EXCLUDED.map((word) => `LOWER(${col}) NOT LIKE '%${word}%'`).join("\n           AND ");
  return `((LOWER(${col}) LIKE '%nlex%' OR LOWER(${col}) LIKE '%north luzon%')
           AND ${not})`;
}

/**
 * The corridor's live jams, deduplicated, as a CTE named `live_jams`.
 *
 * Waze re-issues a queue under a NEW jam_id when it briefly loses and
 * re-detects it, and the superseded row keeps its last_seen_at inside the
 * window. A 213 m queue below Bocaue was present twice, byte-identical
 * geometry, two ids, last seen 28 minutes apart -- so the map drew it twice,
 * the overview counted it twice, and neither was wrong about any single row.
 *
 * Deduplicated on the geometry itself, keeping the most recently seen row,
 * because that is what identifies a stretch of road; jam_id identifies a
 * Waze record, and the whole problem is that one queue had two of those.
 * ST_AsBinary rather than the geometry `=` operator: exact bytes, with no
 * dependence on how PostGIS decides two shapes are equal.
 *
 * Prepend to a query and select `FROM live_jams j` in place of the table.
 */
export function liveNlexJamsCte(windowMinutes: number): string {
  return `WITH live_jams AS (
    SELECT DISTINCT ON (ST_AsBinary(j.geom)) j.*
    FROM silver.fact_waze_jams j
    WHERE j.corridor_match IN ('ON_CORRIDOR', 'NEAR_CORRIDOR')
      AND j.last_seen_at > NOW() - interval '${windowMinutes} minutes'
      AND j.geom IS NOT NULL
      AND ${nlexStreetSql("j.street")}
    ORDER BY ST_AsBinary(j.geom), j.last_seen_at DESC
  )`;
}
