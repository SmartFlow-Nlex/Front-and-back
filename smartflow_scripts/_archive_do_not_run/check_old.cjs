throw new Error("ARCHIVED - do not run. Probes a table that no longer exists in the database (bronze.traffic_volume). See smartflow_scripts/README.md.");
const {Pool}=require('pg'); 
const p=new Pool(require("../config/db.cjs").poolConfig); 
(async()=>{ 
  try {
    const res = await p.query(`SELECT date, SUM(COALESCE(h00,0)+COALESCE(h01,0)+COALESCE(h12,0)+COALESCE(h23,0)) as total_volume FROM bronze.traffic_volume GROUP BY date ORDER BY date DESC LIMIT 5`);
    console.log(res.rows);
  } catch(e) { console.error(e.message); }
  await p.end();
})();
