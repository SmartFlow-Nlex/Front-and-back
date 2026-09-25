# Incident response analysis

Analysis behind the Incident Prescriptive tab's response-strategy recommendation
(run 2026-09-25). The scripts print to the console and save no output files.

Inputs: accident_data_*.csv and breakdown_data_*.csv, 2022 to 2026-06-30, in
D:/OneDrive_2026-09-08/shared files/ (path is hard-coded at the top of each
Python script; change `src` if the files move). Needs pandas and numpy (both in
../../requirements.txt). 00_db_check.sql is read-only; run it with
Back-End/scripts/run-sql.ts. It confirmed the warehouse matches the CSVs:
21,804 accidents, 156,901 breakdowns, 51,539 dispatch records.

| Script | What it does |
|---|---|
| 00_db_check.sql | Row counts in silver.nlex_accident_events_clean and silver.nlex_breakdown_events_clean, including dispatch records |
| 01_profile_columns.py | Columns, null shares, category counts for both CSV sets |
| 02_accident_clearance.py | Accident blockage and site clearance times and units sent, by severity, type, weather, detection and hour |
| 03_breakdown_response.py | Parses the deployments field the way the ETL does; cleaned response and service times by service, year, hour, direction, location, cause and 10 km segment |
| 04_response_zero_and_segments.py | What zero-minute responses are; segment by peak-hour effects; time a unit is engaged; dispatches per hour and per day |
| 05_outcome_tests.py | Whether response speed links to outcomes (takes several minutes to run) |

## Main results

- Breakdown dispatch response (over 0 min, up to 240): median 22 min, p90 52; 71% arrive within 30 min; no improvement from 2022 to 2026. Km 0-20 is the slowest, 31 min median in the PM peak.
- Zero-minute responses (6,379) are patrol vehicles that found the incident themselves; report them separately.
- Accidents have no per-unit response times. Units sent (median): damage-only 0, injury 4, fatal 7. Site clearance (median): 4, 40 and 83 min.
- Accidents near a site that is still uncleared (same direction, within 2 km) occur at about 2.0x the rate of the same-length window after it clears (95% CI 1.8-2.3).
- Accidents near a stalled vehicle waiting for a responder are not more frequent than before it stalled (rate ratio 0.86, CI 0.76-0.97), so no crash benefit from faster breakdown response is shown.
- More units sent goes with longer clearance within each severity, but bigger incidents get more units, so this does not show that units slow or speed clearance.

## Caveats

- Observational; not adjusted for weather or traffic.
- Corrupt values exist (response times up to 10.5 million minutes; one row dated 2029). Scripts cap or exclude them.
- About 30% of accidents have BlockageCleared equal to the start time (no blockage, not fast clearing); 748 have negative durations.
- Not in the data: fleet size, unit or base locations, police or ambulance arrival for accidents.
