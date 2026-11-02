# SmartFlow NLEX – Pending Decisions (Chapters 1–3 Revision)

*Prepared 22 October 2026 for the project team and adviser. These items cannot be settled from the repository and need team or faculty input. Each item says what the revised manuscript currently does.*

## A. Objectives (1.4.1 and 1.4.2 kept verbatim, as instructed)

The objectives were not reworded. The following mismatches between their wording and the system are reported here instead. A new Section 1.4.3 (Table 1.4.3.1) maps each objective to the features and evaluation criteria without changing the objective text.

| # | Objective wording | What the system does | Options for the team |
|---|---|---|---|
| A1 | GO and SO3: "4-year historical NLEX dataset" | The toll and incident record covers 1 Jan 2022 – 30 Jun 2026 (4.5 years). The 2020–2021 incident rows come from files labelled synthetic. | Keep the wording (4 full years plus a partial year), or ask the adviser to approve "2022–2026" |
| A2 | GO: "real-time crowdsourced and external data" | Waze is live (polled about every 2 minutes). Weather and events are historical batch loads. | Keep; Ch1 scope and limitations now state this precisely |
| A3 | GO: "support SDG 9 through lower vehicular carbon emissions" | Emissions are estimated, not reduced in operation. SDG 11 and SDG 13 fit emission reduction more closely. | Adviser decision on whether to add SDG 11/13 |
| A4 | SO3: "using Python and RStudio" | No R code exists in the repository; all analysis is in Python. | Add a small R analysis, or ask approval to drop "RStudio". Section 2.2.4 no longer mentions RStudio. |
| A5 | SO4: "deploy existing … models … using existing machine learning algorithms" | Models were developed, trained and evaluated by the team. | Keep; the wording is defensible as "existing algorithms" |
| A5b | SO4 grammar: "…forecast expressway conditions using integrating historical toll records…" | Text kept verbatim as instructed | Adviser may approve "by integrating" |
| A6 | Prescriptive analytics has no dedicated specific objective | Prescriptive models exist (MCLP, stochastic MILP, TOPSIS, fuzzy, staffing). | Table 1.4.3.1 maps them to the GO, SO1 and SO2. Adviser decides whether to add an SO5. |

## B. Data and evidence the team must confirm

1. **Real vs synthetic data for 2022 onward.** The repository README lists "confirm whether source files are synthetic" as an open item. The 2020–21 files are named `*_synthetic.csv`. The manuscript states that 2022+ data are NLEX exports; confirm this.
2. **Data-sharing agreement with NLEX/MPTC** for the toll, incident and Waze Partner Hub data. Cite or attach it, or state its absence in the limitations.
3. **Existing business process (3.2.1.1.1).** The description of NLEX Central IT (NiFi, Kubernetes, MinIO, S3, Databricks, Power BI) is not verifiable from the repository. The manuscript now says it is based on consultation. Confirm the source (interview date or contact).
4. **Mejia & Sigua (2018) figures.** The 17.44% capacity and 7.4% speed reductions were removed because the PDF could not be checked. Open http://ncts.upd.edu.ph/tssp/wp-content/uploads/2018/08/Mejia18.pdf and, if they are confirmed, the figures can be restored with page numbers.
5. **Weather ingest and Waze poller code** run from outside the repository (`.gemini\…\scratch`; unknown host). Commit them so the methodology is reproducible.
6. **Production LLM model.** The local `.env` says glm-4.5-flash (Z.ai direct), while the sandbox README says glm-5.3-flash via OpenRouter. The manuscript says "GLM (Z.ai), optionally via OpenRouter"; confirm the model used in the defense build.
7. **UAT feedback PDF** ("SmartFlow-NLEX-Web-Dashboard-Test-Consolidated-Feedback") was not found on this machine. Chapter 3 is now written as a UAT plan, not results.

## C. System issues found during verification (affect what the manuscript can claim)

