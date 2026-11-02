# SmartFlow NLEX – Analytics Model Audit

*Prepared 22 October 2026. Each method named in the original manuscript was checked against the repository (training code → stored output → API → UI) and the AWS RDS warehouse, using read-only SELECT queries. Figures are as stored on 20–21 October 2026; they change with every weekly retraining run. Evidence paths are relative to the repository root.*

**Status key:** IMPLEMENTED-VERIFIED · PARTIAL · CONFIGURED-UNVERIFIED · PLANNED · UNSUPPORTED (the claim is contradicted by the code).
**Treatment key:** Retain · Revise · Reclassify · Consolidate · Proposed (kept as future work) · Remove.

## 1. Key findings

1. **The volume champion is Prophet, not LSTM or XGBoost.** On the 80/20 rolling-origin holdout (294 days, 10 Sep 2025 – 30 Jun 2026), Prophet scored WMAPE 6.57%, MASE 1.203 and R² 0.359. LSTM is last (WMAPE 10.97%, R² −0.167). No XGBoost volume model exists (`pred_xgboost` has 0 rows).
2. **The volume gate has drifted from the committed code.** `retrain_honest.py` requires MASE < 1, yet the database accepts Prophet at MASE 1.203 with rejection text that appears in no committed file.
3. **Seven descriptive methods are not implemented:** STL/MSTL, ACF/PACF, GMM, the Underwood fit, KDE/NKDE, Getis-Ord Gi* and the log-normal clearance fit. They are kept as *Proposed* (Section 3.11.1.9).
4. **Three prescriptive models are genuine optimizations:**
   - maximal covering location (MCLP) for patrol positioning, a binary integer program solved with YALPS;
   - a two-stage stochastic clearance protocol (MILP with four Kaplan–Meier scenarios, plus EVPI and VSS);
   - booth staffing, an exact greedy solution of an interval-structured linear program.

   TOPSIS and the fuzzy advisory are implemented, but the fuzzy advisory takes P(high congestion) and lead time as inputs. It does not use V/C and does not output speed limits.
5. **"Monte Carlo" is a seeded bootstrap** of 400 resamples over observed incidents. It does not vary volume, fleet mix or weather, and does not "guarantee" anything.
6. **Emissions use fixed per-class factors** of 192, 354 and 1,492 g CO₂/km, with no speed term and no Climatiq call at run time. The idle penalty is a D/D/1 triangle, φ·(λ/60)·T²/2, which is a lower bound.
7. **The event-surge table has regressed** to the circular method (C1 in Pending Decisions). The defensible figure is 1.16x for the CDV/PH Arena exit (CI 1.08–1.29, 109 calendar events), and it must be rebuilt before any figure is quoted.
8. **Several models have weak skill:**
   - Severity classifiers: accuracy 0.901 against a majority-class rate of 0.900.
   - Negative binomial incident counts: R² 0.262, the same as Poisson.
   - Cox clearance model: C-index 0.625, fitted with no censoring.
   - Congestion classifier: 0.640 against a 0.577 profile baseline, a skill score of about 0.15.

   The manuscript reports these honestly as limitations.
9. **Equation errors in the original were corrected:**
   - MASE was scaled over J test points and used a lag-1 random walk, which understated it about 4.5×.
   - ADT was missing its Σ, and total ADT was missing a "+".
   - The idling penalty was dimensionally invalid.
   - KPI T751 added kilometres to an idling factor.

## 2. Model and method inventory

