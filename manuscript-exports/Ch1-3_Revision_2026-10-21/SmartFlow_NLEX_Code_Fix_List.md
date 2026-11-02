# SmartFlow NLEX: Code Fixes Needed Before Chapter 3 Is Final

*Prepared 31 October 2026 from a read-only audit of every threshold, KPI and baseline the system shows. Nothing in the code or database was changed.*

The team decided that where the system and the intended method disagree, the **code is fixed first**. The revised Chapter 3 describes the behaviour in the "Should do" column. Until a fix is merged, the manuscript and the system disagree on that item. Tick each item when it is merged, so the manuscript can be checked against the system again.

Paths are relative to the repository root. BE = `Back-End/src`, FE = `Front-End-Dashboard`, AS = `All_Scripts/Predictive_Modeling`, SS = `smartflow_scripts/3_training_testing`, IMS = `Back-End/incident_model_scripts`.

## A. Behaviour that contradicts the method (fix in code)

| # | Area | Where | Does now | Should do (what Chapter 3 states) | Done |
|---|---|---|---|---|---|
| A1 | Event surge baseline | BE services/traffic.service.ts:833-842, 866-873, 983-988 | Dated forecast: weekday-month median over **all** days, events and holidays included. Default view: **90-day mean**. | Use the training baseline in both views: the weekday-month median **excluding** event and holiday days, the same as AS/build_event_surge.py. | ☐ |
| A2 | Fuzzy advisory input | BE services/traffic-prescriptive.service.ts:691-714 | Input is the winning label's probability, or 1 − that probability (for a Medium cell this is p_low + p_high). | Input is the stored **p_high** (probability of High congestion). | ☑ (done, checked 2 Nov) |
| A3 | Fuzzy advisory horizon | traffic-prescriptive.service.ts:238-259, 691-714; FE PrescriptiveTrafficPanels.tsx:583-586 | The "hours ahead" memberships are all 0 at 18 h or more, so later hours always score Monitor, while the banner says 12 h. | Query only forecast hours **1–12 h** ahead, which is what the banner already says. | ☐ |
| A4 | Congestion model serving | AS/train_congestion_horizon.py:766-781 | Serves the top-accuracy model even when it fails the acceptance gate. | Serve a model only if it is **accepted** (beats majority class, persistence and the exit-hour profile). Otherwise serve the exit-hour profile and label it as such. | ☐ |
| A5 | Booth staffing forecast | BE services/traffic-prescriptive.service.ts:437-447 | Falls back to an **unaccepted** volume model when none passes. | Fall back to the best **baseline** (seasonal naive), and keep the warning. | ☐ |
| A6 | Waze panel wording | FE components/maps/WazeLiveModal.tsx:121-134, 267; FE app/dashboard/components/InteractiveRoadMap.tsx:259-266 | The modal uses its own 40/25/12 km/h speed bands, and calls level 5 "Standstill" where the map calls it "blocked". | Use the Waze level words (0 free flow, 1 light, 2 moderate, 3 heavy, 4 severe, 5 blocked) everywhere, and drop the 40/25/12 bands. | ☐ |
| A7 | Kaplan–Meier zero durations | BE services/clearance-protocol.service.ts:73-80 | Keeps 0-minute clearances. | Exclude durations ≤ 0, and censor durations over 1,440 min at 1,440. | ☐ |
| A8 | Rainfall labels on incident forecast | FE components/dashboard/PredictiveIncidentChart.tsx:572-578, 701 | Applies **hourly** bands (7.5/15/30 mm, from a 2019 PAGASA statement) to **daily** totals. | Use PAGASA's current hourly classes, the same ones the sandbox uses (light ≤ 2.5, moderate 2.5–7.5, heavy > 7.5 mm/h), applied to the day's **peak hourly** rainfall. | ☐ |
| A9 | AQI words | FE app/dashboard/sustainability/page.tsx:35, 906; BE services/emissions.service.ts:162-164 | AQI 2 is "Good" on the chart but "Fair" on the tile. | Use OpenWeather's scale in both places: 1 Good, 2 Fair, 3 Moderate, 4 Poor, 5 Very Poor. | ☐ |
| A10 | "Heavy vehicle" definition | FE sustainability/page.tsx:189-191, 1106-1116; BE services/emissions-prescriptive.service.ts:313, 556-562; SS fleet_mix/train_fleet_mix.py:77-80 | "Heavy" means Class 2+3 by **vehicle count** on the tile, Class 3 by vehicle-km in Prescriptive, and Class 2+3 in fleet mix. | "Heavy" = **Class 2+3**, measured by **vehicle-km**, everywhere. The time-window advisory says "Class 3" explicitly. | ☐ |
| A11 | AI narrative accuracy words | BE services/ai-insight.service.ts:89, 527 | WMAPE < 10% "strong", 10–20% "usable", > 20% "weak". | Judge against the baseline and the KPI design targets (K1 ≤ 12%, K5 ≤ 15%), not separate fixed bands. | ☐ |
| A12 | Bootstrap wording | BE services/emissions-prescriptive.service.ts:469 | UI says "Monte Carlo resamples". | Say "bootstrap resamples". | ☐ |
| A13 | Crash-rate interval | FE app/dashboard/incident/page.tsx:307-326; BE services/incident.service.ts:309-320 | No confidence interval. | Show the approximate Poisson 95% interval exp(ln RR ± 1.96√(1/n_wet + 1/n_dry)). | ☐ |
| A14 | Incident model panels | FE IncidentSeverityModels.tsx, SecondaryIncidentRiskPanel.tsx, HighIncidentDayRiskPanel.tsx, CorridorRiskModelsPanel.tsx (no importer) | The severity, Cox clearance-time and secondary-risk results exist but are not on any page. | Mount them on Incidents – Predictive. | ☐ |
| A15 | MTTC and response time | BE services/incident.service.ts:384-463; dashboard.service.ts:103-107 | Mean only. MTTC is not displayed. | Show mean, median and 90th percentile by incident type, with coverage (K9, K15). | ☐ |
| A16 | Maintenance km range | BE validators/maintenance.validator.ts:16-17; FE app/dashboard/maintenance/page.tsx:198-223 | API allows Km 12–88.25; form allows Km 12–87. | One range in both, Km 12–87. | ☐ |
| A17 | Old trainer copies | SS/congestion/train_congestion_horizon.py; SS/event_surge/build_event_surge.py | Outdated cut-offs (30/60 km/h; the circular 1.45× event selection). Running them would overwrite live tables. | Archive or delete them. AS/ holds the live scripts. | ☐ |
| A19 | Speed advisory card (team decision, 1 Nov) | FE components/dashboard/PrescriptiveDeploymentPanel.tsx:55-61, 306-312, 559-625, 693-701 (rendered on Incidents – Prescriptive, app/dashboard/incident/page.tsx:1195) | Shows "Advise 60 km/h on N stretches" with posted limits of 100/80 km/h. | **Remove the card.** The system recommends no speed. The Traffic – Prescriptive fuzzy advisory ranks congestion response (Act/Prepare/Monitor: counter-flow and VMS advisories, staging units, or no action) and does not set speeds. | ☑ (done, checked 2 Nov) |
| A20 | Hard-coded emission factors (added 2 Nov) | BE services/emissions-prescriptive.service.ts:39, 171-173, 311, 318, 524, 547, 552, 620 | `F_LIGHT = 192`, `F_MEDIUM = 354` and `F_HEAVY = 1492` are still hard-coded. The heavy-share what-if (1492 − 354) and the Class 3 CO₂ by exit use them, although the factor table now holds the EMEP/EEA values. | Read the factors from `nlex_emission_factors` (196.1 / 689.4 / 798.2 g/km), and update the comments and UI text that quote 192/354/1492. The what-if saving per shifted vehicle-km becomes 798.2 − 689.4 = 108.8 g. | ☑ (done, checked 2 Nov) |
| A21 | Idling-factor comment and NOₓ labels (added 2 Nov) | BE services/emissions-source.ts:35-38; FE app/dashboard/sustainability/page.tsx:1255, 1276; BE services/emissions.service.ts:425, 436 | The φ comment credits "Climatiq's petrol-car factor", and the estimated pollutant is labelled NO₂ in this copy of the code. The team reports NOₓ is done on another branch, but it is not in this repository yet. | Comment: φ = 0.0192 kg/veh-min is a proponent assumption (about one tenth of a car's CO₂ per km). Label the estimated pollutant **NOₓ**. Measured air-quality NO₂ stays NO₂. | ☑ (done, checked 2 Nov) |
| A18 | Congestion tooltip | FE components/dashboard/PredictiveCongestionChart.tsx:1622 | Says "next 12 hours". | Match the 1–168 h horizon picker. | ☐ |

## A+. New items found after the 2 November pull (Hans-Commit-8 to 13, Jertz-Commit-10 and 11)

| # | Area | Where | Does now | Should do | Done |
|---|---|---|---|---|---|
| A22 | **Event uplift overwritten (urgent)** | SS/weekly_retrain/weekly_retrain.py:252-256 | The weekly batch runs the **old** SS/event_surge/build_event_surge.py (circular 1.45× volume selection). Batch #15 (1 Nov) overwrote gold.ml_event_surge_forecast, with up to 577 inferred "event days" per exit. | Run AS/build_event_surge.py (calendar events, CI > 1, n ≥ 8), rebuild the table, and archive the old script (A17). | ☐ |
| A23 | Mobile config permission | BE routes/mobile-config.routes.ts:12-13 | Any signed-in user with the authenticator code can save. | Allow saving only for the roles that Chapter 3's access table gives write access (Data Analyst / TCC). | ☐ |
| A24 | Congestion champion rule | AS/train_congestion_horizon.py:836-843, 947 | Picks the best severe-hour catcher (within 0.5 points) from **all** candidates, accepted or not. | Choose only among accepted candidates (beats majority, persistence and the exit-hour profile); otherwise serve the profile (same as A4). | ☐ |
| A25 | Congestion state shown vs stored | FE PredictiveCongestionChart.tsx (cell rule) vs stored state read by the mobile app | The dashboard paints cells with a different rule from the stored state the mobile app reads. | Use one rule (the stored, severe-weighted state) in both. | ☐ |
| A26 | Two hourly writers | Laptop scheduled task (refresh_congestion_hidden.ps1) and .github/workflows/congestion-hourly.yml | Both write the congestion forecast every hour. | Keep one: the GitHub Actions job. | ☐ |
| A28 | Evaluation period (team decision, 2 Nov) | Every trainer and evaluation script whose test window runs past 31 Dec 2025 (e.g., incident holdout 10 Sep 2025 – 30 Jun 2026; volume 80/20 split; CO₂ and fleet-mix tests) | Test windows and reported metrics include January–June 2026. | The manuscript now states the NLEX record as 1 Jan 2022 – 31 Dec 2025. Results reported in Chapter 4 must come from that period, so end every test window at 31 Dec 2025 before producing Chapter 4 figures. | ☐ |
| A29 | Idling CO₂ per gallon (team decision, 2 Nov) | BE services/emissions-source.ts:38-54 | 20 lb CO₂ per gallon (9.07 kg) for all classes. This fits gasoline but understates diesel by about 11%. | Use 8.887 kg CO₂/gal (gasoline) for Class 1 and 10.180 kg CO₂/gal (diesel) for Classes 2 and 3 (US EPA, 2026). Idling rates become 0.044 / 0.136 / 0.170 kg CO₂ per vehicle-minute. Update the code comment: the 0.3/0.8/1.0 gal/h rates are planning values within the US DOE (2015, Fact #861) range. | ☐ |
| A27 | Synthetic-data flag | smartflow_scripts/.../traffic_hourly_48h/build_dataset.py:12-17, 43-45 | Says Jan–Jun 2026 hourly toll data were made by the team; the live 48-hour run carries history_synthetic = true. | Team to confirm the data's origin. The manuscript must state it either way. | ☐ |

## B. Features the manuscript claims that the system does not show (build them, or ask for the claim to be removed)

| # | Item | Status | Chapter 3 now says |
|---|---|---|---|
| B1 | Live KPI red/amber/green bands (Tables 3.6.1–3.6.4) | No code compares any KPI with its target. | KPIs are evaluated in Chapter 4. Only the KPIs listed in Section 3.11.6 appear live on the dashboard. |
| B2 | K6 emission-inventory coverage | Not computed. | Evaluated in Chapter 4 from the warehouse. SCTEX is not loaded, so full coverage is 19 of 20 exits. |
| B3 | K16 secondary-incident rate | In the API payload, never shown. | Shown once A14 is done. |
| B4 | Clearance-protocol unit cost and delay cost | API-only (1,500 PHP/unit-h; 300 PHP/veh-h). | Set in the API, not adjustable on the dashboard. |

If the team prefers to build B1–B4, tell Claude so Chapter 3 can be updated.

## C. Not a bug, but the team should know

- The upload check accepts **measured** km 0–89 while its error message shows **official** posts Km 12–87. This is intended, because measured km is converted to official posts (lib/km-post.ts). Chapter 3 now says so.
- The emissions peak-penalty endpoint (`/api/emissions/peak-penalty`) uses fixed rush hours (06:00–09:00, 16:00–19:00) and is not on the dashboard. Remove it, or tell Claude to document it.
- Waze report filter (FE lib/waze-reports.ts:71-76): a report is "disputed" if confidence ≤ −1 or reliability < 5. In 86,969 recent alerts, confidence ranged 0–5 and reliability 5–10, so this rule never fires. Only the "unconfirmed" rule (reliability ≤ 5 and confidence ≤ 0) has an effect. Keep it or simplify it, but Chapter 3 states the rule as written.
- The 10-minute Redis expiry is set by the AWS ingestion process, which is not in this repository. Its owner should confirm it (also in Pending Decisions).
