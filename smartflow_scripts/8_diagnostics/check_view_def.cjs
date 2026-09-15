const { Pool } = require('pg');
const p = new Pool(require("../config/db.cjs").poolConfig);

async function checkViewDef() {
  await p.connect();
  const res = await p.query(`
    SELECT pg_get_viewdef('public.nlex_stalled_vehicles', true)
  `);
  console.log(res.rows[0].pg_get_viewdef);
  await p.end();
}
checkViewDef();
