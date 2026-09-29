# Prescriptive emissions optimiser — specification

Replaces the three hardcoded bars in `app/dashboard/sustainability/page.tsx`
(`prescriptiveEmissionReduction`, values `[8, 14, 22]`, labelled **Illustrative**)
with strategies computed from warehouse data.

Written 2026-09-29. Verified against the live database, not assumed.

---

## 1. The emissions model you are optimising against

Every CO₂ figure on this tab comes from `nlex_theoretical_emissions`:

```
CO₂(e,h,c,d)  =  volume × segment_distance_km × F(c)
```

for exit `e`, hour `h`, vehicle class `c`, direction `d`. `F(c)` comes from
`nlex_emission_factors`:

| class | label | F(c) g/km | % of traffic | % of CO₂ |
|---|---|---:|---:|---:|
| 1 | Light | **192** | 86.01 | 62.88 |
| 2 | Medium | **354** | 9.79 | 13.21 |
| 3 | Heavy | **1492** | 4.20 | **23.91** |

**This model is exactly linear and has no congestion or speed term.** Verified:
dividing observed `co2_grams` by `volume × segment_distance_km` returns
192.00 / 354.00 / 1492.00 — the factor table to the cent. There is no speed
column in the table, and no observed corridor speed exists anywhere in the
warehouse.

### ⚠ The consequence, before you design anything

**Peak-spreading is a no-op.** Moving a trip from 17:00 to 10:00 changes its
emissions by exactly zero, because emissions depend on distance and class, not
on when the trip happens. CO₂ per vehicle-km by hour ranges only 256.97–263.26
g (2.4%), and that spread is *fleet-mix composition shifting across the day*,
not congestion.

Do not build a "shift demand off-peak" strategy. It would report a saving the
model cannot produce. The peak *does* matter, but only through Strategy C.

**Data span:** 2022-01-01 → 2026-06-30, 4,660,732 rows, 10 exits. The June
cutoff is the source CSV's, not a pipeline fault.

---

## 2. The idling sub-model (Strategies B and C)

Idling sits *outside* the linear model. From `calculateRow()` in
`emissions.service.ts`:

```
trapped_vehicles = (daily_volume / 1440) × delay_min
idle_CO₂_kg      = trapped_vehicles × delay_min × φ
                 = (daily_volume / 1440) × delay_min² × φ
```

**Idling CO₂ grows with the square of delay.** That is what makes clearance
time worth optimising: halving a 60-minute incident saves four times what
halving a 30-minute one does.

`φ` is the idling factor, currently fetched live from Climatiq
(`passenger_vehicle-vehicle_type_car-fuel_source_petrol`, 1 km) × 0.10.
**Cache it.** An optimiser that calls Climatiq per candidate solution will be
rate-limited, and the factor does not change between runs.

---

## 3. Strategy A — Heavy-vehicle share

Class 3 is 4.20% of vehicles and 23.91% of CO₂. It is the largest lever.

| | |
|---|---|
| **Decision variable** | `δ` — percentage points of Class-3 vehicle-km reassigned to Class 1/2 |
| **Objective** | minimise `CO₂_total`; saving = `δ/100 × Σ(V·L) × (F₃ − F_target)` |
| **Constraints** | `0 ≤ δ ≤ δ_policy`, a **stated policy target**, not an observed bound — see below. Total vehicle-km conserved: this is a composition shift, not traffic removal. |
| **Data** | `nlex_theoretical_emissions` (volume, segment_distance_km, vehicle_class), `nlex_emission_factors` |

### This one is a sensitivity, not an optimisation — label it as such

The first draft of this spec said to derive `δ_max` from the observed monthly
spread of Class-3 share. **Measured, that spread is 0.037 pp** — over 54 months
the share moves only between 4.172% and 4.242%. The fleet mix on this corridor
is effectively constant.

