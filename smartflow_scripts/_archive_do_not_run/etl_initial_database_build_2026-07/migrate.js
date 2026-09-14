throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
// ============================================================
// NLEX Capstone — Full Migration: Supabase → Local PostgreSQL
// Exports all 6 tables from Supabase, creates schema locally,
// and imports everything in batches.
// ============================================================

import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

// ── Connections ──────────────────────────────────────────────
const AWS_PG = {
  host: 'smartflow.cn4wwa2i4cux.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  user: 'postgres',
  password: 'REMOVED',
  database: 'postgres', // We'll create nlex_capstone first
  ssl: { rejectUnauthorized: false }
};

const SUPABASE_URL = 'https://cksprtvjsjrsldamlylc.supabase.co';
const SERVICE_ROLE_KEY = 'REMOVED';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── Step 1: Create Database ─────────────────────────────────
async function createDatabase() {
  console.log('📦 Step 1: Creating nlex_capstone database...');
  const client = new pg.Client(AWS_PG);
  await client.connect();

  // Check if DB exists
  await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'nlex_capstone' AND pid <> pg_backend_pid()");
  await client.query("DROP DATABASE IF EXISTS nlex_capstone");
  await client.query('CREATE DATABASE nlex_capstone');
  console.log('   ✅ Database "nlex_capstone" recreated freshly.');
  await client.end();
}

// ── Step 2: Create Schema ───────────────────────────────────
async function createSchema(client) {
  console.log('\n📐 Step 2: Creating tables...');

  // Enable UUID extension
  await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  const ddl = `
    -- weather_cells
    CREATE TABLE IF NOT EXISTS weather_cells (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name TEXT,
      latitude NUMERIC,
      longitude NUMERIC
    );

    -- nlex_exits
    CREATE TABLE IF NOT EXISTS nlex_exits (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name TEXT,
      direction TEXT,
      km_marker NUMERIC,
      latitude NUMERIC,
      longitude NUMERIC,
      access_type TEXT,
      weather_cell_id UUID REFERENCES weather_cells(id)
    );

    -- nlex_emission_factors
    CREATE TABLE IF NOT EXISTS nlex_emission_factors (
      id SERIAL PRIMARY KEY,
      vehicle_class INTEGER NOT NULL,
      class_label TEXT NOT NULL,
      description TEXT,
      co2_g_per_km NUMERIC(10,2),
      co_g_per_km NUMERIC(10,4),
      no2_g_per_km NUMERIC(10,4),
      pm25_g_per_km NUMERIC(10,4),
      pm10_g_per_km NUMERIC(10,4),
      so2_g_per_km NUMERIC(10,4),
      source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- nlex_emissions
    CREATE TABLE IF NOT EXISTS nlex_emissions (
      id BIGSERIAL PRIMARY KEY,
      exit_id UUID REFERENCES nlex_exits(id) ON DELETE CASCADE,
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      aqi INTEGER,
      co NUMERIC(10,2),
      "no" NUMERIC(10,2),
      no2 NUMERIC(10,2),
      o3 NUMERIC(10,2),
      so2 NUMERIC(10,2),
      nh3 NUMERIC(10,2),
      pm2_5 NUMERIC(10,2),
      pm10 NUMERIC(10,2),
      api_dt INTEGER,
      raw_response JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- hourly_weather
    CREATE TABLE IF NOT EXISTS hourly_weather (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      weather_cell_id UUID REFERENCES weather_cells(id),
      timestamp TIMESTAMPTZ,
      temperature NUMERIC,
      rainfall NUMERIC,
      wind_speed NUMERIC,
      wind_gusts NUMERIC,
      humidity NUMERIC,
      visibility NUMERIC,
      dew_point NUMERIC,
      surface_pressure NUMERIC,
      weather_code INTEGER,
      weather_description TEXT,
      is_validated BOOLEAN DEFAULT FALSE
    );

    -- philippine_arena_events
    CREATE TABLE IF NOT EXISTS philippine_arena_events (
      id INTEGER PRIMARY KEY,
      title TEXT,
      date_raw TEXT,
      start_date DATE,
      event_type TEXT,
      attendance INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      capacity INTEGER,
      venue TEXT
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_nlex_emissions_exit_id ON nlex_emissions(exit_id);
    CREATE INDEX IF NOT EXISTS idx_nlex_emissions_api_dt ON nlex_emissions(api_dt);
    CREATE INDEX IF NOT EXISTS idx_hourly_weather_cell ON hourly_weather(weather_cell_id);
    CREATE INDEX IF NOT EXISTS idx_hourly_weather_ts ON hourly_weather(timestamp);
    CREATE INDEX IF NOT EXISTS idx_nlex_exits_direction ON nlex_exits(direction);
  `;

  await client.query(ddl);
  console.log('   ✅ All 6 tables created with indexes.');
}

