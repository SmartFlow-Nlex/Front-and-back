# SmartFlow NLEX — Presenter Script

**A Journey Toward Smarter Traffic Decisions** · Mock Defense and Actual Defense

*SmartFlow NLEX: A Multisource Corridor Analytics and Decision-Intelligence System for Expressway Traffic Management*

## How to use this script

- **Working assumption: 20 minutes** of presentation before Q&A. No presentation length is documented in the manuscript; replace this if the panel gives you one.
- About **12 minutes 30 seconds (63%)** goes to the live demonstration, which has exactly one slide (slide 10).
- Lines that start with a presenter's name (e.g. **Hans:**) are spoken word-for-word. Lines in *[brackets]* are cues and are never read aloud. **Operator action** lines are for the person at the keyboard.
- Objective text inside quotation marks is the exact wording of Sections 1.4.1 and 1.4.2. Read it verbatim.
- Values marked **[REHEARSAL: …]** change with live data. Read them off the screen on the day; never memorise a number from rehearsal.
- Source manuscript: *SmartFlow_NLEX_Chapters_1-3_Revised.docx* (manuscript-exports/Ch1-3_Revision_2026-10-21, rebuilt 2 Nov 2026).

### Roles

| Presenter | Role | Main speaking parts |
|---|---|---|
| Kiarra | Project Manager | Opening hook, problem, system and team introduction, closing; demo timekeeper |
| Jertz | Quality Assurance | Objectives, scope, limitations; reading accuracy and limits during the demo |
| Hans | Lead Developer | Leads the live demo: sign-in, Overview, Live Map, Traffic, Incidents, Scenario Sandbox |
| Ysa | Developer | Demo operator for Hans's part; presents Emissions, Mobile App configuration and the commuter mobile app |

Speaking parts are presentation assignments only. They do not indicate who built or tested any feature.

### Timing plan

| Slide | Section | Time | Speaker(s) |
|---|---|---|---|
| 1 | A. Introduction — SmartFlow NLEX (title) | 0:00–0:25 | Kiarra |
| 2 | A. Introduction — Illustrative scenario — Friday, 5:00 PM | 0:25–1:05 | Kiarra |
| 3 | A. Introduction — Two gaps between data and decisions | 1:05–1:50 | Kiarra |
| 4 | A. Introduction — SmartFlow NLEX merges the lanes | 1:50–2:40 | Kiarra |
| 5 | B. Objectives — General objective | 2:40–3:25 | Jertz |
| 6 | B. Objectives — Specific objectives 1–2 | 3:25–4:25 | Jertz |
| 7 | B. Objectives — Specific objectives 3–4 | 4:25–5:05 | Jertz |
| 8 | C. Scope and Limitations — Scope — where this route runs | 5:05–6:00 | Jertz |
| 9 | C. Scope and Limitations — Limitations — know the road conditions | 6:00–6:50 | Jertz |
| 10 | D. Actual System Demonstration | 6:50–19:20 (12:30) | Hans, Ysa, Jertz |
| 11 | E. Closing — Closing — Friday, 5:00 PM, again | 19:20–19:56 | Kiarra |
| 12 | E. Closing — Thank you — Questions? | 19:56–20:00 | Kiarra |

Approximate spoken words per presenter (at ~140 words per minute): Kiarra 481 · Jertz 732 · Hans 1020 · Ysa 328.

## A. Introduction

### Slide 1 — SmartFlow NLEX (title) · 0:00–0:25

*[Kiarra stands centre. Slide 1 is already showing when the panel is ready.]*

**Kiarra:** Good [morning/afternoon], members of the panel. We are Group 4 of 3ISB, and this is SmartFlow NLEX: A Multisource Corridor Analytics and Decision-Intelligence System for Expressway Traffic Management.

*[Pause]*

**Kiarra:** Today we want to take you on a short journey — from a familiar problem on the expressway to a system you will see running live. Let me start with a moment many of us know.

