const { Pool } = require('pg');

const p = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123!',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function checkStalledVehicles() {
  await p.connect();
  console.log("Connected. Checking stalled vehicles table...");

  try {
    const res = await p.query(`SELECT * FROM public.nlex_stalled_vehicles LIMIT 3`);
    console.log("Data:", res.rows);
    
    const count = await p.query(`SELECT COUNT(*) FROM public.nlex_stalled_vehicles`);
    console.log("Total rows:", count.rows[0].count);
    
    const cols = await p.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'nlex_stalled_vehicles'
    `);
    console.log("Columns:", cols.rows);
  } catch (e) {
    console.error("Error:", e);
  } finally {
    await p.end();
  }
}

checkStalledVehicles();
