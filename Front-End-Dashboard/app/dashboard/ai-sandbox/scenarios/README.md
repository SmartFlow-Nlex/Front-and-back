# Real NLEX incident scenarios

Front-end-only feature for the AI Simulation Sandbox (`app/dashboard/ai-sandbox/`). Lets an
operator add realistic incident events to a running simulation — a breakdown, a collision, an
overturned vehicle, a flood, scheduled roadworks, rain (light, moderate or heavy) — and have each one drive the
**existing** engine levers (`simulation.ts`'s `Interventions`: `closedLanes`, `closurePoint` /
`closureEnd`, `incidents`, `speedLimitKmh`, `speedZone`) on a schedule, instead of the operator
setting those levers by hand. `simulation.ts`, the Back-End and `replicate()` are never modified by
this feature — it is a layer that composes the engine's own inputs, nothing more. The same
folder also carries the NB / SB / Both dual-carriageway view; see [Dual-carriageway view](#dual-carriageway-view-nb--sb--both),
the [scene art](#scene-art-what-each-event-looks-like-on-the-road) that draws each event on the road, and
the [lane reallocation](#lane-reallocation) control.

## Files

| File | What it holds |
|---|---|
| `assumptions.ts` | Every value that does **not** come from NLEX data (lane counts, wreck lengths, buffers, speeds, phase splits…), each as a recorded `Assumption` with a reason, evidence and what would settle it. `listAssumptions()` is how the whole set is enumerated (e.g. for an operator-facing "why these numbers" view, or an audit). |
| `catalogue.ts` | What an operator can add: the 9 `ScenarioTemplate`s, their phases, resources, defaults, and the `FamilyKey`/`ScenarioVariant` type machinery. Structure only — no numbers live here except display labels/ordering. |
| `sampler.ts` | Turns a variant + a `DurationMode` (`sampled` / `p50` / `p90` / `manual`) into a `ResolvedDuration`, via `calibration.json`'s quantiles and the breakdown fallback hierarchy (cause × vehicle → cause → vehicle → family). `resolveDuration` is the one entry point; `calibratedVariantOf()` is where it branches for a family with no calibration entry. |
| `adapter.ts` | The pure core: `composeInterventions(manual, events, simTime, road, previous) -> { interventions, owners }` is the ONE function that decides what the engine holds, given the operator's own settings and the scenario events. Also: scheduling (`schedulePhases`, `boundaryTimes`), conflict/ownership rules, the `EngineBinding` that applies a composition to a real `TrafficSim`, and every view the UI reads (`resolutionView`, `canvasMarks`, `effectiveState`, …). |
| `../sceneArt.ts` | The drawing of every event on the canvas: rain, flowing flood water, roadworks, breakdowns, collisions and their responders, the movable barrier and borrowed lanes. Pure canvas drawing that reads `SceneMark`s and imports only types, so `verify.ts` runs it in Node against a recording context. |
| `../vehiclePaint.ts` | The colour mix of the traffic: palettes and weights for cars, buses, truck cabs and trailers, and `paintFor(id, class)`. Pure decoration; `verify.ts` checks the spread. |
| `../motorcycleArt.ts` | The motorcycle sprite (slim bike, rider's shoulders and helmet, lights), pure drawing that `verify.ts` runs against a recording context. |
| `tools/motorcycle_share.py` | Counts the motorcycle records in the client's breakdown exports and where NLEX files them (reads only the vehicle type and class columns, never a plate or a driver). Read-only. |
| `../zipper.ts` | The lane reallocation rules: `planZipper` (what a transfer does, or why it is refused), `zipperHolds`, `borrowedLanes`. Pure. The file and its identifiers (`planZipper`, `ZIPPER_LANES`, `data-zipper`) keep the name the feature was first built under, a zipper lane / counterflow scheme; everything an operator reads says "Lane reallocation". The engine's own "zipper merge" (vehicles merging at a closure) is unrelated. |
| `tools/measure_rain_cap.ts` | Runs the real engine with and without a whole-segment speed cap, at busy and saturating demand: the measurement quoted in `ASSUMPTIONS.RAIN_SPEED_KMH`'s evidence. Read-only; about a minute. |
| `../components/FamilyIcon.tsx`, `../components/ScenePreview.tsx` | The pictogram on each family chip, and the small animated preview under the chips (drawn by the same `sceneArt.ts` the road uses). Decoration only — they read nothing from the simulation. |
| `verify.ts` | The test suite (see below). Not a framework — a flat script of `check(name, boolean)` calls. |
| `tools/build_calibration.py` | Regenerates `calibration.json` from the client's raw CSV exports (see below). Read-only on the CSVs. |
| `calibration.json` | Generated, not hand-edited. Duration quantiles + breakdown response-share quantiles, per family and per hierarchy cell, plus the generator's own provenance (when, from what, what `min_n` it used). |
| `../components/ScenarioPanel.tsx` | The Add-event panel and the event list. Pure layout: every number, label and badge it shows is built by `adapter.ts`/`catalogue.ts` and just rendered here. Takes per-direction data: one carriageway (NB-only/SB-only) or two (Both, with an "Add to" picker, grouped lists and the skip guard). |
| `../useDirectionSim.ts` | One carriageway's whole simulation as a hook (its `TrafficSim`, engine binding, events, interventions, demand, metrics, baseline). Called twice from `page.tsx`, once per direction. |
| `../bothMetrics.ts` | The corridor totals for Both mode (sum / max / flow-weighted; density has none). Pure. |
| `../components/DirectionPill.tsx` | The NB / SB pill that names a carriageway on every control, row and readout in Both mode. |
| `../page.tsx` | Wiring, the carriageway selector and the canvas (`render` for one carriageway, `renderBoth` for two): calls `useDirectionSim` per direction, drives the shared animation loop (`applyAtBoundary` each frame, `stepToScenarioTime` for "skip to next phase" via the hook), and feeds each direction's *effective* state (operator settings with the scenario laid over them) into the recommendation / before-after / baseline / assistant-context readouts. |

## Dual-carriageway view (NB / SB / Both)

A selector above the road chooses **Both**, **Northbound** or **Southbound** (in that order); the tab opens
on **Both**. Origin and destination
now choose the km window only; direction is the selector's job (it used to be derived from which end
of the route was picked first). NB-only and SB-only run and look as the single-carriageway page always
did. Both simulates and draws the two together: stacked with a median between them, **SB above running
right to left, NB below running left to right**, one shared km axis, and lane 1 (engine index 0,
`LANE1_IS_INNERMOST`) against the median on both sides (SB, the top block, is drawn with its lane order
reversed to make that true). Each carriageway's ramps sit on its outer edge: SB's above it, NB's below.

**How it is built.** `useDirectionSim(direction, shared)` owns one carriageway completely — its own
`TrafficSim`, its own `createEngineBinding()`, scenario events and ownership, manual interventions,
demand and plaza-flow fetch, inflow, lane count, metrics and baseline. It is called exactly twice,
unconditionally; the inactive direction is simply not stepped or drawn. What the two share
(`SharedRoadInputs`) is the km window, the exit list, the hour of day and the class profile, plus the
run/pause state, sim speed and the fixed-step accumulator in `page.tsx`. Two separate engine bindings
matter: a binding closes over private ownership state, so one shared between directions would let each
side's "who owns the closure right now" overwrite the other's (`verify.ts`'s binding-isolation checks
pin that applying one never touches the other). A **focus** direction exists only for the few things
that can address one road at a time — the Command prompt (its request carries no direction), the
full-screen bar, the "Add to" picker and "Load into simulation"; everything else in Both mode shows
both carriageways, each named. There is no separate Focus control: each of those carries **its own NB / SB
choice** (Add to, Commands apply to, Load forecast into, and the full-screen Acting on switch), and they
all move the same state, so choosing on one is seen on the others.

### The two carriageways are independent (modelling limitation)

The two `TrafficSim` instances never interact. There is **no cross-median effect of any kind**: an
incident, closure, speed zone or queue on one carriageway cannot slow, divert or delay anything on the
other (no rubbernecking delay, no debris crossing, no contraflow, no vehicles switching carriageway,
no emergency vehicle using the far side). Each direction's inflow is set independently, anchored to its
own observed volume, and is not conserved between them. Read Both mode as **two independent
one-carriageway runs shown side by side**, not as a coupled model of a divided highway; the corridor
totals below are arithmetic on two separate runs.

Each carriageway also has its **own clock**. "Skip to next phase" fast-forwards only the carriageway
whose events it is skipping, and changing one direction's lane count rebuilds only that direction, so
after either the two can be at different simulated times. A corridor total then adds, maxes or weights
readings taken at different moments. Each direction's own tile row, warm-up note and recommendation is
correct for that direction; the total is not a synchronised snapshot.

> **Top follow-up item for the dual-carriageway work.** Because of this, a corridor total can show a
> combination that **never existed on the road at one moment** — for example NB's queue half an hour
> into a collision added to SB's throughput from before it began — and **nothing in the UI indicates
> it**: the tiles print the total with no sign that the two rows above and below it come from different
> simulated times. **Suggested fix for later:** show each direction's simulated time (`Metrics.elapsedS`
> already carries it, so the data is there) next to that direction's row, and mark the corridor totals
> as stale when the two clocks differ by more than a threshold (the threshold is a choice worth making
> deliberately: a few seconds is ordinary drift between two rebuilds, minutes is a skip).

### Corridor totals (Both mode)

Computed by `bothMetrics.ts` (pure; every rule is pinned in `verify.ts`, and the page only calls it).
The Both-mode tiles show the corridor figure on top with the NB and SB values always visible beneath
it, and print the kind of total in the tile itself.

| Metric | Corridor figure | Rule |
|---|---|---|
| Active agents, throughput, CO₂ rate (also stopped count, unmet demand) | **sum** | counts and rates of physically separate traffic add |
| Longest queue | **max** | a corridor is only as good as its worst queue; two 80 m queues are not one 160 m queue |
| Average speed | **flow-weighted** | Σ(speed × throughput) / Σ(throughput), weight = `throughputPerMin`. Never a plain mean. Null (shown "—") when neither direction has any flow — it does not fall back to a plain mean |
| Density | **none** | vehicles per km per lane on two separate carriageways has no meaningful sum or mean; the tile says "no total" and shows the two rows only (travel time is not totalled either) |

The corridor "vs baseline" delta appears only when **both** directions have a baseline, and is built by
the same rules from the two baselines, so a delta compares like with like.

**Flow-weighting caveat.** Weighting by throughput means a direction that is **blocked has a throughput
approaching zero, so it carries almost no weight, and the corridor speed reads as the healthy
direction's speed.** A carriageway that has stopped entirely can therefore leave the headline speed
looking fine. This is inherent to flow-weighting (which is what was asked for over a plain mean, which
would let a near-empty carriageway pull the headline instead); it is not a bug and is not compensated
for. The per-direction rows under every tile, and each carriageway's own recommendation, are what
expose it — read those, not the corridor speed alone, when one side is closed or queued.

### Seeds

NB uses `12345` — unchanged from before the dual-carriageway work, so NB-only reproduces the previous
single-carriageway behaviour (checked when it was introduced by building the engine both ways and
comparing `metrics()` bit for bit). SB uses `12345 + 7919` (`SEED_BY_DIRECTION` in `useDirectionSim.ts`). Different, widely spaced
seeds rather than a shared one, for the reason `replicate()` already spaces its own seeds by 7919
(`simulation.ts`): adjacent seeds in the cheap PRNG (`mulberry32`) can correlate. Two further reasons
here: NB and SB usually differ in inflow, lane count and ramps anyway, so a shared seed would buy no
real reproducibility; and adjacent seeds would put synchronised arrival "bursts" on both carriageways,
which an operator watching both at once would see.

### Direction is both an explicit field and a bucket

A `ScenarioEvent` (and the `NewEventSpec` it is made from) carries `direction: "NB" | "SB"` as its own
field, **and** lives in that direction's own event list (the one held by that direction's
`useDirectionSim`). Both, deliberately: the field lets a row, a log line or a message name its
carriageway without knowing which list holds it, and having two records of the same fact means a drift
between them is detectable instead of silent. Everything downstream is scoped by the bucket — one
direction's events and manual controls go into `composeInterventions`, so conflicts, resource locks and
ownership are per carriageway (the same event can exist on both at once; a refusal names its direction,
e.g. `SB: Cannot add …`, via `conflictMessage` / `manualClosureMessage`).

The consistency rule is `directionBucketsConsistent(byDirection)` in `adapter.ts`: every event in
bucket X must have `direction === X`. It is **enforced where events are stored**:
`useDirectionSim`'s `addScenarioEvent` goes through `addEventToBucket(direction, …)` (which the panel's
preview also calls, so what the panel shows is what will be stored). That function refuses — returning a
reason and **storing nothing** — (1) an event whose `direction` is not that list's, e.g. `NB: refused an
event that names SB as its carriageway …`, checked *first* so an unrelated refusal (a conflict, a bad
start time) can never mask it; and (2) any add to a list that already holds a wrong-direction event, by
running `directionBucketsConsistent` on the list it would hand back, so a corrupted list stops taking
events instead of carrying the error on. `verify.ts` pins this behaviourally (the mismatch, the masking
case and the corrupted-list case, both directions) and checks that the hook has no bare `addEvent` call
left to bypass it. `addEvent` on its own still stamps the direction from the spec and does not check it
(it does not know which list it is for), so anything new that stores events must go through
`addEventToBucket`.

### Adding to one carriageway or both

In Both mode the Add panel shows an **Add to** picker *under the scenario chips*, so it appears once a
scenario is chosen and offers what applies to it (one carriageway in NB-only or SB-only view: no picker).

- Collisions, breakdowns, the overturned vehicle and roadworks happen on one carriageway: the picker offers
  **Northbound / Southbound**.
- Rain and flooding (`carriageways: "one_or_both"` on the catalogue template) also offer **Both**, which is
  the default: weather is not one carriageway's business, and a flooded stretch is often on both. One event
  goes into **each** carriageway's own list — they are ordinary events, each stamped with its own
  direction, removable separately, and everything above (buckets, conflicts, locks, ownership) applies to
  each unchanged. Both carries the same km, start and duration, and for a flood the same lane number (the
  shorter road's lane list, lane 1 being against the median on both).
- **All or nothing.** The refusal is worked out for every target; if either carriageway would refuse (say it
  already has a rain event over that time), Add is disabled for both and the reason names the carriageway.
- Roadworks are single-carriageway by choice (works are usually on one side); add them twice for both.

Which carriageways a click means is `addTargets` in `adapter.ts` (pure, pinned in `verify.ts`); which
families reach both is data on the template.

### Reset

Reset takes **everything back, the scenarios with it**, on both carriageways (and on the one, in a single
view): every scenario event is removed and the numbering restarts (the next rain is `#1` again); hand-set
closed lanes, speed limit and incidents, the closure and speed-zone stretch positions and any armed placing
tool are cleared; the before/after baselines are discarded; the run is rebuilt (new engine, clock and
warm-up); a **lane reallocation is undone** (the lane counts it changed are put back); a pending Command
proposal and an old confidence-run result are dropped; and the Add-event form goes back to its defaults.
What stays is the setup rather than the run: the route and km window, the **Lanes and Inflow sliders**, the
hour of day, the view (NB / SB / Both) and the run speed. `useDirectionSim`'s `resetAll` does each
carriageway's part; `page.tsx`'s `resetEverything` does the rest.