*[Advance slide]*

### Slide 2 — Illustrative scenario — Friday, 5:00 PM · 0:25–1:05

**Kiarra:** Picture this. It is Friday, five in the afternoon, at the start of a long weekend. You are heading north from Balintawak, at kilometre twelve. This is an illustrative scenario, not a recorded event — but the situation is familiar.

**Kiarra:** Right now, everyone can see the traffic. Navigation apps show red lines. Social media shows photos of the toll plaza.

*[Pause — gesture to the 'In 2 hours' and 'Tomorrow' markers]*

**Kiarra:** But the operator in the control room needs to answer a harder question. Not "What is happening?" — but "What is likely to happen next, and what should we do before it does?"

*[Advance slide]*

### Slide 3 — Two gaps between data and decisions · 1:05–1:50

**Kiarra:** Our manuscript found two gaps behind that question.

**Kiarra:** The first gap: the data look backward. Traffic, incident and toll data are presented mainly as summaries of current or past conditions. There is no forecasting layer to anticipate surges from weather, holidays or events.

**Kiarra:** The second gap: the data travel in separate lanes. Toll records, incident logs, crowdsourced reports, weather and event schedules are held separately, never combined in one analytical pipeline.

**Kiarra:** And the stakes are real. For Holy Week 2025, traffic across NLEX, SCTEX and the NLEX Connector was projected to peak at about four hundred ninety-three thousand vehicles a day, against about three hundred fifty thousand on a regular NLEX day.

*[Advance slide]*

### Slide 4 — SmartFlow NLEX merges the lanes · 1:50–2:40

**Kiarra:** So we built SmartFlow NLEX to merge those lanes.

**Kiarra:** It brings six kinds of data into one warehouse — toll, incident, Waze, weather, holiday and event data — and answers four questions. What happened? What is likely next? What response should we consider? And can we test it before we act?

**Kiarra:** Operators see the results in a desktop dashboard. Commuters see them in a mobile app. One principle runs through all of it: the system advises — operators decide.

**Kiarra:** I am Kiarra, the project manager. With me are Jertz, our quality assurance lead; Hans, our lead developer; and Ysa, our developer.."] Jertz will now show you where this journey is headed.

*[Handoff — Kiarra steps back; Jertz steps forward]*

*[Advance slide]*

## B. Objectives

### Slide 5 — General objective · 2:40–3:25

**Jertz:** Thank you, Kiarra. Every journey needs a destination. Ours is our general objective, which I will read exactly as approved.

*[Read verbatim — do not paraphrase]*

**Jertz:** "The general objective of this capstone project is to develop and evaluate SmartFlow NLEX, a centralized decision-intelligence platform that leverages a 4-year historical NLEX dataset alongside real-time crowdsourced and external data to optimize proactive traffic management and incident response. By reducing traffic congestion, the capstone project proposal will support SDG 9 (Industry, Innovation, and Infrastructure) through lower vehicular carbon emissions."

**Jertz:** In simple terms: use four years of history plus live data to help operators act earlier. To get there, we set four waypoints.

*[Advance slide]*

### Slide 6 — Specific objectives 1–2 · 3:25–4:25

**Jertz:** Specific Objective 1:

**Jertz:** "To evaluate response strategies within an Agent-Based Simulation Sandbox in order to minimize expressway downtime and maximize vehicle throughput during incidents or demand surges, providing NLEX management with a risk-free, data-driven environment to test operational decisions before live deployment using a custom HTML5 Canvas-based simulation interface."

**Jertz:** In other words: try a response on a virtual road first.

**Jertz:** Specific Objective 2:

**Jertz:** "To develop the "SmartFlow NLEX" decision-intelligence system for NLEX operators using a custom-built Next.js and TypeScript web dashboard. This system aims to merge and visualize real-time, multi-source data streams across web and conversational channels. By doing so, we will provide operators with a highly usable, accessible platform that simplifies complex data, streamlines operational decision-making, and ensures widespread user adoption."

