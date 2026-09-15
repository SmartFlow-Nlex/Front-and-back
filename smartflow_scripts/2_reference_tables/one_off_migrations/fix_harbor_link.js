if (process.env.ALLOW_MIGRATION !== "1") {
  console.error("One-off migration, already applied to the database. Re-running it can duplicate or undo changes. Set ALLOW_MIGRATION=1 to run it deliberately.");
  process.exit(1);
}
const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);

(async () => {
  const sel = "SELECT source_name, canonical_exit, note FROM gold.exit_name_map WHERE source_name IN ('Mindanao','Karuhatan')";
  console.log("BEFORE:");
  console.table((await p.query(sel)).rows);

  await p.query(
    "UPDATE gold.exit_name_map SET canonical_exit = $1, note = $2, updated_at = now() WHERE source_name IN ('Mindanao','Karuhatan')",
    ["NLEX Harbor Link", "Harbor Link facility (confirmed by project owner 2026-08-29)"]
  );

  console.log("\nAFTER:");
  console.table((await p.query(sel)).rows);

  const hl = await p.query("SELECT source_name FROM gold.exit_name_map WHERE canonical_exit = 'NLEX Harbor Link' ORDER BY 1");
  console.log("\nSource names now mapping to NLEX Harbor Link:");
  console.log("  " + hl.rows.map((r) => r.source_name).join(", "));

  const ex = await p.query("SELECT source_name FROM gold.exit_name_map WHERE canonical_exit IS NULL ORDER BY 1");
  console.log("\nStill excluded (canonical_exit NULL): " + (ex.rowCount === 0 ? "none" : ex.rows.map((r) => r.source_name).join(", ")));

  const n = await p.query("SELECT COUNT(DISTINCT canonical_exit)::int c FROM gold.exit_name_map WHERE canonical_exit IS NOT NULL");
  console.log("Distinct canonical exits: " + n.rows[0].c);

  await p.end();
})();