### Fast-forward cost and the skip guard

"Skip to next phase" steps the engine without drawing. Measured (Chrome, development machine,
2026-09-24, Both mode, through the real UI): roughly **2–5 ms of wall time per simulated second at
600 m and 20–40 ms at 3 km with ramps** on the northbound carriageway while a queue is building; the
southbound one over km 0–3 was roughly 6–10× cheaper (fewer ramp-fed vehicles). Identical setups varied
by up to 1.5–2× from run to run. A calibrated-duration event is quick (a median multi-vehicle collision,
13 simulated minutes, took 2–19 s end to end); a **capped** self accident (535 simulated minutes) took
50–75 s at 600 m. At 3 km it is an estimate of about 9 minutes: the first phase measured 188 s, the tow
phase about 277 s (extrapolated from a 240 s window), and the last phase was not measured.

So a skip is guarded, in every view: its estimated wall time is shown beside the button, and one over
two minutes (`SKIP_WARN_MS`) shows the estimate and asks before starting. The estimate is
(simulated seconds ÷ `SIM_DT`) × the running cost of one `sim.step()` × `SKIP_COST_FACTOR` (2.5, in
`page.tsx`). It is a deliberately **pessimistic upper bound, not a forecast**: across 27 timed skip
intervals the real time was 0.27×–3.98× the bare prediction (median 1.46×, 90th percentile 2.4×). The
slow end is a queue still growing (step cost rises with the vehicles on the road), the fast end a queue
draining, so a draining phase is sometimes flagged when it need not be. In the runs used to set it, no
skip over two minutes went unflagged.

