-- schema.sql
-- DDL for NLEX SmartFlow Database Live Waze Ingestion

-- Enable the PostGIS spatial extension if not already enabled
CREATE EXTENSION IF NOT EXISTS postgis;

-- -----------------------------------------------------
-- 1. Dim Tables (Stubs if not already created in your DB)
-- -----------------------------------------------------

-- Dimension: Time
CREATE TABLE IF NOT EXISTS dim_time (
    time_id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL UNIQUE,
    hour_of_day INT NOT NULL,
    day_of_week VARCHAR(15) NOT NULL,
    month INT NOT NULL,
    year INT NOT NULL,
    is_weekend BOOLEAN NOT NULL,
    is_holiday BOOLEAN NOT NULL
);

-- Dimension: Weather
CREATE TABLE IF NOT EXISTS dim_weather (
    weather_id SERIAL PRIMARY KEY,
    weather_condition VARCHAR(100),
    temperature_celsius NUMERIC(4, 1),
    rainfall_intensity NUMERIC(5, 2), -- mm/h
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Dimension: Location (NLEX Segments / Exits)
CREATE TABLE IF NOT EXISTS dim_location (
    location_id SERIAL PRIMARY KEY,
    segment_name VARCHAR(100) NOT NULL UNIQUE, -- e.g. "Km 16+800", "Balintawak Toll Plaza"
    start_node VARCHAR(50),
    end_node VARCHAR(50),
    street VARCHAR(255),
    city VARCHAR(100),
    geo_coordinate VARCHAR(100), -- coordinates string representation if needed
    total_plaza_name VARCHAR(100),
    geom GEOMETRY(LineString, 4326) -- Spatial representation of the highway segment
);

-- Dimension: Incident Type (Classification)
CREATE TABLE IF NOT EXISTS dim_incident_type (
    incident_type_id SERIAL PRIMARY KEY,
    category VARCHAR(100) NOT NULL, -- e.g. ACCIDENT, HAZARD, JAM, ROAD_CLOSED
    severity_level VARCHAR(50),     -- e.g. MAJOR, MINOR, MODERATE
    report_source VARCHAR(100) DEFAULT 'Waze Partner Hub',
    CONSTRAINT unique_category_severity UNIQUE (category, severity_level, report_source)
);

-- -----------------------------------------------------
-- 2. Staging Tables (Bronze Layer)
-- -----------------------------------------------------

-- Staging table for raw alert payloads
CREATE TABLE IF NOT EXISTS bronze_waze_alerts (
    id SERIAL PRIMARY KEY,
    raw_data JSONB NOT NULL,
    ingested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Staging table for raw jam payloads
CREATE TABLE IF NOT EXISTS bronze_waze_jams (
    id SERIAL PRIMARY KEY,
    raw_data JSONB NOT NULL,
    ingested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- -----------------------------------------------------
-- 3. Fact Tables (Silver Layer)
-- -----------------------------------------------------

-- Fact Table: Incident Log (Stores Waze Alerts / Incidents)
CREATE TABLE IF NOT EXISTS fact_incident_log (
    incident_log_id VARCHAR(100) PRIMARY KEY, -- Waze uuid
    time_id INT REFERENCES dim_time(time_id),
    weather_id INT REFERENCES dim_weather(weather_id),
    location_id INT REFERENCES dim_location(location_id),
    incident_type_id INT REFERENCES dim_incident_type(incident_type_id),
    mttc_minutes NUMERIC(8,2), -- Mean Time to Clear
    incident_duration_minutes NUMERIC(8,2), -- Total duration of active incident
    impact_length_km NUMERIC(6,3),
    is_active BOOLEAN DEFAULT TRUE,
    first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    cleared_at TIMESTAMP WITH TIME ZONE,
    street VARCHAR(255),
    city VARCHAR(100),
    report_description TEXT,
    reliability INT,
    confidence INT,
    geom GEOMETRY(Point, 4326) -- PostGIS Point geometry (SRID 4326 - WGS 84)
);

-- Fact Table: Waze Jams (Stores Waze Congestion Segments)
CREATE TABLE IF NOT EXISTS fact_waze_jams (
    jam_id VARCHAR(100) PRIMARY KEY, -- Waze jam uuid
    time_id INT REFERENCES dim_time(time_id),
    location_id INT REFERENCES dim_location(location_id),
    street VARCHAR(255),
    city VARCHAR(100),
    level INT, -- Jam level (1-5)
    speed_kmh NUMERIC(6,2),
    length_meters INT,
    delay_seconds INT,
    is_active BOOLEAN DEFAULT TRUE,
    first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    cleared_at TIMESTAMP WITH TIME ZONE,
    geom GEOMETRY(LineString, 4326) -- PostGIS LineString geometry (SRID 4326 - WGS 84)
);

-- -----------------------------------------------------
-- 4. Spatial and Performance Indexes
-- -----------------------------------------------------

-- Spatial Indexes (GIST) for geometry columns (Critical for distance / intersection queries)
CREATE INDEX IF NOT EXISTS idx_location_geom ON dim_location USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_incident_log_geom ON fact_incident_log USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_waze_jams_geom ON fact_waze_jams USING GIST (geom);

-- B-Tree Indexes for relational lookups
CREATE INDEX IF NOT EXISTS idx_incident_log_active ON fact_incident_log(is_active);
CREATE INDEX IF NOT EXISTS idx_waze_jams_active ON fact_waze_jams(is_active);
CREATE INDEX IF NOT EXISTS idx_incident_log_last_seen ON fact_incident_log(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_waze_jams_last_seen ON fact_waze_jams(last_seen_at);
