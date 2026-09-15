const { Pool } = require('pg');

const p = new Pool(require("../config/db.cjs").poolConfig);

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
