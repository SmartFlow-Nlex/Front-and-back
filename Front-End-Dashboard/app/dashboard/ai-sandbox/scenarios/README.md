# Real NLEX incident scenarios

Front-end-only feature for the AI Simulation Sandbox (`app/dashboard/ai-sandbox/`). Lets an
operator add realistic incident events to a running simulation — a breakdown, a collision, an
overturned vehicle, a flood, scheduled roadworks, heavy rain — and have each one drive the
**existing** engine levers (`simulation.ts`'s `Interventions`: `closedLanes`, `closurePoint` /
`closureEnd`, `incidents`, `speedLimitKmh`, `speedZone`) on a schedule, instead of the operator
setting those levers by hand. `simulation.ts`, the Back-End and `replicate()` are never modified by
this feature — it is a layer that composes the engine's own inputs, nothing more. The same
folder also carries the NB / SB / Both dual-carriageway view; see [Dual-carriageway view](#dual-carriageway-view-nb--sb--both).

## Files

| File | What it holds |
|---|---|
| `assumptions.ts` | Every value that does **not** come from NLEX data (lane counts, wreck lengths, buffers, speeds, phase splits…), each as a recorded `Assumption` with a reason, evidence and what would settle it. `listAssumptions()` is how the whole set is enumerated (e.g. for an operator-facing "why these numbers" view, or an audit). |
| `catalogue.ts` | What an operator can add: the 9 `ScenarioTemplate`s, their phases, resources, defaults, and the `FamilyKey`/`ScenarioVariant` type machinery. Structure only — no numbers live here except display labels/ordering. |
| `sampler.ts` | Turns a variant + a `DurationMode` (`sampled` / `p50` / `p90` / `manual`) into a `ResolvedDuration`, via `calibration.json`'s quantiles and the breakdown fallback hierarchy (cause × vehicle → cause → vehicle → family). `resolveDuration` is the one entry point; `calibratedVariantOf()` is where it branches for a family with no calibration entry. |
| `adapter.ts` | The pure core: `composeInterventions(manual, events, simTime, road, previous) -> { interventions, owners }` is the ONE function that decides what the engine holds, given the operator's own settings and the scenario events. Also: scheduling (`schedulePhases`, `boundaryTimes`), conflict/ownership rules, the `EngineBinding` that applies a composition to a real `TrafficSim`, and every view the UI reads (`resolutionView`, `canvasMarks`, `effectiveState`, …). |
| `verify.ts` | The test suite (see below). Not a framework — a flat script of `check(name, boolean)` calls. |
| `tools/build_calibration.py` | Regenerates `calibration.json` from the client's raw CSV exports (see below). Read-only on the CSVs. |
| `calibration.json` | Generated, not hand-edited. Duration quantiles + breakdown response-share quantiles, per family and per hierarchy cell, plus the generator's own provenance (when, from what, what `min_n` it used). |
| `../components/ScenarioPanel.tsx` | The Add-event panel and the event list. Pure layout: every number, label and badge it shows is built by `adapter.ts`/`catalogue.ts` and just rendered here. Takes per-direction data: one carriageway (NB-only/SB-only) or two (Both, with an "Add to" picker, grouped lists and the skip guard). |
| `../useDirectionSim.ts` | One carriageway's whole simulation as a hook (its `TrafficSim`, engine binding, events, interventions, demand, metrics, baseline). Called twice from `page.tsx`, once per direction. |
| `../bothMetrics.ts` | The corridor totals for Both mode (sum / max / flow-weighted; density has none). Pure. |
| `../components/DirectionPill.tsx` | The NB / SB pill that names a carriageway on every control, row and readout in Both mode. |
| `../page.tsx` | Wiring, the carriageway selector and the canvas (`render` for one carriageway, `renderBoth` for two): calls `useDirectionSim` per direction, drives the shared animation loop (`applyAtBoundary` each frame, `stepToScenarioTime` for "skip to next phase" via the hook), and feeds each direction's *effective* state (operator settings with the scenario laid over them) into the recommendation / before-after / baseline / assistant-context readouts. |

## Dual-carriageway view (NB / SB / Both)

A selector above the road chooses **Northbound**, **Southbound** or **Both**. Origin and destination
now choose the km window only; direction is the selector's job (it used to be derived from which end
of the route was picked first). NB-only and SB-only run and look as the single-carriageway page always
did. Both simulates and draws the two together: stacked with a median between them, NB above running
left to right, SB below running right to left, one shared km axis, and lane 1 (engine index 0,
`LANE1_IS_INNERMOST`) against the median on both sides (NB is drawn with its lane order reversed to
make that true).

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
both carriageways, each named.

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

## Which families are calibrated

9 families total. 5 draw a duration from real NLEX data; 4 do not and are **manual-duration-only**:

| Calibrated (Sampled / Median / 90th / Manual) | Manual-only (no calibration entry exists) |
|---|---|
| Breakdown in a lane | Overturned vehicle |
| Breakdown on the shoulder | Flooding |
| Minor collision (rear-end / side-swipe / hit-and-run) | Scheduled roadworks |
| Multi-vehicle collision | Heavy rain |
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

Read-only, exits 1 on any failure, prints every `FAIL` with its name. As of this write-up: **1,323
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
checked in a browser rather than here.

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
