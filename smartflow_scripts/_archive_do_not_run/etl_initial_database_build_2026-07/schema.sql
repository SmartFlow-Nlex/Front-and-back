-- ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.
DO $$ BEGIN RAISE EXCEPTION 'ARCHIVED - do not run this file.'; END $$;

-- ============================================================
-- NLEX EMISSIONS — SUPABASE SCHEMA
-- Paste this ENTIRE block into your Supabase SQL Editor and click "Run"
-- Dashboard → SQL Editor → New Query → Paste → Run
-- ============================================================

-- Drop existing tables if re-running
DROP TABLE IF EXISTS nlex_emissions CASCADE;
DROP TABLE IF EXISTS nlex_emission_factors CASCADE;
DROP TABLE IF EXISTS nlex_exits CASCADE;

-- 1. NLEX Exit Points (50 total: 24 NB + 26 SB)
CREATE TABLE nlex_exits (
  id SERIAL PRIMARY KEY,
  exit_number INTEGER NOT NULL,
  exit_name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('NB', 'SB')),
  km_marker NUMERIC(5,1) NOT NULL,
  latitude NUMERIC(10,4) NOT NULL,
  longitude NUMERIC(10,4) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Vehicle Emission Factors (Class 1, 2, 3 per NLEX/TRB)
CREATE TABLE nlex_emission_factors (
  id SERIAL PRIMARY KEY,
  vehicle_class INTEGER NOT NULL CHECK (vehicle_class IN (1, 2, 3)),
  class_label TEXT NOT NULL,
  description TEXT,
  co2_g_per_km NUMERIC(10,2) NOT NULL,
  co_g_per_km NUMERIC(10,4) NOT NULL,
  no2_g_per_km NUMERIC(10,4) NOT NULL,
  pm25_g_per_km NUMERIC(10,4) NOT NULL,
  pm10_g_per_km NUMERIC(10,4) NOT NULL,
  so2_g_per_km NUMERIC(10,4) NOT NULL,
  source TEXT DEFAULT 'EURO IV/V Philippine Fleet Average',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Air Quality / Emissions Readings (time-series from API)
CREATE TABLE nlex_emissions (
  id BIGSERIAL PRIMARY KEY,
  exit_id INTEGER REFERENCES nlex_exits(id) ON DELETE CASCADE,
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

-- Indexes for fast queries
CREATE INDEX idx_nlex_emissions_exit_id ON nlex_emissions(exit_id);
CREATE INDEX idx_nlex_emissions_fetched_at ON nlex_emissions(fetched_at);
CREATE INDEX idx_nlex_exits_direction ON nlex_exits(direction);

-- Row Level Security: enable + allow public access
ALTER TABLE nlex_exits ENABLE ROW LEVEL SECURITY;
ALTER TABLE nlex_emission_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE nlex_emissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read on nlex_exits" ON nlex_exits FOR SELECT USING (true);
CREATE POLICY "Allow public read on nlex_emission_factors" ON nlex_emission_factors FOR SELECT USING (true);
CREATE POLICY "Allow public read on nlex_emissions" ON nlex_emissions FOR SELECT USING (true);

CREATE POLICY "Allow insert on nlex_exits" ON nlex_exits FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow insert on nlex_emission_factors" ON nlex_emission_factors FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow insert on nlex_emissions" ON nlex_emissions FOR INSERT WITH CHECK (true);

-- ============================================================
-- DONE! Now run: node seed.js
-- ============================================================
