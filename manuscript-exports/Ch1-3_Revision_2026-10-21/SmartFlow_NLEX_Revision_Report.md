# SmartFlow NLEX – Revision Report (Chapters 1–3)

*Prepared 22 October 2026 for the project team and adviser. It records what changed in `3ISB_Group4_CP-1_Manuscript.docx`, why, and the evidence for each change. The original file was not modified (SHA-256 checked before and after).*

## 1. Files

| File | Purpose |
|---|---|
| `SmartFlow_NLEX_Chapters_1-3_Revised.docx` | Clean revised manuscript: TOC refreshed, equations as native Word equations |
| `SmartFlow_NLEX_Chapters_1-3_Redline.docx` | Word comparison of the original and the revision, with all changes tracked, for faculty review |
| `SmartFlow_NLEX_Chapters_1-3_Revised.pdf` | Rendered copy (269 pages) |
| `SmartFlow_NLEX_System_Traceability_Matrix.md` | Manuscript claims compared with repository evidence |
| `SmartFlow_NLEX_Analytics_Model_Audit.md` | Every analytics method: status, validation, treatment |
| `SmartFlow_NLEX_Citation_Audit.md` | Reference verification and corrections |
| `SmartFlow_NLEX_Pending_Decisions.md` | Items that need team or faculty decisions |
| `checkpoints/` | Intermediate builds and the machine-readable edit log (1,081 edits) |

## 2. How the revision was done

1. **Evidence gathering.** Specialist agents audited the repository and the database (SELECT-only), each covering one track:
   - system architecture, the mobile app, data engineering and ETL, predictive models, descriptive/prescriptive analytics and emissions, KPIs and equations, QA and requirements, and deployment and security;
   - internal consistency of the manuscript;
   - the literature, through academic-researcher agents coordinated by the research coordinator: 09a–09d plus the final bibliography.

   Their findings files are the evidence behind every change. Each entry in the edit log carries a reference key (for example F03 = predictive audit, 09b = citations M–Z).
2. **Editing method.** A script edited the original DOCX in place, keeping its letterhead, cover, styles, tables, figures and section structure. New paragraphs copy the formatting of neighbouring paragraphs, and equations were rebuilt as native Word equations. Word then refreshed the TOC and produced the PDF and the redline.
3. **Protected text.** Sections 1.4.1 (General Objective) and 1.4.2 (Specific Objectives) are word-for-word identical to the original, as you instructed. Their mismatches with the system are listed in Pending Decisions §A.
4. **Final QA.** The error-detective and data-analyst agents re-audited the revised draft:
   - 96 of the 128 original defects are fixed, and most of the remaining 32 are deliberate (protected objectives) or pending decisions;
   - 27 new mathematical and KPI issues were found and corrected;
   - an automated check confirmed that the in-text citations and the reference list match one to one.

## 3. Chapter 1 – Introduction

| Section | Change | Reason / evidence |
|---|---|---|
| Introduction (P26–P30) | 105 km attributed to MPTC; corridor and data described accurately; 493,000 described as a combined NLEX, SCTEX and Connector projection; mobile features corrected | 09d, MPTC website; F01 §2.7 |
| 1.1 Definitions | Re-lettered a–n; added Champion Model, Decision Intelligence, Medallion Architecture, Waze for Cities; corridor defined as Km 12–87; weak source replaced | 09d A12; F02 |
| 1.2 Company background | Verified facts only (former MNTC name; three expressways; MPTC/MPIC); unverified claims removed | MPTC website |
| 1.3 Project context | Misattributed DPWH claim removed; GoodVision dated 2023 and softened; NTT replaced by Fujishima et al. (2023) | 09d A4, A7, A11 |
| 1.4.3 (new) | Objective → feature → output → evaluation traceability table | Prompt requirement; objectives untouched |
| 1.5 Scope and limitations | Corridor, data span, horizons, emission method, interfaces corrected; limitations added for data recency, synthetic 2020–21 rows, demo hosting, deployment scope and model skill | F01–F04, F07 |
| 1.6 Framework | Narrative aligned with the actual inputs and the retraining loop; figure-label differences disclosed | F02; Pending §E |

## 4. Chapter 2 – Review of Related Literature

- About 200 paragraphs were reviewed and about 150 revised. Six fabricated or unlocatable references were removed together with the claims that relied on them, and 28 real references were corrected (Citation Audit §2).
- Each "SmartFlow will…" paragraph now states what the system actually does, using implemented, rejected or proposed status. Examples:
  - Prophet is the volume champion and LSTM was rejected.
  - XGBoost classifies congestion state.
  - QRF, Bi-LSTM, GRU wet/dry, MLR, ensembles, heuristic rerouting, V/C and the weather-triggered advisory are proposed.
