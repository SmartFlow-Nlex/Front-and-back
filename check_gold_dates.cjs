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
  try {
    const res = await p.query(`SELECT MIN(date), MAX(date), COUNT(*) FROM gold.daily_traffic_volume`);
    console.log(res.rows[0]);
  } catch(e) { console.error(e.message); }
  await p.end();
})();
