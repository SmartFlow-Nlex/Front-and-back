# SmartFlow NLEX — Live Demo Run Sheet

Slide 10 (Actual System Demonstration) · planned 6:50–19:20 (12:30, about 63%) of a 20-minute working assumption. The first 20 seconds are Hans's spoken lead-in on slide 10.

| # | Clock | Duration | Speaker | Operator | Screen | Action | Purpose |
|---|---|---|---|---|---|---|---|
| 1 | 7:10–7:55 | 0:45 | Hans | Ysa | Sign-in (two-step) | Email + Password → Sign In → Authenticator code → Verify | Show that operator access is protected and role-based |
| 2 | 7:55–8:50 | 0:55 | Hans | Ysa | Overview | Read the freshness line, "Right now" counts and "Slowest reading on the corridor"; scroll to "Live Corridor Status" | Answer "What is happening right now?" in one glance |
| 3 | 8:50–10:00 | 1:10 | Hans · Jertz | Ysa | Live Map | Sidebar → Live Map; compare "Waze Real-Time Traffic" with "Forecasted Traffic"; timeline → "Next 24 h" | Put now and next side by side |
| 4 | 10:00–10:55 | 0:55 | Hans | Ysa | Traffic › Descriptive | Sidebar → Traffic; Descriptive tab; "Average Volume by Hour and Day"; events/holidays card → "Holidays" | Show recurring patterns from the 2022–2025 record |
| 5 | 10:55–12:20 | 1:25 | Hans · Jertz | Ysa | Traffic › Predictive | Predictive tab; "Traffic Volume Walk-Forward Forecast"; "Validation evidence" → "View"; "Predictive Congestion State Map" → "Next 24 h"; optional "Generate report" | Show forecasts together with how reliable they are |
| 6 | 12:20–13:00 | 0:40 | Hans | Ysa | Traffic › Prescriptive | Prescriptive tab; "Booth Staffing Plan"; move "One booth serves N veh/hr" slider; "Congestion Response Advisory" | Turn the forecast into a staffing recommendation the operator can adjust |
| 7 | 13:00–14:05 | 1:05 | Hans · Jertz | Ysa | Incidents | Sidebar → Incidents; Descriptive: "Hotspots by Km Segment", "Dry vs Wet: Incidents per Day"; Prescriptive: "Clearance Response Protocol" (Accident · Injury · Wet · Peak) | Show where incidents concentrate and a suggested response protocol |
| 8 | 14:05–16:30 | 2:25 | Hans | Ysa | Scenario Sandbox | Sidebar → Scenario Sandbox; Carriageway SB; set km range; "Capture baseline"; Command tab → SmartFlow Copilot command → "Execute Command" → "Apply"; "Play" at 10×; read "Before / after"; optional Confidence run | Test an intervention against a no-intervention baseline before acting on the road |
| 9 | 16:30–17:10 | 0:40 | Ysa | Hans | Emissions | Sidebar → Emissions; Descriptive KPI "Total CO₂ (Modeled)" and "Delay-Induced CO₂"; point at the emission-factor note | Connect traffic decisions to estimated CO₂ |
| 10 | 17:10–17:55 | 0:45 | Ysa | Hans | Mobile Control Centre | Sidebar → Mobile App; Advisories → "Manage" → "Add advisory"; type message; Tone "Warning"; tick "Publish"; "Save & publish" | Show the operator controlling what commuters see, without an app update |
| 11 | 17:55–19:20 | 1:25 | Ysa | Ysa (phone) | Commuter mobile app | Alerts tab (advisory) → Corridor tab → "Forecast" → "Next 7 days" → tap an exit → Assistant: "How is NLEX right now?" | Show the commuter's view: advisory, exit forecast, and a corridor-only assistant |
| — | 19:20 | — | Kiarra | Hans | PowerPoint slide 11 | Return to PowerPoint | Close the story |

**Total demo time:** 0:20 lead-in on slide 10 + 12:10 of steps = 12:30

## Pre-flight checklist

- [ ] Sign in on the demo laptop is NOT done in advance: the sign-in is part of the demo. Have a Data Analyst account ready (it is the only role that sees every page, including Emissions) and the authenticator app on Ysa's phone.
- [ ] Open the dashboard in a window sized to the projector (1920×1080 or 1440×900). Set Appearance to Light theme in Settings so it matches slide 10.
- [ ] Warm every page once 15–30 minutes before the defense (Overview, Live Map, Traffic, Incidents, Emissions, Scenario Sandbox, Mobile App). The demonstration API is on a free tier and can take several seconds after inactivity. The Live Map needs 20–35 seconds for map tiles the first time.
- [ ] Check the Overview freshness line says "Live", not "Feed stale". If it says stale, say so in the demo — do not hide it.
- [ ] Phone: install the SmartFlow NLEX mobile app, sign in (two-step), and mirror the screen to the projector laptop (e.g. scrcpy or the vendor's screen-mirroring app). Test the mirror on the venue projector.
- [ ] Prepare the advisory text in advance: "Demo advisory: lane works near Km 20 southbound this afternoon." Delete it after the defense.
- [ ] Rehearsal check: confirm the sandbox flow — Capture baseline, then Apply the Copilot plan, then Play — fills the "Before / after" panel. If the order differs on the day, follow what the screen asks and keep the narration.
- [ ] Keep PowerPoint running in Slide Show on slide 10 so Alt+Tab returns to it.
- [ ] Rehearse once on the defense network, and write the day's numbers in the [REHEARSAL] blanks only as a guide — always read live values off the screen.

## Time checks

Kiarra gives a hand signal at 12:20 (should be on Traffic › Prescriptive), 14:05 (should be entering Scenario Sandbox) and 17:10 (should be on Mobile Control Centre). Optional lines are not counted in the timing. If behind at 14:05, skip the Confidence run; if behind at 17:10, skip the Assistant question.

## Fallbacks

- A page loads slowly: Hans keeps talking about what it will show ("While this loads, here is what we are looking for…"); after 20 seconds, move to the next step and return later if time allows.
- The live feed is stale or the internet drops: say plainly that live features depend on the Waze feed and the connection (a documented limitation), then continue with the historical analytics, which read from the warehouse.
- The language-model narrative or the Copilot command fails or is slow: say that these depend on an outside provider; the narrative falls back to a fixed template, and every Copilot change can be made with the manual controls instead (Close a lane → Set stretch).
- Phone mirroring fails: Ysa shows the same forecast on the dashboard's Mobile Control Centre Preview and describes the app; do not use recorded video.
- A panel member asks for a number that is not on screen: answer "We would rather not quote that from memory; we can show it in the system or in the manuscript."

## Rehearsal placeholders

- [morning/afternoon] in Kiarra's opening line.
- Defense duration: 20 minutes is a working assumption. Replace it if the panel sets a different limit, and re-time the demo so it stays at about 60–70%.
- [REHEARSAL: …] values in the demo (congested counts, slowest exit and speed, champion model and accuracy, booth counts, hotspot segment, sandbox before/after values, CO₂ total). They change with the data; read them off the screen.
- UAT results (task success, SUS score) are not in the current manuscript (Chapter 3 states a UAT plan; results belong in Chapter 4). The script does not quote any. Add them only after Chapter 4 is final.