## Rain intensity

Choosing Rain in the Add panel offers **Light / Moderate / Heavy** (default Moderate). Each is a cap on
the speed of the whole simulated stretch for as long as the event runs, through the engine's one speed
zone (`speedLimitKmh` + `speedZone` = `[0, segment length]`): **100, 100 and 96 km/h**
(`ASSUMPTIONS.RAIN_SPEED_KMH`). The event is named for its intensity (`Heavy rain #1`), and its row shows
`Corridor-wide · 96 km/h cap`. Rain still shares the engine's single speed zone, so it conflicts with an
overlapping shoulder breakdown, exactly as before.

**Where the caps come from.** They are derived from one NLEx study, not invented: Mejia & Sigua (2018),
*Impacts of Different Rainfall Intensities on Key Traffic Flow Parameters at …* (the end of the title did not
extract from the PDF; the site is the NLEx), *Philippine Transportation Journal* 1(2), August 2018,
<https://ncts.upd.edu.ph/tssp/wp-content/uploads/2018/08/Mejia18.pdf>. They fitted speed–density curves to
loop-detector data at Km 11+150 northbound near the Balintawak toll plaza (4 lanes; 6-minute data, June to
December 2016, daytime only; rain from a PAGASA weather station within 1 km; PAGASA classes light
0.1–2.5 mm/h, moderate 2.6–7.5, heavy above 7.5) and report free-flow speeds of **109.79 km/h clear,
102.12 light, 101.46 moderate and 97.66 heavy** (Table 2). Each cap is the engine's own free-flow class-1
speed (108 km/h) scaled by that study's rain-to-clear ratio, rounded to whole km/h. Light and moderate come
out the same because the study's own figures for them differ by under 1 km/h: the data do not separate
them, so the cap does not either (the animation does differ). The panel says where the number comes from.

