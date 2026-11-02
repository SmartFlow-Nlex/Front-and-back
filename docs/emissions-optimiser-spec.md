# Prescriptive emissions optimiser — specification

Replaces the three hardcoded bars in `app/dashboard/sustainability/page.tsx`
(`prescriptiveEmissionReduction`, values `[8, 14, 22]`, labelled **Illustrative**)
with strategies computed from warehouse data.

Written 2026-09-29. **Revised 2026-10-02:** one CO₂ source for the whole
Emissions tab, per-incident idling, bootstrap ranges, and a delay-induced
carbon KPI. Verified against the live database, not assumed.
**Revised 2026-11-01:** the emissions record was rebuilt on cited factors and real
trip distances. All 2025 figures below are from the rebuilt record.
**Revised 2026-11-02:** measured recommendations only. Strategy A (the Class 3 share
shift), Strategy C (busiest-hours responder deployment) and the TOPSIS ranking were
removed as not data-backed; see sections 3, 5 and the diagram additions.

---

## 1. The emissions model you are optimising against

Every CO₂ figure on the Emissions tab — Descriptive, Predictive and
Prescriptive — comes from `gold.fact_emissions_hourly`:

```
CO₂(e,h,d)  =  Σ_c  vkm(e,h,d,c) × F(c)
```

for exit `e`, hour `h`, direction `d`, vehicle class `c`.

**Distance, `vkm`** (`gold.fact_vkm_hourly`, built by `Back-End/src/etl/trip-km.ts`
and `Back-End/scripts/build-vehicle-km.ts`). Each entry-to-exit pair in the hourly
toll files is charged the kilometres between its two plazas. Trips joining from a
connecting expressway are charged from the junction, and pairs with no known
position take the mean of their plaza and class. Open-section trips have no exit
record, so they use the rule in ADB (2011, Table A6.2 note a): entries leave
equally among the exits up to the closed system. `gold.open_plaza_km` holds the low,
central and high distance for each open plaza. Trips paid off NLEX count for the
part they drove on it. The 2026 file has no such rows, so they are estimated from
2025's ratio per class (`status = 'off_nlex_est'`).

Before 2026-11-01 this was vehicles × `segment_km`, half the gap to the neighbouring
exits: 3.79 km per trip, against 16.76 km per NLEX-paid trip now.

**Factors, `F(c)`** (`nlex_emission_factors`). Source: EMEP/EEA Guidebook 2023
(Update 2024), 1.A.3.b.i-iv. Fuel use per km (Table 3-15, Tier 1; Table 3-27, Tier 2) × kg CO₂ per kg fuel
(Table 3-12: petrol 3.168, diesel 3.180). NLEX's classes are defined in PhilRatings'
November 2024 monitoring report.

| class | label | central g/km | low | high | % of trips | % of vehicle-km | % of CO₂ |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | Light Vehicles | **196.1** petrol car | 180.6 diesel car | 251.2 diesel LCV | 78.07 | 77.15 | 47.45 |
| 2 | Buses and Small Trucks | **689.4** heavy-duty diesel, all sizes | 492.9 truck 7.5-16 t, Euro I+ | 836.3 coach, conventional | 13.51 | 13.62 | 29.44 |
| 3 | Large Trucks | **798.2** truck >32 t, Euro I+ | 667.8 truck 16-32 t, Euro I+ | 944.5 truck >32 t, conventional | 8.42 | 9.23 | 23.11 |

CO, NOx and PM2.5 come from the same Guidebook (Tables 3-5, 3-6) as g/kg × fuel.
The `no2_*` columns hold **NOx**; the column names were left to avoid breaking readers.
`co2_low_g_per_km` and `co2_high_g_per_km` carry the bounds. `so2_g_per_km` is NULL:
nothing reads it, and no cited Philippine fuel-sulphur figure was found.

**The Total CO₂ range** on the Emissions tab uses the low factors with the low
open-section distances, and the high with the high. 2025: 834,674 t, range
610,173 to 1,150,245 t.

