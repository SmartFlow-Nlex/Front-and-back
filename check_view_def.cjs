const { Pool } = require('pg');
const p = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123!',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function checkViewDef() {
  await p.connect();
  const res = await p.query(`
    SELECT pg_get_viewdef('public.nlex_stalled_vehicles', true)
  `);
  console.log(res.rows[0].pg_get_viewdef);
  await p.end();
}
checkViewDef();
