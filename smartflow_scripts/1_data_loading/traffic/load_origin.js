const fs = require("fs");
const { Pool } = require("pg");
const copyFrom = require("pg-copy-streams").from;
const p = new Pool(require("../../config/db.cjs").poolConfig);
const TSV = require("path").join(__dirname, "../../_work") + "/fact_origin.tsv";
const f = (v) => Number(v).toLocaleString("en-US");

(async () => {
  const c = await p.connect();
  try {
    await c.query("DROP TABLE IF EXISTS gold.fact_traffic_hourly_origin");
    await c.query(`
      CREATE TABLE gold.fact_traffic_hourly_origin (
        date            date     NOT NULL,
        hour            smallint NOT NULL,
        entry_canonical text     NOT NULL,
        direction       text,
        status          text     NOT NULL,
        class_1 numeric(14,2), class_2 numeric(14,2),
        class_3 numeric(14,2), total   numeric(14,2)
      )`);
    await c.query(`COMMENT ON TABLE gold.fact_traffic_hourly_origin IS
      'Origin side of the same trips in gold.fact_traffic_hourly, keyed on the ENTRY plaza. Exists because facilities that only ever appear as an origin (e.g. Mabiga, the SCTEX Spur Road collecting plaza) are invisible in the exit-keyed table. DO NOT sum alongside fact_traffic_hourly - the same trips appear in both, once by origin and once by transaction plaza. Volume totals come from fact_traffic_hourly.'`);

    console.log("COPY streaming...");
    const t0 = Date.now();
    await new Promise((res, rej) => {
      const st = c.query(copyFrom(
        `COPY gold.fact_traffic_hourly_origin (date,hour,entry_canonical,direction,status,class_1,class_2,class_3,total) FROM STDIN WITH (FORMAT text, NULL '')`));
      const rs = fs.createReadStream(TSV);
      rs.on("error", rej); st.on("error", rej); st.on("finish", res);
      rs.pipe(st);
    });
    console.log(`  loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await c.query("CREATE INDEX ix_fto_date ON gold.fact_traffic_hourly_origin (date)");
    await c.query("CREATE INDEX ix_fto_entry ON gold.fact_traffic_hourly_origin (entry_canonical)");
    await c.query("ANALYZE gold.fact_traffic_hourly_origin");
  } finally { c.release(); }

  const n = await p.query(
    "SELECT COUNT(*)::bigint n, COUNT(DISTINCT entry_canonical)::int origins, MIN(date)::text lo, MAX(date)::text hi FROM gold.fact_traffic_hourly_origin");
  const r = n.rows[0];
  console.log(`\nrows ${f(r.n)} | ${r.origins} distinct origins | ${r.lo}..${r.hi}`);

  const sc = await p.query(
    "SELECT ROUND(SUM(total))::bigint v, COUNT(*)::int rows FROM gold.fact_traffic_hourly_origin WHERE entry_canonical='SCTEX'");
  console.log(`\nSCTEX (via Mabiga): ${f(sc.rows[0].v)} trips across ${f(sc.rows[0].rows)} rows`);

  const st = await p.query(
    "SELECT status, COUNT(DISTINCT entry_canonical)::int names, ROUND(SUM(total))::bigint v FROM gold.fact_traffic_hourly_origin GROUP BY 1 ORDER BY 3 DESC");
  console.log("\nby status:");
  st.rows.forEach((x) => console.log(`  ${x.status.padEnd(12)} ${String(x.names).padStart(3)} names  ${f(x.v).padStart(14)} trips`));

  const nl = await p.query(
    "SELECT COUNT(DISTINCT entry_canonical)::int n FROM gold.fact_traffic_hourly_origin WHERE status='nlex'");
  console.log(`\nNLEX canonical exits represented on the origin side: ${nl.rows[0].n} of 20`);

  // Both tables must describe the same trips.
  const t = await p.query(`
    SELECT (SELECT ROUND(SUM(total)) FROM gold.fact_traffic_hourly)::bigint a,
           (SELECT ROUND(SUM(total)) FROM gold.fact_traffic_hourly_origin)::bigint b`);
  console.log(`\nTotal check: exit-keyed ${f(t.rows[0].a)} | origin-keyed ${f(t.rows[0].b)}  -> ${t.rows[0].a === t.rows[0].b ? "MATCH (same trips, two views)" : "MISMATCH"}`);

  await p.end();
})();