**Limits, stated plainly.** It is one site, one season and one study, calibrated on lanes 3 and 4; free-flow
speed there is a fitted model parameter, not an observed maximum. **A speed cap is a proxy.** Rain's main real
effect is longer following headways, which the engine cannot vary, so a cap reproduces the speed effect and
likely **understates capacity loss**. Measured on this engine (`tools/measure_rain_cap.ts`; 4 lanes, 1 km,
3 seeds), the 100 and 96 km/h caps cut capacity at saturating demand by 2.1% and 2.3% — the study finds 3.7%,
7.6% and 17.4% for light, moderate and heavy — and cut average speed at 1,500 veh/h/lane by 2.9% and 5.1%
(the study: 5.3%, 6.3%, 7.4%). The values these replaced (90 / 75 / 60) were invented round numbers; the same
run shows 60 km/h cutting capacity by 13.7% and busy-road speed by 40%, far past anything the study observed.
Corroboration, not used to set values: the HCM 2000 figures that paper quotes (free-flow speed down 1.9 km/h in
light rain, 4.8–6.4 km/h in heavy; heavy-rain capacity down 14–15%) and the FHWA Road Weather Management page
(freeway speeds down 2–13% in light rain, 3–17% in heavy; no primary source given). The HCM 6th-edition
Chapter 11 weather adjustment factors were looked for and not found in any free source.

