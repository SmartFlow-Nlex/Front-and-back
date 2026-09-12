"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { displayExitName, useNlexExits } from "../../../lib/nlex-exits";
import { lanesForSegment, laneSources } from "../../../lib/nlex-lanes";
import { Car } from "lucide-react";
import PageHeader from "../../../components/dashboard/PageHeader";
import ScenarioForecastPanel from "../../../components/dashboard/ScenarioForecastPanel";
import { TrafficSim, CLASS_META, mixHex, type Metrics, type Interventions } from "./simulation";

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

/** Below this many pixels a Class 1 car stops reading as a vehicle. */
const MIN_CAR_PX = 3;
/** Length of a Class 1 car, for the legibility estimate. */
const CAR_M = 4.5;
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

const SPEED_STEPS = [0.5, 1, 2, 4] as const;

type Baseline = { avgSpeedKmh: number; throughputPerMin: number; longestQueueM: number; co2RatePerMin: number; avgTravelTimeS: number };

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
  const { exits: EXITS } = useNlexExits();
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
  const routeFromKm = Math.min(originExit?.km ?? 0, destExit?.km ?? 0);
  const routeToKm = Math.max(originExit?.km ?? 0, destExit?.km ?? 0);
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

  const locationLabel = nearestExit
    ? `Km ${fromKm.toFixed(2)}–${toKm.toFixed(2)} · ${(segLengthM / 1000).toFixed(2)} km · near ${displayExitName(nearestExit.exit_name)}`
    : `Km ${fromKm.toFixed(2)}–${toKm.toFixed(2)}`;

  // The render loop runs outside React, so these reach it through refs.
  const locationRef = useRef(locationLabel);
  locationRef.current = locationLabel;
  const marksRef = useRef({ fromKm, toKm });
  marksRef.current = { fromKm, toKm };
  // Docked, a lane is capped so the road keeps its proportions inside a card.
  // Expanded there is no card to respect, and capping it only left the
  // carriageway floating in the middle of an empty screen.
  const maxLaneRef = useRef(LANE_PX);
  maxLaneRef.current = expanded ? 240 : LANE_PX;
  // Exits that fall inside the drawn span, so the road can name the places the
  // operator is looking at rather than only its km-posts.
  const exitsRef = useRef<{ name: string; km: number }[]>([]);
  exitsRef.current = EXITS.filter((x) => x.km >= fromKm && x.km <= toKm).map((x) => ({
    name: displayExitName(x.exit_name),
    km: x.km,
  }));

  const [laneCount, setLaneCount] = useState(4);
  const [inflow, setInflow] = useState(4500);
  const [dataAnchor, setDataAnchor] = useState<number | null>(null);
  // Which forecast day the inflow came from, when it came from one. Kept apart
  // from dataAnchor so the slider caption can never call a prediction an
  // observation.
  const [forecastDay, setForecastDay] = useState<string | null>(null);
  // Exit the incident model rates highest for the chosen day, when the sandbox
  // has been positioned there.
  const [hotspot, setHotspot] = useState<string | null>(null);
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

  // Anchor the inflow default to observed NLEX volume (falls back gracefully).
  useEffect(() => {
    fetch(`${BACKEND}/api/traffic/analytics?months=12`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!j.success) return;
        const daily = j.data.kpis.totalVolume / Math.max(1, j.data.kpis.days);
        const peakHourly = Math.round((daily / 24) * 1.6); // peak-hour factor
        const anchored = Math.max(1500, Math.min(8000, peakHourly));
        setDataAnchor(anchored);
        setInflow(anchored);
      })
      .catch(() => {});
  }, []);

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

  // (Re)create the sim when structural config changes.
  const rebuild = useCallback(() => {
    simRef.current = new TrafficSim(
      { length: segLengthM, laneCount, inflowVehPerHour: inflow, seed: 12345 },
      buildInterventions(laneCount, segLengthM)
    );
    setClosedLanes(Array(laneCount).fill(false));
    setSpeedLimit(null);
    setIncidentCount(0);
    setBaseline(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneCount, segLengthM, buildInterventions]);

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
  const closureAtKm = clampKm(closureKm ?? fromKm + (toKm - fromKm) * 0.55);
  const zoneA = clampKm(zoneFromKm ?? fromKm + (toKm - fromKm) * 0.3);
  const zoneB = clampKm(Math.max(zoneToKm ?? fromKm + (toKm - fromKm) * 0.8, zoneA + 0.02));
  // A closure occupies a stretch. Null end means "to the end of the span",
  // which is what it always used to do implicitly.
  const closureEndAtKm = clampKm(Math.max(closureEndKm ?? toKm, closureAtKm + 0.01));
  const closureM = (closureAtKm - fromKm) * 1000;
  const closureEndM = (closureEndAtKm - fromKm) * 1000;
  const zoneM: [number, number] = [(zoneA - fromKm) * 1000, (zoneB - fromKm) * 1000];


  // Live-apply interventions.
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    sim.interventions.closedLanes = closedLanes;
    sim.interventions.speedLimitKmh = speedLimit;
    sim.interventions.closurePoint = closureM;
    sim.interventions.closureEnd = closureEndM;
    sim.interventions.speedZone = zoneM;
  }, [closedLanes, speedLimit, closureM, closureEndM, zoneM]);

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

      if (running) {
        // advance sim time = real time × simSpeed, in fixed steps for stability.
        // A persistent accumulator carries the sub-timestep remainder between
        // frames, so slow (1×) speeds still integrate correctly.
        simAccRef.current += dtReal * simSpeed;
        let guard = 0;
        // Guard scales with the step size so the catch-up window stays ~3 s of
        // simulated time rather than shrinking when SIM_DT does.
        while (simAccRef.current >= SIM_DT && guard < 3 / SIM_DT) {
          sim.step(SIM_DT);
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
      render(ctx, canvas, sim, locationRef.current, marksRef.current, maxLaneRef.current, exitsRef.current);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, simSpeed]);

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
    // Same ceiling render() used for this frame, or a click would map to a
    // different lane than the one under the cursor.
    const laneH = Math.min((cssH - pad * 2) / lanes, maxLaneRef.current);
    const roadTop = (cssH - laneH * lanes) / 2;

    const lane = Math.max(0, Math.min(lanes - 1, Math.floor((cy - roadTop) / laneH)));
    const x = Math.max(0, Math.min(L, (cx / cssW) * L));
    if (placingClosure) {
      // Same geometry as an incident drop, read as a km-post rather than a lane.
      setClosureKm(Number((fromKm + x / 1000).toFixed(2)));
      setPlacingClosure(false);
      return;
    }
    sim.addIncident(lane, x);
    setIncidentCount(sim.interventions.incidents.length);
    setPlacingIncident(false); // one accident per click; re-arm to drop another
  };

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
            closedLanes: closedLanes.map((c, i) => (c ? i + 1 : 0)).filter(Boolean),
            speedLimitKmh: speedLimit,
            incidentCount,
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

    for (const a of plan.actions) {
      switch (a.type) {
        case "close_lane":
        case "open_lane": {
          const shut = a.type === "close_lane";
          const idx = a.lanes.map((n) => n - 1).filter((i) => i >= 0 && i < laneCount);
          if (idx.length === 0) break;
          setClosedLanes((prev) => prev.map((c, i) => (idx.includes(i) ? shut : c)));
          applied.push(`${shut ? "Closed" : "Opened"} lane ${a.lanes.join(", ")}`);
          break;
        }
        case "set_speed_limit":
          setSpeedLimit(a.kmh);
          applied.push(a.kmh == null ? "Removed the speed limit" : `Speed limit ${a.kmh} km/h`);
          break;
        case "add_incident": {
          const x = (a.positionPct / 100) * segLengthM;
          sim.addIncident(a.lane - 1, x);
          setIncidentCount(sim.interventions.incidents.length);
          applied.push(`Incident in lane ${a.lane}`);
          break;
        }
        case "clear_incidents":
          sim.interventions.incidents = [];
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

    setCommandNote(applied.length ? `Applied: ${applied.join(" · ")}.` : "Nothing to apply.");
    setPlan(null);
    setCommand("");
  };
  const clearIncidents = () => {
    const sim = simRef.current;
    if (!sim) return;
    sim.interventions.incidents = [];
    setIncidentCount(0);
  };

  const toggleLane = (i: number) => setClosedLanes((prev) => prev.map((c, idx) => (idx === i ? !c : c)));

  const captureBaseline = () => {
    if (!metrics) return;
    setBaseline({
      avgSpeedKmh: metrics.avgSpeedKmh,
      throughputPerMin: metrics.throughputPerMin,
      longestQueueM: metrics.longestQueueM,
      co2RatePerMin: metrics.co2RatePerMin,
      avgTravelTimeS: metrics.avgTravelTimeS,
    });
  };

  const anyIntervention = closedLanes.some(Boolean) || speedLimit != null || incidentCount > 0;
  const recommendation = getRecommendation(metrics, baseline, closedLanes, incidentCount, speedLimit);

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
                  <button key={i} className={closedLanes[i] ? "closed" : ""} onClick={() => toggleLane(i)}>
                    L{i + 1}
                  </button>
                ))}
              </div>

              <span className="k">Closed Km</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 84 }}>
                  <KmInput value={closureAtKm} min={fromKm} max={toKm} onCommit={setClosureKm} />
                </div>
                <span className="k" style={{ opacity: 0.7 }}>to</span>
                <div style={{ width: 84 }}>
                  <KmInput
                    value={closureEndAtKm}
                    min={fromKm}
                    max={toKm}
                    onCommit={setClosureEndKm}
                  />
                </div>
                <span className="k" style={{ opacity: 0.7 }}>
                  {Math.round((closureEndAtKm - closureAtKm) * 1000)} m
                </span>
              </div>

              <button
                className={`btn-muted ${placingClosure ? "active" : ""}`}
                onClick={() => {
                  setPlacingClosure((v) => !v);
                  setPlacingIncident(false);
                }}
              >
                {placingClosure ? "Click the road…" : "Set closure point"}
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
            </div>
          )}

          {/* Sized to the road, not to the card. render() caps a lane at
              LANE_PX and centres the carriageway in whatever canvas it is
              given, so a stretched canvas drew the same road with dead space
              above and below it — which showed as a white band inside the
              card. Height follows the lane count instead. */}
          <canvas
            ref={canvasRef}
            className={`sandbox-canvas ${placingIncident || placingClosure ? "placing" : ""}`}
            style={expanded ? undefined : { height: laneCount * LANE_PX + CANVAS_PAD * 2 }}
            onClick={placeIncidentAt}
          />

          {/* Wrapper so the legend and the recommendation can sit side by side
              when expanded. `display: contents` while docked means it changes
              nothing there. */}
          <div className="sandbox-footbar">
          <div className="sandbox-legend">
            <span><i style={{ background: CLASS_META[1].color }} /> Class 1 · light</span>
            <span><i style={{ background: CLASS_META[2].color }} /> Class 2 · medium</span>
            <span><i style={{ background: CLASS_META[3].color }} /> Class 3 · heavy</span>
            <span><i style={{ background: "#dc2626" }} /> stopped / incident</span>
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
                  {[
                    closedLanes.filter(Boolean).length
                      ? `${closedLanes.filter(Boolean).length} lane${closedLanes.filter(Boolean).length > 1 ? "s" : ""} closed`
                      : null,
                    speedLimit != null ? `${speedLimit} km/h zone` : null,
                    incidentCount ? `${incidentCount} incident${incidentCount > 1 ? "s" : ""}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
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
          <div className="sandbox-section-title">Corridor</div>
          <label>
            Origin
            <select value={origin} onChange={(e) => setOrigin(Number(e.target.value))}>
              {EXITS.map((ex, i) => (
                <option key={ex.exit_id} value={i} disabled={i >= destination}>
                  {displayExitName(ex.exit_name)} (Km {ex.km})
                </option>
              ))}
            </select>
          </label>
          <label>
            Destination
            <select value={destination} onChange={(e) => setDestination(Number(e.target.value))}>
              {EXITS.map((ex, i) => (
                <option key={ex.exit_id} value={i} disabled={i <= origin}>
                  {displayExitName(ex.exit_name)} (Km {ex.km})
                </option>
              ))}
            </select>
          </label>

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
                ? `Opened at ${hotspot} — the highest incident risk on this route for the selected day. `
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

          <div className="sandbox-section-title">Interventions</div>

          <span className="sandbox-mini-label">Close a lane (traffic must merge out)</span>
          <div className="sandbox-lane-toggles">
            {Array.from({ length: laneCount }, (_, i) => (
              <button key={i} className={closedLanes[i] ? "closed" : ""} onClick={() => toggleLane(i)}>
                L{i + 1}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 8 }}>
            <span className="sandbox-mini-label">
              Closed from Km {closureAtKm.toFixed(2)} to Km {closureEndAtKm.toFixed(2)} ·{" "}
              {Math.round((closureEndAtKm - closureAtKm) * 1000)} m
            </span>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <label style={{ flex: 1, minWidth: 0 }}>
                <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>From km</span>
                <KmInput value={closureAtKm} min={fromKm} max={toKm} onCommit={setClosureKm} />
              </label>
              <label style={{ flex: 1, minWidth: 0 }}>
                <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>To km</span>
                <KmInput value={closureEndAtKm} min={fromKm} max={toKm} onCommit={setClosureEndKm} />
              </label>
            </div>
            <span className="sandbox-slider-hint">
              Traffic merges out before the start and the lane reopens after the end. Click the road
              with &quot;Set closure point&quot; armed to move the start.
            </span>
          </div>

          <div className="sandbox-btn-row">
            <button
              className={`btn-muted ${placingClosure ? "active" : ""}`}
              onClick={() => {
                setPlacingClosure((p) => !p);
                setPlacingIncident(false);
              }}
            >
              {placingClosure ? "Click the road…" : "Set closure point"}
            </button>
          </div>

          <div className="sandbox-btn-row">
            <button
              className={`btn-muted ${placingIncident ? "active" : ""}`}
              onClick={togglePlacing}
            >
              {placingIncident ? "Placing… (click map)" : "Drop incident"}
            </button>
            <button className="btn-muted" onClick={clearIncidents} disabled={incidentCount === 0}>
              Clear ({incidentCount})
            </button>
          </div>
          {placingIncident && (
            <p className="sandbox-place-hint">
              Click a lane on the simulation to drop an incident · Esc to cancel
            </p>
          )}

          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">Speed limit zone</span>
              <span className="sandbox-slider-value" style={{ color: "#ea580c" }}>
                {speedLimit == null ? "off" : `${speedLimit} km/h`}
              </span>
            </div>
            <input
              type="range"
              min={20}
              max={100}
              step={5}
              value={speedLimit ?? 100}
              onChange={(e) => setSpeedLimit(Number(e.target.value) >= 100 ? null : Number(e.target.value))}
              className="sandbox-range capacity"
              style={{ "--range-pct": `${(((speedLimit ?? 100) - 20) / 80) * 100}%` } as React.CSSProperties}
            />
            <span className="sandbox-slider-hint">Slide to 100 to disable</span>
            {speedLimit != null && (
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <label style={{ flex: 1, minWidth: 0 }}>
                  <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>
                    Zone from km
                  </span>
                  <KmInput value={zoneA} min={fromKm} max={toKm} onCommit={setZoneFromKm} />
                </label>
                <label style={{ flex: 1, minWidth: 0 }}>
                  <span className="sandbox-slider-hint" style={{ display: "block", marginBottom: 3 }}>
                    Zone to km
                  </span>
                  <KmInput value={zoneB} min={fromKm} max={toKm} onCommit={setZoneToKm} />
                </label>
              </div>
            )}
          </div>

          <div className="sandbox-section-title">Baseline comparison</div>
          <p className="sandbox-mini-label" style={{ marginTop: 0 }}>
            Capture a baseline with no interventions, then apply changes to see the deltas above.
          </p>
          <div className="sandbox-btn-row">
            <button className="btn-primary" onClick={captureBaseline} disabled={!metrics} style={{ marginLeft: 0 }}>
              Capture baseline
            </button>
            {baseline && (
              <button className="btn-muted" onClick={() => setBaseline(null)}>
                Clear
              </button>
            )}
          </div>
          {baseline && (
            <p className="sandbox-baseline-note">
              Baseline: {fmt(baseline.avgSpeedKmh)} km/h · {fmt(baseline.throughputPerMin)}/min
              {anyIntervention ? " · comparing against current interventions" : " · no interventions applied yet"}
            </p>
          )}
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
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (km: number) => void;
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
/** Set once so a per-frame failure is reported, not repeated 60 times a second. */
let renderFailureReported = false;

/** Tick spacing in km that yields a readable number of markers for a span. */
function kmTickStep(spanKm: number): number {
  for (const step of [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5]) {
    if (spanKm / step <= 8) return step;
  }
  return 10;
}

function render(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  sim: TrafficSim,
  location: string,
  marks: { fromKm: number; toKm: number },
  maxLaneH: number,
  exits: { name: string; km: number }[],
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
  const pad = 8;
  // Let lanes grow to fill the taller canvas. Vehicle length and width are
  // bounded independently below (true-to-scale), so lanes just gain breathing
  // room instead of stretching the cars. The cap only prevents absurdly tall
  // lanes on very large screens.
  const laneH = Math.max(6, Math.min((cssH - pad * 2) / lanes, maxLaneH));
  const roadH = laneH * lanes;
  const roadTop = (cssH - roadH) / 2;
  const mToPx = cssW / L;
  const xPx = (x: number) => x * mToPx;

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
    ctx.fillRect(xPx(z0), roadTop, Math.max(3, xPx(z1 - z0)), roadH);
    ctx.fillStyle = "rgba(234,88,12,0.85)";
    ctx.fillRect(xPx(z0), roadTop, 2, roadH);
    ctx.fillRect(Math.max(xPx(z0) + 2, xPx(z1) - 2), roadTop, 2, roadH);
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
    const x1 = Math.min(cssW, xPx(sim.interventions.closureEnd));
    ctx.fillStyle = "rgba(220,38,38,0.28)";
    ctx.fillRect(x0, y, Math.max(2, x1 - x0), laneH);
    // A solid edge at the far end so the reopening is as visible as the taper.
    if (x1 < cssW) {
      ctx.fillStyle = "rgba(255,120,120,0.9)";
      ctx.fillRect(x1 - 2, y, 2, laneH);
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

  for (const v of sim.vehicles) {
    try {
      // One factor for every class, so a bus still reads as longer than a car.
      const len = Math.max(2, v.length * mToPx * k);
      const wid = Math.max(
        2,
        Math.min(laneH * 0.8, widthM[v.vClass] * mToPx * k * widScale),
      );
      const y = roadTop + v.lane * laneH + laneH * 0.5;
      drawVehicle(ctx, xPx(v.x), y, len, wid, v.vClass, v.color, v.v < 3);
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

  // direction arrow
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "10px system-ui";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  // ── Exits ───────────────────────────────────────────────────────────────────
  // The caption says "near NLEX Harbor Link" but nothing showed WHERE that is.
  // An operator reasoning about a closure needs the junction on the picture,
  // not just in the heading.
  for (const ex of exits) {
    const x = xPx((ex.km - marks.fromKm) * 1000);
    if (x < 0 || x > cssW) continue;
    ctx.strokeStyle = "rgba(125,211,252,0.85)";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, roadTop);
    ctx.lineTo(x, roadTop + roadH);
    ctx.stroke();

    const label = `${ex.name} · Km ${ex.km}`;
    ctx.font = "600 11px system-ui";
    const w = ctx.measureText(label).width + 10;
    // Flip the tag inside the canvas near the right edge rather than clipping.
    const left = x + w > cssW ? x - w : x;
    ctx.fillStyle = "rgba(125,211,252,0.92)";
    roundRect(ctx, left, roadTop + 3, w, 16, 4);
    ctx.fill();
    ctx.fillStyle = "#04283a";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(label, left + 5, roadTop + 6);
  }

  // Km ladder. Without it the road is 600 m of anonymous tarmac and an operator
  // cannot say where on the corridor a queue is forming — which is the first
  // thing they need in order to act on it.
  {
    const spanKm = Math.max(1e-6, marks.toKm - marks.fromKm);
    const step = kmTickStep(spanKm);
    const first = Math.ceil(marks.fromKm / step) * step;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.font = "10px system-ui";
    for (let km = first; km <= marks.toKm + 1e-9; km += step) {
      const x = xPx((km - marks.fromKm) * 1000);
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
      ctx.fillText(`${km.toFixed(step < 0.1 ? 2 : step < 1 ? 2 : 1)}`, x, roadTop + roadH - 3);
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
  slow: boolean
) {
  const glass = "rgba(196,220,255,0.92)";
  const headlight = "#fff3b0";
  const brake = slow ? "#ff4d4d" : "#c62828";
  ctx.save();
  ctx.translate(xFront, yCenter);

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
