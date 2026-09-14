/**
 * Builds the ph_holidays table from the validated Philippine holiday calendar.
 *
 * Replaces the old dim_holiday view, which inferred holidays from an is_holiday
 * flag inside the traffic data itself. That was circular and incomplete: 45
 * holidays across 2020-2026 had no name at all (they showed as "Other holiday"),
 * National Heroes Day was mistyped as Special, and several years were missing
 * holidays entirely.
 *
 * Usage:  npm run seed-holidays              (2020-2026)
 *         npm run seed-holidays -- 2020 2030 (explicit range)
 *
 * Safe to re-run — it upserts by date and reports what changed.
 */
import { Pool } from "pg";
import { env } from "../src/config/env.js";
import { buildPhHolidays, reconcileWithObserved } from "../src/data/ph-holidays.js";

const args = process.argv.slice(2).filter((a) => /^\d{4}$/.test(a));
const fromYear = args[0] ? Number(args[0]) : 2020;
const toYear = args[1] ? Number(args[1]) : 2026;

if (!env.POSTGRES_URL) {
  console.error("No database configured — set POSTGRES_URL or PG_* in Back-End/.env");
  process.exit(1);
}

const db = new Pool({
  connectionString: env.POSTGRES_URL,
  ssl: env.PG_SSL_MODE === "disable" ? undefined : { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

async function main() {
  const calendar = buildPhHolidays(fromYear, toYear);
  console.log(`Rule calendar: ${calendar.length} holidays for ${fromYear}-${toYear}`);

  const client = await db.connect();
  try {
    // The toll data records which days were actually non-working. Use it to pick
    // up "holiday economics" moves that no rule-based library can know about.
    const obs = await client.query(
      `SELECT date_day::text AS d FROM dim_holiday WHERE is_holiday ORDER BY 1`
    );
    const observed = obs.rows.map((r) => r.d);
    console.log(`Observed non-working days in source data: ${observed.length}`);

    const rec = reconcileWithObserved(calendar, observed);
    const holidays = rec.holidays;

    if (rec.moved.length > 0) {
      console.log(`\nRe-dated ${rec.moved.length} holiday(s) onto the day actually observed:`);
      for (const m of rec.moved) console.log(`   ${m.from} -> ${m.to}  ${m.name}`);
    }
    if (rec.notObserved.length > 0) {
      console.log(`\nIn the calendar but never observed as non-working (${rec.notObserved.length}):`);
      for (const n of rec.notObserved) console.log(`   ${n.date}  ${n.name}`);
    }
    if (rec.unexplained.length > 0) {
      console.log(`\nObserved as non-working but unnamed (${rec.unexplained.length}) — add to PROCLAIMED_OVERRIDES:`);
      for (const u of rec.unexplained) console.log(`   ${u}`);
    }
    console.log();

    await client.query(`
      CREATE TABLE IF NOT EXISTS ph_holidays (
        date_day     DATE PRIMARY KEY,
        holiday_name TEXT NOT NULL,
        holiday_type TEXT NOT NULL CHECK (holiday_type IN ('Regular', 'Special')),
        source       TEXT NOT NULL,
        note         TEXT,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS ix_ph_holidays_type ON ph_holidays (holiday_type)`
    );

    const before = (await client.query("SELECT COUNT(*)::int n FROM ph_holidays")).rows[0].n;

    await client.query("BEGIN");

    // Clear the year range first. A plain upsert is not enough: when a holiday
    // is re-dated by a "holiday economics" move, the row at its old nominal
    // date has to go, or the year ends up with both.
    await client.query(
      `DELETE FROM ph_holidays WHERE EXTRACT(year FROM date_day) BETWEEN $1 AND $2`,
      [fromYear, toYear]
    );

    for (const h of holidays) {
      await client.query(
        `INSERT INTO ph_holidays (date_day, holiday_name, holiday_type, source, note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (date_day) DO UPDATE
           SET holiday_name = EXCLUDED.holiday_name,
               holiday_type = EXCLUDED.holiday_type,
               source       = EXCLUDED.source,
               note         = EXCLUDED.note,
               generated_at = now()`,
        [h.date, h.name, h.type, h.source, h.note ?? null]
      );
    }
    await client.query("COMMIT");

    const after = (await client.query("SELECT COUNT(*)::int n FROM ph_holidays")).rows[0].n;
    console.log(`ph_holidays: ${before} -> ${after} rows\n`);

    const byYear = await client.query(`
      SELECT EXTRACT(year FROM date_day)::int AS yr,
             COUNT(*) FILTER (WHERE holiday_type='Regular')::int AS regular,
             COUNT(*) FILTER (WHERE holiday_type='Special')::int AS special,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE source='proclamation')::int AS proclaimed
      FROM ph_holidays GROUP BY 1 ORDER BY 1`);
    console.table(byYear.rows);

    const unnamed = await client.query(
      `SELECT COUNT(*)::int n FROM ph_holidays WHERE holiday_name IN ('Other holiday','') OR holiday_name IS NULL`
    );
    console.log(`Unnamed holidays: ${unnamed.rows[0].n} (the old dim_holiday view had 45)`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await db.end();
  }
}

main().catch((err) => {
  console.error("seed-holidays failed:", err.message);
  process.exit(1);
});
