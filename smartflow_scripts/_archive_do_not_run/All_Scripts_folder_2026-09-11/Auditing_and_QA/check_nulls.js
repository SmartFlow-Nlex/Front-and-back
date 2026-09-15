require('dotenv').config(); // DB credentials come from .env, never from source
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.PG_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkNulls() {
  console.log('=== Checking for NULL values in Silver and Gold schemas ===\n');
  const schemas = ['silver', 'gold'];
  let totalNullFound = 0;

  for (const schema of schemas) {
    console.log(`\n--- Scanning Schema: ${schema} ---`);
    
    // Get all tables and views in the schema
    const tablesRes = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = $1
    `, [schema]);

    if (tablesRes.rows.length === 0) {
      console.log(`No tables found in schema ${schema}`);
      continue;
    }

    for (const table of tablesRes.rows) {
      const tableName = table.table_name;
      
      // Get all columns for the table
      const colsRes = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = $1 AND table_name = $2
      `, [schema, tableName]);

      const columns = colsRes.rows.map(r => r.column_name);
      if (columns.length === 0) continue;

      // Construct a query to check for nulls in any column
      // e.g. SELECT count(*) as null_col1 FROM table WHERE col1 IS NULL
      
      const queries = columns.map(col => 
        `SUM(CASE WHEN "${col}" IS NULL THEN 1 ELSE 0 END) as "${col}_nulls"`
      ).join(', ');

      try {
        const nullRes = await pool.query(`SELECT ${queries} FROM ${schema}.${tableName}`);
        const result = nullRes.rows[0];
        
        let hasNulls = false;
        let nullReport = [];
        
        for (const [key, val] of Object.entries(result)) {
          if (parseInt(val) > 0) {
            hasNulls = true;
            nullReport.push(`  - ${key.replace('_nulls', '')}: ${val} NULLs`);
            totalNullFound++;
          }
        }

        if (hasNulls) {
          console.log(`\n❌ Table: ${tableName} has NULL values!`);
          console.log(nullReport.join('\n'));
        } else {
          // console.log(`✅ Table: ${tableName} (Clean)`);
        }
      } catch (e) {
        console.log(`⚠️ Error querying ${tableName}: ${e.message}`);
      }
    }
  }

  if (totalNullFound === 0) {
    console.log('\n✅✅ SUCCESS: Zero NULL values found across all Silver and Gold tables! ✅✅');
  } else {
    console.log(`\n⚠️ Found NULL values in ${totalNullFound} columns across Silver/Gold layers.`);
  }

  pool.end();
}

checkNulls().catch(e => {
  console.error(e);
  pool.end();
});
