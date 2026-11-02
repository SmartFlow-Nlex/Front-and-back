# SmartFlow NLEX – System-to-Manuscript Traceability Matrix

*Prepared 22 October 2026. This compares the original manuscript (Chapters 1–3) with the repository on branch Main-Dashboard (Kia-Commit-6 plus working tree) and the mobile app (branch Main-Mobile, Ysa-Commit-9). P# refers to paragraph ids in the original document. Status: IMPLEMENTED-VERIFIED (IV), PARTIAL (P), CONFIGURED-UNVERIFIED (CU), PLANNED (PL), UNSUPPORTED (U).*

## 1. Architecture and technology

| Manuscript section | Existing claim | Repository evidence | Status | Issue | Revision |
|---|---|---|---|---|---|
| 2.2.10.1.1, 3.4.2 (P541, P716) | Next.js with server-side rendering | `Front-End-Dashboard/next.config.mjs:8` `output:'export'`; Next 15, React 19 | P | Static export, not SSR | "Next.js 15 static export in Electron" |
| 2.2.10.1.6, 3.2.1.2 g (P562, P683) | Electron desktop dashboard | `Front-End-Dashboard/electron/main.js`; NSIS build config | IV | — | Retained with accurate description |
| 3.14 (P1107) | "React-based Dashboard … Flutter/React Native app" | Expo ^57 / RN 0.86 (mobile `package.json`) | U (Flutter) | No Flutter | Expo and React Native |
| 3.12.3 (P1045) | Mesa, Scikit-Fuzzy, Three.js | None of these is used for analytics; Three.js draws only the mascot | U | Wrong tools | TypeScript simulation; YALPS; custom fuzzy |
| 2.2.8.1, 3.14.1 (P521, P1097) | Supabase as the database; Google Cloud (R07) | AWS RDS PostgreSQL 18.3 + PostGIS 3.6.3 (ap-southeast-1); Supabase for authentication only | U | Wrong host | AWS RDS; Supabase Auth |
| 2.2.8.3, 3.4.2 (P527, P713) | Redis streaming buffer and cache | No Redis client; Upstash keys empty; opt-in flag (`map-comparison.controller.ts:133-153`) | U | Not used | Described as provisioned, unused |
| 2.1.12, 3.11.5 (P471, P1007, P1021) | Anthropic Claude Sonnet + LangChain RAG | `Back-End/src/lib/glm.client.ts` (Z.ai GLM); mobile `assistant.ts` (Qwen via OpenRouter); no RAG or LangChain | U | Wrong model and architecture | GLM and Qwen; tool calling; no RAG |
| 3.5.2, 3.14.1 (P719, P1098) | End-to-end encryption; Bcrypt | TLS to RDS with `rejectUnauthorized:false`; hashing delegated to Supabase | P | Overclaim | Measurable security NFR; limitations |
| 3.2.1.1.2 (T614, P609, P644) | Email OTP (dashboard), SMS OTP (mobile) | Supabase TOTP aal2 enforced (`auth.middleware.ts:29-36, 170-176`); 7-day device trust; idle sign-out | U (OTP) / IV (TOTP) | Wrong factor | TOTP throughout |
| T614 | Role permissions (CRUD) | `Front-End-Dashboard/lib/auth-access.ts` DENIED map; maintenance writes for data analyst and TCC only | P | Incident Operator "Update" not true | Table rebuilt |
| 1.5.1 (P86 etc.) | 105-km corridor | Km 12–87 official posts; about 76 km measured (`silver.dim_location`); MPTC page says 105 km for NLEX | P | Corridor vs company figure | 105 km attributed to MPTC; scope Km 12–87 |

## 2. Data and ETL

