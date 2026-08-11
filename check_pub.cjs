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
    const res = await p.query(`SELECT * FROM public.traffic_volumes LIMIT 5;`);
    console.log(res.rows);
    const sum = await p.query(`SELECT SUM(volume) FROM public.traffic_volumes`);
    console.log("Total Volume sum:", sum.rows[0]);
  } catch(e) { console.error(e.message); }
  await p.end();
})();
