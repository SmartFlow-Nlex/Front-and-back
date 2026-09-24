import { CLASS_META } from "../simulation";

/* ══════════════════════════════════════════════════════════════════════════════
   SCENARIO ASSUMPTIONS

   Everything in this file is a value that does NOT come from NLEX data. Each one
   is an `Assumption`: it carries its value, why it was chosen, what data (if
   any) informed it without determining it, and what would settle it.

   What DOES come from data lives in calibration.json (duration quantiles, the
   breakdown response share) and is documented there. The line between the two
   is deliberate: a number in this file is a modelling choice a reviewer is
   entitled to argue with.

   Nothing here changes the engine. The engine's own Interventions
   (closedLanes / closurePoint / closureEnd / incidents / speedLimitKmh /
   speedZone) are the only levers a scenario can pull.
══════════════════════════════════════════════════════════════════════════════ */

/** The scenario families the engine can represent today. */
export type FamilyKey =
  | "breakdown_in_lane"
  | "breakdown_shoulder"
  | "minor_collision"
  | "multi_vehicle_collision"
  | "self_accident"
  | "overturned_vehicle"
  | "flood"
  | "scheduled_roadworks"
  | "rain";

/**
 * Families that act on the engine through its single closure stretch. Flood and
 * scheduled_roadworks are single-phase (ASSUMPTIONS.PHASE_SPLIT gives them one
 * phase at share 1): unlike a collision, there is no separate "response then
 * clearing" story for either, just closed-then-open.
 */
export type ClosureFamilyKey = "minor_collision" | "multi_vehicle_collision" | "self_accident" | "overturned_vehicle" | "flood" | "scheduled_roadworks";

/** Breakdown families: their durations and phase split both come from data. */
export type BreakdownFamilyKey = "breakdown_in_lane" | "breakdown_shoulder";

/** Families that act on the engine through its single speed zone. */
export type SpeedZoneFamilyKey = "breakdown_shoulder" | "rain";

/**
 * Families with NO calibration.json entry, because NLEX's own logs have no
 * category for them, or (rain) the category exists but the checked split shows
 * no real effect (see NO_CALIBRATION_FAMILIES). Duration is Manual only: the
 * sampler refuses any other mode for these, and the Add panel never offers
 * Sampled / Median / 90th for them.
 */
export type NoCalibrationFamilyKey = "overturned_vehicle" | "flood" | "scheduled_roadworks" | "rain";

/** Phase ids per family. The catalogue attaches the display labels. */
export type PhaseIdOf = {
  readonly breakdown_in_lane: "waiting" | "service";
  readonly breakdown_shoulder: "waiting" | "service";
  readonly minor_collision: "blocked" | "clearing";
  readonly multi_vehicle_collision: "blocked" | "tow" | "clearing";
  readonly self_accident: "blocked" | "tow" | "clearing";
  readonly overturned_vehicle: "blocked" | "tow" | "clearing";
  readonly flood: "active";
  readonly scheduled_roadworks: "active";
  readonly rain: "active";
};

/** How hard it is raining. Each intensity caps traffic to its own speed (ASSUMPTIONS.RAIN_SPEED_KMH). */
export type RainIntensity = "light" | "moderate" | "heavy";
export const RAIN_INTENSITIES: readonly RainIntensity[] = ["light", "moderate", "heavy"];

/**
 * Free-flow speed on the NLEx (km/h) by rainfall class, as fitted from loop-detector data: Table 2 of
 * Mejia & Sigua (2018) — see ASSUMPTIONS.RAIN_SPEED_KMH for the full citation, the site and what it can
 * and cannot support. Recorded here so the caps below are derived from them, in one place, rather than typed.
 */
export const NLEX_RAIN_FREE_FLOW_KMH = { clear: 109.79, light: 102.12, moderate: 101.46, heavy: 97.658 } as const;

/** The engine's own class-1 free-flow speed (30 m/s) scaled by the NLEx study's ratio of rain to clear free-flow speed, to whole km/h. */
const rainCapKmh = (rainFreeFlowKmh: number): number => Math.round((CLASS_META[1].v0 * 3.6 * rainFreeFlowKmh) / NLEX_RAIN_FREE_FLOW_KMH.clear);

/** Engine vehicle classes 1 / 2 / 3. */
export type VehicleKind = "car" | "bus" | "truck";
export type BreakdownCause = "tire" | "engine" | "mechanical" | "fuel" | "electrical";

export type Assumption<T> = {
  readonly status: "ASSUMPTION";
  readonly value: T;
  /** Why this value, and why it is not taken from data. */
  readonly reason: string;
  /** Data that informs the choice without determining it. */
  readonly evidence?: string;
  /** What would settle it. */
  readonly settledBy?: string;
};

function assume<T>(value: T, reason: string, extra?: { readonly evidence?: string; readonly settledBy?: string }): Assumption<T> {
  return { status: "ASSUMPTION", value, reason, ...extra };
}

type PerPhase<F extends FamilyKey, V> = Readonly<Record<PhaseIdOf[F], V>>;
type ByFamily<V> = { readonly [F in FamilyKey]: PerPhase<F, V> };
type ByClosureFamily<V> = { readonly [F in ClosureFamilyKey]: PerPhase<F, V> };
type PhaseShare<Id extends string> = { readonly id: Id; readonly share: number };
/**
 * Ordered, so the catalogue can lay phases out in sequence. Shares sum to 1.
 * ACCIDENT families only: a breakdown's phases are split by the response share
 * measured in the data, so a breakdown has no entry here.
 */
type PhaseSplitTable = { readonly [F in ClosureFamilyKey]: readonly PhaseShare<PhaseIdOf[F]>[] };