**Jertz:** That is the dashboard you will see in a few minutes.

*[Advance slide]*

### Slide 7 — Specific objectives 3–4 · 4:25–5:05

**Jertz:** Specific Objective 3:

**Jertz:** "To analyze a 4-year historical NLEX dataset to map and identify recurring systemic inefficiencies and traffic congestion patterns for strategic capacity planning using Python and RStudio."

**Jertz:** Specific Objective 4:

**Jertz:** "To deploy existing multi-source predictive models within the SmartFlow NLEX dashboard that forecast expressway conditions using integrating historical toll records, crowdsourced data, weather inputs, and event schedules using existing machine learning algorithms."

**Jertz:** Put simply: learn from the past, then forecast what comes next — and show how accurate each forecast is.

*[Advance slide]*

## C. Scope and Limitations

### Slide 8 — Scope — where this route runs · 5:05–6:00

**Jertz:** Now, the route itself. SmartFlow NLEX covers the NLEX main line, from Balintawak at kilometre twelve to Sta. Ines at kilometre eighty-seven — twenty exits, about seventy-six kilometres.

**Jertz:** It serves four kinds of users. On the dashboard: Traffic Control Center operators, incident operators and NLEX data analysts. On the mobile app: commuters and drivers.

**Jertz:** It reads hourly toll records from January 2022 to December 2025, NLEX incident records, the Waze archive and a live feed refreshed about every two minutes, plus weather, air quality, holidays and a calendar of one hundred fifty-nine events.

**Jertz:** And it does four things: it describes past patterns, it forecasts — including congestion for each exit from one to one hundred sixty-eight hours ahead — it recommends responses, and it lets operators test them in a sandbox. It also estimates emissions.

*[Advance slide]*

### Slide 9 — Limitations — know the road conditions · 6:00–6:50

**Jertz:** Before we drive, a QA lead should tell you the road conditions. Here are the limits we want you to keep in mind during the demo.

**Jertz:** First, the system is advisory. It does not control barriers, signs or patrol units. Second, it is evaluated as a capstone demonstration, not in live NLEX operations — so any reduction in congestion or emissions is estimated from history and simulation, not observed.

**Jertz:** Third, forecasts are estimates. Several models beat simple baselines only modestly, and anything beyond the validated horizon is labelled unvalidated. Fourth, emissions are estimates from fixed European factors, not roadside measurements. And finally, live features depend on the internet and on outside providers.

**Jertz:** With that, let's see it working. Hans?

*[Handoff — Hans moves to the demo laptop]*

*[Advance slide]*

## D. Actual System Demonstration

### Slide 10 — Actual System Demonstration · 6:50–19:20

*[Slide 10 stays on screen while Hans introduces the demo.]*

**Hans:** Thank you, Jertz. For the next twelve minutes, we follow one operator through a shift — signing in, seeing what is happening, forecasting what comes next, and testing a response before acting. Then Ysa shows the commuter's side. Ysa drives the keyboard while I explain.

*[Switch to live system]*

**Before the defense (operator checklist):**

