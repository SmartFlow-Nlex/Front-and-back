-- ---------------------------------------------------------------------------
-- nlex_mobile_config — what the SmartFlow mobile app is allowed to show.
--
-- One row, always id = 1. This is operator configuration, not warehouse data,
-- so it lives in public alongside nlex_maintenance_schedules rather than in the
-- bronze/silver/gold medallion.
--
-- The payload is jsonb rather than a column per switch because the set of
-- switches tracks the mobile app's screens, and adding a screen should not mean
-- a migration on a shared RDS instance that teammates are actively querying.
-- The shape is enforced in the API by MobileConfigSchema (zod), which is the
-- real contract — see Back-End/src/validators/mobile-config.validator.ts.
--
-- Run once:
--   psql "$POSTGRES_URL" -f Back-End/scripts/mobile-config.sql
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS nlex_mobile_config (
  -- Singleton. The CHECK is what makes it one: a second INSERT cannot invent
  -- id = 2 and leave the app with two disagreeing configurations.
  id         smallint     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  config     jsonb        NOT NULL,
  updated_at timestamptz  NOT NULL DEFAULT now(),
  updated_by text         NOT NULL DEFAULT 'dashboard'
);

-- Seed with everything switched on and no advisory posted. These defaults are
-- duplicated in the API (DEFAULT_MOBILE_CONFIG) so a mobile client still gets a
-- usable answer before this script has ever been run.
INSERT INTO nlex_mobile_config (id, config, updated_by)
VALUES (
  1,
  '{
    "features": {
      "_comment": "DERIVED from sections by the API - a tab is shown when anything inside it is. Never edit by hand.",
      "dashboard": true,
      "map": true,
      "community": true,
      "assistant": true,
      "alerts": true
    },
    "sections": {
      "dashboard": {
        "statusSummary": true,
        "segmentForecast": true,
        "corridorOutlook": true,
        "eventForecasts": true,
        "mlHotspots": true
      },
      "map": { "liveStatus": true, "forecastView": true },
      "community": { "shareUpdate": true, "reportIncident": true, "filters": true },
      "assistant": { "quickQuestions": true, "capabilities": true },
      "alerts": { "traffic": true, "maintenance": true }
    },
    "advisory": {
      "active": false,
      "tone": "info",
      "message": ""
    }
  }'::jsonb,
  'seed'
)
ON CONFLICT (id) DO NOTHING;

-- Back-fill a row created before `sections` existed. `||` merges at the top
-- level only, and the WHERE clause means an operator's existing choices are
-- never overwritten: this touches the row only when the key is absent
-- entirely. Safe to run repeatedly.
UPDATE nlex_mobile_config
SET config = config || jsonb_build_object(
      'sections', jsonb_build_object(
        'dashboard', jsonb_build_object(
          'statusSummary', true, 'segmentForecast', true, 'corridorOutlook', true,
          'eventForecasts', true, 'mlHotspots', true),
        'map', jsonb_build_object('liveStatus', true, 'forecastView', true),
        'community', jsonb_build_object('shareUpdate', true, 'reportIncident', true, 'filters', true),
        'assistant', jsonb_build_object('quickQuestions', true, 'capabilities', true),
        'alerts', jsonb_build_object('traffic', true, 'maintenance', true)
      )
    )
WHERE id = 1 AND NOT (config ? 'sections');

-- Back-fill the Assistant capabilities section for a row written before it
-- existed. Same guard as above: only touches the key when it is absent.
UPDATE nlex_mobile_config
SET config = jsonb_set(
      config, '{sections,assistant,capabilities}', 'true'::jsonb, true)
WHERE id = 1 AND NOT (config -> 'sections' -> 'assistant' ? 'capabilities');