/* ─────────────────────────────────────────────────────────────────────────────
   Chainage: how event locations in the data relate to the app's km scale.
   The derivation is data, shown in full so the 12.04 can be checked; the
   decision to APPLY one constant offset everywhere is the assumption.
   generate/verify: tools/build_calibration.py writes the same table into
   calibration.json (`chainage_offset`) and verify.ts asserts they agree.
───────────────────────────────────────────────────────────────────────────── */
export type ChainageMatch = {
  readonly appExit: string;
  /** Km on the app's scale (lib/nlex-exits.ts, Balintawak = 0). */
  readonly appKm: number;
  /** SubLocation label the accident/breakdown export uses for the same place. */
  readonly eventLabel: string;
  /** Silver accident + breakdown events logged at that label. */
  readonly events: number;
  /** Median StartKM/1000 of those events: absolute NLEX chainage. */
  readonly chainageKm: number;
  readonly offsetKm: number;
};

export const CHAINAGE_DERIVATION: readonly ChainageMatch[] = [
  { appExit: "Balintawak", appKm: 0, eventLabel: "Balintawak", events: 1248, chainageKm: 11.89, offsetKm: 11.89 },
  { appExit: "Paso De Blas Valenzuela", appKm: 3.44, eventLabel: "Valenzuela", events: 503, chainageKm: 15.3, offsetKm: 11.86 },
  { appExit: "Meycauayan", appKm: 8.21, eventLabel: "Meycauayan", events: 682, chainageKm: 20.13, offsetKm: 11.92 },
  { appExit: "Marilao", appKm: 11.73, eventLabel: "Marilao", events: 194, chainageKm: 23.85, offsetKm: 12.12 },
  { appExit: "Cdv/Ph Arena", appKm: 14.05, eventLabel: "CDV", events: 262, chainageKm: 25.9, offsetKm: 11.85 },
  { appExit: "Bocaue Barrier", appKm: 15.2, eventLabel: "Bocaue Barrier", events: 2333, chainageKm: 27.2, offsetKm: 12 },
  { appExit: "Bocaue Interchange", appKm: 15.82, eventLabel: "Bocaue", events: 650, chainageKm: 27.75, offsetKm: 11.93 },
  { appExit: "Balagtas", appKm: 21.09, eventLabel: "Balagtas", events: 551, chainageKm: 33.84, offsetKm: 12.75 },
  { appExit: "Sta. Rita Guiguinto", appKm: 26.55, eventLabel: "Sta. Rita", events: 224, chainageKm: 38.5, offsetKm: 11.95 },
  { appExit: "Pulilan", appKm: 33.33, eventLabel: "Pulilan", events: 280, chainageKm: 45.37, offsetKm: 12.04 },
  { appExit: "San Simon", appKm: 44.91, eventLabel: "San Simon", events: 344, chainageKm: 56.96, offsetKm: 12.05 },
  { appExit: "San Fernando", appKm: 53.78, eventLabel: "San Fernando", events: 1182, chainageKm: 65.84, offsetKm: 12.06 },
  { appExit: "Mexico", appKm: 60.78, eventLabel: "Mexico", events: 305, chainageKm: 72.87, offsetKm: 12.09 },
  { appExit: "Angeles", appKm: 69.15, eventLabel: "Angeles", events: 220, chainageKm: 81.3, offsetKm: 12.15 },
  { appExit: "Dau", appKm: 71.05, eventLabel: "Dau", events: 166, chainageKm: 83.3, offsetKm: 12.25 },
  { appExit: "Sta. Ines", appKm: 76.25, eventLabel: "Sta. Ines", events: 147, chainageKm: 88.2, offsetKm: 11.95 },
  { appExit: "Tabang Guiguinto", appKm: 20.69, eventLabel: "Tabang", events: 114, chainageKm: 36.6, offsetKm: 15.91 },
];

