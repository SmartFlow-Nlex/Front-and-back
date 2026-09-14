const {Pool}=require('pg'); 
const p=new Pool(require("../config/db.cjs").poolConfig); 
(async()=>{ 
  const metrics = await p.query(`SELECT DISTINCT target FROM gold.ml_model_metrics`);
  console.log(metrics.rows);
  await p.end();
})();
