if (process.env.ALLOW_MIGRATION !== "1") {
  console.error("One-off migration, already applied to the database. Re-running it can duplicate or undo changes. Set ALLOW_MIGRATION=1 to run it deliberately.");
  process.exit(1);
}
const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);
const f = (v) => Number(v).toLocaleString("en-US");

const RENAMES = [
  ["Sctex", "SCTEX"],
  ["Paso De Blas Valenzuela", "Paso de Blas Valenzuela"],
];

(async () => {
  const t = await p.query(
    "SELECT table_schema s, table_name t FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema IN ('bronze','silver','gold','public')");
  const base = new Set(t.rows.map((x) => `${x.s}.${x.t}`));
  const cols = await p.query(
    "SELECT table_schema s, table_name t, column_name c FROM information_schema.columns WHERE table_schema IN ('bronze','silver','gold','public') AND data_type IN ('text','character varying','character')");

  // Find every (table, column) holding any of the old values.
  const plan = [];
  for (const [oldV] of RENAMES) {
    for (const { s, t: tab, c } of cols.rows) {
      if (!base.has(`${s}.${tab}`)) continue;
      try {
        const r = await p.query(`SELECT COUNT(*)::int n FROM "${s}"."${tab}" WHERE "${c}" = $1`, [oldV]);
        if (r.rows[0].n > 0) plan.push({ s, t: tab, c, oldV, n: r.rows[0].n });
      } catch { /* skip */ }
    }
  }
  const total = plan.reduce((a, x) => a + x.n, 0);
  console.log(`Plan: ${f(total)} rows across ${plan.length} (table,column,value) targets\n`);

  const client = await p.connect();
  try {
    await client.query("BEGIN");
    for (const x of plan) {
      const newV = RENAMES.find(([o]) => o === x.oldV)[1];
      await client.query(`UPDATE "${x.s}"."${x.t}" SET "${x.c}" = $1 WHERE "${x.c}" = $2`, [newV, x.oldV]);
    }
    await client.query("COMMIT");
    console.log("Committed.");
  } catch (e) {
    await client.query("ROLLBACK");
    console.log("ROLLED BACK: " + e.message);
    client.release(); await p.end(); process.exit(1);
  }
  client.release();

  // Matviews do not follow their base tables — CDV taught us this.
  const mv = await p.query("SELECT schemaname s, matviewname m FROM pg_matviews");
  for (const { s, m } of mv.rows) {
    const t0 = Date.now();
    await p.query(`REFRESH MATERIALIZED VIEW "${s}"."${m}"`);
    console.log(`  refreshed ${s}.${m}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  console.log("\nVerification — old values remaining anywhere:");
  let leftover = 0;
  for (const [oldV, newV] of RENAMES) {
    let o = 0, n = 0;
    for (const { s, t: tab, c } of cols.rows) {
      try {
        o += (await p.query(`SELECT COUNT(*)::int n FROM "${s}"."${tab}" WHERE "${c}" = $1`, [oldV])).rows[0].n;
        n += (await p.query(`SELECT COUNT(*)::int n FROM "${s}"."${tab}" WHERE "${c}" = $1`, [newV])).rows[0].n;
      } catch { /* skip */ }
    }
    leftover += o;
    console.log(`  "${oldV}" -> "${newV}":  old ${o}  new ${f(n)}`);
  }
  console.log(leftover === 0 ? "  CLEAN" : "  !! leftovers remain");

  // Reconciliation must survive the rename.
  const sum = "h00+h01+h02+h03+h04+h05+h06+h07+h08+h09+h10+h11+h12+h13+h14+h15+h16+h17+h18+h19+h20+h21+h22+h23";
  const rec = await p.query(`
    WITH d AS (SELECT date, SUM(${sum}) v FROM public.nlex_traffic_volume
               WHERE type='Entries' AND vehicle_class='Total' GROUP BY date)
    SELECT ROUND(AVG(d.v))::bigint davg, ROUND(AVG(g.total_volume))::bigint gavg, COUNT(*)::int n
    FROM d JOIN gold.daily_traffic_volume_corrected g ON g.date = d.date`);
  const q = rec.rows[0];
  console.log(`\nReconciliation still holds: descriptive ${f(q.davg)} | predictive ${f(q.gavg)} over ${f(q.n)} days  ->  ${q.davg === q.gavg ? "MATCH" : "MISMATCH"}`);

  await p.end();
})();
