const pg = require('pg');

const pool = new pg.Pool({
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'Hanszy123',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

const bronzeTables = {
  'nlex_traffic_volume': 'traffic_volume',
  'nlex_road_crashes': 'road_crashes',
  'nlex_motorcycle_crashes': 'motorcycle_crashes',
  'nlex_stalled_vehicles': 'stalled_vehicles',
  'nlex_apprehensions': 'apprehensions',
  'hourly_weather': 'hourly_weather',
  'nlex_emissions': 'emissions',
  'nlex_theoretical_emissions': 'theoretical_emissions',
  'nlex_emission_factors': 'emission_factors',
  'fact_hourly_alerts': 'waze_hourly_alerts',
  'fact_hourly_jams': 'waze_hourly_jams',
  'fact_hourly_irregularities': 'waze_hourly_irregularities',
  'nlex_exits': 'exits',
  'philippine_arena_events': 'philippine_arena_events',
  'source_scores': 'source_scores'
};

async function main() {
  console.log('Migrating tables to Bronze schema...');
  
  for (const [oldName, newName] of Object.entries(bronzeTables)) {
    try {
      // Move to bronze schema
      await pool.query(`ALTER TABLE public.${oldName} SET SCHEMA bronze;`);
      
      // Rename to the clean bronze name
      if (oldName !== newName) {
        await pool.query(`ALTER TABLE bronze.${oldName} RENAME TO ${newName};`);
      }
      console.log(`  ✅ Moved public.${oldName} -> bronze.${newName}`);
    } catch (e) {
      if (e.code === '42P01') {
        console.log(`  ⚠️ public.${oldName} does not exist (might be already moved)`);
      } else {
        console.error(`  ❌ Error moving ${oldName}:`, e.message);
      }
    }
  }

  // Also move the new dimension tables to dim schema
  const dimTables = ['dim_time', 'dim_weather', 'dim_incident_type', 'dim_location'];
  for (const dim of dimTables) {
    try {
      await pool.query(`ALTER TABLE public.${dim} SET SCHEMA dim;`);
      console.log(`  ✅ Moved public.${dim} -> dim.${dim}`);
    } catch (e) {
      console.log(`  ⚠️ public.${dim} does not exist (might be already moved)`);
    }
  }

  // And old fact tables just to clean up public
  const oldFacts = ['fact_incident_log', 'fact_waze_jams'];
  for (const f of oldFacts) {
    try {
      await pool.query(`ALTER TABLE public.${f} SET SCHEMA bronze;`);
      await pool.query(`ALTER TABLE bronze.${f} RENAME TO old_${f};`);
      console.log(`  ✅ Moved public.${f} -> bronze.old_${f}`);
    } catch (e) {
      console.log(`  ⚠️ public.${f} does not exist (might be already moved)`);
    }
  }

  console.log('\n✅ Bronze migration complete. Public schema is now clean!');
  pool.end();
}

main().catch(e => { console.error('Error:', e); pool.end(); });