## Scene art: what each event looks like on the road

`sceneMarks(events, road, simTime, owners)` (in `adapter.ts`) turns each running event into a `SceneMark`:
its family, phase and how far through the phase it is, and — the important part — **the lanes and stretch
the engine's closure owner actually holds**. An event is drawn holding lanes only if it *owns* the closure,
so the picture never shows a wreck, flood or work zone the engine is not honouring (an event that yielded
its closure to the operator's own is drawn as the amber marker only). `sceneArt.ts` then draws, in this
order: flood water (under the traffic), the vehicles, the scenes (breakdown with hazards and cones,
collision with skid marks, debris and smoke, the responders arriving and leaving by phase, roadworks
with taper, barrels, work truck and arrow board), rain over everything, then the event labels — which
sit on the seam just past the lanes an event holds rather than on top of it.

- **Rain**: two layers of falling drops (density, speed, length and brightness set by intensity), rings
  where drops land, a cool wet tint on the asphalt, and a speed-limit roundel showing the cap. The
  engine's orange speed-zone wash is not drawn for a rain-owned zone (the whole-segment zone tinted the
  entire road brown); the roundel and the rain say it instead. Two rain events draw the stronger one only.
- **Flood**: water over the flooded lane(s) — a rippling shoreline, streaks and glints that move with the
  direction of travel, foam at the edge, a caution sign and a depth gauge.
- **Animation clock**: one clock in `page.tsx` that advances only while the run is running, so pausing
  freezes the rain, the flowing water and the blinking beacons. The drops are a pure function of the
  clock (nothing stored per drop).
- **Picker**: each family chip has a pictogram and an animated preview shows the selected family (accident
  families cycle through their phases). It freezes for people who ask for reduced motion. The scenario's
  description is behind an **"i"** at the top right of that picture: a button that opens it over the panel,
  closes on Escape or when another scenario is picked.

