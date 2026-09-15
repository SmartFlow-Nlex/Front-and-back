throw new Error("ARCHIVED - do not run. Probes a table that no longer exists in the database (public.incidents_table). See smartflow_scripts/README.md.");
const { Pool } = require('pg');

const p = new Pool(require("../config/db.cjs").poolConfig);

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
