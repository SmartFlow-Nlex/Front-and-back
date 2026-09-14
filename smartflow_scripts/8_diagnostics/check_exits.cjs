const { Pool } = require('pg');
const pool = new Pool(require("../config/db.cjs").poolConfig);
async function main() {
  const data = await pool.query("SELECT * FROM public.nlex_exits ORDER BY id");
  console.log(`Total exits: ${data.rows.length}`);
  console.table(data.rows);
  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