- **The traffic itself** is drawn as metallic vehicles — a highlight-to-shadow gradient across the body, dark
  glass, a thin outline — in a realistic spread of colours (`vehiclePaint.ts`): cars mostly white, silver,
  grey and black (about two thirds), then blues, reds and a few greens, beiges, yellows and oranges; buses in
  liveries (white, blue, red, green, yellow, orange); truck cabs in fleet colours with trailers mostly white or
  silver, chosen independently of the cab. The paint is picked from the vehicle's id so it never changes frame
  to frame, and dark paint gets a lighter rim and paler glass so it does not vanish into the asphalt. Cars,
  buses and trucks are told apart by shape (length, a run of bus windows, a truck's cab and ribbed trailer)
  rather than by colour, so the legend shows the shapes; the brake lights stay red and glow when lit. Sprites
  have a 15 px legibility floor (`MIN_LEN_PX` in `page.tsx`), capped so they cannot overlap their neighbour or
  outgrow their lane.

The scenes are illustrations of the engine's state, not measurements: the wreck's angle, the debris and the
number of responders are decoration. Wreck *length*, lanes and duration are still the recorded assumptions.

## Lane reallocation

In Both mode, a control under the Lanes sliders moves **1 or 2 lanes** from one carriageway to the other:
`NB +1`, `NB +2`, `SB +1`, `SB +2`, or Off. The control says, in one line, what it does: *Lanes are reassigned
between carriageways; vehicles do not cross the median.* The canvas draws a movable barrier (yellow and
black, with the transfer vehicle) in the median in place of the fixed one, and marks the lanes the recipient
was given (its innermost n, against the barrier) with reversible-lane chevrons. (It was first built as a
"zipper lane" for one lane and "counterflow" for two; those names are gone from everything an operator reads.)

**What it models, and what it does not.** The engine cannot change a carriageway's lane count mid-run and
the carriageways still never interact (see the limitation above), so this is a **lane-count transfer**: the
two `setLaneCount`s change together, the total is conserved, and **both runs restart** (any lane-count
change does). What changes is the capacity of each carriageway — not flow crossing the median. There is
deliberately **no timed reallocation event**: a scheme that switches on at some minute would need the engine
to change lanes mid-run. The limits (a carriageway keeps at least 2 lanes and takes at most 6; at most 2
lanes move) are `ASSUMPTIONS.ZIPPER_LANES` — modelling bounds, not operating rules; the Lanes sliders reach 6
while a reallocation is on. The scheme is dropped the moment either lane count stops matching what it set
(the Lanes slider, a segment change), so the barrier is never drawn where it is not. Off restores the
original lane counts. Whether NLEX runs a movable barrier on this corridor is not recorded anywhere here.

**What a change restarts.** Both carriageways, always — a transfer changes both lane counts, so there is no
unaffected direction. Each carriageway is rebuilt (`rebuild()` in `useDirectionSim.ts`): a new engine, so the
clock, the warm-up and the metrics start again; the hand-set closed lanes, speed limit and incidents are
cleared; the before/after **baseline is discarded**; a fast-forward in progress is cancelled. **Scenario
events are kept** and replay from their start (their times are measured from the new run's warm-up); an event
on a lane the new lane count no longer has is flagged and goes inert rather than being dropped. The control
says this in a line under its options, before the operator presses anything; there is **no confirmation
step**, the same as for the Lanes slider.

**Six lanes.** The Lanes slider stops at 5 and a reallocation can make a 6-lane carriageway, so the engine
was checked at 6. Same 1 km road, no ramps, three seeds, 1,500 simulated seconds: at 800 and 1,500
veh/h/lane the throughput per lane is the demand at every lane count from 2 to 6 (e.g. 799 / 801 at 4 / 6
lanes), and at a saturating 3,000 veh/h/lane the admitted flow per lane is 2,196 / 2,186 / 2,180 / 2,172 /
2,173 at 2 / 3 / 4 / 5 / 6 lanes — no loss of per-lane capacity at 6 (0.3% below 4 lanes). Average speeds
are the same at every lane count (about 91 km/h at 800, 80 at 1,500 and 78 at 3,000 veh/h/lane). `verify.ts`
pins a shorter version (6 lanes within 5% of 4 lanes per lane at saturation).
This tests the engine's arithmetic on a plain road only: it does not show that a real 6-lane NLEx carriageway
behaves like this, and the engine's lane rules (e.g. heavy vehicles kept out of lane 1) were not tuned for 6.

## Motorcycles

**What our data says.** NLEX's own breakdown exports (2022–2026, 156,939 records) list **944 motorcycles**
(0.60% of records), and **every one is filed under Class 1** (of 73,662 Class 1 records: 1.28%). The hourly
traffic table (`gold.fact_traffic_hourly`, as `smartflow_scripts/1_data_loading/traffic/load_fact.js` builds it)
holds `class_1`, `class_2`, `class_3` and a total — **no motorcycle count**. NLEX counts motorcycles inside
Class 1, so they are already part of the Class 1 share the engine runs on; nothing we hold says how many
motorcycles *pass*. The accident exports carry a vehicle count but no vehicle type. (When this was written the
warehouse could not be reached from this machine — the connection's TLS handshake was being reset — so the
traffic table's columns were read from its loader, not from the live database.)

**What the sandbox does with it.** It draws **1.28% of the Class 1 vehicles as motorcycles**
(`ASSUMPTIONS.MOTORCYCLE_SHARE_OF_CLASS_1` = 944 / 73,662), chosen by vehicle id so a vehicle stays a
motorcycle for its whole life; buses and trucks never are. The legend has a Motorcycle row saying where the
figure comes from. That share is the *only* motorcycle number in our data, and it is a **fleet share only if
motorcycles break down as often, per vehicle, as other Class 1 vehicles do** — an assumption, recorded as one,
with what would settle it (toll transactions or loop detectors, which NLEX has and the warehouse does not).

**It is a picture, not a model.** The engine has no motorcycle class and `simulation.ts` is not touched, so a
vehicle it treats as a car is *drawn* as a motorcycle: it keeps a car's length, gap and lane behaviour (no
filtering between lanes, no different braking). Motorcycles therefore change nothing in any metric.

## Which families are calibrated

9 families total. 5 draw a duration from real NLEX data; 4 do not and are **manual-duration-only**:

| Calibrated (Sampled / Median / 90th / Manual) | Manual-only (no calibration entry exists) |
|---|---|
| Breakdown in a lane | Overturned vehicle |
| Breakdown on the shoulder | Flooding |
| Minor collision (rear-end / side-swipe / hit-and-run) | Scheduled roadworks |
| Multi-vehicle collision | Rain (Light / Moderate / Heavy) |
| Self accident | |

The 4 manual-only families and *why* each has no entry are recorded in one place:
`ASSUMPTIONS.NO_CALIBRATION_FAMILIES` in `assumptions.ts`. Short version: NLEX's own exports have no
category at all for overturned vehicle, flooding or roadworks; rain's weather column exists, but
checked against calibration.json's own population/exclusion rules it shows no real difference in
clearance time, so there's nothing real to calibrate against either. `resolveDuration` throws if
asked for anything but `manual` on one of these four (`drawManualOnly` in `sampler.ts`), and the
resolved duration carries `level: "none"`, `n: 0` — a fixed, positive signal (`ResolutionView.noCalibration`,
badge text `NO_CALIBRATION_NOTE` in `adapter.ts`) shows this in both the Add panel and an added
event's row, deliberately distinct from an *ordinary* manual draw on a calibrated family (which
also shows "entered by you" but never that badge — the distinction is `resolved.level === "none"`,
not `resolved.mode === "manual"`).

## Regenerating `calibration.json`

```
cd app/dashboard/ai-sandbox/scenarios/tools
python build_calibration.py --csv-dir <folder with accident_data_*.csv and breakdown_data_*.csv>
```

`--csv-dir` (or the `NLEX_CSV_DIR` env var) is required — there is no built-in default path, and the
generator is checked (`verify.ts`) to never reference one. Useful flags: `--out` (defaults to
`../calibration.json`), `--date` (pins `generated_on` for a reproducible diff), `--min-n` (defaults
to `ASSUMPTIONS.LOW_SAMPLE_N`, 200 — the minimum usable events a hierarchy cell needs before it's
trusted; `verify.ts` checks the generator's default and the file's own recorded value agree). The
script is read-only on the CSVs and deterministic (same input files → same output bytes, modulo
`--date`). Read the file's own docstring header for the exact exclusion rules (what counts as a
usable duration, the breakdown multi-deployment event rule, etc.) before changing anything about how
a number is computed — those rules are the actual data contract between this file and `sampler.ts`.

