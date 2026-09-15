const fs = require("fs");
const { Pool } = require("pg");
const copyFrom = require("pg-copy-streams").from;
const p = new Pool(require("../../config/db.cjs").poolConfig);
const TSV = require("path").join(__dirname, "../../_work") + "/fact_hourly.tsv";
const f = (v) => Number(v).toLocaleString("en-US");

(async () => {
  const c = await p.connect();
  try {
    await c.query(`DROP TABLE IF EXISTS gold.fact_traffic_hourly`);
    await c.query(`
      CREATE TABLE gold.fact_traffic_hourly (
        date            date        NOT NULL,
        hour            smallint    NOT NULL,
        exit_canonical  text        NOT NULL,
        direction       text,
        role            text,
        toll_system     text,
        status          text        NOT NULL,
        class_1         numeric(14,2),
        class_2         numeric(14,2),
        class_3         numeric(14,2),
        total           numeric(14,2)
      )`);
    await c.query(`COMMENT ON TABLE gold.fact_traffic_hourly IS
      'Hourly traffic by canonical exit, built from nlex_traffic_hourly_2022..2025.csv via the ETL canonical-exit resolver. One row per (date, hour, exit, direction, role, toll_system). Keyed on the TRANSACTION plaza: NLEX Open System collects at entry, Closed System at exit, so each source row is one tolled trip counted once.'`);

    console.log("COPY streaming...");
    const t0 = Date.now();
    await new Promise((res, rej) => {
      const stream = c.query(copyFrom(
        `COPY gold.fact_traffic_hourly (date,hour,exit_canonical,direction,role,toll_system,status,class_1,class_2,class_3,total) FROM STDIN WITH (FORMAT text, NULL '')`));
      const rs = fs.createReadStream(TSV);
      rs.on("error", rej); stream.on("error", rej); stream.on("finish", res);
      rs.pipe(stream);
    });
    console.log(`  loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    await c.query(`CREATE INDEX ix_fth_date ON gold.fact_traffic_hourly (date)`);
    await c.query(`CREATE INDEX ix_fth_exit ON gold.fact_traffic_hourly (exit_canonical)`);
    await c.query(`CREATE INDEX ix_fth_date_hour ON gold.fact_traffic_hourly (date, hour)`);
    await c.query(`ANALYZE gold.fact_traffic_hourly`);
    console.log("  indexes built");
  } finally { c.release(); }

  const n = await p.query(`SELECT COUNT(*)::bigint n, MIN(date)::text lo, MAX(date)::text hi,
    COUNT(DISTINCT exit_canonical)::int exits, COUNT(DISTINCT date)::int days FROM gold.fact_traffic_hourly`);
  const r = n.rows[0];
  console.log(`\nrows ${f(r.n)} | ${f(r.days)} days ${r.lo}..${r.hi} | ${r.exits} canonical exits`);

  const st = await p.query(`SELECT status, COUNT(*)::int n, ROUND(SUM(total))::bigint v FROM gold.fact_traffic_hourly GROUP BY 1 ORDER BY 3 DESC`);
  console.log("\nby status:");
  st.rows.forEach((x) => console.log(`  ${x.status.padEnd(12)} ${String(f(x.n)).padStart(9)} rows  ${f(x.v).padStart(14)} vehicles`));

  // The reconciliation that matters: does the fact table roll up to the daily series?
  const rec = await p.query(`
    WITH d AS (SELECT date, SUM(total) v FROM gold.fact_traffic_hourly GROUP BY date)
    SELECT COUNT(*)::int n,
           SUM(CASE WHEN ROUND(d.v) = ROUND(g.total_volume) THEN 1 ELSE 0 END)::int exact,
           ROUND(MAX(ABS(d.v - g.total_volume)),2) maxdiff,
           ROUND(AVG(d.v))::bigint davg, ROUND(AVG(g.total_volume))::bigint gavg
    FROM d JOIN gold.daily_traffic_volume_corrected g ON g.date = d.date`);
  const q = rec.rows[0];
  console.log(`\nRECONCILIATION vs gold.daily_traffic_volume_corrected:`);
  console.log(`  days compared    : ${f(q.n)}`);
  console.log(`  EXACT day matches: ${f(q.exact)} / ${f(q.n)}`);
  console.log(`  max abs diff     : ${q.maxdiff}`);
  console.log(`  fact avg ${f(q.davg)}  |  daily avg ${f(q.gavg)}`);

  await p.end();
})();
