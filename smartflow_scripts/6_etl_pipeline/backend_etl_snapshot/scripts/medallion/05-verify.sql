-- MEDALLION VERIFICATION
--
-- Read-only. Run after 01-04 to confirm the layers are populated, the lineage
-- reconciles, and no layer contains data the layer below contradicts.
--   psql "$POSTGRES_URL" -f Back-End/scripts/medallion/05-verify.sql

\echo '== 1. Layer population =='
SELECT 'bronze' AS layer, relname AS table_name,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT COUNT(*) AS c FROM bronze.%I', relname),
                           false, true, '')))[1]::text::bigint AS rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'bronze' AND c.relkind = 'r'
UNION ALL
SELECT 'silver', relname,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT COUNT(*) AS c FROM silver.%I', relname),
                           false, true, '')))[1]::text::bigint
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'silver' AND c.relkind = 'r'
UNION ALL
SELECT 'gold', relname,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT COUNT(*) AS c FROM gold.%I', relname),
                           false, true, '')))[1]::text::bigint
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'gold' AND c.relkind = 'r'
ORDER BY 1, 2;

\echo ''
\echo '== 2. Bronze uniqueness (must all be 0) =='
SELECT 'traffic_volume dup keys' AS check,
       COUNT(*) AS violations
FROM (SELECT 1 FROM bronze.nlex_traffic_volume
      GROUP BY toll_plaza, date_day, hour_of_day, direction HAVING COUNT(*) > 1) q
UNION ALL
SELECT 'emissions dup (exit, api_dt)',
       COUNT(*)
FROM (SELECT 1 FROM bronze.nlex_emissions
      GROUP BY exit_id, api_dt HAVING COUNT(*) > 1) q;

\echo ''
\echo '== 3. Silver derives from bronze: row counts reconcile =='
SELECT 'emissions' AS dataset,
       (SELECT COUNT(*) FROM bronze.nlex_emissions)      AS bronze_rows,
       (SELECT COUNT(*) FROM silver.nlex_emissions_clean) AS silver_rows,
       (SELECT COUNT(*) FROM bronze.nlex_emissions)
         - (SELECT COUNT(*) FROM silver.nlex_emissions_clean) AS dropped_by_cleaning
UNION ALL
SELECT 'weather',
       (SELECT COUNT(*) FROM public.hourly_weather),
       (SELECT COUNT(*) FROM silver.hourly_weather_clean),
       (SELECT COUNT(*) FROM public.hourly_weather)
         - (SELECT COUNT(*) FROM silver.hourly_weather_clean)
UNION ALL
SELECT 'arena events',
       (SELECT COUNT(*) FROM bronze.philippine_arena_events),
       (SELECT COUNT(*) FROM silver.philippine_arena_events_clean),
       (SELECT COUNT(*) FROM bronze.philippine_arena_events)
         - (SELECT COUNT(*) FROM silver.philippine_arena_events_clean);

\echo ''
\echo '== 4. Gold aggregates reconcile against silver (drift must be ~0) =='
SELECT 'emissions readings' AS metric,
       (SELECT COUNT(*) FROM silver.nlex_emissions_clean)          AS silver_value,
       (SELECT SUM(reading_count) FROM gold.daily_emissions_summary) AS gold_value,
       (SELECT COUNT(*) FROM silver.nlex_emissions_clean)
         - (SELECT SUM(reading_count) FROM gold.daily_emissions_summary) AS drift;

SELECT 'total rainfall (mm)' AS metric,
       ROUND((SELECT SUM(rain_1h) FROM silver.hourly_weather_clean)::numeric, 1) AS silver_value,
       ROUND((SELECT SUM(total_rain) FROM gold.daily_weather_summary)::numeric, 1) AS gold_value;

\echo ''
\echo '== 5. Silver cleaning rules actually held =='
SELECT 'emissions AQI out of 1..5'  AS rule, COUNT(*) AS violations FROM silver.nlex_emissions_clean WHERE aqi NOT BETWEEN 1 AND 5
UNION ALL
SELECT 'emissions negative pollutant', COUNT(*) FROM silver.nlex_emissions_clean
  WHERE COALESCE(co,0)<0 OR COALESCE(no2,0)<0 OR COALESCE(pm2_5,0)<0 OR COALESCE(pm10,0)<0
UNION ALL
SELECT 'weather temp out of -20..60', COUNT(*) FROM silver.hourly_weather_clean WHERE temp IS NOT NULL AND temp NOT BETWEEN -20 AND 60
UNION ALL
SELECT 'weather humidity out of 0..100', COUNT(*) FROM silver.hourly_weather_clean WHERE humidity IS NOT NULL AND humidity NOT BETWEEN 0 AND 100
UNION ALL
SELECT 'weather negative rain', COUNT(*) FROM silver.hourly_weather_clean WHERE rain_1h < 0
UNION ALL
SELECT 'silver events duplicated per date', COUNT(*) FROM (
  SELECT 1 FROM silver.philippine_arena_events_clean
  GROUP BY event_date, lower(btrim(event_name)) HAVING COUNT(*) > 1) q;

\echo ''
\echo '== 6. Serving layer matches the exit reference =='
SELECT 'plazas in serving matview' AS check, COUNT(DISTINCT toll_plaza)::text AS value FROM nlex_traffic_volume
UNION ALL
SELECT 'exits in nlex_exits', COUNT(*)::text FROM nlex_exits
UNION ALL
SELECT 'exits WITHOUT volume', string_agg(x.exit_name, ', ' ORDER BY x.exit_id)
FROM nlex_exits x
WHERE NOT EXISTS (SELECT 1 FROM nlex_traffic_volume t WHERE t.toll_plaza = x.exit_name);

\echo ''
\echo '== 7. Arena events resolve to a plaza with volume =='
SELECT x.exit_name AS venue_exit,
       COUNT(*) AS events,
       EXISTS (SELECT 1 FROM nlex_traffic_volume t WHERE t.toll_plaza = x.exit_name) AS has_volume
FROM philippine_arena_events e
JOIN nlex_exits x ON x.exit_id = e.nlex_exit_id
GROUP BY 1 ORDER BY 2 DESC;