/* ─────────────────────────────────────────────────────────────────────────────
   The assumptions
───────────────────────────────────────────────────────────────────────────── */
export const ASSUMPTIONS = {
  LANE1_IS_INNERMOST: assume(
    true,
    "The exports label lanes Lane1..Lane4 and no file says which end is which. The sandbox already draws lane index 0 as L1, the innermost lane, and the engine keeps heavy vehicles out of it (HEAVY_MIN_LANE), so operator lane 1 is mapped to engine lane index 0.",
    {
      evidence:
        "Lane1 is the modal numbered lane in BOTH directions for rear-end (NB 53%, SB 66%), multi-vehicle (NB 63%, SB 84%) and hit-and-run collisions; for side-swipe it is modal in SB only and for self accidents in NB only, and those two are nearly flat across lanes. Lane3 + Lane4 hold 74% of in-lane breakdowns (NB 75%, SB 74%) against 16% in Lane1. That is the pattern you would expect if Lane1 is the fast lane by the median and the outer lanes are the ones next to the shoulder, but it does not prove it, and the number of lanes varies along the corridor.",
      settledBy: "NLEX confirmation of the lane-numbering convention (PENDING). If false, operator lane n maps to engine index laneCount - n and every lane default below inverts.",
    },
  ),

  LANES_BLOCKED: assume<ByFamily<number>>(
    {
      breakdown_in_lane: { waiting: 1, service: 1 },
      breakdown_shoulder: { waiting: 0, service: 0 },
      minor_collision: { blocked: 1, clearing: 0 },
      multi_vehicle_collision: { blocked: 2, tow: 1, clearing: 0 },
      self_accident: { blocked: 1, tow: 1, clearing: 0 },
      overturned_vehicle: { blocked: 1, tow: 1, clearing: 0 },
      flood: { active: 1 },
      scheduled_roadworks: { active: 1 },
      rain: { active: 0 },
    },
    "NOT AVAILABLE in the data: neither export has a lanes-blocked count, only the single lane an event was logged in. The values are the smallest physically plausible ones. An in-lane breakdown blocks the lane it is in for its whole duration (waiting and service alike); a shoulder breakdown blocks none; a collision blocks its own lane; a multi-vehicle collision starts by blocking two lanes and is reduced to the working lane once vehicles are moved. Once the recorded lane-reopen time has passed (see PHASE_SPLIT) no lane is blocked. An overturned vehicle is given the self-accident shape (one lane): it is structurally a single-vehicle event like self_accident, not a multi-vehicle one, and there is no NLEX record of it spilling into a second lane more often than a self accident does. Flood and scheduled_roadworks block one lane, like the other single-vehicle closure families, and the operator can close more on the same stretch as with any of them; a lane count specific to either is NOT AVAILABLE (no roadworks or flood record exists at all). Rain blocks nothing — it is a speed zone, not a closure.",
    {
      evidence:
        "BlockageCleared (lane reopened) precedes SiteCleared for all but 358 of 21,804 accidents, so a final phase with no lane blocked is supported by the data. In-lane multi-vehicle collisions are logged with a median of 3 vehicles (96% have 3 or more, 25% have 4 or more: 556 of 2,257), which is why two lanes is assumed rather than one. Overturned vehicle, flood and scheduled_roadworks have no evidence of their own: see NO_CALIBRATION_FAMILIES.",
      settledBy: "A lanes-blocked field in the incident export, or operator input.",
    },
  ),

  CLOSURE_LENGTH_M: assume<ByClosureFamily<number>>(
    {
      minor_collision: { blocked: 40, clearing: 0 },
      multi_vehicle_collision: { blocked: 100, tow: 60, clearing: 0 },
      self_accident: { blocked: 60, tow: 60, clearing: 0 },
      overturned_vehicle: { blocked: 80, tow: 80, clearing: 0 },
      flood: { active: 150 },
      scheduled_roadworks: { active: 120 },
    },
    "The WRECK LENGTH: how far downstream of the event position the scene extends. NOT AVAILABLE in the data (no export records how much road a scene occupies). Sized to the vehicles involved (4.6 m car, 9 m bus, 14 m truck in the engine) plus a working buffer: two vehicles about 40 m, a multi-vehicle scene about 100 m while lanes are blocked, then a shorter working area while a tow is in progress. Zero where no lane is blocked. The closed stretch is longer than this: it also includes UPSTREAM_BUFFER_M. An overturned vehicle is given a longer footprint than a self accident (80 m against 60 m): a vehicle on its side or roof occupies more than its own length, and righting it needs a crane or heavy wrecker working beside it, not just behind it. Flood is longer again (150 m): standing water pools over a stretch of low ground, not a point, and this sandbox has no flood record to size it against — 150 m is simply larger than any single-vehicle wreck length here, not a measurement. Scheduled roadworks (120 m) is a work zone plus an advance-warning taper, the same reasoning as UPSTREAM_BUFFER_M applied to the work area itself rather than the approach to it.",
    { settledBy: "Field measurement or NLEX incident-management guidance." },
  ),

  CLASS_FILTERED_BLOCKAGE: assume<readonly FamilyKey[]>(
    ["flood"],
    "The engine's closure model is binary: Interventions.closedLanes marks a lane closed to every vehicle class or open to all of them, with no per-class or per-height dimension. Flooding is modelled as a single closed lane over CLOSURE_LENGTH_M.flood (150 m) for exactly that reason — it is the closest thing the engine's existing levers can express — but this is a PLACEHOLDER, not a modelled result. Real flooding affects outer lanes first (they sit lower, nearer the shoulder drain) and is class-dependent: standing water shallow enough for a truck's higher ground clearance to pass can still stop a car. A single lane, closed uniformly to every class, does not represent either of those things; it is only the nearest available approximation. Overturned vehicle and scheduled roadworks do NOT share this limitation, despite also being single-lane closures with an assumed length: both are genuine physical obstructions that block every vehicle class equally (a car cannot pass an overturned truck's wreckage, or a roadworks barrier, any more than another truck could), so a binary closure is not a simplification for them the way it is for flood — there is no real per-class or outer-lanes-first behaviour being flattened away.",
    {
      settledBy:
        "A per-class or per-height blockage lever in the engine (simulation.ts) — none exists today, and adding one is out of this feature's scope (Front-End-Dashboard only, simulation.ts untouched) — or NLEX/DPWH guidance on typical flood depth by vehicle class, if the sandbox ever tries to model this more finely than a placeholder.",
    },
  ),

  UPSTREAM_BUFFER_M: assume(
    100,
    "How far UPSTREAM of a collision the closure begins. In the engine a closure is a wall at closurePoint that traffic in the closed lane must merge out of before reaching it, so a closure that begins exactly at the wreck makes vehicles queue right up against it. A real scene is protected by advance warning and cones well before the wreck. 100 m is a round figure of that order; it is not from an NLEX document. Applies to the closure families only.",
    {
      evidence: "The engine's own merge-urgency zone is 150 m (MERGE_ZONE_M), so at 100 m the wall sits inside the distance over which drivers are already merging. With the sandbox's 600 m default segment and the default 55% placement, the closure starts at about 230 m for a 330 m event.",
      settledBy: "NLEX incident-management practice for advance warning distance.",
    },
  ),

  CLOSURE_ANCHOR: assume<"closure_starts_upstream_of_event">(
    "closure_starts_upstream_of_event",
    "A collision's closure is placed as closurePoint = position - UPSTREAM_BUFFER_M and closureEnd = position + wreck length (CLOSURE_LENGTH_M for the current phase). CLAMPING: each end is clamped to the segment independently, closurePoint = max(0, position - buffer) and closureEnd = min(segment length, position + wreck length), so the closure can only be shortened, never moved, and the event position itself is never altered. The event position must lie within [0, segment length], otherwise there is no stretch (see closureStretch). The engine models no separate advance-warning taper.",
    { settledBy: "Nothing external: this follows from how simulation.ts treats a closure." },
  ),

  PHASE_SPLIT: assume<PhaseSplitTable>(
    {
      minor_collision: [
        { id: "blocked", share: 0.8 },
        { id: "clearing", share: 0.2 },
      ],
      multi_vehicle_collision: [
        { id: "blocked", share: 0.25 },
        { id: "tow", share: 0.3 },
        { id: "clearing", share: 0.45 },
      ],
      self_accident: [
        { id: "blocked", share: 0.3 },
        { id: "tow", share: 0.41 },
        { id: "clearing", share: 0.29 },
      ],
      overturned_vehicle: [
        { id: "blocked", share: 0.3 },
        { id: "tow", share: 0.41 },
        { id: "clearing", share: 0.29 },
      ],
      flood: [{ id: "active", share: 1 }],
      scheduled_roadworks: [{ id: "active", share: 1 }],
    },
    "CLOSURE families only. The data gives one total duration per event, not a timeline, so how that total divides into phases is a modelling choice. The lane-blocked share is anchored to the data (below) and only the split of that share into 'awaiting response' and 'tow' is assumed. Breakdown phases are NOT here: they are split by the response share measured in the data (RESPONSE_SHARE_MODEL). Overturned vehicle has no clearance-ratio evidence of its own (see NO_CALIBRATION_FAMILIES) and is given self_accident's split verbatim, as the closest analog (a single vehicle needing recovery, not a multi-vehicle scene) — doubly an assumption, since self_accident's own split is itself unvalidated at the phase level. Flood and scheduled_roadworks are single-phase (share 1): neither has a real 'response then clearing' story the way a collision does — a flood is closed for as long as the water stands and then open, and roadworks are closed for the planned window and then open. Splitting either into invented sub-phases would be a phase-level fake-metric with nothing behind it at all, worse than the collision families' at least ratio-anchored split.",
    {
      evidence:
        "Ratio of median lane-blockage time (BlockageCleared - start) to median clearance time (SiteCleared - start), in-lane events, positive values only: minor collision 0.80 (rear-end 0.80, side-swipe 0.80, hit-and-run 0.38 on n=76), multi-vehicle 0.54, self accident 0.71. A ratio of medians is a rough guide, not a median of ratios. No equivalent ratio exists for overturned vehicle, flood or scheduled_roadworks: none has any record in NLEX's exports at all (see NO_CALIBRATION_FAMILIES).",
      settledBy: "An event timeline (reported / lanes reopened / cleared) in the incident export.",
    },
  ),

  NO_CALIBRATION_FAMILIES: assume<readonly NoCalibrationFamilyKey[]>(
    ["overturned_vehicle", "flood", "scheduled_roadworks", "rain"],
    "These families have NO calibration.json entry. Overturned vehicle, flood and scheduled_roadworks: NLEX's own exports have no category for them at all, so there is nothing to sample a duration from. Rain: NLEX's accident export DOES record weather (WeatherCondition), but checked against the same population and exclusion rules calibration.json itself uses, the only two levels with enough Rainy events to trust (minor_collision, n=507; minor_collision_rear_end, n=389; both >= LOW_SAMPLE_N) show an IDENTICAL median clearance to Fair weather (5.0 min either way) — every other split has under 200 Rainy events, too thin to read at all. So there is no real effect to calibrate against, not just no data: presenting a p90/p99 gap at that sample size as \"rain slows clearance\" would be exactly the kind of noise CAP_MIN_N exists to guard against. Inventing quantiles, or a modifier that leans on a difference this thin, would be the fake-metric this project has avoided everywhere else, so all four families are Manual duration ONLY — the sampler (resolveDuration) throws if asked for sampled/p50/p90, and the Add panel never offers those buttons for them (ScenarioTemplate.durationSource === \"manual_only\"). Their resolved-duration display therefore never shows a calibration line, a low-sample badge or a cap: resolutionView() already suppresses all three whenever mode is \"manual\", which every draw for these families is.",
    {
      evidence:
        "accident_data_*.csv TypeOfEvent value counts (2022-2026, read-only check): Rear End 8,292, Side Swipe 5,091, Self Accident 2,615, Multiple Collision 2,425, Hit Toll Plaza Equipment 1,215, Hit Objects On The Road 914, Hit and Run 469, Angle Collision 414, Others 216, Hit Pedestrian 64, Head-On Collision 46, Hit Animal 39, Pedestrian/Passenger Fell On Moving Vehicle 18. No \"Overturned\", \"Rollover\", \"Flood\" or \"Roadworks\" value exists at all, in any year. breakdown_data_*.csv has no WeatherCondition column at all, so breakdown_in_lane / breakdown_shoulder cannot carry a rain effect either, even in principle. WeatherCondition on the accident export: Fair 20,558, Rainy 1,249, Stormy 15 (too thin on its own everywhere). Per mainline-lane family, Fair n / Rainy n / Fair p50 / Rainy p50: minor_collision 7,321/507/5.0/5.0; minor_collision_rear_end 5,255/389/5.0/5.0; minor_collision_sideswipe 1,943/112 (Rainy n<200); minor_collision_hit_and_run 123/6; multi_vehicle_collision 1,929/176; self_accident 1,095/102.",
      settledBy: "An \"Overturned\"/\"Rollover\"/\"Flood\"/\"Roadworks\" category appearing in a future NLEX export, a documented source for how long each actually takes to clear or stay closed on this corridor, or (rain) enough additional Rainy events for the thin levels to reach LOW_SAMPLE_N and show whether a real effect exists once they can be trusted.",
    },
  ),

  RAIN_SPEED_KMH: assume<Readonly<Record<RainIntensity, number>>>(
    { light: rainCapKmh(NLEX_RAIN_FREE_FLOW_KMH.light), moderate: rainCapKmh(NLEX_RAIN_FREE_FLOW_KMH.moderate), heavy: rainCapKmh(NLEX_RAIN_FREE_FLOW_KMH.heavy) },
    "The speed each rain intensity caps traffic to, for as long as the event runs, over the WHOLE simulated stretch (RAIN_ZONE) — a stand-in for the lower free-flow speed rain causes, not a local effect near one vehicle (unlike GAWK_SPEED_KMH). DERIVED from one NLEx study, not measured here: Mejia & Sigua (2018) fitted speed-density curves to NLEx loop-detector data by rainfall class (PAGASA classes: light 0.1-2.5 mm/h, moderate 2.6-7.5, heavy above 7.5) and report a free-flow speed of 109.79 km/h in clear weather, 102.12 light, 101.46 moderate and 97.66 heavy (their Table 2). Each cap is the engine's own class-1 free-flow speed (108 km/h) scaled by that study's ratio of rain to clear free-flow speed — 108 x 102.12/109.79, 108 x 101.46/109.79, 108 x 97.658/109.79 — rounded to whole km/h: 100, 100 and 96. Light and moderate come out the same because the study's own figures for them differ by under 1 km/h (its average speeds by 0.7 km/h): the data do not separate them, so the cap does not either. A SPEED CAP IS ONLY A PROXY. Rain's main real effect is on following headways — drivers keep larger gaps — and the engine cannot vary headway, so a cap reproduces the speed effect and likely UNDERSTATES the capacity loss. The same study finds capacity falling 3.7%, 7.6% and 17.4% (light, moderate, heavy); this engine loses about 2% under these caps (see evidence).",
    {
      evidence:
        "Mejia, H. N. & Sigua, R. G. (2018), 'Impacts of Different Rainfall Intensities on Key Traffic Flow Parameters at ...' (the rest of the title did not extract from the PDF; the site is the NLEx), Philippine Transportation Journal 1(2), August 2018, Table 2 and section 5.2: https://ncts.upd.edu.ph/tssp/wp-content/uploads/2018/08/Mejia18.pdf. Their data: loop detectors at Km 11+150 northbound near the Balintawak toll plaza (4 lanes), 6-minute intervals, June-December 2016, daytime only (06:00-17:00), rainfall from a PAGASA automatic weather station within 1 km (15-minute readings); the model was calibrated on lanes 3 and 4; free-flow speed is a parameter of the fitted Underwood speed-density model, not an observed maximum. One site, one season, one study. Also reported there: average speed 73.0 km/h clear against 69.1, 68.4 and 67.6; capacity 1,554 pcu/h clear against 1,497, 1,436 and 1,283 (the text gives them per lane). Corroboration only, NOT used to set the values: the HCM 2000 figures that paper quotes (free-flow speed down 1.9 km/h in light rain and 4.8-6.4 in heavy; capacity down 14-15% in heavy rain), and the FHWA Road Weather Management 'Rain & Flooding' page (freeway speeds down 2-13% in light rain, 3-17% in heavy; it cites no primary source). The HCM 6th-edition Chapter 11 weather adjustment factors were searched for and not found in any free source. Measured on this engine (scenarios/tools/measure_rain_cap.ts: 4 lanes, 1 km, 3 seeds, 1,500 simulated s): at saturating demand these caps cut capacity by 2.1% (100 km/h) and 2.3% (96 km/h) against the study's 3.7% / 7.6% / 17.4%; at 1,500 veh/h/lane they cut average speed by 2.9% and 5.1% against the study's 5.3% / 6.3% / 7.4%.",
      settledBy:
        "Loop-detector speeds and flows at more NLEx sites and seasons with rain of recorded intensity (this is one site and one season); a following-headway lever in the engine, so rain can act where it mostly acts (out of scope: simulation.ts).",
    },
  ),

  RAIN_ZONE: assume<"whole_segment">(
    "whole_segment",
    "A rain event's speed zone (at any intensity) is the WHOLE simulated stretch (0 to the segment length), not a position-relative zone like GAWK_ZONE_M: rain is corridor-wide by nature, and sizing a local zone around a chosen point would misrepresent that. The event still carries a positionKm, for the canvas label only — it has no effect on the zone's extent.",
    { settledBy: "Nothing external: a modelling choice about what \"corridor-wide\" should mean in a sandbox of a fixed simulated stretch." },
  ),

  ZIPPER_LANES: assume<{ readonly minLanes: number; readonly maxLanes: number; readonly maxTransfer: number }>(
    { minLanes: 2, maxLanes: 6, maxTransfer: 2 },
    "Limits on the lane reallocation control, which moves 1 or 2 lanes from one carriageway to the other by changing each carriageway's lane count. A carriageway never drops below 2 lanes (the same floor as the lane slider: a single lane is not a road this sandbox models), may not exceed 6 (one more than the lane slider's 5, which is what lets a 4-lane carriageway take 2 lanes from the other), and at most 2 lanes are moved (a movable barrier is assumed to move one lane, or up to two). These are modelling bounds, not operating rules: nothing in the data says whether NLEX runs a movable barrier or any reversible-lane operation on this corridor, and how many lanes a real scheme could move depends on the road and the barrier system.",
    {
      evidence: "The lane slider runs 2 to 5 (lib/nlex-lanes holds no lane data yet, so there is no corridor figure to check the 6 against). The engine itself takes any lane count: verify.ts runs it at 2 and at 6, and 6 was looked at in Both mode (8 lanes in total in either split) and draws legibly.",
      settledBy: "NLEX guidance on whether a movable barrier or contraflow operation exists on this corridor and how many lanes it can move.",
    },
  ),

  BREAKDOWN_DURATION_SCOPE: assume<"response_plus_service_per_event">(
    "response_plus_service_per_event",
    "AMENDED in Phase 1b. A breakdown's simulated duration is the event's TOTAL, first dispatch to last departure (response + service), replacing the Phase 1 choice of on-scene service time only. The obstacle exists while it waits for the responder as well as while it is served, so service-only understated it by roughly 2.7x at the median in-lane. Still understated: the clock starts at the first dispatch, not at the breakdown, and any delay before dispatch is not recorded.",
    {
      evidence:
        "In-lane median total 43 min (p90 105) against 16 (p90 56) for service only per deployment record; shoulder 37 (p90 86) against 14 (p90 40). The service-only quantiles are kept in calibration.json under reference.service_only_per_deployment_record. Only 53% of in-lane and 28% of shoulder breakdown events have any deployment record, and events without one cannot be calibrated. Dispatch precedes the event's encoded time in 29% of deployment records, so time since the breakdown cannot be reconstructed.",
      settledBy: "A reported-at (breakdown began) timestamp in the incident export.",
    },
  ),

  MULTI_DEPLOYMENT_RULE: assume<"first_dispatch_to_last_departure_ignoring_check_ins">(
    "first_dispatch_to_last_departure_ignoring_check_ins",
    "A breakdown event can carry several deployment records. Rule: ignore records that are zero-length check-ins (dispatch = arrival = departure); over the rest take t0 = earliest dispatch, a = earliest arrival, t1 = latest departure; response = a - t0, service = t1 - a, total = t1 - t0. Gaps between visits therefore count as service, on the assumption that the obstacle is present until the last departure. Zero-length records are ignored because they show no responder attending; keeping them would move the start earlier by an unknown amount.",
    {
      evidence:
        "13.3% of usable in-lane events (781 of 5,863) and 2.7% of shoulder events (156 of 5,690) have more than one substantive record, and run longer (in-lane median 67 min against 41 for single-record events; shoulder 74.5 against 36). Keeping check-ins in the span instead changes the aggregate very little: in-lane p50 43 / p90 106 against 43 / 105, shoulder 37 / 87 against 37 / 86.",
      settledBy: "NLEX confirmation of whether several records on one event are successive visits to one obstacle or separate jobs.",
    },
  ),

  RESPONSE_SHARE_MODEL: assume<"per_event_share_quantiles_drawn_independently_of_total">(
    "per_event_share_quantiles_drawn_independently_of_total",
    "The response share (response / total) is calibrated as its own per-event quantile set, not as a ratio of medians: the distribution is wide (in-lane p10 0.18, median 0.60, p90 0.89) and one fixed ratio would give every event the same phase split. A sampled event draws its share independently of its total, from a second seed derived from the first. p50, p90 and manual durations use the median share, because they fix the total deliberately.",
    {
      evidence:
        "Spearman correlation between total and share: in-lane -0.195, shoulder -0.007. The mild in-lane negative correlation (long events tend to be service-heavy) is ignored. 6.9% of in-lane events (3.7% of shoulder) have a share of exactly 1 (service recorded as 0 min); the p90-p99 knots smooth that mass, so the model draws fewer exact 1s than the data has. A share of exactly 1 gives the Service / tow phase zero length.",
      settledBy: "A joint (total, share) model, if the correlation is judged to matter.",
    },
  ),

  SAMPLED_CAP: assume<"chain_p99">(
    "chain_p99",
    "A sampled duration is capped at the p99 of the first calibration level that has at least CAP_MIN_N usable events, walked in this order: the level the quantiles came from, then the VEHICLE level, then the CAUSE level, then the whole family (a minor collision: its label, then minor collision). The result reports the level and n the cap came from, and whether it applied. The quantiles themselves still come from the chosen level, by the ordinary fallback (cause x vehicle, cause, vehicle, family). The cap skips the cause level in favour of the vehicle level because obstruction time is driven mainly by what has to be recovered: a car is cleared far faster than a truck whatever failed, whereas a cause level pools cars and trucks and is dominated by the trucks, so it is the wrong ceiling for a car. The last 1% of the distribution runs from p99 out to the observed maximum (up to 24 h), which a sandbox run cannot usefully show; the cap is a project decision, not a statistical one. Manual durations are never capped; p50 and p90 are below the cap by construction. Where the cap comes from a broader level than the quantiles, it can sit above or below the chosen level's own p99, so the share of draws it clips is then not 1%.",
    {
      evidence:
        "Family p99 caps: minor collision 127 min, multi-vehicle 157, self accident 535, in-lane breakdown 347, shoulder breakdown 251. Why vehicle before cause (in-lane cause x vehicle p99, minutes): within cars the cause hardly matters (tire 151, engine 153, mechanical 173) while within a cause the vehicle does (tire: car 151, truck 521; mechanical: car 173, truck 467; engine: car 153, truck 217). The cause level (tire 393, mechanical 438) sits between the two and would cap a car about two and a half times above its own tail (393 against 151, 438 against 173). Which level supplies the cap for every calibrated cell is checked in verify.ts against an independent walk of the raw cell counts.",
      settledBy: "Operator preference: the sampler accepts a different cap, or none.",
    },
  ),

  CAP_MIN_N: assume(
    1000,
    "The cap on a sampled duration is a p99, and a p99 is set by the top 1% of the events behind it, so it is only as stable as that tail is deep. Bootstrapping the real breakdown durations, a p99 estimated from 200 events has a relative standard deviation of about 35%, from 500 events 21-24%, from 1,000 events 13-16% and from 2,000 events 9-12%; at 1,000 events the tail holds about ten observations. So a cap is taken only from a level with at least this many usable events, and a thinner level inherits its cap from the next level in the cap chain (the vehicle level, then the cause level, then the family). This is a stability judgement, not a standard: 1,000 is where the estimate stops being dominated by a handful of tail events, not a threshold anything in the data marks. If no level in a chain reaches it the draw is uncapped; every shipped variant has one (checked in verify.ts).",
    {
      evidence:
        "Bootstrap of the in-lane (n = 5,863) and shoulder (n = 5,690) event totals, 3,000 resamples per size, seed 2026, by tools/p99_stability.py. Relative standard deviation of the p99 estimate by sample size, in-lane / shoulder: n=100 45.6% / 44.6%, n=200 35.2% / 35.6%, n=500 23.7% / 20.8%, n=1000 16.4% / 13.0%, n=2000 11.9% / 9.2%. 90% of estimates from 200 in-lane events fall between 187 and 507 min (population p99 347); from 1,000 events, between 245 and 432.",
      settledBy: "Operator preference: a different threshold; or NLEX-side guidance on how tight a duration cap needs to be.",
    },
  ),

  OBSTACLE_LENGTH_M: assume<Readonly<Record<VehicleKind, number>>>(
    { car: CLASS_META[1].len, bus: CLASS_META[2].len, truck: CLASS_META[3].len },
    "The data does not record the length of a stalled vehicle. The engine's own class lengths are used (car 4.6 m, bus 9 m, truck 14 m). These are engine constants, not NLEX measurements.",
    { settledBy: "Nothing needed unless the engine's class lengths are revised." },
  ),

  ENGINE_INCIDENT_SLOT_M: assume(
    5,
    "Mirrors INCIDENT_LENGTH in simulation.ts: every incident the engine holds is a stalled obstacle 5 m long, and the engine offers no way to change that. A longer stalled vehicle is approximated by chaining ceil(length / 5) slots end to end, so a car uses 1, a bus 2 and a truck 3. simulation.ts does not export the constant, so it is copied here and verify.ts checks the copy against the source text.",
    { settledBy: "verify.ts (fails if simulation.ts changes the constant)." },
  ),

  GAWK_SPEED_KMH: assume<{ readonly breakdown_shoulder: number }>(
    { breakdown_shoulder: 70 },
    "A stopped vehicle on the shoulder slows passing traffic. There is no measured NLEX speed to calibrate against: the warehouse holds no observed corridor operating speed (four candidate columns were checked and rejected in the sandbox validation, see smartflow_scripts/4_studies_audits/sandbox_validation/README.md). 70 km/h is a moderate cut below the engine's 108 km/h free-flow class-1 speed. Collisions are modelled by their closure alone, so no post-collision gawking is represented. A shoulder breakdown and rain are the only two families that use the engine's single speed zone (SpeedZoneFamilyKey) — a shoulder breakdown's is local to its position (GAWK_ZONE_M), rain's is corridor-wide at a different, lower speed (RAIN_SPEED_KMH) — and, being the same single engine lever, the two cannot run at once (see composeInterventions's speed_zone case).",
    {
      evidence: "The engine's speed zone caps desired speed for every vehicle in the zone, on all lanes. Real gawking mostly affects the lane beside the incident, so this overstates the slowdown in the other lanes.",
      settledBy: "Probe / loop-detector speeds near recorded shoulder events, which do not exist in the warehouse.",
    },
  ),

  GAWK_ZONE_M: assume<{ readonly upstream: number; readonly downstream: number }>(
    { upstream: 150, downstream: 100 },
    "Extent of the speed zone around a shoulder breakdown: drivers ease off before they reach it and speed up again shortly after. Not measurable from the data.",
    { settledBy: "Field observation." },
  ),

  SPILL_LANE_ORDER: assume<"outward_first">(
    "outward_first",
    "When a scene blocks more than one lane (multi-vehicle collision, first phase), the extra lane is taken on the outer side of the event lane first, then the inner side if there is none. The data logs one lane per event and says nothing about which neighbour a scene spills into. Outward first because 68% of multi-vehicle collisions are logged in Lane1, where the inner side is the median.",
    { settledBy: "Scene-extent data, which does not exist in the exports." },
  ),

  CHAINAGE_OFFSET_KM: assume(
    12.04,
    "Event StartKM in the exports is absolute NLEX chainage (Balintawak sits at about 11.9), whereas the app's exit list measures from Balintawak = 0. Sixteen of the 17 named places that appear in both differ by 11.85 to 12.75 km; the offset is the median of all 17. One constant offset is then applied along the whole corridor, which is the assumption. Tabang (15.91) is a clear outlier: the label 'Tabang' in the events does not sit where the app's 'Tabang Guiguinto' exit is.",
    {
      evidence: "See CHAINAGE_DERIVATION (17 named places, events counted per place; each place's events sit at a single point, IQR < 1 km).",
      settledBy: "gold.exit_km_post, the authoritative km table, which was unreachable when this was derived (database down); or NLEX chainage documents.",
    },
  ),

  DEFAULT_PLACEMENT_PCT: assume(
    55,
    "Where a new event lands along the visible segment when the operator has not chosen. 55% matches the engine's own default closure position (cfg.length * 0.55) so an event and a hand-set closure start from the same place. Not data.",
    { settledBy: "Operator choice." },
  ),

  LABEL_MAPPINGS: assume<{
    readonly cause: Readonly<Record<BreakdownCause, string>>;
    readonly vehicle: Readonly<Record<VehicleKind, string>>;
    readonly collision: Readonly<Record<"rear_end" | "sideswipe" | "hit_and_run", string>>;
  }>(
    {
      cause: {
        tire: "MainCause = Tire",
        engine: "MainCause = Engine",
        mechanical: "MainCause = Mechanical",
        fuel: "MainCause = Fuel",
        electrical: "SubCause in (Battery, Electrical, Alternator, Starter, Wiring, Spark Plug, Contact Point)",
      },
      vehicle: {
        car: "TypeOfVehicle in (Sedan/Car, AUV, SUV, Van, Pick-Up)",
        bus: "TypeOfVehicle = Bus",
        truck: "TypeOfVehicle = Truck",
      },
      collision: { rear_end: "TypeOfEvent = Rear End", sideswipe: "TypeOfEvent = Side Swipe", hit_and_run: "TypeOfEvent = Hit and Run" },
    },
    "How the template's variant labels correspond to the exports' raw categories. The exports have no 'electrical' cause (it is spread across MainCause 'Others') and no car/bus/truck field (Truck alone spans all three engine vehicle classes). Breakdown durations follow the variant wherever a cause x vehicle, cause or vehicle cell has at least LOW_SAMPLE_N usable events; a breakdown of an unmapped vehicle (PUV, jeepney, motorcycle, heavy equipment) or an unmapped cause simply does not contribute to those cells.",
    {
      evidence:
        "The variant matters: in-lane median totals are truck 50 min against car 35, and mechanical 52 against engine 40 (tire 43). Bus (175 in-lane, 99 shoulder usable events) is below the threshold in both families, so a bus falls back to its cause or the family.",
      settledBy: "NLEX definitions of the cause and vehicle categories.",
    },
  ),

  LOW_SAMPLE_N: assume(
    200,
    "A calibration entry with fewer usable values than this is flagged as a small sample when shown to the operator, and a breakdown hierarchy entry (cause x vehicle, cause, vehicle) is used only if it has at least this many usable events. calibration.json records the value it was generated with and verify.ts checks the two agree. The figure is a judgement, not a statistical threshold. Hit-and-run (129 usable events after excluding 105 zero-minute and 9 negative) is below it but has no lower level inside its family to fall back to, so it keeps its own entry and is flagged.",
    { settledBy: "Nothing external." },
  ),
} as const satisfies Record<string, Assumption<unknown>>;

