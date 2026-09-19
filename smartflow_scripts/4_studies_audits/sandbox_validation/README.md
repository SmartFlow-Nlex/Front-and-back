# AI Sandbox — validation and diagnostics

`validate_sandbox.ts` is the harness. `diagnostics/` holds the throwaway
measurement scripts that were written while building the simulation, kept
because every behavioural claim made about the sandbox came out of one of them
and none of them should have to be trusted on memory.

Run from `Back-End/`, which owns the `tsx` and `pg` installs:

```
cd Back-End
./node_modules/.bin/tsx ../smartflow_scripts/4_studies_audits/sandbox_validation/validate_sandbox.ts
```

The diagnostics run the same way. They print numbers and exit; none of them
write to the database.

---

## What the harness reports

- **Demand reproduction** — the simulation is fed each hour's real volume from
  `gold.fact_traffic_hourly` and asked whether the segment can serve it.
- **Capacity against published figures** — the only speed-side check that can
  honestly be made, with the PCE sensitivity printed alongside because the
  verdict turns on that assumption.
- **Cheapest hour to close a lane** — the operational question the measured
  demand profile makes answerable.

### The limitation, stated up front

The warehouse holds **no observed corridor operating speed**, so the simulation
is calibrated on demand and *bounded* on speed, not validated against NLEX
measurements. Four candidate columns were checked and all four fail; the file
header of `validate_sandbox.ts` records which and why. The short version:
every "speed" column is either jam-interior speed (5–11 km/h at every hour of
the day, including 03:00) or a constant reference value of 121. Volume and
speed correlate at **+0.139** — the wrong sign for a fundamental diagram.

Closing that gap needs loop-detector, probe or toll-transaction travel-time
data that does not currently exist in the warehouse.

---

## diagnostics/

Each of these was written to answer one question, and the answer is recorded
here so the result survives the script.

| script | question | what it found |
|---|---|---|
| `heterogeneity.ts` | Do the agents actually differ from one another? | Yes. Class-1 cars alone run 56–96 km/h; headway cv 24%, politeness cv 49%. |
| `capacity.ts` | What is the segment's capacity, and does flow saturate or collapse? | Found the entrance bug: capacity was 1,100 veh/h/lane and **collapsed** above 1,200. After the fix it saturates at ~2,300. |
| `spawnprobe.ts` | Why is demand not entering? | 45,118 spawn refusals and a hidden backlog of 978 vehicles that nothing rendered. |
| `entry.ts` | What are vehicles at the entrance doing? | Spawning at 15 m/s into an 11 m gap, so IDM demanded −127 m/s² and they emergency-stopped, blocking the entrance. |
| `taper.ts` | Do vehicles get stuck at a lane closure? | Yes — worst wait 308 s before the zipper-merge and patience fixes, 21 s after. |
| `trapped.ts` | Is anything *permanently* trapped in a closed lane? | Yes, and it was entirely Class 2: the heavy-vehicle L1 exception only fired when no permitted lane existed, not when it was full. |
| `closure-ab.ts` | Does giving drivers their own decision cadence hurt merging? | −10% merges, −4% throughput, −44% queue. Not the binding constraint. |
| `jam.ts` | What happens above capacity? | Found 925,052 vehicle-ticks parked at negative x — off the road, invisible, still counted in density. |
| `ramps.ts`, `ramps2.ts` | Do the on/off ramps deliver their configured volumes? | Joins exact (99/100, 66/67); off-ramp share reaches ~78% of the configured turning proportion. |
| `missers.ts` | Why do drivers miss their exit? | 47 of 68 were in the lane *next* to the exit lane — the gain test was discarding the move after every other check had passed. |
| `exitprobe.ts` | How many assigned drivers actually take their exit? | 34% at first, 83% after spawning exit-bound traffic near the outside. |
| `final.ts` | Regression: free flow and closure, both directions. | No vehicle overlaps; the L1 heavy-vehicle ban holds at 0.000 with no closure. |
| `screenshot.ts` | Was the on-screen road really under-populated? | Yes — 1,260 veh/h against a true mainline of 5,996. |
| `mainline.py` | Can mainline flow be derived from toll transactions? | Yes, as a conservation count: entries minus exits upstream. |
| `geom.py` | Does the canvas geometry fit at every zoom? | Used to check the km axis never collides with the ramps or the traffic. |

These were written to be run once and read, not to be maintained. They point at
the simulation by relative path and will need that path adjusted if this folder
moves again.
