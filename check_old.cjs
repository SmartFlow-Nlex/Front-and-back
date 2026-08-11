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
    const res = await p.query(`SELECT date, SUM(COALESCE(h00,0)+COALESCE(h01,0)+COALESCE(h12,0)+COALESCE(h23,0)) as total_volume FROM bronze.traffic_volume GROUP BY date ORDER BY date DESC LIMIT 5`);
    console.log(res.rows);
  } catch(e) { console.error(e.message); }
  await p.end();
})();
