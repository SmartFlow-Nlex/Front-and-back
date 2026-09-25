SELECT
  (SELECT count(*) FROM silver.nlex_accident_events_clean) AS accidents,
  (SELECT count(*) FROM silver.nlex_breakdown_events_clean) AS breakdowns,
  (SELECT count(*) FROM silver.nlex_breakdown_events_clean WHERE deployments IS NOT NULL) AS breakdowns_with_deployments,
  (SELECT count(*) FROM silver.nlex_breakdown_events_clean, jsonb_array_elements(deployments) d WHERE deployments IS NOT NULL) AS deployment_records,
  (SELECT min(event_start_date) FROM silver.nlex_accident_events_clean) AS acc_min,
  (SELECT max(event_start_date) FROM silver.nlex_accident_events_clean) AS acc_max;