**Validated against** (none of these prove the totals, because no measured NLEX CO₂
exists):

- Every toll file matched `gold.fact_traffic_hourly` at 0.000% by class, keys
  identical. `gold.fact_emissions_hourly` reconciled at 559,355,140 trips and
  11,003,942,053 vehicle-km.
- 2025 SCTEX-paid trips: 79.2k a day, against 79,202 published for 2024.
- 2025 NLEX-paid trips: about 365k a day, against 351-356k published (about 4% high).
- Open-section entries, with barrier-to-closed-exit rows counted: 89/97/90% of
  PhilRatings' first half of 2024 by class. These rows are separate trips, not a
  double count.
- **Closed-section vehicle-km: 4,845,889 a day in 2025, 78.6% of PhilRatings' first
  half of 2024.** This gap is unexplained and is reported, not calibrated away. Read
  the totals as more likely under than over.
- Class 1 against other published figures (cross-checks, not replacements):
  - Philippines, new light-duty vehicles in 2015: 7.7 LGe/100 km, from a lab test (NEDC). Source: ASEAN Fuel Economy
    Roadmap for the Transport Sector 2018-2025, p.26. At 8,887 g CO₂ per US gallon of petrol (US EPA), that is
    about 181 g/km. The same roadmap (p.51) puts real-world consumption about 30% above the lab test, so about 235 g/km.
  - United States, typical passenger vehicle on the road: about 400 g/mile, or 249 g/km (US EPA, "Greenhouse Gas
    Emissions from a Typical Passenger Vehicle", updated 3 June 2026).
  - Our 196.1 g/km central, with its 180.6-251.2 range, sits inside these. The central is nearer the lab figure,
    consistent with totals more likely under than over.
- **Philippine basis: DENR-EMB draft Memorandum Circular No. 2021-__, "Guidelines on the Calculation of Motor
  Vehicle Emissions for the Conduct of Emissions Inventory"** (air.emb.gov.ph, unsigned, watermarked DRAFT; no issued
  version found):
  - Its method is ours: Qv = Σ(N × D × E), vehicles × distance × emission per km (Annex A, Equation 2; running
    emission ER = N × D × EFR, Equation 9).
  - It has no local CO₂ factor. Section 4: "When there is no emission factor reflecting the actual local situation,
    default values in manuals can be used."
  - For what its local table does not cover, it adopts Table B, from the Guidelines for Developing Emission Inventory
    in East Asia (Ministry of the Environment, Japan, 2011). Every Table B page cites "EMEP/EEA Guidebook". It gives
    3.180 kg CO₂/kg petrol and 3.140 kg/kg diesel. We use the Guidebook's 2023 values, 3.168 and 3.180. Using the
    draft's values instead would change 2025 CO₂ by about -0.5% (Class 1 +0.4%, Classes 2-3 -1.3%).
  - Its local running factors (Table A, g/km) come from DENR type-approval (COC) tests of new Euro II and IV
    vehicles. They have no CO₂.
    - Heavy-duty diesel NOx: Euro II 5.73, Euro IV 2.63. Our Class 2 is 5.63 and Class 3 is 6.51.
    - Petrol car, Euro IV: NOx 0.022, CO 0.31. Our Class 1 is 0.246 and 2.99.
    The car gap is new-car lab tests against a whole-fleet average that includes older cars. We kept the Guidebook
    for NOx, CO and PM2.5: the record has no fleet age or Euro mix, so choosing between DENR's Euro II and IV rows
    would be a guess. Class 1 NOx, CO and PM2.5 may therefore read high if most NLEX cars are Euro 4. CO₂ is
    unaffected.
  - DENR AO 2010-24 sets CO, HC and NOx limits for motorcycles, not CO₂. No DOTr factor table was found.