| # | Issue | Why it matters | Suggested action (team decision; no code was changed) |
|---|---|---|---|
| C1 | **Event-surge regression.** On 20 Oct the weekly batch reran the old circular event-surge scripts; the dashboard now shows a CDV uplift of 2.69x on 574 inferred events instead of 1.16x on 109 calendar events. | Any figure from the live dashboard is invalid until this is fixed. | Point the weekly "event_surge" group to `All_Scripts/Predictive_Modeling/build_event_surge.py` and rebuild. |
| C2 | **Volume accuracy gate drift.** Prophet is published with MASE 1.203 although the committed gate requires MASE < 1; the acceptance text is not in any committed file. | Section 3.11.3.6 describes the committed rule. | Re-run from the committed trainer, or document the changed gate. |
| C3 | **Security gaps:** role read from user-editable `user_metadata` with open sign-up; unauthenticated `PUT /api/mobile-config`; public audit-log reads that expose operator emails; open LLM command endpoint; PII (plate number, driver) unmasked in silver tables; public repositories contain the RDS hostname and old credentials. | NFR Security and R08 are now worded as requirements and risks, not as achieved. | Fix before the defense or present them as known limitations. |
| C4 | **Shared-database writers:** a second machine still overwrites `gold.ml_predictive_congestion` with 12 horizons. | Affects the reproducibility of congestion results. | One writer per table. |
| C5 | **Scheduled jobs on one laptop** ("Interactive only"; 25 failed runs since 16 Sep). | Operational risk (R05). | Move to a server scheduler for the demonstration. |

## D. Citations requiring team action

1. **Six references could not be found and were removed together with their claims:**
   - Sunio et al. (2023), previously cited as the source of the idling equation
   - Rith et al. (2020), previously cited as the source of the baseline-emission formula
   - Zhang Y. et al. (2022)
   - Vickerman (2021)
   - Haowei et al. (2022)
   - ITF/OECD (2023), "Policy Paper No. 125"

   If the team has the original PDFs, send them for re-checking. Otherwise do not reinstate them.
2. **Real sources that were cited for claims they do not make** were corrected or re-cited (see the Citation Audit). Examples: Ruf et al. for Supabase benchmarks, Attioui & Lahby for "LLM Prior", Smelyakov et al. for GMM, Rengasamy et al. for MLOps, Chung et al. for "93.5%", and Bachechi et al. for "67%".
3. **A GMM traffic-regime source and a GWR crash-frequency source** are still needed. Both methods are described without a citation.
4. **Orphan citations removed:** PIDS (2015), ADB (2012), InfraPPP (2022), MPTC (2024), Vaidyanathan (2024), Nielsen (2012). Supply full references if the team wants them back.
5. **NLEX company facts:** incorporation year and Caloocan headquarters were removed because no official source was retrieved. The 105 km figure is now attributed to MPTC's page; the system covers Km 12–87 (about 76 km measured).
6. **Weak venues retained (consider replacing):** Kaptosv (2025, IJAMRS), Kosasih W & Engel (2026, bit-Tech), the Theseus bachelor's theses (Nguyen 2022, 2025) and the Yao & Graham (2025) preprint.

## E. Figures to redraw (images were not regenerated)

| Figure | Needed change |
|---|---|
| 1.6.1 IPO framework | "External Scraper / Ticketing Websites" → "Event calendar (Philippine Arena)"; "Weather Data API" → "Historical weather (Open-Meteo/ERA5/JMA)" |
| 3.2.1.1.2.1, .7 swimlanes | "OTP / SMS OTP" → "Authenticator code (TOTP)" |
| 3.2.1.1.2.3 | "AI Sandbox" → "Scenario Sandbox" |
| 3.2.1.1.2.4 | Rename "Map Comparison" → "Live Map" (still two maps side by side: live and forecast); maintenance is pulled by the app, not pushed |
| 3.2.1.2.1.1 data pipeline | Remove the Redis streaming buffer, Gate 1 token checks, PII masking and "RAG retrieval source"; Gate 5 → weekly accuracy gate; add Waze poller and dashboard upload |
| 3.10.1 schema | Caption now says "Conceptual … (Design)"; optionally redraw from Table 3.10.1 |
| 3.7.x mock-ups | Keep as design mock-ups; implemented screens go in Chapter 4 |

## F. Formatting decisions

- The original has **no page-number footer**. Add one if the CICS format requires it.
- Headings are numbered by hand and some heading levels are inconsistent (for example, 2.1.4.1 uses Heading 5). They were left as they are, apart from the specific fixes noted in the Revision Report.

