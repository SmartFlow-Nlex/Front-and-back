throw new Error("ARCHIVED - do not run. Probes a table that no longer exists in the database (public.traffic_volumes). See smartflow_scripts/README.md.");
const {Pool}=require('pg'); 
const p=new Pool(require("../config/db.cjs").poolConfig); 
(async()=>{ 
  try {
    const res = await p.query(`SELECT * FROM public.traffic_volumes LIMIT 5;`);
    console.log(res.rows);
    const sum = await p.query(`SELECT SUM(volume) FROM public.traffic_volumes`);
    console.log("Total Volume sum:", sum.rows[0]);
  } catch(e) { console.error(e.message); }
  await p.end();
})();