export type AssumptionId = keyof typeof ASSUMPTIONS;

/** Every assumption, for showing to the operator or auditing. */
export function listAssumptions(): readonly { readonly id: string; readonly assumption: Assumption<unknown> }[] {
  return Object.entries(ASSUMPTIONS).map(([id, assumption]) => ({ id, assumption }));
}

/** LANE1_IS_INNERMOST as a plain constant, because it is used everywhere. */
export const LANE1_IS_INNERMOST: boolean = ASSUMPTIONS.LANE1_IS_INNERMOST.value;
export const CHAINAGE_OFFSET_KM: number = ASSUMPTIONS.CHAINAGE_OFFSET_KM.value;
export const UPSTREAM_BUFFER_M: number = ASSUMPTIONS.UPSTREAM_BUFFER_M.value;

/* ─────────────────────────────────────────────────────────────────────────────
   Small conversions that depend on the assumptions above
───────────────────────────────────────────────────────────────────────────── */

/**
 * Operator lane number (1-based, as printed on the controls) -> engine lane index (0-based).
 * Null when the lane does not exist on a road of `laneCount` lanes.
 */
export function operatorLaneToEngineIndex(lane: number, laneCount: number): number | null {
  if (!Number.isInteger(lane) || !Number.isInteger(laneCount) || laneCount < 1) return null;
  if (lane < 1 || lane > laneCount) return null;
  return LANE1_IS_INNERMOST ? lane - 1 : laneCount - lane;
}

