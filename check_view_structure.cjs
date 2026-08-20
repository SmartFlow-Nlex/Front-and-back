const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  // Check if nlex_emission_factors is a view
  const viewDef = await pool.query(`
    SELECT table_schema, table_name, table_type 
    FROM information_schema.tables 
    WHERE table_name = 'nlex_emission_factors'
  `);
  console.log('=== nlex_emission_factors type ===');
  console.table(viewDef.rows);

  // Get the view definition
  const def = await pool.query(`
    SELECT pg_get_viewdef('nlex_emission_factors'::regclass, true)
  `);
  console.log('\n=== View definition ===');
  console.log(def.rows[0].pg_get_viewdef);

  // Check the underlying table for nlex_theoretical_emissions
  const emType = await pool.query(`
    SELECT table_schema, table_name, table_type 
    FROM information_schema.tables 
    WHERE table_name = 'nlex_theoretical_emissions'
  `);
  console.log('\n=== nlex_theoretical_emissions type ===');
  console.table(emType.rows);

  // Check if nlex_theoretical_emissions is also a view
  try {
    const emDef = await pool.query(`SELECT pg_get_viewdef('nlex_theoretical_emissions'::regclass, true)`);
    console.log('\n=== nlex_theoretical_emissions view def ===');
    console.log(emDef.rows[0].pg_get_viewdef);
  } catch (e) {
    console.log('nlex_theoretical_emissions is a real table (not a view)');
  }

  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