| Tier | Method | Classification | Purpose | Required data | Repository evidence | Status | Validation (as stored) | Manuscript treatment |
|---|---|---|---|---|---|---|---|---|
| Descriptive | Temporal aggregation, hour × weekday profiles | Data transformation / KPI | Peaks and trends | `gold.fact_traffic_hourly` | `Back-End/src/services/traffic.service.ts:27-195` | IMPLEMENTED-VERIFIED | n/a | Retain (3.11.1.2) |
| Descriptive | Local control-day comparison (±45 d, n ≥ 4) | Analytical technique | Holiday and event effect | Daily entries, `ph_holidays`, arena events | `traffic.service.ts:217-350` | IMPLEMENTED-VERIFIED | n/a | Retain (3.11.1.3, Eq. 3.9.3.4) |
| Descriptive | 2-sigma rule / Volume Deviation Index | Anomaly rule | Volume anomalies | Daily entries | `All_Scripts/Data_Pipeline/smartflow_pipeline.py:302-306` (synthetic only) | UNSUPPORTED (live) | n/a | Proposed; replaced by local baseline |
| Descriptive | STL/MSTL, rolling mean | Analytical technique / transformation | Trend and seasonality | Daily series | none | UNSUPPORTED | n/a | Proposed (3.11.1.9) |
| Descriptive | ACF/PACF | Statistical diagnostic | SARIMA orders | Daily series | none; fixed orders | UNSUPPORTED | n/a | Proposed |
| Descriptive | GMM regimes | Unsupervised statistical model | Congestion regimes | Speed–flow | none | UNSUPPORTED | n/a | Proposed; states use Waze jam-speed cuts |
| Descriptive | Underwood speed–flow fit | Traffic-flow model | Capacity | Speed–density | none; Mejia–Sigua speeds used as sandbox caps (`scenario-sandbox/scenarios/assumptions.ts:279-282`) | UNSUPPORTED | n/a | Proposed; Mejia–Sigua reclassified as an external parameter source |
| Descriptive | KDE/NKDE, Getis-Ord Gi* | Estimation / spatial test | Hotspots | Incident points | none; 5-km bin counts (`incident.service.ts:223-244`) | UNSUPPORTED | n/a | Proposed; describe 5-km ranking |
| Descriptive | Wet/dry exposure-normalized crash ratio | Analytical technique | Weather risk | Crashes, hourly rain (wet > 0.3 mm/h) | `Front-End-Dashboard/app/dashboard/incident/page.tsx:305-326` | IMPLEMENTED-VERIFIED | No CI | Retain (Eq. 3.11.1.1) |
| Descriptive | MTTC; Kaplan–Meier | KPI; estimator | Clearance baseline | Event timestamps | `incident.service.ts:378-465`; `clearance-protocol.service.ts:68-153` | IMPLEMENTED-VERIFIED | Coverage reported | Retain (Eq. 3.11.1.2) |
| Descriptive | Log-normal clearance fit | Parametric model | Clearance distribution | Durations | none | UNSUPPORTED | n/a | Proposed |
| Descriptive | Emission inventory (fixed factors) | Deterministic accounting | CO₂, PM2.5, NO₂ | Counts, segment km, factors | `Back-End/src/etl/toll-hourly.ts:315-336`; `bronze.nlex_emission_factors` | IMPLEMENTED-VERIFIED | n/a | Retain; COPERT/EMFAC/speed claims removed (Eq. 3.9.3.5) |
| Descriptive | Delay-induced CO₂ (D/D/1) | Deterministic accounting | Incident idling | Blockage minutes, hourly flow | `Back-End/src/services/emissions-source.ts:38-111` | IMPLEMENTED-VERIFIED | Lower bound | Retain (Eq. 3.9.3.7) |
| Predictive | Prophet (+weather) | Statistical model | Daily volume | Daily entries, weather climatology | `smartflow_scripts/3_training_testing/traffic_volume/retrain_honest.py` | IMPLEMENTED-VERIFIED | WMAPE 6.57, MASE 1.203 (80/20) | Retain as champion (Eq. 3.11.2.1) |
| Predictive | Holt-Winters (additive, m = 7) | Statistical model | Benchmark | Daily | same | IMPLEMENTED-VERIFIED | WMAPE 7.89, accepted | Retain (Eq. 3.11.2.2) |
| Predictive | Holt's linear | Statistical model | Benchmark | Daily | same | IMPLEMENTED-VERIFIED | 9.65, rejected | Consolidate with Holt-Winters |
| Predictive | SARIMAX(1,1,1)(1,1,1)₇ | Statistical model | Weather-adjusted volume | Daily + weather | same | IMPLEMENTED-VERIFIED | 8.55, rejected | Retain as comparator |
| Predictive | LSTM | Deep learning | Volume, CO₂ | Daily | same; `train_emissions.py` | IMPLEMENTED-VERIFIED | Rejected (MASE 2.01 volume; 1.151 CO₂) | Reclassify as rejected comparator |
| Predictive | XGBoost volume | ML model | Volume | — | `pred_xgboost` = 0 rows | UNSUPPORTED | — | Remove from volume; Proposed |
| Predictive | Ensemble (SARIMA + LSTM) | Combination | Volume | — | none | UNSUPPORTED | — | Proposed (not adopted) |
| Predictive | XGBoost congestion classifier (1–168 h) | ML model | Congestion state | Live Waze (from 4 Aug 2026) | `All_Scripts/Predictive_Modeling/train_congestion_horizon.py` | IMPLEMENTED-VERIFIED | 0.640 vs profile 0.577 | Retain (Eq. 3.11.2.3) |
| Predictive | "Quantile random forest" | — | Intervals | — | Plain `RandomForestClassifier` (line 478) | UNSUPPORTED as QRF | 0.532 rejected | Reclassify as RF comparator; QRF proposed |
| Predictive | GRU | Deep learning | Congestion comparator; wet/dry speed | — | Congestion script; weather-speed script (no wet/dry split) | PARTIAL | 0.643 (12 h table) | Comparator; wet/dry proposed |
| Predictive | Bi-LSTM + attention | Deep learning | Travel time, secondary risk | — | none | UNSUPPORTED | — | Proposed |
| Predictive | Event uplift (calendar, bootstrap CI) | Statistical estimator | Event surges | Calendar, volume | `All_Scripts/Predictive_Modeling/build_event_surge.py` | PARTIAL (live table regressed) | 1.16x, error 11.44% vs 13.69% (17 Sep) | Retain method; rebuild before quoting |
| Predictive | Negative binomial GLM | Statistical model | Daily incidents | Counts, rain, volume | `Back-End/incident_model_scripts/train_incident_models.py:746` | IMPLEMENTED-VERIFIED | R² 0.262, MASE 0.718, overfit flag | Retain with caveat (Eq. 3.11.2.4) |
| Predictive | Ordinal logistic / XGBoost severity | Statistical / ML | Severity | Accident events | `train_incident_severity_models.py` | IMPLEMENTED-VERIFIED | 0.900 / 0.901 vs majority 0.900 | Retain; disclose no skill (Eq. 3.11.2.5) |
| Predictive | Cox PH | Survival model | Clearance time | Event durations | same | PARTIAL | C-index 0.625; no censoring | Retain with caveat (Eq. 3.11.2.6) |
| Predictive | Logistic (ridge) secondary risk | Statistical model | Secondary incidents | Self-join label (2 km, 30 min) | same | IMPLEMENTED-VERIFIED | AUC 0.620 | Retain (moved from descriptive) |
| Predictive | GWR (Poisson, 20 exits) | Spatial statistical model | Local effects | Exit panel | `train_incident_spatial_models.py:366-480` | IMPLEMENTED-VERIFIED | LOO MAE 2.70 | Retain; descriptive interpretation (Eq. 3.11.2.7) |
| Predictive | Spatial LSTM (2 nearest exits) | Deep learning | Exit-day incidents | Exit panel | same | IMPLEMENTED-VERIFIED | MAE 2.16 vs 2.32 | Retain; "graph topology" removed |
| Predictive | Gradient boosting regression | ML model | Daily CO₂ | Emission fact | `smartflow_scripts/3_training_testing/emissions/train_emissions.py` | IMPLEMENTED-VERIFIED | WMAPE 5.55, MASE 0.739 | Retain as champion (Eq. 3.11.2.8) |
| Predictive | Polynomial (ridge) | Statistical model | CO₂ comparator | Same | same | IMPLEMENTED-VERIFIED | Rejected | Reclassify as comparator |
| Predictive | Multiple linear regression | Statistical model | CO₂ | — | none | UNSUPPORTED | — | Remove / Proposed |
| Predictive | Dirichlet regression | Statistical model | Fleet mix | Daily class shares | `train_fleet_mix.py` | IMPLEMENTED-VERIFIED | WMAPE 5.09 vs climatology 5.71 | Retain (Eq. 3.11.2.9) |
| Prescriptive | Booth staffing ("LP") | Optimization (exact greedy) | Staffing | Forecast, shares, booths | `traffic-prescriptive.service.ts:46-56, 660-682` | IMPLEMENTED-VERIFIED | n/a | Revise wording (Eqs. 3.11.4.1–2) |
| Prescriptive | MCLP patrol positioning | Binary integer program | Patrol positions | Predicted incidents | `PrescriptiveDeploymentPanel.tsx:69-146` (YALPS) | IMPLEMENTED-VERIFIED | n/a | Retain (Eqs. 3.11.4.3–6) |
| Prescriptive | Two-stage stochastic MILP | Optimization | Dispatch and escalation | KM scenarios, costs | `clearance-protocol.service.ts:327-399` | IMPLEMENTED-VERIFIED | Verifier: 28 checks (not re-run) | Retain; renamed from "SLP" (Eqs. 3.11.4.7–8) |
| Prescriptive | Fuzzy advisory | Rule-based inference (zero-order Sugeno) | Response urgency | P(High), hours ahead | `traffic-prescriptive.service.ts:220-260` | IMPLEMENTED-VERIFIED | Not validated with operators | Revise: no V/C, no speed limits (Eq. 3.11.4.9) |
| Prescriptive | TOPSIS | MCDA | Rank events, emission strategies | Strategy criteria | `prescriptiveTraffic.shared.ts:420-470`; `emissions-prescriptive.service.ts:635-700` | IMPLEMENTED-VERIFIED | Weights untested | Retain (Eqs. 3.11.4.10–11) |
| Prescriptive | Monte Carlo | Bootstrap uncertainty | Strategy ranges | Observed incidents | `emissions-prescriptive.service.ts:175-190, 421-440` | PARTIAL | 400 resamples, seeded | Reclassify; "guarantee" removed |
| Prescriptive | Weather-triggered rule; 80% capacity alert; heuristic rerouting; VSL; price-optimized tolling | Rules / optimization | — | — | none | UNSUPPORTED | — | Proposed (3.11.4.9) |
| Simulation | IDM + MOBIL agent-based sandbox | Simulation methodology | What-if comparison | Warehouse demand, OSM lanes, KM durations | `scenario-sandbox/simulation.ts` | IMPLEMENTED-VERIFIED | `verify.ts` 1,532/0 (21 Oct) | Retain (Eqs. 3.11.5.1–3); not field-validated |
| Language model | GLM commands and narratives; Qwen tool-calling assistant | NLP interface | Interface only | Displayed values / API tools | `Back-End/src/lib/glm.client.ts`; mobile `backend/src/routes/assistant.ts` | IMPLEMENTED-VERIFIED | 65/65 offline checks; 80/80 eval (7 Oct) | Revise: no Claude, no RAG, no LangChain |