## G. Added 24 October 2026
- Decide whether to keep the two MDPI sources (Li et al., 2022; Wen et al., 2021) for the CO₂ gradient-boosting application.
- Optional: if the team can open Zhan et al. (2009, *TRR 2102*) on SAGE and confirm its abstract, it can be added as a second secondary-crash logistic-regression source.
- The Waze poller's code is not in the repository. The owner should confirm that it sets the 10-minute expiry on every write (SET … EX 600, or EXPIRE after SET), because the text relies on it.
- **Check against the full text (library access):** for these sources, only the table of contents or abstract was read:
  - Collett (2023), James et al. (2021) and Washington et al. (2020) (chapters only);
  - Ntziachristos & Samaras (2023) (the EEA chapter page is offline);
  - Lord et al. (2021);
  - Kermo & Dželihodžić (2026), whose IEEE conference's Scopus status is unconfirmed.
- **Gong et al. (2022):** check whether the 7th author is "Qin, W." or "Wu, Q." in the PDF.
- **Musah et al. (2022):** the reference has no DOI. Add one if it exists.
- **Cambridge Dictionary and Inquirer (Reyes-Estrope, 2025):** both sites block automated checks. Open them and confirm the byline and date.
- **Nguyen (2025):** add the awarding university to the thesis entry.
- **Optional (heavy vehicles, 2.1.3.8):** "accelerate more slowly" was removed because no readable 2020+ source states it. If the team can check HCM 7th edition Chapter 12 in print, it can be restored with a page number.
- **Miller et al. (2021):** cited without page numbers, because the page numbers in the extracted text may be off by one. Add pages from the PDF if your adviser requires them.

## H. Added 1 November 2026 (thresholds audit)
- **Code fixes:** merge the fixes in SmartFlow_NLEX_Code_Fix_List.md (A1–A19). Chapter 3 describes the system as it will be after them. Until then, the manuscript and the live system disagree on those items, including K4, K9, K15 and K16 being shown on the dashboard (A14, A15, B3).
- **Emission-factor sources:** find the original sources of the Class 1 and Class 2 CO₂e factors (192 and 354 g/km) and of the PM2.5 and NO₂ factors. The archived seed labels them "DENR/DOTC", but no such document exists. One lead: a code comment calls 192 Climatiq's petrol-car factor.
- **Climatiq page:** the Class 3 factor is New Zealand fleet data (MfE, 2020). The title says "over 30 t", but its summary says "above 12 t and 30 t"; check the Climatiq page.
- **Fleet-mix what-if (A10):** confirm that the what-if keeps shifting vehicle-km from Class 3 to Class 2 once "heavy" means Class 2+3 everywhere else.
- **Proponent cut-offs:** Table 3.11.6.1 marks about 40 cut-offs as "Proponent". Review them with NLEX operators during UAT, as Section 3.11.6 states.
- **(2 Nov) Vehicle-class definitions:** the team named PhilRatings' NLEX Corporation report (Nov 2024) as the source for the class definitions (Class 1 light vehicles, Class 2 buses and small trucks, Class 3 large trucks). The public PhilRatings release of 26 Nov 2024 (bond rating) does not define the classes, and no official NLEX or TRB page with definitions was found. The manuscript therefore uses the system's own class labels without a citation. If the team has the report that defines them, share it so it can be verified and cited.
- **(2 Nov) Code still to update:** fixes A20–A21 in the code-fix list (hard-coded old factors in the prescriptive service; idling-factor comment; NOₓ labels).

## I. Added 2 November 2026 (after the team's pull)
- **Code fixes:** 4 of the 21 original fixes are done (A2, A19, A20, A21). A1, A3–A18, B1–B4 and the new A22–A29 remain. Chapter 3 describes the system after these fixes.
- **Most urgent:** A22 (the event-uplift table was overwritten by the circular method on 1 Nov) and A28 (end every test window at 31 Dec 2025 before producing Chapter 4 results).
- **Two pre-2020 data-source exceptions:** Mejia & Sigua (2018) and U.S. Department of Energy (2015, Fact #861). The adviser should confirm that this is acceptable.
- **48-hour band:** the API returns the 80% band, but the dashboard does not draw it yet. Chapter 3 says it is computed and stored.
- **Mobile config (A23):** saving currently needs only a signed-in user. Add the role check.
