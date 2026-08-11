const { Pool } = require('pg');

const p = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123!',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  await p.connect();
  const res1 = await p.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'bronze' AND table_name = 'nlex_traffic_volume'");
  console.log('bronze.nlex_traffic_volume:', res1.rows);
  
  const res2 = await p.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'gold' AND table_name = 'daily_traffic_volume'");
  console.log('gold.daily_traffic_volume:', res2.rows);
  await p.end();
}

check();
