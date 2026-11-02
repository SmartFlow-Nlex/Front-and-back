"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayExitName, useNlexExits, type NlexExit } from "../../../lib/nlex-exits";
import { apiFetch } from "../../../lib/api";
import { lanesForSegment, laneSources } from "../../../lib/nlex-lanes";
import { fmtKm, fmtKmRange, kmMeasured, kmPost } from "../../../lib/km-post";
import { Car } from "lucide-react";
import PageHeader from "../../../components/dashboard/PageHeader";
import ScenarioForecastPanel, { forecastHour, forecastIncidentsAt, forecastInflowAt, useScenarioForecast } from "../../../components/dashboard/ScenarioForecastPanel";
import ForecastDayPicker from "../../../components/dashboard/ForecastDayPicker";
import InfoTooltip from "../../../components/dashboard/InfoTooltip";
import filterStyles from "../traffic/traffic.module.css";
import {
  TrafficSim, visualLane, replicate,
  type Metrics, type ReplicationResult, type RepStat,
} from "./simulation";
import {
  applyAtBoundary,
  canvasMarks,
  describeBoundary,
  describeOwner,
  formatClock,
  nextBoundaryAfter,
  roadOf,
  sceneMarks,
  NO_OWNERS,
  type Direction,
  type Incident,
  type Ownership,
  type RoadFrame,
  type SceneMark,
  type ScenarioEvent,
  type EventSite,
  type NewEventSpec,
  type KmStretch,
  MIN_EVENT_STRETCH_M,
} from "./scenarios/adapter";
import ScenarioPanel, { TimeField, type DirectionScenarioData, type SkipPlan } from "./components/ScenarioPanel";
import TrendCharts from "./components/TrendCharts";
import { recentAverage } from "./trends";
import PlacesList from "./components/PlacesList";
import { candidatesFrom, HOTSPOT_FAMILIES, SCENARIO_DRAG_TYPE, SITE_FAMILIES, type Hotspots, type PickResult, type ResolvedPlace, type ScenarioDrop, type SiteOption } from "./components/placement";
import { defaultOperatorLane, defaultVariant, getTemplate, type FamilyKey, type ScenarioVariant } from "./scenarios/catalogue";
import { expectedOnStretch, ON_CARRIAGEWAY_SHARE } from "./scenarios/forecastIncidents";
import { engineIndexToOperatorLane, operatorLaneToEngineIndex } from "./scenarios/assumptions";
import DirectionPill, { DIRECTION_NAME } from "./components/DirectionPill";
import { combineBaselines, combineMetrics } from "./bothMetrics";
import { drawBorrowedLanes, drawSceneGround, drawScenes, drawWater, drawWeather, hasSceneArt, type SceneActor, type SceneGeometry } from "./sceneArt";
import { ASSUMPTIONS } from "./scenarios/assumptions";
import { borrowedLanes, crossoverM, defaultStretch, planStretch, planZipper, REALLOCATION_NAME, zipperHolds, type ZipperState } from "./zipper";
import { PAINT_WHITE, isMotorcycle, motorcyclePaintFor, paintFor, trailerPaintFor, type Paint } from "./vehiclePaint";
import { drawMotorcycle } from "./motorcycleArt";
import { useDirectionSim, type DirectionApi, type SharedRoadInputs } from "./useDirectionSim";
import { getRecommendation } from "./recommendation";
import { REPLAY_HZ, ReplayBuffer } from "./replay";
import {
  FACILITY_LABEL_PX,
  GUTTER_LANE_PX_MAX,
  gutterLanePx,
  hasBarrier,
  drawFacilityGround,
  facilityWetAreas,
  drawFacilityOverlay,
  drawFacilityVehicles,
  drawParkedCars,
  baseLengthPx,
  drawnLengthPx,
  drawnWidthPx,
  spriteWidthScale,
  facilityDepth,
  facilityView,
  type FacGeom,
  type FacilityView,
  type SpriteFn,
} from "./facilityArt";
import { DRAW_W_FRAC, FAC_LANE, specDepth } from "./facilities";
import type { CorridorPlace } from "./facilityLayout";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";


/**
 * Default span for the docked view. 600 m on a ~1000 px card is 1.7 px per
 * metre, so a 4.5 m car draws about 8 px. Expanding the card widens the canvas
 * to the viewport, at which point a longer range stays just as readable — the
 * legibility hint measures the real width rather than assuming either.
 */
const DEFAULT_SEG_M = 600;
/**
 * Longest stretch worth drawing. A canvas about 1000 px wide showing 3 km gives
 * 0.33 px per metre, so a 4.5 m car is under two pixels — past this the picture
 * stops being a road and becomes a smear. The physics would still run; the
 * display is what breaks, so the cap is on what we show, and it is stated.
 */
const MAX_SEG_M = 3000;
const MIN_SEG_M = 100;

/** Drawn lane height, and the breathing room above and below the carriageway.
 *  Must match the values render() uses, or the canvas and the road disagree. */
const LANE_PX = 88;
const CANVAS_PAD = 8;

/** Widest a lane may be drawn while docked.
 *
 *  LANE_PX is the lane's natural size and still sets the canvas floor. This is
 *  the ceiling it may grow to when the card stretches to meet the control rail
 *  beside it: render() sizes a lane as min((height - padding) / lanes, ceiling),
 *  so with the two equal the road could never use extra height and any surplus
 *  became a white band. Raising the ceiling turns that surplus into road.
 *
 *  Not unbounded, and well under the 240 used when expanded: at four lanes this
 *  covers a rail about 650px tall, and past that a band is the right answer —
 *  a two-lane road drawn 300px per lane is a diagram of nothing. */
const DOCKED_LANE_MAX = 160;

/** The carriageway choice is drawn twice — in the top filter row, and inside the card in full screen
 *  (which covers that row) — so its wording lives in one place. */
const viewLabel = (v: "Both" | "NB" | "SB") => (v === "NB" ? "Northbound" : v === "SB" ? "Southbound" : "Both (NB + SB)");
const viewTitle = (v: "Both" | "NB" | "SB") =>
  v === "Both" ? "Both carriageways at once, median-separated — the whole road" : v === "NB" ? "Northbound only" : "Southbound only";

/**
 * The live sandbox clock: `clockStartMin` (the picked hour and minute) plus the engine's own elapsed
 * scenario time, as a 24h clock that ticks forward exactly when the simulation does (paused when it's
 * paused, faster under a speed multiplier) — in minutes since the same zero point `clockStartMin` in
 * ScenarioPanel event labels is written against, so "now" and "starts at" read off one shared clock.
 * Formatting the HH:MM:SS itself is TimeField's job (it's editable, not just displayed, and shown
 * to the second so the "live" clock actually reads as live); this only works out how many midnights
 * that live value has rolled past, for the date label beside it.
 */
function liveDayOffset(totalMin: number): number {
  return Math.floor(Math.round(totalMin * 60) / 86400);
}

/** ISO date plus a day offset (from a clock that has wrapped past midnight), as "Mon, Jan 5". */
function liveDateLabel(iso: string, dayOffset: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + dayOffset);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Below this many pixels a Class 1 car stops reading as a vehicle. */
const MIN_CAR_PX = 3;
/** Length of a Class 1 car, for the legibility estimate. */
const CAR_M = 4.5;

const RAMP_GUTTER_PX = 46; // room above/below the road for ramps and their tags
const AXIS_H = 22; // the km scale, printed beside the carriageway

/** Least height a carriageway's gutter needs at the natural lane size: its plazas, or its point ramps. */
function gutterFloorPx(facDepth: number, anyExits: boolean, barrier = false): number {
  return facDepth > 0 ? facDepth * (barrier ? LANE_PX : Math.min(LANE_PX, GUTTER_LANE_PX_MAX)) + FACILITY_LABEL_PX : anyExits ? RAMP_GUTTER_PX : 0;
}

/**
 * Both mode's median: the shared km axis (AXIS_H) plus a visible barrier
 * stripe (18px — thick enough to read as a physical divider, not a stray
 * line) between the two carriageways. One gutter, not two: NB and SB each
 * already reserve their OWN ramp gutter on their outer edge (see
 * `dualRoadLayout`), so the median only ever needs to hold the axis.
 */
const MEDIAN_GUTTER_PX = AXIS_H + 18;

/* ── A note on the vertical scale, because it has been got wrong twice ──────
 *
 * The canvas cannot be to scale in both axes: 600 m across 1,900 px is
 * 3.2 px/m, at which a lane is 11 px wide and a car a 15x6 px smudge. The
 * HORIZONTAL axis is true to scale because it carries real distance — headway,
 * density and queue length are all read off it. The VERTICAL axis is free,
 * because lane index is categorical rather than metric.
 *
 * Capping the vertical exaggeration at 4x was tried and reverted. It is
 * defensible geometry and a bad picture: the carriageway became a thin ribbon
 * stranded at the top of an empty screen. Lanes fill the space they are given.
 *
 * Two things from that attempt were worth keeping and are still here: the km
 * scale has reserved room OUTSIDE the road rather than being printed across
 * the bottom lane, and the geometry lives in one function instead of three
 * copies that had already drifted apart once. */

/* Road geometry, in ONE place.
 *
 * The renderer and the canvas click handler both need the same lane height and
 * the same road position, and each used to carry its own copy of both. They
 * had already drifted once — the handler dropping incidents a lane low
 * wherever a junction was in view. One definition is the only thing that
 * actually fixes that. */
function roadLayout(opts: {
  cssW: number;
  cssH: number;
  lanes: number;
  segLenM: number;
  exitCount: number;
  maxLaneH: number;
  /** Which side the ramps hang off: the side of the OUTER lane, since that is the lane they leave from. */
  rampsAbove: boolean;
  /** How far the toll plazas and service areas reach past the road edge, in lane units (facilityDepth). */
  facDepth?: number;
  /** A barrier plaza in view keeps the road's scale in the gutter — see gutterLanePx. */
  facBarrier?: boolean;
}) {
  const { cssW, cssH, lanes, segLenM, exitCount, maxLaneH, rampsAbove } = opts;
  const depth = Math.max(0, opts.facDepth ?? 0);
  const barrier = !!opts.facBarrier;
  /* The gutter holds the plazas themselves now, so it is measured in lanes at
   * the gutter's own scale, plus a band for their labels — solved together
   * with the lane height, so the road and the plazas beside it share the
   * canvas instead of the plazas eating the road. */
  const fixed = depth > 0 ? FACILITY_LABEL_PX : exitCount > 0 ? RAMP_GUTTER_PX : 0;
  const mToPx = segLenM > 0 ? cssW / segLenM : 1;
  /* Lanes fill whatever is left once the ramp gutter and the km scale have
   * taken theirs. Subtracting AXIS_H here is the part worth noticing: the
   * scale used to be printed inside the bottom lane, over the traffic. */
  const laneH = solveLaneH(cssH - CANVAS_PAD * 2 - fixed - AXIS_H, maxLaneH, (lh) => lh * lanes + depth * gutterLanePx(lh, barrier));
  const gutterPx = gutterLanePx(laneH, barrier);
  const rampGutter = Math.max(fixed + depth * gutterPx, exitCount > 0 ? RAMP_GUTTER_PX : 0);
  const roadH = laneH * lanes;
  // Ramp gutter on the ramp side, km scale on the other; the road centres in
  // whatever is left over and encroaches on neither.
  const spaceAbove = CANVAS_PAD + (rampsAbove ? rampGutter : AXIS_H);
  const spaceBelow = CANVAS_PAD + (rampsAbove ? AXIS_H : rampGutter);
  const roadTop =
    spaceAbove + Math.max(0, (cssH - spaceAbove - spaceBelow - roadH) / 2);
  return { rampGutter, gutterPx, laneH, roadH, roadTop, mToPx };
}

/** The tallest lane height (6..max) whose total drawn height fits `budget`. `used` grows with the lane height. */
function solveLaneH(budget: number, maxLaneH: number, used: (laneH: number) => number): number {
  if (used(maxLaneH) <= budget) return maxLaneH;
  let lo = 6;
  let hi = maxLaneH;
  if (used(lo) >= budget) return lo;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (used(mid) <= budget) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Both mode's geometry: two carriageways stacked in ONE canvas with a shared
 * median between them — SB (running right to left) on top, NB (running left to
 * right) below, each keeping its own OUTER ramp gutter (the top one's above it,
 * the bottom one's below it), with the km axis shared in the median rather than
 * duplicated per side.
 *
 * `laneH` is ONE value for both carriageways, not two independently-fitted
 * ones: a 4-lane carriageway and a 5-lane one stacked at different lane
 * heights would draw a false step in the median where none exists on the
 * road, and it is what turns "8 lanes" into one picture of one road rather
 * than two unrelated diagrams sharing a canvas. It is fitted to whichever
 * side needs the most room — laneH * (lanesNB + lanesSB) is the total road
 * height the budget is divided by.
 */
function dualRoadLayout(opts: {
  cssW: number;
  cssH: number;
  lanesNB: number;
  lanesSB: number;
  segLenM: number;
  exitCount: number;
  maxLaneH: number;
  /** Each carriageway's plazas and service areas, in lane units past its outer edge. */
  facDepthNB?: number;
  facDepthSB?: number;
  facBarrierNB?: boolean;
  facBarrierSB?: boolean;
}) {
  const { cssW, cssH, lanesNB, lanesSB, segLenM, exitCount, maxLaneH } = opts;
  const dNB = Math.max(0, opts.facDepthNB ?? 0);
  const dSB = Math.max(0, opts.facDepthSB ?? 0);
  const bNB = !!opts.facBarrierNB;
  const bSB = !!opts.facBarrierSB;
  // EXITS is one corridor-wide list shared by both directions (SharedRoadInputs),
  // so whether a point-ramp gutter is needed is the same question for NB and SB.
  // The plazas are not: each carriageway's gutter holds its own, and a window
  // with a big barrier plaza on one side need not widen the other.
  const fixedOf = (d: number) => (d > 0 ? FACILITY_LABEL_PX : exitCount > 0 ? RAMP_GUTTER_PX : 0);
  const mToPx = segLenM > 0 ? cssW / segLenM : 1;
  const totalLanes = Math.max(1, lanesNB + lanesSB);
  const laneH = solveLaneH(
    cssH - CANVAS_PAD * 2 - fixedOf(dNB) - fixedOf(dSB) - MEDIAN_GUTTER_PX,
    maxLaneH,
    (lh) => lh * totalLanes + dNB * gutterLanePx(lh, bNB) + dSB * gutterLanePx(lh, bSB),
  );
  const gutterPxNB = gutterLanePx(laneH, bNB);
  const gutterPxSB = gutterLanePx(laneH, bSB);
  const gutterNB = Math.max(fixedOf(dNB) + dNB * gutterPxNB, exitCount > 0 ? RAMP_GUTTER_PX : 0);
  const gutterSB = Math.max(fixedOf(dSB) + dSB * gutterPxSB, exitCount > 0 ? RAMP_GUTTER_PX : 0);
  const nbRoadH = laneH * lanesNB;
  const sbRoadH = laneH * lanesSB;
  // Centre the whole block (ramp gutters, both roads, median) when lanes hit maxLaneH before
  // the canvas is used up — the single-carriageway roadLayout() does the same.
  const usedH = gutterNB + gutterSB + sbRoadH + MEDIAN_GUTTER_PX + nbRoadH;
  const sbRoadTop = CANVAS_PAD + gutterSB + Math.max(0, (cssH - CANVAS_PAD * 2 - usedH) / 2);
  const medianTop = sbRoadTop + sbRoadH;
  const nbRoadTop = medianTop + MEDIAN_GUTTER_PX;
  const rampGutter = Math.max(gutterNB, gutterSB);
  return { rampGutter, gutterNB, gutterSB, gutterPxNB, gutterPxSB, laneH, nbRoadH, sbRoadH, nbRoadTop, medianTop, sbRoadTop, mToPx };
}

/**
 * Where an engine lane index draws vertically, within a carriageway block
 * that starts at `roadTop`. Plain (non-reversed) matches every single-
 * direction carriageway there has ever been: index 0 (operator lane 1, the
 * innermost lane per LANE1_IS_INNERMOST) at the top of the block.
 *
 * `reverseLanes` is Both mode's SB carriageway ONLY. SB is drawn above the
 * median, so the block's BOTTOM edge is the one actually next to the median
 * — reversing which end lane 0 draws at is what keeps "lane 1, innermost"
 * true on the drawn road instead of just true in the data. NB sits below the
 * median, so its top edge is already the median-adjacent one; NB never
 * reverses, and single-direction NB/SB never reverses either (roadLayout()
 * callers all pass false, unchanged from before D3).
 */
function laneSlotTop(engineLane: number, roadTop: number, laneH: number, lanes: number, reverseLanes: boolean): number {
  const slot = reverseLanes ? lanes - 1 - engineLane : engineLane;
  return roadTop + slot * laneH;
}

/** The reallocation the canvas draws: the one in force, or none for the frame or two in which the lane counts
 *  no longer match it (the page drops it on its next render). */
function heldZipper(z: ZipperState | null, lanesNB: number, lanesSB: number): ZipperState | null {
  return z !== null && zipperHolds(z, { NB: lanesNB, SB: lanesSB }) ? z : null;
}

/** Each carriageway's lanes as built. A reallocation lends lanes across the median; it moves no tarmac, so the
 *  road is sized and drawn from these, not from the runs' lane counts. */
function builtLanes(z: ZipperState | null, lanesNB: number, lanesSB: number): Readonly<Record<Direction, number>> {
  return z !== null ? z.base : { NB: lanesNB, SB: lanesSB };
}

/** Where one carriageway's lanes are drawn in Both mode. */
type DualLanes = {
  /** Its own surface: the lanes it has on its own side of the median. */
  readonly roadTop: number;
  readonly roadH: number;
  /** Under a reallocation, the lanes it was lent (its innermost engine lanes, 0..lent-1): drawn on the OTHER
   *  carriageway, its innermost lanes, against the median. */
  readonly lent: number;
  readonly strip: { readonly top: number; readonly h: number } | null;
  /** From the median into the strip: +1 when the strip is below it (lent to SB), -1 above (lent to NB). */
  readonly away: 1 | -1;
  /** Top of an engine lane's drawn slot. Fractional lanes interpolate, so a vehicle crossing from its own
   *  inner lane into a lent one is drawn across the median. */
  readonly laneTop: (lane: number) => number;
};

/**
 * Both mode's lanes, per carriageway, from dualRoadLayout() run on the BUILT lane counts. With no
 * reallocation each carriageway is its own block, lane 1 against the median (laneSlotTop). With one, the
 * carriageway that gave lanes keeps its remaining lanes, starting that many lanes out from the median, and
 * the carriageway that took them draws them there, in the space the giver's inner lanes leave.
 */
function dualLanes(
  L: { readonly laneH: number; readonly sbRoadTop: number; readonly medianTop: number; readonly nbRoadTop: number },
  lanes: Readonly<Record<Direction, number>>,
  z: ZipperState | null,
): Record<Direction, DualLanes> {
  const { laneH } = L;
  const of = (d: Direction): DualLanes => {
    const lent = borrowedLanes(z, d);
    const given = z !== null && z.toward !== d ? z.lanes : 0;
    const own = lanes[d] - lent;
    const nb = d === "NB";
    // NB sits below the median, SB above it; the giver's remaining lanes start `given` lanes out.
    const roadTop = nb ? L.nbRoadTop + given * laneH : L.sbRoadTop;
    const strip = lent === 0 ? null : nb ? { top: L.medianTop - lent * laneH, h: lent * laneH } : { top: L.nbRoadTop, h: lent * laneH };
    const slot = (l: number): number =>
      strip !== null && l < lent
        ? (nb ? strip.top + strip.h - (l + 1) * laneH : strip.top + l * laneH)
        : laneSlotTop(l - lent, roadTop, laneH, own, !nb);
    const laneTop = (l: number): number => {
      const a = Math.floor(l);
      return a === l ? slot(l) : slot(a) + (slot(a + 1) - slot(a)) * (l - a);
    };
    return { roadTop, roadH: own * laneH, lent, strip, away: nb ? -1 : 1, laneTop };
  };
  return { NB: of("NB"), SB: of("SB") };
}

/** The carriageway and engine lane drawn under `y`, own lanes and lent ones alike, or null (median, verge). */
function dualLaneAt(geo: Record<Direction, DualLanes>, lanes: Readonly<Record<Direction, number>>, laneH: number, y: number): { dir: Direction; lane: number } | null {
  for (const dir of ["NB", "SB"] as const) {
    for (let l = 0; l < lanes[dir]; l++) {
      const top = geo[dir].laneTop(l);
      if (y >= top && y < top + laneH) return { dir, lane: l };
    }
  }
  return null;
}

/**
 * Fixed physics timestep.
 *
 * This is what the animation's smoothness actually depends on: positions only
 * change when a step runs, so at 0.2 s the traffic moved five times a second
 * however fast the canvas redrew — the picture was 60 fps of the same frame.
 * 0.05 s puts motion at 20 updates a second at 1x, which reads as continuous,
 * and a finer step integrates the car-following model more accurately as well.
 *
 * Affordable only because the per-lane index removed the quadratic neighbour
 * search: at corridor length this is ~53 ms of CPU per second of simulation,
 * where the old scan would have needed ~450 ms — i.e. more than real time.
 */
const SIM_DT = 0.05;

/** Seconds the road is left to fill before its readings mean anything. Scenario events are timed from the end of it. */
const WARMUP_S = 60;

const SPEED_STEPS = [0.5, 1, 5, 10] as const;

/**
 * A skip's predicted wall time is (simulated seconds / SIM_DT) x the running cost of one sim.step(),
 * times this. It is a deliberately PESSIMISTIC upper bound, not a forecast, and the number was set
 * from measurement: across 27 timed skip intervals (multi-vehicle collision and self accident, median
 * and capped, 600 m and 3 km, in Both mode) the real time ran from 0.27x to 3.98x the bare step-cost
 * prediction, median 1.46x, 90th percentile 2.4x. The slow end is a queue still growing — the
 * cost of a step rises with the vehicles on the road, and the step cost read before the skip is the
 * cost of the road as it is NOW — plus the ~15-25% the 25 ms slices and setTimeout gaps add. The fast
 * end is a queue draining. 2.5 covers the 90th percentile: no skip over two minutes went unflagged,
 * and the price is a draining phase that is flagged when it need not be.
 */
const SKIP_COST_FACTOR = 2.5;

/* takenWith records what was on the road at capture time. A baseline is not
 * necessarily a clear road — comparing "one lane closed" against "two lanes
 * closed" is a perfectly good question — so the snapshot has to carry its own
 * conditions, or the comparison below it would imply a clean before-state it
 * never had. */
type Baseline = { avgSpeedKmh: number; throughputPerMin: number; longestQueueM: number; co2RatePerMin: number; avgTravelTimeS: number; takenWith: string };

/**
 * A proposed set of simulation changes from the command parser. Mirrors the
 * response of POST /api/ai-sandbox/command — keep in step with
 * Back-End/src/services/sandbox-command.service.ts. Every action names its
 * carriageway (the server fills in the focused one when the command did not),
 * and lane numbers are operator numbers: 1 against the median.
 */
type CommandAction =
  | { type: "set_route"; originExitId: number; destinationExitId: number }
  | { type: "frame"; fromKm: number; toKm: number }
  | { type: "frame_place"; placeId: string }
  | { type: "set_view"; view: Direction | "Both" }
  | { type: "close_lane"; direction: Direction; lanes: number[]; fromKm: number | null; toKm: number | null }
  | { type: "open_lane"; direction: Direction; lanes: number[] }
  | { type: "set_speed_limit"; direction: Direction; kmh: number | null; fromKm: number | null; toKm: number | null }
  | {
      type: "add_event";
      direction: Direction;
      family: FamilyKey;
      variant: {
        vehicle?: "car" | "bus" | "truck";
        cause?: "tire" | "engine" | "mechanical" | "fuel" | "electrical";
        label?: "rear_end" | "sideswipe" | "hit_and_run";
        intensity?: "light" | "moderate" | "heavy";
      };
      lane: number | null;
      extraLanes: number[];
      km: number | null;
      /** A stretch instead of a point ("within Km 12.30–12.40"), low km first: the event covers exactly it. */
      fromKm?: number | null;
      toKm?: number | null;
      placeId: string | null;
      site: "booth" | "pump" | "approach" | null;
      stations: number[];
      startMinutes: number;
      /** A clock time to start at ("at 12:30"), measured from this page's clock when it is applied; startMinutes is then 0. */
      atClock?: { hour: number; minute: number } | null;
      duration: { kind: "p50" } | { kind: "p90" } | { kind: "sampled" } | { kind: "manual"; minutes: number };
      /** Where the incident log records this kind of event most on the window (looked up when it is applied). */
      usual?: boolean;
    }
  | { type: "remove_event"; eventId: string }
  | { type: "clear_events"; direction: Direction }
  | { type: "set_reallocation"; toward: Direction | null; fromKm: number | null; toKm: number | null }
  | { type: "set_lane_count"; direction: Direction; lanes: number | "auto" }
  | { type: "set_inflow"; direction: Direction; vehPerHour: number | "observed" }
  | { type: "set_time"; hour: number; minute: number }
  | { type: "set_forecast_day"; date: string }
  | { type: "capture_baseline"; direction: Direction }
  /** Booths or pumps shut or reopened by hand, no incident; stations 0-based from the expressway side, [] = all. */
  | { type: "set_booths"; direction: Direction; placeId: string; stations: number[]; open: boolean }
  | { type: "playback"; run: "play" | "pause" | null; speed: number | null }
  | { type: "reset" }
  | { type: "full_screen"; on: boolean }
  // The original two, still understood if a cached proposal carries them.
  | { type: "add_incident"; lane: number; positionPct: number }
  | { type: "clear_incidents" };

type CommandPlan = {
  actions: CommandAction[];
  reply: string;
  unsupported: string | null;
  warnings: string[];
};

/** Names for a proposal's ids: exits, places on the route, events on the road (keyed "NB:ev2"). */
type CommandLookup = {
  exits: { exit_id: number; exit_name: string }[];
  placeName: (id: string) => string;
  /** A gas station has pumps; everything else, booths. */
  hasPumps: (id: string) => boolean;
  eventName: (key: string) => string;
  /** The stretch a closure or a speed limit with no km of its own takes: the one set in Interventions. Null when the
   *  same proposal moves the window first, since that stretch is placed along whatever window is on screen. */
  closureStretch: (d: Direction) => { fromKm: number; toKm: number } | null;
  zoneStretch: (d: Direction) => { fromKm: number; toKm: number } | null;
};

/** How long the page waits for the command parser: the backend's 90 s per call plus its one retry, and a little. */
const COMMAND_TIMEOUT_MS = 150_000;

const hhmm2 = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/** One proposed action as a line an operator can check before applying. */
function describeAction(a: CommandAction, look: CommandLookup): string {
  const on = (d: Direction) => `on ${DIRECTION_NAME[d]}`;
  const span = (f: number | null, t: number | null) => (f != null && t != null ? `, ${fmtKmRange(f, t, 2)}` : "");
  switch (a.type) {
    case "set_route": {
      const name = (id: number) => {
        const hit = look.exits.find((x) => x.exit_id === id);
        return hit ? displayExitName(hit.exit_name) : `exit ${id}`;
      };
      return `Set the route ${name(a.originExitId)} → ${name(a.destinationExitId)}`;
    }
    case "frame":
      return `Show ${fmtKmRange(a.fromKm, a.toKm, 2)}`;
    case "frame_place":
      return `Go to ${look.placeName(a.placeId)}`;
    case "set_view":
      return a.view === "Both" ? "Show both carriageways" : `Show ${DIRECTION_NAME[a.view]} only`;
    case "close_lane": {
      const at = a.fromKm != null && a.toKm != null ? { fromKm: a.fromKm, toKm: a.toKm } : look.closureStretch(a.direction);
      return `Close lane ${a.lanes.join(", ")} ${on(a.direction)}${at ? span(at.fromKm, at.toKm) : ", over the closure stretch in Interventions"}`;
    }
    case "open_lane":
      return `Reopen lane ${a.lanes.join(", ")} ${on(a.direction)}`;
    case "set_speed_limit": {
      if (a.kmh == null) return `Remove the speed limit ${on(a.direction)}`;
      const at = a.fromKm != null && a.toKm != null ? { fromKm: a.fromKm, toKm: a.toKm } : look.zoneStretch(a.direction);
      return `${a.kmh} km/h speed limit ${on(a.direction)}${at ? span(at.fromKm, at.toKm) : ", over the speed-zone stretch in Interventions"}`;
    }
    case "add_event": {
      const v = a.variant;
      const detail = [v.vehicle, v.cause, v.label?.replace(/_/g, " "), v.intensity].filter(Boolean).join(", ");
      const what = `${getTemplate(a.family).displayName}${detail ? ` (${detail})` : ""}`;
      const where = a.placeId
        ? `at ${look.placeName(a.placeId)}${a.site === "approach" ? ", on the approach" : a.stations.length ? `, ${a.site === "pump" ? "pump" : "booth"} ${a.stations.map((x) => x + 1).join(", ")}` : ""}`
        : `${a.lane != null ? `in lane ${[a.lane, ...a.extraLanes].join(", ")}` : ""}${a.fromKm != null && a.toKm != null ? ` over ${fmtKmRange(a.fromKm, a.toKm, 2)}` : a.km != null ? ` at Km ${fmtKm(a.km, 2)}` : " mid-window"}`;
      const when = a.atClock ? `starting at ${hhmm2(a.atClock.hour, a.atClock.minute)}` : a.startMinutes > 0 ? `starting in ${a.startMinutes} min` : "starting now";
      const long =
        a.duration.kind === "manual" ? `for ${a.duration.minutes} min`
          : a.duration.kind === "p90" ? "for a long (90th percentile) time"
            : a.duration.kind === "sampled" ? "for a sampled time"
              : "for the typical (median) time";
      return `${what} ${on(a.direction)}, ${a.usual ? "where the incident log records it most on this stretch" : where.trim()}, ${when}, ${long}`;
    }
    case "remove_event":
      return `Remove ${look.eventName(a.eventId)}`;
    case "clear_events":
      return `Clear every event and incident ${on(a.direction)}`;
    case "set_reallocation":
      return a.toward == null ? `End the ${REALLOCATION_NAME.toLowerCase()}` : `${REALLOCATION_NAME}: ${DIRECTION_NAME[a.toward]} borrows one lane${span(a.fromKm, a.toKm)}`;
    case "set_lane_count":
      return a.lanes === "auto" ? `${DIRECTION_NAME[a.direction]}: lanes back to what the road has` : `Rebuild ${DIRECTION_NAME[a.direction]} with ${a.lanes} lanes (clears its closures and events)`;
    case "set_inflow":
      return a.vehPerHour === "observed" ? `Inflow ${on(a.direction)} back to the recorded flow` : `Set inflow ${on(a.direction)} to ${fmt(a.vehPerHour)} veh/h`;
    case "set_time":
      return `Set the clock to ${hhmm2(a.hour, a.minute)}`;
    case "set_forecast_day":
      return `Run the forecast for ${new Date(`${a.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}`;
    case "capture_baseline":
      return `Capture a baseline ${on(a.direction)}`;
    case "set_booths": {
      const name = look.placeName(a.placeId);
      const what = look.hasPumps(a.placeId) ? "pump" : "booth";
      const which = a.stations.length === 0 ? `every ${what}` : `${what}${a.stations.length === 1 ? "" : "s"} ${a.stations.map((x) => x + 1).join(", ")}`;
      return `${a.open ? "Reopen" : "Shut"} ${which} at ${name} (${DIRECTION_NAME[a.direction]})`;
    }
    case "playback":
      return [a.run === "play" ? "Play the simulation" : a.run === "pause" ? "Pause the simulation" : null, a.speed != null ? `at ${a.speed}×` : null].filter(Boolean).join(" ") || "Simulation speed unchanged";
    case "reset":
      return "Reset: clear every event, closure, booth, speed limit and baseline on both carriageways";
    case "full_screen":
      return a.on ? "Full screen" : "Exit full screen";
    case "add_incident":
      return `Place an incident in lane ${a.lane}, ${Math.round(a.positionPct)}% along the segment`;
    case "clear_incidents":
      return "Clear all incidents";
  }
}

/** On no lane: the shoulder, and rain over the whole stretch (ScenarioPanel's hasLane). */
const eventHasLane = (f: FamilyKey) => f !== "breakdown_shoulder" && f !== "rain";
/** Where blocking more than one lane may be given by hand (ScenarioPanel's MULTI_LANE_FAMILIES). */
const EVENT_MULTI_LANE = new Set<FamilyKey>(["multi_vehicle_collision", "overturned_vehicle", "flood", "scheduled_roadworks"]);

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
/** "Overturned vehicle #3, Heavy rain #4 and 2 more": a list of events kept to a line. */
const eventList = (events: readonly { name: string }[]): string => {
  const shown = events.slice(0, 2).map((e) => e.name);
  const more = events.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(" and ");
};

export default function AiSandboxPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  /** Seconds of animation clock for the scene art (rain, water, beacons): advances in real time, but only while the run is not paused. */
  const animClockRef = useRef<number>(0);
  /** The lane reallocation in force, for the canvas (the rAF loop reads it outside React). */
  const zipperRef = useRef<ZipperState | null>(null);
  /** Cursor over the canvas in CSS px, and the vehicle whose speed bubble a click pinned — the render loop reads both. */
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const pinnedVehicleRef = useRef<VehicleRef | null>(null);
  const placingArmedRef = useRef(false);
  const metricAccRef = useRef<number>(0);
  const simAccRef = useRef<number>(0);
  /** Steps the loop has taken, both carriageways together: what lines the two replay recordings up (ReplayFrame.seq). */
  const stepSeqRef = useRef<number>(0);
  /** Running cost of one sim.step(), ms, per direction — what a skip's estimated duration is worked out from. Null until the animation loop has stepped that direction. */
  const stepCostRef = useRef<Record<Direction, number | null>>({ NB: null, SB: null });

  // Corridor exits come from the shared list so this tab, maintenance and the
  // map all offer the same set. See lib/nlex-exits.
  /* Exits in corridor order, not alphabetical.
   *
   * The API returns them sorted by name — Angeles, Balagtas, Balintawak … —
   * which for a route picker along a single corridor is close to random: an
   * operator choosing an origin and a destination is reading a road, not an
   * index. Sorting by km-post here also keeps the origin/destination select
   * indices, the exit chips and the on-road ramps all in one order, so a
   * position in one list means the same thing in the others. */
  const { exits: EXITS_RAW } = useNlexExits();
  const EXITS = useMemo<NlexExit[]>(() => [...EXITS_RAW].sort((a, b) => a.km - b.km), [EXITS_RAW]);
  const [origin, setOrigin] = useState(0);
  const [destination, setDestination] = useState(4);

  // Expanded view. A long km range needs pixels the docked card does not have;
  // rather than reshape the page for every visit, the road can take the whole
  // viewport on demand and give it back.
  const [expanded, setExpanded] = useState(false);
  // Full screen lifts the card out of the page grid, which would let the page behind it reflow and
  // throw the scroll position on exit. A placeholder of the card's docked height holds its slot.
  const mainCardRef = useRef<HTMLElement>(null);
  /* Full screen floats its header over the road, and the header is as tall as
     its rows happen to wrap. The road starts below whatever height it actually
     took (--fs-top on the card), not a fixed offset: a fixed 104px let the
     Forecast day row sit on top of the outer lane once the header grew. */
  const hudTopRef = useRef<HTMLDivElement | null>(null);
  /* The same for the readout strip along the bottom (--fs-strip): its height was a fixed 96 px (148 in Both),
     but it is as tall as its tiles render, which browser zoom changes — at 175% the road ran under it. Both are
     measured, and both again whenever either changes size (zooming in or out resizes them). Applied on the next
     frame: setting them inside the observer's own callback resized what it was observing, and the browser
     reported a ResizeObserver loop on every zoom step. */
  useEffect(() => {
    const el = hudTopRef.current;
    const card = mainCardRef.current;
    if (!expanded || !el || !card) return;
    let raf = 0;
    const measure = () => {
      card.style.setProperty("--fs-top", `${Math.ceil(el.offsetTop + el.getBoundingClientRect().height)}px`);
      const strip = card.querySelector<HTMLElement>(".sandbox-metric-row");
      if (strip) card.style.setProperty("--fs-strip", `${Math.ceil(card.getBoundingClientRect().bottom - strip.getBoundingClientRect().top) + 4}px`);
    };
    const apply = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    const strip = card.querySelector<HTMLElement>(".sandbox-metric-row");
    if (strip) ro.observe(strip);
    window.addEventListener("resize", apply);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", apply);
      card.style.removeProperty("--fs-top");
      card.style.removeProperty("--fs-strip");
    };
  }, [expanded]);
  const [heldHeight, setHeldHeight] = useState(0);
  const toggleExpanded = () => {
    if (!expanded) {
      setHeldHeight(mainCardRef.current?.offsetHeight ?? 0);
      // Too narrow for the road and the controls side by side (a small window, or zoomed in): the controls are a
      // sheet over the road there, so full screen opens with them folded and the road in view (C brings them back).
      if (window.matchMedia(NARROW_FULL_SCREEN).matches) setRailOpen(false);
    }
    setExpanded((v) => !v);
  };

  // Actual drawn width, so the legibility hint reflects this screen rather than
  // an assumption made when the canvas was a third of the page.
  const [canvasW, setCanvasW] = useState(1000);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // On the next frame, not inside the callback: the state change re-lays out the page (see the --fs-top effect).
    let raf = 0;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      cancelAnimationFrame(raf);
      if (w > 0) raf = requestAnimationFrame(() => setCanvasW(w));
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);


  const originExit = EXITS[Math.min(origin, EXITS.length - 1)];
  const destExit = EXITS[Math.min(destination, EXITS.length - 1)];


  /**
   * WHICH STRETCH of the corridor is being simulated, as km-posts.
   *
   * An operator asks "what happens between km 3.5 and km 6", not "show me a
   * representative 280 m". The simulation is parameterised on length, so it can
   * model whatever span is asked for; only the drawing has a practical ceiling
   * (see MAX_SEG_M). Previously this was a fixed 280 m of anonymous tarmac and
   * the route pickers changed nothing but the heading.
   *
   * Origin/destination now define this km window ONLY (Phase D2). Which
   * carriageway(s) are simulated is a SEPARATE choice — `view` below — because
   * a real expressway is two carriageways sharing one chainage, not one
   * carriageway whose direction happens to be a fact about which end you
   * start from. Before D2, direction WAS derived from origin > destination;
   * that coupling is gone, and swapping origin/destination now only reverses
   * which end of the window is "from".
   */
  const routeFromKm = Math.min(originExit?.km ?? 0, destExit?.km ?? 0);
  const routeToKm = Math.max(originExit?.km ?? 0, destExit?.km ?? 0);

  /** NB only, SB only, or both carriageways at once (median-separated on the canvas — renderBoth). */
  // The tab opens on Both: the whole road, both carriageways. NB-only / SB-only are one click away.
  const [view, setView] = useState<Direction | "Both">("Both");
  const activeDirections: readonly Direction[] = view === "Both" ? ["NB", "SB"] : [view];
  /**
   * The carriageway the few things that can only address ONE road at a time act on, in Both
   * mode: the Command prompt (the request fields carry no direction), the
   * "Add to" picker in Scenario events, "Load into simulation", and the km-window sliders' primary
   * slot. Everything else in Both mode — tiles, Interventions, Baseline, before/after,
   * recommendations, event lists — shows BOTH carriageways, each named. Clicking a road with a
   * placing tool armed moves it. NB-only/SB-only needs no choice: the one active direction IS the
   * focus, so those modes behave as they did before Both mode existed.
   */
  const [focusedDirection, setFocusedDirection] = useState<Direction>("NB");
  const focusDirection: Direction = view === "Both" ? focusedDirection : view;

  /* First half of a two-click span across the exit chips. Null means the next
   * click just frames a single junction. */
  /* At most one section open, and closing one closes it — it does not hand the
   * space to another. Collapsing a section to see more road, only for a
   * different section to spring open in its place, is the rail refusing to get
   * out of the way. Corridor starts open because nothing else means anything
   * until the route is set. */
  const [openSection, setOpenSection] =
    useState<"corridor" | "interventions" | "scenarios" | "baseline" | "confidence" | null>("corridor");
  const toggleSection = (id: "corridor" | "interventions" | "scenarios" | "baseline" | "confidence") =>
    setOpenSection((cur) => (cur === id ? null : id));
  /* The chips are a reframing tool, reached for occasionally, but nineteen of
   * them wrap to four rows and were the tallest thing in the corridor section.
   * The count stays visible so nothing is lost by keeping them folded. */
  const [segFromKm, setSegFromKm] = useState<number | null>(null);
  const [segToKm, setSegToKm] = useState<number | null>(null);
  /* How the stretch is chosen (2026-10-27, user request): by two exits (the route, with the default window inside
     it), or by a km range anywhere on the corridor, which picks the enclosing exits itself. One at a time, so the
     panel asks one question instead of showing both sets of fields. */
  const [entryMode, setEntryMode] = useState<"exits" | "km">("exits");
  /** A km window chosen together with a new route: the route change must keep it rather than reset it. */
  const pendingSegRef = useRef<{ from: number; to: number } | null>(null);

  // Default to the whole route, capped at what can still be drawn legibly.
  const routeLenM = Math.max(0, (routeToKm - routeFromKm) * 1000);
  const defaultFrom = routeFromKm;
  // Default to a span that can be READ, not the longest one allowed. Defaulting
  // to the whole route put 3 km on a ~1000 px canvas — 0.33 px per metre, so a
  // 4.5 m car drew 1.5 px wide and the road looked empty while 200 vehicles
  // were on it. Wider spans stay available; they are just not the starting
  // point, and the hint says what happens to the picture when you choose one.
  const defaultTo = routeFromKm + Math.min(routeLenM || DEFAULT_SEG_M, DEFAULT_SEG_M) / 1000;

  const fromKm = Math.min(Math.max(segFromKm ?? defaultFrom, routeFromKm), routeToKm);
  const toKm = Math.min(Math.max(segToKm ?? defaultTo, fromKm + MIN_SEG_M / 1000), Math.max(routeToKm, fromKm + MIN_SEG_M / 1000));
  /* How wide the road on screen is, per carriageway: the narrowest width the drawn stretch passes through, from
     the corridor's lane table (lib/nlex-lanes.ts, OpenStreetMap). The stretch on screen, not the whole route:
     a 600 m view near Balintawak is 4 lanes even when the route runs on into the 3-lane section. Each
     direction's useDirectionSim follows its own figure; the Lanes sliders only override it. */
  const segmentLanes: Record<Direction, number | null> = { NB: lanesForSegment(fromKm, toKm, "NB"), SB: lanesForSegment(fromKm, toKm, "SB") };
  const laneProvenance = [...new Set([...laneSources(fromKm, toKm, "NB"), ...laneSources(fromKm, toKm, "SB")])];
  const segLengthM = Math.round((toKm - fromKm) * 1000);
  const spanCapped = routeLenM > MAX_SEG_M && segLengthM >= MAX_SEG_M;

  /* Jump the window to a junction, toll plaza, barrier or service area on the
     chosen route. The list offers only what lies between the origin and the
     destination, so a pick never changes the route: the operator chose that
     stretch, and the list is for moving around inside it. */
  const [placesOpen, setPlacesOpen] = useState(false);
  /** Open window w, kept inside the route. */
  const showWindow = (w: { fromKm: number; toKm: number }) => {
    setSegFromKm(Number(Math.max(routeFromKm, w.fromKm).toFixed(3)));
    setSegToKm(Number(Math.min(routeToKm, w.toKm).toFixed(3)));
  };
  const framePlace = (pl: CorridorPlace, dir: Direction) => {
    showWindow(pl.frame);
    if (view === "Both") setFocusedDirection(dir);
  };
  /** Frame the window on one junction. The drawn window defaults to 600 m from
   *  the origin, so most junctions start off-screen; this puts one in the middle. */
  const frameJunction = (km: number) => {
    const win = Math.min(routeLenM || DEFAULT_SEG_M, DEFAULT_SEG_M) / 1000;
    let a = km - win / 2;
    let b = km + win / 2;
    // Shift rather than shrink at the ends, so the origin or destination is
    // still framed with road beside it instead of being clipped.
    if (a < routeFromKm) { a = routeFromKm; b = Math.min(routeToKm, a + win); }
    if (b > routeToKm) { b = routeToKm; a = Math.max(routeFromKm, b - win); }
    showWindow({ fromKm: a, toKm: b });
  };

  /** Choose by km range: the window is what was typed, and the route becomes the nearest exits around it
   *  (keeping the current orientation, origin before or after destination). */
  const corridorMinKm = EXITS[0]?.km ?? 0;
  const corridorMaxKm = EXITS[EXITS.length - 1]?.km ?? 0;
  const frameKmRange = (from: number, to: number) => {
    const lo = Math.max(corridorMinKm, Math.min(from, to));
    const hi = Math.min(corridorMaxKm, Math.max(Math.max(from, to), lo + MIN_SEG_M / 1000));
    let a = 0;
    EXITS.forEach((ex, i) => { if (ex.km <= lo) a = i; });
    let b = EXITS.length - 1;
    for (let i = EXITS.length - 1; i >= 0; i--) if (EXITS[i].km >= hi) b = i;
    if (a === b) { if (b < EXITS.length - 1) b += 1; else a = Math.max(0, a - 1); }
    const [o, d] = origin > destination ? [b, a] : [a, b];
    const win = { from: Number(lo.toFixed(3)), to: Number(hi.toFixed(3)) };
    if (o === origin && d === destination) {
      setSegFromKm(win.from);
      setSegToKm(win.to);
    } else {
      pendingSegRef.current = win;
      setOrigin(o);
      setDestination(d);
    }
  };

  /** Fit the whole origin -> destination route, as far as it can be drawn. */
  const fitRoute = () => {
    setSegFromKm(routeFromKm);
    setSegToKm(Math.min(routeToKm, routeFromKm + MAX_SEG_M / 1000));
  };
  /**
   * How wide a Class 1 car actually is on screen. Measured rather than assumed:
   * the canvas went from a third of the page to all of it, and a guess baked in
   * at the old width would have warned about spans that are now perfectly
   * readable. Below MIN_CAR_PX the vehicles stop being legible even though the
   * physics is unaffected — the run stays valid, the picture just cannot show
   * it, and the reader deserves to be told which is which.
   */
  const carPx = (canvasW / Math.max(1, segLengthM)) * CAR_M;
  const tooFineToDraw = carPx < MIN_CAR_PX;
  /** Longest span that still draws legibly at the canvas's current width. */
  const maxLegibleM = Math.round((canvasW * CAR_M) / MIN_CAR_PX);

  useEffect(() => {
    // A km range from the previous route may not exist on the new one -- unless the range is what moved the
    // route (Choose by: km range), in which case it is kept.
    const keep = pendingSegRef.current;
    pendingSegRef.current = null;
    setSegFromKm(keep ? keep.from : null);
    setSegToKm(keep ? keep.to : null);
  }, [origin, destination]);

  /** The exit nearest the middle of the span, so the canvas can name the place. */
  const nearestExit = (() => {
    if (!EXITS.length) return null;
    const mid = (fromKm + toKm) / 2;
    return EXITS.reduce((best, x) => (Math.abs(x.km - mid) < Math.abs(best.km - mid) ? x : best));
  })();

  // Single-direction canvas label (NB-only/SB-only); Both mode labels each carriageway itself in renderBoth.
  const dirLabel = focusDirection === "NB" ? "Northbound" : "Southbound";

  const locationLabel = nearestExit
    ? `${dirLabel} · ${fmtKmRange(fromKm, toKm, 2)} · ${(segLengthM / 1000).toFixed(2)} km · near ${displayExitName(nearestExit.exit_name)}`
    : `${dirLabel} · ${fmtKmRange(fromKm, toKm, 2)}`;

  // The render loop runs outside React, so these reach it through refs.
  const locationRef = useRef(locationLabel);
  locationRef.current = locationLabel;
  const marksRef = useRef({ fromKm, toKm, direction: focusDirection });
  marksRef.current = { fromKm, toKm, direction: focusDirection };
  // Docked, a lane is capped so the road keeps its proportions inside a card.
  // Expanded there is no card to respect, and capping it only left the
  // carriageway floating in the middle of an empty screen.
  const maxLaneRef = useRef(LANE_PX);
  /** The plaza or service area the scenario panel is placing an event at, outlined on the road. */
  const facilityHighlightRef = useRef<string | null>(null);
  /* Dragging a scenario chip onto the road: the panel fills scenarioDropRef with what a drop does, the chip being
     dragged is draggedFamily (the road shows where it would land, dropGhostRef, drawn by the frame loop). */
  const scenarioDropRef = useRef<ScenarioDrop | null>(null);
  const [draggedFamily, setDraggedFamily] = useState<FamilyKey | null>(null);
  const draggedFamilyRef = useRef<FamilyKey | null>(null);
  draggedFamilyRef.current = draggedFamily;
  const dropGhostRef = useRef<DropGhost | null>(null);
  const setHighlight = useCallback((id: string | null) => {
    facilityHighlightRef.current = id;
  }, []);
  maxLaneRef.current = expanded ? 240 : DOCKED_LANE_MAX;
  // Exits that fall inside the drawn span, so the road can name the places the
  // operator is looking at rather than only its km-posts.
  const exitsRef = useRef<{ name: string; km: number }[]>([]);
  exitsRef.current = EXITS.filter((x) => x.km >= fromKm && x.km <= toKm).map((x) => ({
    name: displayExitName(x.exit_name),
    km: x.km,
  }));

  // Whether the road is running a loaded forecast. "Load into simulation" turns it on; from then on the
  // road follows the forecast day and time chosen in the top strip, so what it shows is what the Traffic and
  // Incident tabs forecast for that day and hour. Kept apart from dataAnchor so the slider caption can never
  // call a prediction an observation. Shared: the forecast is one corridor prediction, not one per carriageway.
  const [forecastFollowing, setForecastFollowing] = useState(false);
  // Exit the incident model rates highest for the chosen day, when the sandbox
  // has been positioned there.
  const [hotspot, setHotspot] = useState<string | null>(null);
  // Whether the selected forecast day has an incident forecast. Days past the
  // incident model's horizon still carry traffic and CO2 forecasts, so they are
  // offered, but the hint must not credit the incident model for choosing the place.
  const [incidentCovered, setIncidentCovered] = useState(true);
  const [simSpeed, setSimSpeed] = useState<(typeof SPEED_STEPS)[number]>(1);
  const [running, setRunning] = useState(true);
  /* Replay. `replayIndex` null means live; a number is the frame on screen.
     One buffer per carriageway, because the two record independently and an
     operator reviewing NB should not have SB scrubbed out from under them. */
  const replayRef = useRef<Record<Direction, ReplayBuffer>>({
    NB: new ReplayBuffer(),
    SB: new ReplayBuffer(),
  });
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [replayLen, setReplayLen] = useState(0);
  /* Whether the recording holds anything worth reviewing. The control is
     hidden entirely when it does not: on an empty road there is nothing to
     replay, and a button that is always present but does nothing teaches the
     operator to ignore it. Recomputed on the metrics tick rather than per
     frame — it walks the buffer. */
  const [replayHasEvent, setReplayHasEvent] = useState(false);
  const replayIndexRef = useRef<number | null>(null);
  replayIndexRef.current = replayIndex;
  /* Whose recording the slider walks while reviewing. The other carriageway is shown at the same moment, found by
     the loop's step counter (17 Oct 2026, testers SB-15: Both, the view the tab opens on, drew the live road
     whatever the slider said, so scrubbing moved nothing). Pinned when review starts, so moving focus to the other
     carriageway mid-review does not swap the recording under the slider. */
  const [replayLead, setReplayLead] = useState<Direction>("NB");
  const replayLeadRef = useRef<Direction>("NB");
  replayLeadRef.current = replayLead;
  /* Playing while reviewing means "catch up", however it was pressed: the button already did this, but Space in full
     screen and a "play" command resumed the engine under a frozen frame, and the recording then moved on beneath
     the slider (each new frame shifts the oldest out, so the same index became a different moment). */
  useEffect(() => {
    if (running && replayIndexRef.current !== null) setReplayIndex(null);
  }, [running]);
  /* Playing the recording back (19 Oct 2026, testers SB-15, second pass). Review used to be a frozen frame and a
     slider: "Replay incident" stopped a second before the incident and nothing moved until the slider was dragged,
     and the transport's Play meant "back to live", so the one way to watch it happen was to scrub by hand. It now
     plays from there at the run's speed, can be paused and dragged at any point (a drag while playing carries on from
     where it was dropped), and stops on the last recorded frame, which says so. The engine stays paused throughout. */
  const [replayPlaying, setReplayPlaying] = useState(false);
  const replayLenRef = useRef(0);
  replayLenRef.current = replayLen;
  useEffect(() => {
    if (replayIndex === null) setReplayPlaying(false);
  }, [replayIndex]);
  useEffect(() => {
    if (!replayPlaying) return;
    /* Frames are recorded REPLAY_HZ times a simulated second, so at 1x one goes by every 125 ms. Ticks of 50 ms that
       move on as many frames as are due keep a 10x replay from re-rendering the page sixty times a second. */
    const TICK_MS = 50;
    let due = 0;
    const t = setInterval(() => {
      const i = replayIndexRef.current;
      if (i === null) return;
      due += (TICK_MS / 1000) * simSpeed * REPLAY_HZ;
      const n = Math.floor(due);
      if (n === 0) return;
      due -= n;
      const last = replayLenRef.current - 1;
      const next = Math.min(last, i + n);
      setReplayIndex(next);
      if (next >= last) setReplayPlaying(false);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [replayPlaying, simSpeed]);

  /* Full screen used to be the road and nothing else: the controls rail stayed
   * behind the overlay, so the one mode meant for watching the simulation was
   * the one mode where nothing could be changed. The rail comes with it now,
   * and can be folded away when the road is all you want. */
  const [railOpen, setRailOpen] = useState(true);
  /* The notes, legend and recommendation are reference material. Docked they
   * sit under the road; full screen they were taking a quarter of the height
   * the road had just been given, so they start folded and open on request. */
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      // Never steal a key from someone typing into the Command prompt.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        if (e.key === "Escape") (t as HTMLInputElement).blur();
        return;
      }
      if (e.key === "Escape") { setExpanded(false); return; }
      if (e.code === "Space") { e.preventDefault(); setRunning((r) => !r); return; }
      if (e.key === "c" || e.key === "C") { setRailOpen((o) => !o); return; }
      const speed = { "1": 0.5, "2": 1, "3": 2, "4": 4 } as const;
      if (e.key in speed) {
        const v = speed[e.key as keyof typeof speed];
        if ((SPEED_STEPS as readonly number[]).includes(v)) setSimSpeed(v as (typeof SPEED_STEPS)[number]);
        return;
      }
      if (e.key === "b" || e.key === "B") setView("Both");
      if (e.key === "n" || e.key === "N") setView("NB");
      if (e.key === "s" || e.key === "S") setView("SB");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  /* Zoomed in (or the window made narrow) past the point where the road and the controls fit side by side while in
   * full screen: the controls become a sheet over the road, so they fold away rather than cover half of it. */
  useEffect(() => {
    if (!expanded) return;
    const mq = window.matchMedia(NARROW_FULL_SCREEN);
    const onChange = (e: MediaQueryListEvent) => { if (e.matches) setRailOpen(false); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [expanded]);

  /* The page behind must not scroll under the overlay: a wheel over the road
   * otherwise moved the dashboard it is covering. */
  useEffect(() => {
    if (!expanded) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [expanded]);

  /** What the canvas draws for scenario events: where each is, its phase, and which incidents in the engine are the scenarios'. Keyed by direction — Phase D3 draws both; today the canvas reads only the focused one. */
  const scenarioOverlayRef = useRef<Partial<Record<Direction, ScenarioOverlay>>>({});

  // Simulation Controls card can flip between the manual controls and a
  // natural-language command prompt for the NLEX corridor. The prompt is parsed
  // by GLM server-side (see Back-End/src/services/sandbox-command.service.ts);
  // the model proposes actions and the operator confirms before anything is
  // applied to the running simulation.
  const [sideMode, setSideMode] = useState<"controls" | "command">("controls");
  const [command, setCommand] = useState("");
  const [commandNote, setCommandNote] = useState<string | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [plan, setPlan] = useState<CommandPlan | null>(null);
  /* While the model works: when it started (for the seconds shown on the button), and the request, so it can be
     cancelled. GLM usually answers in a few seconds and now and then takes a minute or more (its providers' slow
     tail), which with no sign of life read as a hung button. */
  const [commandSince, setCommandSince] = useState<number | null>(null);
  const [, setCommandClock] = useState(0);
  const commandAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (commandSince === null) return;
    const t = setInterval(() => setCommandClock((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [commandSince]);
  /** The carriageway a proposal was worked out FOR — fixed when the command is sent, so changing focus while it is on screen cannot redirect Apply to a different road. */
  const [planDirection, setPlanDirection] = useState<Direction | null>(null);

  /* Anchor the inflow to the traffic that actually passes THIS segment.
   *
   * It asked for the corridor total and divided by 24 — every vehicle entering
   * NLEX anywhere, across all twenty exits. That produced ~9,200 veh/hr, which
   * the clamp then pinned at 8,000 for every route, direction and segment.
   *
   * On four lanes that is 2,000 per lane before anything is done to the road,
   * and closing one lane demands 2,667 per lane from the three that remain —
   * a third above real motorway capacity. The queue in the closed lane then
   * could never clear: measured at that inflow only 33 of 67 vehicles entering
   * the closed lane ever merged out, against 21 of 22 at a realistic demand.
   * Every closure looked like the merge logic was broken when the real problem
   * was that the scenario was impossible.
   *
   * byPlaza carries per-exit volume, so the nearest junction is a far better
   * proxy for flow past the segment, and the ceiling is now tied to the lane
   * count rather than a flat 8,000. */
  /* Per-class CO2 and fleet share, from the warehouse rather than from
   * constants in the bundle. Until it resolves the simulation runs on its
   * defaults, which is why this is optional rather than blocking. Shared: a
   * vehicle class's g/m CO2 factor is not a property of which carriageway
   * it's on (each direction's own fleet-MIX share still comes from its own
   * demand profile — see useDirectionSim's activeHour). */
  const [classProfile, setClassProfile] =
    useState<Partial<Record<1 | 2 | 3, { co2PerM?: number; share?: number }>> | undefined>(undefined);
  useEffect(() => {
    fetch(`${BACKEND}/api/emissions/fleet-profile`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!j.success || !j.data) return;
        const out: Partial<Record<1 | 2 | 3, { co2PerM?: number; share?: number }>> = {};
        for (const f of j.data.factors ?? []) {
          const k = Number(f.vehicle_class) as 1 | 2 | 3;
          if (k !== 1 && k !== 2 && k !== 3) continue;
          // g/km in the warehouse; the simulation integrates in g per metre.
          out[k] = { ...(out[k] ?? {}), co2PerM: Number(f.co2_g_per_km) / 1000 };
        }
        const mix = j.data.mix;
        if (mix) for (const k of [1, 2, 3] as const) {
          if (typeof mix[k] === "number") out[k] = { ...(out[k] ?? {}), share: mix[k] };
        }
        if (Object.keys(out).length) setClassProfile(out);
      })
      .catch(() => {});
  }, []);

  /* ── Observed hourly demand: hour of day stays SHARED (D1 §2 / D2 correction #4) — "what does
   * 09:00 look like" is one question, not one per carriageway. Each direction's own demand PROFILE
   * (fetched per direction, see useDirectionSim) still supplies its own vehPerHour/mix AT that
   * shared hour, which is what actually varies between NB and SB. */
  const [hourOfDay, setHourOfDay] = useState<number | null>(null);
  /* Minutes (and, since the clock reads to the second, a fractional part of a minute for the
   * seconds) within that hour — purely a starting-clock refinement, never fed to the demand/incident
   * forecast (which is hourly-resolution data; there is no such thing as "the 07:23:41 profile").
   * Changing it does NOT rebuild the run the way hourOfDay does: only hourOfDay is a rebuild
   * dependency (see useDirectionSim's `ramps`/`rebuild`), so nudging it just moves where the live
   * Simulation time clock (next to Play/Pause) starts counting from. */
  const [clockMinuteOffset, setClockMinuteOffset] = useState(0);
  // Open at the busiest hour: the interesting question is what a closure costs when it costs the
  // most. Whichever direction's demand-profile fetch resolves first proposes it; once set, neither
  // direction's later fetch overwrites it (both call this, but only the first "cur == null" wins).
  const proposeHourOfDay = useCallback((hour: number) => {
    setHourOfDay((cur) => (cur == null ? hour : cur));
  }, []);
  const resetSimAccumulator = useCallback(() => {
    simAccRef.current = 0;
  }, []);

  // The forecast is fetched here, above the direction hooks, because what it says for the chosen day and hour is
  // an input to them (their inflow and the incidents placed on the road), not just something the panel displays.
  const forecast = useScenarioForecast({
    onHotspot: (name, km) => {
      // Only reposition while the operator has not chosen a span of their
      // own — a suggestion should not overwrite a deliberate choice.
      if (segFromKm != null || segToKm != null) return;
      if (km < routeFromKm || km > routeToKm) return;
      const half = DEFAULT_SEG_M / 2000;
      const from = Math.max(routeFromKm, Math.min(km - half, routeToKm - DEFAULT_SEG_M / 1000));
      setSegFromKm(Number(from.toFixed(2)));
      setSegToKm(Number((from + DEFAULT_SEG_M / 1000).toFixed(2)));
      setHotspot(name);
    },
    onIncidentCoverage: setIncidentCovered,
  });
  /* Picking a forecast day moves the clock to that day's busiest forecast hour (17 Oct 2026, testers SB-8). The hour
     was set once, from the observed profile's peak, and never followed the day: a Saturday (forecast peak 11:00) or
     a Sunday (16:00) still opened at the weekday evening peak, and the forecast was read at that hour. The day's
     figures come over the network, so the pick is held until they arrive; a time set after it (the clock field, a
     command) wins. */
  const [hourFollowsDay, setHourFollowsDay] = useState<string | null>(null);
  const pickForecastDay = (d: string) => {
    setHourFollowsDay(d);
    forecast.selectDay(d);
  };
  useEffect(() => {
    if (hourFollowsDay === null || forecast.busy || forecast.data?.date !== hourFollowsDay) return;
    const peak = forecastHour(forecast.data, null);
    if (peak != null) {
      setHourOfDay(peak);
      setClockMinuteOffset(0);
    }
    setHourFollowsDay(null);
  }, [hourFollowsDay, forecast.busy, forecast.data]);
  // What the road runs once a forecast is loaded: the chosen day at the chosen hour. Until then nothing is
  // overridden and the observed hourly profile drives it as before.
  const loadedForecast = forecastFollowing ? forecast.data : null;
  const forecastDay = loadedForecast?.date ?? null;
  // Its own values as dependencies: the hook keys the simulation rebuild on the mix, so a fresh object each render
  // would rebuild the road every render.
  const fleet = loadedForecast?.fleet ?? null;
  const forecastMix = useMemo(() => (fleet ? ({ 1: fleet.c1, 2: fleet.c2, 3: fleet.c3 } as const) : null), [fleet]);

  /** The lane reallocation in force (see the Lane reallocation section below); declared here because both
   *  carriageways' runs are built from it. */
  const [zipper, setZipper] = useState<ZipperState | null>(null);
  /* The incident forecast on the stretch on screen: the hour's corridor-wide count shared out to this stretch
     and each carriageway (scenarios/forecastIncidents.ts). Memoised on what it depends on, so the hooks see a
     stable object and draw only when the day, hour or stretch changes. */
  const forecastHourIncidents = forecastIncidentsAt(loadedForecast, hourOfDay);
  const forecastByExit = loadedForecast?.incidents.covered ? loadedForecast.incidents.byExit : null;
  const forecastIncidents = useMemo(() => {
    if (!loadedForecast || forecastHourIncidents == null || !forecastByExit) return null;
    const byExit = forecastByExit.map((e) => ({ km: e.km, perDay: e.perDay }));
    const of = (direction: Direction) => expectedOnStretch({ hourly: forecastHourIncidents, byExit, fromKm, toKm, direction });
    return { key: `${loadedForecast.date}|${hourOfDay ?? "peak"}`, expected: { NB: of("NB"), SB: of("SB") }, byExit, hourly: forecastHourIncidents };
  }, [loadedForecast, forecastHourIncidents, forecastByExit, hourOfDay, fromKm, toKm]);
  const sharedRoadInputs: SharedRoadInputs = {
    BACKEND, fromKm, toKm, segLengthM, EXITS, nearestExit, segmentLanes, hourOfDay, proposeHourOfDay, classProfile, resetSimAccumulator,
    forecastInflow: forecastInflowAt(loadedForecast, hourOfDay),
    forecastIncidents,
    forecastMix,
    reallocation: zipper,
  };
  // Called unconditionally, twice, regardless of `view` — an inactive direction's sim just is not
  // stepped or rendered below. Hooks cannot be called conditionally, and there is no need to: the
  // per-direction state is cheap to hold even when unused, and this is what keeps switching the
  // view instant (nothing to (re)build) rather than mount/unmount churn.
  const nb = useDirectionSim("NB", sharedRoadInputs);
  const sb = useDirectionSim("SB", sharedRoadInputs);
  /* How far each carriageway's plazas reach past its edge, in lanes. The docked
     canvas grows by that much rather than squeezing the lanes to make room —
     a plaza is worth drawing, but not at the price of the road beside it. */
  const facDepthNB = useMemo(() => nb.facilities.reduce((m, f) => Math.max(m, specDepth(f, nb.laneCount)), 0), [nb.facilities, nb.laneCount]);
  const facDepthSB = useMemo(() => sb.facilities.reduce((m, f) => Math.max(m, specDepth(f, sb.laneCount)), 0), [sb.facilities, sb.laneCount]);
  const facDepthOf = (d: Direction) => (d === "NB" ? facDepthNB : facDepthSB);
  const facBarrierOf = (d: Direction) => (d === "NB" ? nb : sb).facilities.some((f) => f.kind === "barrier");
  const byDirection: Record<Direction, DirectionApi> = { NB: nb, SB: sb };
  /** The carriageway the single-road things act on (see focusedDirection). NB-only/SB-only: this IS the (only) active direction. */
  const focused = byDirection[focusDirection];
  const both = view === "Both";
  /** A recording of the run now on the road, on a carriageway on screen: what the Replay button needs to be offered. */
  const replayAvailable = activeDirections.some((d) => replayRef.current[d].isOf(byDirection[d].simRef.current) && replayRef.current[d].length >= 2);

  /* ── Which carriageway a control or a click acts on ───────────────────────
   *
   * Placement is armed per direction (each direction owns its own placing flags and half-drawn
   * closure), but only ever ONE thing is armed at a time, on one direction. Arming anything first
   * disarms everything, so there is never an invisible armed state on the carriageway whose controls
   * are not on screen — and choosing a different focus while something is armed drops it, for the
   * same reason. */
  const [placeNote, setPlaceNote] = useState<string | null>(null);
  const disarmPlacing = () => {
    for (const d of [nb, sb]) {
      d.setPlacingIncident(false);
      d.setPlacingClosure(false);
    }
    setPlaceNote(null);
  };
  const chooseFocus = (d: Direction) => {
    if (d !== focusDirection) disarmPlacing();
    setFocusedDirection(d);
  };
  const armPlacing = (direction: Direction, kind: "incident" | "closure") => {
    const d = byDirection[direction];
    const wasOn = kind === "incident" ? d.placingIncident : d.placingClosure;
    disarmPlacing();
    if (wasOn) return;
    if (both) setFocusedDirection(direction);
    if (kind === "incident") d.setPlacingIncident(true);
    else d.setPlacingClosure(true);
  };
  const placingArmed = activeDirections.some((dn) => byDirection[dn].placingIncident || byDirection[dn].placingClosure);
  placingArmedRef.current = placingArmed;

  /* ── Lane reallocation ────────────────────────────────────────────────────
   *
   * Moves one lane from one carriageway to the other by changing both lane counts together — see
   * zipper.ts for what that models and what it does not. Both mode only. While a
   * scheme is on, the canvas draws the movable barrier and marks the borrowed lanes; the moment either lane
   * count stops matching what the scheme set (the Lanes slider, a new segment resetting to the corridor's
   * own count) the scheme is dropped, so the barrier is never drawn where it is not. */
  zipperRef.current = zipper;
  const laneCounts = { NB: nb.laneCount, SB: sb.laneCount };
  // The Lanes sliders stop at 5, the corridor's own range. A reallocation can take a carriageway to its limit
  // (recorded in ASSUMPTIONS.ZIPPER_LANES), so while one is on the sliders reach it — otherwise the thumb would
  // sit at 5 while the road has 6.
  const laneSliderMax = zipper === null ? 5 : Math.max(5, ASSUMPTIONS.ZIPPER_LANES.value.maxLanes);
  const laneSliderPct = (n: number) => `${((Math.min(n, laneSliderMax) - 2) / (laneSliderMax - 2)) * 100}%`;
  useEffect(() => {
    if (zipper !== null && !zipperHolds(zipper, { NB: nb.laneCount, SB: sb.laneCount })) setZipper(null);
  }, [zipper, nb.laneCount, sb.laneCount]);
  // Which stretch the reallocation covers. Off: what the operator has typed (or, untouched, a suggested stretch of the
  // recorded length). On: the simulated window itself — the engine cannot vary lanes along a road, so the stretch IS
  // the road it simulates (see zipper.ts).
  const [reallocFrom, setReallocFrom] = useState<number | null>(null);
  const [reallocTo, setReallocTo] = useState<number | null>(null);
  const [reallocError, setReallocError] = useState<string | null>(null);
  const windowBeforeRef = useRef<{ from: number | null; to: number | null; setFrom: number; setTo: number } | null>(null);
  const stretchLimits = { routeFromKm, routeToKm, minKm: MIN_SEG_M / 1000, maxKm: MAX_SEG_M / 1000 };
  const suggested = defaultStretch(fromKm, toKm, routeToKm, ASSUMPTIONS.ZIPPER_LANES.value.defaultStretchKm);
  const stretchNow = zipper !== null ? { fromKm, toKm } : { fromKm: reallocFrom ?? suggested.fromKm, toKm: reallocTo ?? suggested.toKm };
  const stretchPlan = planStretch(stretchNow.fromKm, stretchNow.toKm, stretchLimits);

  /** Undo the scheme: the lane counts come back, and so does the window it was set to — unless the operator has moved the window since. */
  const endReallocation = () => {
    if (zipper !== null) {
      nb.setLaneCount(zipper.base.NB);
      sb.setLaneCount(zipper.base.SB);
      const before = windowBeforeRef.current;
      if (before !== null && segFromKm === before.setFrom && segToKm === before.setTo) {
        setSegFromKm(before.from);
        setSegToKm(before.to);
      }
    }
    windowBeforeRef.current = null;
    setZipper(null);
    setReallocError(null);
  };
  /** Start (or change) the scheme over `at`, or the stretch in the control. Returns why it could not, or null. */
  const chooseZipper = (toward: Direction | null, lanes: number, at?: { fromKm: number; toKm: number }): string | null => {
    if (toward === null) {
      endReallocation();
      return null;
    }
    const plan = planZipper(zipper === null ? laneCounts : zipper.base, toward, lanes);
    if (!plan.ok) return plan.reason;
    const want = at ?? stretchNow;
    const stretch = planStretch(want.fromKm, want.toKm, stretchLimits);
    if (!stretch.ok) {
      setReallocError(stretch.reason);
      return stretch.reason;
    }
    setReallocError(null);
    if (zipper === null) windowBeforeRef.current = { from: segFromKm, to: segToKm, setFrom: stretch.fromKm, setTo: stretch.toKm };
    setSegFromKm(stretch.fromKm);
    setSegToKm(stretch.toKm);
    nb.setLaneCount(plan.counts.NB);
    sb.setLaneCount(plan.counts.SB);
    setZipper(plan.state);
    return null;
  };
  /** One end of the stretch was edited. Off it is only an entry; on it moves the simulated window. */
  const editStretch = (which: "from" | "to", km: number) => {
    const next = which === "from" ? { from: km, to: stretchNow.toKm } : { from: stretchNow.fromKm, to: km };
    if (zipper === null) {
      setReallocFrom(next.from);
      setReallocTo(next.to);
      setReallocError(null);
      return;
    }
    const plan = planStretch(next.from, next.to, stretchLimits);
    if (!plan.ok) {
      setReallocError(plan.reason);
      return;
    }
    setReallocError(null);
    setSegFromKm(plan.fromKm);
    setSegToKm(plan.toKm);
    if (windowBeforeRef.current !== null) windowBeforeRef.current = { ...windowBeforeRef.current, setFrom: plan.fromKm, setTo: plan.toKm };
  };

  /* ── Confidence run ──────────────────────────────────────────────────────
   *
   * The animation is one seed. Any number an operator is going to act on
   * needs to say how much of it is the intervention and how much is this
   * particular set of drivers, so the same scenario is re-run on independent
   * seeds and reported as a mean with a 95% interval.
   *
   * Driven through the generator rather than called outright: ten runs is
   * tens of millions of integration steps and would lock the tab solid. The
   * pump below yields to the browser between simulated seconds.
   *
   * Runs against the single active direction — replicate() takes one static
   * Interventions snapshot and cannot follow a timed event OR two carriageways
   * at once, so Both mode disables it outright (with a message) rather than
   * running one road and letting the operator think it covered both. */
  const [repRuns, setRepRuns] = useState(10);
  const [repResult, setRepResult] = useState<ReplicationResult | null>(null);
  const [repProgress, setRepProgress] = useState<number | null>(null);
  const repCancel = useRef(false);
  /* Which carriageway and set-up a result was run on, and whether a run was cut short by an event (17 Oct 2026,
     testers SB-16.3). The block on timed events was there, but only as a disabled button and a line that Both mode,
     the view the tab opens on, replaced with its own; an event added mid-run let the run finish on the set-up from
     before it (and disabled its Stop button); and a result from before an event stayed on screen unlabelled. */
  const [repFor, setRepFor] = useState<{ direction: Direction; setup: string } | null>(null);
  const [repStopped, setRepStopped] = useState(false);

  /* ── Reset ─────────────────────────────────────────────────────────────────
   *
   * Everything goes back, the scenarios with it: both carriageways are reset (events, hand-set controls,
   * baseline, clock — see resetAll), a lane reallocation is undone (the lane counts it changed are put back),
   * a command proposal and an old confidence result are dropped, and the Add-event form is remounted so it is
   * back on its defaults. The route, the Lanes / Inflow sliders and the view are the setup and stay. */
  const [scenarioFormKey, setScenarioFormKey] = useState(0);
  const resetEverything = () => {
    endReallocation();
    setReallocFrom(null);
    setReallocTo(null);
    nb.resetAll();
    sb.resetAll();
    disarmPlacing();
    setPlan(null);
    setCommandError(null);
    setRepResult(null);
    setScenarioFormKey((k) => k + 1);
    // Recorded frames belong to the sim instance that just got replaced —
    // scrubbing into them after a reset would show vehicles from a run that
    // no longer exists.
    replayRef.current.NB.clear();
    replayRef.current.SB.clear();
    setReplayIndex(null);
    setReplayLen(0);
    setReplayHasEvent(false);
  };

  const runReplications = useCallback(() => {
    // replicate() runs one static Interventions snapshot on one carriageway: it cannot follow a timed
    // event, and it cannot run two roads at once (Both mode disables it outright — Phase D4.6).
    if (both) return;
    if (focused.scenarioEvents.length > 0) return;
    if (repProgress != null) { repCancel.current = true; return; }
    repCancel.current = false;
    setRepResult(null);
    setRepStopped(false);
    setRepFor({ direction: focusDirection, setup: focused.anyIntervention ? focused.interventionSummary : "a clear road" });
    setRepProgress(0);
    const gen = replicate(
      {
        length: segLengthM,
        laneCount: focused.laneCount,
        inflowVehPerHour: focused.inflow,
        classProfile: classProfile,
        ramps: focused.ramps,
        facilities: focused.facilities,
        warmupS: WARMUP_S,
      },
      // The interventions AS CURRENTLY SET, not a clean road: the operator is
      // asking about the scenario in front of them.
      {
        closedLanes: [...focused.closedLanes],
        closurePoint: focused.manualControls.closurePoint,
        closureEnd: focused.manualControls.closureEnd,
        incidents: focused.simRef.current ? [...focused.simRef.current.interventions.incidents] : [],
        speedLimitKmh: focused.speedLimit,
        speedZone: [focused.manualControls.speedZone[0], focused.manualControls.speedZone[1]],
      },
      { runs: repRuns, secondsPerRun: 300 },
    );
    const pump = () => {
      if (repCancel.current) { setRepProgress(null); return; }
      const t0 = performance.now();
      // Work in ~25 ms slices so the animation keeps its frame budget.
      while (performance.now() - t0 < 25) {
        const step = gen.next();
        if (step.done) {
          setRepResult(step.value);
          setRepProgress(null);
          return;
        }
        setRepProgress(step.value.done / step.value.total);
      }
      setTimeout(pump, 0);
    };
    setTimeout(pump, 0);
  }, [both, repProgress, repRuns, segLengthM, classProfile, focused, focusDirection]);

  // An event added (or Both chosen) while a run is going: the run was set up without it, so it stops rather than
  // finish and be read as the scenario's. Its Stop button is disabled from that moment, so it could not be stopped by hand.
  const repEvents = activeDirections.flatMap((dn) => byDirection[dn].scenarioEvents);
  const repBlocked = both || focused.scenarioEvents.length > 0;
  useEffect(() => {
    if (repBlocked && repProgress != null) {
      repCancel.current = true;
      setRepStopped(true);
    }
  }, [repBlocked, repProgress]);

  // What the canvas draws for each direction's scenario events: kept in a ref (the render loop runs
  // outside React) and refreshed whenever either direction's own events/binding change — mirrors the
  // single-sim page's old scenarioOverlayRef assignment, just done once per direction instead of once.
  useEffect(() => {
    scenarioOverlayRef.current.NB = {
      events: nb.scenarioEvents, frame: nb.scenarioFrame, owners: nb.owners, isScenarioIncident: nb.scenarioBinding.isScenarioIncident,
      sky: { events: sb.scenarioEvents, frame: sb.scenarioFrame },
    };
  }, [nb.scenarioEvents, nb.scenarioFrame, nb.owners, nb.scenarioBinding, sb.scenarioEvents, sb.scenarioFrame]);
  useEffect(() => {
    scenarioOverlayRef.current.SB = {
      events: sb.scenarioEvents, frame: sb.scenarioFrame, owners: sb.owners, isScenarioIncident: sb.scenarioBinding.isScenarioIncident,
      sky: { events: nb.scenarioEvents, frame: nb.scenarioFrame },
    };
  }, [sb.scenarioEvents, sb.scenarioFrame, sb.owners, sb.scenarioBinding, nb.scenarioEvents, nb.scenarioFrame]);

  // Animation + physics loop: steps every ACTIVE direction's sim in the same tick, in the same
  // ~25ms-equivalent-per-frame slice budget the single-sim loop always used (there is no separate
  // budget per direction — Both mode's two steps share the one frame, which is the whole point of
  // the Phase D1 performance estimate and the D2.5/D2.6 measurement below).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Drawn after the road, so the bubble sits over the traffic, scenes and weather. While an incident or
    // closure is armed the click belongs to placement, so hovering shows nothing and the cursor stays a crosshair.
    const paintVehicleProbe = () => {
      const armed = placingArmedRef.current;
      const pointer = armed ? null : pointerRef.current;
      // An event's label sits over the traffic, so the pointer on one means the label (its full text), not the car under it.
      const label = pointer ? labelAt(pointer.x, pointer.y) : null;
      const r = drawVehicleProbes(ctx, roadW(canvas.clientWidth), canvas.clientHeight, label ? null : pointer, pinnedVehicleRef.current);
      if (label) drawLabelProbe(ctx, roadW(canvas.clientWidth), label);
      // A pinned vehicle that has left the road (or whose sim was rebuilt) is no longer there to point at.
      if (pinnedVehicleRef.current && !r.pinnedFound) pinnedVehicleRef.current = null;
      const cursor = r.hovering && !armed ? "pointer" : "";
      if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
    };

    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);
      const dtReal = Math.min(0.1, (now - (lastFrameRef.current || now)) / 1000);
      lastFrameRef.current = now;
      if (running) animClockRef.current += dtReal;

      // The accumulator is shared across directions deliberately: both sims advance sim time at the
      // same simSpeed from the same real dtReal, so one accumulator drives both step loops in lockstep
      // rather than two independently-drifting ones.
      if (running) {
        simAccRef.current += dtReal * simSpeed;
        let guard = 0;
        while (simAccRef.current >= SIM_DT && guard < 3 / SIM_DT) {
          stepSeqRef.current++;
          for (const direction of activeDirections) {
            const d = byDirection[direction];
            const sim = d.simRef.current;
            // A skip-in-progress on THIS direction owns its own stepping (stepToScenarioTime, inside
            // useDirectionSim's skipToNextPhase) — the rAF loop must not also step it, or the two
            // would race for the same sim. The other direction (if also active) is unaffected and
            // steps normally here, which is exactly what "skip is per direction" requires.
            if (!sim || d.skipRef.current !== null) continue;
            const stepStart = performance.now();
            sim.step(SIM_DT);
            // The same run without the scenario events (the before/after's "No events" side), one step behind at most.
            // Inside the timing: while it exists a skip costs both, so its estimate should too.
            d.twinRef.current?.stepAlong();
            const stepMs = performance.now() - stepStart;
            const prevCost = stepCostRef.current[direction];
            stepCostRef.current[direction] = prevCost === null ? stepMs : prevCost + (stepMs - prevCost) * 0.02;
            // Recorded for review. Throttled inside the buffer, so calling it
            // every step costs a comparison on most of them.
            replayRef.current[direction].record(sim, stepSeqRef.current);
            // And the readouts over time, for the Trends charts: one comparison per step until a sample is due.
            d.trend.record(sim, d.scenarioFrame.warmupS);
            const sctx = d.scenarioCtxRef.current;
            if (sctx) {
              const r = applyAtBoundary(d.scenarioBinding, sim, sctx.controls, sctx.events, sctx.frame, d.scenarioDueRef.current);
              d.scenarioDueRef.current = r.dueS;
              if (r.composition !== null) d.publishOwners(r.composition.owners);
            }
          }
          simAccRef.current -= SIM_DT;
          guard++;
        }
        if (guard >= 60) simAccRef.current = 0; // don't spiral if a frame stalls
        metricAccRef.current += dtReal;
        if (metricAccRef.current >= 0.25) {
          metricAccRef.current = 0;
          setReplayLen(replayRef.current[focusDirection].length);
          // Either carriageway on screen: Both mode reviews the two together, so an incident on the other one counts.
          setReplayHasEvent(activeDirections.some((d) => replayRef.current[d].lastEventIndex() !== null));
          for (const direction of activeDirections) {
            const sim = byDirection[direction].simRef.current;
            if (sim) byDirection[direction].setMetrics(sim.metrics());
          }
        }
      }
      /* Under review, the canvas is handed recorded frames dressed as sims
         rather than the live ones. The engine keeps running underneath —
         nothing here reaches back into it — so letting go returns to a
         simulation that has carried on, not one frozen at the rewind point.
         The slider walks one carriageway's recording (replayLead); any other
         carriageway drawn is the frame taken at the same step. Null: draw the
         live run (not reviewing, or nothing recorded for that moment). Under
         review the plazas come from the recording too, on the live geometry. */
      const reviewed = (d: Direction) => {
        const ri = replayIndexRef.current;
        const live = byDirection[d].simRef.current;
        if (ri === null || !live) return null;
        const leadFrame = replayRef.current[replayLeadRef.current].frame(ri);
        if (!leadFrame) return null;
        const buf = replayRef.current[d];
        let idx = ri;
        if (d !== replayLeadRef.current) {
          // Only a frame of this run taken within half a second of the lead's (a carriageway that was not on screen
          // then, or has been rebuilt since, has nothing for that moment).
          idx = leadFrame.seq === undefined || !buf.isOf(live) ? -1 : buf.indexAtSeq(leadFrame.seq);
          if (idx >= 0 && Math.abs((buf.frame(idx)?.seq ?? Infinity) - (leadFrame.seq ?? 0)) * SIM_DT > 0.5) idx = -1;
        }
        const shown = idx < 0 ? null : buf.asSimLike(idx, live.cfg);
        if (!shown) return null;
        return { sim: shown, fac: live.fac.list.length > 0 ? buf.facilityViewAt(idx, live.fac.list) : null };
      };
      const reviewing = replayIndexRef.current !== null;
      // Both mode draws both carriageways in one canvas (Phase D3); NB-only/SB-only draw the one
      // active direction full-height, exactly as before D3.
      if (view === "Both") {
        const simNB = nb.simRef.current;
        const simSB = sb.simRef.current;
        if (simNB && simSB) {
          const recNB = reviewed("NB");
          const recSB = reviewed("SB");
          const shownNB = (recNB?.sim ?? simNB) as typeof simNB;
          const shownSB = (recSB?.sim ?? simSB) as typeof simSB;
          const minutesNow = clockStartMinRef.current + (shownNB.time - WARMUP_S) / 60;
          const dayFraction = daylightFraction(minutesNow);
          const asphaltColor = daylightAsphalt(minutesNow);
          const alpha = reviewing ? 0 : running ? simAccRef.current : 0;
          renderBoth(
            ctx, canvas, shownNB, shownSB,
            { fromKm: marksRef.current.fromKm, toKm: marksRef.current.toKm },
            maxLaneRef.current, exitsRef.current,
            scenarioOverlayRef.current.NB ?? null, scenarioOverlayRef.current.SB ?? null,
            animClockRef.current, zipperRef.current, dayFraction, asphaltColor,
            // Whatever is left in the accumulator is a fraction of a step the
            // engine has not applied yet; drawing it keeps the traffic moving
            // on frames where no step ran.
            alpha,
            recNB ? recNB.fac : simNB.fac.list.length > 0 ? facilityView(simNB.fac, simNB.facilityStats(), alpha) : null,
            recSB ? recSB.fac : simSB.fac.list.length > 0 ? facilityView(simSB.fac, simSB.facilityStats(), alpha) : null,
            facilityHighlightRef.current,
          );
          paintVehicleProbe();
          if (dropGhostRef.current) drawDropGhost(ctx, roadW(canvas.clientWidth), { ...dropGhostRef.current, x: roadX(dropGhostRef.current.x) });
        }
      } else {
        const liveSim = byDirection[focusDirection].simRef.current;
        const rec = reviewed(focusDirection);
        const focusedSim = rec?.sim ?? liveSim;
        if (focusedSim && liveSim) {
          const minutesNow = clockStartMinRef.current + (focusedSim.time - WARMUP_S) / 60;
          const dayFraction = daylightFraction(minutesNow);
          const asphaltColor = daylightAsphalt(minutesNow);
          const alpha = reviewing ? 0 : running ? simAccRef.current : 0;
          const facView = rec ? rec.fac : liveSim.fac.list.length > 0 ? facilityView(liveSim.fac, liveSim.facilityStats(), alpha) : null;
          render(ctx, canvas, focusedSim as NonNullable<typeof liveSim>, locationRef.current, marksRef.current, maxLaneRef.current, exitsRef.current, scenarioOverlayRef.current[focusDirection] ?? null, animClockRef.current, dayFraction, asphaltColor, alpha, facView, facilityHighlightRef.current);
          paintVehicleProbe();
          if (dropGhostRef.current) drawDropGhost(ctx, roadW(canvas.clientWidth), { ...dropGhostRef.current, x: roadX(dropGhostRef.current.x) });
        }
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, simSpeed, activeDirections.join(), view, focusDirection, nb.simRef, sb.simRef, nb.scenarioBinding, sb.scenarioBinding, nb.publishOwners, sb.publishOwners, nb.setMetrics, sb.setMetrics]);

  // A run rebuilt while reviewing (a new hour, lane count or window, all allowed while paused) leaves the recording
  // describing a road that is no longer there, drawn on the new one's geometry: back to live instead.
  useEffect(() => {
    if (replayIndex !== null && !replayRef.current[replayLead].isOf(byDirection[replayLead].simRef.current)) setReplayIndex(null);
  });

  // Clicking a vehicle pins its speed bubble to it (it follows the vehicle until the same one, or empty
  // road, is clicked). Only reached when nothing is armed — an armed click belongs to placement below.
  const pinVehicleAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const hit = vehicleAt(roadX(e.clientX - rect.left), e.clientY - rect.top);
    const cur = pinnedVehicleRef.current;
    pinnedVehicleRef.current =
      hit === null || (cur !== null && cur.id === hit.id && cur.dir === hit.dir && cur.born === hit.born)
        ? null
        : { id: hit.id, dir: hit.dir, born: hit.born };
  };

  // The render loop hit-tests this every frame, so a vehicle drifting under a still cursor is followed.
  const trackPointer = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    pointerRef.current = { x: roadX(e.clientX - rect.left), y: e.clientY - rect.top };
  };

  /* Incident placement and closure drawing: arm a mode from a control, then click the road.
   *
   * In NB-only/SB-only the click acts on the one carriageway there is. In Both mode it acts on the
   * carriageway that was CLICKED, and moves focus there (so the controls beside the road follow the
   * hand): armed on NB, click SB, and the incident lands on SB. A click that maps to no carriageway
   * at all — the median, the km axis, the ramp gutters, the padding — is refused with a line saying
   * so, rather than being snapped to the nearest lane.
   *
   * The one exception is the SECOND click of a closure: the stretch belongs to the carriageway its
   * first click was on, and the second click only supplies the end km, which is the same km on either
   * carriageway (they share one axis) — so it completes the stretch wherever on either road it lands,
   * instead of throwing away the start because the end went over the median-side lane. */
  /* Where a click lands, as an event place: a lane and km on either
     carriageway, or a booth, pump or ramp of a plaza or service area. The
     inverse of the drawing — the road at the road's scale, the gutter at its
     own (gutterLanePx) — so the place clicked is the place drawn there. */
  const resolvePick = (e: { clientX: number; clientY: number }, want: Direction | null): PickResult | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const cssW = roadW(rect.width);
    const cssH = rect.height;
    const cx = roadX(e.clientX - rect.left);
    const cy = e.clientY - rect.top;
    type Geo = { dir: Direction; roadTop: number; roadH: number; laneH: number; gutterPx: number; gutter: number; reverse: boolean; laneTop?: (lane: number) => number };
    const geos: Geo[] = [];
    if (both) {
      const simNB = nb.simRef.current;
      const simSB = sb.simRef.current;
      if (!simNB || !simSB) return null;
      // The road as renderBoth draws it: sized from the built lanes, lent lanes on the other carriageway.
      const held = heldZipper(zipperRef.current, simNB.cfg.laneCount, simSB.cfg.laneCount);
      const built = builtLanes(held, simNB.cfg.laneCount, simSB.cfg.laneCount);
      const L = dualRoadLayout({
        cssW, cssH, lanesNB: built.NB, lanesSB: built.SB, segLenM: simNB.cfg.length,
        exitCount: exitsRef.current.length, maxLaneH: maxLaneRef.current,
        facDepthNB: facilityDepth(simNB.fac.list), facDepthSB: facilityDepth(simSB.fac.list),
        facBarrierNB: hasBarrier(simNB.fac.list), facBarrierSB: hasBarrier(simSB.fac.list),
      });
      const engine = { NB: simNB.cfg.laneCount, SB: simSB.cfg.laneCount };
      const dl = dualLanes(L, engine, held);
      // A lent lane is a lane of the carriageway using it, wherever it is drawn.
      const hit = dualLaneAt(dl, engine, L.laneH, cy);
      if (hit !== null && hit.lane < dl[hit.dir].lent) {
        if (want !== null && hit.dir !== want) return null;
        const simL = byDirection[hit.dir].simRef.current;
        if (!simL) return null;
        const alongL = hit.dir === "SB" ? 1 - cx / cssW : cx / cssW;
        const uL = Math.max(0, Math.min(simL.cfg.length, alongL * simL.cfg.length));
        return { direction: hit.dir, km: byDirection[hit.dir].kmAt(uL), lane: engineIndexToOperatorLane(hit.lane, simL.cfg.laneCount), site: null };
      }
      geos.push({ dir: "NB", roadTop: dl.NB.roadTop, roadH: dl.NB.roadH, laneH: L.laneH, gutterPx: L.gutterPxNB, gutter: L.gutterNB, reverse: false, laneTop: dl.NB.laneTop });
      geos.push({ dir: "SB", roadTop: dl.SB.roadTop, roadH: dl.SB.roadH, laneH: L.laneH, gutterPx: L.gutterPxSB, gutter: L.gutterSB, reverse: true, laneTop: dl.SB.laneTop });
    } else {
      const sim0 = byDirection[focusDirection].simRef.current;
      if (!sim0) return null;
      const L = roadLayout({
        cssW, cssH, lanes: sim0.cfg.laneCount, segLenM: sim0.cfg.length, exitCount: exitsRef.current.length,
        maxLaneH: maxLaneRef.current, rampsAbove: false,
        facDepth: facilityDepth(sim0.fac.list), facBarrier: hasBarrier(sim0.fac.list),
      });
      geos.push({ dir: focusDirection, roadTop: L.roadTop, roadH: L.roadH, laneH: L.laneH, gutterPx: L.gutterPx, gutter: L.rampGutter, reverse: false });
    }
    // The carriageway (with its gutter) the click is on.
    const g = geos.find((q) => {
      const lo = q.reverse ? q.roadTop - q.gutter : q.roadTop;
      const hi = q.reverse ? q.roadTop + q.roadH : q.roadTop + q.roadH + q.gutter;
      return cy >= lo && cy <= hi;
    });
    if (!g || (want !== null && g.dir !== want)) return null;
    const sim = byDirection[g.dir].simRef.current;
    if (!sim) return null;
    const lanes = sim.cfg.laneCount;
    const along = g.dir === "SB" ? 1 - cx / cssW : cx / cssW;
    const u = Math.max(0, Math.min(sim.cfg.length, along * sim.cfg.length));
    const km = byDirection[g.dir].kmAt(u);
    // Across: lane units outward from the outer lane's centre.
    const out = g.reverse ? -1 : 1;
    const outerCentreY = (g.laneTop ? g.laneTop(lanes - 1) : laneSlotTop(lanes - 1, g.roadTop, g.laneH, lanes, g.reverse)) + g.laneH / 2;
    const edgeY = g.reverse ? g.roadTop : g.roadTop + g.roadH;
    const dOut = (cy - outerCentreY) * out;
    const w = dOut <= 0.5 * g.laneH ? dOut / g.laneH : 0.5 + ((cy - edgeY) * out) / Math.max(1, g.gutterPx);
    for (const f of sim.fac.list) {
      if (u < f.u0 - 4 || u > f.u1 + 4) continue;
      const onRoad = w <= 0.5;
      if (onRoad && !f.laneEntries) continue; // a ramp plaza is off the road; a barrier is on it
      if (!onRoad && w > f.wMax + 0.3) continue;
      const stations = f.stations;
      const name = f.spec.name;
      if (stations.length === 0) return { direction: g.dir, km, lane: null, site: { facilityId: f.spec.id, facilityName: name, kind: "approach", stations: [] } };
      const stopU = stations[0].u;
      // Upstream of the booths' queuing area is the approach; anywhere else, the nearest booth or pump across.
      if (u < stopU - 70) return { direction: g.dir, km, lane: null, site: { facilityId: f.spec.id, facilityName: name, kind: "approach", stations: [] } };
      let best = stations[0];
      for (const st of stations) if (Math.abs(st.w - w) < Math.abs(best.w - w)) best = st;
      return { direction: g.dir, km, lane: null, site: { facilityId: f.spec.id, facilityName: name, kind: best.kind, stations: [best.index] } };
    }
    if (w > 0.5) return null; // the verge, not a place
    const laneFloat = lanes - 1 + w;
    const engineLane = Math.max(0, Math.min(lanes - 1, Math.round(laneFloat)));
    return { direction: g.dir, km, lane: engineIndexToOperatorLane(engineLane, lanes), site: null };
  };

  /* ── Zoom ──────────────────────────────────────────────────────────────────────────────────────────────
     Vehicles are their true size, so the road is zoomed to see them large (roadView). The wheel zooms about the
     cursor in full screen, or anywhere with Ctrl held (docked, a plain wheel still scrolls the page); a drag
     pans; the toolbar has −, + and Whole road; an event's "Zoom to" goes to it. It goes back to the whole
     window whenever the window or the view changes: a zoom is a look at this stretch, not a setting. (Opening
     zoomed in was tried on 2026-10-14 and dropped: the operator wants the whole window, with taller vehicles.) */
  const [zoom, setZoom] = useState(1);
  const maxZoomNow = () => {
    const w = canvasRef.current?.clientWidth ?? 0;
    return w > 0 ? Math.max(1, (MAX_PX_PER_M * segLengthM) / w) : 1;
  };
  /** Zoom to `z`, keeping the road under screen x `anchor` (CSS px on the canvas; its middle when null) where it is. */
  const zoomAt = (z: number, anchor: number | null) => {
    const w = canvasRef.current?.clientWidth ?? 0;
    if (w <= 0) return;
    const nz = Math.max(1, Math.min(maxZoomNow(), z));
    const a = anchor ?? w / 2;
    roadView.pan = Math.max(0, Math.min(w * nz - w, (roadView.pan + a) * (nz / roadView.zoom) - a));
    roadView.zoom = nz;
    setZoom(nz);
  };
  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt;
  /** Onto a km of the window, with about 180 m of road across the screen (or as close as the zoom allows). */
  const zoomToKm = (km: number) => {
    const w = canvasRef.current?.clientWidth ?? 0;
    if (w <= 0 || toKm <= fromKm) return;
    const nz = Math.max(1, Math.min(maxZoomNow(), segLengthM / 180));
    roadView.zoom = nz;
    // Low km is on the left for both carriageways (southbound is drawn mirrored), so one mapping serves both.
    roadView.pan = Math.max(0, Math.min(w * nz - w, ((km - fromKm) / (toKm - fromKm)) * w * nz - w / 2));
    setZoom(nz);
  };
  useEffect(() => {
    roadView.zoom = 1;
    roadView.pan = 0;
    setZoom(1);
    return () => {
      roadView.zoom = 1;
      roadView.pan = 0;
    };
  }, [fromKm, toKm, view, segLengthM]);
  // The wheel, as a real listener: React's is passive, and a zoom must stop the page scrolling under it.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const zooming = expanded || e.ctrlKey || e.metaKey;
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      if (roadView.zoom > 1 && sideways) {
        e.preventDefault();
        const w = canvas.clientWidth;
        roadView.pan = Math.max(0, Math.min(w * roadView.zoom - w, roadView.pan + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY)));
        return;
      }
      if (!zooming) return;
      e.preventDefault();
      zoomAtRef.current(roadView.zoom * Math.exp(-e.deltaY * 0.0016), e.clientX - canvas.getBoundingClientRect().left);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [expanded]);
  /** A drag on the zoomed road pans it. One that moved is not also a click (it would pin a vehicle or place an incident). */
  const panDraggedRef = useRef(false);
  const startPan = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || roadView.zoom <= 1) return;
    const canvas = e.currentTarget;
    const from = { x: e.clientX, pan: roadView.pan };
    let moved = false;
    const move = (m: MouseEvent) => {
      const dx = m.clientX - from.x;
      if (!moved && Math.abs(dx) < 5) return;
      moved = true;
        const w = canvas.clientWidth;
      roadView.pan = Math.max(0, Math.min(w * roadView.zoom - w, from.pan - dx));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (moved) panDraggedRef.current = true;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (panDraggedRef.current) {
      panDraggedRef.current = false;
      return;
    }
    const armed = activeDirections.find((dn) => byDirection[dn].placingIncident || byDirection[dn].placingClosure);
    if (armed === undefined) {
      pinVehicleAt(e);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Invert the same geometry the renderer uses to map the click back to
    // (carriageway, lane, x-in-metres). Keep these formulas in sync with render()/renderBoth().
    const rect = canvas.getBoundingClientRect();
    const cssW = roadW(rect.width);
    const cssH = rect.height;
    const cx = roadX(e.clientX - rect.left);
    const cy = e.clientY - rect.top;

    let target: Direction;
    let laneH: number;
    let roadTop: number;
    // Under a reallocation, the lane read off the drawn geometry (lent lanes sit on the other carriageway).
    let drawnLane: number | null = null;
    if (both) {
      const simNB = nb.simRef.current;
      const simSB = sb.simRef.current;
      if (!simNB || !simSB) return;
      const held = heldZipper(zipperRef.current, simNB.cfg.laneCount, simSB.cfg.laneCount);
      const built = builtLanes(held, simNB.cfg.laneCount, simSB.cfg.laneCount);
      const layout = dualRoadLayout({
        cssW,
        cssH,
        lanesNB: built.NB,
        lanesSB: built.SB,
        segLenM: simNB.cfg.length,
        exitCount: exitsRef.current.length,
        maxLaneH: maxLaneRef.current,
        facDepthNB: facilityDepth(simNB.fac.list),
        facDepthSB: facilityDepth(simSB.fac.list),
        facBarrierNB: hasBarrier(simNB.fac.list),
        facBarrierSB: hasBarrier(simSB.fac.list),
      });
      const inNB = cy >= layout.nbRoadTop && cy <= layout.nbRoadTop + layout.nbRoadH;
      const inSB = cy >= layout.sbRoadTop && cy <= layout.sbRoadTop + layout.sbRoadH;
      if (!inNB && !inSB) {
        setPlaceNote("That is the median, the km axis or the verge — click a lane on either carriageway.");
        return;
      }
      const drafting = byDirection[armed].placingClosure && byDirection[armed].closureDraftKm != null;
      target = drafting ? armed : inNB ? "NB" : "SB";
      laneH = layout.laneH;
      roadTop = target === "NB" ? layout.nbRoadTop : layout.sbRoadTop;
      if (held !== null) {
        const engine = { NB: simNB.cfg.laneCount, SB: simSB.cfg.laneCount };
        const hit = dualLaneAt(dualLanes(layout, engine, held), engine, layout.laneH, cy);
        if (hit !== null) {
          if (!drafting) target = hit.dir;
          if (hit.dir === target) drawnLane = hit.lane;
        }
      }
    } else {
      target = armed;
      const sim0 = byDirection[target].simRef.current;
      if (!sim0) return;
      // Same geometry render() used for this frame, or a click maps to a
      // different lane than the one under the cursor. The ramp gutter is part of
      // that geometry: reserving it moves the road up, and a handler that did not
      // know would place incidents one lane low wherever a junction is in view.
      // roadTop comes from the shared helper too, so there is no copy of the
      // vertical placement left to drift out of step with the renderer.
      const single = roadLayout({
        cssW,
        cssH,
        lanes: sim0.cfg.laneCount,
        segLenM: sim0.cfg.length,
        exitCount: exitsRef.current.length,
        maxLaneH: maxLaneRef.current,
        rampsAbove: false,
        facDepth: facilityDepth(sim0.fac.list),
        facBarrier: hasBarrier(sim0.fac.list),
      });
      laneH = single.laneH;
      roadTop = single.roadTop;
    }

    const td = byDirection[target];
    const sim = td.simRef.current;
    if (!sim) return;
    const L = sim.cfg.length;
    const lanes = sim.cfg.laneCount;
    // The drawn slot (0 at roadTop, downward) is the engine lane index UNLESS this is Both mode's
    // SB carriageway, which draws lane 0 at the BOTTOM of its block (laneSlotTop's reverseLanes) —
    // same inversion the renderer applies, read backwards.
    // Under a reallocation the lane was read off the drawn geometry; it goes back through the same inversion.
    const drawnSlot = drawnLane !== null
      ? (both && target === "SB" ? lanes - 1 - drawnLane : drawnLane)
      : Math.max(0, Math.min(lanes - 1, Math.floor((cy - roadTop) / laneH)));
    const lane = both && target === "SB" ? lanes - 1 - drawnSlot : drawnSlot;
    const alongFrac = target === "SB" ? 1 - cx / cssW : cx / cssW;
    const x = Math.max(0, Math.min(L, alongFrac * L));
    setPlaceNote(null);

    if (byDirection[armed].placingClosure) {
      // Two clicks mark the stretch an operator actually closes — "Km 20.20 to
      // 20.30" — in either order. One click used to move only the start, so the
      // works always ran on to the end of the span. The click snaps to a round
      // official km post (what the readout prints) and is kept as measured km.
      const km = kmMeasured(Number(kmPost(td.kmAt(x)).toFixed(2)));
      if (td.closureDraftKm == null) {
        // First click: the stretch is on THIS carriageway. If the mode was armed on the other one,
        // hand it over (its own half-drawn state is cleared by the leave-placing effect below).
        if (target !== armed) {
          byDirection[armed].setPlacingClosure(false);
          td.setPlacingClosure(true);
        }
        if (both && target !== focusDirection) setFocusedDirection(target);
        td.setClosureDraftKm(km);
        sim.interventions.closureDraft = { from: x, to: x };
        return;
      }
      const a = Math.min(td.closureDraftKm, km);
      const b = Math.max(Math.max(td.closureDraftKm, km), Math.min(toKm, a + 0.01));
      td.setClosureKm(a);
      td.setClosureEndKm(b);
      td.setPlacingClosure(false);
      return;
    }
    td.placeIncident(lane, x);
    disarmPlacing(); // one accident per click; re-arm to drop another
    if (both && target !== focusDirection) setFocusedDirection(target);
  };

  /* A scenario chip dragged over the road: where it would land, as the marker the frame loop draws. A drop
     hands that place to the panel (scenarioDropRef), which adds the event there or says why it cannot. */
  const dropTextOf = (family: FamilyKey, at: PickResult | null): DropGhost["text"] => {
    const name = getTemplate(family).displayName;
    if (at === null) return { ok: false, line: `${name}: drop it on a lane, a booth or a pump` };
    if (at.site !== null) {
      if (!SITE_FAMILIES.has(family)) return { ok: false, line: `${name} happens on a lane, not at ${at.site.facilityName}` };
      const where = at.site.kind === "approach" ? "on the ramp" : `${at.site.kind} ${at.site.stations.map((i) => i + 1).join(", ")}`;
      return { ok: true, line: `${name} → ${at.site.facilityName} · ${where}` };
    }
    // A shoulder breakdown pulls off from the lane next to the shoulder (the outermost, the highest-numbered); it
    // cannot be dropped on a middle or inner lane, so the marker says so over those and the drop is refused
    // (2026-10-27: it showed "Breakdown on the shoulder → Lane 3" over a centre lane and placed it there).
    if (family === "breakdown_shoulder" && at.lane != null) {
      const outer = byDirection[at.direction].laneCount;
      if (at.lane !== outer) {
        return { ok: false, line: `${name} can't be dropped on Lane ${at.lane}: use Lane ${outer}, next to the shoulder` };
      }
    }
    return { ok: true, line: `${name} → ${DIRECTION_NAME[at.direction]}${at.lane != null ? ` · Lane ${at.lane}` : ""} · Km ${fmtKm(at.km, 2)}` };
  };
  const dragOverRoad = (e: React.DragEvent<HTMLCanvasElement>) => {
    if (!e.dataTransfer.types.includes(SCENARIO_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const family = draggedFamilyRef.current;
    const canvas = canvasRef.current;
    if (!family || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    dropGhostRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, text: dropTextOf(family, resolvePick(e, null)) };
  };
  const dropOnRoad = (e: React.DragEvent<HTMLCanvasElement>) => {
    const family = e.dataTransfer.getData(SCENARIO_DRAG_TYPE) as FamilyKey;
    if (!family) return;
    e.preventDefault();
    dropGhostRef.current = null;
    setDraggedFamily(null);
    const at = resolvePick(e, null);
    const ghost = dropTextOf(family, at);
    if (at === null || !ghost.ok) {
      setPlaceNote(`${ghost.line}.`);
      return;
    }
    const why = scenarioDropRef.current ? scenarioDropRef.current(family, at) : "Open Scenario events to place one.";
    setPlaceNote(why);
  };

  // Follow the cursor after the first click so the stretch is seen before it is set.
  const previewClosureAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drafting = activeDirections.find((dn) => byDirection[dn].placingClosure && byDirection[dn].closureDraftKm != null);
    if (drafting === undefined) return;
    const d = byDirection[drafting];
    const sim = d.simRef.current;
    const canvas = canvasRef.current;
    if (!sim || !canvas || d.closureDraftKm == null) return;
    const rect = canvas.getBoundingClientRect();
    const L = sim.cfg.length;
    const frac = roadX(e.clientX - rect.left) / roadW(rect.width);
    const x = Math.max(0, Math.min(L, (drafting === "SB" ? 1 - frac : frac) * L));
    const startM = d.mAt(d.closureDraftKm);
    sim.interventions.closureDraft = { from: Math.min(startM, x), to: Math.max(startM, x) };
  };

  // Leaving placing mode, by any route, discards a half-drawn stretch. Runs per direction: each
  // direction's own placingClosure/simRef, so drawing a closure on one carriageway never touches
  // the other's half-drawn state.
  useEffect(() => {
    if (nb.placingClosure) return;
    nb.setClosureDraftKm(null);
    if (nb.simRef.current) nb.simRef.current.interventions.closureDraft = null;
    // nb is a fresh object every render (useDirectionSim returns a new literal each call); the
    // fields actually read here are the only ones that matter, and are themselves each stable
    // (state value / setState setter / ref) — listing the whole object would re-run this every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nb.placingClosure, nb.setClosureDraftKm, nb.simRef]);
  useEffect(() => {
    if (sb.placingClosure) return;
    sb.setClosureDraftKm(null);
    if (sb.simRef.current) sb.simRef.current.interventions.closureDraft = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sb.placingClosure, sb.setClosureDraftKm, sb.simRef]);

  // Esc leaves either placing mode, wherever it is armed.
  useEffect(() => {
    if (!placingArmed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") disarmPlacing();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // disarmPlacing closes over the two hook objects, fresh every render; what it calls (the setters) is
    // stable, and placingArmed is the only thing that decides whether the listener should exist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placingArmed]);

  // A proposal that moves the window places a km-less closure or zone along the NEW window: no km to quote yet.
  const planMovesWindow = !!plan && plan.actions.some((a) => a.type === "set_route" || a.type === "frame" || a.type === "frame_place" || (a.type === "set_reallocation" && a.toward !== null));
  const commandLookup: CommandLookup = {
    closureStretch: (d) => (planMovesWindow ? null : { fromKm: Math.min(byDirection[d].closureAtKm, byDirection[d].closureEndAtKm), toKm: Math.max(byDirection[d].closureAtKm, byDirection[d].closureEndAtKm) }),
    zoneStretch: (d) => (planMovesWindow ? null : { fromKm: Math.min(byDirection[d].shownZoneFromKm, byDirection[d].shownZoneToKm), toKm: Math.max(byDirection[d].shownZoneFromKm, byDirection[d].shownZoneToKm) }),
    exits: EXITS,
    placeName: (id) => (["NB", "SB"] as const).map((d) => byDirection[d].places.find((x) => x.id === id)).find(Boolean)?.name ?? id,
    hasPumps: (id) => (["NB", "SB"] as const).map((d) => byDirection[d].places.find((x) => x.id === id)).find(Boolean)?.kind === "service_area",
    eventName: (key) => {
      const [d, id] = key.split(":");
      const e = d === "NB" || d === "SB" ? byDirection[d].scenarioEvents.find((x) => x.id === id) : undefined;
      return e ? `${e.name} (${d})` : key;
    },
  };
  /** One carriageway as the command parser sees it: operator lane numbers, km for the closure and the zone. */
  const commandDirState = (d: Direction) => {
    const h = byDirection[d];
    const closed = h.eff.closedLanes.map((c, i) => (c ? i + 1 : 0)).filter(Boolean);
    return {
      lanes: h.laneCount,
      lanesFromRoad: segmentLanes[d],
      closedLanes: closed,
      closure: closed.length ? { fromKm: Math.min(h.shownClosureFromKm, h.shownClosureToKm), toKm: Math.max(h.shownClosureFromKm, h.shownClosureToKm) } : null,
      speedLimitKmh: h.eff.speedLimitKmh,
      zone: h.eff.speedLimitKmh != null ? { fromKm: Math.min(h.shownZoneFromKm, h.shownZoneToKm), toKm: Math.max(h.shownZoneFromKm, h.shownZoneToKm) } : null,
      inflowVehPerHour: h.inflow,
      inflowSource: h.inflowFrom,
      closedBooths: Object.entries(h.closedBooths).filter(([, st]) => st.length > 0).map(([placeId, st]) => ({ placeId, stations: [...st] })),
    };
  };
  /* The proposal on the road (planGhosts): each action with a place, as metres on its carriageway's run now.
     Recomputed when the proposal or either road changes; emptied when there is no proposal. */
  useEffect(() => {
    const out: Record<Direction, PlanGhost[]> = { NB: [], SB: [] };
    const span = (a: number, b: number) => fmtKmRange(Math.min(a, b), Math.max(a, b), 2);
    for (const a of plan?.actions ?? []) {
      if (!("direction" in a) && a.type !== "set_reallocation" && a.type !== "remove_event") continue;
      const dir: Direction | null = a.type === "remove_event" ? (a.eventId.startsWith("SB:") ? "SB" : "NB") : a.type === "set_reallocation" ? a.toward : "direction" in a ? a.direction : null;
      if (dir === null) continue;
      const h = byDirection[dir];
      const len = h.spanM;
      const push = (kmA: number, kmB: number, lanes: readonly number[] | null, point: boolean, label: string) => {
        const m0 = Math.min(h.mAt(kmA), h.mAt(kmB));
        const m1 = Math.max(h.mAt(kmA), h.mAt(kmB));
        if (m1 < 0 || m0 > len) return; // not on the window now: Apply moves the window first
        out[dir].push({ fromM: Math.max(0, m0), toM: Math.min(len, m1), lanes, point, label });
      };
      const engine = (ops: readonly number[]) => ops.map((l) => operatorLaneToEngineIndex(l, h.laneCount)).filter((l): l is number => l !== null);
      switch (a.type) {
        case "close_lane": {
          const A = a.fromKm ?? h.shownClosureFromKm;
          const B = a.toKm ?? h.shownClosureToKm;
          push(A, B, engine(a.lanes), false, `close lane ${a.lanes.join(", ")} · ${span(A, B)}`);
          break;
        }
        case "open_lane":
          push(h.shownClosureFromKm, h.shownClosureToKm, engine(a.lanes), false, `reopen lane ${a.lanes.join(", ")}`);
          break;
        case "set_speed_limit": {
          if (a.kmh == null) break;
          const A = a.fromKm ?? h.shownZoneFromKm;
          const B = a.toKm ?? h.shownZoneToKm;
          push(A, B, null, false, `${a.kmh} km/h · ${span(A, B)}`);
          break;
        }
        case "set_reallocation":
          if (a.fromKm != null && a.toKm != null) push(a.fromKm, a.toKm, null, false, `lane reallocation · ${span(a.fromKm, a.toKm)}`);
          break;
        case "remove_event": {
          const e = h.scenarioEvents.find((x) => `${dir}:${x.id}` === a.eventId);
          if (!e) break;
          const lanes = e.lane === null ? null : engine([e.lane, ...e.extraLanes]);
          if (e.stretchKm) push(e.stretchKm.fromKm, e.stretchKm.toKm, lanes, false, `remove ${e.name}`);
          else push(e.positionKm, e.positionKm, lanes, true, `remove ${e.name}`);
          break;
        }
        case "set_booths": {
          const p = h.places.find((x) => x.id === a.placeId);
          if (p) push(p.km, p.km, null, true, `${a.open ? "reopen" : "shut"} ${a.stations.length ? `booth ${a.stations.map((x) => x + 1).join(", ")}` : "every booth"} at ${p.name}`);
          break;
        }
        case "add_event": {
          const name = getTemplate(a.family).displayName;
          const when = a.atClock ? ` · ${hhmm2(a.atClock.hour, a.atClock.minute)}` : a.startMinutes > 0 ? ` · in ${a.startMinutes} min` : "";
          if (a.family === "rain") {
            push(fromKm, toKm, null, false, `${name} · whole road${when}`);
            break;
          }
          if (a.usual) break; // looked up when applied: there is no place to show yet
          if (a.placeId) {
            const p = h.places.find((x) => x.id === a.placeId);
            if (p) push(p.km, p.km, null, true, `${name} at ${p.name}${when}`);
            break;
          }
          const cap = h.laneCount;
          const lane = eventHasLane(a.family) ? Math.min(Math.max(1, a.lane ?? defaultOperatorLane(getTemplate(a.family), cap)), cap) : null;
          const lanes = lane === null ? null : engine([lane, ...a.extraLanes]);
          if (a.fromKm != null && a.toKm != null) push(a.fromKm, a.toKm, lanes, false, `${name} · ${span(a.fromKm, a.toKm)}${when}`);
          else {
            const km = a.km ?? (fromKm + toKm) / 2;
            push(km, km, lanes, true, `${name} · Km ${fmtKm(km, 2)}${when}`);
          }
          break;
        }
        default:
          break;
      }
    }
    planGhosts.NB = out.NB;
    planGhosts.SB = out.SB;
    return () => {
      planGhosts.NB = [];
      planGhosts.SB = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, fromKm, toKm, nb.laneCount, sb.laneCount, nb.scenarioEvents, sb.scenarioEvents, nb.shownClosureFromKm, nb.shownClosureToKm, sb.shownClosureFromKm, sb.shownClosureToKm, nb.shownZoneFromKm, nb.shownZoneToKm, sb.shownZoneFromKm, sb.shownZoneToKm]);

  /** Every toll plaza, barrier and gas station on the corridor, both carriageways, in km order: "go to Shell
   *  Balagtas" has to work from any route, so the ones off it are sent too (the server routes round them). */
  const commandPlaces = () =>
    (["NB", "SB"] as const)
      .flatMap((d) =>
        byDirection[d].places.map((p) => ({
          id: p.id, name: p.name, kind: p.kind, direction: d, km: p.km, stations: p.booths,
          inWindow: p.km >= fromKm && p.km <= toKm,
          onRoute: p.km >= routeFromKm - 0.05 && p.km <= routeToKm + 0.05,
        })),
      )
      .sort((a, b) => a.km - b.km);

  // Ask the backend to turn the sentence into simulation actions. This only
  // ever produces a PROPOSAL — applyPlan() below is what actually touches the
  // simulation, and it runs when the operator presses Apply.
  const runCommand = async () => {
    const text = command.trim();
    if (!text || commandBusy) return;

    // The direction is pinned NOW: what is sent, what the proposal says it is for, and where Apply
    // lands are all this one carriageway, whatever focus does while the request is in flight.
    const sentTo = byDirection[focusDirection];
    const sentDirection = focusDirection;

    setCommandBusy(true);
    setCommandError(null);
    setCommandNote(null);
    setPlan(null);
    setPlanDirection(null);
    const abort = new AbortController();
    commandAbortRef.current = abort;
    setCommandSince(Date.now());
    // Past the backend's own per-call limit with its one retry: something is wrong, not slow.
    const limit = setTimeout(() => abort.abort("timeout"), COMMAND_TIMEOUT_MS);

    try {
      // Signed-in only: each command costs GLM tokens (2 Nov 2026). apiFetch adds the session token.
      const res = await apiFetch(`${BACKEND}/api/ai-sandbox/command`, {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: text,
          context: {
            laneCount: sentTo.laneCount,
            segmentLengthM: segLengthM,
            // The model reasons in 1-indexed lane numbers, the sim in 0-indexed
            // array positions. Convert on the way out and back again in
            // applyPlan() so the two never mix.
            // What is actually on the road (operator + running scenario), in the existing fields —
            // no new "direction" field (no backend change, per Phase D1 §4): this is always the
            // FOCUSED direction's effective state, captured as `sentTo` above. NB-only/SB-only,
            // that's unambiguous. In Both mode the Command panel shows which carriageway that is
            // and lets the operator change it right there; the proposal is then labelled with it.
            closedLanes: sentTo.eff.closedLanes.map((c, i) => (c ? i + 1 : 0)).filter(Boolean),
            speedLimitKmh: sentTo.eff.speedLimitKmh,
            incidentCount: sentTo.effIncidentCount,
            exits: EXITS.map((x) => ({ exit_id: x.exit_id, exit_name: displayExitName(x.exit_name), km: x.km })),
            /* Since 2026-10-05, the sandbox as it now is: both carriageways (each action names its own; the
               fields above stay the focused one's, for an older backend), the route and the window, the places
               on the route and the events on the road (keyed by carriageway, since each numbers its own), the
               reallocation, the clock and the forecast days — so "close lane 3 southbound" or "a crash at the
               Meycauayan booths at 7 am" can be resolved against what is really there. */
            view,
            focus: sentDirection,
            ...(EXITS[origin] && EXITS[destination]
              ? { route: { originExitId: EXITS[origin].exit_id, destinationExitId: EXITS[destination].exit_id, fromKm: routeFromKm, toKm: routeToKm } }
              : {}),
            window: { fromKm, toKm },
            directions: Object.fromEntries(activeDirections.map((d) => [d, commandDirState(d)])),
            places: commandPlaces(),
            events: activeDirections.flatMap((d) =>
              byDirection[d].scenarioEvents.map((e) => ({
                id: `${d}:${e.id}`,
                name: e.name,
                direction: d,
                km: e.positionKm,
                fromKm: e.stretchKm?.fromKm ?? null,
                toKm: e.stretchKm?.toKm ?? null,
                startMin: (e.startS - byDirection[d].scenarioNowS) / 60,
                endMin: (e.endS - byDirection[d].scenarioNowS) / 60,
              })),
            ),
            reallocation: zipper !== null ? { toward: zipper.toward, fromKm, toKm } : null,
            clock: { hour: Math.floor(liveMin / 60) % 24, minute: Math.floor(liveMin % 60) },
            nowMin: Math.max(0, sentTo.scenarioNowS / 60),
            // The clock at the end of warm-up: an event "at 12:30" is measured from it (with nowMin).
            runStart: { hour: Math.floor((((clockStartMin % 1440) + 1440) % 1440) / 60), minute: Math.floor((((clockStartMin % 1440) + 1440) % 1440) % 60) },
            forecastDay: forecast.date,
            forecastDays: forecast.data?.availableDates ?? [],
            playback: { running, speed: simSpeed, fullScreen: expanded },
          },
        }),
      });
      const json = await res.json();

      if (!res.ok || !json.success) {
        setCommandError(json?.message ?? `Request failed (${res.status}).`);
        return;
      }
      setPlan(json.data as CommandPlan);
      setPlanDirection(sentDirection);
    } catch {
      setCommandError(
        abort.signal.aborted
          ? abort.signal.reason === "timeout"
            ? `The model took longer than ${Math.round(COMMAND_TIMEOUT_MS / 60000 * 10) / 10} minutes. Try again; it is usually a few seconds.`
            : "Cancelled."
          : "Could not reach the backend. Is it running on port 4000?",
      );
    } finally {
      clearTimeout(limit);
      commandAbortRef.current = null;
      setCommandSince(null);
      setCommandBusy(false);
    }
  };

  /* A plan is applied in steps, because some actions rebuild the road the later ones land on: a new route opens
     its own window, a new window or lane count or hour builds a new run (and a new run starts clean), a forecast
     day loads over the network. Applied all at once, "go to Meycauayan and put a crash at the booths" added the
     crash to the old window and the rebuild then threw it away. So: route, view, clock and day first; then the
     window and lane counts; then a reallocation (which sets the window and lanes itself); then everything that
     acts on the road. Each step waits until both runs have been rebuilt and have stood unchanged for a moment. */
  type CommandQueue = {
    stages: CommandAction[][];
    /** The carriageway the proposal was made for: where the two old-style actions land. */
    dir: Direction;
    applied: string[];
    notApplied: string[];
    waitDay: string | null;
    /** The plan sets the clock itself: a forecast day it also picks keeps that time instead of moving to the day's peak hour. */
    explicitTime: boolean;
    /** "Where it usually happens" lookups still in flight: the plan is not finished until they land. */
    pending: number;
    sig: string;
    since: number;
    started: number;
  };
  const cmdQueueRef = useRef<CommandQueue | null>(null);
  const [, setCmdTick] = useState(0);
  const simNumbers = useRef(new WeakMap<object, number>());
  const simCount = useRef(0);
  const commandStage = (a: CommandAction): number =>
    a.type === "reset" ? 0
    : a.type === "playback" ? 5
    : a.type === "set_route" || a.type === "set_view" || a.type === "set_time" || a.type === "set_forecast_day" || a.type === "full_screen" ? 1
      : a.type === "frame" || a.type === "frame_place" || a.type === "set_lane_count" || (a.type === "set_reallocation" && a.toward === null) ? 2
        : a.type === "set_reallocation" ? 3
          : 4;
  const finishCommand = (q: CommandQueue) =>
    setCommandNote(
      (q.applied.length ? `Applied: ${q.applied.join(" · ")}.` : "Nothing to apply.") +
        (q.notApplied.length ? ` Not applied: ${q.notApplied.join(" · ")}.` : ""),
    );

  /** A proposed event onto its carriageway; `at` is a place worked out on the page ("where it usually happens"). */
  const addCommandEvent = (a: Extract<CommandAction, { type: "add_event" }>, q: CommandQueue, at: ResolvedPlace | null) => {
    const ok = (t: string) => q.applied.push(t);
    const no = (t: string) => q.notApplied.push(t);
    const h = byDirection[a.direction];
    const variant = { ...defaultVariant(a.family), ...a.variant } as ScenarioVariant;
    let site: EventSite | null = at?.site ?? null;
    let km = at ? at.positionKm : a.km;
    if (!at && a.placeId) {
      const f = h.facilities.find((x) => x.id === a.placeId);
      if (!f) {
        no(`${getTemplate(a.family).displayName}: that place is not on screen on ${DIRECTION_NAME[a.direction]}`);
        return;
      }
      site = { facilityId: f.id, facilityName: f.name, kind: a.site ?? "approach", stations: a.site === "approach" ? [] : a.stations };
      km = f.km ?? km;
    }
    const cap = h.laneCount;
    const wantLane = at ? at.lane ?? a.lane : a.lane;
    if (site === null && eventHasLane(a.family) && wantLane != null && wantLane > cap) no(`${DIRECTION_NAME[a.direction]} has no lane ${wantLane} here (it has ${cap}); the event goes in lane ${cap}`);
    const lane = site !== null || !eventHasLane(a.family) ? null : Math.min(Math.max(1, wantLane ?? defaultOperatorLane(getTemplate(a.family), cap)), cap);
    /* A stretch ("within Km 12.30–12.40"): the event covers exactly it — its closure is the stretch and the wreck is
       put inside it (positionInStretch) — instead of a point with a closure laid out round it, which put most of a
       "12.30–12.40" crash outside 12.30–12.40. Held to the window; one cut below 20 m is the point it has become. */
    let stretchKm: KmStretch | null = null;
    if (site === null && a.fromKm != null && a.toKm != null && !at) {
      const lo = Math.max(fromKm, Math.min(a.fromKm, a.toKm));
      const hi = Math.min(toKm, Math.max(a.fromKm, a.toKm));
      if ((hi - lo) * 1000 >= MIN_EVENT_STRETCH_M) {
        stretchKm = { fromKm: lo, toKm: hi };
        if (lo > Math.min(a.fromKm, a.toKm) + 0.0005 || hi < Math.max(a.fromKm, a.toKm) - 0.0005) no(`${fmtKmRange(Math.min(a.fromKm, a.toKm), Math.max(a.fromKm, a.toKm), 2)} runs past the road on screen; the event covers ${fmtKmRange(lo, hi, 2)}`);
      } else {
        km = (lo + hi) / 2;
      }
    }
    // Minutes after warm-up. A run just rebuilt is still warming up (its "now" is below zero), and an event cannot
    // start before warm-up ends, so "now" is the later of the two, as the Scenario panel has it.
    const nowMin = Math.max(0, h.scenarioNowS / 60);
    let startMinutes = nowMin + a.startMinutes;
    /* A clock time ("at 12:30"): measured here, from this clock to the second — the server's copy of it is a
       minute-rounded snapshot from when the command was typed, and the run may have been rebuilt since (a set_time
       before it in the same plan builds a new one at that hour). */
    if (a.atClock) {
      const at = a.atClock.hour * 60 + a.atClock.minute;
      const base = clockStartMin + nowMin;
      const ahead = (((at - base) % 1440) + 1440) % 1440;
      const behind = 1440 - ahead;
      if (behind < 1) startMinutes = nowMin;
      else if (ahead <= 240) startMinutes = nowMin + ahead;
      else {
        no(`${getTemplate(a.family).displayName}: ${hhmm2(a.atClock.hour, a.atClock.minute)} is ${ahead > 720 ? "already past" : "more than 4 hours ahead"} on the sandbox clock (${hhmm2(Math.floor((((base % 1440) + 1440) % 1440) / 60), Math.floor((((base % 1440) + 1440) % 1440) % 60))}); not added`);
        return;
      }
    }
    const spec: NewEventSpec = {
      variant,
      direction: a.direction,
      lane,
      extraLanes: lane === null || !EVENT_MULTI_LANE.has(a.family) ? [] : [...new Set(a.extraLanes.filter((l) => l >= 1 && l <= cap && l !== lane))],
      positionKm: Math.min(toKm, Math.max(fromKm, km ?? (fromKm + toKm) / 2)),
      stretchKm,
      startMinutes,
      duration: a.duration.kind === "sampled" ? { kind: "sampled", seed: 1 + Math.floor(Math.random() * 2147483000) } : a.duration,
      site,
    };
    const r = h.addScenarioEvent(spec);
    if (r.ok) ok(`${r.event.name} on ${DIRECTION_NAME[a.direction]}${at?.note ? ` (${at.note.replace(/\.$/, "")})` : ""}`);
    else no(r.reason);
  };
  /** "Where it usually happens", once the incident log has answered: its busiest place on this window, or mid-window with a note. */
  const placeUsual = (a: Extract<CommandAction, { type: "add_event" }>, q: CommandQueue, hot: Hotspots | null) => {
    const h = byDirection[a.direction];
    const sites = h.facilities.map((f): SiteOption => ({
      id: f.id,
      name: f.name,
      kind: f.kind,
      km: f.km ?? h.kmAt(f.x),
      stations: h.simRef.current?.fac.get(f.id)?.stations.length ?? f.booths,
      recordNames: f.recordNames ?? [],
    }));
    const best = HOTSPOT_FAMILIES.has(a.family) ? candidatesFrom(hot, sites, fromKm, toKm)[0] : undefined;
    if (!best) q.notApplied.push(`${getTemplate(a.family).displayName}: ${hot ? "the incident log has nothing of this kind on this stretch" : "the incident log could not be read"}, so it goes mid-window`);
    // A place at a booth only for a family that can happen there; otherwise the place's km on the road.
    const place = best ? (best.place.site && !SITE_FAMILIES.has(a.family) ? { ...best.place, site: null } : best.place) : null;
    addCommandEvent(a, q, place);
  };
  const cmdLatestRef = useRef({ placeUsual });
  cmdLatestRef.current = { placeUsual };

  /** One action, against the state as it is in this render. */
  const applyCommandAction = (a: CommandAction, q: CommandQueue) => {
    const ok = (t: string) => q.applied.push(t);
    const no = (t: string) => q.notApplied.push(t);
    switch (a.type) {
      case "set_route": {
        const o = EXITS.findIndex((x) => x.exit_id === a.originExitId);
        const d = EXITS.findIndex((x) => x.exit_id === a.destinationExitId);
        if (o < 0 || d < 0) {
          no("the route (an exit is not on the corridor)");
          break;
        }
        setOrigin(o);
        setDestination(d);
        ok(`Route ${displayExitName(EXITS[o].exit_name)} → ${displayExitName(EXITS[d].exit_name)}`);
        break;
      }
      case "set_view":
        setView(a.view);
        ok(a.view === "Both" ? "Both carriageways shown" : `${DIRECTION_NAME[a.view]} shown`);
        break;
      case "set_time":
        setHourFollowsDay(null);
        setHourOfDay(a.hour);
        setClockMinuteOffset(a.minute);
        ok(`Clock ${hhmm2(a.hour, a.minute)}`);
        break;
      case "set_forecast_day":
        if (!(forecast.data?.availableDates ?? []).includes(a.date)) {
          no(`no forecast for ${a.date}`);
          break;
        }
        if (q.explicitTime) forecast.selectDay(a.date);
        else pickForecastDay(a.date);
        setForecastFollowing(true);
        q.waitDay = a.date;
        ok(`Forecast day ${a.date}`);
        break;
      case "frame":
        showWindow({ fromKm: a.fromKm, toKm: a.toKm });
        ok(`Window ${fmtKmRange(a.fromKm, a.toKm, 2)}`);
        break;
      case "frame_place": {
        const hit = (["NB", "SB"] as const).map((d) => ({ d, p: byDirection[d].places.find((x) => x.id === a.placeId) })).find((x) => x.p);
        if (!hit?.p) {
          no("that place is not on this route");
          break;
        }
        framePlace(hit.p, hit.d);
        ok(`Window on ${hit.p.name}`);
        break;
      }
      case "set_lane_count": {
        const h = byDirection[a.direction];
        if (a.lanes === "auto") {
          const n = segmentLanes[a.direction];
          if (n == null) {
            no(`${DIRECTION_NAME[a.direction]} lanes: the lane table has nothing for this stretch`);
            break;
          }
          h.setLaneCount(n);
          ok(`${DIRECTION_NAME[a.direction]}: ${n} lanes, as the road has`);
        } else {
          h.setLaneCount(a.lanes);
          ok(`${DIRECTION_NAME[a.direction]}: ${a.lanes} lanes`);
        }
        break;
      }
      case "set_reallocation": {
        if (a.toward === null) {
          endReallocation();
          ok(`${REALLOCATION_NAME} ended`);
          break;
        }
        const why = chooseZipper(a.toward, 1, a.fromKm != null && a.toKm != null ? { fromKm: a.fromKm, toKm: a.toKm } : undefined);
        if (why) no(`${REALLOCATION_NAME}: ${why}`);
        else ok(`${REALLOCATION_NAME}: ${DIRECTION_NAME[a.toward]} +1 lane`);
        break;
      }
      case "close_lane":
      case "open_lane": {
        const h = byDirection[a.direction];
        const shut = a.type === "close_lane";
        // The count may have changed since the proposal (a lane count, a new window): say which lanes are not there.
        const missing = a.lanes.filter((n) => n < 1 || n > h.laneCount);
        if (missing.length > 0) no(`${DIRECTION_NAME[a.direction]} has no lane ${missing.join(", ")} here (it has ${h.laneCount})`);
        const idx = a.lanes.map((n) => n - 1).filter((i) => i >= 0 && i < h.laneCount);
        // Things a running scenario event owns cannot be changed from here; say so rather than report them applied.
        const held = shut ? [] : idx.filter((i) => h.lockedLanes[i]);
        if (held.length > 0 && h.owners.closure) {
          no(`${DIRECTION_NAME[a.direction]} lane ${held.map((i) => i + 1).join(", ")} stays closed (driven by ${describeOwner(h.owners.closure)})`);
        }
        const free = idx.filter((i) => !held.includes(i));
        if (free.length === 0) break;
        h.setClosedLanes((prev) => prev.map((c, i) => (free.includes(i) ? shut : c)));
        if (a.type === "close_lane" && a.fromKm != null && a.toKm != null) {
          h.setClosureKm(a.fromKm);
          h.setClosureEndKm(a.toKm);
        }
        ok(`${shut ? "Closed" : "Opened"} ${DIRECTION_NAME[a.direction]} lane ${free.map((i) => i + 1).join(", ")}`);
        break;
      }
      case "set_speed_limit": {
        const h = byDirection[a.direction];
        if (h.owners.speedZone) {
          no(`the ${DIRECTION_NAME[a.direction]} speed zone is driven by ${describeOwner(h.owners.speedZone)}`);
          break;
        }
        h.setSpeedLimit(a.kmh);
        if (a.kmh != null && a.fromKm != null && a.toKm != null) {
          h.setZoneFromKm(a.fromKm);
          h.setZoneToKm(a.toKm);
        }
        ok(a.kmh == null ? `Removed the ${DIRECTION_NAME[a.direction]} speed limit` : `${DIRECTION_NAME[a.direction]} ${a.kmh} km/h`);
        break;
      }
      case "add_event": {
        if (!a.usual) {
          addCommandEvent(a, q, null);
          break;
        }
        /* "Where it usually happens": the same lookup and the same choice as the Scenario panel's — the busiest
           100 m of this stretch in the incident log (with its usual lane), or the plaza or station where this kind of
           event is recorded most. Asked now, applied when it answers, through the latest render's functions. */
        q.pending += 1;
        const qs = new URLSearchParams({ family: a.family, direction: a.direction, fromKm: String(fromKm), toKm: String(toKm) });
        fetch(`${BACKEND}/api/ai-sandbox/hotspots?${qs}`, { cache: "no-store" })
          .then((r) => r.json())
          .catch(() => null)
          .then((j: { success?: boolean; data?: Hotspots } | null) => {
            cmdLatestRef.current.placeUsual(a, q, j?.success && j.data ? j.data : null);
            q.pending -= 1;
            setCmdTick((x) => x + 1);
          });
        break;
      }
      case "remove_event": {
        const [d, id] = a.eventId.split(":");
        const h = d === "NB" || d === "SB" ? byDirection[d] : null;
        const e = h?.scenarioEvents.find((x) => x.id === id);
        if (!h || !e) {
          no("that event is no longer on the road");
          break;
        }
        h.removeScenarioEvent(id);
        ok(`Removed ${e.name} (${d})`);
        break;
      }
      case "clear_events": {
        const h = byDirection[a.direction];
        for (const e of h.scenarioEvents) h.removeScenarioEvent(e.id);
        h.clearIncidents();
        ok(`Cleared ${DIRECTION_NAME[a.direction]}'s events and incidents`);
        break;
      }
      case "set_inflow": {
        const h = byDirection[a.direction];
        if (a.vehPerHour === "observed") {
          if (h.dataAnchor == null) {
            no(`${DIRECTION_NAME[a.direction]} inflow: no recorded flow for this stretch`);
            break;
          }
          h.setInflow(h.dataAnchor);
          ok(`${DIRECTION_NAME[a.direction]} inflow back to ${fmt(h.dataAnchor)} veh/h (recorded)`);
        } else {
          h.setInflow(a.vehPerHour);
          ok(`${DIRECTION_NAME[a.direction]} inflow ${fmt(a.vehPerHour)} veh/h`);
        }
        break;
      }
      case "capture_baseline":
        byDirection[a.direction].captureBaseline();
        ok(`Baseline captured on ${DIRECTION_NAME[a.direction]}`);
        break;
      case "set_booths": {
        const h = byDirection[a.direction];
        const f = h.facilities.find((x) => x.id === a.placeId);
        const n = f ? h.simRef.current?.fac.get(f.id)?.stations.length ?? f.booths : 0;
        if (!f || n === 0) {
          no(`booths: that place is not on screen on ${DIRECTION_NAME[a.direction]}`);
          break;
        }
        const which = (a.stations.length === 0 ? Array.from({ length: n }, (_, i) => i) : a.stations).filter((i) => i >= 0 && i < n);
        h.setClosedBooths((prev) => {
          const cur = new Set(prev[f.id] ?? []);
          for (const i of which) {
            if (a.open) cur.delete(i);
            else cur.add(i);
          }
          return { ...prev, [f.id]: [...cur].sort((x, y) => x - y) };
        });
        const what = f.kind === "service_area" ? "pump" : "booth";
        ok(`${a.open ? "Reopened" : "Shut"} ${a.stations.length === 0 ? `every ${what}` : `${what} ${which.map((i) => i + 1).join(", ")}`} at ${f.name}`);
        break;
      }
      case "playback":
        if (a.run) setRunning(a.run === "play");
        if (a.speed != null && (SPEED_STEPS as readonly number[]).includes(a.speed)) setSimSpeed(a.speed as (typeof SPEED_STEPS)[number]);
        ok([a.run === "play" ? "Playing" : a.run === "pause" ? "Paused" : null, a.speed != null ? `${a.speed}×` : null].filter(Boolean).join(" at "));
        break;
      case "reset":
        resetEverything();
        ok("Reset");
        break;
      case "full_screen":
        setExpanded(a.on);
        ok(a.on ? "Full screen" : "Left full screen");
        break;
      case "add_incident":
        byDirection[q.dir].placeIncident(a.lane - 1, (a.positionPct / 100) * segLengthM);
        ok(`Incident in lane ${a.lane}`);
        break;
      case "clear_incidents":
        byDirection[q.dir].clearIncidents();
        ok("Cleared incidents");
        break;
    }
  };

  // Apply a confirmed plan to the simulation. Every action was already range-
  // checked server-side; the bounds are re-asserted as each is applied, because
  // that is the last thing between model output and sim state. Each action names
  // its carriageway; the two old-style ones land on the carriageway the proposal
  // was made for (planDirection), matching the context runCommand sent.
  const applyPlan = () => {
    // The carriageway the proposal was made for, not whatever is focused now.
    const planTarget = byDirection[planDirection ?? focusDirection];
    if (!plan || !planTarget.simRef.current) return;
    const actions = [...plan.actions];
    // A carriageway the view does not show: show both first, so what is changed can be seen.
    // Rain is put on both carriageways whatever is on screen (it falls on the whole road), so it never widens the view.
    const named = actions.flatMap((a) => (a.type === "add_event" && a.family === "rain" ? [] : "direction" in a ? [a.direction] : a.type === "set_reallocation" && a.toward ? [a.toward] : []));
    if (!actions.some((a) => a.type === "set_view") && named.some((d) => !activeDirections.includes(d))) actions.unshift({ type: "set_view", view: "Both" });
    const stages = [0, 1, 2, 3, 4, 5].map((n) => actions.filter((a) => commandStage(a) === n)).filter((g) => g.length > 0);
    const now = Date.now();
    const q: CommandQueue = { stages, dir: planDirection ?? focusDirection, applied: [], notApplied: [], waitDay: null, explicitTime: actions.some((a) => a.type === "set_time"), pending: 0, sig: "", since: now, started: now };
    for (const a of q.stages.shift() ?? []) applyCommandAction(a, q);
    if (q.stages.length > 0 || q.pending > 0) {
      cmdQueueRef.current = q;
      setCommandNote(`Applying… ${q.applied.join(" · ")}`);
      setCmdTick((t) => t + 1);
    } else {
      cmdQueueRef.current = null;
      finishCommand(q);
    }
    setPlan(null);
    setCommand("");
  };

  // The next step of a plan, once the road it acts on has been rebuilt and has settled (see CommandQueue).
  useEffect(() => {
    const q = cmdQueueRef.current;
    if (!q) return;
    const numberOf = (sim: object | null) => {
      if (!sim) return 0;
      let n = simNumbers.current.get(sim);
      if (n == null) {
        n = ++simCount.current;
        simNumbers.current.set(sim, n);
      }
      return n;
    };
    const runs = (["NB", "SB"] as const).map((d) => {
      const sim = byDirection[d].simRef.current;
      return `${numberOf(sim)}:${sim?.cfg.length ?? 0}:${sim?.cfg.laneCount ?? 0}`;
    });
    const sig = [origin, destination, fromKm, toKm, view, hourOfDay, ...runs].join("|");
    const now = Date.now();
    if (sig !== q.sig) {
      q.sig = sig;
      q.since = now;
    }
    // And the clock has moved to that day's peak hour, if it is going to (hourFollowsDay): that rebuilds the run.
    const dayReady = q.waitDay === null || (forecast.date === q.waitDay && !forecast.busy && hourFollowsDay === null);
    const runsReady = activeDirections.every((d) => {
      const sim = byDirection[d].simRef.current;
      return !!sim && sim.cfg.length === segLengthM && sim.cfg.laneCount === byDirection[d].laneCount;
    });
    // Ten seconds is long enough for any rebuild; past it, apply anyway and let each action say if it cannot.
    if (q.stages.length > 0 && ((now - q.since >= 450 && dayReady && runsReady) || now - q.started > 10_000)) {
      for (const a of q.stages.shift() ?? []) applyCommandAction(a, q);
      q.sig = "";
      q.since = now;
    }
    if (q.stages.length === 0 && q.pending === 0) {
      cmdQueueRef.current = null;
      finishCommand(q);
      return;
    }
    const t = setTimeout(() => setCmdTick((x) => x + 1), 150);
    return () => clearTimeout(t);
  });
  // clearIncidents, toggleLane, addScenarioEvent, removeScenarioEvent, cancelSkip, skipToNextPhase,
  // captureBaseline, interventionSummary and anyIntervention are all useDirectionSim's now — called
  // per direction there, read here as focused.clearIncidents etc. (see the JSX below).
  const laneOverridden = segmentLanes[focusDirection] != null && focused.laneCount !== segmentLanes[focusDirection];
  /* Where the lane counts on the road come from: the road itself, the operator's override, a lane
     reallocation, or an assumption where the lane table has nothing. The sliders stay folded away unless the
     operator opens them (lanesOpen): the width is a fact about the road, not a setting. */
  const [lanesOpen, setLanesOpen] = useState(false);
  const laneDirs: readonly Direction[] = activeDirections;
  const roadLanesText = laneDirs.length > 1
    ? laneDirs.map((d) => `${d} ${segmentLanes[d] ?? "?"}`).join(" · ")
    : `${segmentLanes[laneDirs[0]] ?? "?"}`;
  const lanesBy: "road" | "hand" | "reallocation" | "assumed" =
    zipper !== null ? "reallocation"
      : laneDirs.some((d) => segmentLanes[d] != null && byDirection[d].laneCount !== segmentLanes[d]) ? "hand"
        : laneDirs.some((d) => segmentLanes[d] == null) ? "assumed"
          : "road";
  const laneNote =
    lanesBy === "road"
      ? `From the road for ${fmtKmRange(fromKm, toKm, 2)} (OpenStreetMap). They follow the stretch on screen.`
      : lanesBy === "hand"
        ? `Set by hand. The road here has ${roadLanesText}.`
        : lanesBy === "reallocation" && zipper !== null
          ? `${REALLOCATION_NAME} ${zipper.toward} +${zipper.lanes} (in Interventions). The road here has ${roadLanesText}; changing lanes ends it.`
          : "This stretch is not in the corridor's lane table, so the count shown is assumed. Use Change lanes to set it.";
  const laneInfo = `Each carriageway's through lanes over the stretch on screen, from the lane tags in OpenStreetMap (© OpenStreetMap contributors), measured per direction between interchanges (lib/nlex-lanes.ts). Where the stretch crosses a change in width, the narrowest is used: that is where queues form. Changing lanes resets the run.${laneProvenance.length ? ` Source: ${laneProvenance.join("; ")}.` : ""}`;
  const lanesBackToRoad = () => {
    for (const d of laneDirs) {
      const n = segmentLanes[d];
      if (n != null) byDirection[d].setLaneCount(n);
    }
  };

  const recommendations: Record<Direction, ReturnType<typeof getRecommendation>> = {
    NB: getRecommendation(nb.metrics, nb.baseline, [...nb.eff.closedLanes], nb.effIncidentCount, nb.eff.speedLimitKmh, { inflow: nb.inflow, inflowFrom: nb.inflowFrom, anchor: nb.dataAnchor }),
    SB: getRecommendation(sb.metrics, sb.baseline, [...sb.eff.closedLanes], sb.effIncidentCount, sb.eff.speedLimitKmh, { inflow: sb.inflow, inflowFrom: sb.inflowFrom, anchor: sb.dataAnchor }),
  };
  const recommendation = recommendations[focusDirection];

  // Corridor readouts (Both mode only): built from the two directions' own metrics/baselines by the
  // rules in bothMetrics.ts, so the totals and the per-direction rows can never disagree.
  const corridor = both && nb.metrics && sb.metrics ? combineMetrics(nb.metrics, sb.metrics) : null;
  const corridorBase = both && nb.baseline && sb.baseline ? combineBaselines(nb.baseline, sb.baseline) : null;
  const rowsOf = (value: (m: Metrics) => string, delta?: (m: Metrics, b: Baseline) => number | null): TileRow[] =>
    (["NB", "SB"] as const).map((dn) => {
      const d = byDirection[dn];
      return { direction: dn, value: d.metrics ? value(d.metrics) : "…", delta: delta && d.metrics && d.baseline ? delta(d.metrics, d.baseline) : null };
    });

  // What a skip on each carriageway would take, before it starts.
  const scenarioDataFor = (dn: Direction): DirectionScenarioData => {
    const d = byDirection[dn];
    const other: Direction = dn === "NB" ? "SB" : "NB";
    const next = nextBoundaryAfter(d.scenarioEvents, d.scenarioRoad, d.scenarioNowS);
    let skipPlan: SkipPlan | null = null;
    if (next !== null) {
      const what = describeBoundary(d.scenarioEvents, d.scenarioRoad, next, d.scenarioNowS);
      const cost = stepCostRef.current[dn] ?? stepCostRef.current[other];
      const simSeconds = Math.max(0, next - d.scenarioNowS);
      // Two skips at once share the one thread: each takes about twice as long as it would alone.
      const sharing = byDirection[other].skip !== null ? 2 : 1;
      skipPlan = {
        label: what ? what.label : "the next phase",
        simSeconds,
        estimateMs: cost === null ? null : (simSeconds / SIM_DT) * cost * SKIP_COST_FACTOR * sharing,
      };
    }
    return {
      events: d.scenarioEvents,
      owners: d.owners,
      road: d.scenarioRoad,
      nowS: d.scenarioNowS,
      laneCount: d.laneCount,
      kmAtPct: (pct) => d.kmAt((d.spanM * pct) / 100),
      manualClosure: { closedLanes: d.closedLanes, closurePoint: d.manualControls.closurePoint, closureEnd: d.manualControls.closureEnd },
      nextSeq: d.scenarioSeqRef.current + 1,
      onAdd: d.addScenarioEvent,
      onRemove: d.removeScenarioEvent,
      skip: d.skip,
      canSkip: next !== null,
      skipPlan,
      onSkip: d.skipToNextPhase,
      onCancelSkip: d.cancelSkip,
      sites: d.facilities.map((f): SiteOption => ({
        id: f.id,
        name: f.name,
        kind: f.kind,
        km: f.km ?? d.kmAt(f.x),
        // Booth or pump count as built (a barrier is sized to its lanes), else as specified.
        stations: d.simRef.current?.fac.get(f.id)?.stations.length ?? f.booths,
        recordNames: f.recordNames ?? [],
      })),
    };
  };
  const nbEvents = nb.scenarioEvents.length;
  const sbEvents = sb.scenarioEvents.length;
  const scenarioSummary = both
    ? nbEvents + sbEvents === 0
      ? "none"
      : `${nbEvents + sbEvents} event${nbEvents + sbEvents === 1 ? "" : "s"} · NB ${nbEvents} · SB ${sbEvents}`
    : focused.scenarioEvents.length === 0
      ? "none"
      : `${focused.scenarioEvents.length} event${focused.scenarioEvents.length === 1 ? "" : "s"} · ${focused.activeScenarioText.length > 0 ? focused.activeScenarioText[0] : "none running"}`;
  const baselineSummaryOf = (d: DirectionApi) => (d.baseline ? `${fmt(d.baseline.avgSpeedKmh)} km/h · ${fmt(d.baseline.throughputPerMin)}/min captured` : "not captured");
  const baselineSummary = both ? `NB ${nb.baseline ? "captured" : "not captured"} · SB ${sb.baseline ? "captured" : "not captured"}` : baselineSummaryOf(focused);

  /* The picked hour and minute, in minutes since midnight — the zero point both the live clock below
   * and every scenario event's "starts HH:MM" label (ScenarioPanel) are written against. NB and SB
   * share one engine clock (see the render loop's accumulator note), so `focused.scenarioNowS` is the
   * same instant on either carriageway. Only the HOUR half feeds the demand/incident forecast
   * (hourly-resolution data); the minute is display/start-point precision only — see clockMinuteOffset. */
  const clockStartMin = (hourOfDay ?? focused.demand?.peakHour ?? 8) * 60 + clockMinuteOffset;
  const liveMin = clockStartMin + focused.scenarioNowS / 60;
  const live = hourOfDay != null;
  // The render loop runs outside React on every animation frame, reading the engine's own sim.time
  // directly rather than the ~4x/sec-polled focused.scenarioNowS above — it needs clockStartMin
  // through a ref for the same reason locationRef/marksRef exist (see their comment).
  const clockStartMinRef = useRef(clockStartMin);
  clockStartMinRef.current = clockStartMin;
  const liveDateText = live && forecast.date ? liveDateLabel(forecast.date, liveDayOffset(liveMin)) : null;

  // The metric tiles, once, so full screen can put the same ones inside the card (the row above the grid is
  // covered by it) and the page draws them in their usual place otherwise.
  const metricTiles = (
    <>
      {/* Metric tiles. NB-only/SB-only: one tile per metric, exactly as always. Both mode: the corridor
          figure on top of each tile with each carriageway's own value under it (per-direction rows,
          always visible) — see bothMetrics.ts for which metrics sum, which take the max, which are
          flow-weighted, and which (density) have no total at all. */}
      {/* Every figure in this strip comes from the agent-based engine, not from the road: the pill says so. */}
      <div className="sandbox-metric-flag">
        <span className="nc-tag-illustrative">Simulation</span>
        {both && (
          <p className="sandbox-metric-caption" data-metric-caption>
            Corridor totals with NB and SB beneath.{" "}
            <InfoTooltip text="Average speed is flow-weighted — each direction's speed weighted by its throughput, not a plain mean of the two. Longest queue is the worse of the two; density has no total." />
          </p>
        )}
      </div>
      {both ? (
        <div className="sandbox-metric-row">
          <MetricTileBoth
            label="Active agents"
            tag="total"
            tagTitle="Vehicles on the road now, both carriageways added."
            total={corridor ? fmt(corridor.activeAgents) : "…"}
            rows={rowsOf((m) => fmt(m.activeAgents))}
          />
          <MetricTileBoth
            label="Avg speed"
            tag="flow-weighted"
            tagTitle="Each direction's average speed weighted by its throughput (vehicles per minute) — not the plain mean of the two."
            total={corridor ? (corridor.flowWeightedAvgSpeedKmh === null ? "—" : `${fmt(corridor.flowWeightedAvgSpeedKmh)} km/h`) : "…"}
            totalDelta={
              corridor && corridorBase && corridor.flowWeightedAvgSpeedKmh !== null && corridorBase.flowWeightedAvgSpeedKmh !== null
                ? pctDelta(corridor.flowWeightedAvgSpeedKmh, corridorBase.flowWeightedAvgSpeedKmh)
                : null
            }
            rows={rowsOf((m) => `${fmt(m.avgSpeedKmh)} km/h`, (m, b) => pctDelta(m.avgSpeedKmh, b.avgSpeedKmh))}
            goodWhenUp
          />
          <MetricTileBoth
            label="Throughput"
            tag="total"
            tagTitle="Vehicles per minute completing the segment, both carriageways added."
            total={corridor ? `${fmt(corridor.throughputPerMin)}/min` : "…"}
            totalDelta={corridor && corridorBase ? pctDelta(corridor.throughputPerMin, corridorBase.throughputPerMin) : null}
            rows={rowsOf((m) => `${fmt(m.throughputPerMin)}/min`, (m, b) => pctDelta(m.throughputPerMin, b.throughputPerMin))}
            goodWhenUp
          />
          <MetricTileBoth
            label="Longest queue"
            tag="max"
            tagTitle="The longer of the two queues. Queues do not add across carriageways: two 80 m queues are not a 160 m one."
            total={corridor ? `${fmt(corridor.longestQueueM)} m` : "…"}
            totalDelta={corridor && corridorBase ? pctDelta(corridor.longestQueueM, corridorBase.longestQueueM) : null}
            rows={rowsOf((m) => `${fmt(m.longestQueueM)} m`, (m, b) => pctDelta(m.longestQueueM, b.longestQueueM))}
          />
          <MetricTileBoth
            label="CO₂ rate"
            tag="total"
            tagTitle="kg of CO₂ per minute, both carriageways added."
            total={corridor ? `${fmt(corridor.co2RatePerMin, 1)} kg/min` : "…"}
            totalDelta={corridor && corridorBase ? pctDelta(corridor.co2RatePerMin, corridorBase.co2RatePerMin) : null}
            rows={rowsOf((m) => `${fmt(m.co2RatePerMin, 1)} kg/min`, (m, b) => pctDelta(m.co2RatePerMin, b.co2RatePerMin))}
          />
          <MetricTileBoth
            label="Density"
            tag="per direction"
            tagTitle="Vehicles per km per lane on two separate carriageways has no meaningful total or mean, so none is shown."
            total={null}
            rows={rowsOf((m) => `${fmt(m.densityPerKmLane)}/km/ln`)}
          />
        </div>
      ) : (
      <div className="sandbox-metric-row">
        <MetricTile label="Active agents" value={focused.metrics ? fmt(focused.metrics.activeAgents) : "…"} />
        <MetricTile
          label="Avg speed"
          value={focused.metrics ? `${fmt(focused.metrics.avgSpeedKmh)} km/h` : "…"}
          delta={focused.baseline && focused.metrics ? pctDelta(focused.metrics.avgSpeedKmh, focused.baseline.avgSpeedKmh) : null}
          goodWhenUp
        />
        <MetricTile
          label="Throughput"
          value={focused.metrics ? `${fmt(focused.metrics.throughputPerMin)}/min` : "…"}
          delta={focused.baseline && focused.metrics ? pctDelta(focused.metrics.throughputPerMin, focused.baseline.throughputPerMin) : null}
          goodWhenUp
        />
        <MetricTile
          label="Longest queue"
          value={focused.metrics ? `${fmt(focused.metrics.longestQueueM)} m` : "…"}
          delta={focused.baseline && focused.metrics ? pctDelta(focused.metrics.longestQueueM, focused.baseline.longestQueueM) : null}
        />
        <MetricTile
          label="CO₂ rate"
          value={focused.metrics ? `${fmt(focused.metrics.co2RatePerMin, 1)} kg/min` : "…"}
          delta={focused.baseline && focused.metrics ? pctDelta(focused.metrics.co2RatePerMin, focused.baseline.co2RatePerMin) : null}
        />
        <MetricTile label="Density" value={focused.metrics ? `${fmt(focused.metrics.densityPerKmLane)}/km/ln` : "…"} />
      </div>
      )}
    </>
  );

  return (
    <section className="ds-content sandbox-page">
      <PageHeader
        icon={Car}
        title="Scenario Sandbox"
        subtitle={`Agent-based what-if simulation · ${originExit ? displayExitName(originExit.exit_name) : ""} → ${destExit ? displayExitName(destExit.exit_name) : ""} · ${fmtKmRange(fromKm, toKm, 2)}`}
      />

      {/* The two choices that apply to the whole sandbox — which carriageway(s), and which forecast day —
          in one strip under the header, the way the Traffic and Incident tabs hold their Range. Full
          screen covers this strip, so the card carries its own copy of the Carriageway choice there. */}
      <div className="sandbox-toprow">
        <div className={filterStyles.filterGroup}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-muted)" }} aria-hidden="true"><path d="M4 14 6 2M12 14 10 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><path d="M8 3v1.5M8 7v2M8 11.5V13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          <span className={filterStyles.filterLabel}>Carriageway</span>
          <div className={filterStyles.segmented} role="tablist" aria-label="Carriageway view">
            {(["Both", "NB", "SB"] as const).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} className={view === v ? "active" : ""} onClick={() => setView(v)} title={viewTitle(v)}>
                {view === v && <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                {viewLabel(v)}
              </button>
            ))}
          </div>
        </div>
        <div className={filterStyles.filterGroup}>
          <span className={filterStyles.filterLabel}>Forecast day</span>
          <ForecastDayPicker
            value={forecast.date}
            dates={forecast.data?.availableDates ?? []}
            coverageEnd={forecast.data?.incidents.coverageEnd ?? null}
            onChange={pickForecastDay}
            disabled={!forecast.data}
          />
        </div>
      </div>

      {/* The prescriptive seam: the three forecasts choose the conditions this
          scenario starts from. */}
      <ScenarioForecastPanel
        forecast={forecast}
        hour={hourOfDay}
        following={forecastFollowing}
        // The forecast is one segment-level prediction, not one per carriageway (D2 §3), so it seeds every
        // carriageway (each direction hook reads the same forecastInflow). Loading turns following on; the
        // inflow itself arrives through the hook's dataAnchor, so it tracks the day and hour from here on.
        // Each road's own Inflow slider can still move it afterwards, until the day or hour next changes.
        onApplyInflow={() => setForecastFollowing(true)}
      />

      {!expanded && metricTiles}

      <div className="sandbox-grid" style={{ marginTop: 14 }}>
        {/* Simulation canvas + recommendation */}
        {expanded && <div className="sandbox-main-hold" aria-hidden style={{ height: heldHeight }} />}
        <article
          ref={mainCardRef}
          className={
            `sandbox-main${expanded ? " is-expanded" : ""}` +
            `${expanded && railOpen ? " with-rail" : ""}` +
            // Both mode stacks a corridor total over per-direction rows, so its
            // readout strip is taller and the road's band has to allow for it.
            `${expanded && both ? " is-both" : ""}`
          }
        >
          {/* sandbox-hud-top holds the head and, once expanded, everything docked above the road
              (Carriageway, the key hints, the notes toggle, Forecast day) as one flow stack — see
              the CSS comment on sandbox-hud-top for why that matters: pinning them at independent
              fixed pixel offsets from the top let them overlap the head as soon as it wrapped onto
              a second line, since none of them actually knew how tall the head had rendered.
              `display: contents` while docked means this wrapper changes nothing there — the head
              is still just .sandbox-main's first child. */}
          <div className="sandbox-hud-top" ref={hudTopRef}>
          <div className="sandbox-head">
            <h2>Traffic Simulation</h2>
            {live && (
              <div
                className="sandbox-live-clock"
                title="The simulated date and time of day. Ticks forward with the simulation (paused when it's paused, faster at higher speeds). Picking a forecast day moves it to that day's busiest forecast hour. Edit it to jump the clock to a different hour, minute or second; the hour reseeds the road's demand for that hour, the minute and second just move the starting point."
              >
                <span className="sandbox-live-clock-label">Simulation time</span>
                {liveDateText && <span className="sandbox-live-clock-date">{liveDateText}</span>}
                <TimeField
                  valueS={liveMin * 60}
                  // No upper limit: the clock rolls past midnight on its own as the run goes, so a cap at
                  // 23:59:59 stopped ▲ there and snapped a typed value back a day.
                  minS={0}
                  maxS={Number.MAX_SAFE_INTEGER}
                  step={1}
                  scn="sim-time"
                  onCommit={(targetS, unit) => {
                    /* The box shows start + the run's elapsed time, not the start, so the edit is applied
                       as a shift of the start — writing the edited value back as the start counted the
                       elapsed time twice. A minute or second edit only moves the clock and leaves the run
                       alone, even when it carries into another hour; an hour edit reseeds demand for that
                       hour. Which box was edited comes from TimeField, not from comparing hours. */
                    setHourFollowsDay(null);
                    const shownS = Math.round(liveMin * 60);
                    if (unit !== "hour") {
                      setClockMinuteOffset((o) => o + (targetS - shownS) / 60);
                      return;
                    }
                    // A new hour rebuilds the run (hourOfDay feeds the facility plan the rebuild keys on),
                    // and a rebuilt run's clock starts WARMUP_S before its zero point; the same hour does
                    // not, and the run's elapsed time carries on. Either way the box then reads targetS —
                    // including its day, which the offset carries when an hour step crosses midnight.
                    const targetHour = Math.floor(targetS / 3600) % 24;
                    const nowAfterS = targetHour !== hourOfDay ? -WARMUP_S : focused.scenarioNowS;
                    setHourOfDay(targetHour);
                    setClockMinuteOffset((targetS - nowAfterS) / 60 - targetHour * 60);
                  }}
                />
              </div>
            )}
            <div>
              <div className="sandbox-speed-seg sandbox-zoom-seg" role="group" aria-label="Zoom the road" data-zoom>
                <button onClick={() => zoomAt(roadView.zoom / 1.6, null)} disabled={zoom <= 1.001} aria-label="Zoom out" title="Zoom out (Ctrl + wheel, or the wheel in full screen)">
                  −
                </button>
                <span data-zoom-readout title="How much of the road is across the screen. Vehicles are drawn at their true size, so zoom in to see them large.">
                  {Math.round(segLengthM / zoom).toLocaleString()} m
                </span>
                <button onClick={() => zoomAt(roadView.zoom * 1.6, null)} disabled={zoom >= maxZoomNow() - 0.001} aria-label="Zoom in" title="Zoom in (Ctrl + wheel, or the wheel in full screen); drag the road to move along it">
                  +
                </button>
                <button onClick={() => zoomAt(1, null)} disabled={zoom <= 1.001} title="Show the whole window" data-zoom-fit>
                  Fit
                </button>
              </div>
              <div className="sandbox-speed-seg">
                {SPEED_STEPS.map((s) => (
                  <button key={s} className={simSpeed === s ? "active" : ""} onClick={() => setSimSpeed(s)}>
                    {s}×
                  </button>
                ))}
              </div>
              <button
                className="nc-pill sandbox-play"
                onClick={() => {
                  // Pressing Play while reviewing means "catch up", not
                  // "resume from here" — the engine never stopped.
                  if (replayIndex !== null) { setReplayIndex(null); setRunning(true); return; }
                  setRunning((r) => !r);
                }}
              >
                {replayIndex !== null ? "Back to live" : running ? "Pause" : "Play"}
              </button>
              {/* Rewind. An incident here is over in seconds, and an operator
                  reading the metrics or watching the other carriageway misses
                  it with no way back — Reset throws the whole run away. This
                  reviews the recording; it does not rewind the engine. */}
              {/* Offered whenever the run on screen has a recording (UAT 16 Oct 2026, testers SB-15 "blocked"; 19 Oct): it used to appear only
                  while an incident or closure that had just APPEARED was still inside the 90 s recording, which at 10x is
                  nine seconds of wall time, and never for rain, so testers often had no Replay to press. With nothing of
                  the kind recorded it replays the whole recording; with one, from just before the latest. */}
              {(replayAvailable || replayIndex !== null) && (
                <button
                  className="btn-muted"
                  data-short="⟲ Replay"
                  title={
                    replayHasEvent
                      ? both ? "Replay the last incident or closure on either carriageway" : "Replay the last incident or closure on this carriageway"
                      : "Replay the last minute and a half of the road"
                  }
                  onClick={() => {
                    // The latest one on the road(s) on screen; its carriageway's recording is the one the slider walks.
                    // Only a recording of the run now on the road counts (one left over from before a rebuild does not).
                    const usable = activeDirections.filter((d) => replayRef.current[d].isOf(byDirection[d].simRef.current) && replayRef.current[d].length >= 2);
                    if (usable.length === 0) return;
                    let lead: Direction = usable.includes(focusDirection) ? focusDirection : usable[0];
                    let at: number | null = null;
                    let latest = -Infinity;
                    for (const d of usable) {
                      const buf = replayRef.current[d];
                      const i = buf.lastEventIndex();
                      const seq = i === null ? undefined : buf.frame(i)?.seq;
                      if (i !== null && (seq ?? 0) > latest) {
                        latest = seq ?? 0;
                        lead = d;
                        at = i;
                      }
                    }
                    const buf = replayRef.current[lead];
                    setRunning(false);
                    setReplayLead(lead);
                    // A few frames before it, so the operator sees it happen
                    // rather than arriving to the aftermath.
                    setReplayIndex(at === null ? 0 : Math.max(0, at - 8));
                    setReplayLen(buf.length);
                    setReplayPlaying(true);
                  }}
                >
                  {replayHasEvent ? "⟲ Replay incident" : "⟲ Replay"}
                </button>
              )}
              <button className="btn-muted" onClick={resetEverything} title="Back to a clean start: scenarios, closures, speed limits, incidents, baselines and any lane reallocation are all cleared">
                Reset
              </button>
              {expanded && (
                <button
                  className="btn-muted"
                  onClick={() => setRailOpen((o) => !o)}
                  title="Show or hide the controls (C)"
                  aria-pressed={railOpen}
                  data-short={railOpen ? "Hide" : "Controls"}
                >
                  {railOpen ? "Hide controls" : "Controls"}
                </button>
              )}
              <button
                className="btn-muted"
                onClick={toggleExpanded}
                title={expanded ? "Exit full screen (Esc)" : "Expand the road to fill the screen"}
                data-short={expanded ? "Exit" : undefined}
              >
                {expanded ? "Exit full screen" : "Full screen"}
              </button>
            </div>
          </div>

          {/* Replay gets its OWN row.
              It was inline in the transport row, between Reset and Controls.
              That row is already full — speeds, Pause, Replay, Reset, Controls,
              Full screen — so adding a 180px slider and three more controls
              made it collide with the buttons beside it and with the keyboard
              hints drawn over the card in full screen. A control that appears
              only sometimes must not have to fit in a row sized without it. */}
          {replayIndex !== null && (
            <div
              style={{
                display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                padding: "8px 12px", marginTop: 8,
                border: "1px solid color-mix(in srgb, var(--page-accent) 40%, transparent)",
                borderRadius: 14, background: "var(--bg-raised)",
                position: "relative", zIndex: 3,
              }}
            >
              <span style={{
                fontSize: "var(--fs-label)", fontWeight: 600, letterSpacing: "2px",
                textTransform: "uppercase", color: "var(--page-accent)", whiteSpace: "nowrap",
              }}>
                Reviewing
              </span>
              <button
                className="btn-muted"
                data-replay-play
                title={replayPlaying ? "Pause the replay" : replayIndex >= replayLen - 1 ? "Play the recording again from the start" : "Play the recording from here"}
                onClick={() => {
                  if (replayPlaying) { setReplayPlaying(false); return; }
                  // At the last frame, Play starts the recording again rather than doing nothing.
                  if (replayIndex >= replayLen - 1) setReplayIndex(0);
                  setReplayPlaying(true);
                }}
              >
                {replayPlaying ? "❚❚ Pause" : replayIndex >= replayLen - 1 ? "↺ Play again" : "▶ Play"}
              </button>
              <button className="btn-muted" title="One frame back"
                onClick={() => { setReplayPlaying(false); setReplayIndex((i) => Math.max(0, (i ?? 0) - 1)); }}>◀</button>
              <input
                type="range"
                min={0}
                max={Math.max(0, replayLen - 1)}
                value={replayIndex}
                onChange={(e) => setReplayIndex(Number(e.target.value))}
                style={{ flex: "1 1 220px", minWidth: 160, maxWidth: 420, accentColor: "var(--page-accent)" }}
                aria-label="Scrub through the recording"
              />
              <button className="btn-muted" title="One frame forward"
                onClick={() => { setReplayPlaying(false); setReplayIndex((i) => Math.min(replayLen - 1, (i ?? 0) + 1)); }}>▶</button>
              <span style={{
                fontSize: "var(--fs-label)", color: "var(--text-secondary)",
                fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
              }}>
                {(() => {
                  const f = replayRef.current[replayLead].frame(replayIndex);
                  const last = replayRef.current[replayLead].lastTime;
                  if (!f || last === null) return "reviewing";
                  const behind = last - f.time;
                  return behind < 0.2 ? "end of the recording (the live road is paused here)" : `${behind.toFixed(1)}s behind live`;
                })()}
              </span>
              <button className="btn-primary" onClick={() => { setReplayIndex(null); setRunning(true); }}>
                Back to live
              </button>
            </div>
          )}

          {/* Docked, the Carriageway choice is the strip under the page header, and Forecast day
              lives in .sandbox-toprow — full screen covers both, so the card carries its own copy
              of each here while it is open, plus the key hints and the notes toggle (moved in here
              from where it used to render, down by the canvas). These stay inside sandbox-hud-top,
              right after the head above, so they stack below whatever height the head actually
              rendered at instead of a fixed pixel offset from the top. */}
          {expanded && (
            <>
              <div className="sandbox-hud-row">
                <div className="sandbox-view-seg" role="tablist" aria-label="Carriageway view, full screen">
                  <span className="k">Carriageway</span>
                  <div className="sandbox-view-buttons">
                    {(["Both", "NB", "SB"] as const).map((v) => (
                      <button
                        key={v}
                        role="tab"
                        aria-selected={view === v}
                        className={view === v ? "active" : ""}
                        onClick={() => setView(v)}
                        title={viewTitle(v)}
                      >
                        {viewLabel(v)}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Full screen covers the "Simulate a Forecast Day" panel and its Load button, so picking a day
                    here also loads it: the road runs the day chosen, rather than a day only shown in the clock. */}
                <div
                  className="sandbox-view-seg sandbox-forecast-seg"
                  title="Picking a day here loads it into the simulation: its inflow, incidents and vehicle mix for the hour."
                >
                  <span className="k">Forecast day</span>
                  <ForecastDayPicker
                    value={forecast.date}
                    dates={forecast.data?.availableDates ?? []}
                    coverageEnd={forecast.data?.incidents.coverageEnd ?? null}
                    onChange={(d) => {
                      pickForecastDay(d);
                      setForecastFollowing(true);
                    }}
                    disabled={!forecast.data}
                  />
                  {forecast.busy && <span className="k">Loading…</span>}
                </div>
                <p className="sandbox-fs-keys" aria-hidden>
                  <b>Space</b> play/pause · <b>1–4</b> speed · <b>B/N/S</b> carriageway · <b>C</b> controls · <b>Esc</b> exit
                </p>
                <button
                  className="sandbox-fs-notes-toggle"
                  onClick={() => setNotesOpen((o) => !o)}
                  aria-expanded={notesOpen}
                  data-short={notesOpen ? "Hide notes" : "Notes"}
                >
                  {notesOpen ? "Hide notes" : "Notes, legend & recommendation"}
                </button>
              </div>
            </>
          )}
          </div>
          {both && placeNote !== null && !expanded && (
            <p className="sandbox-place-hint" data-place-note>
              {placeNote}
            </p>
          )}
          {view === "Both" && !expanded && (
            <details className="nc-details sandbox-both-details">
              <summary>Details</summary>
              <p className="sandbox-live-note">
                Both carriageways run together, median-separated, lane 1 against the median on each
                side. Every control, event and readout below belongs to one carriageway and says which.
                The few things that can address only one road at a time — the Command prompt and the
                Add-event picker — each carry their own NB / SB choice;
                with a placing tool armed, clicking a lane on either road changes that road.
              </p>
            </details>
          )}

          {/* A floor, not a fixed height. This was pinned to the lane count so
              a stretched canvas could not open a dead band above and below the
              road — but that also meant the card could never reach the height
              of the control rail beside it, and the difference showed as empty
              page under the recommendation.
              With DOCKED_LANE_MAX above LANE_PX, render() widens the lanes to
              use whatever height the canvas is given, so the card can stretch
              and the road grows to match. The min-height keeps the road at its
              usual size whenever the rail is shorter than it.
              Both mode's floor is the same idea doubled: both carriageways at
              their own natural LANE_PX, plus the median and (if any exit is in
              view) both ramp gutters — docked mode would rather grow the card
              than compress a lane, which is the "taller canvas" option D3's
              pre-build legibility note called for whenever the budget is
              actually tight (see the D3 report — expanded mode is the one with
              a real ceiling; docked has never had one).
              Draws both carriageways in Both mode (renderBoth), the one active
              direction full-height otherwise (render) — see the rAF loop above. */}
          <canvas
            ref={canvasRef}
            className={`sandbox-canvas ${placingArmed ? "placing" : ""}${draggedFamily !== null ? " is-drop-target" : ""}`}
            style={
              expanded
                ? undefined
                : {
                    minHeight:
                      view === "Both"
                        ? (nb.laneCount + sb.laneCount) * LANE_PX +
                          MEDIAN_GUTTER_PX +
                          gutterFloorPx(facDepthNB, exitsRef.current.length > 0, facBarrierOf("NB")) +
                          gutterFloorPx(facDepthSB, exitsRef.current.length > 0, facBarrierOf("SB")) +
                          CANVAS_PAD * 2
                        : focused.laneCount * LANE_PX +
                          (facDepthOf(focusDirection) > 0 ? gutterFloorPx(facDepthOf(focusDirection), false, facBarrierOf(focusDirection)) : 0) +
                          CANVAS_PAD * 2,
                  }
            }
            onClick={handleCanvasClick}
            onMouseDown={startPan}
            onDoubleClick={(e) => {
              // Double-click: in to about 180 m across, on the spot clicked (or back out, when already that close).
              const rect = e.currentTarget.getBoundingClientRect();
              const near = Math.max(1, Math.min(maxZoomNow(), segLengthM / 180));
              zoomAt(roadView.zoom >= near - 0.01 ? 1 : near, e.clientX - rect.left);
            }}
            onMouseMove={(e) => {
              trackPointer(e);
              previewClosureAt(e);
            }}
            onMouseLeave={() => {
              pointerRef.current = null;
            }}
            onDragOver={dragOverRoad}
            onDragLeave={() => {
              dropGhostRef.current = null;
            }}
            onDrop={dropOnRoad}
          />

          {/* Full screen: the readout strip along the bottom of the card, in the band the canvas leaves for it
              (--fs-strip). Docked, the same tiles render above the grid instead. */}
          {expanded && metricTiles}

          {/* Wrapper so the legend and the recommendation can sit side by side
              when expanded. `display: contents` while docked means it changes
              nothing there. The notes toggle button itself now renders up in
              sandbox-hud-top, alongside the Carriageway strip, so it stacks
              in flow with everything else in full screen's top HUD instead
              of floating independently. */}
          <div
            className={`sandbox-footbar${expanded && !notesOpen ? " is-folded" : ""}`}
            data-both={both || undefined}
          >
          {/* Both mode: one card per carriageway — its recommendation first (the prescriptive output), then what
              the panel must never hide (a warm-up reading is the road filling, not the scenario; demand the
              segment cannot take queues upstream where nothing draws it), then its before/after — and the legend
              once, under both. NB-only/SB-only keeps the single column. */}
          {both ? (
            activeDirections.map((dn) => {
              const d = byDirection[dn];
              return (
                <section key={dn} className="sandbox-dir-card" data-dir={dn}>
                  <div className={`sandbox-reco ${recommendations[dn].tone}`} data-reco={dn}>
                    <strong>
                      <DirectionPill direction={dn} long /> Prescriptive recommendation
                      <span className="nc-tag-illustrative">Simulation</span>
                    </strong>
                    <p>{recommendations[dn].text}</p>
                  </div>
                  <DirectionNotes d={d} direction={dn} />
                  {/* With events the comparison needs no capture: it is the same run without them (eventCompare). */}
                  {d.metrics && (d.eventCompare || (d.baseline && d.anyChange)) ? (
                    <CompareBlock d={d} direction={dn} />
                  ) : (
                    <p className="sandbox-compare-none" data-compare-none={dn}>
                      No before/after yet: add an event to compare the run with and without it, or capture a baseline and then change something on this carriageway.
                    </p>
                  )}
                </section>
              );
            })
          ) : (
            <>
              <div className={`sandbox-reco ${recommendation.tone}`}>
                <strong>
                  Prescriptive recommendation
                  <span className="nc-tag-illustrative">Simulation</span>
                </strong>
                <p>{recommendation.text}</p>
              </div>
              {focused.metrics && !focused.metrics.warm && (
                <p className="sandbox-live-note">
                  Warming up &mdash; the road is still filling, so these figures are not yet the
                  scenario. {Math.max(0, Math.ceil(WARMUP_S - focused.metrics.elapsedS))}s to go.
                </p>
              )}
              {/* Keyed off the peak, not the live reading alone — see the matching
                  comment in DirectionNotes — so a backup that has since cleared
                  still shows that it happened, not just that the road is clear now. */}
              {focused.metrics && focused.metrics.warm && focused.peakUnmetVehPerHour > 1 && (
                <p className="sandbox-live-note warn">
                  Peak {Math.round(focused.peakUnmetVehPerHour).toLocaleString()} veh/h of demand couldn&rsquo;t
                  enter this run (currently {Math.round(focused.metrics.unmetVehPerHour).toLocaleString()} veh/h):
                  the segment was at capacity and the queue for it forms upstream, outside this model. The speeds
                  shown describe only the traffic that got on.
                </p>
              )}
              <CompareBlock d={focused} direction={null} />
            </>
          )}
          {/* The readouts over time, per carriageway shown: what the strip above can only show as a moment. */}
          <TrendCharts
            series={activeDirections.map((dn) => {
              const d = byDirection[dn];
              return {
                direction: dn,
                samples: d.trend.samplesOf(d.simRef.current),
                baseline: d.baseline,
                events: d.scenarioEvents.map((e) => ({ id: e.id, name: e.name, startS: e.startS, endS: e.endS })),
              };
            })}
            clockStartMin={clockStartMin}
          />
          <div className="sandbox-legend">
            <span><i className="veh veh-1" /> Class 1 · light (car)</span>
            <span><i className="veh veh-2" /> Class 2 · medium (bus)</span>
            <span><i className="veh veh-3" /> Class 3 · heavy (truck)</span>
            <span data-legend="motorcycle">
              <i className="veh veh-m" /> Motorcycle · {(ASSUMPTIONS.MOTORCYCLE_SHARE_OF_CLASS_1.value * 100).toFixed(1)}% of Class 1, from NLEX&apos;s records
            </span>
            <span><i style={{ background: "#dc2626" }} /> stopped / incident</span>
            <span><i style={{ background: "#f59e0b" }} /> scenario event</span>
          </div>
          </div>
        </article>

        {/* Controls */}
        <aside className={`sandbox-side${expanded ? " is-expanded" : ""}${expanded && !railOpen ? " is-folded" : ""}`}>
          <div className="sandbox-side-head">
            <h2>{sideMode === "command" ? "SmartFlow Copilot" : "Simulation Controls"}</h2>
            <div className="sandbox-mode-seg" role="tablist">
              <button
                role="tab"
                aria-selected={sideMode === "controls"}
                className={sideMode === "controls" ? "active" : ""}
                onClick={() => setSideMode("controls")}
              >
                Controls
              </button>
              <button
                role="tab"
                aria-selected={sideMode === "command"}
                className={sideMode === "command" ? "active" : ""}
                onClick={() => setSideMode("command")}
              >
                Command
              </button>
            </div>
          </div>

          {sideMode === "controls" ? (
          <div className="sandbox-side-scroll">
          <RailSection
            title="Corridor"
            open={openSection === "corridor"}
            onToggle={() => toggleSection("corridor")}
            summary={`${originExit ? displayExitName(originExit.exit_name) : "?"} → ${destExit ? displayExitName(destExit.exit_name) : "?"} · ${view} · ${focused.laneCount} lanes · ${fmt(focused.inflow)} veh/hr`}
          >
          <div className="sandbox-slider-header" style={{ marginBottom: 6 }}>
            <span className="sandbox-slider-hint">Choose by</span>
            <div className="sandbox-mode-seg" role="tablist" aria-label="Choose the stretch by">
              <button role="tab" aria-selected={entryMode === "exits"} className={entryMode === "exits" ? "active" : ""}
                onClick={() => setEntryMode("exits")} title="Pick an origin and a destination exit">
                Exits
              </button>
              <button role="tab" aria-selected={entryMode === "km"} className={entryMode === "km" ? "active" : ""}
                onClick={() => setEntryMode("km")} title="Type a km range anywhere on the corridor; the exits around it are picked for you">
                Km range
              </button>
            </div>
          </div>
          {entryMode === "exits" && (
          /* Side by side: two full-width selects stacked cost a whole row of
             rail height for no gain, and a route reads better as one line. */
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ flex: 1, minWidth: 0 }}>
              Origin
              <select value={origin} onChange={(e) => setOrigin(Number(e.target.value))}>
                {EXITS.map((ex, i) => (
                  <option key={ex.exit_id} value={i} disabled={i === destination}>
                    {displayExitName(ex.exit_name)} (Km {fmtKm(ex.km)})
                  </option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1, minWidth: 0 }}>
              Destination
              <select value={destination} onChange={(e) => setDestination(Number(e.target.value))}>
                {EXITS.map((ex, i) => (
                  <option key={ex.exit_id} value={i} disabled={i === origin}>
                    {displayExitName(ex.exit_name)} (Km {fmtKm(ex.km)})
                  </option>
                ))}
              </select>
            </label>
          </div>
          )}
          {/* The stretch under study, as official km posts. An operator asks about
              "km 20.5 to km 23"; the simulation is parameterised on length, so it
              models exactly that rather than a fixed sample. The fields show and
              take official posts; the state underneath stays measured km. */}
          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <InfoLabel
                info={`Route runs ${fmtKmRange(routeFromKm, routeToKm, 2)}.${nearestExit ? ` Nearest exit: ${displayExitName(nearestExit.exit_name)}.` : ""} Changing the segment resets the run.`}
              >
                Segment
              </InfoLabel>
              <span className="sandbox-slider-value" style={{ color: "var(--text-primary)" }}>
                {(segLengthM / 1000).toFixed(2)} km
              </span>
            </div>
            {entryMode === "km" ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label style={{ flex: 1, minWidth: 0 }}>
                <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>From km</span>
                <KmInput
                  value={fromKm}
                  min={corridorMinKm}
                  max={corridorMaxKm}
                  onCommit={(v) => frameKmRange(v, toKm)}
                  testId="window-from"
                />
              </label>
              <label style={{ flex: 1, minWidth: 0 }}>
                <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>To km</span>
                <KmInput
                  value={toKm}
                  min={corridorMinKm}
                  max={corridorMaxKm}
                  onCommit={(v) => frameKmRange(fromKm, v)}
                  testId="window-to"
                />
              </label>
            </div>
            ) : (
              <span className="sandbox-slider-hint">
                {fmtKmRange(fromKm, toKm, 2)} of the route.{" "}
                <button type="button" className="sandbox-link-btn" onClick={() => setEntryMode("km")}
                  style={{ background: "none", border: "none", padding: 0, color: "var(--page-accent)", cursor: "pointer", font: "inherit" }}>
                  Set a km range
                </button>
              </span>
            )}
            {/* Only what is true of THIS view right now stays under the field — where the window opened,
                and why the road has switched to a density view or been capped. The static explanation
                (route, nearest exit, that a change resets the run) is behind the "i". */}
            {(hotspot || tooFineToDraw || spanCapped) && (
              <span className="sandbox-slider-hint">
                {hotspot
                  ? incidentCovered
                    ? `Opened at ${hotspot} — the highest incident risk on this route for the selected day. `
                    : `Opened at ${hotspot}, chosen on an earlier forecast day — the selected day has no incident forecast yet. `
                  : ""}
                {tooFineToDraw
                  ? `At ${(segLengthM / 1000).toFixed(2)} km a car is ${carPx.toFixed(1)} px wide, so the road switches to a density view — colour is mean speed, green running to red stopped. Narrow to roughly ${(maxLegibleM / 1000).toFixed(1)} km or less to see individual vehicles.`
                  : spanCapped
                    ? `Drawing is capped at ${(MAX_SEG_M / 1000).toFixed(1)} km. Narrow the range to study a longer route in parts.`
                    : ""}
              </span>
            )}
          </div>

          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <InfoLabel
                info={
                  forecastDay
                    ? `Loaded from the forecast for ${new Date(`${forecastDay}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.`
                    : focused.dataAnchor
                      ? `Observed NLEX peak ≈ ${fmt(focused.dataAnchor)} veh/hr.`
                      : "Vehicle entry rate."
                }
              >
                {view === "Both" ? `Inflow (${focusDirection})` : "Inflow"}
              </InfoLabel>
              <span className="sandbox-slider-value" style={{ color: "var(--page-accent)" }}>{fmt(focused.inflow)} veh/hr</span>
            </div>
            <input
              type="range"
              min={1000}
              max={8000}
              step={100}
              value={focused.inflow}
              onChange={(e) => focused.setInflow(Number(e.target.value))}
              className="sandbox-range inflow"
              style={{ "--range-pct": `${((focused.inflow - 1000) / 7000) * 100}%` } as React.CSSProperties}
            />
          </div>
          {/* Both mode: the OTHER direction's inflow, right below the focused one's — D2.3's "show
              both inflow sliders in Both mode". Switching focus (the NB/SB tabs above the canvas)
              brings that direction's full slider (with its own basis/forecast hint) into the primary
              slot above; this one stays a compact second control so both are always reachable without
              a focus switch just to nudge a number. */}
          {view === "Both" && (
            <div className="sandbox-slider-group">
              <div className="sandbox-slider-header">
                <span className="sandbox-slider-label">Inflow ({focusDirection === "NB" ? "SB" : "NB"})</span>
                <span className="sandbox-slider-value" style={{ color: "var(--page-accent)" }}>
                  {fmt(byDirection[focusDirection === "NB" ? "SB" : "NB"].inflow)} veh/hr
                </span>
              </div>
              <input
                type="range"
                min={1000}
                max={8000}
                step={100}
                value={byDirection[focusDirection === "NB" ? "SB" : "NB"].inflow}
                onChange={(e) => byDirection[focusDirection === "NB" ? "SB" : "NB"].setInflow(Number(e.target.value))}
                className="sandbox-range inflow"
                style={{ "--range-pct": `${((byDirection[focusDirection === "NB" ? "SB" : "NB"].inflow - 1000) / 7000) * 100}%` } as React.CSSProperties}
              />
            </div>
          )}

          {/* The chosen route as one list: each junction from the origin to the
              destination with its toll plazas on the same row, service areas
              between them. Click to frame; two junctions span the road between them. */}
          <div className="sandbox-slider-group" data-places>
            <button
              onClick={() => setPlacesOpen((o) => !o)}
              aria-expanded={placesOpen}
              className="sandbox-slider-header"
              style={{ width: "100%", background: "none", border: 0, padding: 0, cursor: "pointer" }}
            >
              <span className="sandbox-slider-label" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none"
                     style={{ transform: placesOpen ? "rotate(90deg)" : "none", transition: "transform 140ms ease" }}>
                  <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Exits, entries &amp; gas stations
              </span>
              <span className="sandbox-slider-value is-info">{DIRECTION_NAME[focusDirection]}</span>
            </button>
            {placesOpen && (
              <>
                {/* Its own NB / SB choice, like Add to and Commands apply to: the plazas differ by carriageway. */}
                {both && <FocusSwitch label="Showing" focus={focusDirection} directions={activeDirections} onFocus={chooseFocus} />}
                <PlacesList
                  junctions={EXITS}
                  places={focused.places}
                  placesInView={new Set(focused.facilities.map((f) => f.id))}
                  view={{ fromKm, toKm }}
                  route={{ fromKm: routeFromKm, toKm: routeToKm }}
                  direction={focusDirection}
                  onJunction={(j) => frameJunction(j.km)}
                  onPlace={(pl) => framePlace(pl, focusDirection)}
                />
                <div className="sandbox-btn-row">
                  <button className="btn-muted" style={{ flex: 1 }} onClick={fitRoute}
                          title="Widen the drawn window to the whole origin-to-destination route, as far as it can still be drawn legibly.">
                    Fit whole route
                  </button>
                </div>
                <span className="sandbox-slider-hint">
                  Click a row to frame it. Only what lies between your origin and destination is listed. Between Balintawak and the Bocaue Barrier you pay on entry, so exits there are free. Plazas: OpenStreetMap (© OpenStreetMap contributors), or estimated from the toll record.
                </span>
              </>
            )}
          </div>

          {/* Direction used to be DERIVED from origin > destination, with a Swap button to reverse
              it — removed in Phase D2, not repurposed: origin/destination now define the km window
              only (routeFromKm/routeToKm already take the min/max regardless of which was picked
              first), so swapping them changes nothing to swap. Which carriageway(s) run is the NB /
              SB / Both selector above the road. This block is read-only status, kept here because an
              operator scanning the Corridor section for "which way" should still find an answer. */}
          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <InfoLabel info="NLEX runs from Balintawak (Km 12) north to Sta. Ines (Km 87), on the official km posts. Choose the carriageway with the Carriageway control at the top of the page. The km axis is fixed — the Balintawak end, the lower km posts, is always on-screen-left — and it is the TRAFFIC that runs right to left when southbound; each direction's inflow anchors to its own observed volume, independently. Both mode draws the two carriageways stacked with a median between them, Southbound above and Northbound below, sharing this one axis — lane 1 sits against the median on both sides.">
                Carriageway
              </InfoLabel>
              <span className="sandbox-slider-value is-info">
                {view === "Both" ? "Both" : focusDirection === "NB" ? "Northbound" : "Southbound"}
              </span>
            </div>
          </div>

          {/* Lanes follow the road: each carriageway's width over the stretch on screen (segmentLanes). Shown as a
              fact, with the sliders folded away behind "Change lanes" as an override. */}
          <div className="sandbox-slider-group" data-lanes={lanesBy}>
            <div className="sandbox-slider-header">
              <InfoLabel info={laneInfo}>Lanes</InfoLabel>
              <span className="sandbox-slider-value" style={{ color: lanesBy === "road" ? "var(--color-success)" : "var(--color-warning)" }}>
                {laneDirs.length > 1 ? laneDirs.map((d) => `${d} ${byDirection[d].laneCount}`).join(" · ") : byDirection[laneDirs[0]].laneCount}
              </span>
            </div>
            <span className="sandbox-slider-hint" data-lanes-note>{laneNote}</span>
            <div className="sandbox-btn-row">
              <button className={`btn-muted${lanesOpen ? " active" : ""}`} aria-expanded={lanesOpen} onClick={() => setLanesOpen((o) => !o)}>
                {lanesOpen ? "Done" : "Change lanes"}
              </button>
              {lanesBy === "hand" && (
                <button className="btn-muted" onClick={lanesBackToRoad} title="Put each carriageway back to the lane count the road has here">
                  Back to the road&apos;s
                </button>
              )}
            </div>
          </div>
          {lanesOpen && (
          <>
          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">{view === "Both" ? `Lanes (${focusDirection})` : "Lanes"}</span>
              <span className="sandbox-slider-value" style={{ color: laneOverridden ? "var(--color-warning)" : "var(--color-success)" }}>
                {focused.laneCount}
              </span>
            </div>
            <input
              type="range"
              min={2}
              max={laneSliderMax}
              step={1}
              value={focused.laneCount}
              onChange={(e) => focused.setLaneCount(Number(e.target.value))}
              className="sandbox-range lanes"
              style={{ "--range-pct": laneSliderPct(focused.laneCount) } as React.CSSProperties}
            />
          </div>
          {/* Both mode: the other direction's own lane count, independently adjustable — D2.4's "per-direction lane count, defaulting to the same value" (both start from segmentLanes; either can diverge from here). */}
          {view === "Both" && (
            <div className="sandbox-slider-group">
              <div className="sandbox-slider-header">
                <span className="sandbox-slider-label">Lanes ({focusDirection === "NB" ? "SB" : "NB"})</span>
                <span className="sandbox-slider-value" style={{ color: "var(--color-success)" }}>
                  {byDirection[focusDirection === "NB" ? "SB" : "NB"].laneCount}
                </span>
              </div>
              <input
                type="range"
                min={2}
                max={laneSliderMax}
                step={1}
                value={byDirection[focusDirection === "NB" ? "SB" : "NB"].laneCount}
                onChange={(e) => byDirection[focusDirection === "NB" ? "SB" : "NB"].setLaneCount(Number(e.target.value))}
                className="sandbox-range lanes"
                style={{ "--range-pct": laneSliderPct(byDirection[focusDirection === "NB" ? "SB" : "NB"].laneCount) } as React.CSSProperties}
              />
            </div>
          )}
          </>
          )}

          </RailSection>

          <RailSection
            title="Interventions"
            open={openSection === "interventions"}
            onToggle={() => toggleSection("interventions")}
            summary={
              (zipper !== null ? `${REALLOCATION_NAME}: ${zipper.toward} +${zipper.lanes} · ` : "") +
              (both ? `NB: ${nb.interventionSummary} · SB: ${sb.interventionSummary}` : focused.interventionSummary)
            }
          >

          {/* NB-only/SB-only: the controls for the one carriageway, unchanged. Both mode: one full set per
              carriageway, each in its own named, coloured panel — what a button changes is read off the
              panel it sits in, not off which direction happens to be focused. */}
          {both ? (
            activeDirections.map((dn) => (
              <DirectionPanel key={dn} direction={dn} note="every control in this panel changes this carriageway only">
                <InterventionControls d={byDirection[dn]} fromKm={fromKm} toKm={toKm} onArm={(kind) => armPlacing(dn, kind)} />
              </DirectionPanel>
            ))
          ) : (
            <InterventionControls d={focused} fromKm={fromKm} toKm={toKm} onArm={(kind) => armPlacing(focusDirection, kind)} />
          )}
          {/* Lane reallocation lends lanes from one carriageway to the other, so it acts on both and sits
              outside the per-carriageway panels above. Both mode only. */}
          {both && (
            <ZipperControl
              counts={laneCounts}
              state={zipper}
              onChoose={chooseZipper}
              stretch={stretchNow}
              stretchError={reallocError ?? (stretchPlan.ok ? null : stretchPlan.reason)}
              stretchOk={stretchPlan.ok}
              routeFromKm={routeFromKm}
              routeToKm={routeToKm}
              onStretch={editStretch}
            />
          )}

          </RailSection>

          <RailSection
            title="Scenario events"
            open={openSection === "scenarios"}
            onToggle={() => toggleSection("scenarios")}
            summary={scenarioSummary}
          >
            {/* What the loaded forecast put on this stretch, and why so few: its count is the whole corridor's. */}
            {forecastIncidents && (
              <span className="sandbox-slider-hint" data-forecast-incidents>
                {`Forecast for ${hourOfDay != null ? `${String(hourOfDay).padStart(2, "0")}:00` : "the peak hour"}: ${forecastIncidents.hourly} incidents on the whole corridor; about ${Math.round(ON_CARRIAGEWAY_SHARE * 100)}% happen on the expressway itself, shared out by where they happen. On this stretch that is ${activeDirections.map((d) => `${d} ${forecastIncidents.expected[d].toFixed(2)}`).join(" · ")} expected; this run drew ${activeDirections.map((d) => `${d} ${byDirection[d].forecastAdded}`).join(" · ")}, listed below as events.`}
              </span>
            )}
            {/* Every event names its carriageway (D2 correction #1: it carries its direction explicitly AND
                lives in that direction's list). NB-only/SB-only: this panel, unchanged, for the one
                carriageway. Both mode: an "Add to" picker (which also moves the page's focus), both
                directions' events grouped under their own headings with their own Skip, and the skip
                guard for long fast-forwards. */}
            <ScenarioPanel
              key={scenarioFormKey}
              directions={activeDirections}
              focus={focusDirection}
              onFocus={chooseFocus}
              data={{ NB: scenarioDataFor("NB"), SB: scenarioDataFor("SB") }}
              fromKm={fromKm}
              toKm={toKm}
              clockStartMin={clockStartMin}
              onHighlight={setHighlight}
              onLocate={zoomToKm}
              dropRef={scenarioDropRef}
              onDragFamily={(f) => {
                setDraggedFamily(f);
                if (f === null) dropGhostRef.current = null;
              }}
            />
          </RailSection>

          <RailSection
            title="Baseline comparison"
            open={openSection === "baseline"}
            onToggle={() => toggleSection("baseline")}
            summary={baselineSummary}
          >
          {/* This was a lone "Capture baseline" button whose only explanation
              lived in a title tooltip — invisible unless hovered, so nothing on
              screen said what a baseline was for or that the ORDER matters.
              Capture after closing a lane and every delta reads 0%, and the
              feature looks broken rather than misused. The procedure is now the
              UI: three steps that tick themselves off, with the button sitting
              inside the step it belongs to, and only the current step carrying
              its explanation so the panel stays short. Per carriageway in Both
              mode: each direction still shows its own warm-up and before/after
              (the two clocks are independent — see useDirectionSim — so one can
              genuinely be ready before the other), but one button captures both
              at once rather than making the operator click twice for what is, in
              practice, always the same action done on both roads together. */}
          <p className="sandbox-baseline-lede">
            Measures what an intervention costs, by comparing the road before and after it.
          </p>
          {both ? (
            <>
              <div className="sandbox-btn-row">
                <button
                  className="btn-primary"
                  onClick={() => { nb.captureBaseline(); sb.captureBaseline(); }}
                  disabled={!nb.metrics || !sb.metrics}
                  style={{ marginLeft: 0 }}
                >
                  {nb.baseline && sb.baseline ? "Re-capture both" : "Capture baseline (both)"}
                </button>
                {(nb.baseline || sb.baseline) && (
                  <button
                    className="btn-muted"
                    onClick={() => { nb.setBaseline(null); sb.setBaseline(null); }}
                  >
                    Clear both
                  </button>
                )}
              </div>
              {activeDirections.map((dn) => (
                <DirectionPanel key={dn} direction={dn} note="its own warm-up and before/after — captured together with the other carriageway by the button above">
                  <BaselineSteps d={byDirection[dn]} hideCapture />
                </DirectionPanel>
              ))}
            </>
          ) : (
            <BaselineSteps d={focused} />
          )}
          </RailSection>

          <RailSection
            title="Confidence run"
            open={openSection === "confidence"}
            onToggle={() => toggleSection("confidence")}
            summary={
              repProgress != null
                ? `running ${(repProgress * 100).toFixed(0)}%`
                : repEvents.length > 0
                  ? `off · ${repEvents.length} timed event${repEvents.length === 1 ? "" : "s"}`
                  : both
                    ? "off · one carriageway at a time"
                    : repResult
                      ? `${repResult.runs} runs · ${fmt(repResult.avgSpeedKmh.mean)} ± ${fmt(repResult.avgSpeedKmh.ci95, 1)} km/h`
                      : "not run"
            }
          >
          {/* One animated run is one sample. This re-runs the SAME scenario on
              independent seeds and reports a 95% interval, so a difference can
              be told apart from the luck of the draw. */}
          <p className="sandbox-baseline-lede">
            Re-runs the current scenario on independent seeds and reports a 95%
            confidence interval, so you can tell a real effect from noise.
          </p>
          <label className="sandbox-reps-label">
            Runs
            <input
              type="range" min={3} max={20} step={1} value={repRuns}
              disabled={repProgress != null}
              onChange={(e) => setRepRuns(Number(e.target.value))}
            />
            <b>{repRuns}</b>
          </label>
          <div className="sandbox-btn-row">
            <button
              className="btn-primary"
              onClick={runReplications}
              disabled={both || focused.scenarioEvents.length > 0}
              aria-describedby={repBlocked ? "sandbox-reps-why" : undefined}
              title={repBlocked ? "Not available: see the reason below" : undefined}
              style={{ marginLeft: 0 }}
            >
              {repProgress != null ? "Stop" : "Run"}
            </button>
            {repProgress != null && (
              <span className="sandbox-reps-prog">{(repProgress * 100).toFixed(0)}%</span>
            )}
          </div>
          {/* Every reason it is off, not just the first: Both mode used to print only its own line, so an operator
              who had added a timed event (in the view the tab opens on) was never told the event blocks it too. */}
          <div id="sandbox-reps-why" role="status">
            {both && (
              <p className="sandbox-reps-warn" data-reps="both-disabled">{"Confidence runs support one carriageway at a time."}</p>
            )}
            {repEvents.length > 0 && (
              <div className="sandbox-reps-blocked" data-reps="events-blocked">
                <p className="sandbox-reps-warn">
                  <b>{"Confidence runs don't yet support timed events."}</b>{" "}
                  {`Each run replays one fixed set of closures, limits and incidents from the start; it cannot follow when an event starts, its phases or when it ends, so with ${eventList(repEvents)} on the road it would report a different scenario from this one.`}
                </p>
                <p className="sandbox-reps-note">
                  {`Remove the event${repEvents.length === 1 ? "" : "s"} in Scenario events (or Reset) to run it on what is set by hand; the events' own effect is read from the before/after and the Trends charts.`}
                  {repResult ? " The result below was run before them and does not include them." : ""}
                </p>
              </div>
            )}
            {repStopped && !repResult && (
              <p className="sandbox-reps-warn" data-reps="stopped">Stopped: the scenario changed while it ran, so its result would not have described it.</p>
            )}
          </div>
          {repResult && (
            <div className="sandbox-reps-out">
              {([
                ["Avg speed", repResult.avgSpeedKmh, "km/h", 1],
                ["Throughput", repResult.throughputPerMin, "/min", 1],
                ["Longest queue", repResult.longestQueueM, "m", 0],
                ["CO₂ rate", repResult.co2RatePerMin, "kg/min", 2],
              ] as [string, RepStat, string, number][]).map(([label, st, unit, dp]) => (
                <div className="sandbox-reps-row" key={label}>
                  <span className="l">{label}</span>
                  <span className="v">
                    {st.mean.toFixed(dp)} <i>&plusmn; {st.ci95.toFixed(dp)} {unit}</i>
                  </span>
                </div>
              ))}
              {repResult.unmetVehPerHour.mean > 1 && (
                <p className="sandbox-reps-warn">
                  {Math.round(repResult.unmetVehPerHour.mean).toLocaleString()} veh/h of demand
                  could not enter the segment — the queue for it forms upstream, outside
                  this model, so the speeds above describe only the traffic that got on.
                </p>
              )}
              <p className="sandbox-reps-note">
                {repResult.runs} runs &times; {repResult.secondsPerRun}s, first{" "}
                {repResult.warmupS}s discarded as warm-up. Intervals are Student&rsquo;s t at 95%.
                {repFor ? ` Run on ${DIRECTION_NAME[repFor.direction]} with ${repFor.setup}.` : ""}
              </p>
            </div>
          )}
          </RailSection>
          </div>
          ) : (
          <div className="sandbox-side-scroll">
            <div className="ai-command">
              <p className="ai-command-sub">
                Type a command in English, Filipino or Taglish: close lanes or set a speed limit by km, add a crash,
                breakdown, rain or road works (on a lane or at a booth or pump), borrow a lane from the other side,
                go to a place, or change the time or forecast day. You see the actions before anything changes.
              </p>
              {/* Both mode: a command that names a carriageway ("southbound", "pa-Maynila", "both directions")
                  goes there; one that names none goes to the carriageway picked here — a deliberate,
                  always-visible choice, rather than gating every command behind a second pick. Each line of
                  the proposal below says which carriageway it changes. */}
              {both && (
                <div className="sandbox-dir-pick" data-cmd="direction" role="tablist" aria-label="Carriageway a command applies to when it names none" title="Used when the command does not say northbound or southbound">
                  <span className="k">Commands apply to</span>
                  <div className="sandbox-dir-seg">
                    {activeDirections.map((dn) => (
                      <button
                        key={dn}
                        role="tab"
                        aria-selected={focusDirection === dn}
                        className={`dir-${dn}${focusDirection === dn ? " active" : ""}`}
                        onClick={() => chooseFocus(dn)}
                      >
                        {DIRECTION_NAME[dn]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <textarea
                className="ai-command-input"
                rows={4}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={'Try: "isara lane 4 southbound mula Km 20.1 hanggang 20.4" or "may banggaan sa Meycauayan toll, booth 2, 30 minutes"'}
              />
              <button
                className="ai-command-btn"
                onClick={runCommand}
                disabled={!command.trim() || commandBusy}
              >
                {commandBusy ? `Interpreting… ${commandSince === null ? 0 : Math.floor((Date.now() - commandSince) / 1000)} s` : "Execute Command"}
              </button>
              {commandBusy && (
                <button className="ai-plan-discard" data-cmd="cancel" onClick={() => commandAbortRef.current?.abort("cancel")}>
                  Cancel
                </button>
              )}

              {commandError && <p className="ai-command-error">{commandError}</p>}

              {/* A proposal, not a change. Nothing reaches the simulation until
                  the operator presses Apply. */}
              {plan && (
                <div className="ai-plan">
                  {both && planDirection !== null && (
                    <p className="ai-plan-target" data-plan-direction={planDirection}>
                      Each line names the carriageway it changes; one the command did not name went to <DirectionPill direction={planDirection} long />
                    </p>
                  )}
                  <p className="ai-plan-reply">{plan.reply}</p>

                  {plan.actions.length > 0 ? (
                    <ul className="ai-plan-actions">
                      {plan.actions.map((a, i) => (
                        <li key={i}>{describeAction(a, commandLookup)}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="ai-plan-empty">No actions to apply.</p>
                  )}

                  {plan.unsupported && (
                    <p className="ai-plan-warn">Not applied: {plan.unsupported}</p>
                  )}
                  {plan.warnings.map((w, i) => (
                    <p className="ai-plan-warn" key={i}>{w}</p>
                  ))}

                  <div className="ai-plan-buttons">
                    <button
                      className="ai-plan-apply"
                      onClick={applyPlan}
                      disabled={plan.actions.length === 0}
                    >
                      Apply
                    </button>
                    <button className="ai-plan-discard" onClick={() => setPlan(null)}>
                      Discard
                    </button>
                  </div>
                </div>
              )}

              {commandNote && <p className="ai-command-note">{commandNote}</p>}
            </div>
          </div>
          )}
        </aside>
      </div>
    </section>
  );
}


/**
 * A km-post field you can actually type in.
 *
 * It shows and takes the OFFICIAL km post; value, min, max and what onCommit
 * receives are MEASURED km (lib/km-post.ts), converted here at the edge.
 *
 * The value shown is derived and clamped to the route, so binding the input
 * straight to it fought every keystroke: "1.15" was re-read after "1", after
 * "1." (NaN) and after "1.1", an emptied field parsed as 0 and snapped to the
 * route start, and the caret jumped. This keeps the raw text while the field
 * has focus and commits once — on blur or Enter — so the clamping happens to a
 * number the operator has finished writing.
 */
function KmInput({
  value,
  min,
  max,
  onCommit,
  disabled = false,
  testId,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (km: number) => void;
  disabled?: boolean;
  /** A stable hook for the browser checks. */
  testId?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft == null) return;
    const n = Number.parseFloat(draft);
    setDraft(null);
    // An unparseable or empty entry reverts rather than silently becoming zero. So does a km outside the field's
    // range: it used to be taken and then clamped, so Km 11.9 quietly became Km 12 (TC-UT-23, 2 Nov 2026).
    const km = Number.isFinite(n) ? kmMeasured(n) : NaN;
    if (Number.isFinite(km) && km >= min - 1e-6 && km <= max + 1e-6) onCommit(km);
  };

  return (
    <input
      type="number"
      className="sandbox-km-input"
      data-km={testId}
      min={Number(kmPost(min).toFixed(2))}
      max={Number(kmPost(max).toFixed(2))}
      step={0.05}
      disabled={disabled}
      value={draft ?? fmtKm(value, 2)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setDraft(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/**
 * The lane reallocation control: move one lane from one carriageway to the other. Each option shows whether it is possible from the lane counts the road would have with the scheme off, and
 * says why not when it is not; "Off" puts the original counts back. Both mode only.
 */
function ZipperControl({
  counts,
  state,
  onChoose,
  stretch,
  stretchError,
  stretchOk,
  routeFromKm,
  routeToKm,
  onStretch,
}: {
  counts: Readonly<Record<Direction, number>>;
  state: ZipperState | null;
  onChoose: (toward: Direction | null, lanes: number) => void;
  /** The stretch the barrier moves over (km), and whether it can be simulated; why not when it cannot. */
  stretch: { readonly fromKm: number; readonly toKm: number };
  stretchError: string | null;
  stretchOk: boolean;
  routeFromKm: number;
  routeToKm: number;
  onStretch: (which: "from" | "to", km: number) => void;
}) {
  const base = state === null ? counts : state.base;
  const options: readonly { readonly toward: Direction; readonly lanes: number }[] = [
    // One lane, as NLEX opens a single lane of the opposite bound (ASSUMPTIONS.ZIPPER_LANES.maxTransfer).
    { toward: "NB", lanes: 1 },
    { toward: "SB", lanes: 1 },
  ];
  return (
    <div className="sandbox-slider-group sandbox-zipper" data-zipper={state === null ? "off" : `${state.toward}+${state.lanes}`}>
      <div className="sandbox-slider-header">
        <InfoLabel info={REALLOCATION_INFO}>{REALLOCATION_NAME}</InfoLabel>
        <span className="sandbox-slider-value" style={{ color: state === null ? "var(--text-muted)" : "var(--text-primary)" }}>
          {state === null ? "off" : `${state.toward} +${state.lanes}`}
        </span>
      </div>
      <div className="sandbox-realloc-km" data-zipper-stretch>
        <div className="sandbox-realloc-km-row">
          <label>
            <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>From km</span>
            <KmInput value={stretch.fromKm} min={routeFromKm} max={routeToKm} onCommit={(km) => onStretch("from", km)} testId="realloc-from" />
          </label>
          <label>
            <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>To km</span>
            <KmInput value={stretch.toKm} min={routeFromKm} max={routeToKm} onCommit={(km) => onStretch("to", km)} testId="realloc-to" />
          </label>
        </div>
        {stretchError !== null && (
          <span className="sandbox-slider-hint sandbox-realloc-error" data-zipper-note="stretch-error">
            {stretchError}
          </span>
        )}
      </div>
      <div className="sandbox-dir-seg zip" role="radiogroup" aria-label="Move lanes between the carriageways">
        <button role="radio" aria-checked={state === null} className={state === null ? "active" : ""} data-zipper-option="off" onClick={() => onChoose(null, 0)}>
          Off
        </button>
        {options.map((o) => {
          const plan = planZipper(base, o.toward, o.lanes);
          const on = state !== null && state.toward === o.toward && state.lanes === o.lanes;
          return (
            <button
              key={`${o.toward}${o.lanes}`}
              role="radio"
              aria-checked={on}
              className={on ? "active" : ""}
              disabled={(!plan.ok || !stretchOk) && !on}
              data-zipper-option={`${o.toward}+${o.lanes}`}
              title={!plan.ok ? plan.reason : !stretchOk && !on ? (stretchError ?? "Give a stretch first.") : `${o.toward} takes ${o.lanes} lane${o.lanes === 1 ? "" : "s"} from ${o.toward === "NB" ? "SB" : "NB"}`}
              onClick={() => onChoose(o.toward, o.lanes)}
            >
              {o.toward} +{o.lanes}
            </button>
          );
        })}
      </div>
      {/* What is true right now stays visible while the scheme is on; what the control IS and what a change
          restarts is behind the "i". */}
      {state !== null && (
        <span className="sandbox-slider-hint" data-zipper-note="state">
          {`${fmtKmRange(stretch.fromKm, stretch.toKm, 2)}: NB ${counts.NB} lanes · SB ${counts.SB} lanes (was ${state.base.NB} + ${state.base.SB}). ${state.toward}'s lane 1 is the reallocated lane, against the barrier. Changing either Lanes slider ends it.`}
        </span>
      )}
    </div>
  );
}

/** One carriageway's line inside a Both-mode tile. */
type TileRow = { readonly direction: Direction; readonly value: string; readonly delta: number | null };

/**
 * Both mode's metric tile: the corridor figure on top, each carriageway's own value beneath it, always
 * visible (no hover, no expand — this is read under pressure, and a hidden number is a number missed).
 * `tag` says what KIND of headline this is, in the tile itself: "flow-weighted" for average speed, "max"
 * for the longest queue, "per direction" where there is deliberately no total. NB-only/SB-only never
 * reach this — they keep MetricTile exactly as it was.
 */
function MetricTileBoth({
  label,
  tag,
  tagTitle,
  total,
  totalDelta,
  rows,
  goodWhenUp,
}: {
  label: string;
  tag: string;
  tagTitle: string;
  /** The headline, or null where the metric has no corridor total. */
  total: string | null;
  totalDelta?: number | null;
  rows: readonly TileRow[];
  goodWhenUp?: boolean;
}) {
  const tone = (delta: number | null): string => {
    if (delta == null || Math.abs(delta) < 1) return "muted";
    return (goodWhenUp ? delta > 0 : delta < 0) ? "up" : "down";
  };
  const chip = (delta: number | null): string => (delta == null ? "" : Math.abs(delta) < 1 ? "≈" : `${delta > 0 ? "+" : ""}${delta.toFixed(0)}%`);
  return (
    <article className="sandbox-metric is-both" data-metric={label}>
      <h3>
        {label}
        <span className="sandbox-metric-tag" title={tagTitle} data-metric-tag={tag}>{tag}</span>
      </h3>
      <div className={`sandbox-metric-val${total === null ? " is-none" : ""}`}>{total ?? "no total"}</div>
      {totalDelta != null && Math.abs(totalDelta) >= 1 ? (
        <span className={`sandbox-metric-delta ${tone(totalDelta)}`}>
          {totalDelta > 0 ? "+" : ""}
          {totalDelta.toFixed(0)}% vs baseline
        </span>
      ) : (
        <span className="sandbox-metric-delta muted">{totalDelta != null ? "≈ baseline" : " "}</span>
      )}
      <div className="sandbox-metric-dirs">
        {rows.map((r) => (
          <div className="sandbox-metric-dir" key={r.direction} data-metric-dir={r.direction}>
            <DirectionPill direction={r.direction} />
            <span className="v">{r.value}</span>
            <span className={`d ${tone(r.delta)}`}>{chip(r.delta)}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

/** Both mode: a bordered, coloured, named block around whatever belongs to ONE carriageway. */
function DirectionPanel({ direction, note, children }: { direction: Direction; note?: string; children: React.ReactNode }) {
  return (
    <div className={`sandbox-dir-panel dir-${direction}`} data-dir-panel={direction}>
      <div className="sandbox-dir-panel-head">
        <DirectionPill direction={direction} long />
        {note && <InfoTooltip text={note} />}
      </div>
      {children}
    </div>
  );
}

/**
 * The Interventions controls for ONE carriageway. Rendered once (NB-only/SB-only, exactly the markup
 * this section always had) or twice, each inside its own DirectionPanel (Both). Which road a button
 * touches is decided by which `d` it was handed, never by what is focused.
 */
function InterventionControls({
  d,
  fromKm,
  toKm,
  onArm,
}: {
  d: DirectionApi;
  fromKm: number;
  toKm: number;
  /** Arm placing a closed stretch on the road. (Incidents are placed as scenario events.) */
  onArm: (kind: "closure") => void;
}) {
  return (
    <>
      <span className="sandbox-mini-label">
        Close a lane (traffic must merge out)
        <InfoTooltip text="A closure applies to closed lanes only — pick L1 to L4 above to apply it." />
      </span>
      <div className="sandbox-lane-toggles">
        {Array.from({ length: d.laneCount }, (_, i) => (
          <button
            key={i}
            className={d.closedLanes[i] || d.lockedLanes[i] ? "closed" : ""}
            onClick={() => d.toggleLane(i)}
            disabled={d.lockedLanes[i]}
            title={d.lockedLanes[i] && d.owners.closure ? `Driven by: ${describeOwner(d.owners.closure)}` : undefined}
          >
            L{i + 1}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 8 }}>
        <span className="sandbox-mini-label">
          Closed from Km {fmtKm(d.shownClosureFromKm, 2)} to Km {fmtKm(d.shownClosureToKm, 2)} ·{" "}
          {Math.round((d.shownClosureToKm - d.shownClosureFromKm) * 1000)} m
        </span>
        {d.owners.closure && (
          <p className="sandbox-live-note">
            Driven by: {describeOwner(d.owners.closure)}. The stretch is locked. You can close more lanes on it; the lanes
            the event blocks stay closed until it moves on.
          </p>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <label style={{ flex: 1, minWidth: 0 }}>
            <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>From km</span>
            <KmInput value={d.shownClosureFromKm} min={fromKm} max={toKm} onCommit={d.commitClosureStart} disabled={d.owners.closure !== null} />
          </label>
          <label style={{ flex: 1, minWidth: 0 }}>
            <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>To km</span>
            <KmInput value={d.shownClosureToKm} min={fromKm} max={toKm} onCommit={d.commitClosureEnd} disabled={d.owners.closure !== null} />
          </label>
        </div>
        {/* The instruction that used to sit here ran to three wrapped lines
            and repeated what the button beside it already says. It is
            reference material — read once, then never again — so it moves
            onto the controls it describes as a tooltip. */}
      </div>

      {/* Incidents are placed as scenario events, which give them a kind, a
          response and a timeline; the bare "Drop incident" that used to sit
          here duplicated that with less. An incident the Command tab puts on
          the road still lands among these, so it can still be cleared here —
          the button shows only when there is one to clear. */}
      <div className="sandbox-btn-row sandbox-btn-row-3">
        <button
          className={`btn-muted ${d.placingClosure ? "active" : ""}`}
          title="Traffic merges out before the start and the lane reopens after the end. Type the Km range above, or press this and click the road twice — start, then end."
          disabled={d.owners.closure !== null}
          onClick={() => onArm("closure")}
        >
          {d.placingClosure ? (d.closureDraftKm == null ? "Click start…" : "Click end…") : "Set stretch"}
        </button>
        {d.incidentCount > 0 && (
          <button className="btn-muted" onClick={d.clearIncidents}>
            Clear incidents ({d.incidentCount})
          </button>
        )}
      </div>
      <ClosureHint placing={d.placingClosure} draftKm={d.closureDraftKm} />

      <div className="sandbox-slider-group">
        <div className="sandbox-slider-header">
          <span className="sandbox-slider-label">Speed limit zone</span>
          <span className="sandbox-slider-value" style={{ color: "var(--text-primary)" }}>
            {d.shownSpeedLimit == null ? "off" : `${d.shownSpeedLimit} km/h`}
          </span>
        </div>
        {d.owners.speedZone && (
          <p className="sandbox-live-note">
            Driven by: {describeOwner(d.owners.speedZone)}. The zone and its limit are locked until the event ends.
          </p>
        )}
        <input
          type="range"
          min={20}
          max={100}
          step={5}
          value={d.shownSpeedLimit ?? 100}
          onChange={(e) => d.setSpeedLimit(Number(e.target.value) >= 100 ? null : Number(e.target.value))}
          disabled={d.owners.speedZone !== null}
          className="sandbox-range capacity"
          title="Slide to 100 to disable the zone."
          style={{ "--range-pct": `${(((d.shownSpeedLimit ?? 100) - 20) / 80) * 100}%` } as React.CSSProperties}
        />
        {/* "Slide to 100 to disable" was a whole line spent restating the
            value readout beside the title, which already says "off" the
            moment the zone is disabled. It survives as the slider's own
            tooltip. */}
        {d.shownSpeedLimit != null && (
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <label style={{ flex: 1, minWidth: 0 }}>
              <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>
                Zone from km
              </span>
              <KmInput value={d.shownZoneFromKm} min={fromKm} max={toKm} onCommit={d.setZoneFromKm} disabled={d.owners.speedZone !== null} />
            </label>
            <label style={{ flex: 1, minWidth: 0 }}>
              <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>
                Zone to km
              </span>
              <KmInput value={d.shownZoneToKm} min={fromKm} max={toKm} onCommit={d.setZoneToKm} disabled={d.owners.speedZone !== null} />
            </label>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The three-step baseline procedure for ONE carriageway — its own warm-up, its own capture, its own
 * before/after. (The explanatory lede above it is shared and stays in the section.)
 *
 * Baseline capture is a three-step procedure and the panel says so.
 * Throughput is counted over the run so far, so a snapshot taken seconds
 * after a rebuild records a near-zero flow — the road has not filled and
 * nobody has finished the segment yet — and every later comparison then
 * reads as a miracle. Hence the settling step, which is the one an operator
 * would never guess at.
 */
function BaselineSteps({ d, hideCapture }: { d: DirectionApi; hideCapture?: boolean }) {
  const elapsedS = d.metrics?.elapsedS ?? 0;
  const warmedUp = elapsedS >= WARMUP_S;
  const stepDone = [warmedUp, d.baseline != null, d.baseline != null && d.anyChange];
  const activeStep = stepDone.findIndex((x) => !x) + 1; // 0 once all are done
  const stepCls = (n: number) => `sandbox-step${stepDone[n - 1] ? " is-done" : activeStep === n ? " is-now" : ""}`;
  return (
    <>
    {/* Said here too, where an operator goes to measure something: an event is measured without any capture. */}
    {d.eventCompare && (
      <p className="sandbox-baseline-lede" data-compare-note="events">
        This carriageway has scenario events, so the before/after under the road compares the same run without them
        against the run with them, at the same moment. No capture is needed for that; a baseline still measures what you
        change by hand.
      </p>
    )}
    <ol className="sandbox-steps">
      <li className={stepCls(1)}>
        <span className="n">{stepDone[0] ? "✓" : "1"}</span>
        <div className="t">
          <b>Let the road settle</b>
          {activeStep === 1 && (
            <i>
              Throughput counts vehicles finishing the segment, so it needs about a
              minute of running before it means anything.
              {d.metrics ? ` ${Math.ceil(Math.max(0, WARMUP_S - elapsedS))}s to go.` : ""}
            </i>
          )}
        </div>
      </li>

      <li className={stepCls(2)}>
        <span className="n">{stepDone[1] ? "✓" : "2"}</span>
        <div className="t">
          <b>Capture the &ldquo;before&rdquo;</b>
          {d.baseline ? (
            <i>
              Recorded {fmt(d.baseline.avgSpeedKmh)} km/h · {fmt(d.baseline.throughputPerMin)}/min
              with {d.baseline.takenWith}.
            </i>
          ) : activeStep === 2 ? (
            <i>Freezes the current numbers for comparison. Nothing in the simulation changes.</i>
          ) : null}
          {/* In Both mode this button lives once, above both panels, and
              captures both carriageways together — see the combined button
              in the Baseline comparison section. Each panel still shows its
              own recorded numbers above; it just doesn't repeat the button. */}
          {!hideCapture && (
            <div className="sandbox-btn-row">
              <button className="btn-primary" onClick={d.captureBaseline} disabled={!d.metrics} style={{ marginLeft: 0 }}>
                {d.baseline ? "Re-capture" : "Capture baseline"}
              </button>
              {d.baseline && (
                <button className="btn-muted" onClick={() => d.setBaseline(null)}>
                  Clear
                </button>
              )}
            </div>
          )}
        </div>
      </li>

      <li className={stepCls(3)}>
        <span className="n">{stepDone[2] ? "✓" : "3"}</span>
        <div className="t">
          <b>Change something, then read the difference</b>
          {stepDone[2] ? (
            <i>
              Comparing {d.baseline?.takenWith} &rarr; {d.compareSummary}. The
              before/after table is under the road.
            </i>
          ) : activeStep === 3 ? (
            <i>
              Close a lane or set a speed limit in Interventions above, or add an event in
              Scenario events. A before/after table then appears under the road.
            </i>
          ) : null}
        </div>
      </li>
    </ol>
    </>
  );
}

/**
 * Before / after. The deltas exist as small tinted text on the metric
 * tiles, which is easy to miss and impossible to read as a whole.
 * Laid out side by side, the effect of an intervention is one
 * glance rather than four comparisons. Per carriageway: in Both mode
 * each direction gets its own, headed by its own pill.
 */
function CompareBlock({ d, direction }: { d: DirectionApi; direction: Direction | null }) {
  // A carriageway with scenario events compares the run with them against the same run without them (EventCompareBlock).
  if (d.eventCompare && d.metrics) return <EventCompareBlock d={d} direction={direction} />;
  /* One carriageway on screen and nothing to compare yet: say what is missing and offer the button here, where
     the comparison will appear, rather than only in the guide in the controls. (Both mode prints its own line
     per carriageway.) */
  if (!d.baseline || !d.metrics || !d.anyChange) {
    if (direction !== null || !d.metrics) return null;
    return (
      <div className="sandbox-compare sandbox-compare-empty" data-compare-empty>
        <b>Before / after</b>
        <span>
          {d.baseline
            ? `Baseline captured with ${d.baseline.takenWith}. Now change something — close a lane, set a speed limit, add an event — and the difference appears here.`
            : "Capture a baseline first (how the road runs before you change anything), then change something to see what it costs."}
        </span>
        {!d.baseline && (
          <button className="btn-primary" onClick={d.captureBaseline} style={{ marginLeft: 0 }} data-compare-capture>
            Capture baseline
          </button>
        )}
      </div>
    );
  }
  // "Now" is the last minute's mean, as the baseline is (recentAverage): two instants gave a different answer each second.
  const avg = recentAverage(d.trend.samplesOf(d.simRef.current));
  const nowOf = { speed: avg ? avg.speedKmh : d.metrics.avgSpeedKmh, flow: avg ? avg.throughputPerMin : d.metrics.throughputPerMin, queue: avg ? avg.queueM : d.metrics.longestQueueM, co2: avg ? avg.co2KgPerMin : d.metrics.co2RatePerMin };
  // label, was, now, unit, and whether a bigger number is the better outcome.
  const compareRows: readonly (readonly [string, number, number, string, boolean])[] = [
    ["Avg speed", d.baseline.avgSpeedKmh, nowOf.speed, "km/h", true],
    ["Throughput", d.baseline.throughputPerMin, nowOf.flow, "/min", true],
    ["Longest queue", d.baseline.longestQueueM, nowOf.queue, "m", false],
    ["CO₂ rate", d.baseline.co2RatePerMin, nowOf.co2, "kg/min", false],
  ];
  const verdict = compareVerdict(d.baseline, nowOf);
  /* Where the scenario's events stand against this comparison (SB-17): "After" is the road now, so an event that has
     not started is not in it yet, one that is over shows as the road recovering, and one already running when the
     baseline was taken is on both sides. Said, rather than left for the operator to infer from flat numbers. */
  const waiting = d.compareEvents.filter((e) => e.state === "pending");
  const over = d.compareEvents.filter((e) => e.state === "done");
  const inBoth = d.baseline.eventsRunning ?? [];
  const names = (xs: readonly { name: string }[]) => xs.map((x) => x.name).join(", ");
  const eventNotes = [
    waiting.length > 0
      ? `${names(waiting)} ${waiting.length === 1 ? "has" : "have"} not started (next in ${formatClock(Math.min(...waiting.map((e) => e.startsInS)))}), so After does not include ${waiting.length === 1 ? "it" : "them"} yet. "Skip to next phase" in Scenario events gets there sooner.`
      : null,
    over.length > 0 ? `${names(over)} ${over.length === 1 ? "is" : "are"} over: After now shows the road recovering.` : null,
    inBoth.length > 0
      ? `The baseline was captured while ${inBoth.join(", ")} ${inBoth.length === 1 ? "was" : "were"} running, so ${inBoth.length === 1 ? "its" : "their"} effect is in Before too. Capture before an event starts to measure the event itself.`
      : null,
  ].filter((x): x is string => x !== null);
  return (
    <div className="sandbox-compare" data-compare={direction ?? undefined}>
      <div className="sandbox-compare-head">
        <b>
          {direction !== null && <DirectionPill direction={direction} long />} Baseline vs now
        </b>
        <span>
          {d.baseline.takenWith} &rarr; {d.compareSummary}
        </span>
      </div>
      <p className={`sandbox-compare-verdict ${verdict.tone}`} data-compare-verdict>
        {verdict.text}
      </p>
      {eventNotes.map((t, i) => (
        <p className="sandbox-compare-foot" data-compare-events key={i}>
          {t}
        </p>
      ))}
      <CompareRows rows={compareRows} was="Before" now="After" />
      <p className="sandbox-compare-foot">
        {avg && d.baseline.averaged ? "Both sides are one-minute averages, so the figures hold steady." : "Averaged over the last minute where the run is long enough; re-capture once the road has run a minute for a steadier baseline."}
      </p>
    </div>
  );
}

/** The Before / After table: label, was, now, unit, and whether a bigger number is the better outcome, per row. */
function CompareRows({ rows, was: wasLabel, now: nowLabel }: { rows: readonly (readonly [string, number, number, string, boolean])[]; was: string; now: string }) {
  return (
    <div className="sandbox-compare-rows">
      <div className="sandbox-compare-row sandbox-compare-labels" aria-hidden>
        <span className="l" />
        <span className="was">{wasLabel}</span>
        <span className="arrow" />
        <span className="now">{nowLabel}</span>
        <span className="d" />
      </div>
      {rows.map(
        ([label, was, now, unit, higherIsBetter]) => {
          const pct = was === 0 ? null : ((now - was) / was) * 100;
          // "Better" is not the same as "bigger": a longer queue and
          // more CO2 are both worse, so the direction is declared per
          // metric rather than assumed from the sign.
          const good = pct == null ? null : higherIsBetter ? pct >= 0 : pct <= 0;
          return (
            <div className="sandbox-compare-row" key={label}>
              <span className="l">{label}</span>
              <span className="was">{fmt(was, unit === "kg/min" ? 1 : 0)}</span>
              <span className="arrow">→</span>
              <span className="now">
                {fmt(now, unit === "kg/min" ? 1 : 0)} <i>{unit}</i>
              </span>
              <span className={`d ${good == null ? "" : good ? "good" : "bad"}`}>
                {pct == null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`}
              </span>
            </div>
          );
        },
      )}
    </div>
  );
}

/**
 * Before / after with scenario events (19 Oct 2026, testers SB-17, second pass: "Scenario events are not applied in
 * the baseline comparison"). Before is the same run without the events — the no-event twin in eventTwin.ts, built
 * from this run's own seed, hour, inflow and road, holding what the operator set by hand and nothing else, stepped
 * alongside — and After is this run, both read over the same last minute of the same clock. So the difference is the
 * events', with no capture to time right: an event already running, or drawn by a forecast day when the run was
 * built, is in After and not in Before. (The captured baseline still drives the "vs baseline" figures on the tiles.)
 */
function EventCompareBlock({ d, direction }: { d: DirectionApi; direction: Direction | null }) {
  const twin = d.twinRef.current;
  const live = d.simRef.current;
  const names = (xs: readonly { name: string }[]) => xs.map((x) => x.name).join(", ");
  const head = (
    <div className="sandbox-compare-head">
      <b>
        {direction !== null && <DirectionPill direction={direction} long />} Without vs with the events
      </b>
      <span>{names(d.twinEvents)}</span>
    </div>
  );
  // Still catching up from the start of the run (just built, or after a skip): no half-way figures.
  if (!twin || !live || twin.live !== live || !d.twinState?.ready) {
    return (
      <div className="sandbox-compare" data-compare={direction ?? undefined} data-compare-twin="building">
        {head}
        <p className="sandbox-compare-foot">
          {`Running the same road without the events up to now, to compare against${d.twinState ? ` (${Math.round(d.twinState.progress * 100)}%)` : ""}…`}
        </p>
      </div>
    );
  }
  // Both sides the last minute's mean on the same 10 s grid (TrendLog), or the instant where the run is too young for one.
  const tAvg = recentAverage(twin.trend.samplesOf(twin.sim));
  const lAvg = recentAverage(d.trend.samplesOf(live));
  const tm = twin.sim.metrics();
  const lm = d.metrics ?? live.metrics();
  const averaged = tAvg !== null && lAvg !== null;
  const before = tAvg !== null && lAvg !== null
    ? { avgSpeedKmh: tAvg.speedKmh, throughputPerMin: tAvg.throughputPerMin, longestQueueM: tAvg.queueM, co2RatePerMin: tAvg.co2KgPerMin }
    : tm;
  const nowOf = tAvg !== null && lAvg !== null
    ? { speed: lAvg.speedKmh, flow: lAvg.throughputPerMin, queue: lAvg.queueM, co2: lAvg.co2KgPerMin }
    : { speed: lm.avgSpeedKmh, flow: lm.throughputPerMin, queue: lm.longestQueueM, co2: lm.co2RatePerMin };
  const rows: readonly (readonly [string, number, number, string, boolean])[] = [
    ["Avg speed", before.avgSpeedKmh, nowOf.speed, "km/h", true],
    ["Throughput", before.throughputPerMin, nowOf.flow, "/min", true],
    ["Longest queue", before.longestQueueM, nowOf.queue, "m", false],
    ["CO₂ rate", before.co2RatePerMin, nowOf.co2, "kg/min", false],
  ];
  const waiting = d.twinEvents.filter((e) => e.state === "pending");
  const over = d.twinEvents.filter((e) => e.state === "done");
  const running = d.twinEvents.filter((e) => e.state === "active");
  const verdict =
    running.length === 0 && over.length === 0
      ? // Nothing has happened yet: the two are the same run until an event's vehicles are picked out of the traffic.
        { text: "No difference yet: until an event starts, the run with the events and the run without them are the same run.", tone: "flat" as const }
      : compareVerdict(before, nowOf);
  const setByHand = d.handSetSummary;
  const notes = [
    waiting.length > 0
      ? `${names(waiting)} ${waiting.length === 1 ? "has" : "have"} not started (next in ${formatClock(Math.min(...waiting.map((e) => e.startsInS)))}). "Skip to next phase" in Scenario events gets there sooner.`
      : null,
    over.length > 0 ? `${names(over)} ${over.length === 1 ? "is" : "are"} over: the difference left is the road recovering.` : null,
  ].filter((x): x is string => x !== null);
  return (
    <div className="sandbox-compare" data-compare={direction ?? undefined} data-compare-twin="ready">
      {head}
      <p className={`sandbox-compare-verdict ${verdict.tone}`} data-compare-verdict>
        {verdict.text}
      </p>
      {notes.map((t, i) => (
        <p className="sandbox-compare-foot" data-compare-events key={i}>
          {t}
        </p>
      ))}
      <CompareRows rows={rows} was="No events" now="With events" />
      <p className="sandbox-compare-foot">
        {`"No events" is this same run (the same seed, hour, inflow and road${setByHand ? `, and what is set by hand: ${setByHand}` : ""}) run alongside without the scenario events, so the difference is the events'. `}
        {averaged ? "Both sides are the last minute's average." : "Single readings until the run has a minute of figures to average."}
      </p>
    </div>
  );
}

/**
 * The comparison as one sentence: what moved, by how much, in the words a reader would use. A change under 3%
 * is the road's own second-to-second noise and is called no change; the queue is given in metres, because
 * "+∞%" of a queue that was 0 m says nothing.
 */
function compareVerdict(
  b: { avgSpeedKmh: number; throughputPerMin: number; longestQueueM: number; co2RatePerMin: number },
  now: { speed: number; flow: number; queue: number; co2: number },
): { text: string; tone: "good" | "bad" | "flat" } {
  const pct = (was: number, is: number) => (was > 0 ? ((is - was) / was) * 100 : 0);
  const parts: string[] = [];
  let score = 0;
  const sp = pct(b.avgSpeedKmh, now.speed);
  if (Math.abs(sp) >= 3) { parts.push(`speed ${sp < 0 ? "down" : "up"} ${Math.abs(sp).toFixed(0)}%`); score += sp > 0 ? 1 : -1; }
  const fl = pct(b.throughputPerMin, now.flow);
  if (Math.abs(fl) >= 3) { parts.push(`throughput ${fl < 0 ? "down" : "up"} ${Math.abs(fl).toFixed(0)}%`); score += fl > 0 ? 1 : -1; }
  const dq = now.queue - b.longestQueueM;
  if (Math.abs(dq) >= 20) { parts.push(`queue ${Math.abs(dq).toFixed(0)} m ${dq > 0 ? "longer" : "shorter"}`); score += dq < 0 ? 1 : -1; }
  const co = pct(b.co2RatePerMin, now.co2);
  if (Math.abs(co) >= 3) { parts.push(`CO₂ ${co < 0 ? "down" : "up"} ${Math.abs(co).toFixed(0)}%`); score += co < 0 ? 1 : -1; }
  if (parts.length === 0) return { text: "No real change from the baseline: every figure is within its normal second-to-second movement.", tone: "flat" };
  const text = `Compared with the baseline: ${parts.join(", ")}.`;
  return { text, tone: score > 0 ? "good" : score < 0 ? "bad" : "flat" };
}

/** Both mode's warm-up / unmet-demand notes, one carriageway each, each naming which. */
function DirectionNotes({ d, direction }: { d: DirectionApi; direction: Direction }) {
  const m = d.metrics;
  if (!m) return null;
  return (
    <>
      {!m.warm && (
        <p className="sandbox-live-note" data-note={direction}>
          Warming up &mdash; the road is still filling, so these figures are not yet the
          scenario. {Math.max(0, Math.ceil(WARMUP_S - m.elapsedS))}s to go.
        </p>
      )}
      {/* unmetVehPerHour alone is a cumulative average since warm-up: it fades
          as the run goes on rather than resetting, so a brief backup could
          clear the current reading with nothing left on screen to show it
          happened. Keying this off the peak instead — see peakUnmetVehPerHour
          in useDirectionSim — keeps the note up (naming both figures) for the
          rest of the run even once the live number drops back near zero. */}
      {m.warm && d.peakUnmetVehPerHour > 1 && (
        <p className="sandbox-live-note warn" data-note={direction}>
          Peak {Math.round(d.peakUnmetVehPerHour).toLocaleString()} veh/h of demand couldn&rsquo;t enter this run
          (currently {Math.round(m.unmetVehPerHour).toLocaleString()} veh/h): the segment was at capacity and
          the queue for it forms upstream, outside this model. The speeds shown describe only the traffic
          that got on.
        </p>
      )}
    </>
  );
}

function MetricTile({
  label,
  value,
  delta,
  goodWhenUp,
}: {
  label: string;
  value: string;
  delta?: number | null;
  goodWhenUp?: boolean;
}) {
  let cls = "";
  if (delta != null && Math.abs(delta) >= 1) {
    const positive = delta > 0;
    const good = goodWhenUp ? positive : !positive;
    cls = good ? "up" : "down";
  }
  return (
    <article className="sandbox-metric">
      <h3>{label}</h3>
      <div className="sandbox-metric-val">{value}</div>
      {delta != null && Math.abs(delta) >= 1 ? (
        <span className={`sandbox-metric-delta ${cls}`}>
          {delta > 0 ? "+" : ""}
          {delta.toFixed(0)}% vs baseline
        </span>
      ) : (
        <span className="sandbox-metric-delta muted">{delta != null ? "≈ baseline" : " "}</span>
      )}
    </article>
  );
}

function pctDelta(cur: number, base: number): number | null {
  if (base <= 0.001) return null;
  return ((cur - base) / base) * 100;
}

// getRecommendation lives in recommendation.ts, where verify.ts can test its edge cases.

// --------------------------------------------------------------------------
// Canvas rendering — pure draw from sim state, no mutation.
// --------------------------------------------------------------------------
/** One foldable block of the control rail.
 *
 *  The rail had three titled sections stacked in a single column — corridor
 *  setup, interventions and baseline — which ran far taller than the road
 *  beside it and forced the simulation card to either stretch into blank space
 *  or end level with nothing. Folding solves the height, but folding alone
 *  hides state, and an operator cannot be asked to expand a section to find out
 *  whether a lane is closed. So the header carries a summary: collapsed, the
 *  section still reports what it is holding.
 */
function RailSection({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: React.ReactNode;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section style={{ borderTop: "1px solid var(--border-default)", paddingTop: 8, marginTop: 8 }}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 8,
          background: "none", border: 0, padding: "2px 0", cursor: "pointer", textAlign: "left",
        }}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
             style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 140ms ease", flex: "0 0 auto" }}>
          <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="sandbox-section-title" style={{ margin: 0, flex: "0 0 auto" }}>{title}</span>
        {!open && (
          <span title={summary} style={{
            marginLeft: "auto", fontSize: "0.72rem", color: "var(--text-muted)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0,
          }}>{summary}</span>
        )}
      </button>
      {open && <div style={{ marginTop: 2 }}>{children}</div>}
    </section>
  );
}

/** Set once so a per-frame failure is reported, not repeated 60 times a second. */
let renderFailureReported = false;

/* ── Vehicle probe ───────────────────────────────────────────────────────────
 * Hover a vehicle to read its speed, or click it to pin the bubble to it.
 *
 * Where a sprite lands depends on the carriageway's mirroring, the enlargement
 * floor and the lane slot, all of which drawCarriageway() has already worked
 * out. So it records each footprint as it draws and the probe hit-tests those,
 * instead of a mouse handler keeping a second copy of the geometry (which is
 * what click placement has to do by hand — see handleCanvasClick). Rebuilt
 * every frame, so a footprint is always where the vehicle was last drawn. */
type VehicleHit = {
  id: number;
  dir: Direction;
  /** Sim second the vehicle entered — with `id`, tells it apart from a later sim's vehicle that reuses the id. */
  born: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  kmh: number;
  vClass: 1 | 2 | 3;
  /** 1-based, the same numbering as the L1..L4 tags on the road. */
  lane: number;
  moto: boolean;
  /** Off the carriageway: the plaza or service area it is in, said instead of a lane. */
  where?: string;
};
type VehicleRef = { id: number; dir: Direction; born: number };

const vehicleHits: VehicleHit[] = [];

/* Scenario event labels as drawn this frame, with the words each leaves out (17 Oct 2026, tester J). A label used to
   carry the name, phase and time left ("Overturned vehicle #3 · Lane blocked: awaiting response · 12:04 left"), and
   two or three of them stacked over the lanes they describe. The road shows the name; the rest appears on hover,
   drawn over the label (drawLabelProbe). The event list keeps every detail. Module-level like vehicleHits. */
type LabelHit = { left: number; top: number; w: number; h: number; full: string; look: "road" | "roadPending" | "site" | "sitePending" };
const labelHits: LabelHit[] = [];

/** The label under (x, y), the one drawn last when two overlap (it is the one on top). */
function labelAt(x: number, y: number): LabelHit | null {
  for (let i = labelHits.length - 1; i >= 0; i--) {
    const h = labelHits[i];
    if (x >= h.left && x <= h.left + h.w && y >= h.top && y <= h.top + h.h) return h;
  }
  return null;
}

/** A hovered label, drawn again over itself with everything it says: same place, same colours, as wide as it needs. */
function drawLabelProbe(ctx: CanvasRenderingContext2D, cssW: number, h: LabelHit) {
  const site = h.look === "site" || h.look === "sitePending";
  const faint = h.look === "roadPending";
  ctx.save();
  ctx.font = site ? "700 10px system-ui" : "700 11px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const w = ctx.measureText(h.full).width + (site ? 12 : 14);
  const lx = Math.max(4, Math.min(h.left, cssW - w - 4));
  if (site) {
    ctx.fillStyle = h.look === "site" ? "rgba(220,38,38,0.97)" : "rgba(234,88,12,0.96)";
    roundRect(ctx, lx, h.top, w, h.h, 4);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(h.full, lx + 6, h.top + 2.5);
  } else {
    ctx.fillStyle = "rgba(15,23,42,0.97)";
    roundRect(ctx, lx, h.top, w, h.h, 4);
    ctx.fill();
    ctx.strokeStyle = faint ? "rgba(148,163,184,0.8)" : "#f59e0b";
    ctx.lineWidth = 1.5;
    ctx.setLineDash(faint ? [4, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = faint ? "#cbd5e1" : "#fde68a";
    ctx.fillText(h.full, lx + 7, h.top + 3.5);
  }
  ctx.restore();
}

/* The road's zoom, for the drawing and for every click on it.
 *
 * Vehicles are drawn at their true length (facilityArt's TRUE SIZE), so with a whole 600 m window on screen a
 * car is a dozen pixels and with 3 km it is two or three. Zooming is how they are made large: `zoom` times the
 * window's scale, with `pan` CSS pixels of the zoomed road off the left edge. The renderers lay the road out
 * on a "virtual" canvas `zoom` times as wide as the real one and shift it left by `pan`, so nothing in the
 * drawing needed to learn about zoom; a click is put back onto that virtual canvas (roadX / roadW) before it
 * is read. Module-level, like vehicleHits: the render loop runs outside React. Along the road only — across
 * it the lanes already fill the height they are given. */
const roadView = { zoom: 1, pan: 0 };
/** The widest a metre is drawn, px: a car about 115 px long. Zoom stops there. */
const MAX_PX_PER_M = 25;
/** A screen x on the canvas (CSS px from its left edge) as an x on the zoomed road. */
const roadX = (screenX: number) => screenX + roadView.pan;
/** The zoomed road's width for a canvas this wide. */
const roadW = (canvasW: number) => canvasW * roadView.zoom;

/* What a Copilot proposal would do on the road, drawn faintly until Apply or Cancel.
 *
 * A proposal was a sentence in the panel — "Minor collision on Northbound, over Km 12.30–12.40" — and where that
 * is on the road could only be checked after applying it. Each action that has a place is outlined where it will
 * land, in its own colour (sky blue: not the red of a closure in force nor the amber of an event), dashed, with
 * "Proposed" in its label. Metres along the carriageway's own run; only what lies on the window now is listed
 * (a plan that moves the window says so in the panel). Module-level like vehicleHits: the render loop runs
 * outside React and reads it every frame. */
type PlanGhost = {
  readonly fromM: number;
  readonly toM: number;
  /** Engine lanes covered; null = the whole carriageway (a speed limit, rain, a shoulder breakdown's slow-down). */
  readonly lanes: readonly number[] | null;
  /** One spot (an event given a single km, a plaza): a pin, not a box. */
  readonly point: boolean;
  readonly label: string;
};
const planGhosts: Record<Direction, readonly PlanGhost[]> = { NB: [], SB: [] };

function drawPlanGhosts(
  ctx: CanvasRenderingContext2D,
  ghosts: readonly PlanGhost[],
  g: { xPx: (m: number) => number; roadTop: number; roadH: number; laneH: number; cssW: number; lanes: number; laneTop: (lane: number) => number; animT: number },
) {
  if (ghosts.length === 0) return;
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  ctx.save();
  ctx.font = "700 11px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (const gh of ghosts) {
    const lanes = (gh.lanes ?? []).filter((l) => l >= 0 && l < g.lanes);
    const tops = lanes.map((l) => g.laneTop(l));
    const top = gh.lanes === null || tops.length === 0 ? g.roadTop : Math.min(...tops);
    const bottom = gh.lanes === null || tops.length === 0 ? g.roadTop + g.roadH : Math.max(...tops) + g.laneH;
    const xa = g.xPx(gh.fromM);
    const xb = g.xPx(gh.toM);
    const x0 = Math.max(0, Math.min(xa, xb));
    const x1 = Math.min(g.cssW, Math.max(xa, xb));
    ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = -(g.animT * 14) % 12; // marching, so it reads as "not there yet"
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(56,189,248,0.95)";
    let anchorX: number;
    if (gh.point) {
      const cx = (xa + xb) / 2;
      const cy = (top + bottom) / 2;
      const r = Math.min(13, g.laneH * 0.42);
      ctx.fillStyle = "rgba(56,189,248,0.2)";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, g.roadTop);
      ctx.lineTo(cx, g.roadTop + g.roadH);
      ctx.lineWidth = 1;
      ctx.stroke();
      anchorX = cx;
    } else {
      ctx.fillStyle = "rgba(56,189,248,0.16)";
      ctx.fillRect(x0, top, Math.max(2, x1 - x0), bottom - top);
      ctx.strokeRect(x0 + 1, top + 1, Math.max(2, x1 - x0 - 2), bottom - top - 2);
      anchorX = (x0 + x1) / 2;
    }
    ctx.setLineDash([]);
    const text = `Proposed · ${gh.label}`;
    const w = ctx.measureText(text).width + 14;
    const h = 18;
    const lx = Math.max(4, Math.min(anchorX - w / 2, g.cssW - w - 4));
    let ly = top - h - 3 >= g.roadTop + 20 ? top - h - 3 : bottom + 3 + h <= g.roadTop + g.roadH ? bottom + 3 : top + 3;
    for (let tries = 0; tries < 6 && placed.some((p) => lx < p.x1 && lx + w > p.x0 && ly < p.y1 && ly + h > p.y0); tries++) ly += h + 3;
    placed.push({ x0: lx, x1: lx + w, y0: ly, y1: ly + h });
    ctx.fillStyle = "rgba(8,47,73,0.94)";
    roundRect(ctx, lx, ly, w, h, 4);
    ctx.fill();
    ctx.strokeStyle = "rgba(56,189,248,0.95)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#e0f2fe";
    ctx.fillText(text, lx + 7, ly + 3.5);
  }
  ctx.restore();
}
/** Sprites are a few pixels across at corridor scale; the hover target is a little bigger than the drawing. */
const PROBE_SLOP_PX = 4;
const VEHICLE_NAME = { 1: "Car", 2: "Bus", 3: "Truck" } as const;

/** The vehicle drawn under (x, y) in canvas CSS px — the one whose centre is nearest when footprints overlap. */
function vehicleAt(x: number, y: number): VehicleHit | null {
  let best: VehicleHit | null = null;
  let bestD = Infinity;
  for (const h of vehicleHits) {
    if (x < h.left - PROBE_SLOP_PX || x > h.right + PROBE_SLOP_PX || y < h.top - PROBE_SLOP_PX || y > h.bottom + PROBE_SLOP_PX) continue;
    const d = Math.hypot(x - (h.left + h.right) / 2, y - (h.top + h.bottom) / 2);
    if (d < bestD) {
      best = h;
      bestD = d;
    }
  }
  return best;
}

/** Draws the speed bubble for the pinned vehicle and for the one under the cursor, over the finished frame. */
function drawVehicleProbes(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  pointer: { x: number; y: number } | null,
  pinned: VehicleRef | null,
): { hovering: boolean; pinnedFound: boolean } {
  const pinnedHit = pinned ? vehicleHits.find((h) => h.id === pinned.id && h.dir === pinned.dir && h.born === pinned.born) ?? null : null;
  const hovered = pointer ? vehicleAt(pointer.x, pointer.y) : null;
  if (pinnedHit) drawProbeBubble(ctx, cssW, cssH, pinnedHit, true);
  if (hovered && hovered !== pinnedHit) drawProbeBubble(ctx, cssW, cssH, hovered, false);
  return { hovering: hovered !== null, pinnedFound: pinnedHit !== null };
}

function drawProbeBubble(ctx: CanvasRenderingContext2D, cssW: number, cssH: number, h: VehicleHit, pinned: boolean) {
  const accent = pinned ? "#fbbf24" : "#7dd3fc";
  const speed = `${Math.round(h.kmh)} km/h`;
  const what = `${h.moto ? "Motorcycle" : VEHICLE_NAME[h.vClass]} · ${h.where ?? `Lane ${h.lane}`}`;
  const hint = pinned ? "click to unpin" : "click to pin";

  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = "700 18px system-ui";
  const w1 = ctx.measureText(speed).width;
  ctx.font = "500 13px system-ui";
  const w2 = ctx.measureText(what).width;
  ctx.font = "12px system-ui";
  const w3 = ctx.measureText(hint).width;
  const padX = 11;
  const padY = 9;
  const bw = Math.max(w1, w2, w3) + padX * 2;
  const bh = padY * 2 + 23 + 18 + 14;

  // Outline the vehicle, so it is clear which one the bubble is about when the traffic is dense.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  roundRect(ctx, h.left - 2, h.top - 2, h.right - h.left + 4, h.bottom - h.top + 4, 3);
  ctx.stroke();

  // Above the vehicle, or below it when there is no room; kept inside the canvas either side.
  const gap = 8;
  const cx = (h.left + h.right) / 2;
  const bx = Math.max(2, Math.min(cssW - bw - 2, cx - bw / 2));
  const above = h.top - 2 - gap - bh;
  const by = Math.max(2, Math.min(cssH - bh - 2, above >= 2 ? above : h.bottom + 2 + gap));

  ctx.fillStyle = "rgba(15,23,42,0.94)";
  roundRect(ctx, bx, by, bw, bh, 7);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.25;
  ctx.stroke();

  ctx.fillStyle = "#f8fafc";
  ctx.font = "700 18px system-ui";
  ctx.fillText(speed, bx + padX, by + padY);
  ctx.fillStyle = "rgba(226,232,240,0.88)";
  ctx.font = "500 13px system-ui";
  ctx.fillText(what, bx + padX, by + padY + 23);
  ctx.fillStyle = "rgba(148,163,184,0.9)";
  ctx.font = "12px system-ui";
  ctx.fillText(hint, bx + padX, by + padY + 23 + 18);
  ctx.restore();
}

/** Tick spacing in km that yields a readable number of markers for a span. */
function kmTickStep(spanKm: number): number {
  for (const step of [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5]) {
    if (spanKm / step <= 8) return step;
  }
  return 10;
}

/**
 * The km ladder's ticks for a window given in MEASURED km: round OFFICIAL km posts, each drawn where
 * that post really is (kmMeasured) and labelled with the post itself. The step is chosen on the span of
 * posts the window covers, so the numbers stay round however the posts stretch against the road.
 */
function kmAxisTicks(fromKm: number, toKm: number, zoom: number): { km: number; text: string }[] {
  const postFrom = kmPost(fromKm);
  const postTo = kmPost(toKm);
  const step = kmTickStep(Math.max(1e-6, postTo - postFrom) / zoom);
  const dp = step < 1 ? 2 : 1;
  const out: { km: number; text: string }[] = [];
  for (let i = Math.ceil(postFrom / step - 1e-9); i * step <= postTo + 1e-9; i++) {
    const post = i * step;
    out.push({ km: kmMeasured(post), text: post.toFixed(dp) });
  }
  return out;
}

/** A slider's label with its "i": the explanation lives in the popup, not in a paragraph under the control.
 *  What is true of the view right now (a warning, an error) still belongs inline, next to the field. */
/** A one-road-at-a-time control's own NB / SB choice (README: no separate Focus control), styled as the Command
 *  tab's. Every such choice moves the same focus state, so choosing here is seen on the others. */
function FocusSwitch({ label, focus, directions, onFocus }: { label: string; focus: Direction; directions: readonly Direction[]; onFocus: (d: Direction) => void }) {
  return (
    <div className="sandbox-dir-pick" data-focus-switch role="tablist" aria-label={`${label}: which carriageway`}>
      <span className="k">{label}</span>
      <div className="sandbox-dir-seg">
        {directions.map((dn) => (
          <button
            key={dn}
            role="tab"
            aria-selected={focus === dn}
            className={`dir-${dn}${focus === dn ? " active" : ""}`}
            onClick={() => onFocus(dn)}
          >
            {DIRECTION_NAME[dn]}
          </button>
        ))}
      </div>
    </div>
  );
}

function InfoLabel({ info, children }: { info: string; children: React.ReactNode }) {
  return (
    <span className="sandbox-slider-label" style={{ display: "inline-flex", alignItems: "center" }}>
      {children}
      <InfoTooltip text={info} />
    </span>
  );
}

/** What the lane-reallocation control is, over which stretch, and what changing it restarts. */
const REALLOCATION_INFO = [
  "One carriageway borrows the other's inner lane over the stretch you give — usually about a kilometre, not the whole corridor.",
  "Its traffic crosses the median at an opening at each end of the stretch and drives the borrowed lane coned off from the other carriageway's traffic, which keeps its remaining lanes. Drivers get in or out only at those openings (within 150 m of each end), and anyone leaving the expressway before the far opening stays out.",
  "The sandbox simulates only this stretch (100 m to 3 km) and reallocates the lanes along all of it; the road either side is not simulated.",
  "Changing it restarts BOTH carriageways: clocks, baselines, and hand-set closures, speed limits and incidents are cleared. Scenario events stay and replay from their start. The simulated window becomes the stretch (Off puts it back).",
].join(" ");

/**
 * Tells the operator the one step of PLACING a closure that the controls don't show —
 * live, click-by-click guidance, so it stays inline text rather than an "i" tooltip (there
 * is no natural moment to hover an icon mid-click). The "closures apply to closed lanes
 * only" reminder that used to live here at rest, before anything was clicked, is reference
 * material read once, not a live status — it now sits behind the "i" beside "Close a lane"
 * instead (see InterventionControls), same as every other read-once explainer in this rail.
 */
function ClosureHint({ placing, draftKm }: { placing: boolean; draftKm: number | null }) {
  if (!placing) return null;
  const text = draftKm == null
    ? "Click the road where the closure starts · Esc to cancel"
    : `Starts at Km ${fmtKm(draftKm, 2)} — now click where it ends · Esc to cancel`;
  return <p className="sandbox-place-hint">{text}</p>;
}

/** What render() needs to draw scenario events. */
type ScenarioOverlay = {
  events: readonly ScenarioEvent[];
  frame: RoadFrame;
  /** What the engine binding last applied on this carriageway: an event is drawn holding lanes only if it owns the closure. */
  owners: Ownership;
  /** True for an incident in the engine's list that a scenario put there. */
  isScenarioIncident: (i: Incident) => boolean;
  /** The other carriageway's events and frame, for the weather only: the two sides share a sky, so a flood (and the
   *  rain it brings) on one carriageway rains on both. */
  sky?: { events: readonly ScenarioEvent[]; frame: RoadFrame } | null;
};

/** Narrower than this (CSS px) the road and the full-screen controls do not fit side by side. Matches globals.css. */
const NARROW_FULL_SCREEN = "(max-width: 900px)";

/* The canvas's pixel buffer at the screen's density, whatever the browser zoom.
 *
 * Zoom sets devicePixelRatio, and at 90%, 110%, 125% or 175% it is fractional, so width x ratio is not a whole
 * number. The buffer was compared against that unrounded product, which a canvas width (an integer) never equals,
 * so it was re-allocated — and cleared — every frame; and the transform scaled by the ratio while the buffer had
 * been truncated, so the picture was a fraction of a pixel out (soft). Rounded once, compared rounded, and scaled
 * by exactly buffer / CSS size. */
function fitBackingStore(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, cssW: number, cssH: number): void {
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.max(1, Math.round(cssW * dpr));
  const bh = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(bw / Math.max(1, cssW), 0, 0, bh / Math.max(1, cssH), 0, 0);
}

/** A hazard triangle for a scenario event; `faint` for one that has not started. */
function drawScenarioMarker(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, faint: boolean) {
  ctx.save();
  ctx.globalAlpha = faint ? 0.55 : 1;
  ctx.fillStyle = "#f59e0b";
  ctx.strokeStyle = "#1f2937";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 1.05, y + r * 0.85);
  ctx.lineTo(x - r * 1.05, y + r * 0.85);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#1f2937";
  ctx.font = "bold 10px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("!", x, y + r * 0.2);
  ctx.restore();
}

/** A label per scenario event at its location: its name, with the phase and time left on hover (labelHits); stacked so two never sit on top of each other. */
function drawScenarioLabels(
  ctx: CanvasRenderingContext2D,
  marks: readonly SceneMark[],
  g: {
    xPx: (m: number) => number;
    roadTop: number;
    laneH: number;
    roadH: number;
    cssW: number;
    r: number;
    lanes: number;
    /** Both mode's NB carriageway only — see laneSlotTop(). */
    reverseLanes: boolean;
    /** Where each engine lane is drawn, when not laneSlotTop within this block (Both mode, dualLanes). */
    laneTop?: (lane: number) => number;
    /** What an event's label says, when not its mark's own text (the phase's words, corrected for who is there). */
    wording?: (m: SceneMark) => string;
  },
) {
  const slotTop = g.laneTop ?? ((lane: number) => laneSlotTop(lane, g.roadTop, g.laneH, g.lanes, g.reverseLanes));
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  ctx.save();
  ctx.font = "700 11px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (const m of marks) {
    const x = g.xPx(m.xM);
    const shoulder = m.lane === null;
    // Shoulder sits just past the outermost lane (engine index lanes-1) — which
    // edge of the block that is flips with reverseLanes exactly as the
    // outermost lane's own slot does.
    const laneY = shoulder
      ? (g.reverseLanes ? g.roadTop + 3 : g.roadTop + g.roadH - 3)
      : slotTop(m.lane ?? 0) + g.laneH * 0.5;
    const faint = m.state === "pending";
    // A scene draws itself. The amber triangle is what is left for an event that has not started, or that is
    // running but holds nothing on the road (it yielded its closure to the operator's own).
    if (!hasSceneArt(m)) drawScenarioMarker(ctx, x, laneY, g.r, faint);
    const text = m.name;
    const w = ctx.measureText(text).width + 14;
    const h = 18;
    const heldStretch = hasSceneArt(m) && m.closedLanes.length > 0 ? m.stretch : null;
    const cx = heldStretch === null ? x : g.xPx((heldStretch.fromM + heldStretch.toM) / 2);
    const lx = Math.max(4, Math.min(cx - w / 2, g.cssW - w - 4));
    // Above the marker; but the canvas prints its own header along the top edge of the road, so near the top go below it.
    let ly = laneY - g.r - h - 3;
    if (ly < g.roadTop + 20) ly = laneY + g.r + 3;
    // A scene that holds lanes is drawn across them, so the label goes on the seam just past the lanes it
    // holds (or just before them at the road's edge) rather than on top of the water, works or wreck.
    if (hasSceneArt(m) && m.closedLanes.length > 0) {
      const tops = m.closedLanes.map((l) => slotTop(l));
      const heldTop = Math.min(...tops);
      const heldBottom = Math.max(...tops) + g.laneH;
      const below = heldBottom + 3;
      const above = heldTop - h - 3;
      ly = below + h <= g.roadTop + g.roadH ? below : above >= g.roadTop + 20 ? above : ly;
    }
    for (let tries = 0; tries < 6; tries++) {
      const clash = placed.some((p) => lx < p.x1 && lx + w > p.x0 && ly < p.y1 && ly + h > p.y0);
      if (!clash) break;
      ly += h + 3;
    }
    placed.push({ x0: lx, x1: lx + w, y0: ly, y1: ly + h });
    ctx.fillStyle = "rgba(15,23,42,0.9)";
    roundRect(ctx, lx, ly, w, h, 4);
    ctx.fill();
    ctx.strokeStyle = faint ? "rgba(148,163,184,0.8)" : "#f59e0b";
    ctx.lineWidth = 1.5;
    ctx.setLineDash(faint ? [4, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = faint ? "#cbd5e1" : "#fde68a";
    ctx.fillText(text, lx + 7, ly + 3.5);
    labelHits.push({ left: lx, top: ly, w, h, full: `${m.name} · ${g.wording ? g.wording(m) : m.text}`, look: faint ? "roadPending" : "road" });
  }
  ctx.restore();
}

/**
 * Everything about drawing ONE carriageway: asphalt, zones, closures,
 * congestion, vehicles, incidents, scenario labels, ramps, its own corner
 * text — every layer render() has always drawn, unchanged in content.
 *
 * Pulled out of render() so Both mode can call it twice (D3) instead of
 * carrying a second copy that drifts from the first, which is the exact
 * mistake roadLayout() was already written to avoid for the geometry alone.
 * render() below is now a thin single-carriageway wrapper — same signature,
 * same behaviour, nothing single-direction reads has changed.
 */
/**
 * 0 (full night) to 1 (full day) from minutes since midnight (may run past 1440 across a day
 * boundary — only the time of day matters). Dawn 05:00-07:00, day 07:00-17:00, dusk 17:00-19:00,
 * night the rest. Deliberately simple (no season, no latitude) — just enough that a simulation
 * running through the afternoon looks like afternoon, and one running at 2am looks like night.
 */
function daylightFraction(minutesSinceMidnight: number): number {
  const h = (((minutesSinceMidnight % 1440) + 1440) % 1440) / 60;
  if (h < 5 || h >= 19) return 0;
  if (h < 7) return (h - 5) / 2;
  if (h < 17) return 1;
  return 1 - (h - 17) / 2;
}

/** Linear-interpolates two "#rrggbb" colours; `t` is clamped to [0, 1]. */
function mixHex(from: string, to: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const at = [1, 3, 5].map((i) => Number.parseInt(from.slice(i, i + 2), 16));
  const bt = [1, 3, 5].map((i) => Number.parseInt(to.slice(i, i + 2), 16));
  const [r, g, b] = at.map((v, i) => Math.round(v + (bt[i] - v) * k));
  return `rgb(${r}, ${g}, ${b})`;
}

/** The carriageway's own night colour, unchanged from before day/night existed. */
const ASPHALT_NIGHT = "#20293a";
/** A lit, overcast-daylight asphalt grey — light enough to read as "day" without going pale
 *  concrete-white, which would fight the vehicle sprites (several of which are themselves white). */
const ASPHALT_DAY = "#8b94a3";
/** Low sun raking across wet-look tarmac reads warm, not grey — dawn leans a
 *  cool violet (the sky hasn't warmed up yet), dusk leans amber (it's had all
 *  day to). Using dayFraction alone for colour made both indistinguishable
 *  from a muddy halfway point between night and day; these are their own
 *  named stops instead of an interpolated midpoint. */
const ASPHALT_DAWN = "#6a5f74";
const ASPHALT_DUSK = "#8a6754";

/**
 * The asphalt colour for a given time of day, as four named keyframes
 * (night / dawn / day / dusk) rather than daylightFraction's single 0..1
 * axis — that axis alone cannot tell a genuine dawn from a genuine dusk
 * apart, since both sit at the same "halfway between night and day" value.
 * Keyframes sit at the same clock hours daylightFraction already uses
 * (dawn 05:00-07:00 peaking at 06:00, dusk 17:00-19:00 peaking at 18:00) so
 * the two stay in lockstep rather than drifting against each other.
 */
/** A small tile of grey speckle, generated once (lazily, on first draw) and
 *  reused every frame as a repeating fillStyle pattern. Real asphalt is
 *  never a flat colour; regenerating per-pixel noise every frame would cost
 *  far more than a road this small is worth, so the randomness is paid for
 *  exactly once and the pattern is just stamped down afterward. */
/* Night lights: three soft shapes drawn once and stamped with additive blending each frame — a headlight
   beam, a red tail-light glow, a warm street-lamp pool — so a few hundred lights cost a few hundred
   drawImage calls, not gradients rebuilt per vehicle per frame. */
type LightSprites = { beam: HTMLCanvasElement; tail: HTMLCanvasElement; pool: HTMLCanvasElement };
let lightSprites: LightSprites | null = null;
function getLightSprites(): LightSprites | null {
  if (lightSprites) return lightSprites;
  if (typeof document === "undefined") return null;
  const make = (w: number, h: number, paint: (c: CanvasRenderingContext2D) => void) => {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const c = cv.getContext("2d");
    if (c) paint(c);
    return cv;
  };
  // A beam pointing right from its left middle: a widening cone, bright near the lamp, gone by the far end.
  const beam = make(256, 128, (c) => {
    const g = c.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, "rgba(255,244,214,0.95)");
    g.addColorStop(0.35, "rgba(255,240,200,0.45)");
    g.addColorStop(1, "rgba(255,236,190,0)");
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(0, 54);
    c.lineTo(256, 4);
    c.lineTo(256, 124);
    c.lineTo(0, 74);
    c.closePath();
    c.fill();
    // Soften the cone's edges: fade it out towards the top and bottom.
    c.globalCompositeOperation = "destination-in";
    const v = c.createLinearGradient(0, 0, 0, 128);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(0.5, "rgba(0,0,0,1)");
    v.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = v;
    c.fillRect(0, 0, 256, 128);
  });
  const radial = (inner: string, mid: string) => (c: CanvasRenderingContext2D) => {
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, inner);
    g.addColorStop(0.45, mid);
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
  };
  const tail = make(128, 128, radial("rgba(255,60,50,0.95)", "rgba(220,30,30,0.35)"));
  const pool = make(128, 128, radial("rgba(255,214,150,0.55)", "rgba(255,196,120,0.18)"));
  lightSprites = { beam, tail, pool };
  return lightSprites;
}

/** How dark it is for the lights: 0 in daylight, rising through dusk, 1 once dayFraction is down to 0. */
function nightness(dayFraction: number): number {
  return Math.max(0, Math.min(1, 1 - dayFraction / 0.55));
}

/** Street lamps along the median as screen x (same km on both carriageways): 50 m apart (never closer than
 *  36 px on screen, or they become a stripe), half a step off the round metres so a lamp never stands on a
 *  km post (posts fall on multiples of 50 m). */
function lampXs(fromKm: number, toKm: number, mToPx: number, cssW: number): number[] {
  const stepM = Math.max(50, Math.ceil(36 / Math.max(1e-6, mToPx) / 50) * 50);
  const out: number[] = [];
  const first = Math.ceil((fromKm * 1000 - stepM / 2) / stepM) * stepM + stepM / 2;
  for (let m = first; m <= toKm * 1000 + 1e-6; m += stepM) {
    const x = ((m - fromKm * 1000) / ((toKm - fromKm) * 1000)) * cssW;
    if (x >= 0 && x <= cssW) out.push(x);
  }
  return out;
}

/* ── The scene around the road ──────────────────────────────────────────────
   The road used to float in empty space. Now it sits in a verge (grass, the odd tree), each carriageway has
   a paved shoulder outside its outer lane, and the median is paved with a concrete barrier down it, carrying
   the green km posts. All of it is drawn OUTSIDE the lanes, in the room the layout already leaves for ramps
   and plazas: no lane moves or shrinks. Day and night shift every colour with the asphalt. */
const GRASS_DAY = "#5e7a45";
const GRASS_NIGHT = "#0b140e";
/** A stable 0..1 from a number: the same tree stands at the same km every frame. */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
/** How deep each carriageway's paved shoulder is drawn, outside its outer lane. */
function shoulderPx(laneH: number): number {
  return Math.max(6, Math.min(22, laneH * 0.45));
}
/** The verge over the whole canvas, drawn first, with trees in `bands` (the strips beyond the shoulders) at
 *  fixed km, a third of the 20 m slots each side. Road, median and plazas are then drawn over it. */
function drawVerge(
  ctx: CanvasRenderingContext2D, cssW: number, cssH: number, dayFraction: number,
  fromKm: number, toKm: number, bands: readonly { top: number; bottom: number }[],
) {
  ctx.fillStyle = mixHex(GRASS_NIGHT, GRASS_DAY, dayFraction);
  ctx.fillRect(0, 0, cssW, cssH);
  const grain = getAsphaltGrain(ctx);
  if (grain) {
    ctx.fillStyle = grain;
    ctx.fillRect(0, 0, cssW, cssH);
  }
  const spanM = Math.max(1, (toKm - fromKm) * 1000);
  const pxPerM = cssW / spanM;
  const slotM = Math.max(20, Math.ceil(28 / pxPerM / 10) * 10);
  const shade = mixHex("#050c07", "#3b5729", dayFraction);
  const light = mixHex("#09140c", "#58783c", dayFraction);
  bands.forEach((b, bi) => {
    const depth = b.bottom - b.top;
    if (depth < 16) return;
    for (let m = Math.ceil((fromKm * 1000) / slotM) * slotM; m <= toKm * 1000; m += slotM) {
      const seed = m * 7 + bi * 1013;
      if (hash01(seed) > 0.36) continue;
      const r = Math.min(depth * 0.32, 6 + hash01(seed + 2) * 6);
      const x = (m - fromKm * 1000 + (hash01(seed + 1) - 0.5) * slotM * 0.6) * pxPerM;
      const y = b.top + r + 2 + hash01(seed + 3) * Math.max(0, depth - 2 * r - 4);
      ctx.fillStyle = `rgba(0,0,0,${(0.2 + 0.12 * dayFraction).toFixed(2)})`;
      ctx.beginPath();
      ctx.ellipse(x + r * 0.35, y + r * 0.4, r, r * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = shade;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = light;
      ctx.beginPath();
      ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}
/** The median's paved strip, under its barrier. */
function fillMedian(ctx: CanvasRenderingContext2D, cssW: number, top: number, h: number, dayFraction: number) {
  ctx.fillStyle = mixHex("#141921", "#767d86", dayFraction);
  ctx.fillRect(0, top, cssW, h);
  const grain = getAsphaltGrain(ctx);
  if (grain) {
    ctx.fillStyle = grain;
    ctx.fillRect(0, top, cssW, h);
  }
}
/** A run of concrete median barrier centred on `yMid`: a lit top, a shaded face, its shadow, and joints. */
function drawBarrierRun(ctx: CanvasRenderingContext2D, x0: number, x1: number, yMid: number, dayFraction: number) {
  if (x1 - x0 < 2) return;
  const h = 9;
  const top = yMid - h / 2;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(x0, top + h, x1 - x0, 2);
  const g = ctx.createLinearGradient(0, top, 0, top + h);
  g.addColorStop(0, mixHex("#5c636d", "#e6e8eb", dayFraction));
  g.addColorStop(0.45, mixHex("#3e444c", "#c3c7cd", dayFraction));
  g.addColorStop(1, mixHex("#262b32", "#8e949c", dayFraction));
  ctx.fillStyle = g;
  ctx.fillRect(x0, top, x1 - x0, h);
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  for (let x = x0 + 14; x < x1; x += 14) ctx.fillRect(x, top, 1, h);
}

let asphaltGrainTile: HTMLCanvasElement | null = null;
function getAsphaltGrain(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (!asphaltGrainTile) {
    const size = 96;
    const tile = document.createElement("canvas");
    tile.width = size;
    tile.height = size;
    const tctx = tile.getContext("2d");
    if (!tctx) return null;
    const img = tctx.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      // Grey speckle, sparse and faint — a texture the road surface has,
      // not a pattern the eye is drawn to.
      const v = Math.random() < 0.5 ? 0 : 255;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = Math.random() < 0.55 ? Math.round(6 + Math.random() * 14) : 0;
    }
    tctx.putImageData(img, 0, 0);
    asphaltGrainTile = tile;
  }
  return ctx.createPattern(asphaltGrainTile, "repeat");
}

function daylightAsphalt(minutesSinceMidnight: number): string {
  const h = (((minutesSinceMidnight % 1440) + 1440) % 1440) / 60;
  if (h < 5 || h >= 19) return ASPHALT_NIGHT;
  if (h < 6) return mixHex(ASPHALT_NIGHT, ASPHALT_DAWN, h - 5);
  if (h < 7) return mixHex(ASPHALT_DAWN, ASPHALT_DAY, h - 6);
  if (h < 17) return ASPHALT_DAY;
  if (h < 18) return mixHex(ASPHALT_DAY, ASPHALT_DUSK, h - 17);
  return mixHex(ASPHALT_DUSK, ASPHALT_NIGHT, h - 18);
}

/** Hazard lamps at the four corners of a vehicle, flashing: centred on (cx, y), turned `angle`. */
function drawHazardLamps(ctx: CanvasRenderingContext2D, cx: number, y: number, len: number, wid: number, angle: number, t: number): void {
  if (Math.floor(t * 2.2) % 2 !== 0) return;
  ctx.save();
  ctx.translate(cx, y);
  ctx.rotate(angle);
  const r = Math.max(1, wid * 0.12);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = sx * (len / 2 - r * 0.7);
      const yy = sy * (wid / 2 - r * 0.7);
      ctx.fillStyle = "rgba(251,191,36,0.32)";
      dot(ctx, x, yy, r * 2.4);
      ctx.fillStyle = "#fbbf24";
      dot(ctx, x, yy, r);
    }
  }
  ctx.restore();
}

/* A vehicle that has crashed or broken down — drawn as ITSELF: its own paint and class, at the angle it came to rest,
 * with what happened to it on it (crumpled at the ends for a crash, on its side for an overturn) and its hazards going.
 * It used to be a red block, so the car that crashed turned into a different car the moment it did — which is exactly
 * what an operator reads as a wreck appearing from nowhere. */
function drawWreckAgent(
  ctx: CanvasRenderingContext2D, xNose: number, y: number,
  len: number, wid: number, angle: number, sb: boolean, t: number,
  vClass: 1 | 2 | 3 = 1, paint: Paint = PAINT_WHITE, trailer: Paint = PAINT_WHITE,
  look: "crash" | "stalled" | "overturned" = "crash", hazards = true, moto = false,
): void {
  const f = sb ? -1 : 1;
  ctx.save();
  ctx.translate(xNose - f * (len / 2), y);
  ctx.rotate(angle);
  if (look === "overturned") paintOverturned(ctx, len, wid, paint, trailer, vClass, f);
  else {
    drawVehicle(ctx, f * (len / 2), 0, len, wid, vClass, paint, false, sb, trailer, moto);
    if (look === "crash" && !moto) paintDamage(ctx, len, wid, f);
  }
  ctx.restore();
  if (hazards && !moto) drawHazardLamps(ctx, xNose - f * (len / 2), y, len, wid, angle, t);
}

/** Crumpled ends and broken glass, over a vehicle's sprite (frame centred on it, nose toward `f`). */
function paintDamage(ctx: CanvasRenderingContext2D, len: number, wid: number, f: 1 | -1): void {
  const nose = (f * len) / 2;
  const tail = (-f * len) / 2;
  ctx.fillStyle = "rgba(15,23,42,0.5)";
  ctx.beginPath();
  ctx.moveTo(nose, -wid * 0.44);
  ctx.lineTo(nose - f * len * 0.1, -wid * 0.28);
  ctx.lineTo(nose - f * len * 0.05, 0);
  ctx.lineTo(nose - f * len * 0.12, wid * 0.3);
  ctx.lineTo(nose, wid * 0.44);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(15,23,42,0.38)";
  ctx.beginPath();
  ctx.moveTo(tail, -wid * 0.4);
  ctx.lineTo(tail + f * len * 0.07, -wid * 0.12);
  ctx.lineTo(tail + f * len * 0.04, wid * 0.24);
  ctx.lineTo(tail, wid * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(226,232,240,0.9)";
  for (let i = 0; i < 4; i++) ctx.fillRect(nose - f * len * (0.18 + i * 0.035) - 0.6, (i % 2 ? 1 : -1) * wid * (0.08 + i * 0.07) - 0.6, 1.2, 1.2);
}

/** A vehicle on its side, from above: the side panel in its paint, the underside with its axles and wheels to the sky. */
function paintOverturned(ctx: CanvasRenderingContext2D, len: number, wid: number, paint: Paint, trailer: Paint, vClass: 1 | 2 | 3, f: 1 | -1): void {
  const w = wid * 0.94;
  ctx.fillStyle = "rgba(0,0,0,0.32)";
  roundRect(ctx, -len / 2 + 1.5, -w / 2 + 2, len, w, Math.min(3, w * 0.3));
  ctx.fill();
  const g = ctx.createLinearGradient(0, -w / 2, 0, w / 2);
  g.addColorStop(0, vClass === 3 ? trailer.hi : paint.hi);
  g.addColorStop(1, vClass === 3 ? trailer.lo : paint.lo);
  ctx.fillStyle = g;
  roundRect(ctx, -len / 2, -w / 2, len, w, Math.min(3, w * 0.3));
  ctx.fill();
  if (vClass === 3) {
    // The cab, in its own colour, at the front.
    ctx.fillStyle = paint.lo;
    roundRect(ctx, f === 1 ? len / 2 - len * 0.28 : -len / 2, -w / 2, len * 0.28, w, Math.min(3, w * 0.3));
    ctx.fill();
  }
  // The underside: chassis along the half that faces the sky.
  ctx.fillStyle = "#273142";
  roundRect(ctx, -len / 2 + len * 0.04, -w / 2 + w * 0.06, len * 0.92, w * 0.46, 2);
  ctx.fill();
  const axles = vClass === 3 ? [0.4, 0.2, -0.22, -0.32, -0.42] : vClass === 2 ? [0.32, -0.3] : [0.3, -0.3];
  for (const a of axles) {
    const x = a * len * f;
    ctx.fillStyle = "#05080f";
    ctx.beginPath();
    ctx.ellipse(x, -w * 0.18, Math.max(1.4, len * 0.045), Math.max(1.2, w * 0.2), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#94a3b8";
    dot(ctx, x, -w * 0.18, Math.max(0.6, w * 0.06));
  }
  // The roof edge, scraped along the road.
  ctx.strokeStyle = "rgba(226,232,240,0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-len / 2 + 2, w / 2 - 1.5);
  ctx.lineTo(len / 2 - 2, w / 2 - 1.5);
  ctx.stroke();
}

const RESPONDER_LOOK: Record<"ambulance" | "police" | "tow" | "works", { readonly vClass: 1 | 2 | 3; readonly body: Paint; readonly bed: Paint; readonly lights: readonly [string, string]; readonly glow: readonly [string, string] }> = {
  police: { vClass: 1, body: { hi: "#ffffff", lo: "#d5dbe5" }, bed: PAINT_WHITE, lights: ["#ef4444", "#3b82f6"], glow: ["rgba(239,68,68,0.32)", "rgba(59,130,246,0.32)"] },
  ambulance: { vClass: 2, body: { hi: "#ffffff", lo: "#e2e8f0" }, bed: PAINT_WHITE, lights: ["#ef4444", "#f8fafc"], glow: ["rgba(239,68,68,0.32)", "rgba(248,250,252,0.3)"] },
  tow: { vClass: 3, body: { hi: "#fbbf24", lo: "#d97706" }, bed: { hi: "#64748b", lo: "#334155" }, lights: ["#fbbf24", "#f59e0b"], glow: ["rgba(251,191,36,0.32)", "rgba(245,158,11,0.3)"] },
  works: { vClass: 3, body: { hi: "#fde047", lo: "#ca8a04" }, bed: { hi: "#facc15", lo: "#a16207" }, lights: ["#fbbf24", "#f59e0b"], glow: ["rgba(251,191,36,0.32)", "rgba(245,158,11,0.3)"] },
};

/* A responder: the same vehicle shapes as the traffic (a car, a van, a truck) in its service's livery, with its light
 * bar flashing — police red and blue, ambulance red and white, recovery and works amber. */
function drawResponderAgent(
  ctx: CanvasRenderingContext2D, xNose: number, y: number,
  len: number, wid: number, kind: "ambulance" | "police" | "tow" | "works", sb: boolean, t: number,
): void {
  const look = RESPONDER_LOOK[kind];
  const f = sb ? -1 : 1;
  drawVehicle(ctx, xNose, y, len, wid, look.vClass, look.body, false, sb, look.bed, false);
  ctx.save();
  ctx.translate(xNose - f * (len / 2), y);
  if (kind === "police") {
    // A blue band down each side.
    ctx.fillStyle = "#1d4ed8";
    ctx.fillRect(-len * 0.42, -wid / 2, len * 0.84, Math.max(1, wid * 0.13));
    ctx.fillRect(-len * 0.42, wid / 2 - Math.max(1, wid * 0.13), len * 0.84, Math.max(1, wid * 0.13));
  } else if (kind === "ambulance") {
    ctx.fillStyle = "#dc2626";
    ctx.fillRect(-len * 0.46, -wid / 2, len * 0.92, Math.max(1, wid * 0.12));
    ctx.fillRect(-len * 0.46, wid / 2 - Math.max(1, wid * 0.12), len * 0.92, Math.max(1, wid * 0.12));
    // The cross on the roof.
    const cx = -f * len * 0.12;
    ctx.fillRect(cx - len * 0.09, -wid * 0.07, len * 0.18, wid * 0.14);
    ctx.fillRect(cx - len * 0.03, -wid * 0.24, len * 0.06, wid * 0.48);
  } else if (kind === "works") {
    // Chevrons across the tail.
    ctx.fillStyle = "#1f2937";
    for (let i = 0; i < 3; i++) ctx.fillRect(-f * len * 0.46 + f * i * len * 0.09 - len * 0.022, -wid * 0.42, len * 0.045, wid * 0.84);
  }
  // The light bar, across the roof (the cab, on a truck); its halves alternate, and the lit one glows.
  const barX = kind === "police" ? -f * len * 0.04 : f * len * 0.3;
  const on = Math.floor(t * (kind === "tow" || kind === "works" ? 2.5 : 4)) % 2 === 0;
  const bw = Math.max(1.6, len * 0.07);
  const bh = wid * 0.84;
  for (const side of [-1, 1] as const) {
    const lit = (side === -1) === on;
    const i = side === -1 ? 0 : 1;
    if (lit) {
      ctx.fillStyle = look.glow[i];
      dot(ctx, barX, (side * bh) / 4, wid * 0.42);
    }
    ctx.fillStyle = lit ? look.lights[i] : "rgba(30,41,59,0.9)";
    ctx.fillRect(barX - bw / 2, side === -1 ? -bh / 2 : 0, bw, bh / 2);
  }
  ctx.restore();
}

/* Driving out of the picture.
 *
 * The engine retires a vehicle the moment its NOSE reaches the end of the simulated stretch, which is the edge of the
 * canvas — so the rest of it, still on screen (a car's sprite is 26 px at the whole view, a truck's well over twice
 * that), vanished in one frame: traffic popped out of existence at the exit edge. The engine is right to count the trip
 * there; this is only the drawing. A vehicle that was about to cross the end in one frame and is gone in the next is
 * drawn rolling on at the speed it had until it is clear of the picture. Keyed by the engine, so each carriageway has
 * its own, and emptied if the clock goes back (a reset). */
type ExitGhost = { v: TrafficSim["vehicles"][number]; x0: number; t0: number };

/** How far each vehicle is drawn back from where it really is to keep its full size without touching the one ahead
 *  (m), and when, per carriageway; eased off over DISPLACE_EASE_S when it is let go. */
const displaceBySim = new WeakMap<object, Map<number, { d: number; t: number }>>();
const DISPLACE_EASE_S = 1.2;
function displaceStateOf(sim: TrafficSim): Map<number, { d: number; t: number }> {
  let m = displaceBySim.get(sim);
  if (!m) displaceBySim.set(sim, (m = new Map()));
  return m;
}

/** How far each scene vehicle is drawn back from where it really is (m), and when, per carriageway (see `geo`). */
const sceneGlideBySim = new WeakMap<object, Map<number, { d: number; t: number }>>();
const SCENE_GLIDE_S = 0.4;
function sceneGlideOf(sim: TrafficSim): Map<number, { d: number; t: number }> {
  let m = sceneGlideBySim.get(sim);
  if (!m) sceneGlideBySim.set(sim, (m = new Map()));
  return m;
}
const exitGhostsBySim = new WeakMap<object, { t: number; near: Map<number, TrafficSim["vehicles"][number]>; ghosts: Map<number, ExitGhost> }>();
/** How far past the end (m) a ghost is kept: more than any vehicle's drawn length at the most enlarged view. */
const EXIT_RUNOUT_M = 80;
function exitGhosts(sim: TrafficSim, live: readonly TrafficSim["vehicles"][number][]): TrafficSim["vehicles"][number][] {
  const L = sim.cfg.length;
  let st = exitGhostsBySim.get(sim);
  if (!st || sim.time < st.t) {
    st = { t: sim.time, near: new Map(), ghosts: new Map() };
    exitGhostsBySim.set(sim, st);
  }
  const dt = sim.time - st.t;
  if (dt > 0) {
    const here = new Set(live.map((v) => v.id));
    for (const [id, v] of st.near) {
      // Gone, and where it was going it would have crossed the end: it drove off (not a ramp, not a reset).
      if (!here.has(id) && v.x + Math.max(0, v.v) * dt >= L - 0.5) st.ghosts.set(id, { v: { ...v }, x0: v.x, t0: st.t });
    }
  }
  const out: TrafficSim["vehicles"][number][] = [];
  for (const [id, g] of st.ghosts) {
    const x = g.x0 + Math.max(0, g.v.v) * (sim.time - g.t0);
    if (x > L + EXIT_RUNOUT_M) {
      st.ghosts.delete(id);
      continue;
    }
    g.v.x = x;
    g.v.accel = 0;
    out.push(g.v);
  }
  st.near = new Map(live.filter((v) => v.x > L - 40).map((v) => [v.id, { ...v }]));
  st.t = sim.time;
  return out;
}

function drawCarriageway(
  ctx: CanvasRenderingContext2D,
  sim: TrafficSim,
  opts: {
    cssW: number;
    cssH: number;
    roadTop: number;
    laneH: number;
    roadH: number;
    rampGutter: number;
    /** Northbound draws its ramps above the road, southbound below — true for NB in every mode. */
    rampsAbove: boolean;
    /** Both mode's NB carriageway only — see laneSlotTop(). Single-direction always false. */
    reverseLanes: boolean;
    mToPx: number;
    /** Southbound: traffic mirrors, sprites face left. True for SB in every mode. */
    sb: boolean;
    xPx: (x: number) => number;
    wPx: (m: number) => number;
    fromKm: number;
    toKm: number;
    overlay: ScenarioOverlay | null;
    /** Single-direction draws its own km axis; Both draws one shared axis separately (drawSharedKmAxis). */
    drawAxis: boolean;
    /** Simulated seconds accrued since the last physics step, 0..SIM_DT. Vehicles
     *  are drawn this far along their current motion so the traffic moves every
     *  frame instead of every third one. Drawing only — the engine never sees it. */
    alphaS: number;
    /** "▶ traffic flow" for single-direction, unchanged; Both passes a direction-aware arrow. */
    flowLabel: string;
    /** Corner label — the full location string for single-direction, just "Northbound"/"Southbound" for Both. */
    location: string;
    /** Animation clock, seconds (frozen while paused): drives rain, flowing water, beacons and hazard lights. */
    animT: number;
    /** How many of this carriageway's innermost lanes were reallocated to it from the other; 0 otherwise. */
    borrowed: number;
    /** What to call those lanes on the canvas. */
    borrowedLabel: string;
    /** Both mode: where each engine lane is drawn (dualLanes). Default: laneSlotTop within this block. */
    laneTop?: (lane: number) => number;
    /** Both mode, a reallocation, the carriageway lent lanes: they are drawn on the other carriageway (laneTop),
     *  and near either end of the stretch their traffic is drawn crossing the median (`shiftPx` at the very end,
     *  easing to 0 at `crossM` in). `away` points from the median into those lanes. */
    lent?: { readonly lanes: number; readonly crossM: number; readonly lengthM: number; readonly shiftPx: number; readonly away: 1 | -1 } | null;
    /** 0 (night) to 1 (day) — see daylightFraction(). Tints the lane markings; the asphalt itself uses asphaltColor, which can tell a real dawn from a real dusk apart. */
    dayFraction: number;
    /** The toll plazas and service areas on this carriageway, and who is in them. */
    facView: FacilityView | null;
    /** A facility to outline — the one an operator is placing an event at. */
    highlightFacility: string | null;
    /** Pixels per lane unit past the road edge (roadLayout's gutterPx). */
    gutterPx: number;
    /** Pre-mixed asphalt colour for this moment — see daylightAsphalt(). Computed once per frame at the call site (not per carriageway) so Both mode's two roads never fall a step out of sync with each other. */
    asphaltColor: string;
  },
) {
  const {
    cssW, cssH, roadTop, laneH, roadH, rampGutter, rampsAbove, reverseLanes,
    mToPx, sb, xPx, wPx, fromKm, toKm, overlay, drawAxis, alphaS, flowLabel, location, animT, borrowed, borrowedLabel, dayFraction, asphaltColor,
    facView, highlightFacility, gutterPx,
  } = opts;
  const asphalt = asphaltColor;
  const lanes = sim.cfg.laneCount;
  const lent = opts.lent ?? null;
  // The lanes on this block's own surface; lent ones are drawn on the other carriageway.
  const ownLanes = lanes - (lent?.lanes ?? 0);
  const slotTop = opts.laneTop ?? ((lane: number) => laneSlotTop(lane, roadTop, laneH, lanes, reverseLanes));
  /** Where a vehicle `across` lanes in, nose at `xm`, is drawn. A lent lane's traffic eases over to the
   *  median opening within crossM of either end: it crosses from its own carriageway there and back. */
  const laneCentreAt = (across: number, xm: number): number => {
    const centre = (lane: number): number => {
      const c = slotTop(lane) + laneH / 2;
      if (lent === null || lane >= lent.lanes) return c;
      const t = Math.max(0, Math.min(1, Math.min(xm, lent.lengthM - xm) / Math.max(1, lent.crossM)));
      return c + (1 - t * t * (3 - 2 * t)) * lent.shiftPx;
    };
    const a = Math.floor(across);
    return a === across ? centre(a) : centre(a) + (centre(a + 1) - centre(a)) * (across - a);
  };

  /* The paved shoulder outside the outer lane: a worn strip of the same asphalt, a rumble strip along the
     edge line, gravel at its outer edge. Outside the lanes, in the gutter, so no lane moves; ramps and plazas
     are drawn over it where they leave the road. */
  {
    const sh = shoulderPx(laneH);
    const shTop = reverseLanes ? roadTop - sh : roadTop + roadH;
    ctx.fillStyle = asphalt;
    ctx.fillRect(0, shTop, cssW, sh);
    ctx.fillStyle = `rgba(255,255,255,${(0.04 + 0.05 * dayFraction).toFixed(2)})`;
    ctx.fillRect(0, shTop, cssW, sh);
    ctx.fillStyle = `rgba(255,255,255,${(0.1 + 0.1 * dayFraction).toFixed(2)})`;
    const rumbleH = Math.max(2, sh * 0.22);
    const rumbleY = reverseLanes ? roadTop - rumbleH - 2 : roadTop + roadH + 2;
    for (let x = 2; x < cssW; x += 6) ctx.fillRect(x, rumbleY, 2, rumbleH);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(0, reverseLanes ? shTop : shTop + sh - 1.5, cssW, 1.5);
  }

  // asphalt — flat fill first, then a crown shade and a grain overlay so it
  // reads as a road surface rather than a flat illustration. Both stay
  // inside the same rounded rect the flat fill used, via one clip.
  ctx.fillStyle = asphalt;
  roundRect(ctx, 0, roadTop, cssW, roadH, 10);
  ctx.fill();
  ctx.save();
  roundRect(ctx, 0, roadTop, cssW, roadH, 10);
  ctx.clip();
  // Real tarmac catches light unevenly across its width (the crown that
  // sheds rainwater to the shoulders) — darker at the edges, true colour in
  // the middle, rather than one flat value corner to corner.
  const crown = ctx.createLinearGradient(0, roadTop, 0, roadTop + roadH);
  crown.addColorStop(0, "rgba(0,0,0,0.16)");
  crown.addColorStop(0.5, "rgba(0,0,0,0)");
  crown.addColorStop(1, "rgba(0,0,0,0.16)");
  ctx.fillStyle = crown;
  ctx.fillRect(0, roadTop, cssW, roadH);
  // Fine speckle — a repeating tile generated once, not per pixel per frame.
  const grain = getAsphaltGrain(ctx);
  if (grain) {
    ctx.fillStyle = grain;
    ctx.fillRect(0, roadTop, cssW, roadH);
  }
  ctx.restore();

  // speed-limit zone. Not when it is a rain event's: rain's zone is the whole segment, so the wash would
  // tint the entire carriageway orange; rain shows a speed-limit sign and the rain itself instead.
  const rainOwnsZone =
    overlay !== null &&
    overlay.owners.speedZone !== null &&
    overlay.events.some((e) => overlay.owners.speedZone !== null && e.id === overlay.owners.speedZone.eventId && e.variant.family === "rain");
  // Further speed zones (Interventions.speedZones): each event's own; rain's spans the whole stretch and is shown by
  // the rain and its sign instead, so only the ones narrower than the stretch get the wash.
  const zonesToDraw: [number, number][] = [];
  if (sim.interventions.speedLimitKmh != null && !rainOwnsZone) zonesToDraw.push([sim.interventions.speedZone[0], sim.interventions.speedZone[1]]);
  for (const z of sim.interventions.speedZones ?? []) if (z.to - z.from < sim.cfg.length - 1) zonesToDraw.push([z.from, z.to]);
  for (const [z0, z1] of zonesToDraw) {
    ctx.fillStyle = "rgba(234,88,12,0.16)";
    // A zone measured in metres is sub-pixel once the span is kilometres long,
    // so the one intervention the operator applied became invisible. Floored to
    // stay findable; the km ladder still says where it truly is.
    const zL = Math.min(xPx(z0), xPx(z1));
    const zR = Math.max(xPx(z0), xPx(z1));
    ctx.fillRect(zL, roadTop, Math.max(3, wPx(z1 - z0)), roadH);
    ctx.fillStyle = "rgba(234,88,12,0.85)";
    ctx.fillRect(zL, roadTop, 2, roadH);
    ctx.fillRect(Math.max(zL + 2, zR - 2), roadTop, 2, roadH);
  }

  // lane dividers — a touch more opaque in daylight: the same 0.35 that stands out against the
  // dark night asphalt gets closer in value to a light asphalt and starts to wash out.
  ctx.strokeStyle = `rgba(255,255,255,${(0.35 + 0.25 * dayFraction).toFixed(2)})`;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([14, 14]);
  for (let l = 1; l < ownLanes; l++) {
    const y = roadTop + l * laneH;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cssW, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Shoulder edge lines — solid, unlike the dashed dividers between lanes,
  // matching the real marking convention. Without these the outermost lanes
  // had no boundary at all, which is what made the road read as an abstract
  // striped rectangle rather than a carriageway with an edge.
  ctx.lineWidth = 2;
  ctx.beginPath();
  // Lent lanes: the median-side edge stops at the openings, where this traffic crosses over.
  const openPx = lent === null ? 0 : Math.min(cssW / 2, lent.crossM * mToPx);
  const innerY = reverseLanes ? roadTop + ownLanes * laneH : roadTop;
  for (const y of [roadTop, roadTop + ownLanes * laneH]) {
    const x0 = y === innerY ? openPx : 0;
    ctx.moveTo(x0, y);
    ctx.lineTo(cssW - x0, y);
  }
  ctx.stroke();

  /* Night: the median's street lamps light the inner lanes in warm pools (additive, so they brighten the
     asphalt rather than paint over it). Under the facilities, markings' overlays and traffic. */
  const night = nightness(dayFraction);
  const lights = night > 0.02 ? getLightSprites() : null;
  if (lights) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, roadTop, cssW, ownLanes * laneH);
    ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.5 * night;
    const pw = laneH * 3.4;
    const ph = laneH * 2.6;
    for (const x of lampXs(fromKm, toKm, mToPx, cssW)) ctx.drawImage(lights.pool, x - pw / 2, innerY - ph / 2, pw, ph);
    ctx.restore();
  }

  /* Toll plazas and service areas, as places: ramps, booth lanes, islands,
   * pumps. Under the traffic and over the lane markings, so where a barrier
   * plaza's booths stand the plaza replaces the lane lines, as on the road.
   * They hang off the OUTER edge — the side the outer lane is drawn on —
   * because that is the lane every vehicle leaves and joins from. */
  const facOut: 1 | -1 = reverseLanes ? -1 : 1;
  const outerCentreY = slotTop(lanes - 1) + laneH / 2;
  const facEdgeY = reverseLanes ? roadTop : roadTop + roadH;
  const facGeom: FacGeom | null =
    facView && facView.list.length > 0
      ? {
          ctx, xPx,
          // On the road at the road's scale; past its edge at the gutter's own.
          yOf: (w: number) => (w <= 0.5 ? outerCentreY + facOut * w * laneH : facEdgeY + facOut * (w - 0.5) * gutterPx),
          laneH, gutterPx, mToPx,
          fwd: sb ? -1 : 1, out: facOut, asphalt, dayFraction, t: animT, cssW, cssH,
          roadEdgeY: facEdgeY, gutterEdgeY: facEdgeY + facOut * rampGutter,
          roadInnerY: reverseLanes ? roadTop + roadH : roadTop,
        }
      : null;
  if (facGeom && facView) drawFacilityGround(facGeom, facView);

  // What each scenario event looks like this frame (family, phase, the lanes and stretch it actually holds).
  const scenes: readonly SceneMark[] = overlay ? sceneMarks(overlay.events, roadOf(sim, overlay.frame), sim.time, overlay.owners) : [];
  // Set once the traffic's own scale is known (below); the water, scenes and weather share it.
  const laneCenterY = (engineLane: number): number => slotTop(engineLane) + laneH / 2;

  // closed-lane hatching + taper, for every closure on the road: the shared one (the operator's, or the first
  // event's) and each further event's own (Interventions.closures — there is no limit on how many run at once).
  const allClosures = [
    { lanes: sim.interventions.closedLanes, from: sim.interventions.closurePoint, to: sim.interventions.closureEnd },
    ...(sim.interventions.closures ?? []),
  ];
  for (const closure of allClosures)
  for (let l = 0; l < lanes; l++) {
    if (!closure.lanes[l]) continue;
    const y = slotTop(l);
    const x0 = xPx(closure.from);
    // The works end where the operator said they end, not at the edge of the
    // view — a closure that always ran to the end of the screen could not
    // represent "lane 4 shut between km 0.20 and km 0.40".
    const x1 = xPx(closure.to);
    const cL = Math.max(0, Math.min(x0, x1));
    const cR = Math.min(cssW, Math.max(x0, x1));
    ctx.fillStyle = "rgba(220,38,38,0.28)";
    ctx.fillRect(cL, y, Math.max(2, cR - cL), laneH);
    // A solid edge at the far end so the reopening is as visible as the taper.
    // Solid edge at the REOPENING end, whichever side of the screen that is.
    if (x1 > 0 && x1 < cssW) {
      ctx.fillStyle = "rgba(255,120,120,0.9)";
      ctx.fillRect(sb ? x1 : x1 - 2, y, 2, laneH);
    }
    ctx.strokeStyle = "rgba(255,120,120,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x0, y + laneH / 2);
    ctx.lineTo(x0 + 14, y + 4);
    ctx.moveTo(x0, y + laneH / 2);
    ctx.lineTo(x0 + 14, y + laneH - 4);
    ctx.stroke();
  }

  // A closure acts on closed lanes only, so with none closed the hatching above
  // draws nothing and setting the stretch looked like it did nothing. Once the
  // operator has touched the closure, outline the stretch until a lane is picked.
  if (sim.interventions.showClosurePreview && !sim.interventions.closureDraft && !sim.interventions.closedLanes.some(Boolean)) {
    const x0 = xPx(sim.interventions.closurePoint);
    const x1 = xPx(sim.interventions.closureEnd);
    const oL = Math.max(0, Math.min(x0, x1));
    const oR = Math.min(cssW, Math.max(x0, x1));
    ctx.save();
    ctx.strokeStyle = "rgba(252,165,165,0.8)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(oL + 0.75, roadTop + 0.75, Math.max(2, oR - oL - 1.5), roadH - 1.5);
    ctx.setLineDash([]);
    const label = "Closure stretch · close a lane to apply";
    ctx.font = "600 11px Inter, system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left"; // other layers leave it centred
    const tw = ctx.measureText(label).width;
    const lx = Math.max(4, Math.min(x0 + 6, cssW - tw - 10));
    ctx.fillStyle = "rgba(15,23,42,0.75)";
    ctx.fillRect(lx - 4, roadTop + 4, tw + 8, 17);
    ctx.fillStyle = "rgba(254,202,202,0.98)";
    ctx.fillText(label, lx, roadTop + 7);
    ctx.restore();
  }

  // The stretch being drawn: shaded between the first click and the cursor,
  // with both ends labelled as official km posts.
  const draftStretch = sim.interventions.closureDraft;
  if (draftStretch) {
    const x0 = xPx(draftStretch.from);
    const x1 = xPx(draftStretch.to);
    const dL = Math.max(0, Math.min(x0, x1));
    const dR = Math.min(cssW, Math.max(x0, x1));
    ctx.save();
    ctx.fillStyle = "rgba(220,38,38,0.22)";
    ctx.fillRect(dL, roadTop, Math.max(2, dR - dL), roadH);
    ctx.strokeStyle = "rgba(252,165,165,0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, roadTop);
    ctx.lineTo(x0, roadTop + roadH);
    ctx.moveTo(x1, roadTop);
    ctx.lineTo(x1, roadTop + roadH);
    ctx.stroke();
    const kmOf = (m: number) => (sb ? toKm - m / 1000 : fromKm + m / 1000);
    const kmA = fmtKm(kmOf(draftStretch.from), 2);
    const kmB = fmtKm(kmOf(draftStretch.to), 2);
    const label = kmA === kmB ? `Km ${kmA} → click the end` : `Km ${kmA} – ${kmB}`;
    ctx.font = "700 12px Inter, system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left"; // other layers leave it centred
    const tw = ctx.measureText(label).width;
    const lx = Math.max(4, Math.min(x0 + 6, cssW - tw - 10));
    ctx.fillStyle = "rgba(15,23,42,0.85)";
    ctx.fillRect(lx - 5, roadTop + 4, tw + 10, 19);
    ctx.fillStyle = "#fecaca";
    ctx.fillText(label, lx, roadTop + 7);
    ctx.restore();
  }

  // Lane reallocation: the lanes this carriageway was given, marked as reversible, under the traffic.
  const fwd: 1 | -1 = sb ? -1 : 1;
  if (borrowed > 0) {
    drawBorrowedLanes(
      { ctx, cssW, roadTop, roadH, laneH, xPx, fwd, laneCenterY, outerEdgeY: reverseLanes ? roadTop : roadTop + roadH, outward: reverseLanes ? -1 : 1, carLen: 18, carWid: 9, t: animT },
      borrowed,
      borrowedLabel,
      lent?.away ?? (reverseLanes ? -1 : 1),
    );
  }
  // Flood water goes UNDER the traffic and over the closure hatch: the lane reads as under (flowing) water.
  drawWater(
    { ctx, cssW, roadTop, roadH, laneH, xPx, fwd, laneCenterY, outerEdgeY: reverseLanes ? roadTop : roadTop + roadH, outward: reverseLanes ? -1 : 1, carLen: 18, carWid: 9, t: animT },
    scenes,
  );

  // vehicles — top-down sprites, front facing the direction of travel (right).
  // Length is true-to-scale; width uses the true vehicle width with a small
  // exaggeration for legibility, capped to the lane. This keeps a car longer
  // than it is wide and keeps stopped vehicles from overlapping.
  // ── Congestion bands ────────────────────────────────────────────────────────
  // "Longest queue 0 m" is a tile; on the road the queue itself was invisible,
  // which is odd for the one thing an intervention is meant to cause. Stretches
  // where traffic is crawling are shaded per lane, so the effect of a closure is
  // seen where it happens rather than only counted.
  {
    const SLOW = 8; // m/s — roughly 29 km/h, below which a lane is queueing
    const binPx = 14;
    const bins = Math.max(1, Math.ceil(cssW / binPx));
    for (let lane = 0; lane < lanes; lane++) {
      const worst = new Array(bins).fill(Infinity);
      for (const v of sim.vehicles) {
        // A wreck or a parked responder is not queueing: its own scene shows it.
        if (v.lane !== lane || v.v >= SLOW || v.role !== "traffic") continue;
        const b = Math.min(bins - 1, Math.max(0, Math.floor(xPx(v.x) / binPx)));
        worst[b] = Math.min(worst[b], v.v);
      }
      const y = slotTop(lane);
      for (let b = 0; b < bins; b++) {
        if (!Number.isFinite(worst[b])) continue;
        // Deeper red the slower it is: stopped reads differently from crawling.
        const severity = 1 - Math.max(0, Math.min(1, worst[b] / SLOW));
        ctx.fillStyle = `rgba(220,38,38,${0.1 + 0.28 * severity})`;
        ctx.fillRect(b * binPx, y, binPx + 1, laneH);
      }
    }
  }

  // Vehicles are drawn larger than true scale so they stay visible as the span
  // grows — a 4.5 m car is a third of a pixel across 11 km of corridor.
  //
  // The sprite is scaled as a WHOLE rather than floored on each axis
  // separately. Flooring length and width independently produced a car 6 px
  // long and 24 px wide at corridor length: drawn on its side, and nothing like
  // a vehicle. One factor keeps the proportions whatever the span.
  const widthM: Record<number, number> = { 1: 1.9, 2: 2.5, 3: 2.6 };
  /* Width exaggeration. 1.7 when vehicles were held to a bus's length per lane height and were otherwise
     slivers; with the larger size below a car keeps a car's proportions (about 2 : 1) at 1.3. */
  const widScale = 1.3;

  /**
   * How large to draw a vehicle, as one factor applied to both axes.
   *
   * True scale first. Enlargement is a FLOOR for legibility, not a target: at
   * 600 m on a wide screen a car is already 14.6 px and needs no help, and treating
   * the gap to the vehicle ahead as something to fill produced 101 px cars sitting
   * nose to tail. Only when true scale falls below what the eye can resolve does
   * the sprite grow, and even then it is capped so it cannot overlap its neighbour
   * or outgrow its lane.
   *
   * The floor used to be a flat 15 px, which reads as a speck once laneH grows
   * past a hundred-odd pixels — the lane got taller to stay legible but the
   * traffic inside it didn't. Tying the floor to laneH (a car at ~42% of the
   * lane's own drawn height) makes "big enough to see" track "big enough to
   * look like it's using its lane" instead of sitting still at 15 px on every
   * view. laneH*0.9 below is still the hard ceiling, so this only ever pulls
   * the sprite UP toward it, never past it.
   */
  const MIN_LEN_PX = 15;
  /* A car at about 60% of its lane's drawn height (was 42%). Lanes are drawn about four times true width
     for legibility, so true-scale vehicles read as specks on empty tarmac: 54 vehicles on 600 m looked like
     a quiet road. The squeeze below (drawnLengthPx) still keeps 30% of every real gap visible, so a bigger
     sprite never reaches the one behind it. */
  const LANE_LEN_FRAC = 0.62;
  const trueCarLen = 4.6 * mToPx;
  const lenFloor = Math.max(MIN_LEN_PX, laneH * LANE_LEN_FRAC);
  const kFloor = Math.max(trueCarLen, lenFloor) / Math.max(0.01, trueCarLen);
  /* The anti-overlap and lane-overflow ceilings used to be measured in CAR
   * lengths, so a floor big enough to make a car look right could still push
   * the shared k past what a much longer bus or truck (same k, real length up
   * to 16.5 m) can fit in its own slot. Measuring the ceilings in BUS lengths
   * (12 m — most of the fleet, short of the rare articulated truck) keeps k
   * honest for nearly everything sharing the road, at the cost of being a
   * little more conservative for cars specifically when traffic is dense. */
  const trueBusLen = 12 * mToPx;
  // A bus up to about two lane heights long (it was capped at 0.9, which is what held cars at ~16 px).
  const kOverflowCap = (laneH * 2.2) / Math.max(0.01, trueBusLen);
  /* No cap from the AVERAGE spacing any more: it shrank every vehicle on a carriageway as soon as one lane
     queued, so a jam turned the whole road back into specks. Each sprite is already squeezed to the room
     actually behind it (drawnLengthPx, noseGapM below), which is what keeps any two from touching. */
  const k = Math.min(kFloor, kOverflowCap);
  /** A car's own drawn length under that k — the scenario art's reference size for a "hero" vehicle. */
  const drawnCarLen = baseLengthPx(4.6, mToPx, k);
  // Every class is drawn at the car's width scale (facilityArt: one steady size per class).
  const widK = spriteWidthScale(mToPx, k);
  /* How far across from a lane a vehicle can be drawn and still touch something
     in it: half the widest sprite either side, and a little. A car changing
     lanes counts against a lane only when it is that close to it — halfway
     across it touches neither, and counting it in its new lane from the first
     instant squeezed the cars around it the moment it signalled. */
  const laneReach = Math.min(0.95, Math.min(laneH * 0.85, 2.6 * mToPx * widK * widScale) / Math.max(1, laneH) + 0.05);

  /* Lane identifiers.
   *
   * The controls are labelled L1..L4 and the carriageway was not, so an
   * operator had to count lanes from the top and already know which end L1
   * was. A closed lane's tag turns red, which is the only place the control
   * and the road currently say the same thing in the same words.
   *
   * Drawn before the traffic on purpose: a passing vehicle covers the tag
   * rather than the tag covering the vehicle. These are a fixed reference,
   * not live data, and traffic enters at x = 0 right where they sit. */
  if (laneH >= 16) {
    const tagW = 20;
    const tagH = 13;
    ctx.font = "600 9px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let lane = 0; lane < lanes; lane++) {
      const cy = slotTop(lane) + laneH / 2;
      // A lent lane sits among the other carriageway's lanes, so its tag says whose it is.
      const lentHere = lent !== null && lane < lent.lanes;
      const w = lentHere ? tagW + 16 : tagW;
      ctx.fillStyle = "rgba(9,14,28,0.72)";
      roundRect(ctx, roadView.pan + 5, cy - tagH / 2, w, tagH, 3);
      ctx.fill();
      const closed = sim.interventions.closedLanes[lane];
      ctx.fillStyle = closed ? "#fca5a5" : lentHere ? "rgba(253,224,71,0.95)" : "rgba(255,255,255,0.6)";
      ctx.fillText(lentHere ? `${sb ? "SB" : "NB"} L${lane + 1}` : `L${lane + 1}`, roadView.pan + 5 + w / 2, cy + 0.5);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  const motoShare = ASSUMPTIONS.MOTORCYCLE_SHARE_OF_CLASS_1.value;
  let motorcycles = 0;
  let class1 = 0;
  /* How much room each sprite actually has behind it.
   *
   * `k` inflates every vehicle so a 4.6 m car is still visible when a
   * kilometre is on screen, and its anti-overlap cap is computed from AVERAGE
   * spacing. A standing queue is nothing like average: the engine guarantees a
   * real gap of MIN_CLEARANCE (0.5 m), which at this zoom is under a pixel, so
   * an inflated sprite is drawn straight through the one behind it and the
   * queue renders as a solid bar.
   *
   * The physics is correct — the overlap diagnostic reports zero — so this is
   * purely the drawing. A vehicle's sprite is capped at the nose-to-nose
   * distance to its follower: that is exactly the room it has, and using it
   * means no sprite can reach into another however far k is pushed.
   *
   * Straddlers count in both lanes, the same rule the engine uses, so a car
   * halfway through a change cannot be drawn over one it is leaving. */
  /* Where each vehicle's nose is DRAWN, which is not where the engine has it.
   *
   * Between engine steps the canvas extrapolates each vehicle forward by its
   * own speed and acceleration, so a fast follower closes on a slow leader by
   * more than the engine gap suggests. Measuring the room from v.x therefore
   * allowed a sprite slightly longer than the space it would actually be
   * drawn into. Both the gap map and the sprites use the same extrapolated
   * positions now, so the cap below is exact rather than nearly right. */
  // The hard shoulder's vehicles (responders running up it, a vehicle pulled over onto it) are drawn with the traffic.
  const shoulderTraffic = (sim as { shoulder?: typeof sim.vehicles }).shoulder ?? [];
  const live = shoulderTraffic.length > 0 ? [...sim.vehicles, ...shoulderTraffic] : sim.vehicles;
  const leaving = exitGhosts(sim, live);
  const everyone = leaving.length > 0 ? [...live, ...leaving] : live;
  const noseXm = new Map<number, number>();
  for (const v of everyone) {
    noseXm.set(v.id, v.x + Math.max(0, v.v + 0.5 * v.accel * alphaS) * alphaS);
  }

  const noseGapM = new Map<number, number>();
  /** Nose to nose to whatever is ahead in the same lane (m): how far a headlight beam can reach before it lands on it. */
  const roomAheadM = new Map<number, number>();
  /* The same room for the plaza vehicles still out on the carriageway — on a
     taper leaving it, at the end of an acceleration lane joining it, anywhere
     on a barrier's fans — against the road traffic behind them. The engine
     keeps the two apart (its lane index counts both), but each layer used to
     size its sprites against only its own vehicles, so a car could be drawn
     into a truck leaving for a plaza, or a truck rejoining the road drawn back
     over the car behind it. Plaza vehicles among themselves are still spaced
     by the plaza layer, which knows their booth lanes. */
  const plazaRoomM = new Map<number, number>();
  /** The room behind a road vehicle to a PLAZA vehicle (m): the one thing a road vehicle is still shortened for, as the
   *  plaza layer draws its own vehicles by its own geometry. Against road traffic it keeps its size (see `geo`). */
  const plazaBehindM = new Map<number, number>();
  {
    /* `w`: how much this vehicle counts in the band, 0..1. A vehicle in its lane is 1. One changing lanes counts
       in both from the moment it starts, by how close it has come: nothing as it leaves the far lane's centre,
       fully once it is near enough to touch (laneReach). It used to switch from not counted to fully counted at
       that one point, so the cars either side of the gap it was moving into were drawn a size smaller in a single
       frame, and a size bigger again in the frame it cleared the lane it left — traffic round an event, which
       changes lanes in a queue all the time, pulsed. The room is now eased in and out with it (softRoom). */
    type Nose = { id: number; x: number; plaza: boolean; w: number; free: number };
    /* The least room at which a vehicle of this length is drawn at its full size (bisected off drawnLengthPx, once
       per length). The easing runs from there down to the real room, not from "unlimited": most of an ease from
       unlimited passes before the sprite is touched at all, and the whole change then lands in its last frames. */
    const freeByLen = new Map<number, number>();
    const freeRoomM = (lengthM: number): number => {
      const hit = freeByLen.get(lengthM);
      if (hit !== undefined) return hit;
      const base = baseLengthPx(lengthM, mToPx, k);
      let lo = lengthM;
      let hi = lengthM + 400;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (drawnLengthPx(base, lengthM, mid, mToPx) >= base - 0.01) hi = mid;
        else lo = mid;
      }
      freeByLen.set(lengthM, hi);
      return hi;
    };
    const softRoom = (gap: number, w: number, free: number) => gap + (1 - w) * Math.max(0, free - gap);
    const bands = new Map<number, Nose[]>();
    const put = (b: number, n: Nose) => {
      const arr = bands.get(b);
      if (arr) arr.push(n);
      else bands.set(b, [n]);
    };
    // How far through a lane change (0..1 of its time) a vehicle comes within reach of the lane it is moving into.
    let shiftAtReach = 0.5;
    {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (mid * mid * (3 - 2 * mid) >= 1 - laneReach) hi = mid;
        else lo = mid;
      }
      shiftAtReach = Math.max(0.05, hi);
    }
    for (const v of everyone) {
      const x = noseXm.get(v.id) ?? v.x;
      const across = visualLane(v);
      for (const b of v.laneFrom !== v.lane && v.laneShift < 1 ? [v.lane, v.laneFrom] : [v.lane]) {
        // Evenly over the time it takes to come within reach (not over the distance, which a lane change covers
        // slowly at first and then all at once): 0 as it sets off, 1 by the time it could touch.
        const off = Math.abs(across - b);
        const progress = v.laneShift >= 1 || v.laneFrom === v.lane ? 1 : b === v.lane ? v.laneShift : 1 - v.laneShift;
        /* A vehicle just entering the road counts in full at once. It used to be eased in over its first 14 m, so the
           one ahead kept its enlarged tail drawn over it there — measured, up to 8 px of a truck over the car behind,
           a few pixels in from the edge. It enters with its nose at the edge of the picture, so the one ahead is cut
           off there and nothing on screen changes size. */
        const w = off <= laneReach ? 1 : Math.max(0, Math.min(1, progress / shiftAtReach));
        if (w > 0.001) put(b, { id: v.id, x, plaza: false, w, free: freeRoomM(v.length) });
      }
    }
    for (const a of facView?.agents ?? []) {
      // In whichever lane its nose or its tail is drawn over; past the outer
      // lane's edge it is off the carriageway.
      const n = { id: a.id, x: a.u, plaza: true, w: 1, free: 80 };
      const into = new Set<number>();
      for (const w of [a.w, a.tw]) if (w < 0.78) into.add(Math.max(0, Math.min(lanes - 1, Math.round(lanes - 1 + w))));
      for (const b of into) put(b, n);
    }
    const tighter = (m: Map<number, number>, id: number, gap: number) => {
      // Tightest constraint wins when a vehicle appears in two bands.
      const prev = m.get(id);
      if (prev === undefined || gap < prev) m.set(id, gap);
    };
    for (const arr of bands.values()) {
      arr.sort((a, b) => a.x - b.x);
      for (let i = 0; i < arr.length; i++) {
        const n = arr[i];
        // Back to the first vehicle that fully counts: one only part-way in does not hide the one behind it.
        let plazaDone = !n.plaza;
        for (let j = i - 1; j >= 0; j--) {
          const o = arr[j];
          const w = Math.min(n.w, o.w);
          const room = softRoom(n.x - o.x, w, n.free);
          if (!n.plaza) {
            tighter(noseGapM, n.id, room);
            if (o.plaza) tighter(plazaBehindM, n.id, room);
          } else if (!plazaDone && !o.plaza) {
            tighter(plazaRoomM, n.id, room);
            if (o.w >= 0.999) plazaDone = true;
          }
          tighter(roomAheadM, o.id, softRoom(n.x - o.x, w, 80));
          if (o.w >= 0.999 && (plazaDone || !n.plaza)) break;
        }
      }
    }
  }

  /* A scene's own vehicles at rest — its wrecks and its parked responders — are laid out together, front to back, at
     one scale. Sized one by one to the room behind each, as the traffic is, a crash came out as a big car hitting a
     small one, an ambulance twice the size of the police car beside it, and a car that shrank to half its size the
     moment it was hit. They keep the traffic's size where the shut stretch behind them has room for that, nose to tail
     in the order they really stand; where it has not, all of them shrink alike. A vehicle still driving into the scene
     is held (on screen) at the drawn tail of the one it is about to hit, so the contact is shown where it is drawn. */
  const sceneLayout = new Map<number, { xm: number; len: number }>();
  {
    const groups = new Map<string, (typeof everyone)[number][]>();
    for (const v of everyone) {
      if (v.sceneKey === undefined || v.departing) continue;
      if (v.role === "traffic" && v.doom === undefined) continue;
      // A responder still pulling in is laid out with the scene too (held a visible gap short of it), so it is never
      // drawn into the wreck it is stopping behind in the frames before it is parked.
      if (v.role === "responder" && v.stillSince == null && v.holdAtX == null) continue;
      const key = `${v.sceneKey}|${v.onShoulder ? "shoulder" : v.lane}`;
      const g = groups.get(key);
      if (g) g.push(v);
      else groups.set(key, [v]);
    }
    for (const members of groups.values()) {
      const lane = members[0].lane;
      const shoulder = Boolean(members[0].onShoulder);
      const inGroup = new Set(members);
      // Everyone else in the same lane (or on the shoulder), so a run of the scene's vehicles stops at the first stranger.
      // (Not the scene's own responders crossing in: counted as strangers, one squeezed the whole scene up small while
      // it crossed, and the scene jumped back to full size the frame it arrived.)
      const sceneKey = members[0].sceneKey;
      const strangers = everyone.filter(
        (o) =>
          !inGroup.has(o) && !(o.role === "responder" && o.sceneKey === sceneKey && !o.departing) &&
          (shoulder ? Boolean(o.onShoulder) : !o.onShoulder && (o.lane === lane || (o.laneShift < 1 && o.laneFrom === lane))),
      );
      const all = [...members, ...strangers].sort((a, b) => b.x - a.x);
      // Runs of the scene's vehicles with nobody else between them, front first; each is laid out on its own.
      const runs: (typeof everyone)[number][][] = [];
      let run: (typeof everyone)[number][] = [];
      for (const v of all) {
        if (inGroup.has(v)) run.push(v);
        else if (run.length > 0) {
          runs.push(run);
          run = [];
        }
      }
      if (run.length > 0) runs.push(run);
      /* The drawn gap between two of a scene's vehicles at rest: the real one, scaled with the scene, but never less
         than a visible 3 px plus what each one's angle swings its corners out by. They used to be laid nose to tail
         0.5 m apart — a pixel at the whole view — so a crash, its ambulance and its police car were drawn as one
         bumper-to-bumper chain, the turned wrecks a pixel or two into each other. */
      const swing = (v: (typeof everyone)[number], lenPx: number) =>
        0.3 * lenPx * Math.abs(Math.sin(v.yaw ?? (v.role === "wreck" ? v.restAngle ?? 0 : 0)));
      const restGapM = (prev: (typeof everyone)[number], v: (typeof everyone)[number], realM: number, scale: number, prevPx: number, lenPx: number) =>
        Math.max(realM * scale, (3 + swing(prev, prevPx) + swing(v, lenPx)) / mToPx);
      /* Everyone at full size, in the order they really stand. Responders are drawn where the engine has them; a
         wreck at its real position or, if the one in front is drawn reaching back over it, a visible gap behind it
         (its real gap, or 3 px plus what each one's angle swings out by). Where that leaves no room, the last pass
         over everything (below) draws whoever is behind further back — it never shrinks anyone. The scene used to be
         scaled down to fit its closure, so wrecks changed size as an ambulance arrived and grew back when towed. */
      for (const list of runs) {
        const moving = (v: (typeof everyone)[number]) => v.role === "traffic" || (v.role === "responder" && v.stillSince == null);
        const anchor = (v: (typeof everyone)[number]) => v.role === "responder";
        let tailM = Infinity;
        let prevPx = 0;
        list.forEach((v, i) => {
          const real = moving(v) ? noseXm.get(v.id) ?? v.x : v.x;
          const prev = i > 0 ? list[i - 1] : null;
          const gapM = prev === null ? 0 : Math.max(0.4, prev.x - prev.length - v.x);
          const base = drawnLengthPx(baseLengthPx(v.length, mToPx, k), v.length, plazaBehindM.get(v.id) ?? Infinity, mToPx);
          const len = moving(v) ? -1 : base;
          const drawn = base;
          let xm = real;
          if (prev !== null && !anchor(v)) {
            // Still driving into the scene: held a visible gap short of the drawn tail of the one it is about to hit.
            const keep = restGapM(prev, v, gapM, 1, prevPx, drawn);
            xm = Math.min(real, tailM - keep);
          }
          sceneLayout.set(v.id, { xm, len });
          tailM = xm - drawn / mToPx;
          prevPx = drawn;
        });
      }
    }
  }

  /* The hard shoulder, for what is on it: its middle, or a little further out for a vehicle too wide for it, so it
     clears the outer lane's traffic. A vehicle crossing to or from it slides between that and its lane. */
  const outerEdgePx = reverseLanes ? roadTop : roadTop + roadH;
  const outwardPx: 1 | -1 = reverseLanes ? -1 : 1;
  const yOnRoad = (v: (typeof everyone)[number], across: number, xm: number, wid: number): number => {
    if (!(v.onShoulder || v.viaShoulder) || across <= lanes - 1) return laneCentreAt(across, xm);
    const inLane = laneCentreAt(lanes - 1, xm);
    const onIt = outerEdgePx + outwardPx * Math.max(shoulderPx(laneH) / 2, wid / 2 - laneH * 0.08);
    return inLane + (onIt - inLane) * Math.min(1, across - (lanes - 1));
  };
  /** Where a vehicle's sprite goes: its drawn nose (m), length and width (px), lanes across, centre line, and the angle
   *  it is turned to — never further round than keeps it inside its own lane, so a wreck does not reach into traffic. */
  /** A vehicle's drawn length: its true length, whatever is round it (facilityArt's TRUE SIZE). */
  const easedLen = (v: (typeof everyone)[number]): number =>
    drawnLengthPx(baseLengthPx(v.length, mToPx, k), v.length, plazaBehindM.get(v.id) ?? Infinity, mToPx);
  // Test hook: a page under test sets window.__spriteLog to a Map and reads each vehicle's drawn length per frame.
  const spriteLog = typeof window !== "undefined" ? (window as unknown as { __spriteLog?: Map<string, number[]> }).__spriteLog : undefined;
  /* Where everything is drawn this frame: nose (m) and length (px).
   *
   * A scene's vehicles are drawn a little back from their engine positions (the layout above, so its enlarged sprites
   * fit nose to tail). Whenever one joined or left the layout — an ambulance pulling in, the scene packing up to
   * drive away — it jumped between the two: measured, an ambulance 38 m in one frame. So the OFFSET from the real
   * position is eased (about 0.4 s of simulated time; paused, nothing moves), not the position: a scene that packs
   * up catches up with where its vehicles really are while they drive.
   *
   * Then one rule over everything drawn, lane by lane: a sprite never reaches back over the drawn nose of anything
   * behind it that it could touch across the road — it is shortened instead. Whatever the easing, the layout or a
   * lane change does, nothing is drawn over anything else. */
  const glide = sceneGlideOf(sim);
  const geo = new Map<number, { xm: number; len: number }>();
  for (const v of everyone) {
    const laid = sceneLayout.get(v.id);
    const real = noseXm.get(v.id) ?? v.x;
    const want = laid === undefined ? 0 : real - laid.xm;
    const prev = glide.get(v.id);
    let d = want;
    if (prev !== undefined && sim.time >= prev.t) d = prev.d + (want - prev.d) * (1 - Math.exp(-Math.max(0, sim.time - prev.t) / SCENE_GLIDE_S));
    if (laid === undefined && Math.abs(d) < 0.02) glide.delete(v.id);
    else if (laid !== undefined || prev !== undefined) glide.set(v.id, { d, t: sim.time });
    geo.set(v.id, { xm: real - d, len: laid !== undefined && laid.len > 0 ? laid.len : easedLen(v) });
  }
  /* Full size, never drawn over one another: where there is not room, a vehicle is drawn further BACK, not shorter.
   *
   * At the whole view a car is drawn about 10 m long, and a standing queue in the engine is a car every 6.6 m — so
   * either the sprites shrink in a queue (they did, in 5–14% of frames round an event) or they overlap, unless the
   * queue is drawn longer than the engine's. It is: front to back, each vehicle is drawn at its engine position or,
   * if that would put it into the drawn tail of one ahead that it could touch, a visible 2 px behind that tail. The
   * difference is soaked up a few vehicles further back, where moving traffic leaves far bigger gaps than any
   * sprite needs.
   *
   * Two vehicles count against each other by how close they are ACROSS the road, pair by pair: in full once near
   * enough to touch, not at all a whole lane apart, and in between in proportion — so a vehicle changing lanes
   * pushes the one behind it back smoothly as it comes across, and a whole queue moving over together (a lane
   * reopening) still never overlaps itself. A vehicle let go — the one ahead moved off or moved over — catches up
   * with where it really is over about a second (DISPLACE_EASE_S), rather than jumping forward. Nothing is contact
   * by design, not even a casualty on the tow truck's hook (it is drawn just behind the truck). Drawing only: the
   * engine, and every figure, are untouched. */
  {
    const MARGIN_M = 2 / mToPx;
    const disp = displaceStateOf(sim);
    type Done = { tail: number; across: number; swing: number };
    // How far a vehicle turned at an angle (a wreck, one skidding) swings its corners out past its length, in metres.
    const swingM = (v: (typeof everyone)[number], lenPx: number) => (0.3 * lenPx * Math.abs(Math.sin(v.yaw ?? (v.role === "wreck" ? v.restAngle ?? 0 : 0)))) / mToPx;
    const done: Done[] = [];
    const order = [...everyone].sort((a, b) => geo.get(b.id)!.xm - geo.get(a.id)!.xm);
    const seen = new Set<number>();
    for (const v of order) {
      const g = geo.get(v.id)!;
      const real = g.xm;
      const across = visualLane(v);
      const swing = swingM(v, g.len);
      let xm = real;
      for (let i = done.length - 1; i >= Math.max(0, done.length - 48); i--) {
        const e = done[i];
        const da = Math.abs(e.across - across);
        if (da >= 1) continue;
        const ww = da <= laneReach ? 1 : (1 - da) / Math.max(1e-6, 1 - laneReach);
        const cap = e.tail - MARGIN_M - e.swing - swing;
        xm = Math.min(xm, cap + (1 - ww) * Math.max(0, real - cap));
      }
      // Let go gradually: never drawn further forward than the easing allows (further back is always safe).
      let d = real - xm;
      const st = disp.get(v.id);
      if (st !== undefined && sim.time > st.t && d < st.d) d = d + (st.d - d) * Math.exp(-(sim.time - st.t) / DISPLACE_EASE_S);
      else if (st !== undefined && sim.time === st.t) d = Math.max(d, st.d);
      if (d > 0.01) disp.set(v.id, { d, t: sim.time });
      else disp.delete(v.id);
      seen.add(v.id);
      g.xm = real - d;
      done.push({ tail: g.xm - g.len / mToPx, across, swing });
    }
    for (const id of disp.keys()) if (!seen.has(id)) disp.delete(id);
  }
  const spriteOf = (v: (typeof everyone)[number]) => {
    const laid = sceneLayout.get(v.id);
    const g = geo.get(v.id) ?? { xm: noseXm.get(v.id) ?? v.x, len: easedLen(v) };
    const xm = g.xm;
    const len = g.len;
    if (spriteLog && v.role === "traffic" && laid === undefined) {
      const key = `${sb ? "SB" : "NB"}${v.id}`;
      const arr = spriteLog.get(key);
      const row = [len, xm, v.laneShift < 1 ? 1 : 0, performance.now(), noseGapM.get(v.id) ?? -1, sim.time];
      if (arr) arr.push(...row);
      else spriteLog.set(key, row);
    }
    const wid = drawnWidthPx(Math.max(2, Math.min(laneH * 0.85, widthM[v.vClass] * mToPx * widK * widScale)), len);
    // visualLane, not v.lane: the integer flips the instant MOBIL accepts
    // the move, which drew the change as a one-frame jump across a whole lane.
    const across = visualLane(v);
    const turn = v.yaw ?? (v.role === "wreck" ? v.restAngle ?? 0 : 0);
    const lim = Math.asin(Math.max(0, Math.min(1, (laneH * 0.47 - wid / 2) / Math.max(1, len / 2))));
    return { xm, len, wid, across, y: yOnRoad(v, across, xm, wid), yaw: Math.max(-lim, Math.min(lim, turn)) };
  };

  // The scenario events' art shares the traffic's scale: a "hero" vehicle is a car drawn a little larger.
  const heroLen = Math.max(18, Math.min(drawnCarLen * 2.4, laneH * 1.25));
  const sceneGeom: SceneGeometry = {
    ctx,
    cssW,
    roadTop,
    roadH,
    laneH,
    xPx,
    fwd,
    laneCenterY,
    outerEdgeY: reverseLanes ? roadTop : roadTop + roadH,
    outward: reverseLanes ? -1 : 1,
    carLen: heroLen,
    carWid: Math.max(9, Math.min(heroLen * 0.46, laneH * 0.62)),
    t: animT,
    // The plazas and service areas beside this carriageway: rain falls on them as on the road.
    wetAreas: facGeom && facView ? facilityWetAreas(facGeom, facView.list) : undefined,
  };
  /* Each scene's own vehicles as they are drawn this frame — its wrecks and its responders, by event — so the people,
     cones and marks of a scene go round the vehicles that are really there, not at fixed offsets from its point. */
  const actors = new Map<string, SceneActor[]>();
  for (const v of everyone) {
    if (v.sceneKey === undefined || v.role === "traffic") continue;
    const sp = spriteOf(v);
    const cast = actors.get(v.sceneKey) ?? [];
    cast.push({
      kind: v.role === "wreck" ? "wreck" : v.responderKind ?? "police",
      cx: xPx(sp.xm) - fwd * (sp.len / 2), cy: sp.y, len: sp.len, wid: sp.wid, yaw: sp.yaw,
      still: v.stillSince != null ? Math.max(0, sim.time - v.stillSince) : null,
      departing: Boolean(v.departing), onShoulder: Boolean(v.onShoulder), look: v.look ?? null,
    });
    actors.set(v.sceneKey, cast);
  }
  // What the crashes left on the road — skid marks, glass, a spilled load — goes UNDER the traffic.
  drawSceneGround(sceneGeom, scenes, actors);

  /* Night: each vehicle's headlights throw a beam ahead of it along its lane. Drawn before the sprites, so
     the light falls on the road and the vehicles sit on top of it. Wrecks are dark. */
  if (lights) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.42 * night;
    const beamLen = Math.min(laneH * 1.6, Math.max(18, drawnCarLen * 3.2));
    const beamW = laneH * 0.78;
    for (const v of sim.vehicles) {
      if (v.role === "wreck") continue;
      const xm = noseXm.get(v.id) ?? v.x;
      const x = xPx(xm);
      if (x < -beamLen || x > cssW + beamLen) continue;
      const y = laneCentreAt(visualLane(v), xm);
      // To the car ahead and a little onto it, not through a queue: overlapping beams pile up into haze.
      const ahead = roomAheadM.get(v.id);
      const reach = ahead === undefined ? beamLen : Math.min(beamLen, Math.max(drawnCarLen * 0.5, (ahead - 4.6) * mToPx + drawnCarLen * 0.3));
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(fwd, 1);
      ctx.drawImage(lights.beam, 0, -beamW / 2, reach, beamW);
      ctx.restore();
    }
    ctx.restore();
  }
  /** Where each vehicle's tail lights are, recorded as it is drawn, for the glow pass after the sprites. */
  const tails: { x: number; y: number; r: number; braking: boolean }[] = [];
  /* Test hook: a page under test sets window.__spriteDump to { rows: [], every: seconds } and gets every drawn
     sprite (traffic, wrecks, responders) about every `every` simulated seconds, to check a scene for vehicles that
     appear or vanish mid-road, jump, or are drawn over one another. Nothing is recorded otherwise. */
  const dumpHook = typeof window !== "undefined" ? (window as unknown as { __spriteDump?: { rows: unknown[]; every: number; last?: Record<string, number> } }).__spriteDump : undefined;
  const dirKey = sb ? "SB" : "NB";
  const dumping = dumpHook !== undefined && sim.time - (dumpHook.last?.[dirKey] ?? -Infinity) >= dumpHook.every;
  if (dumping) dumpHook.last = { ...dumpHook.last, [dirKey]: sim.time };

  for (const v of everyone) {
    try {
      // One factor for every class, so a bus still reads as longer than a car.
      // Capped by the room behind it — see noseGapM above.
      /* Leave the gap visible, not just a seam.
       *
       * Capping at the full nose-to-nose distance made a sprite end exactly
       * where the next one starts — a solid bar of car, indistinguishable from
       * cars drawn through each other — and a 1.5 px seam was still read as
       * vehicles overlapping once sprites were forty-odd pixels long. The
       * physics diagnostic reported 0.00% throughout, because it measures v.x
       * and v.length, the ENGINE's geometry, and never sees the inflated
       * sprite. drawnLengthPx lets the enlargement take only part of the real
       * gap behind a vehicle; the drawn length only, so the simulation is
       * untouched. */
      const sprite = spriteOf(v);
      const len = sprite.len;
      let wid = sprite.wid;
      const across = sprite.across;
      let y = sprite.y;
      /* Still out beyond the outer lane: merging off an acceleration lane. The
         plaza layer drew this vehicle there a frame ago, in the plaza's band at
         the plaza's scale (narrower than the road's), and it is handed over as a
         lane change from that slot. Drawn at the road's scale instead, it jumped
         out by half a lane the moment it started to merge, then slid in — the
         "teleport". Placed and sized by the plaza's own rule until it is across
         the road edge, it glides in from exactly where it was. */
      if (facGeom && across > lanes - 1 && !v.onShoulder && !v.viaShoulder) {
        const w = across - (lanes - 1);
        y = facGeom.yOf(w);
        const slotWid = FAC_LANE * DRAW_W_FRAC * (w > 0.5 ? facGeom.gutterPx : laneH);
        wid = Math.min(wid, slotWid + (wid - Math.min(wid, slotWid)) * Math.max(0, 1 - w));
      }
      // Braking, or already stopped. The threshold is a real lift-off rather
      // than any negative value, so brake lights do not flicker on the small
      // corrections every car-following model makes continuously.
      const braking = v.accel < -0.6 || v.v < 3;
      const moto = isMotorcycle(v.id, v.vClass, motoShare);
      if (v.vClass === 1) class1++;
      if (moto) motorcycles++;
      /* Where it is NOW, not where it was at the last 0.05 s boundary. Constant
       * acceleration over a fraction of one step; clamped so a braking vehicle
       * is never drawn sliding backwards, which the kinematics would allow once
       * v + a*alpha goes negative. */
      const xDrawn = sprite.xm;
      const xNose = xPx(xDrawn);
      /* Wrecks and responders are real agents now, so they are drawn HERE,
         with the traffic, rather than by the scene layer on top of it. That
         is the whole point of the change: one list of vehicles, one set of
         positions, so nothing can be drawn where the engine does not think it
         is. A wreck keeps the angle it came to rest at; a responder gets its
         own livery and a flashing bar. */
      const paint = moto ? motorcyclePaintFor(v.id) : paintFor(v.id, v.vClass);
      if (dumping && xNose > -60 && xNose < cssW + 60) {
        dumpHook.rows.push([dirKey, +sim.time.toFixed(2), v.id, v.role === "responder" ? v.responderKind ?? "responder" : v.role, +(xNose - fwd * (len / 2)).toFixed(1), +y.toFixed(1), +len.toFixed(1), +wid.toFixed(1), +sprite.yaw.toFixed(3), +sprite.xm.toFixed(1), v.onShoulder || v.viaShoulder ? 1 : 0, v.towedBy ? 1 : 0, +cssW.toFixed(0), +mToPx.toFixed(3)]);
      }
      if (v.role === "wreck" || v.look === "overturned") {
        // The vehicle that crashed or broke down, as itself: its own paint, at the angle it came to rest.
        drawWreckAgent(ctx, xNose, y, len, wid, sprite.yaw, sb, animT, v.vClass, paint, trailerPaintFor(v.id), v.look ?? "crash", v.hazards ?? true, moto);
      } else if (v.role === "responder") {
        drawResponderAgent(ctx, xNose, y, len, wid, v.responderKind ?? "police", sb, animT);
      } else {
        if (sprite.yaw !== 0) {
          // Skidding into it: turned as it slides.
          ctx.save();
          ctx.translate(xNose - fwd * (len / 2), y);
          ctx.rotate(sprite.yaw);
          drawVehicle(ctx, fwd * (len / 2), 0, len, wid, v.vClass, paint, braking, sb, trailerPaintFor(v.id), moto);
          ctx.restore();
        } else drawVehicle(ctx, xNose, y, len, wid, v.vClass, paint, braking, sb, trailerPaintFor(v.id), moto);
        // Slowing to a stop with a fault: its hazards are already on.
        if (v.hazards) drawHazardLamps(ctx, xNose - fwd * (len / 2), y, len, wid, sprite.yaw, animT);
        if (lights) tails.push({ x: xNose - fwd * len, y, r: Math.max(4, wid * 0.55), braking });
      }
      // The body trails behind the nose: to the left going north, to the right going south.
      vehicleHits.push({
        id: v.id,
        dir: sb ? "SB" : "NB",
        born: v.spawnTime,
        left: sb ? xNose : xNose - len,
        right: sb ? xNose + len : xNose,
        top: y - wid / 2,
        bottom: y + wid / 2,
        kmh: v.v * 3.6,
        vClass: v.vClass,
        lane: v.lane + 1,
        moto,
        where: v.onShoulder ? "Hard shoulder" : undefined,
      });
    } catch (err) {
      // One unusable sprite must not take the remaining traffic with it: a
      // throw here previously painted the road and skipped every vehicle after
      // it, which reads on screen as an empty simulation rather than a fault.
      if (!renderFailureReported) {
        renderFailureReported = true;
        console.error("[sandbox] vehicle rendering failed:", err, {
          len: v.length,
          vClass: v.vClass,
          laneH,
          mToPx,
        });
      }
    }
  }

  // Night: tail lights glow red behind every vehicle, brighter while it brakes — the stop-and-go waves
  // read as pulses of red running back through the traffic.
  if (lights && tails.length > 0) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const t of tails) {
      ctx.globalAlpha = (t.braking ? 0.8 : 0.35) * night;
      const r = t.braking ? t.r * 1.15 : t.r;
      // Centred a little behind the bumper, so the glow falls on the road there rather than on the car behind.
      const cx = t.x - fwd * r * 0.35;
      ctx.drawImage(lights.tail, cx - r, t.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  /* Vehicles in the plazas and service areas: the same sprites at the same
   * scale, turned to face along the lane they are on. */
  const facSprite: SpriteFn = (a, len, wid, braking) => {
    if (a.role === "wreck") {
      // A breakdown at a booth stands straight (no resting angle); a crash is crumpled.
      drawWreckAgent(ctx, 0, 0, len, wid, a.restAngle ?? 0, false, animT, a.vClass, paintFor(a.id, a.vClass), trailerPaintFor(a.id), a.restAngle === undefined ? "stalled" : "crash");
    } else if (a.role === "responder") {
      drawResponderAgent(ctx, 0, 0, len, wid, a.responderKind ?? "tow", false, animT);
    } else {
      const moto = isMotorcycle(a.id, a.vClass, motoShare);
      drawVehicle(ctx, 0, 0, len, wid, a.vClass, moto ? motorcyclePaintFor(a.id) : paintFor(a.id, a.vClass), braking, false, trailerPaintFor(a.id), moto);
    }
  };
  // Cars parked at the service areas: scenery, in the traffic's own sprites at the traffic's own size.
  if (facGeom && facView) drawParkedCars(facGeom, facView, k, facSprite);
  if (facGeom && facView && facView.agents.length > 0) {
    const nameOf = new Map(facView.list.map((f) => [f.spec.id, f.spec.name]));
    const drawn = drawFacilityVehicles(facGeom, facView, k, plazaRoomM, facSprite);
    for (const h of drawn) {
      const a = facView.agents.find((x) => x.id === h.id);
      vehicleHits.push({
        id: h.id, dir: sb ? "SB" : "NB", born: h.born, left: h.left, right: h.right, top: h.top, bottom: h.bottom,
        kmh: h.kmh, vClass: h.vClass, lane: 0, moto: isMotorcycle(h.id, h.vClass, motoShare),
        where: a ? nameOf.get(a.fid) : undefined,
      });
    }
  }

  // What is on this carriageway right now, for the browser checks (a motorcycle is rare, so the picture alone is a poor test).
  ctx.canvas.dataset[sb ? "motoSb" : "motoNb"] = String(motorcycles);
  ctx.canvas.dataset[sb ? "class1Sb" : "class1Nb"] = String(class1);

  // Plaza canopies and service-area roofs over the vehicles under them, then their labels —
  // including any scenario event set at a booth, pump or ramp, labelled where it is.
  if (facGeom && facView) {
    const siteMarks = overlay
      ? canvasMarks(overlay.events, roadOf(sim, overlay.frame), sim.time).flatMap((m) =>
          m.site ? [{ site: m.site, name: m.name, text: m.text, state: m.state, secondsUntilStart: m.secondsUntilStart }] : [],
        )
      : [];
    for (const hit of drawFacilityOverlay(facGeom, facView, highlightFacility, siteMarks)) {
      labelHits.push({ left: hit.left, top: hit.top, w: hit.w, h: hit.h, full: hit.full, look: hit.active ? "site" : "sitePending" });
    }
  }

  // incidents
  for (const inc of sim.interventions.incidents) {
    const y = slotTop(inc.lane) + laneH * 0.5;
    // A scenario's obstacle is drawn by the scene art (a stalled vehicle with its hazard lights), so it
    // cannot be mistaken for the operator's red "!" dot, which is all that is drawn here.
    if (overlay && overlay.isScenarioIncident(inc)) continue;
    ctx.fillStyle = "#dc2626";
    ctx.beginPath();
    ctx.arc(xPx(inc.x), y, Math.min(8, laneH * 0.32), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 10px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("!", xPx(inc.x), y);
  }

  // Scenario events as scenes, round their own vehicles (drawn above with the traffic): the people, the cones, the
  // work zone — then the weather over everything, then each event's label (phase and time left) on top.
  drawScenes(sceneGeom, scenes, actors);
  // The weather of both carriageways: they share a sky (ScenarioOverlay.sky).
  const skyMarks: readonly SceneMark[] = overlay?.sky
    ? sceneMarks(overlay.sky.events, roadOf(sim, overlay.sky.frame), sim.time, NO_OWNERS).filter((m) => m.family === "rain" || m.family === "flood")
    : [];
  drawWeather(sceneGeom, skyMarks.length ? [...scenes, ...skyMarks] : scenes);
  if (overlay) {
    /* The label says who is there. "Awaiting response" is the phase's name, and it is true only until somebody
       arrives: with a patrol car parked behind the wreck it read as a mistake. Asked of the engine (a recording
       cannot say, and keeps the phase's own words). */
    const engine = sim as { sceneAttended?: (key: string) => boolean };
    const wording = (m: SceneMark): string =>
      m.state === "active" && typeof engine.sceneAttended === "function" && engine.sceneAttended(m.eventId)
        ? m.text.replace("awaiting response", "responders on scene").replace("Waiting for responder", "Patrol on scene, awaiting recovery")
        : m.text;
    drawScenarioLabels(ctx, scenes, {
      xPx,
      roadTop,
      laneH,
      roadH,
      cssW,
      r: Math.min(9, laneH * 0.36),
      lanes,
      reverseLanes,
      laneTop: slotTop,
      wording,
    });
  }
  // A Copilot proposal not yet applied, outlined where it would land.
  drawPlanGhosts(ctx, planGhosts[sb ? "SB" : "NB"], { xPx, roadTop, roadH, laneH, cssW, lanes, laneTop: slotTop, animT });

  // direction arrow
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "10px system-ui";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  // ── Exits ───────────────────────────────────────────────────────────────────
  // Drawn as real off-ramps, not tick marks. A junction used to be a cyan line
  // across the carriageway, which told an operator WHERE it was but not what it
  // was — the road read as an unbroken strip of tarmac with annotations on it.
  // A ramp peeling off the outer edge is the thing they are actually looking at
  // on the corridor, so the picture matches the road.
  //
  // Traffic drives on the right here, so exits leave from the OUTER lane, which
  // is the highest lane index and therefore the bottom of the canvas. The ramp
  // trails away in the direction of travel, which flips with the carriageway.
  {
    // `edge` is the carriageway side the ramp leaves from; `out` is the
    // direction away from the road, so one sign flips the whole shape.
    const edge = rampsAbove ? roadTop + 1 : roadTop + roadH - 1;
    const out = rampsAbove ? -1 : 1;
    const rampLen = Math.max(26, Math.min(70, cssW * 0.06));
    /* Every vertical measurement here comes out of the reserved gutter, never
     * out of laneH. Tying the ramp to lane height meant a tall canvas drew it
     * up to 114 px below the carriageway while only 34 px had been set aside,
     * so it spilled past the bottom of the canvas as a stray dark wedge. */
    const rampDrop = rampGutter * 0.35;
    const rampThick = rampGutter * 0.24;
    const fwd = sb ? -1 : 1; // on-screen direction of travel

    /* Only where traffic really leaves or joins at a point: the engine's own plain ramps — an exit or an
     * entry on this carriageway that could not be laid out as a plaza. Every plaza, service area and laid-out
     * ramp draws itself. Drawn for every interchange in view instead, a ramp appeared where this carriageway
     * has no exit at all (Tabang Guiguinto and SCTEX southbound, the Bocaue Barrier northbound, the two ends
     * of the corridor) — at Tabang through the booths of its entry plaza — and at the interchange's km rather
     * than where its exit is when that plaza stood just outside the window (San Simon, CDV northbound). */
    for (const r of sim.cfg.ramps ?? []) {
      const leaves = r.offFraction > 0;
      if (!leaves && r.onVehPerHour <= 0) continue;
      const x = xPx(r.x);
      if (x < -rampLen || x > cssW + rampLen) continue;
      const km = sb ? toKm - r.x / 1000 : fromKm + r.x / 1000;
      // An off-ramp trails away in the direction of travel; an on-ramp comes in from behind.
      const away = leaves ? fwd : -fwd;
      const xEnd = x + away * rampLen;

      // The ramp surface: same asphalt as the mainline so it reads as road
      // rather than as an overlay, tapering as it leaves.
      ctx.fillStyle = asphalt;
      ctx.beginPath();
      ctx.moveTo(x, edge);
      ctx.lineTo(xEnd, edge + out * rampDrop);
      ctx.lineTo(xEnd, edge + out * (rampDrop + rampThick));
      ctx.lineTo(x - away * rampThick * 1.6, edge);
      ctx.closePath();
      ctx.fill();

      // Gore: the painted wedge between mainline and ramp, which is what makes
      // a divergence legible at a glance.
      ctx.fillStyle = "rgba(226,232,240,0.30)";
      ctx.beginPath();
      ctx.moveTo(x, edge);
      ctx.lineTo(x + away * rampLen * 0.55, edge + out * rampDrop * 0.62);
      ctx.lineTo(x + away * rampLen * 0.22, edge);
      ctx.closePath();
      ctx.fill();

      // Ramp edge line.
      ctx.strokeStyle = "rgba(125,211,252,0.85)";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, edge);
      ctx.lineTo(xEnd, edge + out * rampDrop);
      ctx.stroke();

      // Name tag, sitting on the ramp rather than over the traffic lanes.
      const label = `${r.name} ${leaves ? "exit" : "entry"} · Km ${fmtKm(km, 2)}`;
      ctx.font = "600 11px system-ui";
      const w = ctx.measureText(label).width + 10;
      let left = away > 0 ? xEnd - w * 0.1 : xEnd - w * 0.9;
      left = Math.max(2, Math.min(cssW - w - 2, left));
      const top = rampsAbove
        ? Math.max(1, edge - rampDrop - rampThick - 15)
        : Math.min(cssH - 17, edge + rampDrop + rampThick - 1);
      ctx.fillStyle = "rgba(125,211,252,0.92)";
      roundRect(ctx, left, top, w, 16, 4);
      ctx.fill();
      ctx.fillStyle = "#04283a";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(label, left + 5, top + 3);
    }
  }

  // Km ladder. Without it the road is 600 m of anonymous tarmac and an operator
  // cannot say where on the corridor a queue is forming — which is the first
  // thing they need in order to act on it.
  // Both mode draws this once, shared, in the median (drawSharedKmAxis) rather
  // than once per carriageway — the two would print identical numbers at
  // identical x (see drawSharedKmAxis's own comment for why that is exact,
  // not approximate), so a second copy would only be a duplicate, not a check.
  if (drawAxis) {
    /* The scale sits outside the carriageway, opposite the ramps.
     *
     * It used to be printed at roadTop + roadH - 3, i.e. inside the bottom
     * lane. That was survivable only while lanes were 115 px tall and mostly
     * empty; at a true-to-scale 44 px the numbers land on the traffic.
     *
     * Which side depends on the direction, because the ramp gutter is also
     * outside the road: northbound the ramps are drawn above, so the scale
     * goes below, and southbound the other way round. Fixing it below for
     * both would have stacked the numbers on top of every southbound ramp. */
    const axisBelow = rampsAbove;
    /* Chips, not loose digits. At 10px and 55% white the km scale was legible
       on a 300px docked canvas and lost on a full-screen one, where the road is
       three times the size and the operator is further from it — the one thing
       that says WHERE a queue is forming was the hardest thing to read. The
       ladder scales with the road: a chip the traffic cannot wash out, and the
       gridline brightened to match. */
    const tall = roadH >= 260;
    const axisY = axisBelow ? roadTop + roadH + AXIS_H / 2 : roadTop - AXIS_H / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = tall ? "700 12px system-ui" : "600 10px system-ui";
    for (const { km, text } of kmAxisTicks(fromKm, toKm, roadView.zoom)) {
      const x = xPx(sb ? (toKm - km) * 1000 : (km - fromKm) * 1000);
      if (x < 2 || x > cssW - 2) continue;
      ctx.strokeStyle = tall ? "rgba(255,255,255,0.26)" : "rgba(255,255,255,0.16)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, roadTop);
      ctx.lineTo(x, roadTop + roadH);
      ctx.stroke();
      ctx.setLineDash([]);
      // A solid stub at the carriageway edge ties the number to its line.
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.beginPath();
      const edgeY = axisBelow ? roadTop + roadH : roadTop;
      ctx.moveTo(x, edgeY);
      ctx.lineTo(x, edgeY + (axisBelow ? 4 : -4));
      ctx.stroke();
      const tw = ctx.measureText(text).width;
      const ch = tall ? 17 : 14;
      ctx.fillStyle = "rgba(8,13,25,0.82)";
      roundRect(ctx, x - tw / 2 - 6, axisY - ch / 2, tw + 12, ch, 5);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.94)";
      ctx.fillText(text, x, axisY + 0.5);
    }
    // Says what the ladder counts, once, at the low-km end.
    ctx.font = tall ? "700 11px system-ui" : "600 9px system-ui";
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.textAlign = "left";
    ctx.fillText("KM POST", roadView.pan + 6, axisY + 0.5);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  ctx.font = "10px system-ui";
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  // Beside the lane tags, not over the first one, when the lanes are too short for the two to sit one above the
  // other (a small window, zoomed in, or Both mode's half-height carriageways).
  const flowX = laneH >= 16 && laneH < 48 ? 5 + (lent !== null ? 36 : 20) + 6 : 8;
  ctx.fillText(flowLabel, roadView.pan + flowX, roadTop + 4);

  // Where this stretch is on the corridor. Without it the canvas is 280 m of
  // anonymous tarmac and the route pickers appear to do nothing.
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "600 11px system-ui";
  ctx.textAlign = "right";
  ctx.fillText(location, roadView.pan + cssW / roadView.zoom - 8, roadTop + 4);
}

/**
 * render() unchanged in behaviour: single carriageway, full canvas height,
 * its own km axis, reverseLanes always false. Same signature D2 left it
 * with — the rAF loop's single-direction call site did not need to change.
 */
function render(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  sim: TrafficSim,
  location: string,
  // `direction` decides which end of the km range the canvas starts from;
  // travel itself is always drawn left to right.
  marks: { fromKm: number; toKm: number; direction: "NB" | "SB" },
  maxLaneH: number,
  exits: { name: string; km: number }[],
  overlay: ScenarioOverlay | null,
  animT: number,
  dayFraction: number,
  asphaltColor: string,
  /** See drawCarriageway's `alphaS`. */
  alphaS = 0,
  /** The plazas and service areas on this carriageway, live or recorded. */
  facView: FacilityView | null = null,
  highlightFacility: string | null = null,
) {
  vehicleHits.length = 0; // re-recorded by drawCarriageway() below
  labelHits.length = 0; // likewise
  const viewW = canvas.clientWidth;
  const cssW = roadW(viewW); // the zoomed road: everything below is laid out on it (see roadView)
  const cssH = canvas.clientHeight;
  fitBackingStore(ctx, canvas, viewW, cssH);
  ctx.clearRect(0, 0, viewW, cssH);
  roadView.pan = Math.max(0, Math.min(roadView.pan, cssW - viewW));
  // Not restored: fitBackingStore resets the transform at the start of the next frame, and what the loop draws
  // over the road after this (the speed bubble, the drop ghost) is drawn in the same shifted space.
  ctx.translate(-roadView.pan, 0);

  // The canvas has no size for a frame or two while the layout settles — most
  // visibly when entering full screen, where its height is elastic. Every
  // dimension below is derived from cssH, so a zero here turns into a negative
  // lane height, a negative vehicle width, and a negative corner radius that
  // throws inside drawVehicle. Canvas then paints the road and dies before the
  // traffic, every frame, which looks exactly like an empty simulation.
  if (cssW <= 0 || cssH <= 0) return;

  const L = sim.cfg.length;
  const lanes = sim.cfg.laneCount;
  /* Which side the off-ramps leave from. Northbound they are drawn above the
   * carriageway, southbound below, so the two directions are told apart at a
   * glance and the ramps always trail away from the traffic rather than
   * crossing it. The gutter is reserved on that same side, and the km scale
   * on the other — see roadLayout(), which owns all of that arithmetic and is
   * shared with the click handler and the page's canvas sizing. */
  /* Ramps hang off the OUTER lane's side. That used to be "above for
   * northbound, below for southbound" to tell the two apart, but a single
   * carriageway draws its outer lane at the bottom in either direction — so
   * northbound exits were drawn off the median side while the cars left from
   * the other edge. Now that vehicles drive the ramps, they must be the same
   * side. */
  const rampsAbove = false;
  const { rampGutter, gutterPx, laneH, roadH, roadTop } = roadLayout({
    cssW,
    cssH,
    lanes,
    segLenM: L,
    exitCount: exits.length,
    maxLaneH,
    rampsAbove,
    facDepth: facilityDepth(facView?.list),
    facBarrier: hasBarrier(facView?.list),
  });
  const mToPx = cssW / L;
  // The verge, under everything: trees beyond the shoulder, and on the inner side clear of the km scale.
  drawVerge(ctx, cssW, cssH, dayFraction, marks.fromKm, marks.toKm, [
    { top: 0, bottom: roadTop - AXIS_H - 6 },
    { top: roadTop + roadH + shoulderPx(laneH), bottom: cssH },
  ]);
  /* The corridor keeps a fixed, map-like orientation: the low km post is always
   * on the left. Southbound traffic therefore runs right to left, which is what
   * an operator expects to see — reversing the km axis instead made the road
   * flip end-for-end between directions and was disorienting.
   *
   * `xPx` maps a distance-along-travel to a screen position and so is mirrored;
   * `wPx` converts a LENGTH and must never be, which is the distinction that
   * makes spans need explicit min/max below. */
  const sb = marks.direction === "SB";
  const xPx = (x: number) => (sb ? cssW - x * mToPx : x * mToPx);
  const wPx = (m: number) => m * mToPx;

  drawCarriageway(ctx, sim, {
    cssW,
    cssH,
    roadTop,
    laneH,
    roadH,
    rampGutter,
    rampsAbove,
    reverseLanes: false,
    mToPx,
    sb,
    xPx,
    wPx,
    fromKm: marks.fromKm,
    toKm: marks.toKm,
    overlay,
    drawAxis: true,
    flowLabel: "▶ traffic flow",
    location,
    animT,
    alphaS,
    borrowed: 0,
    borrowedLabel: "",
    dayFraction,
    asphaltColor,
    facView,
    highlightFacility,
    gutterPx,
  });
}

/**
 * Both mode: two carriageways in one canvas, a shared median between them —
 * NB above (traffic left to right, lane 1 reversed to draw next to the
 * median below it), SB below (traffic right to left, lane 1 already draws
 * next to the median above it, unchanged from single-direction). One shared
 * km axis in the median rather than one per carriageway (see
 * drawSharedKmAxis) — this is the "whole carriageway, 8 lanes, 4 north +
 * 4 south" picture as one road, not two.
 */
function renderBoth(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  simNB: TrafficSim,
  simSB: TrafficSim,
  marks: { fromKm: number; toKm: number },
  maxLaneH: number,
  exits: { name: string; km: number }[],
  overlayNB: ScenarioOverlay | null,
  overlaySB: ScenarioOverlay | null,
  animT: number,
  zipper: ZipperState | null,
  dayFraction: number,
  asphaltColor: string,
  /** See drawCarriageway's `alphaS`. */
  alphaS = 0,
  facViewNB: FacilityView | null = null,
  facViewSB: FacilityView | null = null,
  highlightFacility: string | null = null,
) {
  vehicleHits.length = 0; // re-recorded by both drawCarriageway() calls below
  labelHits.length = 0; // likewise
  const viewW = canvas.clientWidth;
  const cssW = roadW(viewW); // the zoomed road: everything below is laid out on it (see roadView)
  const cssH = canvas.clientHeight;
  fitBackingStore(ctx, canvas, viewW, cssH);
  ctx.clearRect(0, 0, viewW, cssH);
  roadView.pan = Math.max(0, Math.min(roadView.pan, cssW - viewW));
  // Not restored: fitBackingStore resets the transform at the start of the next frame, and what the loop draws
  // over the road after this (the speed bubble, the drop ghost) is drawn in the same shifted space.
  ctx.translate(-roadView.pan, 0);
  if (cssW <= 0 || cssH <= 0) return; // see render()'s identical guard for why

  const L = simNB.cfg.length; // both directions share the same segment length (SharedRoadInputs)
  // The scheme as the road has it this frame (none while the lane counts have just stopped matching it).
  zipper = heldZipper(zipper, simNB.cfg.laneCount, simSB.cfg.laneCount);
  // Sized from the lanes as BUILT: a reallocation lends lanes across the median, it does not move tarmac.
  const built = builtLanes(zipper, simNB.cfg.laneCount, simSB.cfg.laneCount);
  const { gutterNB, gutterSB, gutterPxNB, gutterPxSB, laneH, nbRoadTop, medianTop, sbRoadTop, mToPx } = dualRoadLayout({
    cssW,
    cssH,
    lanesNB: built.NB,
    lanesSB: built.SB,
    segLenM: L,
    exitCount: exits.length,
    maxLaneH,
    facDepthNB: facilityDepth(facViewNB?.list),
    facDepthSB: facilityDepth(facViewSB?.list),
    facBarrierNB: hasBarrier(facViewNB?.list),
    facBarrierSB: hasBarrier(facViewSB?.list),
  });
  const geo = dualLanes({ laneH, sbRoadTop, medianTop, nbRoadTop }, { NB: simNB.cfg.laneCount, SB: simSB.cfg.laneCount }, zipper);
  // The verge, under everything: trees beyond each carriageway's shoulder.
  const sh = shoulderPx(laneH);
  drawVerge(ctx, cssW, cssH, dayFraction, marks.fromKm, marks.toKm, [
    { top: 0, bottom: sbRoadTop - sh },
    { top: nbRoadTop + built.NB * laneH + sh, bottom: cssH },
  ]);

  const xPxNB = (x: number) => x * mToPx; // NB: left to right, unmirrored
  const xPxSB = (x: number) => cssW - x * mToPx; // SB: right to left, mirrored
  const wPx = (m: number) => m * mToPx;
  const crossM = crossoverM(L);
  // Where the lent lanes' traffic is drawn at the very ends: the middle of the median opening.
  const gapY = medianTop + MEDIAN_GUTTER_PX / 2;
  const lentOf = (d: Direction) => {
    const g = geo[d];
    return g.lent === 0 ? null : { lanes: g.lent, crossM, lengthM: L, away: g.away, shiftPx: gapY - (g.laneTop(0) + laneH / 2) };
  };

  if (zipper === null) {
    drawMedian(ctx, cssW, medianTop, MEDIAN_GUTTER_PX, dayFraction);
  } else {
    // The other carriageway's inner lanes, lent; the median open at a crossover at each end of the stretch.
    const strip = geo[zipper.toward].strip;
    if (strip !== null) drawLentRoad(ctx, { cssW, medianTop, medianH: MEDIAN_GUTTER_PX, crossPx: wPx(crossM), strip, laneH, lanes: zipper.lanes, away: geo[zipper.toward].away, asphalt: asphaltColor, dayFraction });
    const giver = zipper.toward === "NB" ? "SB" : "NB";
    ctx.font = "800 9px system-ui";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const label = `${REALLOCATION_NAME.toUpperCase()} · ${zipper.toward} +${zipper.lanes} lane${zipper.lanes === 1 ? "" : "s"}, ${zipper.toward === "NB" ? "SB" : "NB"} −${zipper.lanes} · ${fmtKmRange(marks.fromKm, marks.toKm, 2)} · ${zipper.toward} CROSSES INTO ${giver} LANE${zipper.lanes === 1 ? " 1" : "S 1–2"} AT EACH END`;
    // On a dark chip: in the light theme the median is the page's own white, and yellow on it cannot be read.
    const lx = Math.min(wPx(crossM) + 8, cssW / 3);
    ctx.fillStyle = "rgba(8,13,25,0.82)";
    roundRect(ctx, lx - 4, medianTop + 0.5, ctx.measureText(label).width + 8, 12, 3);
    ctx.fill();
    ctx.fillStyle = "rgba(253,224,71,0.95)";
    ctx.fillText(label, lx, medianTop + 2);
  }
  drawSharedKmAxis(ctx, { xPx: xPxNB, fromKm: marks.fromKm, toKm: marks.toKm, cssW, axisY: medianTop + MEDIAN_GUTTER_PX / 2, backdrop: zipper !== null });

  const drawNB = () => drawCarriageway(ctx, simNB, {
    cssW,
    cssH,
    roadTop: geo.NB.roadTop,
    laneH,
    roadH: geo.NB.roadH,
    rampGutter: gutterNB,
    rampsAbove: false,
    reverseLanes: false, // NB sits below the median: its top edge is already the median-adjacent one
    mToPx,
    sb: false,
    xPx: xPxNB,
    wPx,
    fromKm: marks.fromKm,
    toKm: marks.toKm,
    overlay: overlayNB,
    drawAxis: false,
    flowLabel: "▶ traffic flow",
    location: "Northbound",
    animT,
    alphaS,
    borrowed: borrowedLanes(zipper, "NB"),
    borrowedLabel: zipper === null ? "" : "REALLOCATED",
    laneTop: geo.NB.laneTop,
    lent: lentOf("NB"),
    dayFraction,
    asphaltColor,
    facView: facViewNB,
    highlightFacility,
    gutterPx: gutterPxNB,
  });
  const drawSB = () => drawCarriageway(ctx, simSB, {
    cssW,
    cssH,
    roadTop: geo.SB.roadTop,
    laneH,
    roadH: geo.SB.roadH,
    rampGutter: gutterSB,
    rampsAbove: true,
    reverseLanes: true, // SB sits above the median: its bottom edge is the median-adjacent one
    mToPx,
    sb: true,
    xPx: xPxSB,
    wPx,
    fromKm: marks.fromKm,
    toKm: marks.toKm,
    overlay: overlaySB,
    drawAxis: false,
    flowLabel: "traffic flow ◀",
    location: "Southbound",
    animT,
    alphaS,
    borrowed: borrowedLanes(zipper, "SB"),
    borrowedLabel: zipper === null ? "" : "REALLOCATED",
    laneTop: geo.SB.laneTop,
    lent: lentOf("SB"),
    dayFraction,
    asphaltColor,
    facView: facViewSB,
    highlightFacility,
    gutterPx: gutterPxSB,
  });
  // The carriageway that gave lanes first: the one that took them draws its cones and traffic over that road.
  if (zipper !== null && zipper.toward === "NB") {
    drawSB();
    drawNB();
  } else {
    drawNB();
    drawSB();
  }
  // Night: the lamp heads themselves, small bright points along the median, each with a halo.
  const night = nightness(dayFraction);
  const lights = night > 0.02 ? getLightSprites() : null;
  if (lights) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const y = medianTop + MEDIAN_GUTTER_PX / 2;
    for (const x of lampXs(marks.fromKm, marks.toKm, mToPx, cssW)) {
      if (x < 66) continue; // clear of the KM POST label at the median's left end
      ctx.globalAlpha = 0.55 * night;
      ctx.drawImage(lights.pool, x - 14, y - 14, 28, 28);
      ctx.globalAlpha = night;
      ctx.fillStyle = "rgba(255,236,200,0.95)";
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/**
 * Under a lane reallocation: the lanes lent, as the other carriageway's road surface against the median, and the
 * median itself, open at a crossover at each end of the stretch (`crossPx` long) where the traffic using those
 * lanes crosses over and back. Drawn before either carriageway; the giver's own block then covers the overlap
 * at its rounded corners, and the taker draws its cones and traffic on top.
 */
function drawLentRoad(
  ctx: CanvasRenderingContext2D,
  g: {
    cssW: number; medianTop: number; medianH: number; crossPx: number;
    strip: { readonly top: number; readonly h: number }; laneH: number; lanes: number; away: 1 | -1;
    asphalt: string; dayFraction: number;
  },
) {
  const { cssW, medianTop, medianH, crossPx, strip, laneH, lanes, away, asphalt, dayFraction } = g;
  // The lent lanes' surface, running on under the giver's block (12 px) so no seam shows at its corners.
  const top = away === 1 ? strip.top : strip.top - 12;
  const h = strip.h + 12;
  ctx.fillStyle = asphalt;
  ctx.fillRect(0, top, cssW, h);
  const grain = getAsphaltGrain(ctx);
  if (grain) {
    ctx.fillStyle = grain;
    ctx.fillRect(0, top, cssW, h);
  }
  fillMedian(ctx, cssW, medianTop, medianH, dayFraction);
  // The median openings: tarmac across it where the crossovers are.
  const gap = Math.max(0, Math.min(crossPx, cssW / 2));
  for (const fill of grain ? [asphalt, grain] : [asphalt]) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, medianTop - 1, gap, medianH + 2);
    ctx.fillRect(cssW - gap, medianTop - 1, gap, medianH + 2);
  }
  // The median barrier between them, its ends capped with the black-and-yellow of a crash cushion.
  const barrierH = 6;
  const barrierY = medianTop + (medianH - barrierH) / 2;
  if (cssW - 2 * gap > 24) {
    drawBarrierRun(ctx, gap, cssW - gap, barrierY + barrierH / 2, dayFraction);
    for (const x of [gap, cssW - gap - 12]) {
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = i % 2 === 0 ? "#facc15" : "#111827";
        ctx.fillRect(x + i * 4, barrierY - 1, 4, barrierH + 2);
      }
    }
  }
  // The lent lanes' own markings: the solid edge against the median (broken at the openings), dashed between two.
  ctx.strokeStyle = `rgba(255,255,255,${(0.35 + 0.25 * dayFraction).toFixed(2)})`;
  ctx.lineWidth = 2;
  const innerY = away === 1 ? strip.top : strip.top + strip.h;
  ctx.beginPath();
  ctx.moveTo(gap, innerY);
  ctx.lineTo(cssW - gap, innerY);
  ctx.stroke();
  if (lanes > 1) {
    ctx.lineWidth = 1.5;
    ctx.setLineDash([14, 14]);
    for (let l = 1; l < lanes; l++) {
      ctx.beginPath();
      ctx.moveTo(0, strip.top + l * laneH);
      ctx.lineTo(cssW, strip.top + l * laneH);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

/** Where a dragged scenario chip would land: the pointer on the road, and a line saying where that is. */
type DropGhost = { x: number; y: number; text: { ok: boolean; line: string } };

/** The landing marker under a dragged scenario chip: a ring at the pointer and the place it names, red where it
 *  cannot go. Drawn by the frame loop over everything else, so it follows the pointer while paused too. */
function drawDropGhost(ctx: CanvasRenderingContext2D, cssW: number, g: DropGhost) {
  const col = g.text.ok ? "#38bdf8" : "#f87171";
  ctx.save();
  ctx.strokeStyle = col;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(g.x, g.y, 13, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(g.x, g.y, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = "700 12px Inter, system-ui, sans-serif";
  const w = ctx.measureText(g.text.line).width + 18;
  const h = 24;
  const lx = Math.min(Math.max(4, g.x - w / 2), cssW - w - 4);
  const ly = g.y - 20 - h >= 4 ? g.y - 20 - h : g.y + 20;
  ctx.fillStyle = "rgba(8,13,25,0.9)";
  roundRect(ctx, lx, ly, w, h, 6);
  ctx.fill();
  ctx.strokeStyle = col;
  ctx.lineWidth = 1;
  roundRect(ctx, lx, ly, w, h, 6);
  ctx.stroke();
  ctx.fillStyle = "#f1f5f9";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(g.text.line, lx + 9, ly + h / 2 + 0.5);
  ctx.restore();
}

/** The barrier between the two carriageways in Both mode — a solid stripe, not just empty space,
 *  so it reads as a physical median rather than a gap the layout happened to leave. */
function drawMedian(ctx: CanvasRenderingContext2D, cssW: number, medianTop: number, gutterH: number, dayFraction = 1) {
  fillMedian(ctx, cssW, medianTop, gutterH, dayFraction);
  drawBarrierRun(ctx, 0, cssW, medianTop + gutterH / 2, dayFraction);
}

/**
 * Both mode's ONE km axis, drawn once in the median rather than once per
 * carriageway. This is exact, not an approximation that happens to look
 * right: NB's xPx(x) = x*mToPx and SB's xPx(x) = cssW - x*mToPx place the
 * SAME km at the SAME pixel whenever each is fed its own direction-correct
 * distance-along-travel — fromKm always lands at x=0 and toKm at x=cssW for
 * both (that is what "the km axis is fixed, low km always on-screen-left"
 * already means for single-direction SB). One axis, using either
 * carriageway's mapping, is therefore correct for both, not a compromise.
 */
function drawSharedKmAxis(
  ctx: CanvasRenderingContext2D,
  g: { xPx: (m: number) => number; fromKm: number; toKm: number; cssW: number; axisY: number; /** a dark chip behind each number, for the movable barrier's stripes */ backdrop: boolean },
) {
  const { xPx, fromKm, toKm, cssW, axisY, backdrop } = g;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  /* The chip is now unconditional. It used to appear only over the movable
     barrier's stripes; everywhere else the numbers sat at 70% white on whatever
     the median happened to be, which on a full-screen road is the scale an
     operator reads a queue's position from. */
  ctx.font = "700 12px system-ui";
  for (const { km, text } of kmAxisTicks(fromKm, toKm, roadView.zoom)) {
    const x = xPx((km - fromKm) * 1000);
    if (x < 2 || x > cssW - 2) continue;
    const tw = ctx.measureText(text).width;
    // A green NLEX km post on the barrier: white numerals, a white rim, a little shadow.
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    roundRect(ctx, x - tw / 2 - 5, axisY - 7.5, tw + 12, 17, 3);
    ctx.fill();
    ctx.fillStyle = backdrop ? "#0a5c32" : "#0b6b3a";
    roundRect(ctx, x - tw / 2 - 6, axisY - 8.5, tw + 12, 17, 3);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1;
    roundRect(ctx, x - tw / 2 - 4.5, axisY - 7, tw + 9, 14, 2);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x, axisY + 0.5);
  }
  ctx.font = "700 10px system-ui";
  ctx.textAlign = "left";
  const label = "KM POST";
  const lw = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(8,13,25,0.7)";
  roundRect(ctx, roadView.pan + 3, axisY - 7.5, lw + 8, 15, 3);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillText(label, roadView.pan + 7, axisY + 0.5);
  ctx.restore();
}

// Top-down vehicle sprite. Local frame: front (nose) at x=0, body extends to
// -len (behind). Class 1 = car, 2 = bus, 3 = articulated semi.
function drawVehicle(
  ctx: CanvasRenderingContext2D,
  xFront: number,
  yCenter: number,
  len: number,
  wid: number,
  vClass: 1 | 2 | 3,
  paint: Paint,
  /* Lit brake lights.
   *
   * This was `v.v < 3` — brake lights that only came on once a vehicle had
   * already nearly stopped, which is not what a brake light is for. The
   * simulation gives every driver a reaction lag precisely so that
   * stop-and-go waves form, and those waves are made of people braking at
   * speed. Lighting on deceleration instead makes them visible: a pulse of
   * red travelling backwards through otherwise free-flowing traffic, which is
   * the single clearest sign the model is doing something real. On pale
   * bodies the lit lamp also gets a glow so the pulse still reads. */
  braking: boolean,
  /** Southbound: the sprite is drawn mirrored so the nose leads. */
  faceLeft = false,
  /** A truck's trailer is painted apart from its cab. */
  trailer: Paint = PAINT_WHITE,
  /** Drawn as a motorcycle with its rider (Class 1 only; the engine still sees a car of `len` x `wid`). */
  motorcycle = false
) {
  const glass = "rgba(20,28,44,0.95)";
  const glint = "rgba(190,208,232,0.55)";
  const outline = "rgba(9,14,28,0.8)";
  const headlight = "#fff6bf";
  // Below this size a sprite is a speck: the body and the lights only.
  const detail = len >= 12 && wid >= 6;
  ctx.save();
  ctx.translate(xFront, yCenter);
  // Every part below is drawn behind the nose at negative x, so one flip turns
  // the whole vehicle around without touching any of that geometry.
  if (faceLeft) ctx.scale(-1, 1);

  // A body panel shaded across its width, with a thin dark outline so pale paint still separates from the road.
  const panel = (x: number, w: number, tone: Paint, radius: number) => {
    const g = ctx.createLinearGradient(0, -wid / 2, 0, wid / 2);
    g.addColorStop(0, tone.hi);
    g.addColorStop(1, tone.lo);
    ctx.fillStyle = g;
    roundRect(ctx, x, -wid / 2, w, wid, radius);
    ctx.fill();
    ctx.strokeStyle = tone.edge ?? outline;
    ctx.lineWidth = 0.9;
    ctx.stroke();
  };
  // Glass is dark on light paint and paler on dark paint, so a black car still shows its windows.
  const glassOf = (tone: Paint): string => tone.glass ?? glass;

  if (motorcycle) {
    // A motorcycle with its rider, inside the car-sized slot the engine simulates (see motorcycleArt.ts).
    drawMotorcycle(ctx, len, wid, paint, braking);
    ctx.restore();
    return;
  }

  // soft shadow
  ctx.fillStyle = "rgba(0,0,0,0.32)";
  roundRect(ctx, -len + 0.5, -wid / 2 + 2.2, len, wid, Math.min(6, wid / 2));
  ctx.fill();

  if (vClass === 3) {
    // ---- articulated semi: ribbed trailer (back) + cab (front), joined by a hitch ----
    const cabLen = len * 0.3;
    const trailerLen = len * 0.62;
    panel(-len, trailerLen, trailer, Math.min(2.5, wid * 0.3));
    if (detail) {
      ctx.strokeStyle = "rgba(15,23,42,0.22)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      const ribs = Math.min(12, Math.floor(trailerLen / 3.5));
      for (let i = 1; i < ribs; i++) {
        const rx = -len + (trailerLen * i) / ribs;
        ctx.moveTo(rx, -wid / 2 + 1);
        ctx.lineTo(rx, wid / 2 - 1);
      }
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(15,23,42,0.8)";
    ctx.fillRect(-len * 0.38, -wid * 0.14, len * 0.08, wid * 0.28);
    panel(-cabLen, cabLen, paint, Math.min(3.5, wid * 0.4));
    if (detail) {
      ctx.fillStyle = glassOf(paint);
      roundRect(ctx, -cabLen * 0.52, -wid / 2 + wid * 0.14, cabLen * 0.36, wid * 0.72, 1.2);
      ctx.fill();
    }
  } else if (vClass === 2) {
    // ---- bus: a long pale body with a run of dark side windows and a windshield ----
    panel(-len, len, paint, Math.min(3, wid * 0.32));
    if (detail) {
      ctx.fillStyle = glassOf(paint);
      roundRect(ctx, -len * 0.15, -wid / 2 + wid * 0.14, len * 0.08, wid * 0.72, 1);
      ctx.fill();
      const n = Math.max(3, Math.min(9, Math.floor(len / 4.5)));
      const step = (len * 0.68) / n;
      const slotW = step * 0.6;
      for (let i = 0; i < n; i++) {
        roundRect(ctx, -len * 0.24 - (i + 1) * step + (step - slotW) / 2, -wid / 2 + wid * 0.2, slotW, wid * 0.6, 1);
        ctx.fill();
      }
    }
  } else {
    // ---- car: shaded body, a lighter roof, a dark windshield and rear window ----
    panel(-len, len, paint, Math.min(wid * 0.48, len * 0.3));
    if (detail) {
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      roundRect(ctx, -len * 0.7, -wid / 2 + wid * 0.18, len * 0.36, wid * 0.64, wid * 0.2);
      ctx.fill();
      ctx.fillStyle = glassOf(paint);
      roundRect(ctx, -len * 0.34, -wid / 2 + wid * 0.14, len * 0.15, wid * 0.72, wid * 0.16);
      ctx.fill();
      roundRect(ctx, -len * 0.86, -wid / 2 + wid * 0.2, len * 0.12, wid * 0.6, wid * 0.14);
      ctx.fill();
      ctx.fillStyle = glint;
      ctx.fillRect(-len * 0.33, -wid / 2 + wid * 0.2, 0.9, wid * 0.22);
    }
  }

  // headlights
  const lampR = Math.max(0.9, wid * 0.11);
  ctx.fillStyle = headlight;
  dot(ctx, -1.2, -wid / 2 + wid * 0.2, lampR);
  dot(ctx, -1.2, wid / 2 - wid * 0.2, lampR);
  drawRearLights(ctx, len, wid, vClass, braking, detail);

  ctx.restore();
}

/** Brake-light colours: the lens unlit, lit, and the hot middle of a lit lamp. */
const TAIL_UNLIT = "#6e1515";
const TAIL_UNLIT_EDGE = "rgba(255,120,110,0.35)";
const TAIL_LIT = "#ff3b30";
const TAIL_CORE = "rgba(255,226,214,0.95)";

/**
 * Rear lights, seen from above, in the sprite's own frame (nose at 0, rear at -len).
 *
 * A lamp at each rear corner that wraps a little way down the side, as a real tail-light cluster does; on a car
 * a third, high-mounted brake light at the top of the rear window, and on a bus one across the middle of the
 * rear. Unlit they are a dark lens. Braking they light bright red with a hot core and a soft glow, so a wave of
 * braking reads as a pulse of red running back through the traffic in daylight too (the night pass adds its own
 * bigger glow, drawn after every vehicle). The glow is held to 2 px behind the vehicle: a halo reaching the car
 * behind would read as the two touching.
 */
function drawRearLights(ctx: CanvasRenderingContext2D, len: number, wid: number, vClass: 1 | 2 | 3, braking: boolean, detail: boolean) {
  const rear = -len;
  // Along the road (thin: a lamp is a few centimetres deep), across from each corner, and down the side.
  // A lit lamp is drawn a little larger than an unlit one: at the docked canvas a car is ~16 px long, and a lamp
  // at its true size changes colour without anyone noticing.
  const grow = braking ? 1.35 : 1;
  const depth = Math.max(1.4, Math.min(3.2, len * (vClass === 1 ? 0.06 : 0.03))) * grow;
  const span = Math.min(wid * 0.45, Math.max(2, wid * (vClass === 1 ? 0.32 : vClass === 2 ? 0.28 : 0.24)) * grow);
  const wrap = detail ? Math.max(1, len * (vClass === 1 ? 0.08 : 0.035)) : 0;
  const rim = Math.max(0.8, wid * 0.08);
  const inset = Math.min(1, wid * 0.06);

  if (braking) {
    // The glow first, under the lamps, clipped so it never reaches more than 2 px behind the bumper.
    const sprite = getLightSprites();
    if (sprite) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rear - 2, -wid / 2 - 2, len * 0.35 + 2, wid + 4);
      ctx.clip();
      ctx.globalAlpha = 0.9;
      const r = Math.max(4, span * 1.7);
      for (const sgn of [-1, 1]) {
        const cy = sgn * (wid / 2 - inset - span / 2);
        ctx.drawImage(sprite.tail, rear + depth * 0.5 - r, cy - r, r * 2, r * 2);
      }
      ctx.restore();
    }
  }

  for (const sgn of [-1, 1]) {
    // One corner: the strip across the rear, and its wrap down the side, as one L-shaped lens.
    const yEdge = sgn * (wid / 2 - inset);
    const yIn = yEdge - sgn * span;
    ctx.beginPath();
    ctx.moveTo(rear + 0.3, yEdge);
    ctx.lineTo(rear + 0.3 + depth + wrap, yEdge);
    ctx.lineTo(rear + 0.3 + depth + wrap, yEdge - sgn * rim);
    ctx.lineTo(rear + 0.3 + depth, yEdge - sgn * rim);
    ctx.lineTo(rear + 0.3 + depth, yIn);
    ctx.lineTo(rear + 0.3, yIn);
    ctx.closePath();
    ctx.fillStyle = braking ? TAIL_LIT : TAIL_UNLIT;
    ctx.fill();
    if (braking) {
      // The bulb's hot middle.
      ctx.fillStyle = TAIL_CORE;
      ctx.fillRect(rear + 0.3 + depth * 0.25, Math.min(yEdge, yIn) + span * 0.3, Math.max(0.6, depth * 0.45), span * 0.4);
    } else if (detail) {
      // A highlight along the unlit lens, so it reads as glass and not a smudge.
      ctx.strokeStyle = TAIL_UNLIT_EDGE;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(rear + 0.3 + depth, yIn);
      ctx.lineTo(rear + 0.3 + depth, yEdge - sgn * rim);
      ctx.stroke();
    }
  }

  // The third, high-mounted brake light: only lit, it is part of the glass or the body when off.
  if (braking && detail && vClass !== 3) {
    ctx.fillStyle = TAIL_LIT;
    const w = Math.max(0.8, len * (vClass === 1 ? 0.022 : 0.012));
    const h = wid * (vClass === 1 ? 0.3 : 0.36);
    // A car's sits at the top of the rear window; a bus's across the rear, above the engine grille.
    const x = vClass === 1 ? -len * 0.85 : rear + depth + 0.6;
    roundRect(ctx, x, -h / 2, w, h, w / 2);
    ctx.fill();
    ctx.fillStyle = TAIL_CORE;
    ctx.fillRect(x + w * 0.3, -h * 0.3, Math.max(0.4, w * 0.4), h * 0.6);
  }
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  // arcTo throws IndexSizeError on a negative radius, and several callers
  // derive one from a sprite dimension — `wid - 5` on a small vehicle, or
  // anything at all during the frame where the canvas still has no height.
  // One throw inside the animation loop paints the road and skips every
  // vehicle after it, which reads on screen as an empty simulation rather than
  // as a crash. Clamping here covers all seven call sites at once.
  const ww = Math.max(0, w);
  const hh = Math.max(0, h);
  const rr = Math.max(0, Math.min(r, ww / 2, hh / 2));
  w = ww;
  h = hh;
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
