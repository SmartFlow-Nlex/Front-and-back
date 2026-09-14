throw new Error("ARCHIVED - do not run. First medallion schema build, Waze aggregation and reference loaders (July 2026); superseded by Back-End/scripts/medallion and the Back-End ETL. Kept only as a record; see smartflow_scripts/README.md.");
const pg = require('pg');

const pool = new pg.Pool({
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const res = await pool.query(`
    SELECT table_schema, table_name 
    FROM information_schema.tables 
    WHERE table_schema IN ('bronze', 'silver', 'gold', 'dim', 'public') 
    ORDER BY table_schema, table_name
  `);
  console.table(res.rows);
  
  const columns = await pool.query(`
    SELECT table_schema, table_name, column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name IN ('waze_hourly_jams', 'traffic_volume', 'dim_location')
      AND table_schema IN ('silver', 'dim')
  `);
  console.table(columns.rows);
  
  pool.end();
}

main().catch(e => {
  console.error(e);
  pool.end();
});
