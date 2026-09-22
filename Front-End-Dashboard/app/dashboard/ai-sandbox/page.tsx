"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayExitName, useNlexExits, type NlexExit } from "../../../lib/nlex-exits";
import { lanesForSegment, laneSources } from "../../../lib/nlex-lanes";
import { Car } from "lucide-react";
import PageHeader from "../../../components/dashboard/PageHeader";
import ScenarioForecastPanel from "../../../components/dashboard/ScenarioForecastPanel";
import {
  TrafficSim, CLASS_META, mixHex, visualLane, replicate,
  type Metrics, type Interventions, type ReplicationResult, type RepStat,
} from "./simulation";
import {
  NO_OWNERS,
  addEvent,
  applyAtBoundary,
  canvasMarks,
  createEngineBinding,
  describeActiveEvents,
  describeBoundary,
  describeOwner,
  effectiveState,
  nextBoundaryAfter,
  ownershipKey,
  removeEvent,
  roadOf,
  scenarioLockedLanes,
  scenarioTimeS,
  stepToScenarioTime,
  type CanvasMark,
  type Incident,
  type ManualControls,
  type NewEventSpec,
  type Ownership,
  type Road,
  type RoadFrame,
  type ScenarioEvent,
} from "./scenarios/adapter";
import ScenarioPanel, { type SkipView } from "./components/ScenarioPanel";

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
  const simRef = useRef<TrafficSim | null>(null);
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

  /**
   * WHICH STRETCH of the corridor is being simulated, as km-posts.
   *
   * An operator asks "what happens between km 3.5 and km 6", not "show me a
   * representative 280 m". The simulation is parameterised on length, so it can
   * model whatever span is asked for; only the drawing has a practical ceiling
   * (see MAX_SEG_M). Previously this was a fixed 280 m of anonymous tarmac and
   * the route pickers changed nothing but the heading.
   */
  // Southbound when the journey runs down the km posts.
  const direction: "NB" | "SB" =
    (originExit?.km ?? 0) > (destExit?.km ?? 0) ? "SB" : "NB";
  const routeFromKm = Math.min(originExit?.km ?? 0, destExit?.km ?? 0);
  const routeToKm = Math.max(originExit?.km ?? 0, destExit?.km ?? 0);
  /* Which carriageway is being simulated — DERIVED from the route, never set
   * separately.
   *
   * The simulation models one carriageway: every vehicle enters at x = 0 and
   * travels toward increasing x. Nothing used to say which, and the route
   * picker quietly forbade the question by disabling any origin above the
   * destination, so every run was northbound whether or not that was intended.
   *
   * Direction is not an independent fact — it IS the relationship between where
   * the traffic starts and where it is going. NLEX runs Balintawak (Km 0, the
   * Manila end) north to Sta. Ines, so a route whose origin is the higher km
   * post is southbound. Deriving it means the two controls can never disagree;
   * a separate toggle could claim "Southbound" while the route still read
   * Balintawak -> Marilao. */
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

  const dirLabel = direction === "NB" ? "Northbound" : "Southbound";

  const locationLabel = nearestExit
    ? `${dirLabel} · Km ${fromKm.toFixed(2)}–${toKm.toFixed(2)} · ${(segLengthM / 1000).toFixed(2)} km · near ${displayExitName(nearestExit.exit_name)}`
    : `${dirLabel} · Km ${fromKm.toFixed(2)}–${toKm.toFixed(2)}`;

  // The render loop runs outside React, so these reach it through refs.
  const locationRef = useRef(locationLabel);
  locationRef.current = locationLabel;
  const marksRef = useRef({ fromKm, toKm, direction });
  marksRef.current = { fromKm, toKm, direction };
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

  const [laneCount, setLaneCount] = useState(4);

  const [inflow, setInflow] = useState(4500);
  // Which forecast day the inflow came from, when it came from one. Kept apart
  // from dataAnchor so the slider caption can never call a prediction an
  // observation.
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

  const [closedLanes, setClosedLanes] = useState<boolean[]>(Array(4).fill(false));
  const [speedLimit, setSpeedLimit] = useState<number | null>(null);
  const [incidentCount, setIncidentCount] = useState(0);
  /* Scenario events (see ./scenarios/adapter.ts). closedLanes, speedLimit and the
   * closure and zone positions below stay the OPERATOR's settings; what the engine
   * actually holds is composeInterventions(operator's settings, these events, sim
   * time), applied through the binding. incidentCount counts the operator's
   * incidents only. */
  const [scenarioEvents, setScenarioEvents] = useState<readonly ScenarioEvent[]>([]);
  const [owners, setOwners] = useState<Ownership>(NO_OWNERS);
  /* The live-apply effect runs on every render, so it must not call a state setter each time
   * even for an unchanged value: React counts passive effects that schedule an update, and
   * fifty in a row without a quiet one raises "Maximum update depth exceeded". Ownership is
   * published only when its key changes, tracked here. */
  const ownersKeyRef = useRef(ownershipKey(NO_OWNERS));
  const publishOwners = useCallback((next: Ownership) => {
    const key = ownershipKey(next);
    if (key === ownersKeyRef.current) return;
    ownersKeyRef.current = key;
    setOwners(next);
  }, []);
  const [scenarioBinding] = useState(createEngineBinding);
  /** A skip to the next phase in progress: what it skips through and where the engine has got to. */
  const [skip, setSkip] = useState<SkipView | null>(null);
  /** When (on the scenario clock) the animation loop next has to re-apply. -Infinity: at the next step. */
  const scenarioDueRef = useRef(-Infinity);
  const scenarioSeqRef = useRef(0);
  /** The stored events, kept in step with the state so two calls in one tick (a script, a double click) each see the other. */
  const scenarioEventsRef = useRef<readonly ScenarioEvent[]>([]);
  const skipRef = useRef<{ cancel: boolean } | null>(null);
  /**
   * What the animation loop applies. Written by the live-apply effect, so the loop
   * (which is not re-created when these change) always sees the latest.
   */
  const scenarioCtxRef = useRef<{ controls: ManualControls; events: readonly ScenarioEvent[]; frame: RoadFrame } | null>(null);
  /** What the canvas draws for scenario events: where each is, its phase, and which incidents in the engine are the scenarios'. */
  const scenarioOverlayRef = useRef<ScenarioOverlay | null>(null);
  /** Lanes a running scenario is blocking: shown closed, and the operator cannot reopen them. */
  const lockedLanes = scenarioLockedLanes(owners, laneCount);
  /**
   * Where on the corridor an intervention is applied, as km-posts.
   *
   * These were fixed fractions of the segment — a closure always began at 55%
   * of whatever span was on screen, and the speed zone always spanned 30-80%.
   * That is not a decision the simulation should be making: an operator closing
   * a lane knows which chainage it starts at, and moving the segment window
   * silently moved the closure with it. Null means "centre of the current
   * span", so the defaults behave as before until a position is chosen.
   */
  const [closureKm, setClosureKm] = useState<number | null>(null);
  const [closureEndKm, setClosureEndKm] = useState<number | null>(null);
  const [zoneFromKm, setZoneFromKm] = useState<number | null>(null);
  const [zoneToKm, setZoneToKm] = useState<number | null>(null);
  const [placingIncident, setPlacingIncident] = useState(false);
  const [placingClosure, setPlacingClosure] = useState(false);
  // First click of the two that mark a closed stretch, as a km-post. Null until
  // the start has been clicked.
  const [closureDraftKm, setClosureDraftKm] = useState<number | null>(null);

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

  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);


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
   * defaults, which is why this is optional rather than blocking. */
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

  /* ── Observed hourly demand ──────────────────────────────────────────────
   *
   * The 24-hour shape at the nearest interchange, measured, replacing a daily
   * mean multiplied by an assumed peaking factor of 1.6. At Balintawak NB the
   * real ratio is 1.89, and the class mix swings from 1.6% heavy at 06:00 to
   * 12.4% at 02:00 — freight at night, commuters at rush hour — which one
   * flat mix cannot represent at all. */
  type DemandHour = { hour: number; vehPerHour: number; mix: Record<1 | 2 | 3, number> };
  type DemandProfile = {
    exit: string; hours: DemandHour[]; peakHour: number; peakVehPerHour: number;
    meanVehPerHour: number; peakingFactor: number; days: number;
  };
  const [demand, setDemand] = useState<DemandProfile | null>(null);
  const [hourOfDay, setHourOfDay] = useState<number | null>(null);

  useEffect(() => {
    if (!nearestExit) return;
    const name = encodeURIComponent(String(nearestExit.exit_name));
    fetch(`${BACKEND}/api/ai-sandbox/demand-profile?exit=${name}&direction=${direction}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.success && j.data?.hours?.length) {
          setDemand(j.data);
          // Open at the busiest hour: the interesting question is what a
          // closure costs when it costs the most.
          setHourOfDay((cur) => (cur == null ? j.data.peakHour : cur));
        } else setDemand(null);
      })
      .catch(() => setDemand(null));
  }, [nearestExit, direction]);

  /** The hour currently being simulated, if observed demand is driving it. */
  const activeHour = useMemo(
    () => (demand && hourOfDay != null ? demand.hours.find((h) => h.hour === hourOfDay) ?? null : null),
    [demand, hourOfDay],
  );

  /* ── Mainline flow ───────────────────────────────────────────────────────
   *
   * Per-interchange entry and exit volumes, which the km table below turns
   * into the flow crossing any point:
   *
   *     mainline(x) = SUM(entries at km <= x) - SUM(exits at km <= x)   [NB]
   *
   * This replaces anchoring the inflow to the NEAREST plaza's own volume,
   * which was an on-ramp figure being used as a through-flow. Near Balintawak
   * (km 0, the gateway) the two are close and it looked fine; eight km north
   * at Meycauayan the plaza reads 211 veh/h against a mainline of roughly
   * 3,500, and the sandbox was simulating the slip road. */
  type PlazaFlow = { exit: string; entriesByHour: number[]; exitsByHour: number[] };
  const [plazaFlows, setPlazaFlows] = useState<PlazaFlow[] | null>(null);
  useEffect(() => {
    fetch(`${BACKEND}/api/ai-sandbox/plaza-flows?direction=${direction}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setPlazaFlows(j?.success ? j.data.plazas : null))
      .catch(() => setPlazaFlows(null));
  }, [direction]);

  /** Entry/exit volumes for one exit at one hour, or null if not recorded. */
  const flowAt = useCallback(
    (exitName: string, hour: number) => {
      if (!plazaFlows) return null;
      const key = String(exitName).toLowerCase().trim();
      const f =
        plazaFlows.find((x) => x.exit.toLowerCase().trim() === key) ??
        plazaFlows.find((x) => {
          const k = x.exit.toLowerCase().trim();
          return k.includes(key) || key.includes(k);
        });
      if (!f) return null;
      const h = Math.max(0, Math.min(23, hour));
      return { entries: f.entriesByHour[h] ?? 0, exits: f.exitsByHour[h] ?? 0 };
    },
    [plazaFlows],
  );

  /** Vehicles per hour crossing this km-post, in the direction of travel. */
  const mainlineAtKm = useCallback(
    (km: number, hour: number): number | null => {
      if (!plazaFlows || EXITS.length === 0) return null;
      let flow = 0;
      let sawAny = false;
      for (const e of EXITS) {
        // Upstream means lower km northbound, higher km southbound.
        const upstream = direction === "NB" ? e.km <= km + 1e-6 : e.km >= km - 1e-6;
        if (!upstream) continue;
        const f = flowAt(e.exit_name, hour);
        if (!f) continue;
        sawAny = true;
        flow += f.entries - f.exits;
      }
      return sawAny ? Math.max(0, Math.round(flow)) : null;
    },
    [plazaFlows, EXITS, direction, flowAt],
  );

  const [plazaVol, setPlazaVol] = useState<Record<string, number> | null>(null);
  const [volDays, setVolDays] = useState(365);
  useEffect(() => {
    fetch(`${BACKEND}/api/traffic/analytics?months=12&direction=${direction}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!j.success) return;
        const map: Record<string, number> = {};
        for (const row of j.data.byPlaza ?? []) map[String(row.plaza).toLowerCase()] = Number(row.v) || 0;
        setPlazaVol(map);
        setVolDays(Math.max(1, j.data.kpis?.days ?? 365));
      })
      .catch(() => {});
  }, [direction]);

  /* Peak-hour flow past the nearest junction, capped at what the lanes can
   * physically carry. PEAK_FACTOR turns a daily mean into a peak hour; the
   * ceiling is per-lane capacity, so the sandbox can never open already
   * gridlocked. */
  const dataAnchor = (() => {
    /* Preference order, best evidence first.
     *
     * 1. Mainline flow across the start of the segment, from the conservation
     *    count. This is the only one of the three that is actually the
     *    quantity being simulated.
     * 2. The nearest interchange's own hourly volume. Correct at Balintawak,
     *    increasingly wrong the further up the corridor it is used.
     * 3. A daily mean scaled by an assumed peaking factor. */
    const hr = hourOfDay ?? demand?.peakHour ?? 8;
    const ceiling = laneCount * 2200; // motorway capacity, per lane
    const entryKm = direction === "NB" ? fromKm : toKm;
    const mainline = mainlineAtKm(entryKm, hr);
    if (mainline != null && mainline > 0) {
      return Math.max(300, Math.min(ceiling, mainline));
    }
    if (activeHour) {
      return Math.max(300, Math.min(ceiling, activeHour.vehPerHour));
    }
    if (!plazaVol || !nearestExit) return null;
    const key = String(nearestExit.exit_name).toLowerCase();
    const total =
      plazaVol[key] ??
      Object.entries(plazaVol).find(([k]) => k.includes(key) || key.includes(k))?.[1];
    if (!total) return null;
    const peakHourly = Math.round((total / volDays / 24) * 1.6);
    // Shares the ceiling declared above; 2,200/lane matches the calibrated
    // capacity of ~2,267 veh/h/lane rather than the round 2,000 guessed before.
    return Math.max(600, Math.min(ceiling, peakHourly));
  })();

  /** One line saying where the inflow figure came from. */
  const inflowBasis = useMemo(() => {
    const hr = hourOfDay ?? demand?.peakHour ?? 8;
    const entryKm = direction === "NB" ? fromKm : toKm;
    const mainline = mainlineAtKm(entryKm, hr);
    if (mainline == null || mainline <= 0) {
      return activeHour
        ? `Inflow from the volume recorded at ${displayExitName(String(nearestExit?.exit_name ?? ""))} — an interchange figure, not a through-flow.`
        : null;
    }
    const feeders = EXITS.filter((e) =>
      direction === "NB" ? e.km <= entryKm + 1e-6 : e.km >= entryKm - 1e-6,
    ).filter((e) => {
      const f = flowAt(e.exit_name, hr);
      return f && (f.entries > 0 || f.exits > 0);
    });
    const names = feeders.slice(0, 3).map((e) => displayExitName(e.exit_name)).join(" + ");
    const more = feeders.length > 3 ? ` +${feeders.length - 3} more` : "";
    return `Mainline flow at Km ${entryKm.toFixed(2)}: ${mainline.toLocaleString()} veh/h — entries minus exits upstream (${names}${more}).`;
  }, [hourOfDay, demand, direction, fromKm, toKm, mainlineAtKm, EXITS, flowAt, activeHour, nearestExit]);

  // Re-anchor when the route, direction or lane count changes — each of those
  // changes what "normal traffic here" means.
  useEffect(() => {
    if (dataAnchor != null) setInflow(dataAnchor);
  }, [dataAnchor]);

  /* The class profile actually handed to the simulation: warehouse CO2
   * factors always, and the fleet mix from the selected HOUR when one is
   * available, falling back to the all-hours average. An 02:00 closure meets
   * 12.4% heavy vehicles and an 06:00 one meets 1.6%; the emissions and the
   * merging behaviour differ accordingly, and a single average hides both. */
  const effectiveClassProfile = useMemo(() => {
    if (!classProfile && !activeHour) return undefined;
    const out: Partial<Record<1 | 2 | 3, { co2PerM?: number; share?: number }>> = {};
    for (const k of [1, 2, 3] as const) {
      const co2PerM = classProfile?.[k]?.co2PerM;
      const share = activeHour ? activeHour.mix[k] : classProfile?.[k]?.share;
      if (co2PerM != null || share != null) out[k] = { co2PerM, share };
    }
    return Object.keys(out).length ? out : undefined;
  }, [classProfile, activeHour]);

  const buildInterventions = useCallback(
    (lanes: number, len: number): Partial<Interventions> => ({
      closedLanes: Array(lanes).fill(false),
      closurePoint: len * 0.55,
      closureEnd: len,
      incidents: [],
      speedLimitKmh: null,
      speedZone: [len * 0.3, len * 0.8],
    }),
    []
  );

  /* Interchanges inside the simulated stretch, as on- and off-ramps.
   *
   * Volumes come from the same measured per-plaza figures as the mainline
   * inflow, scaled to the selected hour. One assumption is unavoidable and is
   * stated rather than buried: the warehouse records a plaza's total volume,
   * not a split between traffic joining and traffic leaving, so it is halved
   * between the two. If an entry/exit split is ever recorded, this is the one
   * line to change.
   *
   * Access is per direction and comes from the data: an interchange with no
   * northbound entry contributes no on-ramp to a northbound run, which is why
   * nb_entry / sb_exit and friends are read rather than assumed symmetric. */
  const ramps = useMemo(() => {
    if (!originExit || !destExit) return [];
    const lo = Math.min(originExit.km, destExit.km);
    const hi = Math.max(originExit.km, destExit.km);
    const nb = direction === "NB";
    const hr = hourOfDay ?? demand?.peakHour ?? 8;
    const shape =
      activeHour && demand && demand.meanVehPerHour > 0
        ? activeHour.vehPerHour / demand.meanVehPerHour
        : 1;
    const out: { x: number; onVehPerHour: number; offFraction: number; name: string }[] = [];
    for (const e of EXITS) {
      // Strictly inside: the endpoints are where the simulated road starts and
      // stops, not junctions traffic passes through.
      if (e.km <= lo + 0.02 || e.km >= hi - 0.02) continue;
      const canJoin = nb ? e.nb_entry : e.sb_entry;
      const canLeave = nb ? e.nb_exit : e.sb_exit;
      if (!canJoin && !canLeave) continue;

      /* Measured entries and exits, not a plaza total split down the middle.
       *
       * The halving was a stated assumption standing in for data that turns
       * out to exist: role = Entry/Exit separates the two, so a junction that
       * only takes traffic on now contributes only an on-ramp. */
      const f = flowAt(e.exit_name, hr);
      let on = 0;
      let off = 0;
      if (f) {
        on = canJoin ? f.entries : 0;
        off = canLeave ? f.exits : 0;
      } else {
        // Fallback for a junction with no transaction data: the old daily-mean
        // estimate, halved between the two movements as before.
        const key = String(e.exit_name).toLowerCase();
        const total =
          plazaVol?.[key] ??
          Object.entries(plazaVol ?? {}).find(([k]) => k.includes(key) || key.includes(k))?.[1];
        if (!total) continue;
        const hourly = (total / volDays / 24) * shape;
        on = canJoin ? hourly / 2 : 0;
        off = canLeave ? hourly / 2 : 0;
      }
      if (on <= 0 && off <= 0) continue;

      // The share leaving is measured against the flow actually reaching this
      // junction, not against the flow that entered the segment.
      const passing = mainlineAtKm(e.km, hr) ?? inflow;
      out.push({
        x: nb ? (e.km - fromKm) * 1000 : (toKm - e.km) * 1000,
        onVehPerHour: Math.round(on),
        // Capped: a junction taking more than a third of the mainline would be
        // the end of the corridor, not a ramp on it.
        offFraction: Math.max(0, Math.min(0.35, off / Math.max(1, passing))),
        name: displayExitName(e.exit_name),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originExit, destExit, EXITS, plazaVol, volDays, activeHour, demand, inflow,
      direction, fromKm, toKm, hourOfDay, flowAt, mainlineAtKm]);


  // (Re)create the sim when structural config changes.
  const rebuild = useCallback(() => {
    simRef.current = new TrafficSim(
      {
        length: segLengthM,
        laneCount,
        inflowVehPerHour: inflow,
        seed: 12345,
        classProfile: effectiveClassProfile,
        ramps,
        warmupS: WARMUP_S,
      },
      buildInterventions(laneCount, segLengthM)
    );
    setClosedLanes(Array(laneCount).fill(false));
    setSpeedLimit(null);
    setIncidentCount(0);
    setBaseline(null);
    /* Sim time is back at 0, so scenario events start over from the new warm-up.
     * The events themselves are kept as stored (durations are never re-drawn); the
     * binding forgets the old engine's incidents, a fast-forward aimed at the old
     * engine is cancelled, and the next step re-applies. */
    scenarioBinding.reset();
    scenarioDueRef.current = -Infinity;
    if (skipRef.current) skipRef.current.cancel = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // classProfile included so the run restarts once the warehouse values
    // land — otherwise the first simulation would keep emitting at the
    // bundled defaults for its whole life.
  }, [laneCount, segLengthM, buildInterventions, effectiveClassProfile, ramps, scenarioBinding]);

  useEffect(() => {
    rebuild();
  }, [rebuild]);

  // Live-apply inflow without discarding the running sim.
  useEffect(() => {
    if (simRef.current) simRef.current.cfg.inflowVehPerHour = inflow;
  }, [inflow]);

  // Positions in metres from the start of the simulated span, which is what the
  // simulation works in. Clamped so a position left over from a previous
  // segment cannot sit outside the current one.
  const clampKm = (km: number) => Math.min(Math.max(km, fromKm), toKm);
  /* The only place direction enters the maths. Metres are always measured
   * along the direction of travel from the entry point, which is the low km
   * post northbound and the high one southbound. */
  const kmAt = (m: number) => (direction === "NB" ? fromKm + m / 1000 : toKm - m / 1000);
  const mAt = (km: number) => (direction === "NB" ? (km - fromKm) * 1000 : (toKm - km) * 1000);
  const spanM = (toKm - fromKm) * 1000;
  const closureAtKm = clampKm(closureKm ?? kmAt(spanM * 0.55));
  const zoneA = clampKm(zoneFromKm ?? kmAt(spanM * 0.3));
  const zoneB = clampKm(zoneToKm ?? kmAt(spanM * 0.8));
  // A closure occupies a stretch. Null end means "to the end of the span",
  // which is what it always used to do implicitly.
  const closureEndAtKm = clampKm(Math.max(closureEndKm ?? toKm, closureAtKm + 0.01));
  // Ordered along travel: southbound the "start" km is the higher number, so a
  // raw subtraction would give a negative offset and an inverted stretch.
  const closureM = Math.min(mAt(closureAtKm), mAt(closureEndAtKm));
  const closureEndM = Math.max(mAt(closureAtKm), mAt(closureEndAtKm));
  // Likewise the speed zone: the operator's, or a shoulder breakdown's while it owns it.
  const shownSpeedLimit = owners.speedZone ? owners.speedZone.limitKmh : speedLimit;
  const shownZoneFromKm = owners.speedZone ? Math.min(kmAt(owners.speedZone.zone[0]), kmAt(owners.speedZone.zone[1])) : zoneA;
  const shownZoneToKm = owners.speedZone ? Math.max(kmAt(owners.speedZone.zone[0]), kmAt(owners.speedZone.zone[1])) : zoneB;
  // The stretch the controls show: the operator's own, or, while a scenario owns it, the scenario's (locked).
  const shownClosureFromKm = owners.closure ? Math.min(kmAt(owners.closure.closurePointM), kmAt(owners.closure.closureEndM)) : closureAtKm;
  const shownClosureToKm = owners.closure ? Math.max(kmAt(owners.closure.closurePointM), kmAt(owners.closure.closureEndM)) : closureEndAtKm;

  // Typed ends always keep the value the operator typed. The previous clamp
  // (end = max(end, start + 0.01)) silently discarded a "To" below the current
  // start — typing Km 0.30 while the start sat at the default 0.33 did nothing.
  // Now the OTHER end moves out of the way instead.
  const commitClosureStart = (km: number) => {
    const a = clampKm(km);
    setClosureKm(a);
    if (a >= closureEndAtKm) setClosureEndKm(clampKm(a + 0.1));
  };
  const commitClosureEnd = (km: number) => {
    const b = clampKm(km);
    if (b <= closureAtKm) setClosureKm(clampKm(b - 0.1));
    setClosureEndKm(b);
  };
  const zoneM: [number, number] = [
    Math.min(mAt(zoneA), mAt(zoneB)),
    Math.max(mAt(zoneA), mAt(zoneB)),
  ];

  /* What the operator has set by hand, and how km-posts map to metres on this
   * stretch: the two things the scenario adapter needs from the page. */
  const manualControls: ManualControls = {
    closedLanes,
    closurePoint: closureM,
    closureEnd: closureEndM,
    showClosurePreview: closureKm != null || closureEndKm != null || placingClosure,
    speedLimitKmh: speedLimit,
    speedZone: zoneM,
  };
  const scenarioFrame: RoadFrame = { warmupS: WARMUP_S, metresAt: mAt };
  const scenarioRoad: Road = { laneCount, segmentLengthM: segLengthM, ...scenarioFrame };
  // Seconds since the end of warm-up, as of the last metrics refresh (a few times a second), for the events list.
  const scenarioNowS = scenarioTimeS(metrics?.elapsedS ?? 0, scenarioFrame);
  /* What is actually on the road: the operator's settings with any running scenario laid over
   * them. The readouts below (recommendation, before/after, baseline, the assistant's context)
   * read THIS, not the operator's settings alone. */
  const eff = effectiveState({ closedLanes, speedLimitKmh: speedLimit }, owners, scenarioEvents, scenarioNowS, laneCount);
  const effIncidentCount = incidentCount + eff.scenarioIncidents;
  const activeScenarioText = describeActiveEvents(eff.active);

  /* ── Confidence run ──────────────────────────────────────────────────────
   *
   * The animation is one seed. Any number an operator is going to act on
   * needs to say how much of it is the intervention and how much is this
   * particular set of drivers, so the same scenario is re-run on independent
   * seeds and reported as a mean with a 95% interval.
   *
   * Driven through the generator rather than called outright: ten runs is
   * tens of millions of integration steps and would lock the tab solid. The
   * pump below yields to the browser between simulated seconds. */
  const [repRuns, setRepRuns] = useState(10);
  const [repResult, setRepResult] = useState<ReplicationResult | null>(null);
  const [repProgress, setRepProgress] = useState<number | null>(null);
  const repCancel = useRef(false);

  const runReplications = useCallback(() => {
    // replicate() runs static interventions and cannot follow a timed event.
    if (scenarioEvents.length > 0) return;
    if (repProgress != null) { repCancel.current = true; return; }
    repCancel.current = false;
    setRepResult(null);
    setRepProgress(0);
    const gen = replicate(
      {
        length: segLengthM,
        laneCount,
        inflowVehPerHour: inflow,
        classProfile: effectiveClassProfile,
        ramps,
        warmupS: WARMUP_S,
      },
      // The interventions AS CURRENTLY SET, not a clean road: the operator is
      // asking about the scenario in front of them.
      {
        closedLanes: [...closedLanes],
        closurePoint: closureM,
        closureEnd: closureEndM,
        incidents: simRef.current ? [...simRef.current.interventions.incidents] : [],
        speedLimitKmh: speedLimit,
        speedZone: zoneM,
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
  }, [
    repProgress, repRuns, segLengthM, laneCount, inflow, effectiveClassProfile, ramps,
    closedLanes, closureM, closureEndM, speedLimit, zoneM, scenarioEvents,
  ]);


  /* Live-apply interventions.
   *
   * This used to copy the operator's state straight onto the engine. It now goes
   * through the scenario adapter, which lays any running scenario event over that
   * state (composeInterventions) and applies the result. The animation loop below
   * goes through the same call when a phase boundary is crossed, so neither path
   * can overwrite the other. Runs whenever the operator's settings or the events
   * change. */
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    scenarioCtxRef.current = { controls: manualControls, events: scenarioEvents, frame: scenarioFrame };
    scenarioOverlayRef.current = { events: scenarioEvents, frame: scenarioFrame, isScenarioIncident: scenarioBinding.isScenarioIncident };
    const { owners: next } = scenarioBinding.apply(sim, manualControls, scenarioEvents, scenarioFrame);
    const now = scenarioTimeS(sim.time, scenarioFrame);
    const due = nextBoundaryAfter(scenarioEvents, roadOf(sim, scenarioFrame), now);
    scenarioDueRef.current = due === null ? Infinity : due;
    publishOwners(next);
    // manualControls and scenarioFrame are rebuilt from the values listed on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedLanes, speedLimit, closureM, closureEndM, zoneM, closureKm, closureEndKm, placingClosure, scenarioEvents, direction, fromKm, toKm, scenarioBinding, publishOwners]);

  // Animation + physics loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);
      const sim = simRef.current;
      if (!sim) return;
      const dtReal = Math.min(0.1, (now - (lastFrameRef.current || now)) / 1000);
      lastFrameRef.current = now;

      // While a "skip to next phase" is fast-forwarding the engine it is the only thing stepping it.
      if (running && skipRef.current === null) {
        // advance sim time = real time × simSpeed, in fixed steps for stability.
        // A persistent accumulator carries the sub-timestep remainder between
        // frames, so slow (1×) speeds still integrate correctly.
        simAccRef.current += dtReal * simSpeed;
        let guard = 0;
        // Guard scales with the step size so the catch-up window stays ~3 s of
        // simulated time rather than shrinking when SIM_DT does.
        while (simAccRef.current >= SIM_DT && guard < 3 / SIM_DT) {
          sim.step(SIM_DT);
          // Scenario events: re-apply when a phase boundary has just been crossed.
          const ctx = scenarioCtxRef.current;
          if (ctx) {
            const r = applyAtBoundary(scenarioBinding, sim, ctx.controls, ctx.events, ctx.frame, scenarioDueRef.current);
            scenarioDueRef.current = r.dueS;
            if (r.composition !== null) publishOwners(r.composition.owners);
          }
          simAccRef.current -= SIM_DT;
          guard++;
        }
        if (guard >= 60) simAccRef.current = 0; // don't spiral if a frame stalls
        metricAccRef.current += dtReal;
        if (metricAccRef.current >= 0.25) {
          metricAccRef.current = 0;
          setMetrics(sim.metrics());
        }
      }
      render(ctx, canvas, sim, locationRef.current, marksRef.current, maxLaneRef.current, exitsRef.current, scenarioOverlayRef.current);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, simSpeed, scenarioBinding, publishOwners]);

  // Incident placement: arm "placing" mode, then let the user click the
  // simulation to choose exactly where (which lane / how far along) the
  // incident is dropped. One accident per click — re-arm to drop another.
  const togglePlacing = () => setPlacingIncident((p) => !p);

  const placeIncidentAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!placingIncident && !placingClosure) return;
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas || !sim) return;

    // Invert the same geometry the renderer uses to map the click back to
    // (lane, x-in-metres). Keep these formulas in sync with render().
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const L = sim.cfg.length;
    const lanes = sim.cfg.laneCount;
    const pad = CANVAS_PAD;
    // Same geometry render() used for this frame, or a click maps to a
    // different lane than the one under the cursor. The ramp gutter is part of
    // that geometry: reserving it moves the road up, and a handler that did not
    // know would place incidents one lane low wherever a junction is in view.
    // roadTop comes from the shared helper too, so there is no copy of the
    // vertical placement left to drift out of step with the renderer.
    const { laneH, roadTop } = roadLayout({
      cssW: rect.width,
      cssH,
      lanes,
      segLenM: L,
      exitCount: exitsRef.current.length,
      maxLaneH: maxLaneRef.current,
      rampsAbove: direction === "NB",
    });

    const lane = Math.max(0, Math.min(lanes - 1, Math.floor((cy - roadTop) / laneH)));
    const alongFrac = direction === "SB" ? 1 - cx / cssW : cx / cssW;
    const x = Math.max(0, Math.min(L, alongFrac * L));
    if (placingClosure) {
      // Two clicks mark the stretch an operator actually closes — "Km 0.20 to
      // 0.30" — in either order. One click used to move only the start, so the
      // works always ran on to the end of the span.
      const km = Number(kmAt(x).toFixed(2));
      if (closureDraftKm == null) {
        setClosureDraftKm(km);
        sim.interventions.closureDraft = { from: x, to: x };
        return;
      }
      const a = Math.min(closureDraftKm, km);
      const b = Math.max(Math.max(closureDraftKm, km), Math.min(toKm, a + 0.01));
      setClosureKm(a);
      setClosureEndKm(b);
      setPlacingClosure(false);
      return;
    }
    sim.addIncident(lane, x);
    setIncidentCount(scenarioBinding.operatorIncidents(sim).length);
    setPlacingIncident(false); // one accident per click; re-arm to drop another
  };

  // Follow the cursor after the first click so the stretch is seen before it is set.
  const previewClosureAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const sim = simRef.current;
    const canvas = canvasRef.current;
    if (!sim || !canvas || !placingClosure || closureDraftKm == null) return;
    const rect = canvas.getBoundingClientRect();
    const L = sim.cfg.length;
    const frac = (e.clientX - rect.left) / rect.width;
    const x = Math.max(0, Math.min(L, (direction === "SB" ? 1 - frac : frac) * L));
    const startM = mAt(closureDraftKm);
    sim.interventions.closureDraft = { from: Math.min(startM, x), to: Math.max(startM, x) };
  };

  // Leaving placing mode, by any route, discards a half-drawn stretch.
  useEffect(() => {
    if (placingClosure) return;
    setClosureDraftKm(null);
    if (simRef.current) simRef.current.interventions.closureDraft = null;
  }, [placingClosure]);

  // Esc leaves either placing mode.
  useEffect(() => {
    if (!placingIncident && !placingClosure) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPlacingIncident(false);
        setPlacingClosure(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placingIncident, placingClosure]);

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
            laneCount,
            segmentLengthM: segLengthM,
            // The model reasons in 1-indexed lane numbers, the sim in 0-indexed
            // array positions. Convert on the way out and back again in
            // applyPlan() so the two never mix.
            // What is actually on the road (operator + running scenario), in the existing fields.
            closedLanes: eff.closedLanes.map((c, i) => (c ? i + 1 : 0)).filter(Boolean),
            speedLimitKmh: eff.speedLimitKmh,
            incidentCount: effIncidentCount,
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
  // is the last thing between model output and sim state.
  const applyPlan = () => {
    const sim = simRef.current;
    if (!plan || !sim) return;
    const applied: string[] = [];

    // Changing the lane count rebuilds the simulation, and rebuild() resets
    // closures, the speed limit and incidents. Applying a closure in the same
    // batch would therefore be silently undone a tick later, so a plan that
    // resizes the road applies only that and says the rest was dropped.
    const resize = plan.actions.find((a) => a.type === "set_lane_count");
    if (resize && resize.type === "set_lane_count") {
      setLaneCount(resize.lanes);
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
          const idx = a.lanes.map((n) => n - 1).filter((i) => i >= 0 && i < laneCount);
          const held = shut ? [] : idx.filter((i) => lockedLanes[i]);
          if (held.length > 0 && owners.closure) {
            notApplied.push(`Lane ${held.map((i) => i + 1).join(", ")} stays closed (driven by ${describeOwner(owners.closure)})`);
          }
          const free = idx.filter((i) => !held.includes(i));
          if (free.length === 0) break;
          setClosedLanes((prev) => prev.map((c, i) => (free.includes(i) ? shut : c)));
          applied.push(`${shut ? "Closed" : "Opened"} lane ${free.map((i) => i + 1).join(", ")}`);
          break;
        }
        case "set_speed_limit":
          if (owners.speedZone) {
            notApplied.push(`The speed zone is driven by ${describeOwner(owners.speedZone)}`);
            break;
          }
          setSpeedLimit(a.kmh);
          applied.push(a.kmh == null ? "Removed the speed limit" : `Speed limit ${a.kmh} km/h`);
          break;
        case "add_incident": {
          const x = (a.positionPct / 100) * segLengthM;
          sim.addIncident(a.lane - 1, x);
          setIncidentCount(scenarioBinding.operatorIncidents(sim).length);
          applied.push(`Incident in lane ${a.lane}`);
          break;
        }
        case "clear_incidents":
          // Only the operator's: a running scenario's obstacle stays until its event ends.
          scenarioBinding.clearOperatorIncidents(sim);
          setIncidentCount(0);
          applied.push("Cleared incidents");
          break;
        case "set_inflow":
          setInflow(a.vehPerHour);
          applied.push(`Inflow ${fmt(a.vehPerHour)} veh/h`);
          break;
        case "set_lane_count":
          setLaneCount(a.lanes);
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
  const clearIncidents = () => {
    const sim = simRef.current;
    if (!sim) return;
    // The operator's incidents only: an in-lane breakdown event removes its own when it ends.
    scenarioBinding.clearOperatorIncidents(sim);
    setIncidentCount(0);
  };

  // A lane a scenario event is blocking cannot be reopened; any other lane can be closed or opened as before.
  const toggleLane = (i: number) => {
    if (lockedLanes[i]) return;
    setClosedLanes((prev) => prev.map((c, idx) => (idx === i ? !c : c)));
  };

  /* ── Scenario events ─────────────────────────────────────────────────────
   * Adding stores the event with its duration already drawn; it is refused,
   * with a message naming what it collides with, if it cannot run or needs a
   * lever another event holds at an overlapping time. */
  const addScenarioEvent = (spec: NewEventSpec): { ok: true; event: ScenarioEvent } | { ok: false; reason: string } => {
    const sim = simRef.current;
    if (!sim) return { ok: false, reason: "The simulation has not started yet." };
    const seq = scenarioSeqRef.current + 1;
    // The operator's own closure matters here: an event that needs the closure stretch is refused while they have one elsewhere.
    const r = addEvent(scenarioEventsRef.current, spec, roadOf(sim, scenarioFrame), seq, { closedLanes, closurePoint: closureM, closureEnd: closureEndM });
    if (!r.ok) return r;
    scenarioSeqRef.current = seq;
    scenarioEventsRef.current = r.events;
    setScenarioEvents(r.events);
    return { ok: true, event: r.event };
  };
  const removeScenarioEvent = (id: string) => {
    scenarioEventsRef.current = removeEvent(scenarioEventsRef.current, id);
    setScenarioEvents(scenarioEventsRef.current);
  };

  /* Skip to the next phase boundary of any scenario event. The engine is stepped
   * without rendering, in ~25 ms slices so the page stays responsive, and the
   * metrics are refreshed once at the end. The panel shows the simulated minutes
   * done and left and a Cancel (cancelSkip); a rebuild stops it too. */
  const cancelSkip = () => {
    if (skipRef.current) skipRef.current.cancel = true;
  };
  const skipToNextPhase = () => {
    const sim = simRef.current;
    if (!sim) return;
    if (skipRef.current) return;
    const road = roadOf(sim, scenarioFrame);
    const from = scenarioTimeS(sim.time, road);
    const target = nextBoundaryAfter(scenarioEventsRef.current, road, from);
    if (target === null) return;
    const token = { cancel: false };
    skipRef.current = token;
    const what = describeBoundary(scenarioEventsRef.current, road, target, from);
    setSkip({ label: what ? what.label : "the next phase", intervalStartS: what ? what.intervalStartS : from, targetS: target, nowS: from });
    const finish = () => {
      skipRef.current = null;
      setSkip(null);
      simAccRef.current = 0;
    };
    const pump = () => {
      if (token.cancel || simRef.current !== sim) {
        finish();
        return;
      }
      const r = stepToScenarioTime(sim, scenarioFrame, target, SIM_DT, 25, () => performance.now());
      if (!r.reached) {
        const now = scenarioTimeS(sim.time, scenarioFrame);
        setSkip((cur) => (cur ? { ...cur, nowS: now } : cur));
        setTimeout(pump, 0);
        return;
      }
      // On the boundary: apply the new phase (with whatever the operator has set by now), then show the result.
      const ctx = scenarioCtxRef.current;
      if (ctx) {
        const applied = applyAtBoundary(scenarioBinding, sim, ctx.controls, ctx.events, ctx.frame, -Infinity);
        scenarioDueRef.current = applied.dueS;
        publishOwners(applied.composition ? applied.composition.owners : NO_OWNERS);
      }
      setMetrics(sim.metrics());
      finish();
    };
    setTimeout(pump, 0);
  };

  const captureBaseline = () => {
    if (!metrics) return;
    const closed = eff.closedLanes
      .map((c, i) => (c ? `L${i + 1}` : null))
      .filter(Boolean)
      .join(", ");
    setBaseline({
      avgSpeedKmh: metrics.avgSpeedKmh,
      throughputPerMin: metrics.throughputPerMin,
      longestQueueM: metrics.longestQueueM,
      co2RatePerMin: metrics.co2RatePerMin,
      avgTravelTimeS: metrics.avgTravelTimeS,
      takenWith:
        [
          closed ? `${closed} closed` : null,
          eff.speedLimitKmh != null ? `${eff.speedLimitKmh} km/h zone` : null,
          effIncidentCount > 0 ? `${effIncidentCount} incident${effIncidentCount === 1 ? "" : "s"}` : null,
          // The scenario events running when it was taken, and the phase each was in.
          ...activeScenarioText,
        ]
          .filter(Boolean)
          .join(" · ") || "a clear road",
    });
  };

  /* What each folded section reports. These must read as the state itself, not
   * as a label — "L1 closed, Km 0.27-0.60" is the reason folding is safe. */
  const closedLaneList = eff.closedLanes
    .map((c, i) => (c ? `L${i + 1}` : null))
    .filter(Boolean)
    .join(", ");
  const interventionSummary =
    [
      closedLaneList ? `${closedLaneList} closed` : null,
      closedLaneList ? `Km ${shownClosureFromKm.toFixed(2)}–${shownClosureToKm.toFixed(2)}` : null,
      effIncidentCount > 0 ? `${effIncidentCount} incident${effIncidentCount === 1 ? "" : "s"}` : null,
      eff.speedLimitKmh != null ? `${eff.speedLimitKmh} km/h zone` : null,
      ...activeScenarioText,
    ]
      .filter(Boolean)
      .join(" · ") || "none applied";
  const anyIntervention = eff.closedLanes.some(Boolean) || eff.speedLimitKmh != null || effIncidentCount > 0;

  /* Baseline capture is a three-step procedure and the panel now says so.
   * Throughput is counted over the run so far, so a snapshot taken seconds
   * after a rebuild records a near-zero flow — the road has not filled and
   * nobody has finished the segment yet — and every later comparison then
   * reads as a miracle. Hence the settling step, which is the one an operator
   * would never guess at. */
  const elapsedS = metrics?.elapsedS ?? 0;
  const warmedUp = elapsedS >= WARMUP_S;
  const stepDone = [warmedUp, baseline != null, baseline != null && anyIntervention];
  const activeStep = stepDone.findIndex((d) => !d) + 1; // 0 once all are done
  const stepCls = (n: number) =>
    `sandbox-step${stepDone[n - 1] ? " is-done" : activeStep === n ? " is-now" : ""}`;
  const recommendation = getRecommendation(metrics, baseline, [...eff.closedLanes], effIncidentCount, eff.speedLimitKmh);

  // How wide the selected stretch of road actually is. Null when the corridor
  // lane table does not cover it — see lib/nlex-lanes.ts, which is deliberately
  // unpopulated until someone can cite a source for the real configuration.
  const segmentLanes =
    originExit && destExit ? lanesForSegment(originExit.km, destExit.km) : null;
  const laneProvenance =
    originExit && destExit ? laneSources(originExit.km, destExit.km) : [];
  const laneOverridden = segmentLanes != null && laneCount !== segmentLanes;

  // Following the road means the simulation rebuilds when the route changes, so
  // a closure is always modelled against the right number of lanes rather than
  // whatever the slider was last left on.
  useEffect(() => {
    if (segmentLanes != null) setLaneCount(segmentLanes);
  }, [segmentLanes]);


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
          setInflow(v);
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

      <div className="sandbox-metric-row">
        <MetricTile label="Active agents" value={metrics ? fmt(metrics.activeAgents) : "…"} />
        <MetricTile
          label="Avg speed"
          value={metrics ? `${fmt(metrics.avgSpeedKmh)} km/h` : "…"}
          delta={baseline && metrics ? pctDelta(metrics.avgSpeedKmh, baseline.avgSpeedKmh) : null}
          goodWhenUp
        />
        <MetricTile
          label="Throughput"
          value={metrics ? `${fmt(metrics.throughputPerMin)}/min` : "…"}
          delta={baseline && metrics ? pctDelta(metrics.throughputPerMin, baseline.throughputPerMin) : null}
          goodWhenUp
        />
        <MetricTile
          label="Longest queue"
          value={metrics ? `${fmt(metrics.longestQueueM)} m` : "…"}
          delta={baseline && metrics ? pctDelta(metrics.longestQueueM, baseline.longestQueueM) : null}
        />
        <MetricTile
          label="CO₂ rate"
          value={metrics ? `${fmt(metrics.co2RatePerMin, 1)} kg/min` : "…"}
          delta={baseline && metrics ? pctDelta(metrics.co2RatePerMin, baseline.co2RatePerMin) : null}
        />
        <MetricTile label="Density" value={metrics ? `${fmt(metrics.densityPerKmLane)}/km/ln` : "…"} />
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
              <button className="btn-muted" onClick={rebuild}>
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

          {/* Full screen hides the controls panel, so the road could be studied
              but not acted on — an operator had to leave the view to place the
              closure they were looking at. The controls that matter while
              watching the road come with it. */}
          {expanded && (
            <div className="sandbox-fs-bar">
              <span className="k">Close lane</span>
              <div className="sandbox-lane-toggles">
                {Array.from({ length: laneCount }, (_, i) => (
                  <button
                    key={i}
                    className={closedLanes[i] || lockedLanes[i] ? "closed" : ""}
                    onClick={() => toggleLane(i)}
                    disabled={lockedLanes[i]}
                    title={lockedLanes[i] && owners.closure ? `Driven by: ${describeOwner(owners.closure)}` : undefined}
                  >
                    L{i + 1}
                  </button>
                ))}
              </div>

              <span className="k">Closed Km</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 84 }}>
                  <KmInput value={shownClosureFromKm} min={fromKm} max={toKm} onCommit={commitClosureStart} disabled={owners.closure !== null} />
                </div>
                <span className="k" style={{ opacity: 0.7 }}>to</span>
                <div style={{ width: 84 }}>
                  <KmInput
                    value={shownClosureToKm}
                    min={fromKm}
                    max={toKm}
                    onCommit={commitClosureEnd}
                    disabled={owners.closure !== null}
                  />
                </div>
                <span className="k" style={{ opacity: 0.7 }}>
                  {Math.round((shownClosureToKm - shownClosureFromKm) * 1000)} m
                </span>
              </div>
              {owners.closure && (
                <span className="k" style={{ opacity: 0.85 }}>Driven by: {describeOwner(owners.closure)}</span>
              )}

              <button
                className={`btn-muted ${placingClosure ? "active" : ""}`}
                disabled={owners.closure !== null}
                onClick={() => {
                  setPlacingClosure((v) => !v);
                  setPlacingIncident(false);
                }}
              >
                {placingClosure ? (closureDraftKm == null ? "Click start…" : "Click end…") : "Set closed stretch"}
              </button>
              <button
                className={`btn-muted ${placingIncident ? "active" : ""}`}
                onClick={() => {
                  setPlacingIncident((v) => !v);
                  setPlacingClosure(false);
                }}
              >
                {placingIncident ? "Click a lane…" : "Drop incident"}
              </button>
              <button className="btn-muted" onClick={clearIncidents} disabled={incidentCount === 0}>
                Clear ({incidentCount})
              </button>
              <ClosureHint placing={placingClosure} draftKm={closureDraftKm} anyClosed={closedLanes.some(Boolean)} laneCount={laneCount} dark />
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
              usual size whenever the rail is shorter than it. */}
          <canvas
            ref={canvasRef}
            className={`sandbox-canvas ${placingIncident || placingClosure ? "placing" : ""}`}
            style={expanded ? undefined : { minHeight: laneCount * LANE_PX + CANVAS_PAD * 2 }}
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
          {metrics && !metrics.warm && (
            <p className="sandbox-live-note">
              Warming up &mdash; the road is still filling, so these figures are not yet the
              scenario. {Math.max(0, Math.ceil(WARMUP_S - metrics.elapsedS))}s to go.
            </p>
          )}
          {metrics && metrics.warm && metrics.unmetVehPerHour > 1 && (
            <p className="sandbox-live-note warn">
              {Math.round(metrics.unmetVehPerHour).toLocaleString()} veh/h of demand cannot
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
          {baseline && metrics && anyIntervention && (
            <div className="sandbox-compare">
              <div className="sandbox-compare-head">
                <b>Baseline vs now</b>
                <span>
                  {baseline.takenWith} &rarr; {interventionSummary}
                </span>
              </div>
              <div className="sandbox-compare-rows">
                {([
                  ["Avg speed", baseline.avgSpeedKmh, metrics.avgSpeedKmh, "km/h", true],
                  ["Throughput", baseline.throughputPerMin, metrics.throughputPerMin, "/min", true],
                  ["Longest queue", baseline.longestQueueM, metrics.longestQueueM, "m", false],
                  ["CO₂ rate", baseline.co2RatePerMin, metrics.co2RatePerMin, "kg/min", false],
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
            summary={`${originExit ? displayExitName(originExit.exit_name) : "?"} → ${destExit ? displayExitName(destExit.exit_name) : "?"} · ${direction} · ${laneCount} lanes · ${fmt(inflow)} veh/hr`}
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
          {demand && hourOfDay != null && (
            <div className="sandbox-hour">
              <div className="sandbox-hour-head">
                <span>Hour of day</span>
                <b>
                  {String(hourOfDay).padStart(2, "0")}:00 &middot;{" "}
                  {activeHour?.vehPerHour.toLocaleString()} veh/h
                  {hourOfDay === demand.peakHour ? " · peak" : ""}
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
                {activeHour
                  ? `${(activeHour.mix[2] * 100 + activeHour.mix[3] * 100).toFixed(0)}% heavy vehicles at this hour. `
                  : ""}
                Measured at {displayExitName(String(nearestExit?.exit_name ?? ""))} over {demand.days.toLocaleString()} days;
                peak {demand.peakVehPerHour.toLocaleString()} veh/h at{" "}
                {String(demand.peakHour).padStart(2, "0")}:00, {demand.peakingFactor.toFixed(2)}&times; the daily mean.
              </p>
              {/* Where the inflow figure came from. The panel used to show a
                  number with no basis, and the basis turned out to be wrong —
                  an on-ramp volume standing in for a through-flow — which is
                  precisely the kind of error a visible provenance line catches
                  before it reaches a recommendation. */}
              {inflowBasis && <p className="sandbox-hour-note src">{inflowBasis}</p>}
            </div>
          )}

          {/* Direction is derived from the route, so it belongs with the route
              rather than in a titled group of its own. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <button
              className="btn-muted"
              onClick={() => { const o = origin; setOrigin(destination); setDestination(o); }}
              title="Reverse the journey. Southbound runs down the km posts, so Balintawak becomes the destination."
              style={{ flex: "0 0 auto", padding: "4px 10px" }}
            >
              ⇄ Swap
            </button>
            <span style={{ fontSize: "0.78rem", fontWeight: 700, color: "#0284c7" }}>{dirLabel}</span>
            <span className="sandbox-slider-hint" style={{ margin: 0 }}>
              carriageway
            </span>
          </div>

          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">Inflow</span>
              <span className="sandbox-slider-value" style={{ color: "var(--brand-primary)" }}>{fmt(inflow)} veh/hr</span>
            </div>
            <input
              type="range"
              min={1000}
              max={8000}
              step={100}
              value={inflow}
              onChange={(e) => setInflow(Number(e.target.value))}
              className="sandbox-range inflow"
              style={{ "--range-pct": `${((inflow - 1000) / 7000) * 100}%` } as React.CSSProperties}
            />
            <span className="sandbox-slider-hint">
              {forecastDay
                ? `Forecast for ${new Date(`${forecastDay}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                : dataAnchor
                  ? `Observed NLEX peak ≈ ${fmt(dataAnchor)} veh/hr`
                  : "Vehicle entry rate"}
            </span>
          </div>

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

          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">Carriageway</span>
              <span className="sandbox-slider-value" style={{ color: "#0ea5e9" }}>
                {direction === "NB" ? "Northbound" : "Southbound"}
              </span>
            </div>
            <div className="sandbox-btn-row">
              <button
                className="btn-muted"
                style={{ flex: 1 }}
                onClick={() => { const o = origin; setOrigin(destination); setDestination(o); }}
                title="Reverse the journey. Southbound means travelling down the km posts, so Balintawak becomes the destination rather than the origin."
              >
                Swap origin &amp; destination
              </button>
            </div>
            <span className="sandbox-slider-hint">
              NLEX runs Balintawak (Km 0) north to Sta. Ines, so a route starting at the
              higher km post is southbound. Inflow re-anchors to that carriageway&apos;s
              observed volume; traffic is always drawn left to right and the km axis
              reverses southbound.
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
              <span className="sandbox-slider-label">Lanes</span>
              <span className="sandbox-slider-value" style={{ color: laneOverridden ? "#b45309" : "#16a34a" }}>
                {laneCount}
              </span>
            </div>
            <input
              type="range"
              min={2}
              max={5}
              step={1}
              value={laneCount}
              onChange={(e) => setLaneCount(Number(e.target.value))}
              className="sandbox-range lanes"
              style={{ "--range-pct": `${((laneCount - 2) / 3) * 100}%` } as React.CSSProperties}
            />
            <span className="sandbox-slider-hint">
              {segmentLanes == null
                ? "No verified lane count for this segment — set it manually. Changing lanes resets the run."
                : laneOverridden
                  ? `Overriding the corridor: ${displayExitName(originExit?.exit_name ?? "")} → ${displayExitName(destExit?.exit_name ?? "")} is ${segmentLanes} lanes. Changing lanes resets the run.`
                  : `Matches the corridor between ${displayExitName(originExit?.exit_name ?? "")} and ${displayExitName(destExit?.exit_name ?? "")}${laneProvenance.length ? ` · ${laneProvenance.join(", ")}` : ""}. Changing lanes resets the run.`}
            </span>
          </div>

          </RailSection>

          <RailSection
            title="Interventions"
            open={openSection === "interventions"}
            onToggle={() => toggleSection("interventions")}
            summary={interventionSummary}
          >

          <span className="sandbox-mini-label">Close a lane (traffic must merge out)</span>
          <div className="sandbox-lane-toggles">
            {Array.from({ length: laneCount }, (_, i) => (
              <button
                key={i}
                className={closedLanes[i] || lockedLanes[i] ? "closed" : ""}
                onClick={() => toggleLane(i)}
                disabled={lockedLanes[i]}
                title={lockedLanes[i] && owners.closure ? `Driven by: ${describeOwner(owners.closure)}` : undefined}
              >
                L{i + 1}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 8 }}>
            <span className="sandbox-mini-label">
              Closed from Km {shownClosureFromKm.toFixed(2)} to Km {shownClosureToKm.toFixed(2)} ·{" "}
              {Math.round((shownClosureToKm - shownClosureFromKm) * 1000)} m
            </span>
            {owners.closure && (
              <p className="sandbox-live-note">
                Driven by: {describeOwner(owners.closure)}. The stretch is locked. You can close more lanes on it; the lanes
                the event blocks stay closed until it moves on.
              </p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <label style={{ flex: 1, minWidth: 0 }}>
                <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>From km</span>
                <KmInput value={shownClosureFromKm} min={fromKm} max={toKm} onCommit={commitClosureStart} disabled={owners.closure !== null} />
              </label>
              <label style={{ flex: 1, minWidth: 0 }}>
                <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>To km</span>
                <KmInput value={shownClosureToKm} min={fromKm} max={toKm} onCommit={commitClosureEnd} disabled={owners.closure !== null} />
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
              className={`btn-muted ${placingClosure ? "active" : ""}`}
              title="Traffic merges out before the start and the lane reopens after the end. Type the Km range above, or press this and click the road twice — start, then end."
              disabled={owners.closure !== null}
              onClick={() => {
                setPlacingClosure((p) => !p);
                setPlacingIncident(false);
              }}
            >
              {placingClosure ? (closureDraftKm == null ? "Click start…" : "Click end…") : "Set stretch"}
            </button>
            <button
              className={`btn-muted ${placingIncident ? "active" : ""}`}
              title="Drop a stopped vehicle on a lane to see how traffic behaves around it."
              onClick={togglePlacing}
            >
              {placingIncident ? "Placing…" : "Drop incident"}
            </button>
            <button className="btn-muted" onClick={clearIncidents} disabled={incidentCount === 0}>
              Clear ({incidentCount})
            </button>
          </div>
          <ClosureHint placing={placingClosure} draftKm={closureDraftKm} anyClosed={closedLanes.some(Boolean)} laneCount={laneCount} />
          {placingIncident && (
            <p className="sandbox-place-hint">
              Click a lane on the simulation to drop an incident · Esc to cancel
            </p>
          )}

          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">Speed limit zone</span>
              <span className="sandbox-slider-value" style={{ color: "#ea580c" }}>
                {shownSpeedLimit == null ? "off" : `${shownSpeedLimit} km/h`}
              </span>
            </div>
            {owners.speedZone && (
              <p className="sandbox-live-note">
                Driven by: {describeOwner(owners.speedZone)}. The zone and its limit are locked until the event ends.
              </p>
            )}
            <input
              type="range"
              min={20}
              max={100}
              step={5}
              value={shownSpeedLimit ?? 100}
              onChange={(e) => setSpeedLimit(Number(e.target.value) >= 100 ? null : Number(e.target.value))}
              disabled={owners.speedZone !== null}
              className="sandbox-range capacity"
              title="Slide to 100 to disable the zone."
              style={{ "--range-pct": `${(((shownSpeedLimit ?? 100) - 20) / 80) * 100}%` } as React.CSSProperties}
            />
            {/* "Slide to 100 to disable" was a whole line spent restating the
                value readout beside the title, which already says "off" the
                moment the zone is disabled. It survives as the slider's own
                tooltip. */}
            {shownSpeedLimit != null && (
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <label style={{ flex: 1, minWidth: 0 }}>
                  <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>
                    Zone from km
                  </span>
                  <KmInput value={shownZoneFromKm} min={fromKm} max={toKm} onCommit={setZoneFromKm} disabled={owners.speedZone !== null} />
                </label>
                <label style={{ flex: 1, minWidth: 0 }}>
                  <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>
                    Zone to km
                  </span>
                  <KmInput value={shownZoneToKm} min={fromKm} max={toKm} onCommit={setZoneToKm} disabled={owners.speedZone !== null} />
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
              scenarioEvents.length === 0
                ? "none"
                : `${scenarioEvents.length} event${scenarioEvents.length === 1 ? "" : "s"} · ${activeScenarioText.length > 0 ? activeScenarioText[0] : "none running"}`
            }
          >
            <ScenarioPanel
              events={scenarioEvents}
              owners={owners}
              road={scenarioRoad}
              nowS={scenarioNowS}
              laneCount={laneCount}
              fromKm={fromKm}
              toKm={toKm}
              kmAtPct={(pct) => kmAt((spanM * pct) / 100)}
              pctAtKm={(km) => (spanM > 0 ? (mAt(km) / spanM) * 100 : 0)}
              manualClosure={{ closedLanes, closurePoint: closureM, closureEnd: closureEndM }}
              nextSeq={scenarioSeqRef.current + 1}
              onAdd={addScenarioEvent}
              onRemove={removeScenarioEvent}
              skip={skip}
              canSkip={nextBoundaryAfter(scenarioEvents, scenarioRoad, scenarioNowS) !== null}
              onSkip={skipToNextPhase}
              onCancelSkip={cancelSkip}
            />
          </RailSection>

          <RailSection
            title="Baseline comparison"
            open={openSection === "baseline"}
            onToggle={() => toggleSection("baseline")}
            summary={baseline ? `${fmt(baseline.avgSpeedKmh)} km/h · ${fmt(baseline.throughputPerMin)}/min captured` : "not captured"}
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
                    {metrics ? ` ${Math.ceil(Math.max(0, WARMUP_S - elapsedS))}s to go.` : ""}
                  </i>
                )}
              </div>
            </li>

            <li className={stepCls(2)}>
              <span className="n">{stepDone[1] ? "✓" : "2"}</span>
              <div className="t">
                <b>Capture the &ldquo;before&rdquo;</b>
                {baseline ? (
                  <i>
                    Recorded {fmt(baseline.avgSpeedKmh)} km/h · {fmt(baseline.throughputPerMin)}/min
                    with {baseline.takenWith}.
                  </i>
                ) : activeStep === 2 ? (
                  <i>Freezes the current numbers for comparison. Nothing in the simulation changes.</i>
                ) : null}
                <div className="sandbox-btn-row">
                  <button
                    className="btn-primary"
                    onClick={captureBaseline}
                    disabled={!metrics}
                    style={{ marginLeft: 0 }}
                  >
                    {baseline ? "Re-capture" : "Capture baseline"}
                  </button>
                  {baseline && (
                    <button className="btn-muted" onClick={() => setBaseline(null)}>
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
                    Comparing {baseline?.takenWith} &rarr; {interventionSummary}. The
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
              disabled={scenarioEvents.length > 0}
              style={{ marginLeft: 0 }}
            >
              {repProgress != null ? "Stop" : "Run"}
            </button>
            {repProgress != null && (
              <span className="sandbox-reps-prog">{(repProgress * 100).toFixed(0)}%</span>
            )}
          </div>
          {scenarioEvents.length > 0 && (
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
  g: { xPx: (m: number) => number; roadTop: number; laneH: number; roadH: number; cssW: number; r: number },
) {
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  ctx.save();
  ctx.font = "700 11px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (const m of marks) {
    const x = g.xPx(m.xM);
    const shoulder = m.lane === null;
    const laneY = shoulder ? g.roadTop + g.roadH - 3 : g.roadTop + (m.lane ?? 0) * g.laneH + g.laneH * 0.5;
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
    const y = roadTop + l * laneH;
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
    const kmOf = (m: number) =>
      marks.direction === "NB" ? marks.fromKm + m / 1000 : marks.toKm - m / 1000;
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
      const y = roadTop + lane * laneH;
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
      const cy = roadTop + lane * laneH + laneH / 2;
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
      const y = roadTop + visualLane(v) * laneH + laneH * 0.5;
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
    const y = roadTop + inc.lane * laneH + laneH * 0.5;
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
      const x = xPx(sb ? (marks.toKm - ex.km) * 1000 : (ex.km - marks.fromKm) * 1000);
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
  {
    const spanKm = Math.max(1e-6, marks.toKm - marks.fromKm);
    const step = kmTickStep(spanKm);
    const first = Math.ceil(marks.fromKm / step) * step;
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
    for (let km = first; km <= marks.toKm + 1e-9; km += step) {
      const x = xPx(sb ? (marks.toKm - km) * 1000 : (km - marks.fromKm) * 1000);
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
  ctx.fillText("▶ traffic flow", 8, roadTop + 4);

  // Where this stretch is on the corridor. Without it the canvas is 280 m of
  // anonymous tarmac and the route pickers appear to do nothing.
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "600 11px system-ui";
  ctx.textAlign = "right";
  ctx.fillText(location, cssW - 8, roadTop + 4);
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