/** Inverse of operatorLaneToEngineIndex. */
export function engineIndexToOperatorLane(index: number, laneCount: number): number | null {
  if (!Number.isInteger(index) || !Number.isInteger(laneCount) || laneCount < 1) return null;
  if (index < 0 || index >= laneCount) return null;
  return LANE1_IS_INNERMOST ? index + 1 : laneCount - index;
}

/** The app's km (Balintawak = 0) -> absolute NLEX chainage, the scale the event data uses. */
export function appKmToChainageKm(appKm: number): number {
  return appKm + CHAINAGE_OFFSET_KM;
}

/** Absolute NLEX chainage -> the app's km. */
export function chainageKmToAppKm(chainageKm: number): number {
  return chainageKm - CHAINAGE_OFFSET_KM;
}

/** How many 5 m engine incident slots a stalled vehicle of this kind occupies. */
export function incidentSlotsFor(vehicle: VehicleKind): number {
  return Math.max(1, Math.ceil(ASSUMPTIONS.OBSTACLE_LENGTH_M.value[vehicle] / ASSUMPTIONS.ENGINE_INCIDENT_SLOT_M.value));
}

/* ─────────────────────────────────────────────────────────────────────────────
   Closure geometry (CLOSURE_ANCHOR, UPSTREAM_BUFFER_M, CLOSURE_LENGTH_M)
───────────────────────────────────────────────────────────────────────────── */
export type ClosureStretch = {
  /** Where the closed lane begins, metres along the segment in the direction of travel (the engine's closurePoint). */
  readonly closurePointM: number;
  /** Where it ends (the engine's closureEnd). */
  readonly closureEndM: number;
  /** True when the upstream buffer ran off the start of the segment and was cut to 0. */
  readonly clampedStart: boolean;
  /** True when the wreck ran off the end of the segment and was cut to the segment length. */
  readonly clampedEnd: boolean;
};

