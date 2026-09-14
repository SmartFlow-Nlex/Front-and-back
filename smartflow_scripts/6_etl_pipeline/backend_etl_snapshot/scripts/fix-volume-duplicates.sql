-- Cleans the duplicated rows in bronze.nlex_traffic_volume and rebuilds the
-- public matview so the whole dashboard uses the rebuilt exit naming.
--
-- WHY THIS EXISTS
--   bronze.nlex_traffic_volume was reloaded with the new exit-based names
--   (Cdv/Ph Arena, Bocaue Interchange, Dau, ...), but three plazas — Pulilan,
--   San Simon and Sta. Ines — were loaded TWICE. Every duplicate is a
--   value-identical copy: 122,736 duplicate groups per plaza, none differing.
--
--   The nlex_traffic_volume matview SUMs its source, so refreshing it without
--   cleaning first would silently DOUBLE those three plazas:
--       Pulilan     194,071,508  ->  should be   97,035,754
--       San Simon   194,071,508  ->  should be   97,035,754
--       Sta. Ines   129,381,484  ->  should be   64,690,742
--
--   The matview is also still stale: it holds the OLD plaza names and has no
--   Cdv/Ph Arena series at all, which is why the volume charts and the map
--   exit list disagree.
--
-- WHAT IT DOES
--   1. Refuses to run if any duplicate group holds differing values.
--   2. Deletes the extra copies, keeping the lowest id per
--      (toll_plaza, date_day, hour_of_day, direction).
--   3. Verifies rows == distinct keys, and rolls back if not.
--   4. Refreshes the matview.
--
-- HOW TO RUN
--   psql "$POSTGRES_URL" -f Back-End/scripts/fix-volume-duplicates.sql
--   ...or paste it into pgAdmin / DBeaver against nlex_capstone.
--
-- The application does NOT depend on this: the events query already
-- de-duplicates at read time against bronze. Running this makes every other
-- volume chart use the new exit naming too, and makes the matview correct.

BEGIN;

-- 1. Safety gate — abort if duplicates are not value-identical.
DO $$
DECLARE
  conflicting int;
BEGIN
  SELECT COUNT(*) INTO conflicting FROM (
    SELECT toll_plaza, date_day, hour_of_day, direction
    FROM bronze.nlex_traffic_volume
    GROUP BY 1, 2, 3, 4
    HAVING COUNT(*) > 1
       AND (COUNT(DISTINCT total_volume)  > 1
         OR COUNT(DISTINCT volume_class1) > 1
         OR COUNT(DISTINCT volume_class2) > 1
         OR COUNT(DISTINCT volume_class3) > 1)
  ) q;

  IF conflicting > 0 THEN
    RAISE EXCEPTION
      'Aborting: % duplicate group(s) hold different values. These are not safe to auto-deduplicate — inspect them first.',
      conflicting;
  END IF;
END $$;

-- 2. Delete the extra copies, keeping the earliest row of each group.
DELETE FROM bronze.nlex_traffic_volume b
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY toll_plaza, date_day, hour_of_day, direction
           ORDER BY id
         ) AS rn
  FROM bronze.nlex_traffic_volume
) d
WHERE b.id = d.id
  AND d.rn > 1;

-- 3. Verify the table is now one row per key.
DO $$
DECLARE
  n_rows bigint;
  n_keys bigint;
BEGIN
  SELECT COUNT(*),
         COUNT(DISTINCT (toll_plaza, date_day, hour_of_day, direction))
    INTO n_rows, n_keys
  FROM bronze.nlex_traffic_volume;

  IF n_rows <> n_keys THEN
    RAISE EXCEPTION 'Aborting: still duplicated after delete (rows=%, keys=%).', n_rows, n_keys;
  END IF;

  RAISE NOTICE 'bronze.nlex_traffic_volume clean: % rows', n_rows;
END $$;

COMMIT;

-- 4. Rebuild the matview the dashboard reads. Outside the transaction because
--    REFRESH takes its own lock and is slow on this table.
REFRESH MATERIALIZED VIEW nlex_traffic_volume;

-- 5. Confirm the new naming, including the Philippine Arena's own exit.
SELECT toll_plaza, COUNT(*) AS rows
FROM nlex_traffic_volume
GROUP BY 1
ORDER BY 1;
