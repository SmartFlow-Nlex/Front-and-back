throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
const { Pool } = require('pg');
const pool = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

// Weighted distribution of traffic volume across 20 NLEX plazas
// Busier urban plazas get higher weight
const PLAZA_WEIGHTS = {
  'Balintawak': 0.12,
  'Mindanao Ave / Bignay': 0.08,
  'Karuhatan': 0.06,
  'Valenzuela': 0.07,
  'Meycauayan': 0.06,
  'Marilao': 0.05,
  'Bocaue': 0.08,
  'Balagtas': 0.05,
  'Tabang': 0.04,
  'Plaridel': 0.04,
  'Pulilan': 0.03,
  'Calumpit': 0.03,
  'Apalit': 0.03,
  'San Simon': 0.03,
  'San Fernando': 0.06,
  'Mexico': 0.04,
  'Angeles': 0.05,
  'Dau / Mabalacat': 0.04,
  'Sta. Ines / SCTEX': 0.02,
  'Tipo / TPLEX': 0.02,
};

// Verify weights sum to 1
const totalWeight = Object.values(PLAZA_WEIGHTS).reduce((a, b) => a + b, 0);
console.log('Total weight:', totalWeight.toFixed(2));

async function main() {
  const client = await pool.connect();
  
  try {
    console.log('\n=== STEP 1: Add toll_plaza and direction columns ===');
    
    // Add columns if they don't exist
    await client.query(`
      ALTER TABLE bronze.nlex_traffic_volume 
      ADD COLUMN IF NOT EXISTS toll_plaza TEXT,
      ADD COLUMN IF NOT EXISTS direction TEXT
    `);
    console.log('✅ Columns added');
    
    // Check if data already has plazas assigned
    const check = await client.query(`SELECT COUNT(*) as cnt FROM bronze.nlex_traffic_volume WHERE toll_plaza IS NOT NULL`);
    if (parseInt(check.rows[0].cnt) > 100000) {
      console.log(`⚠️ Data already has ${check.rows[0].cnt} rows with plaza assigned. Skipping.`);
      return;
    }
    
    console.log('\n=== STEP 2: Expand rows across plazas and directions ===');
    console.log('This will multiply 61,368 rows × 20 plazas × 2 directions = ~2.4M rows');
    console.log('This may take a few minutes...\n');
    
    // First, tag existing rows as "aggregate" so we can identify them
    await client.query(`UPDATE bronze.nlex_traffic_volume SET toll_plaza = '__AGGREGATE__' WHERE toll_plaza IS NULL`);
    console.log('✅ Tagged aggregate rows');
    
    const plazas = Object.keys(PLAZA_WEIGHTS);
    const directions = ['NB', 'SB'];
    
    let totalInserted = 0;
    
    for (const plaza of plazas) {
      const weight = PLAZA_WEIGHTS[plaza];
      
      for (const dir of directions) {
        // Each direction gets ~50% of the plaza's volume, with slight NB bias (55/45)
        const dirMultiplier = dir === 'NB' ? 0.55 : 0.45;
        const finalMultiplier = weight * dirMultiplier;
        
        const result = await client.query(`
          INSERT INTO bronze.nlex_traffic_volume (
            date_day, hour_of_day, day_of_week, is_weekend, month_name, quarter,
            is_rush_hour, is_holiday, is_holiday_window,
            volume_class1, volume_class2, volume_class3, total_volume,
            avg_speed_kmh, avg_jam_level, max_delay_seconds,
            temperature, rainfall, wind_speed, humidity, recorded_at,
            toll_plaza, direction
          )
          SELECT 
            date_day, hour_of_day, day_of_week, is_weekend, month_name, quarter,
            is_rush_hour, is_holiday, is_holiday_window,
            ROUND(volume_class1 * ${finalMultiplier})::int,
            ROUND(volume_class2 * ${finalMultiplier})::int,
            ROUND(volume_class3 * ${finalMultiplier})::int,
            ROUND(total_volume * ${finalMultiplier})::int,
            avg_speed_kmh + (random() * 10 - 5),  -- slight variation per plaza
            avg_jam_level + (random() * 0.5 - 0.25),
            max_delay_seconds + (random() * 60 - 30),
            temperature, rainfall, wind_speed, humidity, recorded_at,
            '${plaza}',
            '${dir}'
          FROM bronze.nlex_traffic_volume
          WHERE toll_plaza = '__AGGREGATE__'
        `);
        
        totalInserted += result.rowCount;
        process.stdout.write(`  ${plaza} (${dir}): ${result.rowCount.toLocaleString()} rows inserted\n`);
      }
    }
    
    console.log(`\n✅ Total new rows inserted: ${totalInserted.toLocaleString()}`);
    
    // Now delete the aggregate rows (they've been distributed)
    console.log('\n=== STEP 3: Remove aggregate rows ===');
    const deleted = await client.query(`DELETE FROM bronze.nlex_traffic_volume WHERE toll_plaza = '__AGGREGATE__'`);
    console.log(`✅ Deleted ${deleted.rowCount.toLocaleString()} aggregate rows`);
    
    // Verify final count
    const finalCount = await client.query(`SELECT COUNT(*) as cnt FROM bronze.nlex_traffic_volume`);
    console.log(`\n✅ Final row count: ${parseInt(finalCount.rows[0].cnt).toLocaleString()}`);
    
    // Show distribution
    const dist = await client.query(`
      SELECT toll_plaza, direction, COUNT(*) as rows, SUM(total_volume)::bigint as total_vol
      FROM bronze.nlex_traffic_volume
      GROUP BY toll_plaza, direction
      ORDER BY total_vol DESC
      LIMIT 10
    `);
    console.log('\nTop 10 plaza/direction by volume:');
    dist.rows.forEach(r => {
      console.log(`  ${r.toll_plaza} (${r.direction}): ${parseInt(r.total_vol).toLocaleString()} vehicles, ${r.rows} rows`);
    });
    
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
