const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);

(async () => {
  const t = await p.query(`
    SELECT table_schema s, table_name n
    FROM information_schema.tables
    WHERE table_schema IN ('bronze','silver','gold') AND table_type='BASE TABLE'
    ORDER BY 1,2`);
  console.log("TABLES BY LAYER");
  for (const s of ["bronze", "silver", "gold"]) {
    const rows = t.rows.filter((r) => r.s === s);
    console.log(`  ${s} (${rows.length}): ${rows.map((r) => r.n).join(", ") || "none"}`);
  }

  for (const full of ["bronze.nlex_traffic_volume", "gold.daily_traffic_volume_corrected"]) {
    const [sch, tab] = full.split(".");
    const c = await p.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position",
      [sch, tab]
    );
    console.log(`\n${full}`);
    console.log("  " + c.rows.map((r) => r.column_name).join(", "));
    const n = await p.query(`SELECT COUNT(*)::bigint c FROM ${full}`);
    console.log("  rows: " + Number(n.rows[0].c).toLocaleString());
  }

  await p.end();
})();
