const {Pool}=require('pg'); 
const p=new Pool({
  host:'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port:5432,
  user:'postgres',
  password:'Hanszy123!',
  database:'nlex_capstone',
  ssl:{rejectUnauthorized:false}
}); 
(async()=>{ 
  const res = await p.query(`SELECT MAX(actual_volume) as max_vol, AVG(actual_volume) as avg_vol FROM gold.ml_predictive_volume`);
  console.log(res.rows[0]);
  await p.end();
})();
