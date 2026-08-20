const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone', ssl: { rejectUnauthorized: false } });
async function main() {
  const data = await pool.query("SELECT * FROM public.nlex_exits ORDER BY id");
  console.log(`Total exits: ${data.rows.length}`);
  console.table(data.rows);
  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
