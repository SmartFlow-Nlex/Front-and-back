throw new Error("ARCHIVED - do not run. Medallion rebuild and metrics-table setup from a Gemini session (Jul 27 - Aug 1 2026); already applied. Kept only as a record; see smartflow_scripts/README.md.");
/**
 * Recreate the FULL Medallion Architecture on the new AWS RDS database.
 * Bronze → raw ingested data
 * Silver → cleaned/transformed data
 * Gold   → analytics-ready tables
 */
const { Pool } = require('pg');

const db = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  database: 'nlex_capstone',
  user: 'postgres',
  password: 'REMOVED',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

async function run() {
  const client = await db.connect();
  try {
    console.log('=== Creating Medallion Architecture ===\n');

    // ──────────────────────────────────────────
    // 1. CREATE SCHEMAS
    // ──────────────────────────────────────────
    console.log('1) Creating schemas: bronze, silver, gold...');
    await client.query(`CREATE SCHEMA IF NOT EXISTS bronze;`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS silver;`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS gold;`);
    console.log('   ✅ Schemas created.\n');

    // ──────────────────────────────────────────
    // 2. BRONZE LAYER — Raw ingested data
    // ──────────────────────────────────────────
    console.log('2) Creating BRONZE tables (raw data)...');

    // bronze.nlex_emissions — raw emissions/pollution data from OpenWeatherMap
    await client.query(`
      CREATE TABLE IF NOT EXISTS bronze.nlex_emissions (
        id              BIGSERIAL PRIMARY KEY,
        exit_id         INTEGER,
        exit_name       TEXT,
        direction       TEXT,
        latitude        DOUBLE PRECISION,
        longitude       DOUBLE PRECISION,
        aqi             INTEGER,
        co              DOUBLE PRECISION,
        no              DOUBLE PRECISION,
        no2             DOUBLE PRECISION,
        o3              DOUBLE PRECISION,
        so2             DOUBLE PRECISION,
        pm2_5           DOUBLE PRECISION,
        pm10            DOUBLE PRECISION,
        nh3             DOUBLE PRECISION,
        fetched_at      TIMESTAMPTZ,
        api_dt          BIGINT,
        recorded_at     TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ bronze.nlex_emissions');

    // bronze.hourly_weather — raw weather data
    await client.query(`
      CREATE TABLE IF NOT EXISTS bronze.hourly_weather (
        id              BIGSERIAL PRIMARY KEY,
        cell_id         INTEGER,
        cell_name       TEXT,
        latitude        DOUBLE PRECISION,
        longitude       DOUBLE PRECISION,
        dt              BIGINT,
        temp            DOUBLE PRECISION,
        feels_like      DOUBLE PRECISION,
        pressure        INTEGER,
        humidity         INTEGER,
        dew_point       DOUBLE PRECISION,
        uvi             DOUBLE PRECISION,
        clouds          INTEGER,
        visibility      INTEGER,
        wind_speed      DOUBLE PRECISION,
        wind_deg        INTEGER,
        wind_gust       DOUBLE PRECISION,
        weather_id      INTEGER,
        weather_main    TEXT,
        weather_desc    TEXT,
        weather_icon    TEXT,
        pop             DOUBLE PRECISION,
        rain_1h         DOUBLE PRECISION,
        snow_1h         DOUBLE PRECISION,
        fetched_at      TIMESTAMPTZ,
        recorded_at     TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ bronze.hourly_weather');

    // bronze.philippine_arena_events — events near NLEX
    await client.query(`
      CREATE TABLE IF NOT EXISTS bronze.philippine_arena_events (
        id              BIGSERIAL PRIMARY KEY,
        event_name      TEXT,
        event_date      DATE,
        event_time      TEXT,
        venue           TEXT,
        category        TEXT,
        source          TEXT,
        notes           TEXT,
        recorded_at     TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ bronze.philippine_arena_events');

    // bronze.nlex_exits — exit reference data
    await client.query(`
      CREATE TABLE IF NOT EXISTS bronze.nlex_exits (
        id              SERIAL PRIMARY KEY,
        exit_number     INTEGER,
        exit_name       TEXT,
        direction       TEXT,
        km_marker       DOUBLE PRECISION,
        latitude        DOUBLE PRECISION,
        longitude       DOUBLE PRECISION,
        recorded_at     TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ bronze.nlex_exits');

    // bronze.weather_cells — weather grid reference
    await client.query(`
      CREATE TABLE IF NOT EXISTS bronze.weather_cells (
        id              SERIAL PRIMARY KEY,
        cell_id         INTEGER,
        cell_name       TEXT,
        latitude        DOUBLE PRECISION,
        longitude       DOUBLE PRECISION,
        recorded_at     TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ bronze.weather_cells');

    // bronze.nlex_emission_factors — emission factor reference
    await client.query(`
      CREATE TABLE IF NOT EXISTS bronze.nlex_emission_factors (
        id              SERIAL PRIMARY KEY,
        vehicle_type    TEXT,
        co2_factor      DOUBLE PRECISION,
        unit            TEXT,
        source          TEXT,
        recorded_at     TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ bronze.nlex_emission_factors');

    // ──────────────────────────────────────────
    // 3. SILVER LAYER — Cleaned/transformed data
    // ──────────────────────────────────────────
    console.log('\n3) Creating SILVER tables (cleaned data)...');

    // silver.nlex_emissions_clean
    await client.query(`
      CREATE TABLE IF NOT EXISTS silver.nlex_emissions_clean (
        id              BIGSERIAL PRIMARY KEY,
        exit_id         INTEGER,
        exit_name       TEXT,
        direction       TEXT,
        latitude        DOUBLE PRECISION,
        longitude       DOUBLE PRECISION,
        aqi             INTEGER,
        co              DOUBLE PRECISION,
        no              DOUBLE PRECISION,
        no2             DOUBLE PRECISION,
        o3              DOUBLE PRECISION,
        so2             DOUBLE PRECISION,
        pm2_5           DOUBLE PRECISION,
        pm10            DOUBLE PRECISION,
        nh3             DOUBLE PRECISION,
        recorded_at     TIMESTAMPTZ,
        fetched_at      TIMESTAMPTZ
      );
    `);
    console.log('   ✅ silver.nlex_emissions_clean');

    // silver.hourly_weather_clean
    await client.query(`
      CREATE TABLE IF NOT EXISTS silver.hourly_weather_clean (
        id              BIGSERIAL PRIMARY KEY,
        cell_id         INTEGER,
        cell_name       TEXT,
        latitude        DOUBLE PRECISION,
        longitude       DOUBLE PRECISION,
        recorded_at     TIMESTAMPTZ,
        temp            DOUBLE PRECISION,
        feels_like      DOUBLE PRECISION,
        pressure        INTEGER,
        humidity         INTEGER,
        dew_point       DOUBLE PRECISION,
        uvi             DOUBLE PRECISION,
        clouds          INTEGER,
        visibility      INTEGER,
        wind_speed      DOUBLE PRECISION,
        wind_deg        INTEGER,
        wind_gust       DOUBLE PRECISION,
        weather_main    TEXT,
        weather_desc    TEXT,
        pop             DOUBLE PRECISION,
        rain_1h         DOUBLE PRECISION
      );
    `);
    console.log('   ✅ silver.hourly_weather_clean');

    // silver.philippine_arena_events_clean
    await client.query(`
      CREATE TABLE IF NOT EXISTS silver.philippine_arena_events_clean (
        id              BIGSERIAL PRIMARY KEY,
        event_name      TEXT,
        event_date      DATE,
        event_time      TEXT,
        venue           TEXT,
        category        TEXT,
        source          TEXT,
        notes           TEXT
      );
    `);
    console.log('   ✅ silver.philippine_arena_events_clean');

    // ──────────────────────────────────────────
    // 4. GOLD LAYER — Analytics-ready tables
    // ──────────────────────────────────────────
    console.log('\n4) Creating GOLD tables (analytics-ready)...');

    // gold.daily_traffic_volume — aggregated traffic volumes
    await client.query(`
      CREATE TABLE IF NOT EXISTS gold.daily_traffic_volume (
        id              BIGSERIAL PRIMARY KEY,
        date            DATE NOT NULL,
        direction       TEXT,
        exit_name       TEXT,
        total_volume    BIGINT,
        avg_speed       DOUBLE PRECISION,
        vehicle_class   TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ gold.daily_traffic_volume');

    // gold.ml_predictive_volume — ML model predictions
    await client.query(`
      CREATE TABLE IF NOT EXISTS gold.ml_predictive_volume (
        id              BIGSERIAL PRIMARY KEY,
        date            DATE NOT NULL,
        model_name      TEXT NOT NULL,
        target          TEXT NOT NULL DEFAULT 'total_traffic_volume',
        predicted_value DOUBLE PRECISION NOT NULL,
        actual_value    DOUBLE PRECISION,
        data_split      TEXT DEFAULT 'prediction',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ gold.ml_predictive_volume');

    // gold.ml_model_metrics — ML evaluation metrics
    await client.query(`
      CREATE TABLE IF NOT EXISTS gold.ml_model_metrics (
        id              BIGSERIAL PRIMARY KEY,
        model_name      TEXT NOT NULL,
        target          TEXT NOT NULL DEFAULT 'total_traffic_volume',
        rmse            DOUBLE PRECISION,
        mae             DOUBLE PRECISION,
        mse             DOUBLE PRECISION,
        wmape           DOUBLE PRECISION,
        r2              DOUBLE PRECISION,
        mase            DOUBLE PRECISION,
        mape            DOUBLE PRECISION,
        smape           DOUBLE PRECISION,
        rmsse           DOUBLE PRECISION,
        me              DOUBLE PRECISION,
        mpe             DOUBLE PRECISION,
        adjusted_r2     DOUBLE PRECISION,
        theils_u        DOUBLE PRECISION,
        train_r2        DOUBLE PRECISION,
        val_r2          DOUBLE PRECISION,
        gap             DOUBLE PRECISION,
        diagnosis       TEXT,
        rank            INTEGER,
        accepted        BOOLEAN DEFAULT false,
        rejected_reason TEXT,
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ gold.ml_model_metrics');

    // gold.daily_emissions_summary — aggregated emissions
    await client.query(`
      CREATE TABLE IF NOT EXISTS gold.daily_emissions_summary (
        id              BIGSERIAL PRIMARY KEY,
        date            DATE NOT NULL,
        exit_name       TEXT,
        direction       TEXT,
        avg_aqi         DOUBLE PRECISION,
        avg_co          DOUBLE PRECISION,
        avg_no2         DOUBLE PRECISION,
        avg_o3          DOUBLE PRECISION,
        avg_so2         DOUBLE PRECISION,
        avg_pm2_5       DOUBLE PRECISION,
        avg_pm10        DOUBLE PRECISION,
        reading_count   INTEGER,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ gold.daily_emissions_summary');

    // gold.daily_weather_summary — aggregated weather
    await client.query(`
      CREATE TABLE IF NOT EXISTS gold.daily_weather_summary (
        id              BIGSERIAL PRIMARY KEY,
        date            DATE NOT NULL,
        cell_name       TEXT,
        avg_temp        DOUBLE PRECISION,
        min_temp        DOUBLE PRECISION,
        max_temp        DOUBLE PRECISION,
        avg_humidity    DOUBLE PRECISION,
        avg_wind_speed  DOUBLE PRECISION,
        total_rain      DOUBLE PRECISION,
        dominant_weather TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('   ✅ gold.daily_weather_summary');

    // ──────────────────────────────────────────
    // 5. CREATE INDEXES for performance
    // ──────────────────────────────────────────
    console.log('\n5) Creating indexes...');
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bronze_emissions_exit ON bronze.nlex_emissions(exit_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bronze_emissions_fetched ON bronze.nlex_emissions(fetched_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bronze_weather_cell ON bronze.hourly_weather(cell_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bronze_weather_dt ON bronze.hourly_weather(dt);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_silver_emissions_exit ON silver.nlex_emissions_clean(exit_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_silver_weather_cell ON silver.hourly_weather_clean(cell_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gold_traffic_date ON gold.daily_traffic_volume(date);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gold_predictions_date ON gold.ml_predictive_volume(date);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gold_predictions_model ON gold.ml_predictive_volume(model_name);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gold_metrics_model ON gold.ml_model_metrics(model_name);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gold_emissions_date ON gold.daily_emissions_summary(date);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gold_weather_date ON gold.daily_weather_summary(date);`);
    
    console.log('   ✅ All indexes created.');

    // ──────────────────────────────────────────
    // 6. VERIFY
    // ──────────────────────────────────────────
    console.log('\n6) Verifying...');
    const schemas = await client.query(`
      SELECT schema_name FROM information_schema.schemata 
      WHERE schema_name IN ('bronze','silver','gold') 
      ORDER BY schema_name;
    `);
    console.log('   Schemas:', schemas.rows.map(r => r.schema_name).join(', '));

    const tables = await client.query(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_schema IN ('bronze','silver','gold') 
      ORDER BY table_schema, table_name;
    `);
    console.log('   Tables:');
    tables.rows.forEach(r => console.log(`     ${r.table_schema}.${r.table_name}`));

    console.log('\n=== ✅ MEDALLION ARCHITECTURE COMPLETE ===');
    console.log(`   Bronze: ${tables.rows.filter(r => r.table_schema === 'bronze').length} tables`);
    console.log(`   Silver: ${tables.rows.filter(r => r.table_schema === 'silver').length} tables`);
    console.log(`   Gold:   ${tables.rows.filter(r => r.table_schema === 'gold').length} tables`);
  } finally {
    client.release();
    await db.end();
  }
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