- Verified literature was added for the implemented methods: Prophet, ETS/M4 benchmarks, XGBoost, IDM/MOBIL, MCLP and patrol location, TOPSIS, fuzzy inference, negative binomial models, hazard models with Cox and Kaplan–Meier, Dirichlet regression, MASE/WMAPE, Waze validity, the IPCC guidelines, COPERT, LLM tool use, the lakehouse pattern, TOTP and SUS.
- Section 2.2 was aligned with the implemented stack: AWS RDS with PostGIS, Supabase Auth, an in-process cache instead of Redis, a static Next.js export in Electron, GLM and Qwen, and Open-Meteo/ERA5/JMA weather.
- The 2.3 Synthesis was rewritten. Novelty is now framed as the integrated, baseline-validated decision-support workflow for NLEX, set against Philippine NLEX studies (Gugol et al., 2013; Maravilla et al., 2011; Mejia & Sigua, 2018; Gernale & Juanico, 2023). It is not claimed for any single algorithm.
- Overclaims ("guarantees", "exact", "mathematically ensures", "no practical utility") were softened throughout.

## 5. Chapter 3 – Methodology

| Section | Change |
|---|---|
| 3.1 | CRISP-DM phases mapped to the actual work; Kanban cadences with the backup-branch merge procedure; Table 3.1.1 rebuilt |
| 3.2.1.1 | Existing-process provenance caveat; TOTP authentication; T614 roles and permissions from `auth-access.ts`; all 11 swimlane narratives aligned with the implementation |
| 3.2.1.2 | Pipeline layers rewritten as implemented; new Table 3.2.1.2.1 compares design and implementation; modeling-layer domains rewritten |
| 3.3–3.4 | Business solution corrected; risk register rebuilt (R01–R11, including materialised risks); feasibility (stack, AWS RDS, LLM providers) and cost table corrected without inventing figures |
| 3.5 | FR table with a Status column; FR-01 to FR-13 reworded and FR-14 to FR-21 added; measurable NFRs; captions added |
| 3.6 | KPI tables corrected (unmeasurable KPIs replaced); Table 3.6.5 catalogue with 16 KPIs; design targets labelled |
| 3.7–3.8 | Mock-ups labelled as design; mobile figures renumbered 3.7.2.x; outputs a–g described by type (computed, predicted, recommended, simulated) |
| 3.9 | Data Sources table (Table 3.9.1); extraction and validation as implemented; corrected ADT, deviation and emission equations (3.9.3.1–3.9.3.7); PII disclosure |
| 3.10 | Fact constellation labelled as conceptual design; implemented warehouse in Table 3.10.1 |
| 3.11 | Rebuilt: method inventory (Table 3.11.1); every implemented method documented with purpose, inputs, formulation, procedure, output, interpretation and feature (38 numbered equations in Chapter 3); unimplemented methods kept as Proposed; corrected MASE and WMAPE; gate and leakage disclosure; agent-based sandbox (IDM/MOBIL) and language-model features accurately described |
| 3.12 | Tools and techniques by tier, as implemented |
| 3.13 | Verification already performed (with evidence) separated from the unit, integration, model/data, security, stress and UAT plans; four UAT role tables; Nielsen corrected |
| 3.14 | Current deployment, release procedure and rollback, separated from the proposed production deployment |

## 6. Formatting

- **Corrected:** the date typo, heading casing (TypeScript, ECharts, GitHub), duplicate heading numbers (2.2.10.1.6 → 2.2.10.1.7; duplicate 3.11.1.6 and 3.11.1.7 removed in the rebuild), mobile figure numbers, duplicate table numbers, broken sentences, and the APA 7 bibliography with hanging indent.
- **Not changed** (see Pending Decisions §F): the missing page-number footer, manual heading numbering, and some heading levels. Figure images were kept; the needed redraws are listed in Pending Decisions §E.

## 7. Known limitations of this revision

- Chapter 4 results were not revised. The deleted Chapter 4 drafts were used only as evidence.
- Live dashboard figures can change with each weekly retraining run. Chapter 3 therefore describes methods and avoids quoting results, except for data spans and validation design.
- Mobile-app findings come from reading the `Main-Mobile` branch (Ysa-Commit-9); the app was not run.

## 8. Update, 24 October 2026 (Chapter 2 trimming and gap sources)
- **Trimmed from Chapter 2:** sections on methods the system does not use (polynomial regression, ensemble forecasting, heuristic rerouting, V/C KPI). Methods still planned were condensed into the new 2.1.13 Methods Considered for Future Work. Headings in 2.1.4.2, 2.1.5.1, 2.1.10 and 2.2.8 were renumbered.
- **Added:** literature for eight implemented methods that lacked support, in Chapter 2 and in the matching Chapter 3 method sections (3.11.2.6, 3.11.2.8, 3.11.2.9, 3.11.4.2, 3.11.4.4, 3.11.4.5, 3.11.4.7). There are 18 new references; the list now has 122.
- **Checks:** 1.4.1 and 1.4.2 are still identical to the original, the citation cross-check is clean, 38 equations were rebuilt, the PDF has 272 pages, and the original DOCX is unchanged (SHA-256 verified).
- **Redis (later on 24 Oct):** 2.2.8.3 was restored, and Chapter 3 (the Extract Layer paragraph, the Extract row of the design-vs-implementation table, and the data-access paragraph) now describes Redis as a 10-minute snapshot written by the 2-minute AWS poller, with PostgreSQL as the system of record. The earlier "provisioned but unused" wording came only from the dashboard code; the poller is not in the repository. References: 127. PDF: 273 pages.
- **All references 2020+ (24 Oct):**
  - 113 references remain, all dated 2020 or later except Mejia & Sigua (2018), the team-approved data-source exception.
  - 56 entries were removed and 43 verified ones added. 67 sentences were rewritten to match what the new sources support.
  - An independent QA pass was applied.
  - The 2.3 Synthesis now notes that recent published NLEX research is limited. 2.1.8.2 describes EMEP/EEA inventory tiers instead of IPCC 2006.
  - PDF: 274 pages.
