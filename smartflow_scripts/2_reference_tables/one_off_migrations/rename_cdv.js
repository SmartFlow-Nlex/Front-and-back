if (process.env.ALLOW_MIGRATION !== "1") {
  console.error("One-off migration, already applied to the database. Re-running it can duplicate or undo changes. Set ALLOW_MIGRATION=1 to run it deliberately.");
  process.exit(1);
}
const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);

const OLD = "Cdv/Ph Arena";
const NEW = "CDV/PH Arena";
const APPLY = process.argv.includes("--apply");

(async () => {
  // Only BASE TABLEs. Views derive from them and cannot be updated directly.
  const t = await p.query(
    "SELECT table_schema s, table_name t FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema IN ('bronze','silver','gold','public')"
  );
  const isBase = new Set(t.rows.map((x) => `${x.s}.${x.t}`));

  const cols = await p.query(`
    SELECT table_schema s, table_name t, column_name c
    FROM information_schema.columns
    WHERE table_schema IN ('bronze','silver','gold','public')
      AND data_type IN ('text','character varying','character')
    ORDER BY 1,2,3`);

  const hits = [];
  for (const { s, t: tab, c } of cols.rows) {
    if (!isBase.has(`${s}.${tab}`)) continue;
    try {
      const r = await p.query(`SELECT COUNT(*)::int n FROM "${s}"."${tab}" WHERE "${c}" = $1`, [OLD]);
      if (r.rows[0].n > 0) hits.push({ s, t: tab, c, n: r.rows[0].n });
    } catch { /* skip */ }
  }

  const total = hits.reduce((a, h) => a + h.n, 0);
  console.log(`Base-table rows holding "${OLD}": ${total.toLocaleString()} across ${hits.length} columns`);
  hits.forEach((h) => console.log(`  ${h.s}.${h.t}.${h.c}  ${h.n.toLocaleString()}`));

  if (!APPLY) { console.log("\n(dry run)"); await p.end(); return; }

  const client = await p.connect();
  try {
    await client.query("BEGIN");
    for (const h of hits) {
      await client.query(`UPDATE "${h.s}"."${h.t}" SET "${h.c}" = $1 WHERE "${h.c}" = $2`, [NEW, OLD]);
    }
    await client.query("COMMIT");
    console.log("\nCommitted.");
  } catch (e) {
    await client.query("ROLLBACK");
    console.log("\nROLLED BACK: " + e.message);
    client.release(); await p.end(); process.exit(1);
  }
  client.release();

  let leftover = 0, renamed = 0;
  for (const h of hits) {
    leftover += (await p.query(`SELECT COUNT(*)::int n FROM "${h.s}"."${h.t}" WHERE "${h.c}" = $1`, [OLD])).rows[0].n;
    renamed += (await p.query(`SELECT COUNT(*)::int n FROM "${h.s}"."${h.t}" WHERE "${h.c}" = $1`, [NEW])).rows[0].n;
  }
  console.log(`Verification: "${NEW}" = ${renamed.toLocaleString()} rows | "${OLD}" remaining = ${leftover}`);

  const v = await p.query("SELECT COUNT(*)::int n FROM public.v_nlex_galaxy_hourly WHERE start_node = $1", [NEW]);
  console.log(`View v_nlex_galaxy_hourly picked up rename: ${v.rows[0].n.toLocaleString()} rows`);

  const n = await p.query("SELECT COUNT(DISTINCT canonical_exit)::int c FROM gold.exit_name_map WHERE canonical_exit IS NOT NULL");
  console.log(`Distinct canonical exits: ${n.rows[0].c}`);
  await p.end();
})();