// ── Step 3: Export & Import ─────────────────────────────────
async function migrateTable(client, tableName, orderBy = 'id') {
  console.log(`\n📥 Migrating: ${tableName}`);

  // Get total count
  const { count, error: cntErr } = await supabase.from(tableName).select('*', { count: 'exact', head: true });
  if (cntErr) {
    console.error(`   ❌ Count error: ${cntErr.message}`);
    return 0;
  }
  console.log(`   📊 Source rows: ${count}`);

  if (count === 0) {
    console.log('   ⏭️ Empty table, skipping.');
    return 0;
  }

  let totalInserted = 0;
  const PAGE_SIZE = 1000;
  let lastId = null;
  let hasMore = true;

  while (hasMore) {
    let query = supabase.from(tableName).select('*').order(orderBy, { ascending: true }).limit(PAGE_SIZE);
    
    // Keyset pagination (must have unique sequential/sortable ID)
    if (lastId !== null) {
      query = query.gt(orderBy, lastId);
    }

    const { data, error } = await query;

    if (error) {
      console.error(`   ❌ Fetch error: ${error.message}`);
      break;
    }

    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }

    // Update lastId for next page
    lastId = data[data.length - 1][orderBy];

    // Build INSERT query
    const columns = Object.keys(data[0]);
    const quotedCols = columns.map(c => `"${c}"`).join(', ');

    // Use parameterized query in batches of 50 rows to avoid param limits
    const BATCH = 50;
    for (let b = 0; b < data.length; b += BATCH) {
      const batch = data.slice(b, b + BATCH);
      const values = [];
      const placeholders = batch.map((row, ri) => {
        const rowPlaceholders = columns.map((col, ci) => {
          values.push(row[col] !== undefined ? (typeof row[col] === 'object' && row[col] !== null ? JSON.stringify(row[col]) : row[col]) : null);
          return `$${ri * columns.length + ci + 1}`;
        });
        return `(${rowPlaceholders.join(', ')})`;
      });

      const sql = `INSERT INTO "${tableName}" (${quotedCols}) VALUES ${placeholders.join(', ')} ON CONFLICT DO NOTHING`;

      try {
        await client.query(sql, values);
        totalInserted += batch.length;
      } catch (err) {
        console.error(`   ❌ Insert error: ${err.message.substring(0, 100)}`);
      }
    }

    // Progress
    const pct = Math.round((totalInserted / count) * 100);
    process.stdout.write(`\r   ⏳ Progress: ${pct}% (${totalInserted}/${count})`);
  }

  console.log(`\n   ✅ Inserted: ${totalInserted} rows`);
  return totalInserted;
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('🚀 NLEX Capstone — Full Migration: Supabase → Local PostgreSQL\n');
  console.log('════════════════════════════════════════════════\n');

  // Step 1: Create database
  await createDatabase();

  // Step 2: Connect to nlex_capstone and create schema
  const client = new pg.Client({ ...AWS_PG, database: 'nlex_capstone' });
  await client.connect();
  await createSchema(client);

  // Step 3: Migrate tables (order matters for foreign keys)
  const results = {};

  // Parent tables first
  results['weather_cells'] = await migrateTable(client, 'weather_cells');
  results['nlex_exits'] = await migrateTable(client, 'nlex_exits');
  results['nlex_emission_factors'] = await migrateTable(client, 'nlex_emission_factors');
  results['philippine_arena_events'] = await migrateTable(client, 'philippine_arena_events');

  // Child tables (large ones)
  results['hourly_weather'] = await migrateTable(client, 'hourly_weather');
  results['nlex_emissions'] = await migrateTable(client, 'nlex_emissions');

  // Step 4: Summary
  console.log('\n\n════════════════════════════════════════════════');
  console.log('  📊 MIGRATION COMPLETE');
  console.log('════════════════════════════════════════════════');
  let total = 0;
  for (const [table, count] of Object.entries(results)) {
    console.log(`  ${table}: ${count} rows`);
    total += count;
  }
  console.log(`  ──────────────────────────`);
  console.log(`  TOTAL: ${total} rows`);
  console.log('════════════════════════════════════════════════');
  console.log(`\n  Connection string for your app:`);
  console.log(`  postgresql://postgres:REMOVED@localhost:5432/nlex_capstone\n`);

  await client.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