So there is no observed feasible region to optimise inside. Bounding Strategy A
by history would return a saving near zero and imply the lever is worthless,
which is the wrong conclusion: the lever is large, it has simply never been
pulled.

Report it as an **elasticity** instead — CO₂ saved per 1 pp of Class-3 share
converted — with `δ` an explicit policy input. The UI must show that `δ` is a
chosen target and that nothing in 54 months of history demonstrates it is
achievable. Strategies B and C are bounded by what has actually been achieved;
this one is not, and the difference has to be visible to the reader.

---

## 4. Strategy B — Incident clearance time

| | |
|---|---|
| **Decision variable** | `τ_b` — target clearance minutes for each severity/percentile band `b` |
| **Objective** | minimise `Σ_b n_b × (V̄_b / 1440) × τ_b² × φ` |
| **Constraints** | `τ_b ≥ floor_b` (the 10th percentile actually achieved in that band — you cannot beat your own best observed response); `τ_b ≤ current_b` |
| **Data** | `silver.nlex_accident_events_clean` (`clearance_min`, `event_start_date`, `km_value`), `gold.fact_traffic_hourly` for `V̄` at the incident's hour and exit |

Observed: 21,067 events with clearance times. **Mean 22.8 min, median 5.0,
p90 59.0.** Heavily right-skewed — a small tail of long incidents carries most
of the idling cost, because of the square. Optimise the tail, not the mean.

**Queue geometry.** `calculateRow()` in `emissions.service.ts` computes
`trapped × delay`, which charges every vehicle the full delay — true only if
the queue never discharges. A queue that builds and drains is triangular, so
use `λ × T² / 2`. Combined with corridor-wide rather than per-segment exposure,
the uncorrected form ran **40× high**: it put a single 6.4-hour incident at
1,912 t, trapping more vehicles than use the whole corridor in half a day.

**Volatility.** Because the cost is quadratic and ~1.5% of incidents exceed
three hours, short Ranges swing hard. Q1 2025 held 1.09% such incidents against
1.72% across the rest of 2025 — enough on its own to move the per-incident
figure threefold. A 3-month window is indicative, not a measurement.

---

## 5. Strategy C — When to put the responders

The same minute saved is worth far more at some hours than others, because
`trapped_vehicles` scales with volume at that hour:

```
hour 17:  59,402,999 vehicle-hours      hour 02:  6,001,569
```

Nearly 10×. This is the *only* legitimate way the peak enters an emissions
strategy.

| | |
|---|---|
| **Decision variable** | `a_h` — share of a fixed response capacity assigned to hour `h` (or exit `e`) |
| **Objective** | maximise CO₂ avoided = `Σ_h n_h × (V_h/1440) × (τ_h² − τ_h(a_h)²) × φ` |
| **Constraints** | `Σ_h a_h = A` (capacity fixed — this is allocation, not hiring); `a_h ≥ 0`; per-hour response improvement bounded by the same observed floor as Strategy B |
| **Data** | as Strategy B, plus the hourly volume profile from `nlex_theoretical_emissions` |

---

## 6. Output contract

The endpoint returns, per strategy:

```ts
{
  key: "fleet_mix" | "clearance" | "deployment",
  label: string,              // no more "Strategy X"
  reductionPct: number,       // vs the same period's actual CO₂
  reductionTonnes: number,
  lever: string,              // the decision variable's chosen value, in words
  basis: { from: string; to: string; rows: number },   // what it was computed over
  assumptions: string[],      // every bound, and where it came from
}
```

`reductionPct` must be **relative to the actual CO₂ of the same window**, so
the three bars are comparable to each other and to the Descriptive tab.

## 7. Done when

- The three bars change when the date Range changes.
- The **Illustrative** chip and its tooltip are gone from
  `sustainability/page.tsx:716-718`.
- Every number traces to a query, and each strategy states its own bound and
  where that bound came from.
- No strategy claims a saving from moving traffic between hours.
