const { Pool } = require('pg');
const p = new Pool(require("../config/db.cjs").poolConfig);

async function main() {
  const r = await p.query(`
    SELECT date, total_volume 
    FROM gold.daily_traffic_volume 
    WHERE date > '2026-07-20' 
    ORDER BY date 
    LIMIT 20
  `);
  console.table(r.rows);
  await p.end();
}
main();
