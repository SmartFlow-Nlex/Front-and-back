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
  const q1 = `SELECT sum(COALESCE(h00, 0) + COALESCE(h01, 0) + COALESCE(h02, 0) + COALESCE(h03, 0) + COALESCE(h04, 0) + COALESCE(h05, 0) + COALESCE(h06, 0) + COALESCE(h07, 0) + COALESCE(h08, 0) + COALESCE(h09, 0) + COALESCE(h10, 0) + COALESCE(h11, 0) + COALESCE(h12, 0) + COALESCE(h13, 0) + COALESCE(h14, 0) + COALESCE(h15, 0) + COALESCE(h16, 0) + COALESCE(h17, 0) + COALESCE(h18, 0) + COALESCE(h19, 0) + COALESCE(h20, 0) + COALESCE(h21, 0) + COALESCE(h22, 0) + COALESCE(h23, 0)) as total FROM bronze.traffic_volume WHERE date = '2026-06-06'`;
  const q2 = `SELECT sum(COALESCE(h00, 0) + COALESCE(h01, 0) + COALESCE(h02, 0) + COALESCE(h03, 0) + COALESCE(h04, 0) + COALESCE(h05, 0) + COALESCE(h06, 0) + COALESCE(h07, 0) + COALESCE(h08, 0) + COALESCE(h09, 0) + COALESCE(h10, 0) + COALESCE(h11, 0) + COALESCE(h12, 0) + COALESCE(h13, 0) + COALESCE(h14, 0) + COALESCE(h15, 0) + COALESCE(h16, 0) + COALESCE(h17, 0) + COALESCE(h18, 0) + COALESCE(h19, 0) + COALESCE(h20, 0) + COALESCE(h21, 0) + COALESCE(h22, 0) + COALESCE(h23, 0)) as total FROM bronze.nlex_traffic_volume WHERE date_day = '2026-06-06'`;
  
  try {
      const res1 = await p.query(q1);
      console.log('bronze.traffic_volume:', res1.rows);
  } catch(e) { console.log('bronze.traffic_volume ERROR:', e.message); }
  
  try {
      const res2 = await p.query(q2);
      console.log('bronze.nlex_traffic_volume:', res2.rows);
  } catch(e) { console.log('bronze.nlex_traffic_volume ERROR:', e.message); }
  
  const q3 = `SELECT count(*) FROM bronze.traffic_volume WHERE date = '2026-06-06'`;
  const q4 = `SELECT count(*) FROM bronze.nlex_traffic_volume WHERE date_day = '2026-06-06'`;
  console.log('Rows in traffic_volume:', (await p.query(q3)).rows);
  console.log('Rows in nlex_traffic_volume:', (await p.query(q4)).rows);
  
  await p.end();
}

check();