## Running the tests

```
cd Back-End
./node_modules/.bin/tsx ../Front-End-Dashboard/app/dashboard/ai-sandbox/scenarios/verify.ts
```

Read-only, exits 1 on any failure, prints every `FAIL` with its name. As of this write-up: **1,425
checks**. It guards, in order: the sampler reproduces the calibrated quantiles and response shares
exactly (distribution, cap behaviour, reproducibility per seed); the breakdown hierarchy fallback and
its cap-source chain; the catalogue/assumptions' internal consistency (phases, shares, lanes,
lengths, resources, per-family default lane/vehicle/cause matching the data's own mode); closure
geometry (buffer, wreck length, clamping) against 20,000 random cases; drift guards (chainage table,
engine constants mirrored from `simulation.ts`, calibration file provenance); the adapter's
scheduler and ownership rules (conflicts, yielding, lock-while-owned, no carry-over, zero-length
phases, a road that stops suiting an event); the real engine loop, rebuild, removal and fast-forward;
every UI view (`resolutionView`, `describeResolution`, `effectiveState`, `describeBoundary`,
`canvasMarks`); and a 1,500-trial fuzz check that re-composing with the previous ownership fed back
is always a fixed point after one apply (the live-apply effect re-applies on every render — this is
what stops that looping). For the dual-carriageway view it also pins the direction bookkeeping
(`directionBucketsConsistent` and the `addEventToBucket` guard that enforces it, including the cases that must be refused), that two engine bindings never touch
each other, every corridor-aggregation rule in `bothMetrics.ts` (including zero flow and unequal
flow), and — as source checks, since `page.tsx` cannot be imported by a Node script — the structure
of click routing, the pinned command direction and the Both-mode tile labels; rendered behaviour is
checked in a browser rather than here. It also pins the rain intensities (order, caps, names, what the
engine applies), `sceneMarks` (including which event owns the lanes), the scene art itself — run in Node
against a recording canvas context: drop counts per intensity, determinism, that the clock moves the drops
and the flood streaks, what is clipped to the road, what a paused or pending event draws, the drops' colour —
and the lane reallocation's pure rules, its wiring, the clear-on-add behaviour of the panel, that the
engine's per-lane capacity holds at 6 lanes, the motorcycle share and sprite, which carriageways an Add goes to (`addTargets`, and the
panel's all-or-nothing handling of Both), what Reset clears, and that every one-road-at-a-time control has
its own NB / SB choice.

There is also a strict `tsc` pass (two scratch tsconfigs — one for `scenarios/**` + `components/**`,
one for `page.tsx` — both extending the project's own `tsconfig.json` with `noUnusedLocals`,
`noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch` turned on) and `next lint`,
both expected clean apart from one item that is not this feature's (`LANE_CHANGE_BASE_SEC` at
`simulation.ts:311` is declared and never read, which strict `tsc` and lint both report; it predates
this work and `simulation.ts` is not modified by it); no `any`, non-null assertion (`!`) or cast (`as X`, except `as const`) belongs
anywhere in this feature. New logic should be mutation-tested by hand (temporarily break the logic,
confirm `verify.ts` actually fails, restore it) rather than trusted on the strength of a passing run
alone — several early drafts of tests in this feature's history passed against broken code the first
time they were written.

