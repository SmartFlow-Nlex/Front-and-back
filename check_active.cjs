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
  const res = await p.query(`SELECT MIN(date_day), MAX(date_day) FROM bronze.nlex_traffic_volume WHERE total_volume > 0`);
  console.log('Active Traffic Bounds:', res.rows[0]);
  await p.end();
})();