- OpenWeatherMap's air quality (`nlex_emissions`, 20 exits, Nov 2020 to 2 Aug 2026) cannot validate the totals.
  It is a model of air levels (µg/m³) from every source, weather included, not emissions in tonnes, and it has
  no CO₂. Tested on 2025:
  - Daily NO₂ against our daily NOx: r = 0.11.
  - Hour of day: r = -0.87. NO₂ peaks at night, when still air traps it, while traffic is lowest.
  - By exit: r = 0.29.
  - Day of week: r = 0.83. Sunday is lowest in both (NO₂ 20% below the weekday mean, our NOx 39%).
  The weekly pattern is consistent, and that is all it supports. A real check would need measured roadside
  levels, such as a DENR-EMB station near NLEX, and even that measures air levels, not tonnes.

**Not established:** the Philippine fleet (the factors describe a typical EU fleet,
and Class 1's petrol-car central is a stated choice with no fleet-mix data), and
speed effects (the model has no speed term). CO₂ here is CO₂ only, not CO₂e.

Record: 2022-01-01 → 2026-06-30, 19 exits. Yearly CO₂: 2022 687,084 t; 2023 767,608 t;
2024 803,423 t; 2025 834,674 t; first half of 2026 414,128 t. The figures for 2022-24
rest on scaled counts and 2026 on the team's synthetic data. Every hourly toll upload
rebuilds the days it covers. The CO₂ forecast is trained on this same table, so the
three views agree and move together.

**Not `nlex_theoretical_emissions`.** It covers 10 of the 20 exits and holds two
rows for almost every (exit, hour, direction, class) key (1,420 of 1,430 on a
sampled day), so summing it counted the corridor about twice.

**Directions.** 21.6% of 2025's CO₂ is at plazas the record does not split by
direction (Angeles and Mexico as `NB/SB`; Balagtas, Harbor Link and Sta. Ines
with none). It is shown as its own share, never guessed into a carriageway.

### ⚠ The consequence, before you design anything

**This model is linear and has no speed term**, so **peak-spreading is a
no-op**: moving a trip from 17:00 to 10:00 changes its emissions by exactly
zero. CO₂ per vehicle-km does vary by hour (277–461 g), but that is the fleet
mix — heavy vehicles are a far larger share at night — not congestion.

Do not build a "shift demand off-peak" strategy (dynamic tolling, truck time
windows). It would report a saving the model cannot produce. The peak *does*
matter, but only through idling: a minute of blockage at a busy hour traps more
vehicles (Strategy B's λ).

---

## 2. The idling sub-model (delay-induced carbon; Strategy B)

Idling sits *outside* the linear model. A queue builds behind an incident while
it is live and drains as it clears, so the vehicle-minutes lost are the area of
that triangle:

```
idle_CO₂_kg(incident) = (λ / 60) × T² / 2 × φ
```

`λ` = vehicles per hour on **one exit-segment in one direction** at the hour the
incident started (the record's hourly volume ÷ days ÷ exits ÷ 2 carriageways);
`T` = the minutes that incident **blocked a lane** (`blockage_cleared − event_start_date`); `φ` = kg CO₂ per
vehicle-minute at a standstill, weighted by that hour's class mix:

| class | gal/h | fuel | kg CO₂/gal | φ kg/min | source of gal/h |
|---|---:|---|---:|---:|---|
| 1 | 0.3 | gasoline | 8.887 | 0.0444 | Gaines, Levinson & McConnell, Argonne, 2010; fueleconomy.gov gives 0.25-0.5 gal/h |
| 2 | 0.8 | diesel | 10.180 | 0.1357 | Argonne, 2015 (long-haul heavy-duty, so an upper reading for Class 2) |
| 3 | 1.0 | diesel | 10.180 | 0.1697 | Gaines et al., 2010 |

CO₂ per gallon: US EPA, Greenhouse Gas Emissions from a Typical Passenger Vehicle (updated 3 June 2026). Until
2 Nov 2026 every class used Argonne's round "about 20 lb" (9.07 kg), which fits gasoline and understated the
diesel classes by about 11%. These are US figures: none
were found for the Philippine fleet. This replaced 0.0192 kg/min, Climatiq's
petrol-car factor × 0.10; the 0.10 had no source.

**T is blockage time, not site-clearance time** (corrected 2026-10-12). Until then
`T` was `clearance_min`, the time to *site* cleared: a vehicle off the road that
never blocked a lane and was recovered hours later counted as hours of queueing.
On 2025, 18 of the 61 "over three hours" incidents had no blockage at all, and
ΣT² on blockage time is 29.6% of what it was. Incidents with no blockage, or
with a blockage longer than 24 hours (one record of 10,085 minutes, a date
typing error), are left out.

**Quadratic in T**, so the long tail carries it: in 2025, 26 blockages of three
hours or more were 65% of the delay-induced carbon. Each incident is charged at
**its own** T — squaring a band's mean would understate the tail.

The old per-incident calculator (`calculateRow`) charged every vehicle the full
delay (λ × T², no /2) over the corridor-wide volume — 40× high — and called
Climatiq live. Nothing called it; it is removed.

**Shown on the Descriptive view** as the *Delay-Induced CO₂* KPI: 1,394 t in
2025, 0.17% of the corridor's CO₂ (1,338 t before Classes 2-3 used the diesel CO₂ per gallon).

---

## 3. Strategy A — Heavy-vehicle share (removed 2026-11-02)

Removed as not data-backed. Its size was a chosen policy target (`δ`, default 1 pp of
Class-3 vehicle-km moved to Class 2), not an observed change: the record's lowest
Class 3 months are holiday Decembers, when car traffic dilutes the trucks, so nothing
shows the share can be pushed down. Class 3 now appears only through measured
outputs: the CO2 per class-km table (Class 3 is 9.2% of the distance and 23.1% of the
CO2 in 2025), the Class 3 window advisory and the tolling recommendation. The API
still accepts `heavyShiftPp` for old links and ignores it.

---

## 4. Strategy B — Lane-blockage time

| | |
|---|---|
| **Decision variable** | `τ_b,h` — target blockage minutes for each band `b` and start hour `h` |
| **Objective** | minimise `Σ_i idle_CO₂(λ_h(i), min(T_i, τ_b(i),h(i)))` over the Range's lane-blocking accidents |
| **Constraints** | `τ_b,h = floor_b,h`, the **10th percentile actually achieved** in that band and hour — you cannot beat your own best observed response. An incident already faster than its floor keeps its own time. Since 2 Nov 2026 a band-hour group with fewer than 10 blockages, and the 60–180 and over-180 bands always, use the band's 10th percentile over all hours: a lone long blockage was its own "fastest 10%" and saved nothing (2025: 168 blockages of 1–3 h, 26 over 3 h). A band with fewer than 10 gets no floor. |
| **Data** | `silver.nlex_accident_events_clean` (`blockage_cleared`, `event_start_date`, `direction`, `km_value`), λ from `gold.fact_emissions_hourly` |

Bands: under 15 min, 15–60, 60–180, over 180. Blockage is heavily
right-skewed (median 4 min, p90 about 33), so one floor for all would be meaningless.

The strategy also reports **where and when** its saving is: the three
10-km stretches (per carriageway) and the hours that hold most of it, the share
from blockages of an hour or more, and a warning when a single incident is 20%
or more of the figure (2025: Southbound Km 50–60 near San Simon holds 49%).

---

## 5. Strategy C — When to put the responders (removed 2026-11-02)

Removed as not data-backed. It assumed that moving existing response capacity into the
12 busiest hours would reach the blockage floors there, and the record holds no
responder capacity, shift or roster data to support that. Its "when" is already on
Strategy B, which reports the hours holding most of its saving.

---

## 6. Bootstrap range (B)

B depends on *which* incidents happen in a Range — and, being quadratic, on how
many long ones. One figure overstates how well that is known. The Range's
incidents are resampled with replacement 400 times (seeded, so the same Range
gives the same range), the saving recomputed against the same observed floors,
and the **5th–95th percentile** reported. 2025: shorter blockages 993.5 t,
likely 491.9–1,776.3 t (758 t before the floors were pooled, 2 Nov 2026).

This figure looks BACK over the Range. Since 2 Nov 2026 it also gives a projection ("Ahead"): the saving per
Range incident times the incident forecast over the days its accuracy test passes (today days 8–14 ahead,
8–14 Jul 2026, 795 incidents): 18.6 t. The per-incident saving is the Range's own, so it carries the Range's
mix of incidents, blockage lengths and hours.

---

## 7. Output contract

`GET /api/emissions/prescriptive` returns one strategy (since 2 Nov 2026):

```ts
{
  key: "clearance",
  label: string,              // "Shorter lane blockages"
  reductionPct: number,       // vs the same period's actual CO₂
  reductionTonnes: number,
  range: { lowTonnes, highTonnes, lowPct, highPct, runs } | null,   // bootstrap
  lever: string,              // the decision variable's chosen value, in words
  where: string, when: string, focus?: string,
  evidenceBounded: true,
  floorNote: string,
  projection: { tonnes, from, to, days, forecastIncidents, basis } | null,
  projectionNote?: string,
  assumptions: string[],      // how it is computed, each step from the record or a cited source
}
```

plus `classKm`, `corridorGPerVkm`, `heavyWindow`, `tolling`, `basis` (the Range,
the actual CO₂, the incident window and count) and `unavailable` (left out rather
than drawn at 0%). There is no `ranking`. `reductionPct` is **relative to the
actual CO₂ of the same window**, so it is comparable to the Descriptive tab.

## 8. Done when

- The figures change when the date Range changes. ✓
- The **Illustrative** chip is gone. ✓
- Every number traces to a query, and each strategy states its own bound and
  where that bound came from. ✓
- No strategy claims a saving from moving traffic between hours. ✓
- Descriptive, Predictive and Prescriptive read the same CO₂ record. ✓

---

## Additions from the modelling diagram (2026-10-14)

The diagram's Recommendations/Strategies boxes for emissions name TOPSIS, CO2 per class-km, a dynamic tolling
recommendation, and a heavy-vehicle window restriction advisory (KPI: Class 3 peak share reduction). The last three
are returned by `GET /api/emissions/prescriptive` and shown on the Prescriptive tab; TOPSIS was removed on
2 Nov 2026 (below).

- **CO2 per class-km** (`classKm`, `corridorGPerVkm`): 196 / 689 / 798 g per km for classes 1 / 2 / 3, against
  each class's share of vehicle-km and of CO2. 2025: Class 3 is 9.2% of the distance and 23.1% of the CO2.
- **TOPSIS** (removed 2026-11-02): it ranked the strategies on weights that were the team's choice (no source),
  and with one measured strategy left there is nothing to rank.
- **Class 3 window advisory** (`heavyWindow`): a recommendation, from the congestion forecast since 2 Nov 2026.
  The window is the hours the forecast expects High congestion most over the next 7 days (within 10% of its
  highest hour's average chance of High; the Range's busiest hours only when no forecast exists). KPI: Class 3's
  share of vehicle-km there, to 0% if followed; the quietest hours are checked for room. 2 Nov 2026: 23:00-01:00,
  where Class 3 is 20.3% of vehicle-km against 9.3% over the day (possibly daytime truck restrictions, which are
  not in the record). No CO2 saving is claimed: the model has no congestion term.
- **Tolling recommendation** (`tolling`): where a Class-3 surcharge for that window would apply, the fewest exits
  (at most five) carrying 80% of Class 3's CO2 in those hours (2 Nov 2026: Bocaue Barrier, San Fernando, NLEX
  Harbor Link, Sta. Ines, Balagtas, 70%). Where, not how much: no toll price, elasticity or diversion data.