## 3. Methodological checks

| Check | Finding | Manuscript treatment |
|---|---|---|
| Leakage: future exogenous inputs | Volume uses training-period climatology for future weather. The incident holdout uses observed same-day rain and volume, so it is optimistic. | Stated in 3.11.2.2 and 3.11.2.5 |
| Leakage: congestion targets crossing the split | Dropped by the trainer; profiles are computed on training data only | Stated in 3.11.2.3 |
| Selection on the reported holdout | Champions and gates are chosen on the same windows that are reported | Disclosed in 3.11.3.6 |
| MAPE with small values | Event-surge MAPE is stored as Infinity; WMAPE is the primary metric | 3.11.3.1–2 |
| MASE definition | Code uses the lag-7 seasonal-naive in-sample scale | Eq. 3.11.3.5 corrected |
| AIC/BIC | Stored for four statistical models; not used for cross-family selection | Section 2.1.9.3 revised |
| Split dependence | 90/10 rankings differ from 80/20 | 2.1.9.4 states both windows |
| Horizons | Volume: 14 days validated, 90 days served unvalidated. Congestion: 1–168 h. CO₂: 7 days. Incidents: one step ahead. | Horizons stated consistently (Ch1 1.5, Ch3 3.8, 3.11) |
| Reproducibility | Volume trainer has no seeds; library versions are pinned | Listed in Revision Report |

## 4. Equation corrections (original → revised)

| Item | Original problem | Revised |
|---|---|---|
| ADT (P848–850) | No Σ; missing "+"; "AD" typo | Eqs. 3.9.3.1–3.9.3.3 |
| VDI (P858) | Full-period mean (look-ahead); ignores seasonality | Replaced by local-baseline deviation (Eq. 3.9.3.4); VDI noted as prototype only |
| E_baseline (P376/P862) | No Σ; no g→t conversion; "EF_API" | Eq. 3.9.3.5 |
| T_delay (P864) | Cleared − reported | Lane-blockage duration (Eq. 3.9.3.6) |
| E_penalty (P381/P866) | V × T × EF is dimensionally invalid | φ·(λ/60)·T²/2 (Eq. 3.9.3.7) |
| MASE (P978) | Denominator divided by J; lag-1 | (1/(T−m)) Σ\|y_t − y_(t−m)\|, m = 7 |
| MAE (P982) | Image only | Eq. 3.11.3.4 |
| KPI T751 | km + idling factor; no reference measurements | Forecast WMAPE plus inventory coverage |
| RMSE (P1043) | "Standard deviation of errors" | Equals the SD only when the mean error is 0 |
