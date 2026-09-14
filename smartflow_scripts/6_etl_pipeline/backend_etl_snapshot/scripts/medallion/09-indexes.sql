-- Expression indexes matching the predicates the dashboard actually uses.
--
-- After the move to silver, cold analytics requests took 11-21 seconds and
-- occasionally tripped the service's error path, which the UI reports as
-- "Live data unavailable". The silver tables had indexes on the raw columns,
-- but every dashboard filter is an EXPRESSION over those columns, so none of
-- them could be used:
--
--   WHERE timestamp_utc::date BETWEEN ...                       (4.6M rows, 12.4s)
--   WHERE (recorded_at AT TIME ZONE 'Asia/Manila')::date BETWEEN  (977k rows, 3.4s)
--
-- An index on timestamp_utc does not serve a filter on timestamp_utc::date.
-- These indexes match the expressions exactly.
--
-- CONCURRENTLY is deliberately not used: it cannot run inside a transaction,
-- and these tables are rebuilt by 06 anyway, so a brief lock is acceptable.

-- 4.6M rows, the single biggest cost on the sustainability tab.
CREATE INDEX IF NOT EXISTS ix_silver_te_date
  ON silver.nlex_theoretical_emissions_clean ((timestamp_utc::date));

-- Supports the per-class daily rollup without re-reading the whole year.
CREATE INDEX IF NOT EXISTS ix_silver_te_date_class
  ON silver.nlex_theoretical_emissions_clean ((timestamp_utc::date), vehicle_class);

-- Measured AQI: the monthly histogram and the KPI both filter on the local date.
-- timezone(text, timestamptz) is immutable, so the whole expression is indexable.
CREATE INDEX IF NOT EXISTS ix_silver_emissions_local_date
  ON silver.nlex_emissions_clean (((recorded_at AT TIME ZONE 'Asia/Manila')::date));

-- Traffic volume matview: the analytics filter is on date + type + class.
CREATE INDEX IF NOT EXISTS ix_ntv_date_type_class
  ON public.nlex_traffic_volume (date, type, vehicle_class);

ANALYZE silver.nlex_theoretical_emissions_clean;
ANALYZE silver.nlex_emissions_clean;
ANALYZE silver.nlex_traffic_volume_clean;
ANALYZE public.nlex_traffic_volume;

SELECT schemaname, tablename, indexname
FROM pg_indexes
WHERE indexname IN ('ix_silver_te_date','ix_silver_te_date_class',
                    'ix_silver_emissions_local_date','ix_ntv_date_type_class')
ORDER BY tablename, indexname;
