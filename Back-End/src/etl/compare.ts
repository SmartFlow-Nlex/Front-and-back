/**
 * "Is this the right file?" — how an upload compares with what the warehouse
 * already holds for the same keys, measured inside the load's transaction
 * before anything is replaced, so a check shows it too.
 */
import type { PoolClient } from "pg";

export type UploadComparison =
  | {
      kind: "toll";
      /** Plaza-days in the file, and how many of them are already loaded. */
      plazaDays: number;
      replaced: number;
      /** Over the plaza-hours already loaded: their total now, and in the file. */
      loadedTotal: number;
      fileTotal: number;
      threshold: number;
      /** Plaza-days whose total moves by more than `threshold`, the largest first. */
      flagged: number;
      examples: { date: string; plaza: string; loaded: number; file: number }[];
    }
  | {
      kind: "records";
      /** Records the file holds that are already loaded, and how many of them it would change. */
      matched: number;
      changed: number;
    };

/** A replaced plaza-day whose total moves more than this is flagged. */
export const DIFF_THRESHOLD = 0.25;
/** Below this many vehicles a plaza-day's percentage swings are noise, not a wrong file. */
const MIN_VOLUME = 200;

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** Compares the staged toll file (temp table th_fact) with gold.fact_traffic_hourly, plaza by day. */
export async function compareToll(c: PoolClient): Promise<UploadComparison> {
  const r = await c.query(`
    SELECT k.date::text AS date, k.exit_canonical AS plaza,
           COUNT(f.date)::int AS matched,
           COALESCE(SUM(k.total) FILTER (WHERE f.date IS NOT NULL), 0)::float8 AS file,
           COALESCE(SUM(f.total), 0)::float8 AS loaded
      FROM th_fact k
      LEFT JOIN gold.fact_traffic_hourly f
        ON f.date = k.date AND f.hour = k.hour AND f.exit_canonical = k.exit_canonical AND f.status = k.status
       AND f.direction IS NOT DISTINCT FROM k.direction AND f.role IS NOT DISTINCT FROM k.role
       AND f.toll_system IS NOT DISTINCT FROM k.toll_system
     GROUP BY 1, 2`);
  const rows = r.rows as { date: string; plaza: string; matched: number; file: number; loaded: number }[];
  const replaced = rows.filter((x) => x.matched > 0);
  const move = (x: { file: number; loaded: number }) => Math.abs(x.file - x.loaded) / x.loaded;
  const flagged = replaced
    .filter((x) => x.loaded >= MIN_VOLUME && move(x) > DIFF_THRESHOLD)
    .sort((a, b) => move(b) - move(a));
  return {
    kind: "toll",
    plazaDays: rows.length,
    replaced: replaced.length,
    loadedTotal: Math.round(replaced.reduce((s, x) => s + x.loaded, 0)),
    fileTotal: Math.round(replaced.reduce((s, x) => s + x.file, 0)),
    threshold: DIFF_THRESHOLD,
    flagged: flagged.length,
    examples: flagged.slice(0, 5).map((x) => ({ date: x.date, plaza: x.plaza, loaded: Math.round(x.loaded), file: Math.round(x.file) })),
  };
}

/**
 * For an upsert by `key` (the event logs): how many staged records (temp table
 * etl_upload) are already loaded, and how many of those differ in any column.
 * Compared as text, so a column type without an equality operator cannot stop
 * the load; and in a savepoint, so a comparison that fails is just left out.
 */
export async function compareRecords(c: PoolClient, table: string, key: string, columns: string[]): Promise<UploadComparison | null> {
  const cols = columns.filter((col) => col !== key);
  if (cols.length === 0) return null;
  await c.query("SAVEPOINT compare");
  try {
    const r = await c.query(`
      SELECT COUNT(*)::int AS matched,
             COUNT(*) FILTER (WHERE (${cols.map((col) => `t.${q(col)}::text`).join(", ")})
                       IS DISTINCT FROM (${cols.map((col) => `u.${q(col)}::text`).join(", ")}))::int AS changed
        FROM ${table} t
        JOIN (SELECT DISTINCT ON (${q(key)}) * FROM etl_upload ORDER BY ${q(key)}, __n DESC) u ON t.${q(key)} = u.${q(key)}`);
    await c.query("RELEASE SAVEPOINT compare");
    return { kind: "records", matched: r.rows[0].matched, changed: r.rows[0].changed };
  } catch {
    await c.query("ROLLBACK TO SAVEPOINT compare");
    return null;
  }
}
