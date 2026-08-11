const { Pool } = require('pg');

const p = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123!',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function checkIncidentTypes() {
  await p.connect();
  console.log("Connected. Checking distinct incident types...");

  try {
    const res = await p.query(`SELECT DISTINCT incident_type, COUNT(*) FROM bronze.nlex_incidents GROUP BY incident_type`);
    console.log(res.rows);
  } catch (e) {
    console.error("Error:", e);
  } finally {
    await p.end();
  }
}

checkIncidentTypes();
