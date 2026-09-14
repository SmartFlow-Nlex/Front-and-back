throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
const pg = require('pg');
const pool = new pg.Pool({
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'nlex_capstone' AND pid <> pg_backend_pid() AND application_name != 'pgAdmin 4'`)
  .then(r => {
    console.log('Killed hanging backends:', r.rowCount);
    pool.end();
  })
  .catch(e => {
    console.error(e);
    pool.end();
  });
