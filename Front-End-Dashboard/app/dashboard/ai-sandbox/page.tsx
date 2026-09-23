"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayExitName, useNlexExits, type NlexExit } from "../../../lib/nlex-exits";
import { lanesForSegment, laneSources } from "../../../lib/nlex-lanes";
import { Car } from "lucide-react";
import PageHeader from "../../../components/dashboard/PageHeader";
import ScenarioForecastPanel from "../../../components/dashboard/ScenarioForecastPanel";
import {
  TrafficSim, CLASS_META, mixHex, visualLane, replicate,
  type Metrics, type ReplicationResult, type RepStat,
} from "./simulation";
import {
  applyAtBoundary,
  canvasMarks,
  describeOwner,
  nextBoundaryAfter,
  roadOf,
  type CanvasMark,
  type Direction,
  type Incident,
  type RoadFrame,
  type ScenarioEvent,
} from "./scenarios/adapter";
import ScenarioPanel from "./components/ScenarioPanel";
import { useDirectionSim, type DirectionApi, type SharedRoadInputs } from "./useDirectionSim";

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

/** Below this many pixels a Class 1 car stops reading as a vehicle. */
const MIN_CAR_PX = 3;
/** Length of a Class 1 car, for the legibility estimate. */
const CAR_M = 4.5;

const RAMP_GUTTER_PX = 46; // room above/below the road for ramps and their tags
const AXIS_H = 22; // the km scale, printed beside the carriageway

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
  /** Northbound draws its ramps above the road, southbound below. */
  rampsAbove: boolean;
}) {
  const { cssW, cssH, lanes, segLenM, exitCount, maxLaneH, rampsAbove } = opts;
  const rampGutter = exitCount > 0 ? RAMP_GUTTER_PX : 0;
  const mToPx = segLenM > 0 ? cssW / segLenM : 1;
  /* Lanes fill whatever is left once the ramp gutter and the km scale have
   * taken theirs. Subtracting AXIS_H here is the part worth noticing: the
   * scale used to be printed inside the bottom lane, over the traffic. */
  const laneH = Math.max(
    6,
    Math.min((cssH - CANVAS_PAD * 2 - rampGutter - AXIS_H) / lanes, maxLaneH),
  );
  const roadH = laneH * lanes;
  // Ramp gutter on the ramp side, km scale on the other; the road centres in
  // whatever is left over and encroaches on neither.
  const spaceAbove = CANVAS_PAD + (rampsAbove ? rampGutter : AXIS_H);
  const spaceBelow = CANVAS_PAD + (rampsAbove ? AXIS_H : rampGutter);
  const roadTop =
    spaceAbove + Math.max(0, (cssH - spaceAbove - spaceBelow - roadH) / 2);
  return { rampGutter, laneH, roadH, roadTop, mToPx };
}

/**
 * Both mode's geometry: two carriageways stacked in ONE canvas with a shared
 * median between them — NB on top, SB below, each keeping its own outer ramp
 * gutter (NB's above, SB's below, exactly roadLayout's existing convention),
 * with the km axis shared in the median rather than duplicated per side.
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
}) {
  const { cssW, cssH, lanesNB, lanesSB, segLenM, exitCount, maxLaneH } = opts;
  // EXITS is one corridor-wide list shared by both directions (SharedRoadInputs),
  // so whether the gutter is needed at all is the same question for NB and SB —
  // there is no case where one carriageway has ramps in view and the other does
  // not, for the same km window.
  const rampGutter = exitCount > 0 ? RAMP_GUTTER_PX : 0;
  const mToPx = segLenM > 0 ? cssW / segLenM : 1;
  const totalLanes = Math.max(1, lanesNB + lanesSB);
  const laneH = Math.max(
    6,
    Math.min(
      (cssH - CANVAS_PAD * 2 - rampGutter * 2 - MEDIAN_GUTTER_PX) / totalLanes,
      maxLaneH,
    ),
  );
  const nbRoadH = laneH * lanesNB;
  const sbRoadH = laneH * lanesSB;
  const nbRoadTop = CANVAS_PAD + rampGutter;
  const medianTop = nbRoadTop + nbRoadH;
  const sbRoadTop = medianTop + MEDIAN_GUTTER_PX;
  return { rampGutter, laneH, nbRoadH, sbRoadH, nbRoadTop, medianTop, sbRoadTop, mToPx };
}

/**
 * Where an engine lane index draws vertically, within a carriageway block
 * that starts at `roadTop`. Plain (non-reversed) matches every single-
 * direction carriageway there has ever been: index 0 (operator lane 1, the
 * innermost lane per LANE1_IS_INNERMOST) at the top of the block.
 *
 * `reverseLanes` is Both mode's NB carriageway ONLY. NB is drawn above the
 * median, so the block's BOTTOM edge is the one actually next to the median
 * — reversing which end lane 0 draws at is what keeps "lane 1, innermost"
 * true on the drawn road instead of just true in the data. SB sits below the
 * median, so its top edge is already the median-adjacent one; SB never
 * reverses, and single-direction NB/SB never reverses either (roadLayout()
 * callers all pass false, unchanged from before D3).
 */
