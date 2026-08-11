const { Pool } = require('pg');

const p = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123!',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function checkIncidents() {
  await p.connect();
  console.log("Connected. Checking incidents tables...");

  try {
    const t1 = await p.query(`SELECT COUNT(*) FROM public.incidents_table`);
    console.log("public.incidents_table count:", t1.rows[0].count);
    if(t1.rows[0].count > 0) {
       const r1 = await p.query(`SELECT * FROM public.incidents_table LIMIT 1`);
       console.log(r1.rows);
    }
    
    const t2 = await p.query(`SELECT COUNT(*) FROM bronze.nlex_incidents`);
    console.log("bronze.nlex_incidents count:", t2.rows[0].count);
    if(t2.rows[0].count > 0) {
       const r2 = await p.query(`SELECT * FROM bronze.nlex_incidents LIMIT 1`);
       console.log(r2.rows);
    }

  } catch (e) {
    console.error("Error:", e);
  } finally {
    await p.end();
  }
}

checkIncidents();
