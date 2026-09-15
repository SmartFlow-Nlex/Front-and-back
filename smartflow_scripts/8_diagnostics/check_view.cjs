const { Pool } = require('pg');
const p = new Pool(require("../config/db.cjs").poolConfig);

async function checkView() {
  await p.connect();
  const res = await p.query(`
    SELECT table_type 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'nlex_stalled_vehicles'
  `);
  console.log(res.rows);
  await p.end();
}
checkView();