function laneSlotTop(engineLane: number, roadTop: number, laneH: number, lanes: number, reverseLanes: boolean): number {
  const slot = reverseLanes ? lanes - 1 - engineLane : engineLane;
  return roadTop + slot * laneH;
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

const SPEED_STEPS = [0.5, 1, 2, 4] as const;

/* takenWith records what was on the road at capture time. A baseline is not
 * necessarily a clear road — comparing "one lane closed" against "two lanes
 * closed" is a perfectly good question — so the snapshot has to carry its own
 * conditions, or the comparison below it would imply a clean before-state it
 * never had. */
type Baseline = { avgSpeedKmh: number; throughputPerMin: number; longestQueueM: number; co2RatePerMin: number; avgTravelTimeS: number; takenWith: string };

/**
 * A proposed set of simulation changes from the command parser. Mirrors the
 * response of POST /api/ai-sandbox/command — keep in step with
 * Back-End/src/services/sandbox-command.service.ts.
 */
type CommandAction =
  | { type: "close_lane"; lanes: number[] }
  | { type: "open_lane"; lanes: number[] }
  | { type: "set_speed_limit"; kmh: number | null }
  | { type: "add_incident"; lane: number; positionPct: number }
  | { type: "clear_incidents" }
  | { type: "set_inflow"; vehPerHour: number }
  | { type: "set_lane_count"; lanes: number }
  | { type: "set_route"; originExitId: number; destinationExitId: number };

type CommandPlan = {
  actions: CommandAction[];
  reply: string;
  unsupported: string | null;
  warnings: string[];
};

/** One proposed action as a line an operator can check before applying. */
function describeAction(a: CommandAction, exits: { exit_id: number; exit_name: string }[]): string {
  switch (a.type) {
    case "close_lane":
      return `Close lane ${a.lanes.join(", ")}`;
    case "open_lane":
      return `Reopen lane ${a.lanes.join(", ")}`;
    case "set_speed_limit":
      return a.kmh == null ? "Remove the speed limit" : `Set a ${a.kmh} km/h speed limit`;
    case "add_incident":
      return `Place an incident in lane ${a.lane}, ${Math.round(a.positionPct)}% along the segment`;
    case "clear_incidents":
      return "Clear all incidents";
    case "set_inflow":
      return `Set inflow to ${fmt(a.vehPerHour)} veh/h`;
    case "set_lane_count":
      return `Rebuild the road with ${a.lanes} lanes`;
    case "set_route": {
      const name = (id: number) => {
        const hit = exits.find((x) => x.exit_id === id);
        return hit ? displayExitName(hit.exit_name) : `exit ${id}`;
      };
      return `Set the route ${name(a.originExitId)} → ${name(a.destinationExitId)}`;
    }
  }
}

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export default function AiSandboxPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const metricAccRef = useRef<number>(0);
  const simAccRef = useRef<number>(0);

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

  // Actual drawn width, so the legibility hint reflects this screen rather than
  // an assumption made when the canvas was a third of the page.
  const [canvasW, setCanvasW] = useState(1000);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      if (w > 0) setCanvasW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  const originExit = EXITS[Math.min(origin, EXITS.length - 1)];
  const destExit = EXITS[Math.min(destination, EXITS.length - 1)];

  // How wide the selected stretch of road actually is. Null when the corridor
  // lane table does not cover it — see lib/nlex-lanes.ts, which is deliberately
  // unpopulated until someone can cite a source for the real configuration.
  // Direction-independent (a property of the road, not of which way you drive
  // it) — computed once here and handed to both directions' useDirectionSim,
  // each of which defaults ITS OWN laneCount from it (see D2.4).
  const segmentLanes = originExit && destExit ? lanesForSegment(originExit.km, destExit.km) : null;
  const laneProvenance = originExit && destExit ? laneSources(originExit.km, destExit.km) : [];

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

  /** NB only, SB only, or both carriageways at once (median-separated — see Phase D3 for the canvas). */
  const [view, setView] = useState<Direction | "Both">("NB");
  const activeDirections: readonly Direction[] = view === "Both" ? ["NB", "SB"] : [view];
  /**
   * Which direction the still-single-direction-shaped panels (Interventions,
   * Scenario events, Baseline, Confidence run, metric tiles, the canvas, the
   * GLM command context) read and write, while in Both mode. NB-only/SB-only
   * needs no choice — the one active direction IS the focus, so those modes
   * are byte-for-byte the pre-D2 behaviour. Splitting every one of those
   * panels to show both directions at once in Both mode is Phase D4's job;
   * D2 proves the two engines run correctly and gives the operator something
   * sane to look at and control in the meantime, not the final Both-mode UI.
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
  const [spanAnchorKm, setSpanAnchorKm] = useState<number | null>(null);
  /* The chips are a reframing tool, reached for occasionally, but nineteen of
   * them wrap to four rows and were the tallest thing in the corridor section.
   * The count stays visible so nothing is lost by keeping them folded. */
  const [exitsOpen, setExitsOpen] = useState(false);
  const [segFromKm, setSegFromKm] = useState<number | null>(null);
  const [segToKm, setSegToKm] = useState<number | null>(null);

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
  const segLengthM = Math.round((toKm - fromKm) * 1000);
  const spanCapped = routeLenM > MAX_SEG_M && segLengthM >= MAX_SEG_M;

  /* Exits an operator can actually work with.
   *
   * The drawn window defaults to 600 m starting at the origin, so in practice
   * the origin exit sat clipped against the left edge and every other junction
   * was off-screen. An operator asking "what happens at Bocaue" had to work out
   * its km post and type two numbers to get it on screen.
   *
   * These give them the junction directly: the exits on the chosen route, which
   * of them are currently visible, and a one-click reframe. */
  const routeExits = EXITS.filter((x) => x.km >= routeFromKm && x.km <= routeToKm)
    .slice()
    .sort((a, b) => a.km - b.km);
  const visibleExitIds = new Set(
    routeExits.filter((x) => x.km >= fromKm && x.km <= toKm).map((x) => x.exit_id),
  );

  /** Frame the window on one exit, keeping it inside the route. */
  const focusExit = (km: number) => {
    const win = Math.min(routeLenM || DEFAULT_SEG_M, DEFAULT_SEG_M) / 1000;
    let a = km - win / 2;
    let b = km + win / 2;
    // Shift rather than shrink at the ends, so a junction at Km 0 is still
    // framed with road either side of it instead of being clipped again.
    if (a < routeFromKm) { a = routeFromKm; b = Math.min(routeToKm, a + win); }
    if (b > routeToKm) { b = routeToKm; a = Math.max(routeFromKm, b - win); }
    setSegFromKm(Number(a.toFixed(3)));
    setSegToKm(Number(b.toFixed(3)));
  };

  /** Frame the stretch between two junctions, with a little road either side.
   *
   *  This is the thing an operator actually wants when they say "the segment
   *  where the exit can be seen": not a junction centred in isolation, but the
   *  run between two of them. Exits here sit 1.6-4.5 km apart, so a 600 m
   *  window can only ever hold one — spanning is the only way to see two. */
  const spanExits = (kmA: number, kmB: number) => {
    const lo = Math.min(kmA, kmB);
    const hi = Math.max(kmA, kmB);
    const padKm = Math.min(0.15, Math.max(0.03, (hi - lo) * 0.06));
    const a = Math.max(routeFromKm, lo - padKm);
    const b = Math.min(routeToKm, hi + padKm);
    setSegFromKm(Number(a.toFixed(3)));
    setSegToKm(Number(b.toFixed(3)));
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
    // A km range from the previous route may not exist on the new one.
    setSegFromKm(null);
    setSegToKm(null);
  }, [origin, destination]);

  /** The exit nearest the middle of the span, so the canvas can name the place. */
  const nearestExit = (() => {
    if (!EXITS.length) return null;
    const mid = (fromKm + toKm) / 2;
    return EXITS.reduce((best, x) => (Math.abs(x.km - mid) < Math.abs(best.km - mid) ? x : best));
  })();

  // The canvas draws the FOCUSED direction only (Phase D3 draws both carriageways at once).
  const dirLabel = focusDirection === "NB" ? "Northbound" : "Southbound";

  const locationLabel = nearestExit
    ? `${dirLabel} · Km ${fromKm.toFixed(2)}–${toKm.toFixed(2)} · ${(segLengthM / 1000).toFixed(2)} km · near ${displayExitName(nearestExit.exit_name)}`
    : `${dirLabel} · Km ${fromKm.toFixed(2)}–${toKm.toFixed(2)}`;

  // The render loop runs outside React, so these reach it through refs.
  const locationRef = useRef(locationLabel);
  locationRef.current = locationLabel;
  const marksRef = useRef({ fromKm, toKm, direction: focusDirection });
  marksRef.current = { fromKm, toKm, direction: focusDirection };
  // Docked, a lane is capped so the road keeps its proportions inside a card.
  // Expanded there is no card to respect, and capping it only left the
  // carriageway floating in the middle of an empty screen.
  const maxLaneRef = useRef(LANE_PX);
  maxLaneRef.current = expanded ? 240 : DOCKED_LANE_MAX;
  // Exits that fall inside the drawn span, so the road can name the places the
  // operator is looking at rather than only its km-posts.
  const exitsRef = useRef<{ name: string; km: number }[]>([]);
  exitsRef.current = EXITS.filter((x) => x.km >= fromKm && x.km <= toKm).map((x) => ({
    name: displayExitName(x.exit_name),
    km: x.km,
  }));

  // Which forecast day the inflow came from, when it came from one. Kept apart
  // from dataAnchor so the slider caption can never call a prediction an
  // observation. Shared: the forecast is one corridor prediction, not one per
  // carriageway, and "Load into simulation" applies it to whichever direction
  // is focused (Both mode) or the only one there is (NB-only/SB-only).
  const [forecastDay, setForecastDay] = useState<string | null>(null);
  // Exit the incident model rates highest for the chosen day, when the sandbox
  // has been positioned there.
  const [hotspot, setHotspot] = useState<string | null>(null);
  // Whether the selected forecast day has an incident forecast. Days past the
  // incident model's horizon still carry traffic and CO2 forecasts, so they are
  // offered, but the hint must not credit the incident model for choosing the place.
  const [incidentCovered, setIncidentCovered] = useState(true);
  const [simSpeed, setSimSpeed] = useState<(typeof SPEED_STEPS)[number]>(1);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
  // Open at the busiest hour: the interesting question is what a closure costs when it costs the
  // most. Whichever direction's demand-profile fetch resolves first proposes it; once set, neither
  // direction's later fetch overwrites it (both call this, but only the first "cur == null" wins).
  const proposeHourOfDay = useCallback((hour: number) => {
    setHourOfDay((cur) => (cur == null ? hour : cur));
  }, []);
  const resetSimAccumulator = useCallback(() => {
    simAccRef.current = 0;
  }, []);

  const sharedRoadInputs: SharedRoadInputs = {
    BACKEND, fromKm, toKm, segLengthM, EXITS, nearestExit, segmentLanes, hourOfDay, proposeHourOfDay, classProfile, resetSimAccumulator,
  };
  // Called unconditionally, twice, regardless of `view` — an inactive direction's sim just is not
  // stepped or rendered below. Hooks cannot be called conditionally, and there is no need to: the
  // per-direction state is cheap to hold even when unused, and this is what keeps switching the
  // view instant (nothing to (re)build) rather than mount/unmount churn.
  const nb = useDirectionSim("NB", sharedRoadInputs);
  const sb = useDirectionSim("SB", sharedRoadInputs);
  const byDirection: Record<Direction, DirectionApi> = { NB: nb, SB: sb };
  /** The single-direction-shaped panels' data source while Both mode has not yet split them (Phase D4). NB-only/SB-only: this IS the (only) active direction. */
  const focused = byDirection[focusDirection];

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
   * Runs against the FOCUSED direction only — replicate() takes one static
   * Interventions snapshot and cannot follow a timed event OR two carriageways
   * at once (see Phase D4.6 for Both mode's disabled state; this phase keeps
   * it working exactly as before for NB-only/SB-only). */
  const [repRuns, setRepRuns] = useState(10);
  const [repResult, setRepResult] = useState<ReplicationResult | null>(null);
  const [repProgress, setRepProgress] = useState<number | null>(null);
  const repCancel = useRef(false);

  const runReplications = useCallback(() => {
    // replicate() runs static interventions and cannot follow a timed event.
    if (focused.scenarioEvents.length > 0) return;
    if (repProgress != null) { repCancel.current = true; return; }
    repCancel.current = false;
    setRepResult(null);
    setRepProgress(0);
    const gen = replicate(
      {
        length: segLengthM,
        laneCount: focused.laneCount,
        inflowVehPerHour: focused.inflow,
        classProfile: classProfile,
        ramps: focused.ramps,
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
  }, [repProgress, repRuns, segLengthM, classProfile, focused]);

  // What the canvas draws for each direction's scenario events: kept in a ref (the render loop runs
  // outside React) and refreshed whenever either direction's own events/binding change — mirrors the
  // single-sim page's old scenarioOverlayRef assignment, just done once per direction instead of once.
  useEffect(() => {
    scenarioOverlayRef.current.NB = { events: nb.scenarioEvents, frame: nb.scenarioFrame, isScenarioIncident: nb.scenarioBinding.isScenarioIncident };
  }, [nb.scenarioEvents, nb.scenarioFrame, nb.scenarioBinding]);
  useEffect(() => {
    scenarioOverlayRef.current.SB = { events: sb.scenarioEvents, frame: sb.scenarioFrame, isScenarioIncident: sb.scenarioBinding.isScenarioIncident };
  }, [sb.scenarioEvents, sb.scenarioFrame, sb.scenarioBinding]);

  // Animation + physics loop: steps every ACTIVE direction's sim in the same tick, in the same
  // ~25ms-equivalent-per-frame slice budget the single-sim loop always used (there is no separate
  // budget per direction — Both mode's two steps share the one frame, which is the whole point of
  // the Phase D1 performance estimate and the D2.5/D2.6 measurement below).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);
      const dtReal = Math.min(0.1, (now - (lastFrameRef.current || now)) / 1000);
      lastFrameRef.current = now;

      // The accumulator is shared across directions deliberately: both sims advance sim time at the
      // same simSpeed from the same real dtReal, so one accumulator drives both step loops in lockstep
      // rather than two independently-drifting ones.
      if (running) {
        simAccRef.current += dtReal * simSpeed;
        let guard = 0;
        while (simAccRef.current >= SIM_DT && guard < 3 / SIM_DT) {
          for (const direction of activeDirections) {
            const d = byDirection[direction];
            const sim = d.simRef.current;
            // A skip-in-progress on THIS direction owns its own stepping (stepToScenarioTime, inside
            // useDirectionSim's skipToNextPhase) — the rAF loop must not also step it, or the two
            // would race for the same sim. The other direction (if also active) is unaffected and
            // steps normally here, which is exactly what "skip is per direction" requires.
            if (!sim || d.skipRef.current !== null) continue;
            sim.step(SIM_DT);
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
          for (const direction of activeDirections) {
            const sim = byDirection[direction].simRef.current;
            if (sim) byDirection[direction].setMetrics(sim.metrics());
          }
        }
      }
      // Both mode draws both carriageways in one canvas (Phase D3); NB-only/SB-only draw the one
      // active direction full-height, exactly as before D3.
      if (view === "Both") {
        const simNB = nb.simRef.current;
        const simSB = sb.simRef.current;
        if (simNB && simSB) {
          renderBoth(
            ctx, canvas, simNB, simSB,
            { fromKm: marksRef.current.fromKm, toKm: marksRef.current.toKm },
            maxLaneRef.current, exitsRef.current,
            scenarioOverlayRef.current.NB ?? null, scenarioOverlayRef.current.SB ?? null,
          );
        }
      } else {
        const focusedSim = byDirection[focusDirection].simRef.current;
        if (focusedSim) {
          render(ctx, canvas, focusedSim, locationRef.current, marksRef.current, maxLaneRef.current, exitsRef.current, scenarioOverlayRef.current[focusDirection] ?? null);
        }
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, simSpeed, activeDirections.join(), view, focusDirection, nb.simRef, sb.simRef, nb.scenarioBinding, sb.scenarioBinding, nb.publishOwners, sb.publishOwners, nb.setMetrics, sb.setMetrics]);

  // Incident placement: arm "placing" mode, then let the user click the
  // simulation to choose exactly where (which lane / how far along) the
  // incident is dropped. One accident per click — re-arm to drop another.
  // Placement always targets the FOCUSED direction (splitting Interventions
  // so a click could act on the OTHER carriageway is Phase D4's job, same as
  // the rest of that rail). What D3 does fix: in Both mode the canvas draws
  // two carriageways with dualRoadLayout's geometry, not one with
  // roadLayout's — a click is now read back with whichever geometry actually
  // drew the pixels under the cursor, and a click that lands in the
  // non-focused carriageway's band is rejected rather than silently mapped
  // through the wrong formula.
  const togglePlacing = () => focused.setPlacingIncident((p) => !p);

  const placeIncidentAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!focused.placingIncident && !focused.placingClosure) return;
    const canvas = canvasRef.current;
    const sim = focused.simRef.current;
    if (!canvas || !sim) return;

    // Invert the same geometry the renderer uses to map the click back to
    // (lane, x-in-metres). Keep these formulas in sync with render()/renderBoth().
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const L = sim.cfg.length;
    const lanes = sim.cfg.laneCount;

    let laneH: number;
    let roadTop: number;
    if (view === "Both") {
      const otherSim = byDirection[focusDirection === "NB" ? "SB" : "NB"].simRef.current;
      if (!otherSim) return;
      const layout = dualRoadLayout({
        cssW,
        cssH,
        lanesNB: focusDirection === "NB" ? lanes : otherSim.cfg.laneCount,
        lanesSB: focusDirection === "SB" ? lanes : otherSim.cfg.laneCount,
        segLenM: L,
        exitCount: exitsRef.current.length,
        maxLaneH: maxLaneRef.current,
      });
      laneH = layout.laneH;
      roadTop = focusDirection === "NB" ? layout.nbRoadTop : layout.sbRoadTop;
      const roadH = laneH * lanes;
      if (cy < roadTop || cy > roadTop + roadH) return; // clicked the other carriageway's band, or the median
    } else {
      // Same geometry render() used for this frame, or a click maps to a
      // different lane than the one under the cursor. The ramp gutter is part of
      // that geometry: reserving it moves the road up, and a handler that did not
      // know would place incidents one lane low wherever a junction is in view.
      // roadTop comes from the shared helper too, so there is no copy of the
      // vertical placement left to drift out of step with the renderer.
      const single = roadLayout({
        cssW: rect.width,
        cssH,
        lanes,
        segLenM: L,
        exitCount: exitsRef.current.length,
        maxLaneH: maxLaneRef.current,
        rampsAbove: focusDirection === "NB",
      });
      laneH = single.laneH;
      roadTop = single.roadTop;
    }

    // The drawn slot (0 at roadTop, downward) is the engine lane index UNLESS this is Both mode's
    // NB carriageway, which draws lane 0 at the BOTTOM of its block (laneSlotTop's reverseLanes) —
    // same inversion the renderer applies, read backwards.
    const drawnSlot = Math.max(0, Math.min(lanes - 1, Math.floor((cy - roadTop) / laneH)));
    const reverseLanes = view === "Both" && focusDirection === "NB";
    const lane = reverseLanes ? lanes - 1 - drawnSlot : drawnSlot;
    const alongFrac = focusDirection === "SB" ? 1 - cx / cssW : cx / cssW;
    const x = Math.max(0, Math.min(L, alongFrac * L));
    if (focused.placingClosure) {
      // Two clicks mark the stretch an operator actually closes — "Km 0.20 to
      // 0.30" — in either order. One click used to move only the start, so the
      // works always ran on to the end of the span.
      const km = Number(focused.kmAt(x).toFixed(2));
      if (focused.closureDraftKm == null) {
        focused.setClosureDraftKm(km);
        sim.interventions.closureDraft = { from: x, to: x };
        return;
      }
      const a = Math.min(focused.closureDraftKm, km);
      const b = Math.max(Math.max(focused.closureDraftKm, km), Math.min(toKm, a + 0.01));
      focused.setClosureKm(a);
      focused.setClosureEndKm(b);
      focused.setPlacingClosure(false);
      return;
    }
    focused.placeIncident(lane, x);
    focused.setPlacingIncident(false); // one accident per click; re-arm to drop another
  };

  // Follow the cursor after the first click so the stretch is seen before it is set.
  const previewClosureAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const sim = focused.simRef.current;
    const canvas = canvasRef.current;
    if (!sim || !canvas || !focused.placingClosure || focused.closureDraftKm == null) return;
    const rect = canvas.getBoundingClientRect();
    const L = sim.cfg.length;
    const frac = (e.clientX - rect.left) / rect.width;
    const x = Math.max(0, Math.min(L, (focusDirection === "SB" ? 1 - frac : frac) * L));
    const startM = focused.mAt(focused.closureDraftKm);
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

  // Esc leaves either placing mode, on the focused direction (the one placement is ever armed on).
  useEffect(() => {
    if (!focused.placingIncident && !focused.placingClosure) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        focused.setPlacingIncident(false);
        focused.setPlacingClosure(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // focused is a fresh object every render (it's nb or sb, both fresh per the note above); same
    // reasoning — only the fields actually read are listed, each itself stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused.placingIncident, focused.placingClosure, focused.setPlacingIncident, focused.setPlacingClosure]);

  // Ask the backend to turn the sentence into simulation actions. This only
  // ever produces a PROPOSAL — applyPlan() below is what actually touches the
  // simulation, and it runs when the operator presses Apply.
  const runCommand = async () => {
    const text = command.trim();
    if (!text || commandBusy) return;

    setCommandBusy(true);
    setCommandError(null);
    setCommandNote(null);
    setPlan(null);

    try {
      const res = await fetch(`${BACKEND}/api/ai-sandbox/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: text,
          context: {
            laneCount: focused.laneCount,
            segmentLengthM: segLengthM,
            // The model reasons in 1-indexed lane numbers, the sim in 0-indexed
            // array positions. Convert on the way out and back again in
            // applyPlan() so the two never mix.
            // What is actually on the road (operator + running scenario), in the existing fields —
            // no new "direction" field (no backend change, per Phase D1 §4): this is always the
            // FOCUSED direction's effective state. NB-only/SB-only, that's unambiguous. In Both
            // mode it is whichever carriageway the operator has focused — see the focus switch in
            // the JSX below, which Phase D4 will make an explicit, required choice rather than a
            // silent default.
            closedLanes: focused.eff.closedLanes.map((c, i) => (c ? i + 1 : 0)).filter(Boolean),
            speedLimitKmh: focused.eff.speedLimitKmh,
            incidentCount: focused.effIncidentCount,
            exits: EXITS.map((x) => ({ exit_id: x.exit_id, exit_name: displayExitName(x.exit_name) })),
          },
        }),
      });
      const json = await res.json();

      if (!res.ok || !json.success) {
        setCommandError(json?.message ?? `Request failed (${res.status}).`);
        return;
      }
      setPlan(json.data as CommandPlan);
    } catch {
      setCommandError("Could not reach the backend. Is it running on port 4000?");
    } finally {
      setCommandBusy(false);
    }
  };

  // Apply a confirmed plan to the simulation. Every action was already range-
  // checked server-side; the bounds are re-asserted here because this function
  // is the last thing between model output and sim state. Applies to the
  // FOCUSED direction only, matching the context runCommand sent.
  const applyPlan = () => {
    const sim = focused.simRef.current;
    if (!plan || !sim) return;
    const applied: string[] = [];

    // Changing the lane count rebuilds the simulation, and rebuild() resets
    // closures, the speed limit and incidents. Applying a closure in the same
    // batch would therefore be silently undone a tick later, so a plan that
    // resizes the road applies only that and says the rest was dropped.
    const resize = plan.actions.find((a) => a.type === "set_lane_count");
    if (resize && resize.type === "set_lane_count") {
      focused.setLaneCount(resize.lanes);
      const dropped = plan.actions.length - 1;
      setCommandNote(
        `Applied: ${resize.lanes} lanes.` +
          (dropped > 0
            ? ` Rebuilding the road clears existing interventions, so ${dropped} other action${dropped > 1 ? "s were" : " was"} not applied — re-issue them now.`
            : ""),
      );
      setPlan(null);
      setCommand("");
      return;
    }

    // Things a running scenario event owns cannot be changed from here either; say so rather than report them applied.
    const notApplied: string[] = [];
    for (const a of plan.actions) {
      switch (a.type) {
        case "close_lane":
        case "open_lane": {
          const shut = a.type === "close_lane";
          const idx = a.lanes.map((n) => n - 1).filter((i) => i >= 0 && i < focused.laneCount);
          const held = shut ? [] : idx.filter((i) => focused.lockedLanes[i]);
          if (held.length > 0 && focused.owners.closure) {
            notApplied.push(`Lane ${held.map((i) => i + 1).join(", ")} stays closed (driven by ${describeOwner(focused.owners.closure)})`);
          }
          const free = idx.filter((i) => !held.includes(i));
          if (free.length === 0) break;
          focused.setClosedLanes((prev) => prev.map((c, i) => (free.includes(i) ? shut : c)));
          applied.push(`${shut ? "Closed" : "Opened"} lane ${free.map((i) => i + 1).join(", ")}`);
          break;
        }
        case "set_speed_limit":
          if (focused.owners.speedZone) {
            notApplied.push(`The speed zone is driven by ${describeOwner(focused.owners.speedZone)}`);
            break;
          }
          focused.setSpeedLimit(a.kmh);
          applied.push(a.kmh == null ? "Removed the speed limit" : `Speed limit ${a.kmh} km/h`);
          break;
        case "add_incident": {
          const x = (a.positionPct / 100) * segLengthM;
          focused.placeIncident(a.lane - 1, x);
          applied.push(`Incident in lane ${a.lane}`);
          break;
        }
        case "clear_incidents":
          // Only the operator's: a running scenario's obstacle stays until its event ends.
          focused.clearIncidents();
          applied.push("Cleared incidents");
          break;
        case "set_inflow":
          focused.setInflow(a.vehPerHour);
          applied.push(`Inflow ${fmt(a.vehPerHour)} veh/h`);
          break;
        case "set_lane_count":
          focused.setLaneCount(a.lanes);
          applied.push(`${a.lanes} lanes`);
          break;
        case "set_route": {
          const o = EXITS.findIndex((x) => x.exit_id === a.originExitId);
          const d = EXITS.findIndex((x) => x.exit_id === a.destinationExitId);
          if (o < 0 || d < 0) break;
          setOrigin(o);
          setDestination(d);
          applied.push(`Route ${displayExitName(EXITS[o].exit_name)} → ${displayExitName(EXITS[d].exit_name)}`);
          break;
        }
      }
    }

    setCommandNote(
      (applied.length ? `Applied: ${applied.join(" · ")}.` : "Nothing to apply.") +
        (notApplied.length ? ` Not applied: ${notApplied.join(" · ")}.` : ""),
    );
    setPlan(null);
    setCommand("");
  };
  // clearIncidents, toggleLane, addScenarioEvent, removeScenarioEvent, cancelSkip, skipToNextPhase,
  // captureBaseline, interventionSummary and anyIntervention are all useDirectionSim's now — called
  // per direction there, read here as focused.clearIncidents etc. (see the JSX below).
  const laneOverridden = segmentLanes != null && focused.laneCount !== segmentLanes;

  /* Baseline capture is a three-step procedure and the panel now says so.
   * Throughput is counted over the run so far, so a snapshot taken seconds
   * after a rebuild records a near-zero flow — the road has not filled and
   * nobody has finished the segment yet — and every later comparison then
   * reads as a miracle. Hence the settling step, which is the one an operator
   * would never guess at. Reads the FOCUSED direction (see the D2 scoping note
   * above useDirectionSim) — Phase D4 shows this per direction in Both mode. */
  const elapsedS = focused.metrics?.elapsedS ?? 0;
  const warmedUp = elapsedS >= WARMUP_S;
  const stepDone = [warmedUp, focused.baseline != null, focused.baseline != null && focused.anyIntervention];
  const activeStep = stepDone.findIndex((d) => !d) + 1; // 0 once all are done
  const stepCls = (n: number) =>
    `sandbox-step${stepDone[n - 1] ? " is-done" : activeStep === n ? " is-now" : ""}`;
  const recommendation = getRecommendation(focused.metrics, focused.baseline, [...focused.eff.closedLanes], focused.effIncidentCount, focused.eff.speedLimitKmh);

  return (
    <section className="ds-content sandbox-page">
      <PageHeader
        icon={Car}
        title="AI Traffic Sandbox"
        subtitle={`Agent-based what-if simulation · ${originExit ? displayExitName(originExit.exit_name) : ""} → ${destExit ? displayExitName(destExit.exit_name) : ""} · Km ${fromKm.toFixed(2)}–${toKm.toFixed(2)}`}
      />

      {/* Live metric tiles */}
      {/* The prescriptive seam: the three forecasts choose the conditions this
          scenario starts from. */}
      <ScenarioForecastPanel
        onApplyInflow={(v, day) => {
          // The forecast is one corridor prediction, not one per carriageway (D2 §3): applies to
          // whichever direction is focused (Both mode) or the only one there is otherwise.
          focused.setInflow(v);
          setForecastDay(day);
        }}
        onHotspot={(name, km) => {
          // Only reposition while the operator has not chosen a span of their
          // own — a suggestion should not overwrite a deliberate choice.
          if (segFromKm != null || segToKm != null) return;
          if (km < routeFromKm || km > routeToKm) return;
          const half = DEFAULT_SEG_M / 2000;
          const from = Math.max(routeFromKm, Math.min(km - half, routeToKm - DEFAULT_SEG_M / 1000));
          setSegFromKm(Number(from.toFixed(2)));
          setSegToKm(Number((from + DEFAULT_SEG_M / 1000).toFixed(2)));
          setHotspot(name);
        }}
        onIncidentCoverage={setIncidentCovered}
      />

      {/* Metric tiles: the FOCUSED direction (Phase D4 adds a per-direction + corridor-total view for Both mode — see the D1 report for the flow-weighted-average-speed / max-queue aggregation rules). */}
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

      <div className="sandbox-grid" style={{ marginTop: 14 }}>
        {/* Simulation canvas + recommendation */}
        <article className={`sandbox-main${expanded ? " is-expanded" : ""}`}>
          <div className="sandbox-head">
            <h2>Traffic Simulation</h2>
            <div>
              <div className="sandbox-speed-seg">
                {SPEED_STEPS.map((s) => (
                  <button key={s} className={simSpeed === s ? "active" : ""} onClick={() => setSimSpeed(s)}>
                    {s}×
                  </button>
                ))}
              </div>
              <button className="btn-primary" onClick={() => setRunning((r) => !r)}>
                {running ? "Pause" : "Play"}
              </button>
              <button className="btn-muted" onClick={() => { nb.rebuild(); sb.rebuild(); }}>
                Reset
              </button>
              <button
                className="btn-muted"
                onClick={() => setExpanded((v) => !v)}
                title={expanded ? "Exit full screen (Esc)" : "Expand the road to fill the screen"}
              >
                {expanded ? "Exit full screen" : "Full screen"}
              </button>
            </div>
          </div>

          {/* The PRIMARY control on this card, not a peer of the speed buttons above: with the old
              swap button gone, this is the only place a carriageway is chosen at all, and in Both
              mode the road below draws exactly what it says (two carriageways, one median) — it
              needs to read as the thing that decides that, at a glance, in a screenshot. */}
          <div className="sandbox-view-seg" role="tablist" aria-label="Carriageway view">
            <span className="k">Carriageway</span>
            <div className="sandbox-view-buttons">
              {(["NB", "SB", "Both"] as const).map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  className={view === v ? "active" : ""}
                  onClick={() => setView(v)}
                  title={v === "Both" ? "Both carriageways at once, median-separated — the whole road" : v === "NB" ? "Northbound only" : "Southbound only"}
                >
                  {v === "NB" ? "Northbound" : v === "SB" ? "Southbound" : "Both (NB + SB)"}
                </button>
              ))}
            </div>
            {view === "Both" && (
              <>
                <span className="k" style={{ marginLeft: 10 }}>Controls follow</span>
                <div className="sandbox-speed-seg" role="tablist" aria-label="Focused carriageway">
                  {(["NB", "SB"] as const).map((d) => (
                    <button key={d} role="tab" aria-selected={focusedDirection === d} className={focusedDirection === d ? "active" : ""} onClick={() => setFocusedDirection(d)}>
                      {d}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {view === "Both" && (
            <p className="sandbox-live-note">
              Both carriageways are drawn and simulated together, median-separated, lane 1 against
              the median on each side. The controls below still act on one direction at a time —
              {" "}<b>{focusedDirection}</b>, chosen above — full per-direction controls and a
              corridor total are coming next.
            </p>
          )}

          {/* Full screen hides the controls panel, so the road could be studied
              but not acted on — an operator had to leave the view to place the
              closure they were looking at. The controls that matter while
              watching the road come with it. Full-screen controls act on the
              FOCUSED direction, same as the docked ones (see the note above). */}
          {expanded && (
            <div className="sandbox-fs-bar">
              <span className="k">Close lane</span>
              <div className="sandbox-lane-toggles">
                {Array.from({ length: focused.laneCount }, (_, i) => (
                  <button
                    key={i}
                    className={focused.closedLanes[i] || focused.lockedLanes[i] ? "closed" : ""}
                    onClick={() => focused.toggleLane(i)}
                    disabled={focused.lockedLanes[i]}
                    title={focused.lockedLanes[i] && focused.owners.closure ? `Driven by: ${describeOwner(focused.owners.closure)}` : undefined}
                  >
                    L{i + 1}
                  </button>
                ))}
              </div>

              <span className="k">Closed Km</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 84 }}>
                  <KmInput value={focused.shownClosureFromKm} min={fromKm} max={toKm} onCommit={focused.commitClosureStart} disabled={focused.owners.closure !== null} />
                </div>
                <span className="k" style={{ opacity: 0.7 }}>to</span>
                <div style={{ width: 84 }}>
                  <KmInput
                    value={focused.shownClosureToKm}
                    min={fromKm}
                    max={toKm}
                    onCommit={focused.commitClosureEnd}
                    disabled={focused.owners.closure !== null}
                  />
                </div>
                <span className="k" style={{ opacity: 0.7 }}>
                  {Math.round((focused.shownClosureToKm - focused.shownClosureFromKm) * 1000)} m
                </span>
              </div>
              {focused.owners.closure && (
                <span className="k" style={{ opacity: 0.85 }}>Driven by: {describeOwner(focused.owners.closure)}</span>
              )}

              <button
                className={`btn-muted ${focused.placingClosure ? "active" : ""}`}
                disabled={focused.owners.closure !== null}
                onClick={() => {
                  focused.setPlacingClosure((v) => !v);
                  focused.setPlacingIncident(false);
                }}
              >
                {focused.placingClosure ? (focused.closureDraftKm == null ? "Click start…" : "Click end…") : "Set closed stretch"}
              </button>
              <button
                className={`btn-muted ${focused.placingIncident ? "active" : ""}`}
                onClick={() => {
                  focused.setPlacingIncident((v) => !v);
                  focused.setPlacingClosure(false);
                }}
              >
                {focused.placingIncident ? "Click a lane…" : "Drop incident"}
              </button>
              <button className="btn-muted" onClick={focused.clearIncidents} disabled={focused.incidentCount === 0}>
                Clear ({focused.incidentCount})
              </button>
              <ClosureHint placing={focused.placingClosure} draftKm={focused.closureDraftKm} anyClosed={focused.closedLanes.some(Boolean)} laneCount={focused.laneCount} dark />
            </div>
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
            className={`sandbox-canvas ${focused.placingIncident || focused.placingClosure ? "placing" : ""}`}
            style={
              expanded
                ? undefined
                : {
                    minHeight:
                      view === "Both"
                        ? (nb.laneCount + sb.laneCount) * LANE_PX +
                          MEDIAN_GUTTER_PX +
                          (exitsRef.current.length > 0 ? RAMP_GUTTER_PX * 2 : 0) +
                          CANVAS_PAD * 2
                        : focused.laneCount * LANE_PX + CANVAS_PAD * 2,
                  }
            }
            onClick={placeIncidentAt}
            onMouseMove={previewClosureAt}
          />

          {/* Wrapper so the legend and the recommendation can sit side by side
              when expanded. `display: contents` while docked means it changes
              nothing there. */}
          <div className="sandbox-footbar">
          {/* Two things the panel must never hide.
              A warm-up reading is the road filling, not the scenario. And when
              demand exceeds what the segment can take, the surplus queues
              upstream where nothing draws it, so the road can report a healthy
              speed precisely because a quarter of the traffic never got on. */}
          {focused.metrics && !focused.metrics.warm && (
            <p className="sandbox-live-note">
              Warming up &mdash; the road is still filling, so these figures are not yet the
              scenario. {Math.max(0, Math.ceil(WARMUP_S - focused.metrics.elapsedS))}s to go.
            </p>
          )}
          {focused.metrics && focused.metrics.warm && focused.metrics.unmetVehPerHour > 1 && (
            <p className="sandbox-live-note warn">
              {Math.round(focused.metrics.unmetVehPerHour).toLocaleString()} veh/h of demand cannot
              enter: the segment is at capacity and the queue for it forms upstream, outside
              this model. The speeds shown describe only the traffic that got on.
            </p>
          )}
          <div className="sandbox-legend">
            <span><i style={{ background: CLASS_META[1].color }} /> Class 1 · light</span>
            <span><i style={{ background: CLASS_META[2].color }} /> Class 2 · medium</span>
            <span><i style={{ background: CLASS_META[3].color }} /> Class 3 · heavy</span>
            <span><i style={{ background: "#dc2626" }} /> stopped / incident</span>
            <span><i style={{ background: "#f59e0b" }} /> scenario event</span>
          </div>

          {/* Before / after. The deltas exist as small tinted text on the metric
              tiles, which is easy to miss and impossible to read as a whole.
              Laid out side by side, the effect of an intervention is one
              glance rather than four comparisons. */}
          {focused.baseline && focused.metrics && focused.anyIntervention && (
            <div className="sandbox-compare">
              <div className="sandbox-compare-head">
                <b>Baseline vs now</b>
                <span>
                  {focused.baseline.takenWith} &rarr; {focused.interventionSummary}
                </span>
              </div>
              <div className="sandbox-compare-rows">
                {([
                  ["Avg speed", focused.baseline.avgSpeedKmh, focused.metrics.avgSpeedKmh, "km/h", true],
                  ["Throughput", focused.baseline.throughputPerMin, focused.metrics.throughputPerMin, "/min", true],
                  ["Longest queue", focused.baseline.longestQueueM, focused.metrics.longestQueueM, "m", false],
                  ["CO₂ rate", focused.baseline.co2RatePerMin, focused.metrics.co2RatePerMin, "kg/min", false],
                ] as [string, number, number, string, boolean][]).map(
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
            </div>
          )}

          <div className={`sandbox-reco ${recommendation.tone}`}>
            <strong>Prescriptive recommendation</strong>
            <p>{recommendation.text}</p>
          </div>
          </div>
        </article>

        {/* Controls */}
        <aside className="sandbox-side">
          <div className="sandbox-side-head">
            <h2>{sideMode === "command" ? "Command Prompt" : "Simulation Controls"}</h2>
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
          {/* Side by side: two full-width selects stacked cost a whole row of
              rail height for no gain, and a route reads better as one line. */}
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ flex: 1, minWidth: 0 }}>
              Origin
              <select value={origin} onChange={(e) => setOrigin(Number(e.target.value))}>
                {EXITS.map((ex, i) => (
                  <option key={ex.exit_id} value={i} disabled={i === destination}>
                    {displayExitName(ex.exit_name)} (Km {ex.km})
                  </option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1, minWidth: 0 }}>
              Destination
              <select value={destination} onChange={(e) => setDestination(Number(e.target.value))}>
                {EXITS.map((ex, i) => (
                  <option key={ex.exit_id} value={i} disabled={i === origin}>
                    {displayExitName(ex.exit_name)} (Km {ex.km})
                  </option>
                ))}
              </select>
            </label>
          </div>
          {/* Hour of day.
              The inflow used to be a daily mean times an assumed peaking
              factor of 1.6, a number nobody had checked. The warehouse holds
              the measured 24-hour shape, so the operator picks an HOUR and the
              simulation runs at what that hour actually carries — volume and
              fleet mix both. It is also the question they actually have: not
              "what happens at 4,500 veh/h" but "which hour is cheapest to
              close this lane". */}
          {focused.demand && hourOfDay != null && (
            <div className="sandbox-hour">
              <div className="sandbox-hour-head">
                <span>Hour of day</span>
                <b>
                  {String(hourOfDay).padStart(2, "0")}:00 &middot;{" "}
                  {focused.activeHour?.vehPerHour.toLocaleString()} veh/h
                  {hourOfDay === focused.demand.peakHour ? " · peak" : ""}
                </b>
              </div>
              <input
                type="range"
                min={0}
                max={23}
                step={1}
                value={hourOfDay}
                onChange={(e) => setHourOfDay(Number(e.target.value))}
                aria-label="Hour of day"
              />
              <p className="sandbox-hour-note">
                {focused.activeHour
                  ? `${(focused.activeHour.mix[2] * 100 + focused.activeHour.mix[3] * 100).toFixed(0)}% heavy vehicles at this hour. `
                  : ""}
                Measured at {displayExitName(String(nearestExit?.exit_name ?? ""))} over {focused.demand.days.toLocaleString()} days;
                peak {focused.demand.peakVehPerHour.toLocaleString()} veh/h at{" "}
                {String(focused.demand.peakHour).padStart(2, "0")}:00, {focused.demand.peakingFactor.toFixed(2)}&times; the daily mean.
              </p>
              {/* Where the inflow figure came from. The panel used to show a
                  number with no basis, and the basis turned out to be wrong —
                  an on-ramp volume standing in for a through-flow — which is
                  precisely the kind of error a visible provenance line catches
                  before it reaches a recommendation. */}
              {focused.inflowBasis && <p className="sandbox-hour-note src">{focused.inflowBasis}</p>}
            </div>
          )}

          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">{view === "Both" ? `Inflow (${focusDirection})` : "Inflow"}</span>
              <span className="sandbox-slider-value" style={{ color: "var(--brand-primary)" }}>{fmt(focused.inflow)} veh/hr</span>
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
            <span className="sandbox-slider-hint">
              {forecastDay
                ? `Forecast for ${new Date(`${forecastDay}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                : focused.dataAnchor
                  ? `Observed NLEX peak ≈ ${fmt(focused.dataAnchor)} veh/hr`
                  : "Vehicle entry rate"}
            </span>
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
                <span className="sandbox-slider-value" style={{ color: "var(--brand-primary)" }}>
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

          {/* The stretch under study, as km-posts. An operator asks about
              "km 3.5 to km 6"; the simulation is parameterised on length, so it
              models exactly that rather than a fixed sample. */}
          {/* Exits on this route. A junction is the unit an operator actually
              thinks in — "what happens at Bocaue" — so clicking one frames the
              drawn window on it rather than making them convert to km posts
              and type two numbers. Highlighted = currently on screen. */}
          <div className="sandbox-slider-group">
            <button
              onClick={() => setExitsOpen((o) => !o)}
              aria-expanded={exitsOpen}
              className="sandbox-slider-header"
              style={{ width: "100%", background: "none", border: 0, padding: 0, cursor: "pointer" }}
            >
              <span className="sandbox-slider-label" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none"
                     style={{ transform: exitsOpen ? "rotate(90deg)" : "none", transition: "transform 140ms ease" }}>
                  <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Exits on route
              </span>
              <span className="sandbox-slider-value" style={{ color: "#38bdf8" }}>
                {visibleExitIds.size} of {routeExits.length} in view
              </span>
            </button>
            {routeExits.length === 0 ? (
              <span className="sandbox-slider-hint">
                No junction lies between the chosen origin and destination.
              </span>
            ) : !exitsOpen ? null : (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {routeExits.map((ex) => {
                    const on = visibleExitIds.has(ex.exit_id);
                    const anchored = spanAnchorKm === ex.km;
                    return (
                      <button
                        key={ex.exit_id}
                        onClick={() => {
                          if (spanAnchorKm == null) {
                            setSpanAnchorKm(ex.km);
                            focusExit(ex.km);
                          } else if (spanAnchorKm === ex.km) {
                            setSpanAnchorKm(null); // clicking the anchor again cancels
                          } else {
                            spanExits(spanAnchorKm, ex.km);
                            setSpanAnchorKm(null);
                          }
                        }}
                        title={
                          spanAnchorKm == null
                            ? `Frame the segment on ${displayExitName(ex.exit_name)} (Km ${ex.km}). Then click a second junction to span between them.`
                            : spanAnchorKm === ex.km
                              ? "Click again to cancel the span"
                              : `Span from Km ${spanAnchorKm} to Km ${ex.km}`
                        }
                        style={{
                          border: anchored
                            ? "1px solid #f59e0b"
                            : on
                              ? "1px solid #38bdf8"
                              : "1px solid var(--border-default)",
                          background: anchored
                            ? "rgba(245,158,11,0.16)"
                            : on
                              ? "rgba(56,189,248,0.14)"
                              : "var(--bg-surface)",
                          color: anchored ? "#92400e" : on ? "#0369a1" : "var(--text-secondary)",
                          borderRadius: 999,
                          padding: "3px 9px",
                          fontSize: "0.72rem",
                          fontWeight: on ? 700 : 500,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {displayExitName(ex.exit_name)}
                        <span style={{ opacity: 0.65, marginLeft: 4 }}>{ex.km}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="sandbox-btn-row">
                  <button className="btn-muted" style={{ flex: 1 }} onClick={fitRoute}
                          title="Widen the drawn window to the whole origin-to-destination route, as far as it can still be drawn legibly.">
                    Fit whole route
                  </button>
                </div>
                <span className="sandbox-slider-hint">
                  {spanAnchorKm != null
                    ? `Km ${spanAnchorKm} selected — click another junction to span between them, or the same one to cancel.`
                    : "Click a junction to frame it; click a second to span between two. Junctions inside the window are drawn on the road as off-ramps."}
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
              <span className="sandbox-slider-label">Carriageway</span>
              <span className="sandbox-slider-value" style={{ color: "#0ea5e9" }}>
                {view === "Both" ? `Both (focused: ${focusDirection === "NB" ? "Northbound" : "Southbound"})` : focusDirection === "NB" ? "Northbound" : "Southbound"}
              </span>
            </div>
            <span className="sandbox-slider-hint">
              NLEX runs Balintawak (Km 0) north to Sta. Ines. Use the Carriageway control above the
              road to choose. The km axis is fixed — Km 0 is always on-screen-left — and it is the
              TRAFFIC that runs right to left when southbound; each direction&apos;s inflow anchors to
              its own observed volume, independently. Both mode draws the two carriageways stacked
              with a median between them, NB above and SB below, sharing this one axis — lane 1 sits
              against the median on both sides.
            </span>
          </div>

          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">Segment</span>
              <span className="sandbox-slider-value" style={{ color: "#7c3aed" }}>
                {(segLengthM / 1000).toFixed(2)} km
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label style={{ flex: 1, minWidth: 0 }}>
                <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>From km</span>
                <KmInput
                  value={fromKm}
                  min={routeFromKm}
                  max={routeToKm}
                  onCommit={setSegFromKm}
                />
              </label>
              <label style={{ flex: 1, minWidth: 0 }}>
                <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>To km</span>
                <KmInput
                  value={toKm}
                  min={routeFromKm}
                  max={routeToKm}
                  onCommit={setSegToKm}
                />
              </label>
            </div>
            <span className="sandbox-slider-hint">
              {hotspot
                ? incidentCovered
                  ? `Opened at ${hotspot} — the highest incident risk on this route for the selected day. `
                  : `Opened at ${hotspot}, chosen on an earlier forecast day — the selected day has no incident forecast yet. `
                : ""}
              {`Route runs Km ${routeFromKm.toFixed(2)}–${routeToKm.toFixed(2)}.`}
              {tooFineToDraw
                ? ` At ${(segLengthM / 1000).toFixed(2)} km a car is ${carPx.toFixed(1)} px wide, so the road switches to a density view — colour is mean speed, green running to red stopped. Narrow to roughly ${(maxLegibleM / 1000).toFixed(1)} km or less to see individual vehicles.`
                : spanCapped
                  ? ` Drawing is capped at ${(MAX_SEG_M / 1000).toFixed(1)} km. Narrow the range to study a longer route in parts.`
                  : nearestExit
                    ? ` Nearest exit: ${displayExitName(nearestExit.exit_name)}. Changing the segment resets the run.`
                    : " Changing the segment resets the run."}
            </span>
          </div>

          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">{view === "Both" ? `Lanes (${focusDirection})` : "Lanes"}</span>
              <span className="sandbox-slider-value" style={{ color: laneOverridden ? "#b45309" : "#16a34a" }}>
                {focused.laneCount}
              </span>
            </div>
            <input
              type="range"
              min={2}
              max={5}
              step={1}
              value={focused.laneCount}
              onChange={(e) => focused.setLaneCount(Number(e.target.value))}
              className="sandbox-range lanes"
              style={{ "--range-pct": `${((focused.laneCount - 2) / 3) * 100}%` } as React.CSSProperties}
            />
            <span className="sandbox-slider-hint">
              {segmentLanes == null
                ? "No verified lane count for this segment — set it manually. Changing lanes resets the run."
                : laneOverridden
                  ? `Overriding the corridor: ${displayExitName(originExit?.exit_name ?? "")} → ${displayExitName(destExit?.exit_name ?? "")} is ${segmentLanes} lanes. Changing lanes resets the run.`
                  : `Matches the corridor between ${displayExitName(originExit?.exit_name ?? "")} and ${displayExitName(destExit?.exit_name ?? "")}${laneProvenance.length ? ` · ${laneProvenance.join(", ")}` : ""}. Changing lanes resets the run.`}
            </span>
          </div>
          {/* Both mode: the other direction's own lane count, independently adjustable — D2.4's "per-direction lane count, defaulting to the same value" (both start from segmentLanes; either can diverge from here). */}
          {view === "Both" && (
            <div className="sandbox-slider-group">
              <div className="sandbox-slider-header">
                <span className="sandbox-slider-label">Lanes ({focusDirection === "NB" ? "SB" : "NB"})</span>
                <span className="sandbox-slider-value" style={{ color: "#16a34a" }}>
                  {byDirection[focusDirection === "NB" ? "SB" : "NB"].laneCount}
                </span>
              </div>
              <input
                type="range"
                min={2}
                max={5}
                step={1}
                value={byDirection[focusDirection === "NB" ? "SB" : "NB"].laneCount}
                onChange={(e) => byDirection[focusDirection === "NB" ? "SB" : "NB"].setLaneCount(Number(e.target.value))}
                className="sandbox-range lanes"
                style={{ "--range-pct": `${((byDirection[focusDirection === "NB" ? "SB" : "NB"].laneCount - 2) / 3) * 100}%` } as React.CSSProperties}
              />
            </div>
          )}

          </RailSection>

          <RailSection
            title="Interventions"
            open={openSection === "interventions"}
            onToggle={() => toggleSection("interventions")}
            summary={focused.interventionSummary}
          >

          {/* Every control here acts on the FOCUSED direction (Phase D4 splits this per direction for Both mode). */}
          <span className="sandbox-mini-label">Close a lane (traffic must merge out)</span>
          <div className="sandbox-lane-toggles">
            {Array.from({ length: focused.laneCount }, (_, i) => (
              <button
                key={i}
                className={focused.closedLanes[i] || focused.lockedLanes[i] ? "closed" : ""}
                onClick={() => focused.toggleLane(i)}
                disabled={focused.lockedLanes[i]}
                title={focused.lockedLanes[i] && focused.owners.closure ? `Driven by: ${describeOwner(focused.owners.closure)}` : undefined}
              >
                L{i + 1}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 8 }}>
            <span className="sandbox-mini-label">
              Closed from Km {focused.shownClosureFromKm.toFixed(2)} to Km {focused.shownClosureToKm.toFixed(2)} ·{" "}
              {Math.round((focused.shownClosureToKm - focused.shownClosureFromKm) * 1000)} m
            </span>
            {focused.owners.closure && (
              <p className="sandbox-live-note">
                Driven by: {describeOwner(focused.owners.closure)}. The stretch is locked. You can close more lanes on it; the lanes
                the event blocks stay closed until it moves on.
              </p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <label style={{ flex: 1, minWidth: 0 }}>
                <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>From km</span>
                <KmInput value={focused.shownClosureFromKm} min={fromKm} max={toKm} onCommit={focused.commitClosureStart} disabled={focused.owners.closure !== null} />
              </label>
              <label style={{ flex: 1, minWidth: 0 }}>
                <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>To km</span>
                <KmInput value={focused.shownClosureToKm} min={fromKm} max={toKm} onCommit={focused.commitClosureEnd} disabled={focused.owners.closure !== null} />
              </label>
            </div>
            {/* The instruction that used to sit here ran to three wrapped lines
                and repeated what the button beside it already says. It is
                reference material — read once, then never again — so it moves
                onto the controls it describes as a tooltip. */}
          </div>

          {/* One row, not two. "Set closed stretch" sat alone above its own
              hint line, with the incident buttons in a second row below it —
              three interactive controls spread over two rows and two gaps.
              They are all "place something on the road", so they read better
              as one cluster and cost a row less height. */}
          <div className="sandbox-btn-row sandbox-btn-row-3">
            <button
              className={`btn-muted ${focused.placingClosure ? "active" : ""}`}
              title="Traffic merges out before the start and the lane reopens after the end. Type the Km range above, or press this and click the road twice — start, then end."
              disabled={focused.owners.closure !== null}
              onClick={() => {
                focused.setPlacingClosure((p) => !p);
                focused.setPlacingIncident(false);
              }}
            >
              {focused.placingClosure ? (focused.closureDraftKm == null ? "Click start…" : "Click end…") : "Set stretch"}
            </button>
            <button
              className={`btn-muted ${focused.placingIncident ? "active" : ""}`}
              title="Drop a stopped vehicle on a lane to see how traffic behaves around it."
              onClick={togglePlacing}
            >
              {focused.placingIncident ? "Placing…" : "Drop incident"}
            </button>
            <button className="btn-muted" onClick={focused.clearIncidents} disabled={focused.incidentCount === 0}>
              Clear ({focused.incidentCount})
            </button>
          </div>
          <ClosureHint placing={focused.placingClosure} draftKm={focused.closureDraftKm} anyClosed={focused.closedLanes.some(Boolean)} laneCount={focused.laneCount} />
          {focused.placingIncident && (
            <p className="sandbox-place-hint">
              Click a lane on the simulation to drop an incident · Esc to cancel
            </p>
          )}

          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">Speed limit zone</span>
              <span className="sandbox-slider-value" style={{ color: "#ea580c" }}>
                {focused.shownSpeedLimit == null ? "off" : `${focused.shownSpeedLimit} km/h`}
              </span>
            </div>
            {focused.owners.speedZone && (
              <p className="sandbox-live-note">
                Driven by: {describeOwner(focused.owners.speedZone)}. The zone and its limit are locked until the event ends.
              </p>
            )}
            <input
              type="range"
              min={20}
              max={100}
              step={5}
              value={focused.shownSpeedLimit ?? 100}
              onChange={(e) => focused.setSpeedLimit(Number(e.target.value) >= 100 ? null : Number(e.target.value))}
              disabled={focused.owners.speedZone !== null}
              className="sandbox-range capacity"
              title="Slide to 100 to disable the zone."
              style={{ "--range-pct": `${(((focused.shownSpeedLimit ?? 100) - 20) / 80) * 100}%` } as React.CSSProperties}
            />
            {/* "Slide to 100 to disable" was a whole line spent restating the
                value readout beside the title, which already says "off" the
                moment the zone is disabled. It survives as the slider's own
                tooltip. */}
            {focused.shownSpeedLimit != null && (
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <label style={{ flex: 1, minWidth: 0 }}>
                  <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>
                    Zone from km
                  </span>
                  <KmInput value={focused.shownZoneFromKm} min={fromKm} max={toKm} onCommit={focused.setZoneFromKm} disabled={focused.owners.speedZone !== null} />
                </label>
                <label style={{ flex: 1, minWidth: 0 }}>
                  <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>
                    Zone to km
                  </span>
                  <KmInput value={focused.shownZoneToKm} min={fromKm} max={toKm} onCommit={focused.setZoneToKm} disabled={focused.owners.speedZone !== null} />
                </label>
              </div>
            )}
          </div>

          </RailSection>

          <RailSection
            title="Scenario events"
            open={openSection === "scenarios"}
            onToggle={() => toggleSection("scenarios")}
            summary={
              focused.scenarioEvents.length === 0
                ? "none"
                : `${focused.scenarioEvents.length} event${focused.scenarioEvents.length === 1 ? "" : "s"} · ${focused.activeScenarioText.length > 0 ? focused.activeScenarioText[0] : "none running"}`
            }
          >
            {/* Events for the FOCUSED direction only — its own bucket (D2 correction #1: an
                event carries its direction explicitly AND lives in that direction's list).
                Phase D4 adds the picker (defaulting to the viewed direction, required in Both
                mode); for now every event this panel creates is stamped with focusDirection. */}
            <ScenarioPanel
              events={focused.scenarioEvents}
              owners={focused.owners}
              road={focused.scenarioRoad}
              direction={focusDirection}
              nowS={focused.scenarioNowS}
              laneCount={focused.laneCount}
              fromKm={fromKm}
              toKm={toKm}
              kmAtPct={(pct) => focused.kmAt((focused.spanM * pct) / 100)}
              manualClosure={{ closedLanes: focused.closedLanes, closurePoint: focused.manualControls.closurePoint, closureEnd: focused.manualControls.closureEnd }}
              nextSeq={focused.scenarioSeqRef.current + 1}
              onAdd={focused.addScenarioEvent}
              onRemove={focused.removeScenarioEvent}
              skip={focused.skip}
              canSkip={nextBoundaryAfter(focused.scenarioEvents, focused.scenarioRoad, focused.scenarioNowS) !== null}
              onSkip={focused.skipToNextPhase}
              onCancelSkip={focused.cancelSkip}
            />
          </RailSection>

          <RailSection
            title="Baseline comparison"
            open={openSection === "baseline"}
            onToggle={() => toggleSection("baseline")}
            summary={focused.baseline ? `${fmt(focused.baseline.avgSpeedKmh)} km/h · ${fmt(focused.baseline.throughputPerMin)}/min captured` : "not captured"}
          >
          {/* This was a lone "Capture baseline" button whose only explanation
              lived in a title tooltip — invisible unless hovered, so nothing on
              screen said what a baseline was for or that the ORDER matters.
              Capture after closing a lane and every delta reads 0%, and the
              feature looks broken rather than misused. The procedure is now the
              UI: three steps that tick themselves off, with the button sitting
              inside the step it belongs to, and only the current step carrying
              its explanation so the panel stays short. */}
          <p className="sandbox-baseline-lede">
            Measures what an intervention costs, by comparing the road before and after it.
          </p>
          <ol className="sandbox-steps">
            <li className={stepCls(1)}>
              <span className="n">{stepDone[0] ? "✓" : "1"}</span>
              <div className="t">
                <b>Let the road settle</b>
                {activeStep === 1 && (
                  <i>
                    Throughput counts vehicles finishing the segment, so it needs about a
                    minute of running before it means anything.
                    {focused.metrics ? ` ${Math.ceil(Math.max(0, WARMUP_S - elapsedS))}s to go.` : ""}
                  </i>
                )}
              </div>
            </li>

            <li className={stepCls(2)}>
              <span className="n">{stepDone[1] ? "✓" : "2"}</span>
              <div className="t">
                <b>Capture the &ldquo;before&rdquo;</b>
                {focused.baseline ? (
                  <i>
                    Recorded {fmt(focused.baseline.avgSpeedKmh)} km/h · {fmt(focused.baseline.throughputPerMin)}/min
                    with {focused.baseline.takenWith}.
                  </i>
                ) : activeStep === 2 ? (
                  <i>Freezes the current numbers for comparison. Nothing in the simulation changes.</i>
                ) : null}
                <div className="sandbox-btn-row">
                  <button
                    className="btn-primary"
                    onClick={focused.captureBaseline}
                    disabled={!focused.metrics}
                    style={{ marginLeft: 0 }}
                  >
                    {focused.baseline ? "Re-capture" : "Capture baseline"}
                  </button>
                  {focused.baseline && (
                    <button className="btn-muted" onClick={() => focused.setBaseline(null)}>
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </li>

            <li className={stepCls(3)}>
              <span className="n">{stepDone[2] ? "✓" : "3"}</span>
              <div className="t">
                <b>Change something, then read the difference</b>
                {stepDone[2] ? (
                  <i>
                    Comparing {focused.baseline?.takenWith} &rarr; {focused.interventionSummary}. The
                    before/after table is under the road.
                  </i>
                ) : activeStep === 3 ? (
                  <i>
                    Close a lane or set a speed limit in Interventions above. A before/after
                    table then appears under the road.
                  </i>
                ) : null}
              </div>
            </li>
          </ol>
          </RailSection>

          <RailSection
            title="Confidence run"
            open={openSection === "confidence"}
            onToggle={() => toggleSection("confidence")}
            summary={
              repProgress != null
                ? `running ${(repProgress * 100).toFixed(0)}%`
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
              disabled={focused.scenarioEvents.length > 0}
              style={{ marginLeft: 0 }}
            >
              {repProgress != null ? "Stop" : "Run"}
            </button>
            {repProgress != null && (
              <span className="sandbox-reps-prog">{(repProgress * 100).toFixed(0)}%</span>
            )}
          </div>
          {focused.scenarioEvents.length > 0 && (
            <p className="sandbox-reps-warn">{"Confidence runs don't yet support timed events."}</p>
          )}
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
              </p>
            </div>
          )}
          </RailSection>
          </div>
          ) : (
          <div className="sandbox-side-scroll">
            <div className="ai-command">
              <p className="ai-command-sub">
                Type natural-language commands to control traffic on the NLEX corridor.
              </p>
              <textarea
                className="ai-command-input"
                rows={4}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={'Try: "From Balintawak close lane 4" or "Set 2 lanes open"'}
              />
              <button
                className="ai-command-btn"
                onClick={runCommand}
                disabled={!command.trim() || commandBusy}
              >
                {commandBusy ? "Interpreting…" : "Execute Command"}
              </button>

              {commandError && <p className="ai-command-error">{commandError}</p>}

              {/* A proposal, not a change. Nothing reaches the simulation until
                  the operator presses Apply. */}
              {plan && (
                <div className="ai-plan">
                  <p className="ai-plan-reply">{plan.reply}</p>

                  {plan.actions.length > 0 ? (
                    <ul className="ai-plan-actions">
                      {plan.actions.map((a, i) => (
                        <li key={i}>{describeAction(a, EXITS)}</li>
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
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (km: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft == null) return;
    const n = Number.parseFloat(draft);
    setDraft(null);
    // An unparseable or empty entry reverts rather than silently becoming zero.
    if (Number.isFinite(n)) onCommit(n);
  };

  return (
    <input
      type="number"
      className="sandbox-km-input"
      min={min}
      max={max}
      step={0.05}
      disabled={disabled}
      value={draft ?? String(Number(value.toFixed(2)))}
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

function getRecommendation(
  m: Metrics | null,
  base: Baseline | null,
  closedLanes: boolean[],
  incidents: number,
  speedLimit: number | null
): { text: string; tone: "good" | "warn" | "bad" } {
  if (!m) return { text: "Warming up the simulation…", tone: "good" };
  const closed = closedLanes.filter(Boolean).length;
  const speedDrop = base ? (base.avgSpeedKmh - m.avgSpeedKmh) / Math.max(1, base.avgSpeedKmh) : 0;

  if (incidents > 0 && m.longestQueueM > 120) {
    return {
      text: `An incident is holding back a ${fmt(m.longestQueueM)} m queue and average speed is ${fmt(m.avgSpeedKmh)} km/h. Deploy responders to clear it before the queue spills upstream.`,
      tone: "bad",
    };
  }
  if (closed > 0 && (m.avgSpeedKmh < 20 || speedDrop > 0.3)) {
    return {
      text: `With ${closed} lane${closed > 1 ? "s" : ""} closed, flow has collapsed to ${fmt(m.avgSpeedKmh)} km/h${base ? ` (${(speedDrop * 100).toFixed(0)}% below baseline` : ""}${base ? ")" : ""}. Reopen a lane or schedule this closure during off-peak demand.`,
      tone: "bad",
    };
  }
  if (m.stoppedCount > 6 || m.longestQueueM > 80) {
    return {
      text: `Congestion is building — ${m.stoppedCount} vehicles stopped, queue ${fmt(m.longestQueueM)} m. Consider opening an additional toll/travel lane or metering inflow upstream.`,
      tone: "warn",
    };
  }
  if (speedLimit != null && m.avgSpeedKmh > 40) {
    return {
      text: `The ${speedLimit} km/h zone is holding flow smooth at ${fmt(m.avgSpeedKmh)} km/h with throughput ${fmt(m.throughputPerMin)}/min. Configuration is stable.`,
      tone: "good",
    };
  }
  return {
    text: `Flow is stable at ${fmt(m.avgSpeedKmh)} km/h and ${fmt(m.throughputPerMin)} vehicles/min clearing the segment. Maintain the current configuration.`,
    tone: "good",
  };
}

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
  title: string;
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
          <span style={{
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

/** Tick spacing in km that yields a readable number of markers for a span. */
function kmTickStep(spanKm: number): number {
  for (const step of [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5]) {
    if (spanKm / step <= 8) return step;
  }
  return 10;
}

/** Tells the operator the one step a closure needs that the controls don't show. */
function ClosureHint({
  placing,
  draftKm,
  anyClosed,
  laneCount,
  dark,
}: {
  placing: boolean;
  draftKm: number | null;
  anyClosed: boolean;
  laneCount: number;
  dark?: boolean;
}) {
  const text = placing
    ? draftKm == null
      ? "Click the road where the closure starts · Esc to cancel"
      : `Starts at Km ${draftKm.toFixed(2)} — now click where it ends · Esc to cancel`
    : !anyClosed
      ? `A closure applies to closed lanes only — pick L1–L${laneCount} to apply it`
      : null;
  if (!text) return null;
  /* Amber, not red.
   *
   * Both of these are guidance — "click the road where the closure starts",
   * "pick a lane for the closure to apply to". Rendered in the danger colour
   * they read as a failure the operator has already caused, and the full
   * screen bar showed one permanently, so the panel looked broken at rest. */
  return dark ? (
    <span className="k" style={{ textTransform: "none", letterSpacing: 0, color: "#fcd34d" }}>
      {text}
    </span>
  ) : (
    <p className="sandbox-place-hint">{text}</p>
  );
}

/** What render() needs to draw scenario events. */
type ScenarioOverlay = {
  events: readonly ScenarioEvent[];
  frame: RoadFrame;
  /** True for an incident in the engine's list that a scenario put there. */
  isScenarioIncident: (i: Incident) => boolean;
};

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

/** A label per scenario event at its location: name, phase and time left; stacked so two never sit on top of each other. */
function drawScenarioLabels(
  ctx: CanvasRenderingContext2D,
  marks: readonly CanvasMark[],
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
  },
) {
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
      : laneSlotTop(m.lane ?? 0, g.roadTop, g.laneH, g.lanes, g.reverseLanes) + g.laneH * 0.5;
    const faint = m.state === "pending";
    // An in-lane breakdown's obstacles are drawn as incidents once it starts; everything else gets a marker here.
    if (m.kind !== "incident" || faint) drawScenarioMarker(ctx, x, laneY, g.r, faint);
    const text = `${m.name} · ${m.text}`;
    const w = ctx.measureText(text).width + 14;
    const h = 18;
    const lx = Math.max(4, Math.min(x - w / 2, g.cssW - w - 4));
    // Above the marker; but the canvas prints its own header along the top edge of the road, so near the top go below it.
    let ly = laneY - g.r - h - 3;
    if (ly < g.roadTop + 20) ly = laneY + g.r + 3;
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
    exits: { name: string; km: number }[];
    overlay: ScenarioOverlay | null;
    /** Single-direction draws its own km axis; Both draws one shared axis separately (drawSharedKmAxis). */
    drawAxis: boolean;
    /** "▶ traffic flow" for single-direction, unchanged; Both passes a direction-aware arrow. */
    flowLabel: string;
    /** Corner label — the full location string for single-direction, just "Northbound"/"Southbound" for Both. */
    location: string;
  },
) {
  const {
    cssW, cssH, roadTop, laneH, roadH, rampGutter, rampsAbove, reverseLanes,
    mToPx, sb, xPx, wPx, fromKm, toKm, exits, overlay, drawAxis, flowLabel, location,
  } = opts;
  const lanes = sim.cfg.laneCount;

  // asphalt
  ctx.fillStyle = "#20293a";
  roundRect(ctx, 0, roadTop, cssW, roadH, 10);
  ctx.fill();

  // speed-limit zone
  if (sim.interventions.speedLimitKmh != null) {
    const [z0, z1] = sim.interventions.speedZone;
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

  // lane dividers
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([14, 14]);
  for (let l = 1; l < lanes; l++) {
    const y = roadTop + l * laneH;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cssW, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // closed-lane hatching + taper
  for (let l = 0; l < lanes; l++) {
    if (!sim.interventions.closedLanes[l]) continue;
    const y = laneSlotTop(l, roadTop, laneH, lanes, reverseLanes);
    const x0 = xPx(sim.interventions.closurePoint);
    // The works end where the operator said they end, not at the edge of the
    // view — a closure that always ran to the end of the screen could not
    // represent "lane 4 shut between km 0.20 and km 0.40".
    const x1 = xPx(sim.interventions.closureEnd);
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
  // with both ends labelled as km-posts.
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
    const kmA = kmOf(draftStretch.from).toFixed(2);
    const kmB = kmOf(draftStretch.to).toFixed(2);
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
        if (v.lane !== lane || v.v >= SLOW) continue;
        const b = Math.min(bins - 1, Math.max(0, Math.floor(xPx(v.x) / binPx)));
        worst[b] = Math.min(worst[b], v.v);
      }
      const y = laneSlotTop(lane, roadTop, laneH, lanes, reverseLanes);
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
  const widScale = 1.7;

  /**
   * How large to draw a vehicle, as one factor applied to both axes.
   *
   * True scale first. Enlargement is a FLOOR for legibility, not a target: at
   * 600 m a car is already 14.6 px and needs no help, and treating the gap to
   * the vehicle ahead as something to fill produced 101 px cars sitting nose to
   * tail. Only when true scale falls below what the eye can resolve does the
   * sprite grow, and even then it is capped so it cannot overlap its neighbour
   * or outgrow its lane.
   */
  const MIN_LEN_PX = 10;
  const trueCarLen = 4.6 * mToPx;
  const perLane = Math.max(1, sim.vehicles.length / Math.max(1, lanes));
  const spacingPx = cssW / perLane;
  const drawnCarLen = Math.min(
    Math.max(trueCarLen, MIN_LEN_PX),
    Math.max(2, spacingPx * 0.9),
    laneH * 0.9,
  );
  const k = drawnCarLen / Math.max(0.01, trueCarLen);

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
      const cy = laneSlotTop(lane, roadTop, laneH, lanes, reverseLanes) + laneH / 2;
      ctx.fillStyle = "rgba(9,14,28,0.72)";
      roundRect(ctx, 5, cy - tagH / 2, tagW, tagH, 3);
      ctx.fill();
      const closed = sim.interventions.closedLanes[lane];
      ctx.fillStyle = closed ? "#fca5a5" : "rgba(255,255,255,0.6)";
      ctx.fillText(`L${lane + 1}`, 5 + tagW / 2, cy + 0.5);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  for (const v of sim.vehicles) {
    try {
      // One factor for every class, so a bus still reads as longer than a car.
      const len = Math.max(2, v.length * mToPx * k);
      const wid = Math.max(
        2,
        Math.min(laneH * 0.8, widthM[v.vClass] * mToPx * k * widScale),
      );
      // visualLane, not v.lane: the integer flips the instant MOBIL accepts
      // the move, which drew the change as a one-frame jump across a whole lane.
      const y = laneSlotTop(visualLane(v), roadTop, laneH, lanes, reverseLanes) + laneH * 0.5;
      // Braking, or already stopped. The threshold is a real lift-off rather
      // than any negative value, so brake lights do not flicker on the small
      // corrections every car-following model makes continuously.
      const braking = v.accel < -0.6 || v.v < 3;
      drawVehicle(ctx, xPx(v.x), y, len, wid, v.vClass, v.color, braking, sb);
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

  // incidents
  for (const inc of sim.interventions.incidents) {
    const y = laneSlotTop(inc.lane, roadTop, laneH, lanes, reverseLanes) + laneH * 0.5;
    // A scenario's obstacle is amber and triangular, so it cannot be mistaken for one the operator dropped.
    if (overlay && overlay.isScenarioIncident(inc)) {
      drawScenarioMarker(ctx, xPx(inc.x), y, Math.min(9, laneH * 0.36), false);
      continue;
    }
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

  // scenario events: a marker where each one is and a label with its phase and the time left in it
  if (overlay) {
    drawScenarioLabels(ctx, canvasMarks(overlay.events, roadOf(sim, overlay.frame), sim.time), {
      xPx,
      roadTop,
      laneH,
      roadH,
      cssW,
      r: Math.min(9, laneH * 0.36),
      lanes,
      reverseLanes,
    });
  }

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

    for (const ex of exits) {
      // Distance along travel; xPx mirrors it when southbound, so the km posts
      // stay put on screen and only the traffic changes direction.
      const x = xPx(sb ? (toKm - ex.km) * 1000 : (ex.km - fromKm) * 1000);
      if (x < -rampLen || x > cssW + rampLen) continue;

      const xEnd = x + fwd * rampLen;

      // The ramp surface: same asphalt as the mainline so it reads as road
      // rather than as an overlay, tapering as it leaves.
      ctx.fillStyle = "#20293a";
      ctx.beginPath();
      ctx.moveTo(x, edge);
      ctx.lineTo(xEnd, edge + out * rampDrop);
      ctx.lineTo(xEnd, edge + out * (rampDrop + rampThick));
      ctx.lineTo(x - fwd * rampThick * 1.6, edge);
      ctx.closePath();
      ctx.fill();

      // Gore: the painted wedge between mainline and ramp, which is what makes
      // a divergence legible at a glance.
      ctx.fillStyle = "rgba(226,232,240,0.30)";
      ctx.beginPath();
      ctx.moveTo(x, edge);
      ctx.lineTo(x + fwd * rampLen * 0.55, edge + out * rampDrop * 0.62);
      ctx.lineTo(x + fwd * rampLen * 0.22, edge);
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

      // A faint tick across the carriageway keeps the km post readable without
      // the old hard line dominating the road.
      ctx.strokeStyle = "rgba(125,211,252,0.28)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, roadTop);
      ctx.lineTo(x, roadTop + roadH);
      ctx.stroke();

      // Name tag, sitting on the ramp rather than over the traffic lanes.
      const label = `${ex.name} · Km ${ex.km}`;
      ctx.font = "600 11px system-ui";
      const w = ctx.measureText(label).width + 10;
      let left = fwd > 0 ? xEnd - w * 0.1 : xEnd - w * 0.9;
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
    const spanKm = Math.max(1e-6, toKm - fromKm);
    const step = kmTickStep(spanKm);
    const first = Math.ceil(fromKm / step) * step;
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
    const axisY = axisBelow ? roadTop + roadH + 5 : roadTop - 5;
    ctx.textAlign = "center";
    ctx.textBaseline = axisBelow ? "top" : "bottom";
    ctx.font = "10px system-ui";
    for (let km = first; km <= toKm + 1e-9; km += step) {
      const x = xPx(sb ? (toKm - km) * 1000 : (km - fromKm) * 1000);
      if (x < 2 || x > cssW - 2) continue;
      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, roadTop);
      ctx.lineTo(x, roadTop + roadH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillText(`${km.toFixed(step < 0.1 ? 2 : step < 1 ? 2 : 1)}`, x, axisY);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  ctx.font = "10px system-ui";
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillText(flowLabel, 8, roadTop + 4);

  // Where this stretch is on the corridor. Without it the canvas is 280 m of
  // anonymous tarmac and the route pickers appear to do nothing.
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "600 11px system-ui";
  ctx.textAlign = "right";
  ctx.fillText(location, cssW - 8, roadTop + 4);
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
) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

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
  const rampsAbove = marks.direction === "NB";
  const { rampGutter, laneH, roadH, roadTop } = roadLayout({
    cssW,
    cssH,
    lanes,
    segLenM: L,
    exitCount: exits.length,
    maxLaneH,
    rampsAbove,
  });
  const mToPx = cssW / L;
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
    exits,
    overlay,
    drawAxis: true,
    flowLabel: "▶ traffic flow",
    location,
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
) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (cssW <= 0 || cssH <= 0) return; // see render()'s identical guard for why

  const L = simNB.cfg.length; // both directions share the same segment length (SharedRoadInputs)
  const { rampGutter, laneH, nbRoadH, sbRoadH, nbRoadTop, medianTop, sbRoadTop, mToPx } = dualRoadLayout({
    cssW,
    cssH,
    lanesNB: simNB.cfg.laneCount,
    lanesSB: simSB.cfg.laneCount,
    segLenM: L,
    exitCount: exits.length,
    maxLaneH,
  });

  const xPxNB = (x: number) => x * mToPx; // NB: left to right, unmirrored
  const xPxSB = (x: number) => cssW - x * mToPx; // SB: right to left, mirrored
  const wPx = (m: number) => m * mToPx;

  drawMedian(ctx, cssW, medianTop, MEDIAN_GUTTER_PX);
  drawSharedKmAxis(ctx, { xPx: xPxNB, fromKm: marks.fromKm, toKm: marks.toKm, cssW, axisY: medianTop + MEDIAN_GUTTER_PX / 2 });

  drawCarriageway(ctx, simNB, {
    cssW,
    cssH,
    roadTop: nbRoadTop,
    laneH,
    roadH: nbRoadH,
    rampGutter,
    rampsAbove: true,
    reverseLanes: true, // NB sits above the median: its bottom edge is the median-adjacent one
    mToPx,
    sb: false,
    xPx: xPxNB,
    wPx,
    fromKm: marks.fromKm,
    toKm: marks.toKm,
    exits,
    overlay: overlayNB,
    drawAxis: false,
    flowLabel: "▶ traffic flow",
    location: "Northbound",
  });
  drawCarriageway(ctx, simSB, {
    cssW,
    cssH,
    roadTop: sbRoadTop,
    laneH,
    roadH: sbRoadH,
    rampGutter,
    rampsAbove: false,
    reverseLanes: false, // SB sits below the median: its top edge is already the median-adjacent one
    mToPx,
    sb: true,
    xPx: xPxSB,
    wPx,
    fromKm: marks.fromKm,
    toKm: marks.toKm,
    exits,
    overlay: overlaySB,
    drawAxis: false,
    flowLabel: "traffic flow ◀",
    location: "Southbound",
  });
}

/** The barrier between the two carriageways in Both mode — a solid stripe, not just empty space,
 *  so it reads as a physical median rather than a gap the layout happened to leave. */
function drawMedian(ctx: CanvasRenderingContext2D, cssW: number, medianTop: number, gutterH: number) {
  const barrierH = 6;
  const barrierY = medianTop + (gutterH - barrierH) / 2;
  ctx.fillStyle = "rgba(226,232,240,0.85)";
  roundRect(ctx, 0, barrierY, cssW, barrierH, 2);
  ctx.fill();
  ctx.fillStyle = "rgba(15,23,42,0.55)";
  ctx.fillRect(0, barrierY - 2, cssW, 1);
  ctx.fillRect(0, barrierY + barrierH + 1, cssW, 1);
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
  g: { xPx: (m: number) => number; fromKm: number; toKm: number; cssW: number; axisY: number },
) {
  const { xPx, fromKm, toKm, cssW, axisY } = g;
  const spanKm = Math.max(1e-6, toKm - fromKm);
  const step = kmTickStep(spanKm);
  const first = Math.ceil(fromKm / step) * step;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "600 10px system-ui";
  for (let km = first; km <= toKm + 1e-9; km += step) {
    const x = xPx((km - fromKm) * 1000);
    if (x < 2 || x > cssW - 2) continue;
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillText(`${km.toFixed(step < 0.1 ? 2 : step < 1 ? 2 : 1)}`, x, axisY);
  }
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
  color: string,
  /* Lit brake lights.
   *
   * This was `v.v < 3` — brake lights that only came on once a vehicle had
   * already nearly stopped, which is not what a brake light is for. The
   * simulation gives every driver a reaction lag precisely so that
   * stop-and-go waves form, and those waves are made of people braking at
   * speed. Lighting on deceleration instead makes them visible: a pulse of
   * red travelling backwards through otherwise free-flowing traffic, which is
   * the single clearest sign the model is doing something real. */
  braking: boolean,
  /** Southbound: the sprite is drawn mirrored so the nose leads. */
  faceLeft = false
) {
  const glass = "rgba(196,220,255,0.92)";
  const headlight = "#fff3b0";
  const brake = braking ? "#ff4d4d" : "#c62828";
  ctx.save();
  ctx.translate(xFront, yCenter);
  // Every part below is drawn behind the nose at negative x, so one flip turns
  // the whole vehicle around without touching any of that geometry.
  if (faceLeft) ctx.scale(-1, 1);

  // soft shadow
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  roundRect(ctx, -len, -wid / 2 + 2.5, len, wid, Math.min(5, wid / 2));
  ctx.fill();

  if (vClass === 3) {
    // ---- articulated semi: trailer (back) + cab (front) ----
    const cabLen = len * 0.3;
    const trailerLen = len * 0.62;
    const gap = len * 0.08;
    // trailer — light tint of this agent's own colour so the whole rig matches
    ctx.fillStyle = mixHex(color, "#ffffff", 0.6);
    roundRect(ctx, -len, -wid / 2, trailerLen, wid, 3);
    ctx.fill();
    ctx.strokeStyle = mixHex(color, "#0b1226", 0.25);
    ctx.lineWidth = 1;
    ctx.stroke();
    // cab
    ctx.fillStyle = color;
    roundRect(ctx, -cabLen, -wid / 2, cabLen, wid, 4);
    ctx.fill();
    // windshield across the cab front
    ctx.fillStyle = glass;
    roundRect(ctx, -cabLen * 0.42, -wid / 2 + 2, cabLen * 0.32, wid - 4, 1.5);
    ctx.fill();
    // coupling gap line
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.moveTo(-trailerLen + gap * 0.5, -wid / 2);
    ctx.lineTo(-trailerLen + gap * 0.5, wid / 2);
    ctx.stroke();
    // lights
    ctx.fillStyle = headlight;
    dot(ctx, -1.5, -wid / 2 + 2.5, 1.4);
    dot(ctx, -1.5, wid / 2 - 2.5, 1.4);
    ctx.fillStyle = brake;
    ctx.fillRect(-len, -wid / 2 + 1.5, 1.8, 2.4);
    ctx.fillRect(-len, wid / 2 - 3.9, 1.8, 2.4);
    ctx.restore();
    return;
  }

  // ---- car / bus body ----
  ctx.fillStyle = color;
  roundRect(ctx, -len, -wid / 2, len, wid, vClass === 1 ? Math.min(6, wid / 2) : 3);
  ctx.fill();

  // subtle roof highlight
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  roundRect(ctx, -len * 0.72, -wid / 2 + 1.5, len * 0.5, wid - 3, 2);
  ctx.fill();

  if (vClass === 1) {
    // windshield (front) + rear window
    ctx.fillStyle = glass;
    roundRect(ctx, -len * 0.34, -wid / 2 + 2, len * 0.2, wid - 4, 1.5);
    ctx.fill();
    roundRect(ctx, -len * 0.82, -wid / 2 + 2.5, len * 0.14, wid - 5, 1.5);
    ctx.fill();
  } else {
    // bus: front windshield + a run of side windows
    ctx.fillStyle = glass;
    roundRect(ctx, -len * 0.2, -wid / 2 + 2, len * 0.12, wid - 4, 1.5);
    ctx.fill();
    ctx.fillStyle = "rgba(196,220,255,0.6)";
    const n = 4;
    for (let i = 0; i < n; i++) {
      const wx = -len * 0.3 - i * (len * 0.13);
      roundRect(ctx, wx, -wid / 2 + 2.5, len * 0.08, wid - 5, 1);
      ctx.fill();
    }
  }

  // head / tail lights
  ctx.fillStyle = headlight;
  dot(ctx, -1.5, -wid / 2 + 2.5, 1.4);
  dot(ctx, -1.5, wid / 2 - 2.5, 1.4);
  ctx.fillStyle = brake;
  ctx.fillRect(-len, -wid / 2 + 1.5, 1.8, 2.4);
  ctx.fillRect(-len, wid / 2 - 3.9, 1.8, 2.4);

  ctx.restore();
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
