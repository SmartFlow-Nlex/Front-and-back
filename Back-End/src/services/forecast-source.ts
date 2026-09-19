/* Which table the congestion forecast is read from.
 *
 * gold.ml_predictive_congestion is shared. Four people develop this system at
 * once and every checkout of train_congestion_horizon.py writes that table,
 * each starting with DELETE FROM. Checkouts older than "Congestion map: a day
 * and a week ahead" still carry HORIZONS = range(1, 13), so when one of those
 * runs it replaces a full week of forecast with twelve hours -- seen at 12:00
 * holding base_ts 11:00 on a day this machine had not run since 06:00. The
 * horizon picker reads the coverage back and disables any range the data
 * cannot reach, so the 24-hour and 7-day options came and went by the hour.
 *
 * gold.ml_congestion_forecast holds the same rows but is written only by the
 * horizon-capable trainer, so it keeps the full week. Prefer it.
 *
 * The fallback matters: until that trainer has run once the new table is empty
 * or absent, and on a teammate's machine running only the old pipeline it may
 * stay that way. Falling back to the shared table means they still see a
 * forecast rather than an empty map.
 */
import type { Pool } from "pg";

export const SHARED_TABLE = "gold.ml_predictive_congestion";
export const OWNED_TABLE = "gold.ml_congestion_forecast";

/* A closed set of two compile-time constants. These are interpolated into SQL,
   so nothing else may ever be returned from here. */
export type ForecastTable = typeof SHARED_TABLE | typeof OWNED_TABLE;

let cache: { at: number; table: ForecastTable } | null = null;
const TTL_MS = 60_000;

/** Re-checked once a minute: the owned table appears the first time the
 *  horizon-capable trainer runs, and should be picked up without a restart. */
export async function forecastTable(db: Pool | null): Promise<ForecastTable> {
  if (!db) return SHARED_TABLE;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.table;

  let table: ForecastTable = SHARED_TABLE;
  try {
    // to_regclass returns null rather than throwing when the table is absent,
    // so a missing table and an empty one take the same path.
    const { rows } = await db.query(
      `SELECT CASE WHEN to_regclass('${OWNED_TABLE}') IS NULL THEN 0
                   ELSE (SELECT COUNT(*) FROM ${OWNED_TABLE}) END::int AS n`,
    );
    if (Number(rows[0]?.n ?? 0) > 0) table = OWNED_TABLE;
  } catch {
    // Leave it on the shared table; a read failure here must not take the
    // forecast down with it.
  }
  cache = { at: Date.now(), table };
  return table;
}

/** For tests and for the retrain hook, so a fresh table is seen at once. */
export function resetForecastSourceCache(): void {
  cache = null;
}