- Sign in on the demo laptop is NOT done in advance: the sign-in is part of the demo. Have a Data Analyst account ready (it is the only role that sees every page, including Emissions) and the authenticator app on Ysa's phone.
- Open the dashboard in a window sized to the projector (1920×1080 or 1440×900). Set Appearance to Light theme in Settings so it matches slide 10.
- Warm every page once 15–30 minutes before the defense (Overview, Live Map, Traffic, Incidents, Emissions, Scenario Sandbox, Mobile App). The demonstration API is on a free tier and can take several seconds after inactivity. The Live Map needs 20–35 seconds for map tiles the first time.
- Check the Overview freshness line says "Live", not "Feed stale". If it says stale, say so in the demo — do not hide it.
- Phone: install the SmartFlow NLEX mobile app, sign in (two-step), and mirror the screen to the projector laptop (e.g. scrcpy or the vendor's screen-mirroring app). Test the mirror on the venue projector.
- Prepare the advisory text in advance: "Demo advisory: lane works near Km 20 southbound this afternoon." Delete it after the defense.
- Rehearsal check: confirm the sandbox flow — Capture baseline, then Apply the Copilot plan, then Play — fills the "Before / after" panel. If the order differs on the day, follow what the screen asks and keep the narration.
- Keep PowerPoint running in Slide Show on slide 10 so Alt+Tab returns to it.
- Rehearse once on the defense network, and write the day's numbers in the [REHEARSAL] blanks only as a guide — always read live values off the screen.

#### Demo 1 — Sign-in (two-step) · 7:10–7:55 (0:45)

*Speaker: Hans · Operator: Ysa · Objective link: SO 2*

> **Operator action:** On the sign-in page, type the Data Analyst email and password, click "Sign In". On "Enter Your Code", type the 6-digit code from the authenticator app, leave "Remember this device for 7 days" unticked, click "Verify".

**Hans — Spoken:** “Our operator starts the shift here. SmartFlow NLEX is decision support for a public expressway, so access matters. Signing in takes two steps: a password, then a six-digit code from an authenticator app on the operator's phone.”

**Hans — Spoken:** “What you see next depends on your role. We are signed in as a data analyst, who sees every page. A Traffic Control Center operator does not see Emissions, data uploads or the audit log, and an incident operator also does not see the sandbox.”

*[Wait for the Overview to load]*

#### Demo 2 — Overview · 7:55–8:50 (0:55)

*Speaker: Hans · Operator: Ysa · Objective link: SO 2 · GO*

**Hans — Spoken:** “This is the Overview. Remember Kiarra's question: what is happening right now? This page answers it in one glance.”

> **Operator action:** Point the cursor at the freshness line under the title.

**Hans — Spoken:** “First, we check that the data are fresh. This line says the Waze jam reports are [REHEARSAL: "Live · just now"] and covers a sixty-minute window. If the feed ever falls behind, the same line says "Feed stale" — the system tells you when not to trust it.”

> **Operator action:** Point at the headline card and "Slowest reading on the corridor".

**Hans — Spoken:** “Right now, [REHEARSAL: N] exit-directions are congested, and the slowest reading on the corridor is at [REHEARSAL: exit · N km/h].”

> **Operator action:** Scroll down to "Live Corridor Status".

**Hans — Spoken:** “Below, Live Corridor Status lays out every exit from Balintawak to Sta. Ines, in both directions, coloured congested, slow or clear. This is the present. But an operator's job is the next few hours — so let's open the Live Map.”

#### Demo 3 — Live Map · 8:50–10:00 (1:10)

*Speaker: Hans · Jertz · Operator: Ysa · Objective link: SO 2 · SO 4*

> **Operator action:** Click "Live Map" in the sidebar (Operations group). Wait for both maps to draw (allow up to 30 seconds on first load).

**Hans — Spoken:** “The Live Map puts two maps side by side. On the left, Waze Real-Time Traffic: jams and alerts reported by drivers, refreshed about every two minutes. On the right, Forecasted Traffic: the congestion state our model expects at each exit.”

> **Operator action:** On the timeline under the maps, click "Next 24 h". Use "Jump to exit…" and choose [REHEARSAL: the congested exit named on the Overview].

**Hans — Spoken:** “With the timeline, the operator can move forward in time — here, the next twenty-four hours. Now we are not just looking at traffic. We are looking at traffic that has not happened yet.”

**Jertz — Spoken:** “One quality note. The percentage beside the forecast model — labelled accurate, and ML Confidence — is the model's R-squared: how well it fits past data, not the share of correct forecasts. And the exit-level forecast is only modestly better than the usual pattern for that exit and hour, which is why we show it beside the live data.”

**Hans — Spoken:** “Thanks, Jertz. So where do these forecasts come from? Let's go to Traffic.”

#### Demo 4 — Traffic › Descriptive · 10:00–10:55 (0:55)

*Speaker: Hans · Operator: Ysa · Objective link: SO 3*

> **Operator action:** Click "Traffic". Make sure the "Descriptive" tab is selected. Set Range to "Custom": 1 Jan 2022 – 31 Dec 2025 (the period the manuscript reports; do not use "All"). Scroll to "Average Volume by Hour and Day".

**Hans — Spoken:** “Traffic has three tabs that follow our analytics: Descriptive — what happened; Predictive — what's next; and Prescriptive — what to do.”

**Hans — Spoken:** “Descriptive first. This heatmap, Average Volume by Hour and Day, is built from four years of hourly toll records, January 2022 to December 2025. Each cell is an hour of the week. The darker cells are the recurring peaks — [REHEARSAL: describe the darkest band, e.g. weekday mornings and Friday evenings]. These are the patterns our third objective asked us to map.”

> **Operator action:** On the events/holidays card, click the "Holidays" toggle (title becomes "Holiday Impact vs Normal Days").

**Hans — Spoken:** “And here we compare holidays with normal days around them, so the operator sees how much a long weekend actually changes demand at each plaza. History tells us what usually happens. Next, the forecast tells us what is likely this time.”

#### Demo 5 — Traffic › Predictive · 10:55–12:20 (1:25)

*Speaker: Hans · Jertz · Operator: Ysa · Objective link: SO 4*

> **Operator action:** Click the "Predictive" tab. Wait for "Traffic Volume Walk-Forward Forecast".

**Hans — Spoken:** “This is the Traffic Volume Walk-Forward Forecast: past, present and future. Five candidate models are trained. The one with the lowest error on held-out data — which must also beat a simple baseline — becomes the champion, re-selected at every weekly retraining. Today it is [REHEARSAL: champion model name].”

> **Operator action:** On the card's "Validation evidence" strip, click "View".

**Jertz — Spoken:** “This is what QA cares about most. Every forecast comes with its evidence: the champion, the period it was tested on, and its error — here [REHEARSAL: accuracy / WMAPE value] — next to a naive baseline, which simply repeats the same day of last week. A model that cannot beat that should not be trusted, and some of our candidates, like the daily LSTM, did not.”

> **Operator action:** Close the modal. Scroll to "Predictive Congestion State Map". Set Range to "Next 24 h".

**Hans — Spoken:** “Below, the Predictive Congestion State Map shows low, medium or high congestion for each exit, hour by hour, up to seven days ahead, refreshed every hour. The commuter app uses this same forecast.”

*[Optional, only if on time: click "Generate report" on the volume card]*

**Hans — Spoken:** “[Optional] And if an operator prefers words to charts, "Generate report" asks a language model to explain the chart in plain language — using only the values already shown, and with a fixed template if the model is unavailable. It explains the result; it never changes it.”

#### Demo 6 — Traffic › Prescriptive · 12:20–13:00 (0:40)

*Speaker: Hans · Operator: Ysa · Objective link: GO · SO 2*

> **Operator action:** Click the "Prescriptive" tab. On "Booth Staffing Plan", point at the slider "One booth serves N veh/hr" (default 350).

**Hans — Spoken:** “A forecast is only useful if it leads to a decision. On the Prescriptive tab, the Booth Staffing Plan turns the forecast volume into how many toll booths to open per plaza, per hour.”

> **Operator action:** Drag the slider from 350 to about 300, then back.

**Hans — Spoken:** “The assumption is visible: one booth serves three hundred fifty vehicles an hour by default. If a plaza is slower, the operator changes it and the plan updates — [REHEARSAL: plaza, hour, booths before → after]. Below, the Congestion Response Advisory flags exits where severe congestion is predicted. All of these are recommendations; the operator decides. Now, the other half of the job — incidents.”

#### Demo 7 — Incidents · 13:00–14:05 (1:05)

*Speaker: Hans · Jertz · Operator: Ysa · Objective link: SO 3 · GO*

> **Operator action:** Click "Incidents". On "Descriptive", set Range to "Custom": 1 Jan 2022 – 31 Dec 2025 (if Custom is not offered here, use "All" and do not quote a period). Scroll to "Hotspots by Km Segment".

**Hans — Spoken:** “Incidents follow the same three tabs. On the descriptive side, Hotspots by Km Segment ranks the stretches of the corridor where accidents and breakdowns concentrate. The top segment in the 2022 to 2025 record is [REHEARSAL: Km segment].”

> **Operator action:** Scroll to "Dry vs Wet: Incidents per Day".

**Hans — Spoken:** “And this compares incidents per day in dry and wet weather — useful when a rainy Friday is in the forecast.”

> **Operator action:** Click the "Prescriptive" tab. On "Clearance Response Protocol", set Type "Accident", Severity "Injury", Weather "Wet", Demand "Peak".

**Hans — Spoken:** “On the prescriptive side, the Clearance Response Protocol suggests how many response units to send and when to escalate, for the situation the operator describes — here, an injury accident, in the rain, at peak demand.”

**Jertz — Spoken:** “Two reminders. The protocol learns from historical clearance times, and only from the records that have one. And it dispatches no one — it shows its assumptions so an operator can judge it.”

**Hans — Spoken:** “Which brings us to the question every operator wants answered before committing a crew: what if we try it first?”

#### Demo 8 — Scenario Sandbox · 14:05–16:30 (2:25)

*Speaker: Hans · Operator: Ysa · Objective link: SO 1*

> **Operator action:** Click "Scenario Sandbox" (Planning group). Set "Carriageway" to "SB". In Simulation Controls › Corridor, choose "Km range" and set a short stretch around Km 20 (e.g. From km 19 to To km 23), then click "Set a km range".

**Hans — Spoken:** “This is the Scenario Sandbox — our first specific objective. Every car you will see is an agent. Each one follows rules for keeping a safe distance and for changing lanes, and congestion emerges from how they interact. The traffic flowing in is drawn from our warehouse data, not invented.”

> **Operator action:** Click "Play". Set speed to "10×". Let it run about 10 seconds. Then click "Capture baseline".

**Hans — Spoken:** “First, we let the road run normally and capture that as our baseline — the no-intervention case. Every result will be compared against it.”

> **Operator action:** Open the "Command" tab (SmartFlow Copilot). Type: isara lane 4 southbound mula Km 20.1 hanggang 20.4 — click "Execute Command". Wait for "Interpreting…". Read the proposed plan, then click "Apply".

**Hans — Spoken:** “Now the scenario. Instead of clicking controls, an operator can type an instruction in English, Filipino or Taglish — here, in Filipino: close lane four southbound from kilometre 20.1 to 20.4. [Pause] Nothing changes yet. The Copilot shows the plan it understood and waits for Apply. A language model reads the sentence; the operator stays in control.”

> **Operator action:** Click "Play" (10×). Let it run 20–30 seconds. Point at the queue forming at the closure, then at the "Before / after" panel.

**Hans — Spoken:** “Watch the cars merge out of the closed lane — and watch the queue grow behind it. The Before / after panel compares the two runs: average speed, throughput, longest queue and the CO₂ rate. With the closure, [REHEARSAL: avg speed X → Y km/h; longest queue A → B].”

*[Optional, only if on time: Confidence run — set Runs to 5, click "Run"]*

**Hans — Spoken:** “[Optional] One run can be lucky. The Confidence run repeats the simulation several times and reports each measure as an average with a ninety-five percent confidence interval.”

**Hans — Spoken:** “So before a single cone goes on the road, the operator sees the likely cost of the closure, and can try another stretch, another time, or a speed-limit zone. These are simulated estimates, not observations — a risk-free place to be wrong.”

**Hans — Spoken:** “Ysa, over to you.”

*[Handoff — Ysa speaks; Hans takes the keyboard]*

#### Demo 9 — Emissions · 16:30–17:10 (0:40)

*Speaker: Ysa · Operator: Hans · Objective link: GO*

> **Operator action:** Click "Emissions" (Data Analyst only). Stay on "Descriptive" and set Range to "Custom": 1 Jan 2022 – 31 Dec 2025. Point at "Total CO₂ (Modeled)" and "Delay-Induced CO₂".

**Ysa — Spoken:** “Thanks, Hans. Our general objective links traffic to carbon emissions. For every toll trip, the system multiplies the kilometres driven between its entry and exit plazas by a fixed factor for its vehicle class — for this period, [REHEARSAL: total CO₂ and its low–high range].”

**Ysa — Spoken:** “Delay-Induced CO₂ adds what vehicles emit idling behind lane-blocking incidents. As Jertz said, these are modelled estimates with European factors, not roadside measurements — so we always show the range.”

**Ysa — Spoken:** “Now, everything so far has been for operators. But the driver at Balintawak is the one sitting in the queue. So let's look at how operators reach them.”

#### Demo 10 — Mobile Control Centre · 17:10–17:55 (0:45)

*Speaker: Ysa · Operator: Hans · Objective link: SO 2*

> **Operator action:** Click "Mobile App" (page title "Mobile Control Centre"). On the Advisories strip click "Manage" → "Add advisory". Paste the prepared message, set Tone to "Warning", tick "Publish", click "Save & publish".

**Ysa — Spoken:** “This is the Mobile Control Centre. From here, an operator decides what travellers get. Each tab of the mobile app has its own sections that can be switched on or off, and the Preview on the right shows the result.”

**Ysa — Spoken:** “Most importantly, the operator can publish an advisory. I am publishing a warning about lane works near kilometre twenty southbound — the same closure we just tested. No new app version is needed; the phones pick it up from the server.”

*[Switch the projector to the mirrored phone]*

#### Demo 11 — Commuter mobile app · 17:55–19:20 (1:25)

*Speaker: Ysa · Operator: Ysa (phone) · Objective link: SO 2 · SO 4*

> **Operator action:** On the phone, open the "Alerts" tab and show the advisory just published.

**Ysa — Spoken:** “Here is the commuter's side. On the Alerts tab, the advisory we just published is already here [REHEARSAL: if it has not arrived, pull to refresh].”

> **Operator action:** Open the "Corridor" tab. Switch from "Live now" to "Forecast". Choose "Next 7 days". Tap the exit shown congested earlier; show Northbound / Southbound.

**Ysa — Spoken:** “On the Corridor tab, the driver sees the same exit-by-exit congestion forecast the operator saw — live now, or forecast up to seven days ahead. Tap an exit, and you see the expected condition in each direction. So the driver at Balintawak can check before leaving, not after joining the queue.”

> **Operator action:** Open the "Assistant" tab. Tap the suggestion "How is NLEX right now?".

**Ysa — Spoken:** “And for drivers who would rather ask, the assistant answers questions about current corridor conditions, in English or Tagalog, using the system's live corridor data. It is deliberately limited: it declines general questions, and it does not give travel times or tell you when to leave.”

*[Pause for the answer to appear]*

**Ysa — Spoken:** “[REHEARSAL: one sentence summarising the answer.] From the control room to the driver's phone — that is one connected flow. Kiarra?”

*[Return to PowerPoint — Hans switches the projector back to the laptop and Alt+Tabs to the slideshow; advance to slide 11]*

**If something fails during the demo:**

- A page loads slowly: Hans keeps talking about what it will show ("While this loads, here is what we are looking for…"); after 20 seconds, move to the next step and return later if time allows.
- The live feed is stale or the internet drops: say plainly that live features depend on the Waze feed and the connection (a documented limitation), then continue with the historical analytics, which read from the warehouse.
- The language-model narrative or the Copilot command fails or is slow: say that these depend on an outside provider; the narrative falls back to a fixed template, and every Copilot change can be made with the manual controls instead (Close a lane → Set stretch).
- Phone mirroring fails: Ysa shows the same forecast on the dashboard's Mobile Control Centre Preview and describes the app; do not use recorded video.
- A panel member asks for a number that is not on screen: answer "We would rather not quote that from memory; we can show it in the system or in the manuscript."

## E. Closing

### Slide 11 — Closing — Friday, 5:00 PM, again · 19:20–19:56

**Kiarra:** Let's go back to Friday, five o'clock, at Balintawak.

**Kiarra:** Before, the only question anyone could answer was: what is happening right now? With SmartFlow NLEX, an operator can also ask: what is likely next, how reliable is that estimate, and what could we test before we act?

**Kiarra:** Our contribution: six data sources in one corridor warehouse; every forecast shown with its accuracy against a naive baseline; and recommendations, with a safe place to try them first.

*[Pause]*

**Kiarra:** Because on an expressway, the best time to manage a queue is before it forms.

*[Advance slide]*

### Slide 12 — Thank you — Questions? · 19:56–20:00

**Kiarra:** Thank you. We would be glad to take your questions.

*[All presenters stand in line. Keep the live system open on the second screen or one Alt+Tab away for questions.]*

## Placeholders to resolve before rehearsal

- [morning/afternoon] in Kiarra's opening line.
- Defense duration: 20 minutes is a working assumption. Replace it if the panel sets a different limit, and re-time the demo so it stays at about 60–70%.
- [REHEARSAL: …] values in the demo (congested counts, slowest exit and speed, champion model and accuracy, booth counts, hotspot segment, sandbox before/after values, CO₂ total). They change with the data; read them off the screen.
- UAT results (task success, SUS score) are not in the current manuscript (Chapter 3 states a UAT plan; results belong in Chapter 4). The script does not quote any. Add them only after Chapter 4 is final.

## Source discrepancies to know before the defense

- SO 3 says "using Python and RStudio"; no R code exists in the repository (Pending Decisions A4). The objective is shown verbatim; be ready for the question.
- The general objective says the project will support SDG 9 "by reducing traffic congestion"; the system is not deployed in live operations, so reductions are estimated, not observed (Limitation: Deployment and Evaluation Scope). The script never claims an observed reduction.
- Mobile app, Dashboard tab: the "Traffic Forecast" card shows delay and travel time, but the manuscript says travel-time estimates are not part of the current version (Section 3.8e, Limitation: AI Knowledge Domain Restriction). The demo uses the Corridor tab instead. Fix the app or the manuscript before the defense.
- Scenario Sandbox: the manuscript lists travel time among the outputs (FR-06, Section 3.8f); the sandbox shows avg speed, throughput, longest queue and CO₂ rate, but no travel time. The script names only the outputs that exist.
- Live Map: the "% accurate" and "ML Confidence" figures are the model's R², not an accuracy measure. Jertz says so during the demo.
- Event uplift: the weekly batch overwrote the event-surge table with the old circular method (Code Fix List A22). The demo avoids the "Event Surge Impact by Exit" card and the Events toggle; do not open them if asked without a caveat.
- Date range: the warehouse has records after 31 Dec 2025, but the manuscript reports the NLEX record as Jan 2022 – Dec 2025. The demo sets Custom ranges ending 31 Dec 2025 on descriptive views. Forecast charts may still show 2026 dates as the 'present'.
- Mobile Control Centre: the "Corridor outlook" switch has no effect in the app, and saving needs only a signed-in user (Code Fix List A23). The demo does not use that switch.
- Open code fixes (Code Fix List A1, A3–A18, A22–A29) mean some live screens may differ from Chapter 3 (for example, the "12-hour horizon" wording on the Congestion Response Advisory). Rehearse on the build you will defend with.
