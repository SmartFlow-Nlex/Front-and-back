const {Pool}=require('pg'); 
const p=new Pool(require("../config/db.cjs").poolConfig); 
(async()=>{ 
  const res = await p.query(`SELECT MIN(date_day), MAX(date_day) FROM bronze.nlex_traffic_volume WHERE total_volume > 0`);
  console.log('Active Traffic Bounds:', res.rows[0]);
  await p.end();
})();
