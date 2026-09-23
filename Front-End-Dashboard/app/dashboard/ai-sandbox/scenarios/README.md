# Real NLEX incident scenarios

Front-end-only feature for the AI Simulation Sandbox (`app/dashboard/ai-sandbox/`). Lets an
operator add realistic incident events to a running simulation — a breakdown, a collision, an
overturned vehicle, a flood, scheduled roadworks, heavy rain — and have each one drive the
**existing** engine levers (`simulation.ts`'s `Interventions`: `closedLanes`, `closurePoint` /
`closureEnd`, `incidents`, `speedLimitKmh`, `speedZone`) on a schedule, instead of the operator
setting those levers by hand. `simulation.ts`, the Back-End and `replicate()` are never modified by
this feature — it is a layer that composes the engine's own inputs, nothing more.

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
| `../components/ScenarioPanel.tsx` | The Add-event panel and the event list. Pure layout: every number, label and badge it shows is built by `adapter.ts`/`catalogue.ts` and just rendered here. |
| `../page.tsx` | Wiring only: owns the `scenarioEvents` state, drives the two loops (`applyAtBoundary` each animation frame, `stepToScenarioTime` for "skip to next phase"), and feeds the *effective* state (operator settings with the scenario laid over them) into the recommendation / before-after / baseline / assistant-context readouts that already existed. |

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

Read-only, exits 1 on any failure, prints every `FAIL` with its name. As of this write-up: **1,271
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
what stops that looping).

There is also a strict `tsc` pass (two scratch tsconfigs — one for `scenarios/**` + `components/**`,
one for `page.tsx` — both extending the project's own `tsconfig.json` with `noUnusedLocals`,
`noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch` turned on) and `next lint`,
both expected clean; no `any`, non-null assertion (`!`) or cast (`as X`, except `as const`) belongs
anywhere in this feature. New logic should be mutation-tested by hand (temporarily break the logic,
confirm `verify.ts` actually fails, restore it) rather than trusted on the strength of a passing run
alone — several early drafts of tests in this feature's history passed against broken code the first
time they were written.

## Open items

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
  change over the run). `page.tsx` refuses a confidence run outright while any scenario event exists
  (`if (scenarioEvents.length > 0) return;`, with an operator-facing note explaining why), rather
  than running something that would silently misrepresent the events. Making a confidence run
  scenario-aware would mean teaching `replicate()` to accept a timed intervention schedule, which is
  a `simulation.ts` change and therefore outside this feature as scoped.
- **Persistence**: `scenarioEvents` is plain in-memory React state (`useState` in `page.tsx`) with no
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
