-- BRONZE: philippine_arena_events
--
-- The scraped event list landed in public.philippine_arena_events, a plain
-- table, which skips the bronze layer entirely. This copies it into bronze as
-- the raw landing record so the chain is complete:
--     bronze.philippine_arena_events
--       -> silver.philippine_arena_events_clean   (conformed, de-duplicated)
--       -> the events analysis
--
-- Bronze keeps the source AS RECEIVED: no de-duplication, no filtering. The
-- case-duplicated titles and the free-text date_raw are preserved deliberately —
-- cleaning those is silver's job, and bronze must stay replayable.
--
-- public.philippine_arena_events is left in place because several views and the
-- events query still read it; retiring it is a follow-up once those are
-- repointed at silver.
--
-- Idempotent: truncate and reload.

BEGIN;

TRUNCATE bronze.philippine_arena_events RESTART IDENTITY;

INSERT INTO bronze.philippine_arena_events
  (event_name, event_date, event_time, venue, category, source, notes, recorded_at)
SELECT title,
       start_date,
       NULL,                                        -- source carries no clock time
       venue,
       event_type,
       'philippine_arena_scraper',
       date_raw,                                    -- the original human string
       COALESCE(created_at, now())
FROM public.philippine_arena_events;

COMMIT;

SELECT 'bronze.philippine_arena_events' AS table_name,
       COUNT(*)          AS rows,
       MIN(event_date)   AS from_date,
       MAX(event_date)   AS to_date
FROM bronze.philippine_arena_events;
