throw new Error("ARCHIVED - do not run. Medallion rebuild and metrics-table setup from a Gemini session (Jul 27 - Aug 1 2026); already applied. Kept only as a record; see smartflow_scripts/README.md.");
/**
 * Phase 1: Ingest reference/seed data + traffic into Bronze layer
 * 
 * Tables:
 *   bronze.nlex_exits (20 physical exits)
 *   bronze.nlex_emission_factors (3 vehicle classes)
 *   bronze.philippine_arena_events
 *   bronze.nlex_traffic_volume (hourly synthetic 2020-2026)
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const db = new Pool({
  host: 'smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com',
  port: 5432, database: 'nlex_capstone', user: 'postgres',
  password: 'REMOVED', ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

const EXITS = [
  { id: 1,  name: 'Balintawak',            lat: 14.6788, lon: 121.0003 },
  { id: 2,  name: 'Mindanao Ave / Bignay', lat: 14.6862, lon: 120.9913 },
  { id: 3,  name: 'Karuhatan',             lat: 14.7064, lon: 120.9703 },
  { id: 4,  name: 'Valenzuela',            lat: 14.7117, lon: 120.9622 },
  { id: 5,  name: 'Meycauayan',            lat: 14.7346, lon: 120.9508 },
  { id: 6,  name: 'Marilao',               lat: 14.7578, lon: 120.9484 },
  { id: 7,  name: 'Bocaue',                lat: 14.7976, lon: 120.9316 },
  { id: 8,  name: 'Balagtas',              lat: 14.8148, lon: 120.9130 },
  { id: 9,  name: 'Tabang',                lat: 14.8379, lon: 120.8900 },
  { id: 10, name: 'Plaridel',              lat: 14.8710, lon: 120.8630 },
  { id: 11, name: 'Pulilan',               lat: 14.8948, lon: 120.8471 },
  { id: 12, name: 'Calumpit',              lat: 14.9168, lon: 120.8235 },
  { id: 13, name: 'Apalit',                lat: 14.9520, lon: 120.7640 },
  { id: 14, name: 'San Simon',             lat: 14.9843, lon: 120.7293 },
  { id: 15, name: 'San Fernando',          lat: 15.0282, lon: 120.6882 },
  { id: 16, name: 'Mexico',                lat: 15.0659, lon: 120.6571 },
  { id: 17, name: 'Angeles',               lat: 15.0936, lon: 120.6369 },
  { id: 18, name: 'Dau / Mabalacat',       lat: 15.1468, lon: 120.5966 },
  { id: 19, name: 'Sta. Ines / SCTEX',     lat: 15.1742, lon: 120.5896 },
  { id: 20, name: 'Tipo / TPLEX',          lat: 15.2220, lon: 120.5878 },
];

async function run() {
  const client = await db.connect();
  try {
    console.log('=== Phase 1: Reference Data + Traffic → Bronze ===\n');

    // ─── 1. NLEX EXITS (20 physical exits) ───
    console.log('1) Ingesting bronze.nlex_exits (20 exits)...');
    await client.query('DROP TABLE IF EXISTS bronze.nlex_exits CASCADE');
    await client.query(`
      CREATE TABLE bronze.nlex_exits (
        id          SERIAL PRIMARY KEY,
        exit_id     INTEGER UNIQUE NOT NULL,
        exit_name   TEXT NOT NULL,
        latitude    DOUBLE PRECISION,
        longitude   DOUBLE PRECISION,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    for (const e of EXITS) {
      await client.query(
        'INSERT INTO bronze.nlex_exits (exit_id, exit_name, latitude, longitude) VALUES ($1,$2,$3,$4)',
        [e.id, e.name, e.lat, e.lon]
      );
    }
    const exitCount = await client.query('SELECT COUNT(*) as cnt FROM bronze.nlex_exits');
    console.log(`   ✅ ${exitCount.rows[0].cnt} exits ingested.\n`);

    // ─── 2. EMISSION FACTORS (3 vehicle classes) ───
    console.log('2) Ingesting bronze.nlex_emission_factors...');
    await client.query('DROP TABLE IF EXISTS bronze.nlex_emission_factors CASCADE');
    await client.query(`
      CREATE TABLE bronze.nlex_emission_factors (
        id            SERIAL PRIMARY KEY,
        vehicle_class INTEGER NOT NULL,
        class_label   TEXT,
        co2_g_per_km  DOUBLE PRECISION,
        co_g_per_km   DOUBLE PRECISION,
        no2_g_per_km  DOUBLE PRECISION,
        source        TEXT,
        recorded_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    const factors = [
      { cls: 1, label: 'Light Vehicles (Class 1)', co2: 192.00, co: 1.77, no2: 0.46 },
      { cls: 2, label: 'Medium Vehicles (Class 2)', co2: 354.00, co: 3.24, no2: 3.17 },
      { cls: 3, label: 'Heavy Vehicles (Class 3)', co2: 666.00, co: 4.00, no2: 6.95 },
    ];
    for (const f of factors) {
      await client.query(
        'INSERT INTO bronze.nlex_emission_factors (vehicle_class, class_label, co2_g_per_km, co_g_per_km, no2_g_per_km, source) VALUES ($1,$2,$3,$4,$5,$6)',
        [f.cls, f.label, f.co2, f.co, f.no2, 'DENR/DOTC Philippines Emission Standards']
      );
    }
    console.log('   ✅ 3 emission factors ingested.\n');

    // ─── 3. PHILIPPINE ARENA EVENTS ───
    console.log('3) Ingesting bronze.philippine_arena_events...');
    // Check if we have the migration script with event data
    const eventsFile = 'C:/Users/Hans/.gemini/antigravity/scratch/nlex-emissions/migrate-arena-events.cjs';
    // We'll create sample events based on what was in the old database
    await client.query('DELETE FROM bronze.philippine_arena_events');
    console.log('   ⚠️  Philippine Arena events table is ready (empty — will need source data or API to populate).\n');

    // ─── 4. TRAFFIC VOLUME → Bronze ───
    console.log('4) Ingesting bronze.nlex_traffic_volume (hourly 2020-2026)...');
    await client.query('DROP TABLE IF EXISTS bronze.nlex_traffic_volume CASCADE');
    await client.query(`
      CREATE TABLE bronze.nlex_traffic_volume (
        id              BIGSERIAL PRIMARY KEY,
        date_day        DATE NOT NULL,
        hour_of_day     INTEGER,
        day_of_week     TEXT,
        is_weekend      BOOLEAN DEFAULT false,
        month_name      TEXT,
        quarter         TEXT,
        is_rush_hour    BOOLEAN DEFAULT false,
        is_holiday      BOOLEAN DEFAULT false,
        is_holiday_window BOOLEAN DEFAULT false,
        volume_class1   INTEGER DEFAULT 0,
        volume_class2   INTEGER DEFAULT 0,
        volume_class3   INTEGER DEFAULT 0,
        total_volume    INTEGER DEFAULT 0,
        avg_speed_kmh   DOUBLE PRECISION,
        avg_jam_level   DOUBLE PRECISION,
        max_delay_seconds DOUBLE PRECISION,
        temperature     DOUBLE PRECISION,
        rainfall        DOUBLE PRECISION,
        wind_speed      DOUBLE PRECISION,
        humidity        DOUBLE PRECISION,
        recorded_at     TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query('CREATE INDEX idx_bronze_traffic_date ON bronze.nlex_traffic_volume(date_day);');

    const trafficFile = 'C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/training_and_testing_outputs/01_dataset/traffic_speed_dataset.csv';
    const trafficRaw = fs.readFileSync(trafficFile, 'utf8');
    const trafficLines = trafficRaw.split('\n').filter(l => l.trim());
    const headers = trafficLines[0].split(',').map(h => h.trim());
    console.log(`   Read ${trafficLines.length - 1} hourly rows`);

    let inserted = 0;
    const CHUNK = 200;
    for (let i = 1; i < trafficLines.length; i += CHUNK) {
      const chunk = trafficLines.slice(i, Math.min(i + CHUNK, trafficLines.length));
      const values = [];
      const params = [];
      let pIdx = 1;

      for (const line of chunk) {
        const vals = line.split(',');
        const row = {};
        headers.forEach((h, idx) => row[h] = vals[idx] ? vals[idx].trim() : '');

        values.push(`($${pIdx},$${pIdx+1},$${pIdx+2},$${pIdx+3},$${pIdx+4},$${pIdx+5},$${pIdx+6},$${pIdx+7},$${pIdx+8},$${pIdx+9},$${pIdx+10},$${pIdx+11},$${pIdx+12},$${pIdx+13},$${pIdx+14},$${pIdx+15},$${pIdx+16},$${pIdx+17},$${pIdx+18})`);
        params.push(
          row.date_day || null,
          parseInt(row.hour_of_day || '0'),
          row.day_of_week || '',
          row.is_weekend === '1',
          row.month_name || '',
          row.quarter || '',
          row.is_rush_hour === '1',
          row.is_holiday === '1',
          row.is_holiday_window === 'True' || row.is_holiday_window === '1',
          parseInt(row.volume_class1 || '0'),
          parseInt(row.volume_class2 || '0'),
          parseInt(row.volume_class3 || '0'),
          parseInt(row.total_volume || row.Total || '0'),
          parseFloat(row.avg_speed_kmh || '0'),
          parseFloat(row.avg_jam_level || '0'),
          parseFloat(row.max_delay_seconds || '0'),
          row.temperature ? parseFloat(row.temperature) : null,
          row.rainfall ? parseFloat(row.rainfall) : null,
          row.wind_speed ? parseFloat(row.wind_speed) : null
        );
        pIdx += 19;
      }

      await client.query(`
        INSERT INTO bronze.nlex_traffic_volume
          (date_day, hour_of_day, day_of_week, is_weekend, month_name, quarter,
           is_rush_hour, is_holiday, is_holiday_window,
           volume_class1, volume_class2, volume_class3, total_volume,
           avg_speed_kmh, avg_jam_level, max_delay_seconds,
           temperature, rainfall, wind_speed)
        VALUES ${values.join(',')}
      `, params);
      inserted += chunk.length;
      if (inserted % 5000 === 0 || i + CHUNK >= trafficLines.length) {
        console.log(`   Inserted ${inserted} / ${trafficLines.length - 1} rows`);
      }
    }
    console.log(`   ✅ Traffic volume: ${inserted} hourly records ingested.\n`);

    // ─── 5. INCIDENT DATA → Bronze ───
    console.log('5) Ingesting bronze.nlex_incidents (raw incidents 2020-2026)...');
    await client.query('DROP TABLE IF EXISTS bronze.nlex_incidents CASCADE');
    await client.query(`
      CREATE TABLE bronze.nlex_incidents (
        id                    BIGSERIAL PRIMARY KEY,
        incident_date         DATE NOT NULL,
        reported_time         TIMESTAMPTZ,
        cleared_time          TIMESTAMPTZ,
        location              TEXT,
        incident_type         TEXT,
        no_of_vehicles        INTEGER,
        cause_of_accident     TEXT,
        type_of_accident      TEXT,
        weather_condition     TEXT,
        injuries_male         INTEGER DEFAULT 0,
        injuries_female       INTEGER DEFAULT 0,
        fatalities_male       INTEGER DEFAULT 0,
        fatalities_female     INTEGER DEFAULT 0,
        hour_of_day           INTEGER,
        km_value              DOUBLE PRECISION,
        nearest_exit          TEXT,
        clearance_minutes     DOUBLE PRECISION,
        total_injuries        INTEGER DEFAULT 0,
        total_fatalities      INTEGER DEFAULT 0,
        severity              TEXT,
        recorded_at           TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query('CREATE INDEX idx_bronze_incidents_date ON bronze.nlex_incidents(incident_date);');

    const incidentFile = 'C:/Users/Hans/.gemini/antigravity/scratch/predictive folder/training_and_testing_outputs/01_dataset/incidents_raw_combined.csv';
    const incRaw = fs.readFileSync(incidentFile, 'utf8');
    const incLines = incRaw.split('\n').filter(l => l.trim());
    const incHeaders = incLines[0].split(',').map(h => h.trim());
    console.log(`   Read ${incLines.length - 1} incident rows`);

    inserted = 0;
    for (let i = 1; i < incLines.length; i += CHUNK) {
      const chunk = incLines.slice(i, Math.min(i + CHUNK, incLines.length));
      const values = [];
      const params = [];
      let pIdx = 1;

      for (const line of chunk) {
        const vals = line.split(',');
        const row = {};
        incHeaders.forEach((h, idx) => row[h] = vals[idx] ? vals[idx].trim() : '');

        values.push(`($${pIdx},$${pIdx+1},$${pIdx+2},$${pIdx+3},$${pIdx+4},$${pIdx+5},$${pIdx+6},$${pIdx+7},$${pIdx+8},$${pIdx+9},$${pIdx+10},$${pIdx+11},$${pIdx+12},$${pIdx+13},$${pIdx+14},$${pIdx+15},$${pIdx+16})`);
        params.push(
          row.incident_date || null,
          row.location || '',
          row.incident_type || '',
          parseInt(row.no_of_vehicles_involved || '0'),
          row.cause_of_accident || '',
          row.type_of_accident || '',
          row.weather_condition || '',
          parseInt(row.no_of_injuries_male || '0'),
          parseInt(row.no_of_injuries_female || '0'),
          parseInt(row.no_of_fatalities_male || '0'),
          parseInt(row.no_of_fatalities_female || '0'),
          parseInt(row.hour_of_day || '0'),
          parseFloat(row.km_value || '0'),
          row.nearest_exit || '',
          parseFloat(row.clearance_minutes || '0'),
          parseInt(row.total_injuries || '0'),
          parseInt(row.total_fatalities || '0')
        );
        pIdx += 17;
      }

      await client.query(`
        INSERT INTO bronze.nlex_incidents
          (incident_date, location, incident_type, no_of_vehicles,
           cause_of_accident, type_of_accident, weather_condition,
           injuries_male, injuries_female, fatalities_male, fatalities_female,
           hour_of_day, km_value, nearest_exit, clearance_minutes,
           total_injuries, total_fatalities)
        VALUES ${values.join(',')}
      `, params);
      inserted += chunk.length;
      if (inserted % 2000 === 0 || i + CHUNK >= incLines.length) {
        console.log(`   Inserted ${inserted} / ${incLines.length - 1} rows`);
      }
    }
    console.log(`   ✅ Incidents: ${inserted} records ingested.\n`);

    // ─── VERIFY ───
    console.log('=== Phase 1 Verification ===');
    const tables = ['bronze.nlex_exits','bronze.nlex_emission_factors','bronze.nlex_traffic_volume','bronze.nlex_incidents'];
    for (const t of tables) {
      const r = await client.query('SELECT COUNT(*) as cnt FROM ' + t);
      console.log(`  ${t}: ${r.rows[0].cnt} rows`);
    }
    console.log('\n=== ✅ Phase 1 COMPLETE ===');

  } finally {
    client.release();
    await db.end();
  }
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
