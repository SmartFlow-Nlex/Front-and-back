const {Pool}=require('pg'); 
const p=new Pool(require("../config/db.cjs").poolConfig); 
(async()=>{ 
  const res = await p.query(`SELECT MAX(actual_volume) as max_vol, AVG(actual_volume) as avg_vol FROM gold.ml_predictive_volume`);
  console.log(res.rows[0]);
  await p.end();
})();