## Open items

- **Corridor totals can mix simulated moments** (top follow-up for the dual-carriageway work): see the
  per-carriageway clock note under [The two carriageways are independent](#the-two-carriageways-are-independent-modelling-limitation)
  for the problem and the suggested fix (show each direction's sim time; mark totals stale when the
  clocks differ by more than a threshold).
- **Class-filtered blockage** (`ASSUMPTIONS.CLASS_FILTERED_BLOCKAGE`, new): the engine's closure
  lever is binary — a lane is closed to every vehicle class or open to all of them. Flooding is
  modelled as a single closed lane over 150 m for exactly that reason, but this is a **placeholder**,
  not a modelled result: real flooding affects outer lanes first and is class-dependent (water
  shallow enough for a truck to pass can still stop a car), and nothing here represents that.
  Overturned vehicle and scheduled roadworks do *not* have this problem — both are genuine full-width
  closures for every vehicle class, so a binary closure isn't a simplification for them the way it is
  for flood. Settling this for real needs either a per-class/per-height lever in `simulation.ts`
  (out of this feature's scope) or NLEX/DPWH guidance on typical flood depth by vehicle class.
- **Timed events and `replicate()`**: the confidence-run / Monte-Carlo path (`replicate()` in
  `simulation.ts`) has no notion of a scenario's timed events — it replays the engine's *current,
  static* `Interventions` many times, which a scenario's phases don't fit (a phase's lanes/zone
  change over the run). `page.tsx` refuses a confidence run outright while the carriageway has any scenario event
  (`if (focused.scenarioEvents.length > 0) return;`, with an operator-facing note explaining why) and
  always in Both mode ("Confidence runs support one carriageway at a time."), rather
  than running something that would silently misrepresent the events. Making a confidence run
  scenario-aware would mean teaching `replicate()` to accept a timed intervention schedule, which is
  a `simulation.ts` change and therefore outside this feature as scoped.
- **Persistence**: each direction's `scenarioEvents` is plain in-memory React state (`useState` in
  `useDirectionSim.ts`) with no
  save layer under it — a page refresh or navigation away loses every added event. Nothing here
  writes to the Back-End or to browser storage. Worth deciding deliberately (and likely scoping
  separately) before anyone relies on a scenario run surviving a reload.
- **Open questions for NLEX / the client**: everything in `assumptions.ts` is an assumption *because*
  the data alone doesn't settle it, but a few specifically ask something only NLEX/the client can
  answer (not "collect more data" or "an internal modelling choice") — compiled here from each
  entry's own `settledBy` field, for whoever writes this up to check against whatever list was
  already in mind:
  1. **`LANE1_IS_INNERMOST`** — which physical end of the road "Lane 1" refers to in the exports.
     Marked `PENDING` explicitly; if it turns out false, every lane default in this feature inverts
     (`operatorLaneToEngineIndex`/`engineIndexToOperatorLane` in `assumptions.ts` document the flip).
  2. **`CHAINAGE_OFFSET_KM`** — whether an authoritative chainage table exists (`gold.exit_km_post`
     was unreachable, database down, when this was derived) to replace the 12.04 km offset derived
     here from matching named places between the app's exit list and the event exports.
  3. **`UPSTREAM_BUFFER_M`** / **`CLOSURE_LENGTH_M`** — NLEX's actual incident-management practice for
     advance-warning distance and typical scene/work-zone footprint, none of which is recorded in any
     export.
  4. **`MULTI_DEPLOYMENT_RULE`** — when a breakdown event carries several deployment records, whether
     they're successive visits to the *same* obstacle (this feature's assumption) or separate jobs.

  If "the four client questions" already discussed elsewhere is a different set than this, treat
  this list as this feature's own candidates, not a claim that it's the canonical one.
- **Rain is a speed cap, which understates rain**: `RAIN_SPEED_KMH` (100 / 100 / 96) is derived from one NLEx
  study (see [Rain intensity](#rain-intensity)) and is still an assumption — one site, one season — and a
  cap cannot lengthen headways, which is where most of rain's effect on capacity lies. Settling it needs
  loop-detector data from more sites and a following-headway lever in `simulation.ts`.
- **A lane reallocation cannot be timed and does not carry traffic across**: see the lane reallocation
  section. `ZIPPER_LANES` (2 to 6 lanes, at most 2 moved) is a modelling bound and needs NLEX guidance on
  movable barriers. Timing it would need a lane change mid-run in `simulation.ts`, and carrying traffic across
  the median would end the independence of the two carriageways, which is the model's core simplification.
- **Lane reallocation restarts both carriageways without a confirmation step** (the Lanes slider does the
  same): see what a change restarts. A confirm dialog is the obvious follow-up if operators lose work to it.
