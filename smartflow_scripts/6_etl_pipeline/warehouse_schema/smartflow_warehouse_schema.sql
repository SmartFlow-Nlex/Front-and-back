-- =====================================================================
-- SmartFlow NLEX — Data Warehouse DDL
-- Fact Constellation Schema (Manuscript §3.10) on PostgreSQL + PostGIS
-- Medallion layers: bronze (raw) / silver (modeled warehouse) / gold (datamart)
-- Target: PostgreSQL 15+ with PostGIS 3.x  (Supabase-compatible)
--
-- This is a starting reference. Column names follow the manuscript where it
-- gives them; adjust to your real source-file headers as you wire the ETL.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Extensions & schemas (medallion architecture, §3.9)
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- helps fuzzy text matching during cleaning

CREATE SCHEMA IF NOT EXISTS bronze;  -- immutable raw archive (source-fidelity)
CREATE SCHEMA IF NOT EXISTS silver;  -- validated, modeled warehouse (this file's focus)
CREATE SCHEMA IF NOT EXISTS gold;    -- query-optimized datamart for dashboard + RAG


-- =====================================================================
-- 1. DIMENSION TABLES (silver) — the six shared dimensions (§3.10)
-- =====================================================================

-- 1.1 dim_location — spatial backbone for the map + prescriptive routing (§3.10.1)
--     Holds toll exits / interchange nodes (points) and segments (lines).
CREATE TABLE silver.dim_location (
    location_key        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    segment_id          TEXT,                         -- e.g. 'SEG-BALINTAWAK-MEYCAUAYAN'
    segment_name        TEXT,
    toll_exit_name      TEXT,                         -- e.g. 'Balintawak', 'Sta. Ines'
    km_marker           TEXT,                         -- human label, e.g. 'KM 16+800'
    km_value            NUMERIC(7,3),                 -- numeric km for ordering/joins
    direction           TEXT CHECK (direction IN ('NB','SB','BOTH')),
    lane_designation    TEXT,
    interchange_node    TEXT,
    geom_type           TEXT CHECK (geom_type IN ('POINT','LINESTRING')),
    geom                geometry(Geometry, 4326),     -- SRID 4326 (WGS84); point or line
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1.2 dim_time — temporal hierarchy for LSTM seasonal/hourly peaks (§3.10.2)
--     Grain = one row per hour. Pre-populate for your full 5-yr range + horizon.
--     Daily-only NLEX records map to hour 0 of the date (see note in chat).
CREATE TABLE silver.dim_time (
    time_key            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts                  TIMESTAMPTZ NOT NULL UNIQUE,  -- the exact hour bucket
    full_date           DATE NOT NULL,
    year                SMALLINT NOT NULL,
    quarter             SMALLINT NOT NULL,
    month               SMALLINT NOT NULL,
    month_name          TEXT NOT NULL,
    day                 SMALLINT NOT NULL,
    day_of_week         SMALLINT NOT NULL,            -- 1=Mon ... 7=Sun
    day_name            TEXT NOT NULL,
    hour                SMALLINT NOT NULL,            -- 0..23
    is_weekend          BOOLEAN NOT NULL,
    is_holiday          BOOLEAN NOT NULL DEFAULT FALSE,
    holiday_name        TEXT,
    is_peak             BOOLEAN NOT NULL DEFAULT FALSE,
    peak_period         TEXT CHECK (peak_period IN ('AM_PEAK','PM_PEAK','OFF_PEAK'))
);

-- 1.3 dim_vehicle_class — fleet descriptions + emission factors (§3.10.3)
--     Effective-dated so historical emissions stay accurate when API factors change.
CREATE TABLE silver.dim_vehicle_class (
    vehicle_class_key   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    class_code          TEXT NOT NULL,                -- 'Class 1' | 'Class 2' | 'Class 3'
    description         TEXT,
    axle_count          SMALLINT,
    emission_factor     NUMERIC(10,4),                -- CO2 g/km   (EF_API_class)
    idle_emission_factor NUMERIC(10,4),               -- CO2 g/min idling (EF_API_idle)
    effective_from      DATE NOT NULL DEFAULT '2020-01-01',
    effective_to        DATE,                         -- NULL = current
    is_current          BOOLEAN NOT NULL DEFAULT TRUE
);

-- 1.4 dim_weather — rainfall/temperature for weather-conditioned incident prob (§3.10.4)
CREATE TABLE silver.dim_weather (
    weather_key         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_code      TEXT,                         -- normalized code
    condition_label     TEXT,                         -- 'Clear','Light Rain','Heavy Rain'...
    rainfall_mm         NUMERIC(7,2),
    temperature_c       NUMERIC(5,2),
    humidity_pct        NUMERIC(5,2),
    wind_speed_kph      NUMERIC(6,2),
    visibility_km       NUMERIC(6,2),
    source              TEXT                          -- e.g. 'OpenWeather'
);

-- 1.5 dim_external_events — scheduled ticketing data for event-driven surges (§3.10.5)
CREATE TABLE silver.dim_external_events (
    event_key           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_name          TEXT,
    venue               TEXT,                         -- e.g. 'Philippine Arena'
    venue_capacity      INTEGER,
    event_type          TEXT,                         -- concert, sports, etc.
    est_attendance      INTEGER,                      -- generalized estimate (§1.5.2.c)
    event_date          DATE,
    start_time          TIME,
    end_time            TIME,
    source              TEXT                          -- e.g. 'SM Tickets'
);

-- 1.6 dim_incident_type — severity + reporting source for cross-validation (§3.10.6)
CREATE TABLE silver.dim_incident_type (
    incident_type_key   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category            TEXT CHECK (category IN ('CRASH','STALL','APPREHENSION','OTHER')),
    severity_level      TEXT CHECK (severity_level IN ('LOW','MODERATE','HIGH','CRITICAL')),
    reporting_source    TEXT CHECK (reporting_source IN ('NLEX','WAZE','COMMUNITY')),
    description         TEXT
);


-- =====================================================================
-- 2. FACT TABLES (silver) — two central facts (§3.10)
--    Kept separate so continuous forecasting is not corrupted by discrete crashes.
-- =====================================================================

-- 2.1 fact_traffic_volume — continuous operational metrics (§3.10)
--     Grain: one row per (location, time-bucket, vehicle_class, direction).
CREATE TABLE silver.fact_traffic_volume (
    traffic_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- foreign keys
    time_key            BIGINT NOT NULL REFERENCES silver.dim_time(time_key),
    location_key        BIGINT NOT NULL REFERENCES silver.dim_location(location_key),
    vehicle_class_key   BIGINT NOT NULL REFERENCES silver.dim_vehicle_class(vehicle_class_key),
    weather_key         BIGINT REFERENCES silver.dim_weather(weather_key),
    event_key           BIGINT REFERENCES silver.dim_external_events(event_key),
    -- measures
    total_vehicle_count INTEGER,
    average_speed_kph   NUMERIC(6,2),
    flow_rate           NUMERIC(10,2),                -- veh/hr
    density             NUMERIC(10,2),                -- veh/km
    congestion_index    NUMERIC(6,3),
    vc_ratio            NUMERIC(6,3),                 -- Volume-to-Capacity (KPI §2.1.10.1)
    adt                 NUMERIC(12,2),                -- Average Daily Traffic (§3.9.3.2)
    exit_traffic_share  NUMERIC(6,3),                 -- S_exit % (§3.9.3.2)
    vdi                 NUMERIC(8,4),                 -- Volume Deviation Index (§3.9.3.2)
    segment_distance_km NUMERIC(7,3),
    co2_baseline_kg     NUMERIC(12,4),               -- E_baseline (§3.9.3.2.d)
    is_anomaly          BOOLEAN DEFAULT FALSE,        -- VDI threshold flag
    load_batch_id       BIGINT,                       -- traceability to ETL run
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2.2 fact_incident_log — discrete anomalies, MTTC + impact length (§3.10)
--     Grain: one row per incident.
CREATE TABLE silver.fact_incident_log (
    incident_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- foreign keys
    time_key            BIGINT NOT NULL REFERENCES silver.dim_time(time_key),  -- reported hour
    location_key        BIGINT NOT NULL REFERENCES silver.dim_location(location_key),
    incident_type_key   BIGINT NOT NULL REFERENCES silver.dim_incident_type(incident_type_key),
    weather_key         BIGINT REFERENCES silver.dim_weather(weather_key),
    vehicle_class_key   BIGINT REFERENCES silver.dim_vehicle_class(vehicle_class_key),
    -- measures / attributes
    time_reported       TIMESTAMPTZ NOT NULL,
    time_cleared        TIMESTAMPTZ,
    mttc_minutes        NUMERIC(8,2),                 -- Mean Time To Clear (KPI §2.1.10.2)
    impact_length_km    NUMERIC(7,3),
    lanes_blocked       SMALLINT,
    vehicles_involved   SMALLINT,
    casualties          SMALLINT,
    accident_cause      TEXT,
    pavement_type       TEXT,
    assistance_rendered TEXT,
    idling_penalty_co2_kg NUMERIC(12,4),              -- E_penalty (§3.9.3.2.d)
    incident_geom       geometry(Point, 4326),        -- exact incident coordinate
    load_batch_id       BIGINT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =====================================================================
-- 3. MODEL OUTPUT & FEEDBACK TABLES (silver) — MLOps retraining loop (§3.9.4)
--    "Feedback and Model Output Tables ... enabling continuous retraining."
-- =====================================================================

-- 3.1 Forecast outputs from upstream models (LSTM volume, XGBoost delay, etc.)
CREATE TABLE silver.fact_model_forecast (
    forecast_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_name          TEXT NOT NULL,                -- 'LSTM','XGBoost','SARIMAX'...
    model_version       TEXT NOT NULL,
    location_key        BIGINT REFERENCES silver.dim_location(location_key),
    target_time_key     BIGINT REFERENCES silver.dim_time(time_key),  -- forecasted hour
    forecast_made_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    horizon_hours       SMALLINT,
    predicted_value     NUMERIC(14,4),
    lower_bound         NUMERIC(14,4),                -- e.g. QRF quantile
    upper_bound         NUMERIC(14,4),
    actual_value        NUMERIC(14,4),                -- backfilled for error scoring
    load_batch_id       BIGINT
);

-- 3.2 Model performance log feeding the MAPE/RMSE display + retraining gate (FR-08, R04)
CREATE TABLE silver.model_performance (
    perf_id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_name          TEXT NOT NULL,
    model_version       TEXT NOT NULL,
    evaluated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    metric_name         TEXT CHECK (metric_name IN ('MAPE','RMSE','MASE','MAE')),
    metric_value        NUMERIC(12,5),
    rag_status          TEXT CHECK (rag_status IN ('GREEN','AMBER','RED')),
    holdout_window      TEXT,
    triggered_retrain   BOOLEAN DEFAULT FALSE
);


-- =====================================================================
-- 4. INDEXES — spatial (GIST) + foreign keys + common query paths
-- =====================================================================
-- Spatial
CREATE INDEX idx_dim_location_geom       ON silver.dim_location      USING GIST (geom);
CREATE INDEX idx_incident_geom           ON silver.fact_incident_log USING GIST (incident_geom);

-- Dimension lookups
CREATE INDEX idx_dim_time_ts             ON silver.dim_time (ts);
CREATE INDEX idx_dim_time_date           ON silver.dim_time (full_date);
CREATE INDEX idx_vehicle_class_current   ON silver.dim_vehicle_class (class_code) WHERE is_current;

-- Fact foreign keys (Postgres does not auto-index FKs)
CREATE INDEX idx_ftv_time                ON silver.fact_traffic_volume (time_key);
CREATE INDEX idx_ftv_location            ON silver.fact_traffic_volume (location_key);
CREATE INDEX idx_ftv_loc_time            ON silver.fact_traffic_volume (location_key, time_key);
CREATE INDEX idx_fil_time                ON silver.fact_incident_log (time_key);
CREATE INDEX idx_fil_location            ON silver.fact_incident_log (location_key);
CREATE INDEX idx_fil_type                ON silver.fact_incident_log (incident_type_key);
CREATE INDEX idx_forecast_target         ON silver.fact_model_forecast (model_name, target_time_key);


-- =====================================================================
-- 5. GOLD DATAMART — pre-computed summaries for dashboard + RAG (§3.9.4)
--    Implements the manuscript's exact formulas as materialized views.
-- =====================================================================

-- 5.1 Average Daily Traffic per exit & class, plus corridor share (§3.9.3.2.c)
CREATE MATERIALIZED VIEW gold.mv_adt_by_exit AS
SELECT
    l.toll_exit_name,
    l.direction,
    vc.class_code,
    t.full_date,
    SUM(f.total_vehicle_count)                                  AS daily_volume,
    AVG(f.average_speed_kph)                                    AS avg_speed_kph,
    SUM(f.co2_baseline_kg)                                      AS daily_co2_kg
FROM silver.fact_traffic_volume f
JOIN silver.dim_location      l  ON l.location_key      = f.location_key
JOIN silver.dim_vehicle_class vc ON vc.vehicle_class_key = f.vehicle_class_key
JOIN silver.dim_time          t  ON t.time_key           = f.time_key
GROUP BY l.toll_exit_name, l.direction, vc.class_code, t.full_date
WITH NO DATA;

-- 5.2 Corridor volume per direction per day (§3.9.3.2)
CREATE MATERIALIZED VIEW gold.mv_corridor_volume AS
SELECT
    l.direction,
    t.full_date,
    SUM(f.total_vehicle_count) AS corridor_volume
FROM silver.fact_traffic_volume f
JOIN silver.dim_location l ON l.location_key = f.location_key
JOIN silver.dim_time     t ON t.time_key     = f.time_key
GROUP BY l.direction, t.full_date
WITH NO DATA;

-- 5.3 Incident KPI rollup: MTTC by type for the operator dashboard (KPI §3.6.2)
CREATE MATERIALIZED VIEW gold.mv_incident_kpi AS
SELECT
    it.category,
    t.full_date,
    COUNT(*)                       AS incident_count,
    AVG(i.mttc_minutes)            AS avg_mttc_minutes,
    AVG(i.impact_length_km)        AS avg_impact_km,
    SUM(i.idling_penalty_co2_kg)   AS total_idling_co2_kg
FROM silver.fact_incident_log i
JOIN silver.dim_incident_type it ON it.incident_type_key = i.incident_type_key
JOIN silver.dim_time          t  ON t.time_key            = i.time_key
GROUP BY it.category, t.full_date
WITH NO DATA;

-- Refresh pattern (call from the Load step after each ETL batch):
--   REFRESH MATERIALIZED VIEW gold.mv_adt_by_exit;
--   REFRESH MATERIALIZED VIEW gold.mv_corridor_volume;
--   REFRESH MATERIALIZED VIEW gold.mv_incident_kpi;
