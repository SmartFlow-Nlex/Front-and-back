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