| Manuscript section | Existing claim | Repository evidence | Status | Issue | Revision |
|---|---|---|---|---|---|
| 3.9.1 (P826) | Daily toll entry counts | `gold.fact_traffic_hourly`: hourly, 19 plazas, 2022-01-01 → 2026-06-30, no gaps | IV (finer grain) | Understated grain | Hourly description |
| 3.9.1 (P826) | Apprehension and Undercap table | Not in any schema | U | — | "Not loaded" |
| 3.9.1 (P826) | Crash table with lane and pavement | No lane or pavement columns; 2020–21 rows synthetic | P | — | Real columns; 2022+ only |
| 3.9.1 (P828), 2.2.9.2 | OpenWeather API, real time | Open-Meteo/ERA5/JMA history to 3 Oct 2026; OpenWeather air pollution only | P | Wrong provider; not live | Corrected |
| 3.9.1 (P828), FR-02 | Ticketing scraper (BeautifulSoup) | No scraper; one-off Philippine Arena calendar (155 → 145 events) | U | — | "Collected once; updated manually" |
| 3.9.1 (P828) | Waze Partner Hub, near real time | Live polls every 120 s since 4 Aug 2026; history Jan 2022 – 18 Apr 2026 | IV (writer outside repo) | Gap 19 Apr – 3 Aug 2026 | Span and gap stated |
| 3.9.2 (P830–833) | Validation Gates 1–4 (24 checks) | Upload pipeline `Back-End/src/etl/index.ts`: about 7 checks implemented, 10 partial, 11 absent | P | Over-specified | Implemented checks listed; absent ones named |
| 3.2.1.2 c (P673) | PII detection and masking | None; plate and driver fields copied to silver | U | Privacy risk | Disclosed; masking required |
| 3.9.3 (P837) | Imputation and interpolation | Not in the ETL; imputed weather rows excluded | U | — | Corrected |
| 3.9.3 (P848–859) | ADT, exit share, VDI | ADT in the API; share and VDI only in the synthetic prototype | P | — | ADT plus local-baseline deviation |
| 3.10 (P879–892) | Fact constellation of 8 tables | 4 of 8 exist by name; actual medallion of about 130 relations | P | Design ≠ implementation | Figure labelled design; Table 3.10.1 added |
| 3.9.4 (P877), 3.2.1.2 e | Gold layer used as RAG source | No retrieval index | U | — | Removed |
| 3.2.1.2 h (P686) | Orchestration, drift monitoring | Windows scheduled tasks on one workstation; no alerting | P | — | Described accurately |

## 3. Functional requirements (original T737) and features

| FR | Original claim | Evidence | Status | Revised FR |
|---|---|---|---|---|
| FR-01 | Real-time and historical multisource ingestion incl. scrapers | Live Waze only; other sources batch | P | FR-01 reworded |
| FR-02 | Automated event scraping | None | U | Event calendar maintenance |
| FR-03 | Validation before storage | `etl/cleaner.ts`, `validators/` | IV | Measurable rejection report |
| FR-04 | Emission tracker | `emissions.service.ts`; fixed factors | IV | Factors and window shown |
| FR-05 | LSTM + XGBoost 7-day volume | Prophet champion; no XGBoost volume model | U as worded | Champion by held-out WMAPE vs baseline |
| FR-06 | Agent-based sandbox | IDM/MOBIL; `verify.ts` 1,532 checks pass | IV | Detailed levers and outputs |
| FR-07 | Smart response (lanes, patrol units) | Booth staffing, MCLP, stochastic protocol | IV | Expanded |
| FR-08 | Real-time accuracy display | Static held-out metrics per retrain | P | Held-out accuracy with window |
| FR-09 | Incident map | Live Map (Waze, 60 min); historical incident analytics | IV | Reworded |
| FR-10 | 48-hour time-slider | Forecast hour picker 1–168 h | P | 168 h |
| FR-11 | ML-powered assistant with departure advice | Qwen with live-status tools; no forecasts or departure advice | P | Live-status assistant |
| FR-12 | Push alerts for surges | On-device notifications; no server push; no surge alerts | P | Alerts while in use |
| FR-13 | Community reports cross-referenced | Stored in Supabase; never read by the dashboard | P | Cross-check proposed |
| (none) | — | Maintenance CRUD, audit log, data management with undo, mobile config, narratives, congestion forecast, weekly retrain, MFA | IV | FR-14 to FR-21 added |

## 4. Non-functional requirements and QA

| Item | Original | Evidence | Status | Revision |
|---|---|---|---|---|
| Availability "three nines" | NFR | `/health` only; no monitoring | U | 99.5% measured by a probe (target) |
| Performance | "acceptable time limits" | Ch. 4 draft: p95 < 45 ms at ≤ 50 concurrency (script not archived) | P | Measurable thresholds |
| Unit tests UTC/UTS | Plan | No test framework or CI; `verify.ts` and command checks are the only automated checks | P | 3.13 split into performed and planned |
| Stress tests (k6, 500 VUs) | Plan | No k6 script or results | PL | Proposed with a separate database |
| UAT (30 participants) | Plan | Not held; feedback PDF not found | PL | Plan with SUS and four role tables |
| UAT-IO-2, UAT-IO-3, UAT-DA-3, UTS-03, UTS-04 | Specific tests | Features do not exist (patrol GPS, incident close, 2-sigma log, COPERT oracle) | U | Replaced |

## 5. Deployment

| Item | Original | Evidence | Status | Revision |
|---|---|---|---|---|
| Cloud hosting (AWS/Azure/GCP) | P1096 | No cloud host for the dashboard; Render free tier serves a demonstration API for the mobile app | P | Current deployment table |
| Model deployment and smoke test with LSTM | P1104–1105 | Weekly retrain with gate and restore; Prophet champion | P | Corrected |
| 48-hour predictive slider | P1108 | 168 h | U | Corrected |
| Rollback via Git | P1111 | Backup branches before every merge; model restore | IV | Described |
| k6 monitoring | P1113 | None | U | Proposed |
