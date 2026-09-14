const {Pool}=require('pg'); 
const p=new Pool(require("../config/db.cjs").poolConfig); 
(async()=>{ 
  try {
    const res = await p.query(`SELECT * FROM gold.daily_traffic_volume LIMIT 1;`);
    console.log("gold.daily_traffic_volume:", res.rows);
    const sum = await p.query(`SELECT MAX(total_volume) FROM gold.daily_traffic_volume`);
    console.log("Max Volume:", sum.rows[0]);
  } catch(e) { console.error(e.message); }
  await p.end();
})();
