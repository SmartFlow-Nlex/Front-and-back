const {Pool}=require('pg'); 
const p=new Pool(require("../config/db.cjs").poolConfig); 
(async()=>{ 
  try {
    const res = await p.query(`SELECT MIN(date), MAX(date), COUNT(*) FROM gold.daily_traffic_volume`);
    console.log(res.rows[0]);
  } catch(e) { console.error(e.message); }
  await p.end();
})();
