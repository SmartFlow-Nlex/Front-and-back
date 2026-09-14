const {Pool}=require('pg'); 
const p=new Pool(require("../config/db.cjs").poolConfig); 
(async()=>{ 
  try {
    const res = await p.query(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_schema IN ('public', 'bronze', 'silver', 'gold')
      ORDER BY table_schema, table_name;
    `);
    console.log(res.rows);
  } catch(e) { console.error(e.message); }
  await p.end();
})();
