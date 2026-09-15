if (process.env.ALLOW_MIGRATION !== "1") {
  console.error("One-off migration, already applied to the database. Re-running it can duplicate or undo changes. Set ALLOW_MIGRATION=1 to run it deliberately.");
  process.exit(1);
}
const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);
const f = (v) => Number(v).toLocaleString("en-US");

(async () => {
  const NOTE = "Toll plaza collecting for the SCTEX Spur Road, which is an interchange with no gate of its own (zero transactions in every dataset). Entry-side only. Determined by project owner 2026-09-01.";

  await p.query(
    `INSERT INTO gold.exit_name_map (source_name, canonical_exit, resolved, note, updated_at)
     VALUES ($1, $2, true, $3, now())
     ON CONFLICT (source_name) DO UPDATE
       SET canonical_exit = EXCLUDED.canonical_exit, note = EXCLUDED.note, updated_at = now()`,
    ["Mabiga", "SCTEX", NOTE]
  ).catch(async (e) => {
    // No unique constraint on source_name in this schema — fall back.
    if (!/no unique|constraint/i.test(e.message)) throw e;
    await p.query("DELETE FROM gold.exit_name_map WHERE source_name = $1", ["Mabiga"]);
    await p.query(
      `INSERT INTO gold.exit_name_map (source_name, canonical_exit, resolved, note, updated_at)
       VALUES ($1,$2,true,$3,now())`, ["Mabiga", "SCTEX", NOTE]);
  });

  const m = await p.query(
    "SELECT source_name, canonical_exit, note FROM gold.exit_name_map WHERE canonical_exit = 'SCTEX' ORDER BY source_name");
  console.log("Source names now mapping to SCTEX:");
  m.rows.forEach((r) => console.log(`  ${r.source_name.padEnd(20)} ${String(r.note).slice(0, 62)}`));

  const n = await p.query(
    "SELECT COUNT(DISTINCT canonical_exit)::int c FROM gold.exit_name_map WHERE canonical_exit IS NOT NULL");
  console.log(`\nDistinct canonical exits: ${n.rows[0].c}`);

  // What actually changes downstream: nothing, because the fact table keys on the
  // transaction (exit) column and Mabiga never appears there.
  const fx = await p.query(
    "SELECT COUNT(*)::int n FROM gold.fact_traffic_hourly WHERE exit_canonical IN ('SCTEX','Mabiga (SCTEX)')");
  const rec = await p.query(`
    WITH d AS (SELECT date, SUM(h00+h01+h02+h03+h04+h05+h06+h07+h08+h09+h10+h11+h12+h13+h14+h15+h16+h17+h18+h19+h20+h21+h22+h23) v
               FROM public.nlex_traffic_volume WHERE type='Entries' AND vehicle_class='Total' GROUP BY date)
    SELECT ROUND(AVG(d.v))::bigint davg, ROUND(AVG(g.total_volume))::bigint gavg
    FROM d JOIN gold.daily_traffic_volume_corrected g ON g.date = d.date`);
  const q = rec.rows[0];
  console.log(`\nfact_traffic_hourly rows for SCTEX/Mabiga: ${fx.rows[0].n}  (expected 0 — entry-side only)`);
  console.log(`Reconciliation unchanged: descriptive ${f(q.davg)} | predictive ${f(q.gavg)}  -> ${q.davg === q.gavg ? "MATCH" : "MISMATCH"}`);

  await p.end();
})();
