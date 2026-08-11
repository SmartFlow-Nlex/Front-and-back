const { Pool } = require('pg');
const p = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123!',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function checkView() {
  await p.connect();
  const res = await p.query(`
    SELECT table_type 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'nlex_stalled_vehicles'
  `);
  console.log(res.rows);
  await p.end();
}
checkView();