- **Chapter 2 citation coverage (25 Oct):** every Chapter 2 subsection now cites literature for its general claims. 8 references were added (121 in total), the 2.2 introduction fragment was fixed, and the PDF is now 277 pages.
- **Thresholds, KPIs and baselines (31 Oct–1 Nov):**
  - **Audit:** a read-only audit compared 152 user-visible rules and 16 KPIs with Chapters 2 and 3 (findings/23a–c).
  - **New Section 3.11.6:** Table 3.11.6.1, 58 rules, gives each rule's cut-off, where it is shown and its basis (a citation or "Proponent").
  - **New subsection 2.1.10.4:** supports the scales and methods behind the table with 2020+ sources.
  - **Corrections:** 19 statements in Chapters 1–3 were corrected. Examples:
    - the upload gates (four, not two) and the undo limit;
    - the drift check and the upload comparison warning;
    - the retraining gate;
    - the secondary-incident rule;
    - the clearance targets;
    - the rain speed caps;
    - the live-data requirement;
    - "heavy vehicle";
    - the risk R02 wording.
  - **Code fixes:** where the system contradicted the method, the team chose to fix the code. Chapter 3 describes the corrected behaviour, and the developer list is SmartFlow_NLEX_Code_Fix_List.md (A1–A19, B1–B4).
  - **Emission factors:** their provenance is now stated as confirmed so far: CO₂e; Class 3 from Climatiq (based on New Zealand MfE 2020 data); Class 1–2 and the PM2.5/NO₂ sources still being confirmed. DENR and DOTC are no longer credited for the values.
  - **NDC plan:** cited only for what it says (pp. 8, 59, 60).
  - **Speed advice:** the system recommends no driving speeds, and the speed card is to be removed (A19).
  - **Totals:** 140 references (Mejia & Sigua, 2018, is still the only pre-2020 one); the PDF is 292 pages.
- **Emission factors replaced (2 Nov):**
  - **New factors:** the team replaced the untraceable factors with values derived from the EMEP/EEA Guidebook 2023 (Update 2024), chapter 1.A.3.b.i-iv: CO₂ 196.1 / 689.4 / 798.2 g/km, plus CO, NOₓ and PM2.5, with low–high ranges. They were confirmed read-only in `nlex_emission_factors`, and `gold.fact_emissions_hourly` was rebuilt with them. Corridor CO₂ for 2022 to June 2026 is about 3.51 Mt, against 3.71 Mt with the old factors.
  - **Manuscript changes:**
    - Every factor, its provenance and the glossary row are updated.
    - The estimated pollutant is now NOₓ; measured NO₂ readings are unchanged.
    - The Climatiq reference is removed (139 references).
    - "105 kilometres" in Chapter 1 is replaced by the ≈ 76 km main line (Km 12 to 88.25).
    - The limitation now says the factors are European averages not calibrated to the Philippine fleet.
  - **PDF:** 290 pages.
- **Re-aligned with the 2 Nov pull (Hans-Commit-8 to 13, Jertz-Commit-10 and 11):**
  - **Audit:** three agents re-audited the code against the manuscript (findings/27a–c), and about 88 changes were applied (findings/29).
  - **New 3.11.2.11:** the 48-hour hourly volume forecast. A stacked LSTM; candidates include a dual-path LSTM; backtested on 2025 only; an 80% split-conformal band.
  - **Congestion forecasting:** seven candidates (including MSTL), a severe-state weight of 1.5, and the severe-catch tie rule among accepted candidates.
  - **"LSTM not adopted":** corrected where it is now false.
  - **Volume MASE rule:** now judged against the naive forecast's own MASE.
  - **Automation:** GitHub Actions now runs the scheduled jobs, plus an hourly Open-Meteo weather task.
  - **Emissions:** trip-based vehicle-km with new Equations 3.9.3.5–3.9.3.9, class-weighted idling, and a CO₂ low–high range.
  - **Data pipeline:** ETL and upload details, toll loads to gold, and the new hourly toll format.
  - **Access:** audit-log access and the remember-device rule.
  - **Testing (3.13):** automated test suites are now described.
  - **Data period:** the NLEX record is stated as 2022–2025, and figures that depended on later data were rewritten.
  - **References:** 146, with two pre-2020 data-source exceptions approved by the team: Mejia & Sigua (2018) and U.S. Department of Energy (2015). The idling rates are described as planning values within the DOE range.
  - **Equations and PDF:** 42 equations; the PDF is 316 pages.