/**
 * The closure stretch for a collision at `positionM` (metres along the segment, in the direction of travel).
 *
 *   closurePoint = max(0, position - UPSTREAM_BUFFER_M)
 *   closureEnd   = min(segmentLength, position + wreckLength)
 *
 * Each end is clamped independently, so a clamp only ever shortens the closure; the event itself does not move.
 * Returns null when there is no valid stretch: a non-finite argument, a segment or wreck length that is not
 * positive, or a position outside [0, segmentLength]. The caller decides whether that means "flag the event".
 */
export function closureStretch(positionM: number, wreckLengthM: number, segmentLengthM: number): ClosureStretch | null {
  if (!Number.isFinite(positionM) || !Number.isFinite(wreckLengthM) || !Number.isFinite(segmentLengthM)) return null;
  if (segmentLengthM <= 0 || wreckLengthM <= 0) return null;
  if (positionM < 0 || positionM > segmentLengthM) return null;
  const rawStart = positionM - UPSTREAM_BUFFER_M;
  const rawEnd = positionM + wreckLengthM;
  const closurePointM = Math.max(0, rawStart);
  const closureEndM = Math.min(segmentLengthM, rawEnd);
  if (closureEndM <= closurePointM) return null;
  return { closurePointM, closureEndM, clampedStart: rawStart < 0, clampedEnd: rawEnd > segmentLengthM };
}
