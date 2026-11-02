// ---------------------------------------------------------------------------
// NLEX corridor traffic microsimulation.
//
// Each vehicle is an independent agent. Longitudinal motion uses the
// Intelligent Driver Model (IDM); lane changes use a MOBIL-style decision.
// Congestion (queues, stop-and-go waves, merge bottlenecks) is EMERGENT from
// these local rules — nothing is scripted. Interventions (lane closures,
// incidents, speed limits) change the road; the agents react on their own.
//
// Units are SI internally (metres, seconds, m/s); the UI converts to km/h.
// A seeded RNG makes a run reproducible, so a baseline and an intervention
// can be compared on the identical inflow sequence.
// ---------------------------------------------------------------------------

import { FacilityEngine, type Facility, type FacilityHost, type FacilitySpec, type FacilityStats, type FacState } from "./facilities";

export type VehicleClass = 1 | 2 | 3;
/** Vehicles a scenario sends to a scene. `works` is a roadworks convoy —
 *  not an emergency, so it travels at ordinary speed and sets up rather than
 *  responding to anything. */
export type ResponderKind = "ambulance" | "police" | "tow" | "works";
/** How a scene's vehicle looks once it has come to rest: crashed (turned at an angle, bodywork damaged), stalled (a
 *  breakdown: straight, hazards going) or overturned (on its side). */
export type WreckLook = "crash" | "stalled" | "overturned";
/* How the vehicles of a scene come to be there. Never put down on the road: they are the traffic that was driving
 * there, picked out a few seconds before it happens and seen to do it.
 *   collision  the first brakes hard and stops; the one behind sees it too late and runs into it
 *   pileup     the same, and each one behind piles into the last
 *   self       one vehicle loses control, skids round and stops
 *   overturn   the same, and it goes over (a truck or a bus, if one is coming)
 *   breakdown  it loses power, slows with its hazards on and stops in its lane
 *   shoulder   the same, but it pulls onto the hard shoulder to stop */
export type CrashKind = "collision" | "pileup" | "self" | "overturn" | "breakdown" | "shoulder";

/** A scene being put together out of the traffic, then standing until it is cleared (crashAt / releaseScene). */
export type CrashScene = {
  /** The scenario event it belongs to, or an id of its own for an operator's or a secondary incident. */
  readonly key: string;
  /** The lane it happens in (the outer lane, for a vehicle pulling onto the shoulder). */
  readonly lane: number;
  /** The event's point, and where the first vehicle's nose comes to rest. */
  readonly x: number;
  readonly stopX: number;
  /** How many vehicles it takes; cut short if nobody else comes along. */
  want: number;
  readonly kind: CrashKind;
  /** The class to pick if one is coming: a truck to overturn, the class that broke down. */
  readonly prefer: VehicleClass | null;
  /** Sim time it is due: the first vehicle is chosen to arrive about then. */
  readonly dueAt: number;
  readonly members: Vehicle[];
  lastJoinAt: number;
  /** Everyone in it has come to rest; the response has been sent. */
  done: boolean;
  /** The operator's or a secondary incident it is the vehicles of: when that is cleared, so is the scene. */
  incident?: Interventions["incidents"][number];
  /** A recovery truck has been asked for (its tow or service phase began), and has been sent. */
  towWanted: boolean;
  towSent: boolean;
  /** A scene with no event to say when: the time to send its recovery truck. */
  towAt: number | null;
  /** Seconds after it is due by which the first responder should be at the scene (the event's response time);
   *  undefined for a scene with no event behind it, which is answered after RESPONSE_CALL_S. */
  respondS?: number;
};

/** The least time between a scene coming to rest and its first responder setting off: somebody has to report it. */
const RESPONSE_CALL_S = 15;
/** How long the recovery crew is at an overturned vehicle before it is back on its wheels. */
const RIGHTING_S = 45;
export type DriverProfile = "cautious" | "normal" | "aggressive";

export type Vehicle = {
  id: number;
  lane: number;
  x: number; // metres from segment start
  v: number; // m/s
  vClass: VehicleClass;
  profile: DriverProfile;
  v0: number; // desired free-flow speed (m/s)
  /* Per-driver traits, drawn once at birth.
   *
   * These used to be read from PROFILE[profile] at every step, which meant a
   * "normal" driver was not a driver at all but a category: every normal Class
   * 1 car wanted exactly 30.0 m/s, left exactly 1.4 s of headway and
   * accelerated at exactly 1.4 m/s². Three classes times three profiles gave
   * the whole road nine possible behaviours, and on an open carriageway the
   * cars in each group converged on an identical speed and held formation.
   *
   * Real drivers vary continuously, and they vary WITHIN a temperament: two
   * unhurried drivers still do not want the same speed. Sampling each trait
   * per vehicle is what makes a queue disperse, a platoon stretch, and a
   * faster driver actually come up behind a slower one and have a reason to
   * change lane. */
  T: number; // preferred time headway (s)
  aMax: number; // this driver's comfortable acceleration (m/s²)
  politeness: number; // MOBIL: weight given to the drivers they affect
  lcSec: number; // seconds this vehicle takes to cross a lane line
  /* When this driver next looks for a gap.
   *
   * Without these, every agent re-evaluated a lane change on every 0.05 s
   * tick — 20 perfectly synchronised glances a second, each one omniscient
   * and instantaneous. That is the single least human thing a microsimulation
   * does: the moment a gap becomes worth taking, everybody who could take it
   * knows at the same instant. `scanSec` is this driver's own mirror-check
   * cadence and `scanTimer` their phase within it, so they notice
   * opportunities at different moments and some are simply slower to spot
   * one than the car behind them. */
  scanSec: number;
  scanTimer: number;
  /* Perception-reaction lag.
   *
   * IDM as written responds to the vehicle ahead instantaneously and
   * continuously, which no human does. That is why the queues it produces
   * glide smoothly instead of oscillating: real stop-and-go waves — the
   * phantom jams you sit in on a motorway with no crash to explain them — are
   * generated by exactly this lag, drivers braking slightly harder than the
   * car in front because they saw it late.
   *
   * Modelled as an asynchronous update (the "action point" approach) rather
   * than by storing a history of the leader's state: the driver recomputes
   * their acceleration every `reactionS` and holds it in between. Same
   * delayed response, a fraction of the memory. */
  reactionS: number;
  reactTimer: number;
  accel: number; // the acceleration currently being held

  /** How long this driver will sit at a taper before forcing their way in. */
  patience: number;
  /** Which ramp this vehicle intends to leave by; null = runs the full length. */
  exitAtX: number | null;
  /** How long they have been stopped in a lane that is closing. */
  stuckFor: number;
  length: number; // m
  spawnTime: number; // sim seconds
  co2: number; // grams emitted so far
  laneCooldown: number; // seconds until next lane change allowed
  /* Where the vehicle is drawn across the carriageway, as opposed to which
   * lane it belongs to.
   *
   * `lane` changes the instant MOBIL accepts the move, because every following
   * and safety calculation needs one unambiguous answer to "which lane is this
   * in" — a car half-way across belongs to one of them, not to both. But the
   * renderer read that same integer, so a change moved the sprite a whole lane
   * width between two frames and looked like a teleport.
   *
   * These two carry the movement the integer cannot: `laneFrom` is where the
   * manoeuvre started and `laneShift` runs 0 → 1 over `lcSec`. The
   * physics is unaffected — this is presentation only. */
  laneFrom: number;
  laneShift: number;
  color: string; // the agent's own paint — class hue with per-vehicle variation

  /* What this agent IS, as opposed to what it looks like.
   *
   * The scene art used to draw crashed cars, an ambulance and a police car as
   * pictures laid over the road, with nothing behind them. So the wreck was
   * not made of the cars that crashed — addIncident DELETED those and a
   * drawing took their place — and the responders did not arrive, they faded
   * in at a fixed offset. Traffic drove through all of it, because as far as
   * the engine was concerned none of it was there.
   *
   * They are agents now. A wreck is the vehicle that crashed, stopped where it
   * stopped; a responder drives in from upstream under the same car-following
   * rules as everyone else. Both are therefore obstacles the rest of the
   * traffic can see, and both are covered by the overlap correction, which is
   * why they can no longer be driven through. */
  role: "traffic" | "wreck" | "responder";
  /** Responders only: which vehicle to draw, and what it is here for. */
  responderKind?: ResponderKind;
  /** Responders only: where they are heading. They hold station on arrival. */
  holdAtX?: number;
  /** Responders only: sim time at which they pack up and drive on. */
  leaveAtT?: number;
  /** Wrecks only: the angle they came to rest at, for the canvas. */
  restAngle?: number;
  /** Which scenario event put this agent on the road, so the scene can be
   *  taken away again when the event ends. Absent for ordinary traffic. */
  sceneKey?: string;
  /* Packing up and leaving.
   *
   * Without this the scene had no end: a wreck sat blocking the lane for the
   * rest of the run because the scenario binding only tracks the INCIDENTS it owns and
   * these are vehicles, and the responders held station forever. A departing
   * agent goes back to ordinary car-following and drives off the end of the
   * segment, which is how everything else leaves. */
  departing?: boolean;
  /** Inside a toll plaza or service area: which one, where, and what it is
   *  doing there. Absent on the carriageway. See facilities.ts. */
  fac?: FacState;
  /** Waiting at a gore or a barrier because the facility is full back to the
   *  carriageway. Stands still in its lane until there is room. */
  heldAtGore?: boolean;
  /** Responders sent to a scene in a plaza or service area: which, and which booth. */
  facTarget?: { fid: string; station: number | null };
  /** A responder held on the shoulder behind its own scene with no way round: for how long (s). */
  shoulderWait?: number;
  /** Until when (sim time) this driver accepts a shortened headway behind a car that just merged in front of it. */
  relaxUntil?: number;
  /* On its way into a scene that has not happened yet (crashAt): which, its place in it (0 stops first; each after it
   * runs into the one ahead, `ahead`), and how it is going. Until the moment it happens it drives as everyone does,
   * which is what lets the event be seen coming. */
  doom?: { readonly scene: CrashScene; readonly order: number; readonly ahead: Vehicle | null; readonly spin: number; brakeFromV?: number; hitAt?: number; stoppedFor: number };
  /** Wrecks, and a vehicle skidding into one: which way the body points now, radians off the lane, easing to restAngle. */
  yaw?: number;
  /** Wrecks: how the canvas draws it. */
  look?: WreckLook;
  /** Hazard lights flashing: stalled, crashed, or slowing to a stop with a fault. */
  hazards?: boolean;
  /** Sim time a wreck came to rest, or a responder parked: how long the people there have had to get out and get on with it. */
  stillSince?: number;
  /** Responders: the lane they park in (TrafficSim.shoulderLane for the hard shoulder). */
  parkLane?: number;
  /** On the hard shoulder, in TrafficSim.shoulder — in no lane. `lane` is then the shoulder's number. */
  onShoulder?: boolean;
  /** Crossing between the shoulder and a lane (laneFrom or lane is the shoulder's number): the canvas draws that end on the shoulder. */
  viaShoulder?: boolean;
  /** A wreck being towed away: the truck it is hitched behind, and whether the hitch is made yet (it is winched up first). */
  towedBy?: Vehicle;
  hitched?: boolean;
  /** A recovery truck: the vehicle it has in tow. */
  towing?: Vehicle;
  /** Responders: how long it has stood waiting to get across to the lane it parks in. */
  heldFor?: number;
};

export type Interventions = {
  closedLanes: boolean[]; // per-lane
  /**
   * Where a closure begins, in metres from the start of the simulated span.
   * Traffic must merge out before reaching it.
   */
  closurePoint: number;
  /**
   * Where it ends and the lane reopens. Roadworks occupy a stretch, not a
   * half-line: an operator closing lane 4 from km 0.20 to km 0.40 expects the
   * lane back afterwards, and the tailback to clear once traffic is past it.
   * Defaults to the end of the span, which is the old open-ended behaviour.
   */
  closureEnd: number;
  /**
   * Display only — draw the closure stretch as a dashed outline even though no
   * lane is closed. A closure acts on closed lanes alone, so without this an
   * operator who set the stretch first saw nothing happen.
   */
  showClosurePreview?: boolean;
  /**
   * Display only — the stretch being drawn with two clicks, in metres from the
   * start of the span, before the second click commits it.
   */
  closureDraft?: { from: number; to: number } | null;
  /* Stalled obstacles. `secondary` marks one the engine generated behind
   * another rather than one the operator or a scenario placed, so the canvas
   * can label it and it cannot itself breed a third — the measured base rate
   * counts secondaries following a PRIMARY, and letting them compound would
   * drift above the rate it was calibrated to. */
  incidents: { lane: number; x: number; secondary?: boolean; bornAt?: number }[];
  speedLimitKmh: number | null; // applies in the speed zone
  speedZone: [number, number]; // [from, to] metres
  /* More lane closures and speed zones, beside the one of each above: scenario events running at the same time,
   * each with its own lanes and stretch, or its own zone and limit. The road had one of each, so a second
   * collision or a second shower could not be added while the first was on — at most two or three events at
   * once. Every closure here acts exactly as the one above does (a wall at its start in its lanes, a merge
   * ahead of it, the lanes beside it cautious), and where zones overlap the lowest limit applies. Optional, and
   * empty when absent, so a run with one of each behaves exactly as it always did. */
  closures?: readonly LaneClosure[];
  speedZones?: readonly SpeedZone[];
};

/** One lane closure: which lanes (engine index), from where to where along the stretch (metres). */
export type LaneClosure = { readonly lanes: readonly boolean[]; readonly from: number; readonly to: number };
/** One speed limit over one stretch (metres). */
export type SpeedZone = { readonly from: number; readonly to: number; readonly kmh: number };

export type Metrics = {
  activeAgents: number;
  avgSpeedKmh: number;
  throughputPerMin: number; // vehicles completing the segment, extrapolated
  densityPerKmLane: number;
  stoppedCount: number;
  longestQueueM: number;
  co2RatePerMin: number; // kg CO2 / minute (current)
  avgTravelTimeS: number; // of recently completed vehicles
  completed: number;
  elapsedS: number; // simulated seconds since this run began
  /** False until the warm-up has elapsed; statistics before that are not
   *  comparable with anything, because the road is still filling. */
  warm: boolean;
  /* Demand that could not get onto the segment, veh/h.
   *
   * When demand exceeds what the road can take, the surplus queues UPSTREAM of
   * the simulated stretch, where nothing draws it and no metric sees it. The
   * segment itself then reports a perfectly healthy speed, because the only
   * traffic on it is the traffic that fitted. Measured at 3,000 veh/h/lane of
   * demand the road read 78 km/h while a quarter of the vehicles never got on.
   * Reporting this is the difference between "the road is fine" and "the road
   * is fine because we left a quarter of the demand at the door". */
  unmetVehPerHour: number;
};

export type SimConfig = {
  length: number; // segment length (m)
  laneCount: number;
  inflowVehPerHour: number; // total across all open lanes
  seed: number;
  /** Per-class CO2 (g/m) and fleet share, from the warehouse.
   *
   *  The constants below are defaults so the simulation still runs standalone,
   *  but they are NOT the corridor's numbers: they have Class 3 at 950 g/km
   *  against the 798 in nlex_emission_factors, and the fleet at 78/16/6
   *  against an observed 78.1/13.5/8.4. Supplying this makes the sandbox agree
   *  with the Emissions dashboard instead of quietly contradicting it. */
  classProfile?: Partial<Record<VehicleClass, { co2PerM?: number; share?: number }>>;
  /* How long to let the road fill before statistics mean anything.
   *
   * A run starts with an empty carriageway, so for the first minute or so
   * there is nothing on it to slow anyone down and nobody has yet reached the
   * far end. Average speed therefore starts at free flow and falls, and
   * throughput starts at zero and climbs — neither is a property of the
   * scenario, both are artefacts of starting from nothing. Measuring through
   * that transient is the classic way to get a flattering answer out of a
   * microsimulation. Statistics are collected only after it. */
  warmupS?: number;
  /** Ramps along the segment: where traffic joins and leaves. */
  ramps?: RampSpec[];
  /* Secondary incidents: a crash in the queue behind an existing one.
   *
   * Off unless asked for, because it makes a run stochastic in a way the
   * operator did not set up, and a baseline capture has to be reproducible.
   * With a fixed seed it still replays exactly — the draw comes from the
   * simulation's own RNG, not Math.random. */
  secondaryIncidents?: boolean;
  /** Override the calibrated hazard. Only for sensitivity work. */
  secondaryPerIncidentMinute?: number;
  /* Toll plazas and service areas with real geometry. Where one is given, its
   * movement is NOT also listed in `ramps`: a facility's diverge is added to
   * the exit list here, and its arrivals come off its own approach road. */
  facilities?: FacilitySpec[];
  /* Lanes lent by the other carriageway: this run's innermost `lanes`, which
   * on the road are the other carriageway's, past the median and coned off.
   * Traffic gets into or out of them only at the crossover at either end,
   * within `crossM` of the start or the end of the span. */
  borrowed?: { lanes: number; crossM: number };
};

/** An interchange on the simulated stretch: traffic joins, leaves, or both. */
export type RampSpec = {
  /** Distance along the segment, metres from the entry end. */
  x: number;
  /** Vehicles per hour joining here. */
  onVehPerHour: number;
  /** Share of passing traffic that leaves here, 0–1. */
  offFraction: number;
  /** Exit name, for debugging and tooltips. */
  name: string;
};

// Per-class kinematics. Heavier = slower desired speed, longer, more CO2/km.
// Colours are a colourblind-safe categorical trio (validated) so each class is
// identifiable at a glance; red is deliberately avoided (it marks a stopped car).
// `lcSec` is how long this class takes to cross a lane line — see
// LANE_CHANGE_BASE_SEC. It scales with size, not mass: a 14 m articulated
// truck has slower steering, has to swing its trailer, and is driven across
// gently because the load shifts. A hatchback just goes.
//
// How each class MOVES, beyond how fast it wants to go. These four are engineering defaults, not fitted to NLEX:
// the warehouse holds no per-class speed, acceleration or headway (see validate_sandbox.ts), so they encode only
// the direction and rough size of differences that are not in dispute, and are here to be replaced by
// measurements when there are any.
//   aF        acceleration relative to a car. Heavier vehicles with less power per tonne pull away and recover
//             speed far more slowly, which is what turns a truck into a moving bottleneck on a grade or out of a queue.
//   tF        time headway relative to a car (scales the profile's T). Longer vehicles that need longer to stop
//             leave a longer gap.
//   v0Sd      spread of desired speed among drivers of the class. Heavy vehicles are speed-limited or governed,
//             so they cluster tighter around their cruising speed than cars do.
//   keepRight extra pull towards the outer lane, on top of LANE_DISCIPLINE (m/s²): heavy vehicles are expected to
//             stay out of the overtaking lanes, and do so more than a car that merely prefers to.
const CLASS = {
  1: { v0: 30, len: 4.6, co2PerM: 0.16, color: "#3e67ef", share: 0.78, lcSec: 1.1, aF: 1.0, tF: 1.0, v0Sd: 0.1, keepRight: 0 }, // light — blue
  2: { v0: 25, len: 9, co2PerM: 0.55, color: "#1f9d57", share: 0.16, lcSec: 1.9, aF: 0.75, tF: 1.15, v0Sd: 0.08, keepRight: 0.25 }, // medium — green
  3: { v0: 22, len: 14, co2PerM: 0.95, color: "#9b5de5", share: 0.06, lcSec: 2.7, aF: 0.45, tF: 1.35, v0Sd: 0.06, keepRight: 0.5 }, // heavy — purple
} as const;

// Driver profile modifiers: time headway T, desired-speed factor, politeness.
// `lcf` scales how briskly this temperament steers across. Someone who tailgates
// and takes small gaps also changes lanes decisively; a cautious driver eases over.
// `scanf` scales the mirror-check cadence. An aggressive driver is actively
// hunting for a gap and so notices one sooner; a cautious driver is settled in
// their lane and looks less often.
//
// CALIBRATION NOTE — the T values.
// Time headway is the parameter that sets capacity: at equilibrium a lane
// carries v / (S0 + length + v*T) vehicles per second, so T is the only free
// parameter with a direct line to the one quantity that CAN be checked against
// published figures. With the original 1.8 / 1.4 / 1.0 the simulated basic
// freeway capacity measured 2,435 pc/h/lane against the HCM's 2,000-2,400, so
// they are scaled by 1.12 to bring it inside the range. Every value stays
// within the 0.8-2.0 s that the car-following literature reports for motorway
// headway, so this is a calibration, not a fudge.
// See All_Scripts/Simulation_Validation/validate_sandbox.ts.
//
// RE-CALIBRATED once the entrance stopped filtering who gets on (see TrafficSim.waiting). The 2.0 / 1.57 / 1.12
// set above measured 2,515 pc/h/lane on this engine — but only because a refused arrival was replaced by a fresh
// random one, so the drivers who got on were disproportionately the short-headway ones (half the trucks, against 15%
// of the population). With every arrival kept as who they are, the same values measure 1,692 pc/h/lane, under the
// HCM's 2,000-2,400, so they are scaled by 0.72 to 1.44 / 1.13 / 0.81 (capacity 2,073 by the same measure: the harness's
// sweep and mix, run without the database; 1,784 / 1,879 / 2,021 at 0.92 / 0.85 / 0.78). The shortest of the three is
// still inside the 0.8-2.0 s range the literature reports. The per-class factors in CLASS (tF) sit on top of these.
const PROFILE = {
  cautious: { T: 1.44, v0f: 0.92, politeness: 0.5, lcf: 1.16, scanf: 1.15, pat: 1.5, react: 1.2 },
  normal: { T: 1.13, v0f: 1.0, politeness: 0.3, lcf: 1.0, scanf: 1.0, pat: 1.0, react: 1.0 },
  aggressive: { T: 0.81, v0f: 1.12, politeness: 0.1, lcf: 0.85, scanf: 0.8, pat: 0.6, react: 0.82 },
} as const;

// IDM constants
const A_MAX = 1.4; // max accel m/s^2
const B_COMF = 2.0; // comfortable decel m/s^2
const S0 = 2.5; // minimum bumper gap m
const DELTA = 4;
const INCIDENT_LENGTH = 5; // a stalled vehicle occupies ~5 m of lane

/* Scenes made of the traffic (crashAt). */
/** How far upstream the first vehicle of a scene may be picked from, m. */
const SCENE_REACH_M = 450;
/** A vehicle joins a scene only from this close behind the last one in it, m. */
const SCENE_FOLLOW_M = 220;
/** Nobody else has come along in this long, s: the scene is what it is. */
const SCENE_GIVE_UP_S = 45;
/** The first vehicle's hard stop, and how fast a breakdown loses speed, m/s². */
const CRASH_BRAKE = 6.5;
const COAST_DECEL = 1.6;
/** How hard the one behind brakes once it has seen: an emergency stop, too late to avoid it. */
const LATE_BRAKE = 5.5;
/** Responders' pace on the hard shoulder, m/s: well under the limit, past a queue. */
const SHOULDER_SPEED: Record<ResponderKind, number> = { police: 22, ambulance: 20, tow: 16, works: 13 };
const RESPONDER_LENGTH: Record<ResponderKind, number> = { police: 5, ambulance: 6.5, tow: 9, works: 8 };
const RESPONDER_CLASS: Record<ResponderKind, VehicleClass> = { police: 1, ambulance: 2, tow: 3, works: 3 };
const RESPONDER_COLOR: Record<ResponderKind, string> = { police: "#1d4ed8", ambulance: "#e2e8f0", tow: "#f59e0b", works: "#eab308" };

const B_SAFE = 4.0; // MOBIL: max decel a follower may be forced into
const LC_THRESHOLD = 0.2; // MOBIL: incentive threshold m/s^2
const LC_BIAS_ESCAPE = 3.0; // strong pull to leave a lane that's blocked ahead

/* ── Zipper merge ────────────────────────────────────────────────────────────
 *
 * A closed lane is a stopped obstacle at its taper, so traffic in it slows and
 * eventually stops. That created a deadlock: merging from a standstill into a
 * lane still running at 70 km/h forces the new follower to brake far harder
 * than B_SAFE, the safety veto refused every such move, and the queue in the
 * closed lane then grew without bound — cars sat at the taper looking like the
 * closure had broken the simulation. Arrivals ran at one car every 2.4 s while
 * merges only happened on the rare huge gap, about one every 7 s.
 *
 * Real drivers resolve this by pushing in, and the lane being merged into
 * yields. So a MANDATORY merge is allowed to impose a harder deceleration than
 * a discretionary one, scaled by how close the vehicle is to the taper: far
 * upstream it behaves normally and waits for a civilised gap; at the taper it
 * takes what it can get. B_SAFE still applies in full to ordinary lane
 * changes, and even a forced merge is capped — this buys a zipper, not a
 * collision.
 */
const MERGE_ZONE_M = 150; // over what distance the urgency ramps to 1
/* How much a driver eases off approaching a lane drop in a NEIGHBOURING lane.
 *
 * A closure does not only affect the lane that is shut. Drivers in the open
 * lanes beside it see the merge coming, lift off and leave room, so the whole
 * carriageway slows and the queue spreads across lanes — which is why a lane
 * drop costs far more capacity than the one lane it removes.
 *
 * Without this the model kept the effect unrealistically local: with a middle
 * lane closed, the lane on one side sat at 61 km/h while the lane on the other
 * side ran at 80.8 km/h, completely undisturbed, because every merge happened
 * to go the other way. Measured against no closure at all, that lane may as
 * well not have known. */
const MERGE_CAUTION = 0.62; // desired-speed multiplier at the taper itself

/* ── Lane discipline: keep right except to overtake ──────────────────────────
 *
 * MOBIL as written here was symmetric — a lane change happened only when it
 * bought acceleration, and staying put cost nothing. So a slow driver who
 * happened to spawn in lane 1 stayed in lane 1 for the whole run, and the
 * "overtaking lane" carried the same mix and very nearly the same speed as the
 * rest of the carriageway. Nothing in the model knew the inner lane means
 * anything.
 *
 * The standard fix is an asymmetric bias: moving outward is rewarded, moving
 * inward is charged. A driver held up by someone slower still pulls in to
 * overtake, because the acceleration they gain exceeds the bias — and once
 * past, the same bias pushes them back out. Lane discipline is then emergent
 * rather than scripted, and it produces the speed gradient a real motorway has
 * without assigning any lane its own speed.
 *
 * Sized well below LC_BIAS_ESCAPE: leaving a closing lane must always outrank
 * a matter of courtesy.
 */
const LANE_DISCIPLINE = 0.32; // m/s^2 in favour of the outer lane
const B_SAFE_FORCED = 9.0; // decel a yielding follower will tolerate at the taper

/** How long a lane change takes to draw, in simulation seconds.
 *
 *  A real lane change runs about 3–5 s door to door for a car, and longer
 *  for a heavy vehicle. That is too slow here: the camera watches a 1 km span,
 *  so a car crossing for four seconds spends most of the visible road
 *  straddling a line and reads as indecision rather than a manoeuvre. Times
 *  are compressed, but the RATIO between classes is kept, because that ratio
 *  is the part you can see — a bus that slides over as fast as a hatchback is
 *  the single thing that most gives away a toy simulation.
 *
 *  This is a base for class 1 only. The figure actually used is per vehicle
 *  (`v.lcSec`), from the class size and the driver's temperament, and the
 *  cooldown after a change is derived from it so that no vehicle can ever
 *  begin a second manoeuvre while still drawn mid-way through the first. */
const LANE_CHANGE_BASE_SEC = 1.1;

/* Quiet time after completing a change, on top of the crossing itself. Keeps a
 * vehicle from weaving lane to lane and gives the new follower a moment to
 * settle before anything else is decided around it. */
const LC_SETTLE_SEC = 0.9;

/* Base interval between one driver's glances for a gap. Around a second, which
 * is the order of a real mirror-check-and-decide cycle, and short enough that
 * a vehicle still reacts promptly to a closure ahead (where the cadence is
 * tightened — see step()). */
const SCAN_BASE_SEC = 0.85;

/* How much more often a driver looks when their own lane is closing ahead.
 * Someone who has seen the merge sign is watching the next lane continuously,
 * not glancing at it once a second. */
const SCAN_ALERT_FACTOR = 4;

/* ── Zipper merge at crawling pace ───────────────────────────────────────────
 *
 * Below this speed a merge stops being an IDM problem and becomes a question
 * of whether the vehicle physically fits. ~11 km/h: queue pace. */
const CREEP_SPEED = 3.0; // m/s
/** Clear road a creeping vehicle needs ahead of it before it noses in. */
const CREEP_GAP = 1.5; // m

/** What a heavy vehicle is charged for using a lane it is barred from. Large
 *  enough that any workable permitted lane outranks it. */
const RESTRICTED_LANE_PENALTY = 2.5;

/* ── Forcing in ──────────────────────────────────────────────────────────────
 *
 * A driver stopped at a taper does not wait indefinitely for a gap that
 * satisfies everyone. After a while they put their nose out and the through
 * traffic yields — which is the only reason a taper clears at all when the
 * open lane is moving faster than the queue. Without it, a stopped vehicle
 * beside a flowing lane can never merge (you cannot insert a stationary bus in
 * front of a car doing 90) and it blocks its lane for the rest of the run.
 *
 * How long they will wait is a trait, so some drivers nose out after a few
 * seconds and others hold back far longer. */
const PATIENCE_BASE_SEC = 8;

/* When forcing, the gap behind is judged as time-to-collision rather than by
 * IDM comfort: the follower must have enough road to brake in, not enough to
 * brake in comfortably. A follower at 25 m/s needs ~30 m. */
const FORCE_TTC_SEC = 1.2;

/** Hard floor on bumper-to-bumper spacing, enforced after integration purely
 *  so vehicles are never drawn through one another. Not a headway rule. */
/* Secondary-incident hazard, per primary incident per minute.
 *
 * NOT invented. gold.ml_incident_severity_metadata holds this corridor's own
 * measured figure: base_rate 0.11511 over n = 4,361 incidents — 11.5% of NLEX
 * incidents are followed by another within 2 km (secondary_km_radius) — and
 * silver.nlex_accident_events_clean gives a 22.8-minute mean clearance. A
 * constant hazard that reproduces 11.5% over a 22.8-minute exposure is
 *
 *     lambda = -ln(1 - 0.11511) / 22.8 = 0.00536 per minute
 *
 * so a scenario of average length generates a secondary 11.5% of the time,
 * which is what the corridor does. Longer incidents generate more, which is
 * also what the corridor does, and is the reason clearance time is worth
 * optimising twice over. */
const SECONDARY_PER_INCIDENT_MINUTE = 0.00536;
/** Observed radius the base rate was measured over (secondary_km_radius = 2 km). */
const SECONDARY_RADIUS_M = 2000;

const MIN_CLEARANCE = 0.5; // m

/* Base perception-reaction time. The traffic-psychology range for an expected
 * event (the car ahead's brake lights) is roughly 0.6-1.5 s; 0.9 s sits in the
 * middle of it. Scaled per driver and per temperament — see Vehicle.reactionS. */
const REACTION_BASE_SEC = 0.9;

/** Default warm-up if a config does not set one. One minute covers filling a
 *  1 km segment at motorway speed several times over. */
const DEFAULT_WARMUP_S = 60;

/** Most vehicles that may be held waiting to enter. Beyond this the surplus is
 *  reported as unmet demand instead of being stored invisibly. */
const MAX_ENTRY_QUEUE = 5;

/** Typical speed of traffic coming off an acceleration lane (m/s, ~58 km/h).
 *  Below the prevailing speed on purpose: that differential is what makes an
 *  interchange a bottleneck rather than a neutral addition of vehicles. */
const RAMP_JOIN_SPEED = 16;

/** How far ahead of their exit a driver starts working towards the outside
 *  lane. 400 m is about the point the advance sign appears. */
const EXIT_APPROACH_M = 650;

/** Pull towards the exit lane for a vehicle that is leaving soon. Scaled by
 *  how close the exit is, so it grows from a preference into a necessity. */
const LC_BIAS_EXIT = 3.4;

/** How far ahead of a barrier plaza drivers start lining up for the shorter queue. */
const PLAZA_LOOK_M = 450;
/** Pull towards a lane whose booths are less busy, m/s², at a two-vehicle difference. */
const PLAZA_QUEUE_BIAS = 1.2;

/** Hardest braking a merge may ask of the driver behind once the merging
 *  driver has waited at the line long enough to nose in. */
const MERGE_FORCED_DECEL = 6;
/* HEADWAY RELAXATION after a merge.
 *
 * Someone merges in front of you and you do not stand on the brakes to restore
 * your full following distance at once: you accept a short one and let it open
 * up over the next several seconds. Car-following models without this demand
 * the whole headway the instant the car arrives, so a merge looks safe only
 * into a gap of 80-odd metres; drivers on an acceleration lane found none in
 * busy traffic, ran to its end, stopped, and waited up to five minutes to get
 * in from a standstill. With it the merge is judged against the headway the
 * follower actually accepts, and the follower then drops back gently. */
const RELAX_S = 10;
const RELAX_MIN = 0.35;

/** Final run-in to a ramp, where a driver stops being polite about gaps. */
const EXIT_COMMIT_M = 250;

/** Slowest a committed driver will ease to while hunting for their gap, as a
 *  fraction of their desired speed. */
const EXIT_CAUTION = 0.7;

/* ── Heavy-vehicle lane restriction ──────────────────────────────────────────
 *
 * Buses and trucks (classes 2 and 3) are kept out of lane index 0 — "L1" on
 * the controls, the innermost lane, drawn at the top of the canvas. Traffic
 * here runs left to right, so lane 0 is the fast lane, and NLEX restricts it to
 * light vehicles.
 *
 * Enforced in three places, because one is not enough: the initial seeding, the
 * spawn at the entrance, and the lane-change decision. Miss the lane-change
 * check and trucks still arrive in L1 a few seconds later by merging into it;
 * miss either of the others and L1 starts the run with trucks already sitting
 * in it.
 */
const HEAVY_MIN_LANE = 1;

/** May this class travel in this lane? */
function laneAllowsClass(vClass: VehicleClass, lane: number): boolean {
  return vClass === 1 || lane >= HEAVY_MIN_LANE;
}

/** Where to draw a vehicle across the carriageway, in lane units.
 *
 *  Smoothstep rather than a straight ramp: a constant-rate slide starts and
 *  stops with a visible corner, which on a small sprite looks like a jerk at
 *  each end. Easing in and out matches how a car is actually steered across. */
/** Deterministic 0..1 from an integer id. Used where a value must be stable
 *  across frames but need not be random — a wreck's resting angle must not
 *  twitch every repaint. */
function hash01(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Does this vehicle occupy `lane` right now?
 *
 *  `v.lane` flips the instant MOBIL accepts a change, but the vehicle is
 *  physically across both lanes until `laneShift` reaches 1 — and that is how
 *  the renderer draws it. Anything reasoning about who is in the way has to
 *  agree with the picture, so it asks this rather than comparing integers.
 *  Comparing integers is what let a car spawn into a lane a 14 m truck was
 *  still halfway out of, and be drawn entirely inside it. */
export function occupiesLane(v: Vehicle, lane: number): boolean {
  return v.lane === lane || (v.laneShift < 1 && v.laneFrom === lane);
}

export function visualLane(v: Vehicle): number {
  if (v.laneShift >= 1) return v.lane;
  const t = Math.max(0, Math.min(1, v.laneShift));
  return v.laneFrom + (v.lane - v.laneFrom) * (t * t * (3 - 2 * t));
}

/** One draw from a normal distribution, clamped to [lo, hi].
 *
 *  Box–Muller off the simulation's own seeded RNG, so a given seed still
 *  replays exactly — heterogeneity must not cost reproducibility, or two runs
 *  of the same scenario stop being comparable and the baseline capture is
 *  meaningless.
 *
 *  Clamped rather than resampled: a truncated tail is the honest shape here.
 *  Nobody drives at four sigma, and an unclamped draw can go negative, which
 *  for a desired speed or a headway is not a slow driver but a broken one. */
function gauss(rng: () => number, sd: number, lo: number, hi: number): number {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.min(hi, Math.max(lo, 1 + z * sd));
}

/** The traits that make one driver differ from another of the same temperament.
 *
 *  Spread figures are the ones the traffic-flow literature reports for
 *  free-flow speed on a motorway: a roughly normal distribution with a
 *  coefficient of variation near 10%. Headway and acceleration are given a
 *  wider spread because drivers differ more in how close they sit and how hard
 *  they pull away than in the speed they are aiming for.
 *
 *  Called from both the seeding path and the spawn path. They used to build
 *  vehicles independently, and a trait added to one would silently not exist
 *  on the other — the road would behave differently at the start of a run than
 *  a minute in. */
function makeDriver(rng: () => number, vClass: VehicleClass, profile: DriverProfile) {
  const c = CLASS[vClass];
  const p = PROFILE[profile];
  return {
    // ±10%, so a calm driver may still out-run a hurried one — which is what
    // stops the three profiles reading as three fixed speeds on the canvas.
    v0: c.v0 * p.v0f * gauss(rng, c.v0Sd, 0.72, 1.3),
    T: p.T * c.tF * gauss(rng, 0.15, 0.65, 1.5),
    aMax: A_MAX * c.aF * gauss(rng, 0.13, 0.65, 1.4),
    politeness: Math.min(0.85, Math.max(0, p.politeness * gauss(rng, 0.25, 0.3, 1.9))),
    // Size sets the scale, temperament nudges it, and the draw keeps two
    // identical trucks from steering in lockstep.
    lcSec: c.lcSec * p.lcf * gauss(rng, 0.12, 0.72, 1.35),
    scanSec: SCAN_BASE_SEC * p.scanf * gauss(rng, 0.3, 0.45, 1.9),
    // Random phase. Without it every driver created in the same frame would
    // glance in unison, which just moves the lockstep rather than removing it.
    scanTimer: SCAN_BASE_SEC * rng(),
    patience: PATIENCE_BASE_SEC * p.pat * gauss(rng, 0.25, 0.5, 1.8),
    reactionS: REACTION_BASE_SEC * p.react * gauss(rng, 0.22, 0.5, 1.7),
    // Random phase again: without it every driver blinks at the same instant
    // and the lag produces one synchronised shockwave instead of many.
    reactTimer: REACTION_BASE_SEC * rng(),
  };
}

// Blend two hex colours; t=0 → a, t=1 → b.
export function mixHex(a: string, b: string, t: number): string {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

// A per-agent shade: the class hue nudged lighter or darker, so same-class
// vehicles look individual without losing the family colour that marks class.
function varyColor(hex: string, r: number): string {
  const t = (r - 0.5) * 0.3; // -0.15 .. +0.15
  return t >= 0 ? mixHex(hex, "#ffffff", t) : mixHex(hex, "#0b1226", -t);
}

/** Who is waiting to enter the road: their class, temperament, the traits drawn for them and where they are headed, fixed once. */
type Arrival = { vClass: VehicleClass; profile: DriverProfile; d: ReturnType<typeof makeDriver>; exitAtX: number | null };

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TrafficSim {
  cfg: SimConfig;
  vehicles: Vehicle[] = [];
  /** The hard shoulder: responders running past the traffic to a scene, and vehicles stopped on it. In no lane. */
  shoulder: Vehicle[] = [];
  /** The shoulder's number as a lane: one past the outer lane (laneFrom / lane while crossing to or from it). */
  get shoulderLane(): number {
    return this.cfg.laneCount;
  }
  /** Scenes being made out of the traffic, and standing (crashAt). */
  private scenes: CrashScene[] = [];
  private sceneSeq = 0;
  /** The incidents that are obstacles this step: one whose vehicles are still on their way to it is not there yet. */
  private liveIncidents: Interventions["incidents"] = [];
  /** Responders waiting to come across into a lane this step: the traffic coming up in it holds back and lets them in. */
  private yieldTo: { lane: number; x: number; len: number }[] = [];
  interventions: Interventions;
  time = 0;
  private rng: () => number;
  private nextId = 1;
  private spawnAccumulator = 0;
  /**
   * An arrival the entrance refused, kept whole for the retry — its class AND its driver.
   *
   * The credit for a refused arrival was given back but the arrival itself was drawn afresh next tick, and the gap
   * test depends on what was drawn: a long vehicle, or a driver who keeps a long headway, needs a bigger gap. So the
   * queue at the entrance filtered the fleet. A truck turned away came back as a car about nine times in ten, and a
   * cautious driver came back as an aggressive one. Measured: Class 3 was 8% of arrivals against 14% configured, and
   * half the trucks that did get on were the short-headway "aggressive" type against 15% of the population, which
   * cancelled any difference in how a truck drives from a car and made the fleet mix a function of entrance
   * congestion rather than of the forecast. A refused arrival now waits as who it was. The mainline entrance keeps a
   * short queue that whoever fits leaves in order of arrival; each on-ramp has a single lane, so a single place in line.
   */
  private waiting: Arrival[] = [];
  private rampPendingArrival: (Arrival | null)[] = [];

  /**
   * Vehicles per lane, ordered by position, rebuilt once per step.
   *
   * Finding the vehicle in front used to scan every vehicle on the road, and
   * it is asked several times per vehicle per step — its own lane, each
   * candidate lane during a lane-change decision, and the prospective follower
   * in that lane. That is quadratic, and at corridor length it dominated: 980
   * vehicles cost 22 ms a step, so the animation could not keep up before any
   * drawing had happened. One sort per lane per step makes each lookup a binary
   * search instead.
   */
  private laneIndex: Vehicle[][] = [];

  private rebuildLaneIndex() {
    const lanes = this.cfg.laneCount;
    this.laneIndex = Array.from({ length: lanes }, () => [] as Vehicle[]);
    for (const v of this.vehicles) {
      if (v.lane >= 0 && v.lane < lanes) this.laneIndex[v.lane].push(v);
    }
    /* A vehicle on a taper is half off the carriageway, but the half that is
     * still on it is in the outer lane, and the car behind has to see it. Putting
     * it in the index is all that takes: every leader, follower and gap lookup
     * reads from here, so the traffic slows for an exiting car and leaves room
     * for a merging one without any of those decisions knowing facilities exist. */
    if (this.fac.list.length > 0) {
      for (const s of this.fac.shadows()) {
        const l = s.fac!.shadowLane;
        if (l >= 0 && l < lanes) this.laneIndex[l].push(s);
      }
    }
    for (const row of this.laneIndex) row.sort((a, b) => a.x - b.x);
  }

  /** First vehicle in `lane` strictly beyond `x`, or null. */
  private firstAfter(lane: number, x: number, exclude?: Vehicle): Vehicle | null {
    const row = this.laneIndex[lane];
    if (!row || row.length === 0) return null;
    let lo = 0;
    let hi = row.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (row[mid].x > x) hi = mid;
      else lo = mid + 1;
    }
    for (let i = lo; i < row.length; i++) if (row[i] !== exclude) return row[i];
    return null;
  }

  /** Last vehicle in `lane` strictly before `x`, or null. */
  private lastBefore(lane: number, x: number, exclude?: Vehicle): Vehicle | null {
    const row = this.laneIndex[lane];
    if (!row || row.length === 0) return null;
    let lo = 0;
    let hi = row.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (row[mid].x < x) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo - 1; i >= 0; i--) if (row[i] !== exclude) return row[i];
    return null;
  }
  private completedTimes: number[] = []; // travel times, rolling
  private completedInWindow: number[] = []; // completion timestamps, rolling
  private co2Window: { t: number; g: number }[] = [];
  private readonly warmupS: number;
  /** Ramps, sorted by position so a vehicle's exit can be picked in one pass. */
  private readonly ramps: RampSpec[];
  /** Toll plazas and service areas, with their own vehicles. */
  readonly fac: FacilityEngine;
  private rampAccumulator: number[] = [];
  /** Vehicles asked for, and vehicles actually let on, since the warm-up. */
  private demanded = 0;
  private admitted = 0;

  /** Class kinematics for THIS run: the defaults, with any warehouse values
   *  laid over them. Shares are renormalised so a partial override cannot make
   *  pickClass fall off the end of the distribution. */
  private readonly cls: Record<VehicleClass, { v0: number; len: number; co2PerM: number; color: string; share: number }>;

  constructor(cfg: SimConfig, interventions?: Partial<Interventions>) {
    this.cfg = cfg;
    {
      const base = { 1: { ...CLASS[1] }, 2: { ...CLASS[2] }, 3: { ...CLASS[3] } } as Record<
        VehicleClass,
        { v0: number; len: number; co2PerM: number; color: string; share: number }
      >;
      const over = cfg.classProfile;
      if (over) {
        for (const k of [1, 2, 3] as VehicleClass[]) {
          const o = over[k];
          if (!o) continue;
          if (typeof o.co2PerM === "number" && o.co2PerM > 0) base[k].co2PerM = o.co2PerM;
          if (typeof o.share === "number" && o.share >= 0) base[k].share = o.share;
        }
        const sum = base[1].share + base[2].share + base[3].share;
        if (sum > 0) for (const k of [1, 2, 3] as VehicleClass[]) base[k].share /= sum;
      }
      this.cls = base;
    }
    this.warmupS = cfg.warmupS ?? DEFAULT_WARMUP_S;
    this.fac = new FacilityEngine(cfg.facilities ?? [], this.facilityHost());
    /* A facility's diverge is an exit like any other as far as choosing one
     * goes, so it joins the same list: drivers are assigned it at entry with
     * its turning share, and work across to the outer lane for it with the same
     * bias. Only what happens AT it differs — see takeExits. Its on-ramp is not
     * listed, because its arrivals come down its own approach road instead of
     * appearing at a point. */
    const facilityExits: RampSpec[] = this.fac.list
      .filter((f) => f.divergeX != null)
      .map((f) => ({ x: f.divergeX!, onVehPerHour: 0, offFraction: f.spec.turnFraction ?? 0, name: f.spec.name }));
    // Sorted so pickExit can walk them in order and stop at the first one past
    // the vehicle; unsorted, a vehicle could be assigned an exit behind it.
    this.ramps = [...(cfg.ramps ?? []), ...facilityExits].sort((a, b) => a.x - b.x);
    this.rampAccumulator = this.ramps.map(() => 0);
    this.rng = mulberry32(cfg.seed);
    this.interventions = {
      closedLanes: Array(cfg.laneCount).fill(false),
      closurePoint: cfg.length * 0.55,
      closureEnd: cfg.length,
      incidents: [],
      speedLimitKmh: null,
      speedZone: [cfg.length * 0.35, cfg.length * 0.75],
      ...interventions,
    };
    this.prefill();
    // Nothing is seeded inside a barrier plaza: everything there is driving
    // through booths, which the seeding knows nothing about.
    if (this.fac.list.some((f) => f.laneEntries)) {
      this.vehicles = this.vehicles.filter((v) => !this.fac.barrierAt(v.x) && !this.fac.barrierAt(v.x - v.length));
    }
  }

  /* What the facility layer is allowed to do to this simulation.
   *
   * One IDM, one RNG, one fleet: a vehicle at a booth follows the car in front
   * by exactly the rule it used on the expressway a minute earlier, and an
   * arrival off a local road is drawn from the same class mix as everyone
   * else, so a plaza cannot quietly run on different physics or a different
   * fleet from the road it serves. */
  private facilityHost(): FacilityHost {
    return {
      laneCount: this.cfg.laneCount,
      s0: S0,
      minClear: MIN_CLEARANCE,
      now: () => this.time,
      rng: () => this.rng(),
      idm: (v, gap, leadV, v0, T) => {
        const free = v.aMax * (1 - Math.pow(v.v / Math.max(1, v0), DELTA));
        if (gap == null) return free;
        const sStar = S0 + Math.max(0, v.v * (T ?? v.T) + (v.v * (v.v - leadV)) / (2 * Math.sqrt(v.aMax * B_COMF)));
        return free - v.aMax * Math.pow(sStar / Math.max(0.1, gap), 2);
      },
      neighbours: (lane, x) => {
        let ahead: Vehicle | null = null;
        let behind: Vehicle | null = null;
        for (const o of this.vehicles) {
          if (!occupiesLane(o, lane)) continue;
          if (o.x >= x) { if (!ahead || o.x < ahead.x) ahead = o; }
          else if (!behind || o.x > behind.x) behind = o;
        }
        return { ahead, behind };
      },
      joinSafe: (v, lane, x, urgency) => this.facilityJoinSafe(v, lane, x, urgency),
      newVehicle: (u) => this.facilityArrival(u),
      admit: (v, lane, x, from, slide) => this.admitFromFacility(v, lane, x, from, slide),
      leave: () => {},
      length: this.cfg.length,
      pastEnd: (v, from) => {
        // Back on the expressway beyond the stretch after a stop for fuel: that
        // trip went through it. An arrival off a local road never drove it.
        if (from.spec.kind === "service_area" && v.role === "traffic") {
          this.completedTimes.push(this.time - v.spawnTime);
          this.completedInWindow.push(this.time);
        }
      },
      emit: (v, dist, dt) => this.emit(v, dist, dt),
    };
  }

  /* Gap acceptance from an acceleration lane.
   *
   * The lane-change test, applied to a driver alongside the outer lane: room
   * in front and behind, and MOBIL's safety criterion — the driver it would
   * cut in front of must not have to brake harder than B_SAFE. Asked every
   * step along the lane, so a driver who has got up to speed takes the first
   * gap that is there, as on a real on-ramp. As the lane runs out they take
   * tighter gaps, exactly as a driver closing on their exit does (see
   * exitPressure), up to nosing in on the zipper allowance at the very end. */
  private facilityJoinSafe(v: Vehicle, lane: number, x: number, urgency: number): boolean {
    let ahead: Vehicle | null = null;
    let behind: Vehicle | null = null;
    for (const o of this.vehicles) {
      if (!occupiesLane(o, lane)) continue;
      if (o.x >= x) { if (!ahead || o.x < ahead.x) ahead = o; }
      else if (!behind || o.x > behind.x) behind = o;
    }
    const bSafe = B_SAFE + (MERGE_FORCED_DECEL - B_SAFE) * urgency;
    const room = S0 * (1 - 0.4 * urgency);
    if (ahead) {
      const g = ahead.x - ahead.length - x;
      if (g < room) return false;
      if (this.idmAccelAgainst(v, ahead.x, ahead.v, ahead.length) < -bSafe) return false;
    }
    if (behind) {
      const g = x - v.length - behind.x;
      if (g < room) return false;
      if (this.idmAccelAgainst(behind, x, v.v, v.length, behind.T * RELAX_MIN) < -bSafe) return false;
    }
    return true;
  }

  /** Someone arriving off a local road at an entry plaza: the same draw as any other arrival. */
  private facilityArrival(u: number): Vehicle {
    const { vClass, profile, d } = this.newArrival(null);
    const c = this.cls[vClass];
    return {
      id: this.nextId++, lane: -1, x: u, v: 0, vClass, profile,
      v0: d.v0, T: d.T, aMax: d.aMax, politeness: d.politeness, lcSec: d.lcSec,
      scanSec: d.scanSec, scanTimer: d.scanTimer, patience: d.patience, stuckFor: 0,
      reactionS: d.reactionS, reactTimer: d.reactTimer, accel: 0,
      exitAtX: null, length: c.len, spawnTime: this.time, co2: 0,
      laneCooldown: 0, laneFrom: -1, laneShift: 1,
      color: varyColor(c.color, this.rng()),
      role: "traffic",
    };
  }

  /* Back onto the carriageway at the end of a merge taper or a barrier's fan.
   *
   * Only into physical room — the facility's own car-following has already
   * kept it behind whoever is in the lane, so this is the last check, not the
   * gap decision. What the trip means afterwards depends on where it came
   * from: off an entry plaza it is a new trip, from a service area it is the
   * same trip resumed (the stop is not time on the expressway), and through a
   * barrier it never stopped being the same trip. */
  private admitFromFacility(v: Vehicle, lane: number, x: number, from: Facility, slide = false): boolean {
    for (const o of this.vehicles) {
      if (!occupiesLane(o, lane)) continue;
      if (o.x >= x) { if (o.x - o.length - x < MIN_CLEARANCE) return false; }
      else if (x - v.length - o.x < MIN_CLEARANCE) return false;
    }
    const inside = this.time - (v.fac?.enteredAt ?? this.time);
    v.fac = undefined;
    v.heldAtGore = false;
    v.lane = lane;
    if (slide) {
      // Whoever it pulls in front of accepts the shorter gap and drops back gently (RELAX_S).
      let behind: Vehicle | null = null;
      for (const o of this.vehicles) if (occupiesLane(o, lane) && o.x < x && (!behind || o.x > behind.x)) behind = o;
      if (behind) behind.relaxUntil = this.time + RELAX_S;
    }
    // Merging from the acceleration lane: it is the lane beyond this one, so
    // the move across is drawn as a lane change from there.
    v.laneFrom = slide ? lane + 1 : lane;
    v.laneShift = slide ? 0 : 1;
    v.x = x;
    v.stuckFor = 0;
    // Settle into the lane before the first look for another one.
    v.laneCooldown = v.lcSec + LC_SETTLE_SEC;
    v.reactTimer = 0;
    if (from.spec.kind === "entry_ramp") {
      v.spawnTime = this.time;
      v.exitAtX = this.pickExit(x);
    } else if (from.spec.kind === "service_area") {
      v.spawnTime += inside;
      v.exitAtX = this.pickExit(x);
    } else if (v.exitAtX != null && v.exitAtX <= x) {
      v.exitAtX = this.pickExit(x);
    }
    this.vehicles.push(v);
    return true;
  }

  /** Per-facility queue and throughput, for the canvas and the panel. */
  facilityStats(): FacilityStats[] {
    return this.fac.stats();
  }

  /* A scenario event at a plaza or service area.
   *
   * Made of what is there, as on the carriageway: the vehicle at the booth
   * (and, for a collision, the one behind it) becomes the scene; only if the
   * booth lane is empty is a vehicle brought in, at the booth line. The booth
   * shuts, so the queue behind it squeezes into the next lanes and the plaza
   * loses that booth's share of its capacity — and if that is more than the
   * plaza can spare, the queue backs up the ramp and onto the expressway on
   * its own. Then the response is sent: a tow drives in the way any vehicle
   * would — off the expressway at the gore, or down the local road into an
   * entry plaza — and stops behind the scene. Roadworks are a crew shutting
   * booths, with a works truck parked in the lane instead. */
  facilityEventStart(sceneKey: string, site: { facilityId: string; kind: "booth" | "pump" | "approach"; stations: readonly number[] }, family: string, respondS?: number): boolean {
    const f = this.fac.get(site.facilityId);
    if (!f) return false;
    const works = family === "scheduled_roadworks";
    const breakdown = family === "breakdown_in_lane" || family === "breakdown_shoulder";
    const want = works ? 0 : family === "multi_vehicle_collision" ? 3 : family === "minor_collision" ? 2 : 1;
    // Made of the vehicles in the plaza: those there are brought to rest, and with none there the next to arrive is.
    if (site.kind === "approach") {
      this.fac.strandOnApproach(f.spec.id, Math.max(1, want), sceneKey, !breakdown);
    } else {
      site.stations.forEach((st, i) => {
        if (i === 0 && want > 0) this.fac.strandAt(f.spec.id, st, want, sceneKey, !breakdown);
        else this.fac.closeStation(f.spec.id, st, sceneKey);
      });
    }
    const station = site.kind === "approach" ? null : site.stations[0] ?? null;
    /* `afterS` counts from the moment the scene EXISTS (its first vehicle at rest), not from the event's start. On a
       fixed clock from the start, the police were on the road at six seconds for a crash that formed at forty-three,
       and on a quiet plaza where no vehicle ever came to the booth all three still drove in, stood at an empty booth
       for the whole event and left. A works crew is not answering anything: it goes at once. */
    const call = (kind: ResponderKind, afterS: number, waits: boolean) =>
      this.pendingFacilityResponders.push({ kind, fid: f.spec.id, station, at: waits ? Infinity : this.time + afterS, afterS, sceneKey });
    if (works) call("works", 0, false);
    else {
      // The drive in from the edge of the picture is about three-quarters of a minute; the rest is the wait.
      const first = Math.max(RESPONSE_CALL_S, (respondS ?? 60) - 45);
      // A crash at a booth or a pump is still a crash: the police, an ambulance, then the recovery.
      if (!breakdown) {
        call("police", first, true);
        call("ambulance", first + 8, true);
      }
      call("tow", breakdown ? first : first + 45, true);
    }
    return true;
  }

  /** The scene at a plaza is over: booths reopen, the wreck is towed off, responders leave. */
  facilityEventEnd(sceneKey: string): void {
    this.fac.releaseScene(sceneKey);
    this.releaseScene(sceneKey);
    this.pendingFacilityResponders = this.pendingFacilityResponders.filter((r) => r.sceneKey !== sceneKey);
  }

  /** Responders on their way to a scene in a plaza or service area. */
  private pendingFacilityResponders: { kind: ResponderKind; fid: string; station: number | null; at: number; afterS: number; sceneKey: string }[] = [];

  /* Send them in the way traffic gets there. Into an entry plaza they come
   * down its local road; to an exit plaza or a service area they enter the
   * segment like anything else and leave the expressway at its gore; to a
   * barrier they come up the lane that feeds the booth. */
  private releaseFacilityResponders() {
    if (this.pendingFacilityResponders.length === 0) return;
    const still: typeof this.pendingFacilityResponders = [];
    for (const r of this.pendingFacilityResponders) {
      const f = this.fac.get(r.fid);
      if (!f) continue;
      // Waiting for there to be a scene: its clock starts when the first vehicle of it is at rest.
      if (r.at === Infinity) {
        if (this.fac.sceneLane(r.sceneKey) !== undefined) r.at = this.time + r.afterS;
        still.push(r);
        continue;
      }
      if (this.time < r.at) { still.push(r); continue; }
      const v = this.makeResponder(r.kind, r.sceneKey);
      /* A scene on a barrier's approach is in ONE of the lanes fanning into the booths. Sent "to the approach" with
         no lane, the ambulance and the recovery truck took whichever fan lane was shortest, drove past the crash,
         through a booth and away. They go to the lane the casualty is standing in. */
      const station = r.station ?? (f.laneEntries ? this.fac.sceneLane(r.sceneKey) ?? null : null);
      v.facTarget = { fid: r.fid, station };
      if (f.spawnPath != null) {
        if (!this.fac.enterFromLocalRoad(f, v)) still.push(r);
        continue;
      }
      const want = f.laneEntries
        ? (station != null ? this.fac.laneOfStation(f, station) : null) ?? this.exitLane
        : this.exitLane;
      /* Room at the entrance: in the lane it wants, or — going to an exit plaza or a service area, which it reaches
         by working across like any driver leaving — in any lane. Held to one lane, it waited behind a queue that
         reached back to the entrance and never came; a barrier's booth lane is the exception, it must be that one. */
      const gapIn = (l: number): number => {
        let lead: Vehicle | null = null;
        for (const o of this.vehicles) {
          if (!occupiesLane(o, l)) continue;
          if (!lead || o.x < lead.x) lead = o;
        }
        return lead ? lead.x - lead.length : Infinity;
      };
      const lanes = f.laneEntries ? [want] : [want, ...Array.from({ length: this.cfg.laneCount }, (_, l) => l).filter((l) => l !== want).sort((a, b) => Math.abs(a - want) - Math.abs(b - want))];
      /* The lane it leaves the expressway from, if there is room there within a few seconds; only then any other.
         Put straight into an inner lane, a recovery truck did not get across four lanes of traffic before the exit
         and drove on past the plaza it was sent to. */
      const lane = gapIn(want) >= S0 + 6 ? want : this.time - r.at < 12 ? undefined : lanes.find((l) => gapIn(l) >= S0 + 6);
      if (lane === undefined) { still.push(r); continue; }
      const gapAhead = gapIn(lane);
      v.lane = lane;
      v.laneFrom = lane;
      v.x = 0;
      v.v = Math.min(v.v0, gapAhead > 60 ? 20 : 10);
      v.exitAtX = f.divergeX;
      this.vehicles.push(v);
    }
    this.pendingFacilityResponders = still;
  }

  private makeResponder(kind: ResponderKind, sceneKey: string): Vehicle {
    const urgent = kind !== "works";
    const len = kind === "tow" ? 9 : kind === "works" ? 8 : 6.5;
    return {
      id: this.nextId++, lane: -1, x: 0, v: 0, vClass: 2, profile: "normal",
      v0: urgent ? 24 : 16, T: urgent ? 0.8 : 1.6, aMax: urgent ? 2.0 : 1.1, politeness: urgent ? 0 : 0.4, lcSec: 1.3,
      scanSec: 0.5, scanTimer: 0, reactionS: 0.5, reactTimer: 0, accel: 0,
      patience: 2, exitAtX: null, stuckFor: 0,
      length: len, spawnTime: this.time, co2: 0, laneCooldown: 0,
      laneFrom: -1, laneShift: 1,
      color: kind === "police" ? "#1d4ed8" : kind === "ambulance" ? "#e2e8f0" : "#f59e0b",
      role: "responder", responderKind: kind, sceneKey,
    };
  }

  /**
   * Put traffic on the road before the first step.
   *
   * Vehicles only ever enter at x = 0, so a freshly built simulation was an
   * empty carriageway that filled from the left at traffic speed: about 13
   * seconds for a 280 m stretch, 52 for a kilometre. Since changing the
   * segment, the lane count or the route rebuilds the simulation, an operator
   * adjusting any of those watched an empty road and reasonably concluded it
   * had broken.
   *
   * The road is seeded at the headway the configured inflow implies, so it
   * starts in roughly the state it would have converged to anyway. Interventions
   * are not applied here — a closure should be seen to cause its queue, not
   * begin with one — so a closed lane simply starts empty.
   */
  private prefill() {
    const lanes = this.cfg.laneCount;
    const openLanes = Array.from({ length: lanes }, (_, i) => i).filter(
      (i) => !this.interventions.closedLanes[i],
    );
    if (openLanes.length === 0) return;

    // Equilibrium headway: seconds between vehicles in one lane at this flow.
    const perLanePerSec = this.cfg.inflowVehPerHour / 3600 / openLanes.length;
    if (perLanePerSec <= 0) return;
    const headwaySec = 1 / perLanePerSec;

    for (const lane of openLanes) {
      // Stagger lanes so the seed does not read as a grid of rows.
      let x = this.cfg.length - this.rng() * headwaySec * 20;
      while (x > 0) {
        // A closed stretch starts empty even in an open lane's neighbour — a
        // vehicle seeded inside the works would be there before the closure
        // caused anything.
        if (this.closedHere(lane, x)) {
          x -= 10;
          continue;
        }
        // Lane 0 seeds light vehicles only. Chosen outright rather than drawn
        // and rejected: a reject-and-retry loop is unbounded in principle, and
        // the answer here is not a matter of chance.
        const vClass: VehicleClass = lane < HEAVY_MIN_LANE ? 1 : this.pickClass();
        const profile = this.pickProfile();
        const c = this.cls[vClass];
        const d = makeDriver(this.rng, vClass, profile);
        const v0 = d.v0;
        const v = v0 * (0.85 + 0.15 * this.rng());
        this.vehicles.push({
          id: this.nextId++,
          lane,
          x,
          v,
          vClass,
          profile,
          v0,
          T: d.T,
          aMax: d.aMax,
          politeness: d.politeness,
          lcSec: d.lcSec,
          scanSec: d.scanSec,
          scanTimer: d.scanTimer,
          patience: d.patience,
          stuckFor: 0,
          reactionS: d.reactionS,
          reactTimer: d.reactTimer,
          accel: 0,
          // Already in a lent lane: through traffic, which leaves the expressway after the far crossover if at all.
          exitAtX: this.cfg.borrowed && lane < this.cfg.borrowed.lanes ? this.pickExit(this.cfg.length - this.cfg.borrowed.crossM) : this.pickExit(0),
          length: c.len,
          // Negative so the first throughput readings are not skewed by a
          // cohort that appears to have crossed the segment instantly.
          spawnTime: -(this.cfg.length - x) / Math.max(1, v),
          co2: 0,
          laneCooldown: 0,
          laneFrom: lane,
          laneShift: 1,
          color: varyColor(c.color, this.rng()),
          role: "traffic",
        });
        // Spacing from the headway, never closer than the car-following model
        // would tolerate.
        const gap = Math.max(v * headwaySec, c.len + S0 + 2);
        x -= gap * (0.85 + 0.3 * this.rng());
      }
    }
  }

  private pickClass(): VehicleClass {
    const r = this.rng();
    if (r < this.cls[1].share) return 1;
    if (r < this.cls[1].share + this.cls[2].share) return 2;
    return 3;
  }

  private pickProfile(): DriverProfile {
    const r = this.rng();
    return r < 0.25 ? "cautious" : r < 0.85 ? "normal" : "aggressive";
  }

  /** `entryX` is where they join, for choosing a destination downstream of it; null for a joiner whose destination is chosen at the ramp. */
  private newArrival(entryX: number | null = null): Arrival {
    const vClass = this.pickClass();
    const profile = this.pickProfile();
    const d = makeDriver(this.rng, vClass, profile);
    return { vClass, profile, d, exitAtX: entryX == null ? null : this.pickExit(entryX) };
  }

  private spawn(lane: number, arrival: Arrival, exitAtX: number | null = null) {
    const { vClass, profile, d } = arrival;
    const c = this.cls[vClass];

    /* Enter at the speed of the traffic already in the lane.
     *
     * Previously a fixed 0.6-0.9 of 22 m/s regardless of what was in front.
     * Joining a moving carriageway at an unrelated speed is not how traffic
     * enters a segment, and the mismatch was doing real damage downstream —
     * see the gap test below. */
    /* Scanned live, NOT through the lane index.
     *
     * The index is rebuilt once per step, so several spawns inside the same
     * tick would every one of them see the road as it was before any of them
     * arrived, and all pile onto x = 0 on top of each other. */
    let lead: Vehicle | null = null;
    for (const other of this.vehicles) {
      if (!occupiesLane(other, lane)) continue;
      if (!lead || other.x < lead.x) lead = other;
    }
    const enterV = Math.min(d.v0, lead ? Math.max(lead.v, 4) : d.v0);

    /* Refuse unless the gap is one this vehicle could actually take.
     *
     * The old test was a fixed 11 m of clearance, which is a parking
     * distance, not a driving one. A car entering at 15 m/s into an 11 m gap
     * is 17 m inside its own safe headway, so IDM answered with about
     * -127 m/s², the vehicle emergency-stopped a few metres in, and it then
     * blocked the entrance for everyone behind it. That single line was
     * capping the whole model: measured capacity was ~1,100 veh/h/lane
     * against a real motorway's ~2,000, and above 1,200 veh/h/lane of demand
     * served flow COLLAPSED instead of saturating, with 978 vehicles quietly
     * queued in an accumulator that nothing ever drew.
     *
     * The requirement is the IDM equilibrium spacing at the entry speed —
     * exactly the gap the vehicle will settle at anyway — so a vehicle is
     * admitted only when the road in front of it can already support it. */
    /* Measured from the LEADER'S REAR, not its nose.
     *
     * `lead.x` is where the leader's front bumper is; its body runs back to
     * lead.x - lead.length. Comparing against the spawner's own length let a
     * car in behind a 14 m truck whose tail was still at x = -4: the nose
     * looked 10 m clear, the tail was across the entrance line, and the new
     * car was then pinned at x = 0 by the floor below with 3.8 m of truck
     * drawn through it. Every residual overlap in the diagnostic was this
     * one case. The gap that matters is bumper to bumper. */
    const gapAhead = lead ? lead.x - lead.length : Infinity;
    if (gapAhead < S0 + enterV * d.T) return false;

    this.vehicles.push({
      id: this.nextId++,
      lane,
      x: 0,
      v: enterV,
      vClass,
      profile,
      v0: d.v0,
      T: d.T,
      aMax: d.aMax,
      politeness: d.politeness,
      lcSec: d.lcSec,
      scanSec: d.scanSec,
      scanTimer: d.scanTimer,
      patience: d.patience,
      stuckFor: 0,
      reactionS: d.reactionS,
      reactTimer: d.reactTimer,
      accel: 0,
      exitAtX,
      length: c.len,
      spawnTime: this.time,
      co2: 0,
      laneCooldown: 0,
      laneFrom: lane,
      laneShift: 1,
      color: varyColor(c.color, this.rng()),
      role: "traffic",
    });
    return true;
  }

  /* Every lane closure on the road now: the one in closedLanes / closurePoint / closureEnd (the operator's, or the
   * first scenario event's laid over it), then each further one in `closures`. Built once per step and kept, since
   * every vehicle asks several times a step; step() clears it, as interventions only change between steps. */
  private closureCache: readonly LaneClosure[] | null = null;
  private closureList(): readonly LaneClosure[] {
    if (this.closureCache) return this.closureCache;
    const iv = this.interventions;
    const list: LaneClosure[] = [];
    if (iv.closedLanes.some(Boolean)) list.push({ lanes: iv.closedLanes, from: iv.closurePoint, to: iv.closureEnd });
    for (const c of iv.closures ?? []) if (c.lanes.some(Boolean) && c.to > c.from) list.push(c);
    this.closureCache = list;
    return list;
  }
  /** Is this point of this lane inside a closed stretch? */
  private closedHere(lane: number, x: number): boolean {
    return this.closureList().some((c) => c.lanes[lane] && x >= c.from && x <= c.to);
  }
  /** Is this lane closed somewhere a driver at x still has to get past? (What one closure used to mean: closed, and x short of its end.) */
  private laneBlockedFor(lane: number, x: number): boolean {
    return this.closureList().some((c) => c.lanes[lane] && x < c.to);
  }
  /** The nearest closure in this lane still to be reached from x (its start ahead), or null. */
  private nextClosureIn(lane: number, x: number): LaneClosure | null {
    let best: LaneClosure | null = null;
    for (const c of this.closureList()) if (c.lanes[lane] && x < c.from && x < c.to && (best === null || c.from < best.from)) best = c;
    return best;
  }
  /** The speed limit at x, km/h: the lowest of every zone it is in; null outside them all. */
  private speedCapAt(x: number): number | null {
    const { speedLimitKmh, speedZone, speedZones } = this.interventions;
    let cap: number | null = speedLimitKmh != null && x >= speedZone[0] && x <= speedZone[1] ? speedLimitKmh : null;
    for (const z of speedZones ?? []) if (x >= z.from && x <= z.to && (cap === null || z.kmh < cap)) cap = z.kmh;
    return cap;
  }

  // Desired speed at a position, honouring every speed-limit zone it is in.
  private desiredSpeed(v: Vehicle): number {
    const cap = this.speedCapAt(v.x);
    let v0 = v.v0;
    if (cap != null) {
      v0 = Math.min(v0, cap / 3.6);
    }
    v0 *= this.mergeCaution(v);
    v0 *= this.exitCaution(v);
    return v0;
  }

  /** Speed factor for a driver running out of road before their exit.
   *
   *  Measured cause: of the drivers who missed their interchange, 47 of 68
   *  were sitting in the lane NEXT to the exit lane when they sailed past it.
   *  They were not lost, and they were not being refused by the bias — they
   *  simply never found a gap, because the outer lane is the busiest one and
   *  they were travelling at the same speed as it. Two vehicles side by side
   *  at the same speed never produce a gap between them.
   *
   *  What a real driver does is lift off and slot in behind someone. Easing
   *  their desired speed does exactly that through the existing car-following:
   *  they drop back, a gap opens alongside, and the lane-change decision that
   *  was already trying to fire finally passes its safety test.
   *
   *  It also produces the weaving slowdown around interchanges, which is a
   *  real effect and the main reason a junction is a bottleneck rather than
   *  just a place where vehicles are added and removed. */
  private exitCaution(v: Vehicle): number {
    if (v.exitAtX == null) return 1;
    if (v.lane === this.exitLane) return 1; // already in the right place
    const toGo = v.exitAtX - v.x;
    if (toGo < 0 || toGo > EXIT_COMMIT_M) return 1;
    const pressure = 1 - toGo / EXIT_COMMIT_M;
    return 1 - (1 - EXIT_CAUTION) * pressure;
  }

  /** Speed factor for a driver approaching someone else's lane drop.
   *
   *  Applies in the OPEN lanes next to a closure, over the same merge zone the
   *  merging traffic uses, ramping from 1 far upstream to MERGE_CAUTION at the
   *  taper. The vehicle in the closed lane is not slowed here — it already has
   *  the taper itself as a stopped obstacle, and doubling that up would brake
   *  it twice for the same thing.
   *
   *  Because this slows the receiving lane, its own followers slow in turn, so
   *  the disturbance propagates outward and upstream through ordinary
   *  car-following rather than being painted on lane by lane. */
  private mergeCaution(v: Vehicle): number {
    // Each closure ahead with a lane beside this one closed; the most cautious of them.
    let factor = 1;
    for (const c of this.closureList()) {
      if (v.x > c.from || v.x > c.to) continue;
      if (c.lanes[v.lane]) continue; // the taper already governs this one
      const adjacentClosed = Boolean(c.lanes[v.lane - 1]) || Boolean(c.lanes[v.lane + 1]);
      if (!adjacentClosed) continue;
      const urgency = Math.max(0, Math.min(1, 1 - (c.from - v.x) / MERGE_ZONE_M));
      factor = Math.min(factor, 1 - (1 - MERGE_CAUTION) * urgency);
    }
    return factor;
  }

  // Gap + relative speed to whatever is ahead in a given lane: real leader,
  // an incident, or a lane-closure taper. Returns null if the road is clear.
  private leaderAhead(v: Vehicle, lane: number): { gap: number; dv: number } | null {
    // `x` is the front bumper; track the front of the nearest thing ahead
    // (`bestX`) and its length (`leadLen`) so the bumper-to-bumper gap is
    // measured to the leader's REAR — not miscounted through our own body.
    let bestX = Infinity;
    let leadV = 0;
    let leadLen = 0;
    // real vehicles — nearest ahead, from the per-lane index
    {
      const o = this.firstAfter(lane, v.x, v);
      if (o) {
        bestX = o.x;
        leadV = o.v;
        leadLen = o.length;
      }
    }
    // incidents (stopped obstacles) in this lane
    for (const inc of this.liveIncidents) {
      if (inc.lane === lane && inc.x > v.x && inc.x < bestX) {
        bestX = inc.x;
        leadV = 0;
        leadLen = INCIDENT_LENGTH;
      }
    }
    /* A responder waiting to come across into this lane: the traffic coming up behind the gap holds back for it, as
       drivers do for the lights. Without this an ambulance stood beside a stream of cars that never left it a gap. */
    if (v.role === "traffic" && !v.doom) {
      for (const y of this.yieldTo) {
        if (y.lane === lane && y.x - y.len - 1.5 > v.x && y.x < bestX) {
          bestX = y.x;
          leadV = 0;
          leadLen = y.len + 1.5;
        }
      }
    }
    // A closure acts as a stopped obstacle at its taper — but only for traffic
    // that has not already passed the far end. Without the second test a
    // vehicle that has cleared the works still braked for a barrier behind it.
    for (const c of this.closureList()) {
      if (this.passesClosure(v, c, lane)) continue;
      if (c.lanes[lane] && v.x < c.to && c.from > v.x && c.from < bestX) {
        bestX = c.from;
        leadV = 0;
        leadLen = 0;
      }
    }
    if (!isFinite(bestX)) return null;
    const gap = bestX - v.x - leadLen;
    return { gap: Math.max(0.1, gap), dv: v.v - leadV };
  }

  /** This driver's time headway now: shortened just after someone merged in front of them, easing back. */
  private headwayOf(v: Vehicle): number {
    if (v.relaxUntil == null || this.time >= v.relaxUntil) return v.T;
    const done = 1 - (v.relaxUntil - this.time) / RELAX_S;
    return v.T * (RELAX_MIN + (1 - RELAX_MIN) * Math.max(0, done));
  }

  private idmAccel(v: Vehicle, lane: number): number {
    // v.aMax / v.T, not the profile's. Reading the shared table here was what
    // collapsed nine hundred drivers into nine behaviours no matter what was
    // stored on the vehicle.
    const v0 = this.desiredSpeed(v);
    const free = v.aMax * (1 - Math.pow(v.v / Math.max(1, v0), DELTA));
    const lead = this.leaderAhead(v, lane);
    if (!lead) return free;
    const sStar = S0 + Math.max(0, v.v * this.headwayOf(v) + (v.v * lead.dv) / (2 * Math.sqrt(v.aMax * B_COMF)));
    const interaction = -v.aMax * Math.pow(sStar / lead.gap, 2);
    return free + interaction;
  }

  // Would merging a vehicle of `length` at front-position `x` land it on top of
  // (or right up against) a stalled incident in `lane`? Used to stop cars from
  // changing lanes directly onto an accident.
  private incidentTooCloseInLane(lane: number, x: number, length: number): boolean {
    for (const inc of this.liveIncidents) {
      if (inc.lane !== lane) continue;
      const incFront = inc.x;
      const incRear = inc.x - INCIDENT_LENGTH;
      // the vehicle would occupy [x - length, x]; require an S0 buffer each side
      if (incFront > x - length - S0 && incRear < x + S0) return true;
    }
    /* An immovable AGENT blocks a lane change for the same reason an incident
     * does. Without this a car would happily change into the cell a wreck or
     * a parked ambulance occupies: MOBIL's gap test assumes both parties can
     * still adjust, and neither of these can. That was the whole of the 0.24%
     * that came back when responders became real vehicles. */
    for (const o of this.vehicles) {
      if (!this.isImmovable(o)) continue;
      if (!occupiesLane(o, lane)) continue;
      if (o.x > x - length - S0 && o.x - o.length < x + S0) return true;
    }
    return false;
  }

  /** Cannot be pushed, and will not get out of the way. */
  private isImmovable(v: Vehicle): boolean {
    if (v.departing) return false; // under tow, and moving like anything else
    return v.role === "wreck" || (v.role === "responder" && v.stillSince != null);
  }

  /** A closure that is no wall to this vehicle: the one round its own scene, which it is driving into — to crash there, or
   *  to park there with its lights on. To everyone else, and to it anywhere else, a closure is what it always was. */
  private passesClosure(v: Vehicle | undefined, c: LaneClosure, lane: number): boolean {
    if (!v || !c.lanes[lane]) return false;
    if (v.doom) return c.from <= v.doom.scene.stopX && c.to >= v.doom.scene.x - 5;
    if (v.role === "responder" && !v.departing && v.holdAtX != null && v.parkLane === lane) return v.holdAtX >= c.from - 1 && v.holdAtX <= c.to + 1;
    return false;
  }

  /** Who is waiting to come across, and into which lane: responders close to their spot, slowed, not yet in its lane. */
  private findYields(): void {
    this.yieldTo = [];
    const outer = this.cfg.laneCount - 1;
    for (const v of this.vehicles) {
      if (v.role !== "responder" || v.departing || v.holdAtX == null || v.stillSince != null || v.parkLane == null || v.laneShift < 1) continue;
      const target = Math.min(v.parkLane, outer);
      if (v.lane === target || v.v > 5 || v.holdAtX - v.x > 45) continue;
      this.yieldTo.push({ lane: v.lane + Math.sign(target - v.lane), x: v.x, len: v.length });
    }
    for (const v of this.shoulder) {
      if (v.role !== "responder" || v.departing || v.holdAtX == null || v.parkLane == null || v.parkLane >= this.cfg.laneCount) continue;
      if (v.x >= v.holdAtX - 16) this.yieldTo.push({ lane: outer, x: v.x, len: v.length });
    }
  }

  /** Room for `v` in `lane` with its nose at x: nobody in the way, and whoever is behind has room to stop for it. */
  private roomFor(v: Vehicle, lane: number, x: number): boolean {
    if (lane < 0 || lane >= this.cfg.laneCount) return false;
    for (const o of this.vehicles) {
      if (o === v || !occupiesLane(o, lane)) continue;
      if (o.x > x - v.length - 1.5 && o.x - o.length < x + 1.5) return false;
      // A car standing still behind (it is giving way) needs only a metre; a moving one, a second's travel.
      if (o.x <= x - v.length - 1.5 && x - v.length - o.x < Math.max(o.v < 0.5 ? 1.0 : S0, o.v * 1.0)) return false;
    }
    for (const inc of this.liveIncidents) if (inc.lane === lane && inc.x > x - v.length - S0 && inc.x - INCIDENT_LENGTH < x + S0) return false;
    return true;
  }

  /** Where on the shoulder `v` can stop near `want`: there, or — if someone is already stopped on that stretch — the
   *  nearest free length beside them: behind if it has not passed that yet, otherwise in front. */
  private freeShoulderSpot(v: Vehicle, want: number): number {
    let at = want;
    for (let k = 0; k < 4; k++) {
      const o = this.shoulder.find((q) => q !== v && q.v < 0.5 && q.x > at - v.length - 2 && q.x - q.length < at + 2);
      if (!o) return at;
      const behind = o.x - o.length - 2.5;
      at = v.x <= behind - 1 ? behind : o.x + 2.5 + v.length;
    }
    return at;
  }

  /** Nobody on the shoulder where `len` metres of vehicle with its nose at x would go. */
  private shoulderFree(x: number, len: number, self?: Vehicle): boolean {
    return !this.shoulder.some((o) => o !== self && o.x > x - len - 2 && o.x - o.length < x + 3);
  }

  /** The deceleration that stops `v` at x, once it is worth starting; a large number (no limit) until then. */
  private brakeTo(v: Vehicle, x: number): number {
    const room = x - v.x;
    if (room <= 0.3) return v.v > 0.05 ? -8 : 0;
    const need = (v.v * v.v) / (2 * room);
    return need >= 1.8 ? -need : 99;
  }

  /* A responder on its way to a scene: across to the lane it parks in, one lane at a time, through any gap the traffic
   * leaves it — they give way to the lights. It is not choosing a cruising lane, so nothing else applies. */
  private responderLane(v: Vehicle): void {
    if (v.parkLane == null || v.laneShift < 1 || v.laneCooldown > 0) return;
    // Bound for the shoulder: out to the outer lane, and the shoulder pass takes it from there.
    const target = Math.min(v.parkLane, this.cfg.laneCount - 1);
    if (v.lane === target) return;
    const to = v.lane + Math.sign(target - v.lane);
    if (!this.roomFor(v, to, v.x)) return;
    v.laneFrom = visualLane(v);
    v.laneShift = 0;
    v.lane = to;
    v.laneCooldown = v.lcSec + 0.2;
  }

  // MOBIL-ish lane change: pick the neighbouring lane that is safe and offers a
  // meaningfully better acceleration, with a strong pull out of a blocked lane.
  private considerLaneChange(v: Vehicle) {
    /* A wreck stays where it came to rest, and one being towed goes where the truck goes. A vehicle on its way into a
     * scene holds its lane: it is about to BE the scene. These used to run the ordinary decision, so a wreck with free
     * road beside it "changed lane" — measured, a collision's two wrecks drifted from lane 2 to lane 4, out of the lane
     * the closure shut and into the traffic, with the ambulance parked beside them. */
    // A truck with a casualty in tow keeps its lane: the load behind it could not be fitted into a gap sized for it alone.
    if (v.role === "wreck" || v.towedBy || v.towing) return;
    /* Sent to a booth at a barrier: it came in on the lane that feeds that booth and keeps it. Lining up for the
       shortest queue like a paying driver took it to booths the scene's could not be reached from, and it paid and
       drove on. */
    if (v.role === "responder" && !v.departing && v.facTarget && this.fac.get(v.facTarget.fid)?.laneEntries) return;
    // Sent to an exit plaza or a service area: straight across to the lane its ramp leaves from, through any gap.
    if (v.role === "responder" && !v.departing && v.facTarget && v.exitAtX != null && v.stillSince == null) {
      if (v.lane !== this.exitLane && v.laneShift >= 1 && v.laneCooldown <= 0) {
        const to = v.lane + Math.sign(this.exitLane - v.lane);
        if (this.roomFor(v, to, v.x)) {
          v.laneFrom = visualLane(v);
          v.laneShift = 0;
          v.lane = to;
          v.laneCooldown = v.lcSec + 0.2;
        }
      }
      return;
    }
    if (v.doom) {
      // Brought in from the next lane: it moves across behind the others first.
      const want = v.doom.scene.lane;
      if (v.lane !== want && v.laneShift >= 1 && v.laneCooldown <= 0 && this.roomFor(v, want, v.x)) {
        v.laneFrom = visualLane(v);
        v.laneShift = 0;
        v.lane = want;
        v.laneCooldown = v.lcSec + LC_SETTLE_SEC;
      }
      return;
    }
    if (v.role === "responder" && !v.departing && v.parkLane != null) {
      this.responderLane(v);
      return;
    }
    if (v.laneCooldown > 0) return;
    if (v.heldAtGore) return;
    // Committed to the booths in front of them: nobody weaves across a plaza's fan.
    if (this.fac.list.length > 0 && this.fac.barrierAt(v.x + 25)) return;
    /* Not until it is fully on the carriageway.
     *
     * A vehicle whose tail is still behind the entrance line cannot be kept
     * clear of anything: the follower it would need to yield to is pinned at
     * x = 0 by the floor in the correction pass and has nowhere to go. Two
     * such vehicles SWAPPING lanes crossed straight through each other —
     * measured at 0.24% of ticks with an incident present, worst 4.98 m, and
     * every pair had one car with a negative rear.
     *
     * Waiting until it is on the road is also simply what happens: nobody
     * changes lane while still on the slip. */
    if (v.x - v.length < 0) return;
    // Belt and braces: the cooldown already outlasts the slide, but a vehicle
    // still visibly straddling a line must not be re-aimed at a third lane,
    // whatever the cooldown says.
    if (v.laneShift < 1) return;
    const here = this.idmAccel(v, v.lane);
    // Blocked for THIS vehicle only while it is upstream of the works.
    // The nearest closure in this vehicle's own lane that it has still to reach: it has to get out before it.
    const closing = this.nextClosureIn(v.lane, v.x);
    /* Already inside a shut stretch — caught between the taper and the scene when the lane closed round it — is as
       pressing as a taper ahead: it gets out the same way (patience, then forcing in), rather than sitting behind
       the wreck for the rest of the event. */
    const trapped = closing === null && this.closedHere(v.lane, v.x);
    const mustEscape = closing !== null || trapped;
    /* A lane closed somewhere ahead is off limits, as it always was — except, while this vehicle's own lane is
     * closing, a lane that closes FURTHER on: that is the way round staggered closures (lane 1 shut here, lane 2
     * shut 300 m on), and without it a car behind the first waited for ever. With a single closure it never
     * applies — every lane one closure shuts, it shuts at the same point — so that behaviour, and the capacity
     * measured on it, are unchanged. Inside a closed stretch a lane is never a way round. */
    const blockedFor = (lane: number) => {
      if (!this.laneBlockedFor(lane, v.x)) return false;
      if (this.closedHere(lane, v.x) || closing === null) return true;
      const next = this.nextClosureIn(lane, v.x);
      return !(next !== null && next.from > closing.from);
    };
    let candidates = [v.lane - 1, v.lane + 1].filter(
      (l) => l >= 0 && l < this.cfg.laneCount && !blockedFor(l),
    );
    /* Keep buses and trucks out of the inner lane.
     *
     * The exception is a heavy vehicle that has to leave a lane closing ahead
     * of it and has nowhere legal to go. Held to the restriction there, it
     * would stop dead at the taper and hold up everything queued behind it for
     * the rest of the run — the restriction would read on screen as a bug in
     * the closure. Roadworks lift lane restrictions for exactly this reason.
     *
     * "Nowhere to go" originally meant no permitted lane EXISTS, which is the
     * wrong test and left the bug in place: a bus in a closed L2 has L3
     * permitted, so the exception never fired, and if L3 was full the bus
     * parked at the taper anyway. Measured on a 4-lane run with L2 shut, the
     * stationary queue at the taper was entirely class 2 for this reason.
     *
     * So the test is now whether the vehicle has actually run out of road: its
     * lane is closing AND it has come to a stop. A moving vehicle still
     * upstream keeps looking for a legal gap; only one that has already failed
     * to find one may take the restricted lane, and the penalty further down
     * means it still prefers a permitted lane whenever one will have it. */
    const permitted = candidates.filter((l) => laneAllowsClass(v.vClass, l));
    const desperate = mustEscape && v.v < CREEP_SPEED;
    if (!mustEscape || (permitted.length > 0 && !desperate)) candidates = permitted;

    /* Lent lanes are across the median behind cones: in or out only at a
     * crossover, and not for a driver leaving before the far one, who would be
     * shut in past their exit. A lane closing ahead lifts this, as roadworks
     * lift every lane rule (see mustEscape). */
    const lent = this.cfg.borrowed;
    if (lent && lent.lanes > 0 && !mustEscape) {
      const atCrossover = v.x <= lent.crossM || v.x >= this.cfg.length - lent.crossM;
      const shutIn = v.exitAtX != null && v.exitAtX < this.cfg.length - lent.crossM;
      candidates = candidates.filter((l) => {
        if ((l < lent.lanes) === (v.lane < lent.lanes)) return true;
        return atCrossover && !(l < lent.lanes && shutIn);
      });
    }

    /* How badly this vehicle needs the gap: 0 far upstream of the taper, 1 at
     * it. Drives both how hard it may push the new follower and how strongly
     * the escape outweighs staying put, so the merge is polite while there is
     * road left and insistent once there is not. */
    const urgency = closing !== null
      ? Math.max(0, Math.min(1, 1 - (closing.from - v.x) / MERGE_ZONE_M))
      : trapped ? 1 : 0;

    /* Working across for an exit.
     *
     * A driver leaving at the next interchange is not choosing a lane on
     * comfort, they are getting to the outside before the ramp arrives, and
     * they start well before it. Without this the ramps would drain only
     * whoever happened to be in the outer lane already, and the weaving that
     * makes interchanges the real bottleneck on this corridor would never
     * appear. */
    const toExit = v.exitAtX != null ? v.exitAtX - v.x : Infinity;
    const exiting = toExit <= EXIT_APPROACH_M;
    const exitUrgency = exiting
      ? Math.max(0, Math.min(1, 1 - toExit / EXIT_APPROACH_M))
      : 0;
    /* Pressure in the last stretch before a ramp.
     *
     * The outward bias alone only tells a driver which way to go; it does not
     * let them take a gap a comfortable driver would decline, and near the
     * ramp that is the binding constraint — 43% of drivers were still
     * sailing past their exit because every gap on offer failed the ordinary
     * safety test. A driver 50 m from the exit they need takes a tighter gap
     * than one cruising, exactly as at a closure taper, so the same easing
     * applies. Sharper than the approach bias: only the final 150 m. */
    const exitPressure =
      v.exitAtX != null
        ? Math.max(0, Math.min(1, 1 - (v.exitAtX - v.x) / EXIT_COMMIT_M))
        : 0;
    const bSafeEff = B_SAFE + Math.max(urgency, exitPressure) * (B_SAFE_FORCED - B_SAFE);
    const plazaAhead = this.fac.list.length > 0 ? this.fac.barrierAhead(v.x, PLAZA_LOOK_M) : null;
    let best: { lane: number; gain: number } | null = null;
    for (const lane of candidates) {
      // never change lanes onto (or right up against) an accident
      if (this.incidentTooCloseInLane(lane, v.x, v.length)) continue;
      // safety: would the new follower have to brake harder than B_SAFE?
      const follower = this.lastBefore(lane, v.x, v);
      // Never in front of a vehicle that is about to run into something: the scene is made of whoever was there.
      if (follower?.doom) continue;
      const lead = this.firstAfter(lane, v.x, v);
      const roomAhead = lead ? lead.x - v.x - lead.length : Infinity;
      /* Gap between this vehicle's rear and the follower's nose.
       *
       * This subtracted the FOLLOWER's length instead of the merging
       * vehicle's. Harmless when a car merged ahead of a truck (it just
       * understated the gap and refused a few legal moves) but wrong the
       * other way: a 14 m truck merging ahead of a 4.6 m car was checked as
       * though it were 4.6 m long, so it could drop its tail straight through
       * the car behind. */
      const gapBehind = follower ? v.x - v.length - follower.x : Infinity;

      /* Out of patience: nose in and make the follower yield.
       *
       * Judged on whether the follower has room to brake, not on whether the
       * braking would be comfortable — that is the whole point of forcing.
       * Still refuses a gap that is not physically there, so this never
       * teleports a vehicle into an occupied space. */
      const forcing =
        mustEscape &&
        v.stuckFor > v.patience &&
        roomAhead >= CREEP_GAP &&
        gapBehind >= Math.max(S0, (follower?.v ?? 0) * FORCE_TTC_SEC);

      /* Zipper merge at crawling pace.
       *
       * The IDM veto below asks "how hard would the new follower have to
       * brake?", and the gain test asks "would I accelerate better over
       * there?". In a jam neither question has a useful answer: gaps are a few
       * metres, so sStar/gap explodes and both the implied deceleration and
       * the implied gain are enormous even when everyone involved is nearly
       * stopped and letting one vehicle in costs nothing. The tests therefore
       * bite hardest exactly where merging matters most.
       *
       * Measured over five 10-minute runs with L2 shut, about 2.7 vehicles sat
       * parked at the taper at any moment and the worst stayed six minutes,
       * blocking its lane for the rest of the run. On the canvas that reads as
       * the closure having broken the simulation, which is what it was
       * reported as.
       *
       * A driver at a taper does not compute a deceleration. They creep to the
       * head of the queue, nose in, and the driver behind yields. So below
       * walking pace the test becomes the one a driver actually makes: is
       * there physically room? */
      const creeping =
        mustEscape &&
        v.v < CREEP_SPEED &&
        (!follower || follower.v < CREEP_SPEED) &&
        roomAhead >= CREEP_GAP;

      /* Physical fit. Checked for every change, not just a forced one.
       *
       * Nothing else enforced it: the follower had a gap test but the LEADER
       * had none, and the only thing discouraging a move into an occupied
       * space was the IDM gain being poor there — which the escape bias can
       * outweigh. The result was two sprites drawn through each other, up to a
       * full 14 m artic inside another vehicle. A gain term is not a substitute
       * for asking whether the car fits. */
      if (roomAhead < (creeping || forcing ? CREEP_GAP : S0)) continue;
      /* What the move costs the driver being cut in front of.
       *
       * MOBIL's defining term, and it was missing: `politeness` was defined on
       * every profile and read by nothing, so the decision was pure self
       * interest and an aggressive driver changed lanes on exactly the same
       * evidence as a cautious one. The only thing separating them was the
       * safety veto below, which is a hard limit rather than a temperament.
       *
       * Now the disadvantage inflicted on the new follower is weighed at this
       * driver's own politeness: near 0 they take any gap that helps them, near
       * 0.85 they hold station rather than force someone to lift off. */
      let courtesy = 0;
      if (follower) {
        if (gapBehind < S0) continue;
        const followerAccel = this.idmAccelAgainst(follower, v.x, v.v, v.length);
        if (!creeping && !forcing && followerAccel < -bSafeEff) continue;
        /* Politeness applies to a DISCRETIONARY change only.
         *
         * A vehicle whose own lane is closing ahead is making a mandatory
         * move: the alternative is not "stay and be slightly slower", it is
         * "stop at the taper". Charging it the follower's inconvenience made
         * merging impossible in exactly the traffic where merging matters —
         * in a queue the follower's disadvantage runs well past the 3.0 escape
         * bias, so the term cancelled the bias and cars sat in the closed lane
         * until the run ended, which on screen looked like the closure had
         * broken the simulation rather than like courtesy.
         *
         * The safety veto above still applies while there is speed in the
         * queue, so a mandatory merge at pace can never force anyone to brake
         * harder than B_SAFE. Once everyone is crawling it gives way to the
         * physical-room test instead — see `creeping`. */
        // Committed to an exit is as mandatory as escaping a closure: the
        // alternative is not "slightly slower", it is missing the junction.
        if (!mustEscape && exitPressure < 0.5) {
          const followerNow = this.idmAccel(follower, lane);
          courtesy = v.politeness * (followerNow - followerAccel);
        }
      }
      const there = this.idmAccel(v, lane);
      let gain = there - here - courtesy;
      /* Keep right except to overtake. Outward is rewarded, inward charged,
       * so the inner lane is only worth taking when there is real time in it.
       * Suspended while escaping a closure — a vehicle merging out of a shut
       * lane is not choosing a cruising lane, and charging it for moving
       * inward would send it the wrong way or nowhere at all. */
      if (!mustEscape) {
        const discipline = LANE_DISCIPLINE + CLASS[v.vClass].keepRight;
        gain += lane > v.lane ? discipline : -discipline;
      }
      // Scaled by the same urgency: a distant closure is a nudge, the taper is
      // an order. Without the floor a vehicle 150 m out would ignore the closure
      // entirely and only react once already slowing for it.
      if (mustEscape) gain += LC_BIAS_ESCAPE * (0.4 + 0.6 * urgency);
      // Outward towards the ramp, and charged for going the wrong way.
      if (exiting && lane !== v.lane) {
        const pull = LC_BIAS_EXIT * (0.3 + 0.7 * exitUrgency);
        gain += lane > v.lane ? pull : -pull;
      }
      /* Lining up for a barrier plaza: towards the booths with the shorter
       * queues. Each lane feeds only the booths in front of it, and without
       * this the outer lanes — which carry the most traffic — saturated their
       * booths while the inner ones stood idle: twelve booths cleared 3,100
       * veh/h where the operator's rate says 4,200. Choosing the shortest
       * queue on the approach is what drivers at a plaza do. */
      if (plazaAhead && lane !== v.lane) {
        const here = this.fac.laneQueue(plazaAhead, v.lane);
        const there = this.fac.laneQueue(plazaAhead, lane);
        if (isFinite(here) && isFinite(there)) gain += PLAZA_QUEUE_BIAS * Math.max(-1, Math.min(1, (here - there) / 2));
        else if (!isFinite(there)) gain -= PLAZA_QUEUE_BIAS;
      }
      /* At crawling pace the acceleration comparison is noise: every lane
       * scores terribly because every gap is small, so `gain` cannot separate
       * a lane with room from one without. Score by room instead — which is
       * what the driver is actually looking at — and keep it above
       * LC_THRESHOLD so a vehicle with somewhere to go always goes. The cap
       * stops a long empty stretch from outweighing a nearer, safer gap. */
      if (creeping || forcing) gain = LC_BIAS_ESCAPE + Math.min(10, roomAhead);
      /* Committed to an exit, and this is the lane it is on.
       *
       * The acceleration comparison cannot decide this. The outer lane is the
       * busiest one, so IDM scores it at around -5 m/s², and no bias of a
       * plausible size outvotes that — which is why 40% of drivers were still
       * sailing past their junction even once the bias, the safety easing and
       * the speed easing were all in place. Every one of those tests was
       * passing; the gain test was throwing the move away afterwards.
       *
       * A driver about to miss their exit is not weighing acceleration. They
       * take the gap if it exists, and the cost of arriving in a slower lane
       * does not enter into it. Physical room is still required. */
      if (
        exitPressure > 0.5 &&
        lane === this.exitLane &&
        roomAhead >= S0 &&
        gapBehind >= S0
      ) {
        gain = Math.max(gain, LC_THRESHOLD + 0.1 + Math.min(10, roomAhead) * 0.05);
      }
      /* A heavy vehicle taking a lane it is normally barred from is breaking a
       * rule to avoid blocking the road. Charged for it, so that whenever a
       * permitted lane will also have it, the permitted lane wins. */
      if (!laneAllowsClass(v.vClass, lane)) gain -= RESTRICTED_LANE_PENALTY;
      if (gain > LC_THRESHOLD && (!best || gain > best.gain)) best = { lane, gain };
    }
    if (best) {
      // Start the slide from wherever the sprite currently is, not from the
      // lane being left. They are the same thing for a settled vehicle, and
      // differ only if a change is somehow accepted mid-manoeuvre — in which
      // case continuing from the drawn position is what avoids a jump.
      v.laneFrom = visualLane(v);
      v.laneShift = 0;
      v.lane = best.lane;
      v.laneCooldown = v.lcSec + LC_SETTLE_SEC;
    }
  }

  // IDM accel of `f` if a vehicle were at position `leadX` moving `leadV`.
  private idmAccelAgainst(f: Vehicle, leadX: number, leadV: number, leadLen: number, T = this.headwayOf(f)): number {
    const v0 = this.desiredSpeed(f);
    const free = f.aMax * (1 - Math.pow(f.v / Math.max(1, v0), DELTA));
    const gap = Math.max(0.1, leadX - f.x - leadLen);
    const dv = f.v - leadV;
    const sStar = S0 + Math.max(0, f.v * T + (f.v * dv) / (2 * Math.sqrt(f.aMax * B_COMF)));
    return free - f.aMax * Math.pow(sStar / gap, 2);
  }

  private emit(v: Vehicle, dist: number, dt: number) {
    const base = this.cls[v.vClass].co2PerM;
    const vKmh = v.v * 3.6;
    // congestion penalty: crawling burns far more per metre; idling still emits
    const congestion = 1 + Math.max(0, (30 - vKmh) / 30) * 1.2;
    const moving = base * dist * congestion;
    const idle = v.v < 0.5 ? this.cls[v.vClass].co2PerM * 6 * dt : 0; // g while stopped
    const g = moving + idle;
    v.co2 += g;
    this.co2Window.push({ t: this.time, g });
  }

  // Nearest impassable point ahead of `fromX` in a lane: the rear of a stalled
  // incident, or a closed lane's taper. Infinity if the lane is clear ahead.
  private blockPointAhead(lane: number, fromX: number, who?: Vehicle): number {
    let wall = Infinity;
    for (const inc of this.liveIncidents) {
      if (inc.lane !== lane) continue;
      const rear = inc.x - INCIDENT_LENGTH;
      if (rear >= fromX && rear < wall) wall = rear;
    }
    for (const c of this.closureList()) {
      if (this.passesClosure(who, c, lane)) continue;
      // Only a wall to traffic that still has to get past the works.
      if (c.lanes[lane] && fromX < c.to && c.from >= fromX && c.from < wall) wall = c.from;
    }
    return wall;
  }

  /* Which interchange, if any, this vehicle intends to leave by.
   *
   * Decided once at entry rather than re-rolled as it drives, because a
   * driver knows where they are going. Each downstream ramp gets its
   * `offFraction` share of whatever traffic is still on the road by then,
   * which is how turning proportions compose along a corridor: 20% leaving at
   * two successive ramps takes 20% then 20% of the remaining 80%, not 40%. */
  private pickExit(fromX: number): number | null {
    for (const r of this.ramps) {
      if (r.x <= fromX + 1) continue; // already passed it
      if (r.offFraction > 0 && this.rng() < r.offFraction) return r.x;
    }
    return null;
  }

  /** The lane a vehicle must be in to use a ramp: the outermost one. */
  private get exitLane(): number {
    return this.cfg.laneCount - 1;
  }

  /* Traffic joining at the on-ramps.
   *
   * Joins in the outermost lane at the ramp's own position, at a speed typical
   * of an acceleration lane rather than at free flow — a vehicle appearing at
   * 100 km/h in the middle of the carriageway would be both wrong and
   * invisible as a disturbance. Merging traffic entering below the prevailing
   * speed is precisely what makes an interchange a bottleneck. */
  private spawnFromRamps(dt: number) {
    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      if (r.onVehPerHour <= 0) continue;
      this.rampAccumulator[i] += (r.onVehPerHour / 3600) * dt;
      while (this.rampAccumulator[i] >= 1) {
        this.rampAccumulator[i] -= 1;
        const lane = this.exitLane;
        const arrival = this.rampPendingArrival[i] ?? this.newArrival();
        this.rampPendingArrival[i] = null;
        const { vClass, profile, d } = arrival;
        const c = this.cls[vClass];

        /* Scanned live, not through the lane index, for the same reason the
         * mainline spawn is: the index is a step old and several joins can
         * happen inside one step. */
        let ahead: Vehicle | null = null;
        let behind: Vehicle | null = null;
        for (const other of this.vehicles) {
          if (other.lane !== lane) continue;
          if (other.x >= r.x) { if (!ahead || other.x < ahead.x) ahead = other; }
          else if (!behind || other.x > behind.x) behind = other;
        }
        const joinV = Math.min(
          d.v0,
          ahead ? Math.max(ahead.v, 4) : d.v0,
          RAMP_JOIN_SPEED * gauss(this.rng, 0.15, 0.6, 1.4),
        );
        /* Same dynamic test as the mainline entrance: room for the vehicle it
         * will become, at the speed it will be doing. A joiner that cannot fit
         * waits on the ramp — and its place in the queue is KEPT rather than
         * discarded, which is what was quietly losing 40% of every ramp's
         * configured volume. */
        const needAhead = c.len + S0 + joinV * d.T;
        const needBehind = behind ? S0 + behind.v * 0.8 : S0;
        if ((ahead && ahead.x - ahead.length - r.x < needAhead - c.len) ||
            (behind && r.x - c.len - behind.x < needBehind)) {
          this.rampPendingArrival[i] = arrival; // waits on the ramp as who it is
          this.rampAccumulator[i] = Math.min(this.rampAccumulator[i] + 1, MAX_ENTRY_QUEUE);
          break;
        }
        this.vehicles.push({
          id: this.nextId++,
          x: r.x, lane, v: Math.max(4, joinV), vClass, profile,
          v0: d.v0, T: d.T, aMax: d.aMax, politeness: d.politeness, lcSec: d.lcSec,
          scanSec: d.scanSec, scanTimer: d.scanTimer, patience: d.patience, stuckFor: 0,
          reactionS: d.reactionS, reactTimer: d.reactTimer, accel: 0,
          exitAtX: this.pickExit(r.x),
          length: c.len, spawnTime: this.time, co2: 0,
          laneCooldown: 0, laneFrom: lane, laneShift: 1,
          color: varyColor(c.color, this.rng()),
          role: "traffic",
        });
      }
    }
  }

  /* Vehicles peeling off at their interchange.
   *
   * Removed once they reach the ramp, but only from the outermost lane — a
   * vehicle that failed to work its way across in time misses its exit and
   * carries on, which is both what happens and what keeps the exit lane's
   * demand honest. Getting there is handled by the lane-change bias. */
  private takeExits() {
    if (this.ramps.length === 0) return;
    this.vehicles = this.vehicles.filter((v) => {
      if (v.exitAtX == null || v.x < v.exitAtX) return true;
      if (v.lane !== this.exitLane) {
        // Missed it. Carry on to the next one they can reach, or run through.
        v.exitAtX = this.pickExit(v.x);
        return true;
      }
      /* A ramp with somewhere to go. The vehicle drives onto it rather than
       * vanishing — and if the ramp is full right back to the gore, it WAITS
       * here in the outer lane, which is how a plaza queue reaches the
       * expressway and starts holding up traffic that was never going there. */
      const f = this.fac.list.length > 0 ? this.fac.atGore(v.exitAtX) : null;
      if (f && f.divergePath != null) {
        const ahead = v.x - v.exitAtX;
        if (!this.fac.roomToDiverge(f, ahead, v.length)) {
          v.heldAtGore = true;
          v.v = 0;
          v.accel = 0;
          return true;
        }
        v.heldAtGore = false;
        // A trip on the expressway ends here — unless it is a stop for fuel,
        // after which the same trip carries on.
        if (f.spec.kind !== "service_area" && v.role === "traffic") {
          this.completedTimes.push(this.time - v.spawnTime);
          this.completedInWindow.push(this.time);
        }
        this.fac.take(f, v, f.divergePath, ahead, { w: visualLane(v) - (this.cfg.laneCount - 1), shift: v.laneShift });
        return false;
      }
      this.completedTimes.push(this.time - v.spawnTime);
      this.completedInWindow.push(this.time);
      return false;
    });
  }

  /* A barrier plaza takes EVERY lane. Whoever reaches its fan-in goes into the
   * booth lanes in front of their own lane, choosing the shortest queue; when
   * all of those are full to the entrance they stop in their lane and wait,
   * which is the tailback a barrier is known for. */
  private enterBarriers() {
    if (!this.fac.list.some((f) => f.laneEntries)) return;
    this.vehicles = this.vehicles.filter((v) => {
      const f = this.fac.barrierAt(v.x);
      if (!f) return true;
      // A wreck is where it stopped; the scene, not the plaza, decides when it moves.
      if (v.role === "wreck" && !v.departing) return true;
      const ahead = v.x - f.u0;
      const target = v.facTarget && v.facTarget.fid === f.spec.id ? v.facTarget.station : null;
      const id = this.fac.barrierEntry(f, v.lane, ahead, v.length, target);
      if (id == null) {
        v.heldAtGore = true;
        v.v = 0;
        v.accel = 0;
        return true;
      }
      v.heldAtGore = false;
      this.fac.take(f, v, id, ahead, { w: visualLane(v) - (this.cfg.laneCount - 1), shift: v.laneShift });
      return false;
    });
  }

  /* A crash in the queue behind an existing incident.
   *
   * Placed where rear-end shunts actually happen: at the BACK of the standing
   * queue, in the lane a driver is braking hardest in, not at a random point
   * in the radius. The hazard is per primary incident per minute and is
   * calibrated — see SECONDARY_PER_INCIDENT_MINUTE.
   *
   * Returns the incidents it created, so the caller can surface them. */
  private maybeSecondary(dt: number): { lane: number; x: number }[] {
    if (!this.cfg.secondaryIncidents) return [];
    const perMin = this.cfg.secondaryPerIncidentMinute ?? SECONDARY_PER_INCIDENT_MINUTE;
    if (perMin <= 0) return [];

    const primaries = this.interventions.incidents.filter((i) => !i.secondary);
    if (primaries.length === 0) return [];

    // Constant hazard over the tick. Drawn once per primary so two incidents
    // carry twice the risk, which is what a longer or wider closure means.
    const pTick = 1 - Math.exp((-perMin / 60) * dt);
    const made: { lane: number; x: number }[] = [];

    for (const primary of primaries) {
      if (this.rng() >= pTick) continue;

      /* Find the tail of the queue behind this incident: the furthest-back
         vehicle that is actually held up by it. A shunt at the front of a
         stationary queue is not what the base rate is measuring — the
         dangerous place is where free-flowing traffic meets the back of it. */
      const from = Math.max(0, primary.x - SECONDARY_RADIUS_M);
      let tail: Vehicle | null = null;
      for (const v of this.vehicles) {
        if (v.x > primary.x || v.x < from) continue;
        if (v.v > 6) continue; // not queued
        if (!tail || v.x < tail.x) tail = v;
      }
      if (!tail) continue;

      /* Just upstream of the tail, so the new obstacle lands on traffic that
         is still moving. Clamped inside the segment. */
      const x = Math.max(5, Math.min(this.cfg.length - 5, tail.x - 8));
      const lane = tail.lane;
      if (this.interventions.incidents.some((i) => i.lane === lane && Math.abs(i.x - x) < 25)) continue;

      this.addIncident(lane, x, true);
      made.push({ lane, x });
    }
    return made;
  }

  /** Secondary incidents created since the last call, for the UI to announce. */
  private freshSecondaries: { lane: number; x: number; t: number }[] = [];
  takeSecondaryAlerts(): { lane: number; x: number; t: number }[] {
    const out = this.freshSecondaries;
    this.freshSecondaries = [];
    return out;
  }

  /* Place an incident — made of the traffic that is approaching it.
   *
   * This used to delete the cars on the spot and draw a wreck over the gap; then it froze the cars nearest the spot
   * where they were, mid-stride, which an operator still sees as cars turning into wrecks out of nowhere. Now the
   * incident's vehicles are picked out of the traffic coming up to it and are SEEN to crash there (crashAt): the first
   * brakes hard and stops, the next fails to. The obstacle is not there until they are — an incident with nobody in it
   * yet would stop traffic for nothing.
   *
   * A scenario breakdown starts its own scene before its incident slots are placed, and the slots are that vehicle. */
  addIncident(lane: number, x: number, secondary = false) {
    const inc = { lane, x, secondary, bornAt: this.time };
    this.interventions.incidents.push(inc);
    if (!this.sceneAt(lane, x)) {
      const s = this.crashAt(lane, x, 2, undefined, "collision", null, 0, x + 6);
      if (s) s.incident = inc;
    }
    if (secondary) this.freshSecondaries.push({ lane, x, t: this.time });
  }

  /** The scene standing at (or coming together at) this point of this lane, if any. */
  private sceneAt(lane: number, x: number): CrashScene | null {
    return this.scenes.find((s) => s.lane === lane && x >= s.x - 30 && x <= s.stopX + 5) ?? null;
  }

  /* An incident is an obstacle once its vehicles are there — until then they are still driving to it — and only where
   * they are: a breakdown's slots run back from the point for the length of the vehicle asked for, and when a shorter
   * one is what stopped, the slots behind it are empty road. */
  private incidentArmed(inc: Interventions["incidents"][number]): boolean {
    const s = this.sceneAt(inc.lane, inc.x);
    if (s === null) return true;
    if (!s.done) return false;
    if (s.incident !== undefined) return true;
    return s.members.some((m) => m.lane === inc.lane && inc.x > m.x - m.length && inc.x - INCIDENT_LENGTH < m.x);
  }

  /* A scene, made of the traffic.
   *
   * Nothing is put down on the road. The vehicles are the ones driving there: the first is picked a few seconds ahead
   * (`inS`, the time until it is due) from the traffic approaching the point in that lane, chosen to arrive about then —
   * a truck or a bus if one is coming and the event asks for it — and each one after it is the vehicle behind the last.
   * They drive as everyone does until it happens (doomAccel), so an operator sees the event coming and then sees it
   * happen, to cars that were already there. The response is sent once they are at rest (respond).
   *
   * Once per event: a second call with the same key is ignored. Returns the scene, or null when it already exists. */
  crashAt(lane: number, x: number, want: number, sceneKey?: string, kind: CrashKind = "collision", prefer: VehicleClass | null = null, inS = 0, stopAt?: number, respondS?: number): CrashScene | null {
    if (sceneKey !== undefined && this.scenes.some((s) => s.key === sceneKey)) return null;
    const single = kind === "self" || kind === "overturn" || kind === "breakdown" || kind === "shoulder";
    const n = single ? 1 : Math.max(1, Math.round(want));
    // A crash ends AT the event's point and its vehicles lie downstream of it, inside the closed stretch; a breakdown's
    // nose is at the point, over the obstacle slots that run back from it.
    const pile = kind === "breakdown" || kind === "shoulder" ? 0 : n * 6 + 4;
    const scene: CrashScene = {
      key: sceneKey ?? `incident-${++this.sceneSeq}`,
      lane: kind === "shoulder" ? this.cfg.laneCount - 1 : lane,
      x,
      stopX: Math.max(1, Math.min(this.cfg.length - 2, stopAt ?? x + pile)),
      want: n,
      kind,
      prefer,
      dueAt: this.time + Math.max(0, inS),
      members: [],
      lastJoinAt: this.time,
      done: false,
      towWanted: false,
      towSent: false,
      towAt: null,
      respondS,
    };
    this.scenes.push(scene);
    this.gatherScene(scene);
    return scene;
  }

  /** May this vehicle become part of a scene in `lane`: an ordinary vehicle, settled in that lane, wholly on the road. */
  private canJoinScene(v: Vehicle, lane: number): boolean {
    return v.role === "traffic" && !v.doom && !v.fac && !v.heldAtGore && v.lane === lane && v.laneShift >= 1 && v.x - v.length >= 0 && !v.relaxUntil;
  }

  private joinScene(s: CrashScene, v: Vehicle): void {
    const ahead = s.members.length > 0 ? s.members[s.members.length - 1] : null;
    const sgn = hash01(v.id * 7 + 3) < 0.5 ? -1 : 1;
    // How far round a skid turns it: less the longer it is, so a truck stays (mostly) in its own lane.
    const cap = Math.min(0.95, Math.asin(Math.min(1, 3.2 / Math.max(3.2, v.length))));
    v.doom = { scene: s, order: s.members.length, ahead, spin: sgn * cap * (0.65 + 0.35 * hash01(v.id)), stoppedFor: 0 };
    v.exitAtX = null; // not leaving at the next interchange after all
    v.sceneKey = s.key;
    s.members.push(v);
    s.lastJoinAt = this.time;
  }

  /** Bring the next vehicle into a scene that still needs one: the first, chosen to arrive about when it is due, then each one behind. */
  private gatherScene(s: CrashScene): void {
    // Anyone who has left the road (or was released) is no longer in it.
    for (let i = s.members.length - 1; i >= 0; i--) {
      const m = s.members[i];
      if (m.sceneKey !== s.key || (!this.vehicles.includes(m) && !this.shoulder.includes(m))) s.members.splice(i, 1);
    }
    if (s.members.length === 0) {
      const eta = Math.max(0, s.dueAt - this.time);
      let best: Vehicle | null = null;
      let bestScore = Infinity;
      const coast = s.kind === "breakdown" || s.kind === "shoulder";
      const brake = coast ? COAST_DECEL : CRASH_BRAKE;
      /* When it should come to rest: a crash's first vehicle a few seconds before it is due, so that the one behind
         runs into it on time; a breakdown when it is due. */
      const restIn = eta - (s.want > 1 ? 3 : 0);
      // The class asked for (a heavy vehicle, for an overturn), if one comes along — waited for a little while.
      const wanted = (v: Vehicle) => s.prefer === null || (s.kind === "overturn" ? v.vClass >= 2 : v.vClass === s.prefer);
      let bestWanted: Vehicle | null = null;
      let bestWantedScore = Infinity;
      for (const v of this.vehicles) {
        if (!this.canJoinScene(v, s.lane)) continue;
        const d = s.stopX - v.x;
        // Far enough back to stop there believably (a breakdown coasts, it does not brake), near enough to get there soon.
        if (d < (v.v * v.v) / (2 * (coast ? 2.2 : 7)) + 3 || d > SCENE_REACH_M) continue;
        const cruise = Math.max(0, d - (v.v * v.v) / (2 * brake)) / Math.max(4, v.v);
        const score = Math.abs(cruise + v.v / brake - restIn);
        if (score < bestScore) {
          bestScore = score;
          best = v;
        }
        if (wanted(v) && score < bestWantedScore) {
          bestWantedScore = score;
          bestWanted = v;
        }
      }
      /* The class asked for is waited for only while one of any class could still get there on time: a coasting
         breakdown needs about v / COAST_DECEL to stop, a crash a few seconds. Waited for until twenty seconds AFTER it
         was due, every breakdown began half a minute late (a truck is one vehicle in eleven). */
      const latest = s.dueAt - (coast ? 17 : 4);
      if (bestWanted === null && s.prefer !== null && this.time < latest) return;
      let pick = bestWanted ?? best;
      /* Due, and nobody can stop there in the ordinary way — the point is a few car lengths from where traffic comes
         onto the simulated stretch at full speed, so no vehicle is ever "far enough back to stop believably". The
         event used to shut its lane and then nothing happened at all: no vehicle, no response. It happens to the next
         vehicle to reach the point, which stops as hard as the room it has demands (a crash does; a breakdown this
         close to the edge of the picture has simply come from further back than the picture shows). Three seconds
         ahead, not at the moment itself: by then the event has shut the lane, and nobody enters a shut lane. */
      if (pick === null && this.time >= s.dueAt - 3) {
        let near = Infinity;
        for (const v of this.vehicles) {
          if (!this.canJoinScene(v, s.lane)) continue;
          const d = s.stopX - v.x;
          if (d < 2 || d > SCENE_REACH_M || d >= near) continue;
          // Not one that would need more than a crash stop to make it; it passes, and the next is taken.
          if ((v.v * v.v) / (2 * d) > 11) continue;
          near = d;
          pick = v;
        }
      }
      if (pick === null) return;
      this.joinScene(s, pick);
    }
    while (s.members.length < s.want) {
      const last = s.members[s.members.length - 1];
      if (last.onShoulder) break;
      const rear = last.x - last.length;
      let next = this.lastBefore(s.lane, rear, last);
      if (next && (!this.canJoinScene(next, s.lane) || rear - next.x > SCENE_FOLLOW_M)) next = null;
      /* Nobody coming in its own lane for a few seconds (light traffic, or the lane already emptying ahead of the
         closure): the next one comes from the lane beside it, far enough back to move across first. */
      if (!next && this.time - s.lastJoinAt > 4) {
        let best: Vehicle | null = null;
        for (const l of [s.lane - 1, s.lane + 1]) {
          if (l < 0 || l >= this.cfg.laneCount) continue;
          const c = this.lastBefore(l, rear - 40);
          if (c && this.canJoinScene(c, l) && rear - c.x <= SCENE_FOLLOW_M && (!best || c.x > best.x)) best = c;
        }
        next = best;
      }
      if (!next) break;
      this.joinScene(s, next);
    }
  }

  /* How a vehicle on its way into a scene drives: like anyone, until the moment it does not.
   *
   * The first one stops at the scene's point — hard, for a crash; a long coast with its hazards on, for a breakdown —
   * following the traffic in front as usual until then. Each one behind follows the one ahead without seeing it stop,
   * brakes when it is already too late, and runs into it at a speed that is still a crash (hitAt). In a crawl that is a
   * nudge, at speed a hard one, which is how a pile-up actually differs from one road to another. */
  private doomAccel(v: Vehicle): number {
    const d = v.doom!;
    const s = d.scene;
    const coast = s.kind === "breakdown" || s.kind === "shoulder";
    if (d.order === 0) {
      let a = this.idmAccel(v, v.lane);
      const room = s.stopX - v.x;
      const need = room <= 0.2 ? Infinity : (v.v * v.v) / (2 * room);
      if (d.brakeFromV === undefined && need >= (coast ? COAST_DECEL : CRASH_BRAKE) * 0.95) {
        d.brakeFromV = Math.max(1, v.v);
        if (coast) v.hazards = true;
      }
      if (d.brakeFromV !== undefined) {
        a = Math.min(a, room <= 0.2 ? -8 : -need);
        // Short of the point and all but stopped, with the road clear: it rolls up to it.
        if (v.v < 1 && room > 1) a = Math.max(a, Math.min(0.8, this.idmAccel(v, v.lane)));
      }
      return a;
    }
    const lead = d.ahead;
    if (!lead || v.lane !== lead.lane) return this.idmAccel(v, v.lane);
    // Somebody else between it and the one it is to hit (they will be merging out): it follows them as anyone would.
    const front = this.firstAfter(v.lane, v.x, v);
    if (front && front !== lead && front.x < lead.x) return this.idmAccel(v, v.lane);
    const inTrouble = lead.role === "wreck" || lead.doom?.brakeFromV !== undefined;
    if (!inTrouble) return this.idmAccel(v, v.lane);
    /* The room it has: to where the one ahead will have stopped, which is further on than where it is now if it is still
       moving. Judged against where it is now, a follower of a car that was still braking stopped well short, then crept
       up to the pile at walking pace for a minute and a half. */
    const gap = lead.x - lead.length - v.x;
    const room = lead.role === "wreck" ? gap : gap + (lead.v * lead.v) / (2 * Math.max(1, -lead.accel));
    /* The speed it will hit at is fixed the moment it reacts. Re-chosen from its speed every step, the target fell as it
       slowed, so it braked harder and harder and stopped 0.4 m short: a pile-up of cars politely stopping. */
    if (d.hitAt === undefined) {
      const hitAt = Math.min(v.v, 4 + 0.3 * v.v);
      const late = room <= 0.2 ? Infinity : (v.v * v.v - hitAt * hitAt) / (2 * room);
      if (late < LATE_BRAKE) return v.v < 2 ? 0.8 : 0; // has not seen it: carries on (and creeps up, in a crawl)
      d.hitAt = hitAt;
      d.brakeFromV = Math.max(1, v.v);
    }
    if (v.v <= d.hitAt + 0.05) return v.v < 2.5 ? 0.8 : 0; // down to the speed it hits at: it rolls on into it
    return -Math.min(8, Math.max(0, (v.v * v.v - d.hitAt * d.hitAt) / (2 * Math.max(0.2, room))));
  }

  /** After it moved: has it happened? The first one has stopped at its point; one behind has closed on the one ahead. */
  private doomContact(v: Vehicle, dt: number): void {
    const d = v.doom!;
    const s = d.scene;
    d.stoppedFor = v.v < 0.3 ? d.stoppedFor + dt : 0;
    if (d.order === 0) {
      // A skid turns it as it slows, and an overturn goes over part way through.
      if (d.brakeFromV !== undefined && (s.kind === "self" || s.kind === "overturn")) {
        const p = Math.max(0, Math.min(1, 1 - v.v / d.brakeFromV));
        v.yaw = d.spin * Math.pow(p, 0.8);
        if (s.kind === "overturn" && p > 0.6) v.look = "overturned";
      }
      const room = s.stopX - v.x;
      const arrived = d.brakeFromV !== undefined && v.v < 0.3 && (room < 1.5 || d.stoppedFor > 3);
      // Held in a queue short of it for a while: this is where it happens.
      const held = d.stoppedFor > 8 && room < 80;
      if (arrived || held) this.comeToRest(v, 0);
      return;
    }
    const lead = d.ahead;
    if (!lead) return;
    const gap = lead.x - lead.length - v.x;
    /* Contact is the overlap pass's floor (MIN_CLEARANCE), not less: in a crawl that pass holds it there first and
       zeroes its speed, so a test any tighter never fired and the "crash" was a car stopping politely behind another. */
    if (gap <= MIN_CLEARANCE + 0.05) {
      const impact = Math.max(0, v.v - lead.v);
      v.x = Math.max(v.x - 1.5, lead.x - lead.length - MIN_CLEARANCE);
      // The one hit is shoved on a little, if there is room in front of it.
      const push = Math.min(1.4, 0.12 * impact);
      const beyond = this.firstAfter(lead.lane, lead.x, lead);
      if (push > 0.05 && (!beyond || beyond.x - beyond.length - lead.x > push + 0.6)) lead.x += push;
      this.comeToRest(lead, impact);
      this.comeToRest(v, impact);
    } else if (d.stoppedFor > 10) {
      this.comeToRest(v, 0); // stopped short after all, in a crawl: part of it nose to tail
    }
  }

  /** It is a wreck now: at rest, where it is, turned by whatever hit it. */
  private comeToRest(v: Vehicle, impact: number): void {
    const kind = v.doom?.scene.kind ?? "collision";
    const cap = Math.min(0.55, Math.asin(Math.min(1, 3.2 / Math.max(3.2, v.length))));
    if (v.role !== "wreck") {
      const spin = v.doom?.spin ?? 0;
      v.role = "wreck";
      v.v = 0;
      v.accel = 0;
      v.stillSince = this.time;
      v.laneShift = 1;
      v.laneFrom = v.lane;
      v.look = kind === "breakdown" || kind === "shoulder" ? "stalled" : kind === "overturn" ? "overturned" : "crash";
      v.hazards = kind !== "collision" && kind !== "pileup" ? true : impact > 0;
      v.yaw = v.yaw ?? 0;
      v.restAngle = kind === "self" || kind === "overturn" ? spin : kind === "breakdown" || kind === "shoulder" ? 0 : spin * 0.08;
      v.doom = undefined;
    }
    if (impact > 0) {
      // The knock turns it, more the harder it was; and it is now plainly a crash.
      const sgn = hash01(v.id * 13 + 5) < 0.5 ? -1 : 1;
      v.restAngle = Math.max(-cap, Math.min(cap, (v.restAngle ?? 0) + sgn * Math.min(cap, 0.05 + 0.022 * impact)));
      v.look = "crash";
      v.hazards = true;
      // Whatever happens next at the scene (people getting out, the response) counts from the impact, not from when it stopped.
      v.stillSince = this.time;
    }
  }

  /** A wreck at rest: it does not move, and settles to the angle it was knocked to. */
  private settleWreck(v: Vehicle, dt: number): void {
    v.v = 0;
    v.accel = 0;
    if (v.restAngle !== undefined) v.yaw = (v.yaw ?? 0) + (v.restAngle - (v.yaw ?? 0)) * Math.min(1, dt * 5);
  }

  /** Hitched to a recovery truck: winched up to it first, then pulled along at its speed, in its lane, straightening out. */
  private followTow(w: Vehicle, dt: number): void {
    const t = w.towedBy!;
    if (!this.vehicles.includes(t) && !this.shoulder.includes(t)) {
      // The truck has left the road ahead of it: it rolls on, as departing traffic.
      w.towedBy = undefined;
      w.v = t.v;
      return;
    }
    const at = t.x - t.length - 1.0;
    if (!w.hitched) {
      if (at - w.x > 0.05) w.x = Math.min(at, w.x + 1.5 * dt);
      else w.hitched = true;
      w.v = 0;
    } else {
      w.x = Math.max(w.x, at);
      w.v = t.v;
    }
    w.lane = t.lane;
    w.laneFrom = t.laneFrom;
    w.laneShift = t.laneShift;
    w.onShoulder = t.onShoulder;
    w.viaShoulder = t.viaShoulder;
    w.yaw = (w.yaw ?? 0) * Math.max(0, 1 - dt * 1.2);
    w.restAngle = w.yaw;
  }

  /* Each step: bring the next vehicle into each scene that still needs one; once everyone in it is at rest, send the
   * response; an operator's or a secondary incident that has been cleared takes its scene away with it. */
  private stepScenes(): void {
    const cleared: string[] = [];
    for (const s of this.scenes) {
      if (s.incident && !this.interventions.incidents.includes(s.incident)) {
        cleared.push(s.key);
        continue;
      }
      if (!s.done) {
        this.gatherScene(s);
        const resting = s.members.length > 0 && s.members.every((m) => m.role === "wreck");
        if (resting && s.members.length < s.want && this.time - s.lastJoinAt > SCENE_GIVE_UP_S) s.want = s.members.length;
        if (resting && s.members.length >= s.want) {
          s.done = true;
          this.respond(s);
        }
      }
      if (s.done && !s.towSent && (s.towWanted || (s.towAt !== null && this.time >= s.towAt))) this.sendTow(s);
      /* An overturned vehicle is righted by the recovery crew once their truck has been there a while (the event's
         "righting and tow" phase), and waits on its wheels to be towed — rather than lying on its side right up to
         the moment it is pulled away, and flipping upright then. */
      if (s.towSent && s.members.some((m) => m.look === "overturned")) {
        const tow = [...this.vehicles, ...this.shoulder].find((v) => v.sceneKey === s.key && v.role === "responder" && v.responderKind === "tow" && v.stillSince != null && !v.departing);
        if (tow && this.time - tow.stillSince! > RIGHTING_S) for (const m of s.members) if (m.look === "overturned") m.look = "crash";
      }
    }
    for (const key of cleared) this.releaseScene(key);
  }

  /* The response, once the vehicles are at rest: police first, parked behind the wreck to protect it (the patrol, for a
   * breakdown), then the ambulance behind them for a crash. They come up the hard shoulder and cross into the lane at
   * the scene. The recovery truck goes when the event's tow or service phase begins (dispatchTow); a scene with no
   * event behind it gets one after a while. */
  private respond(s: CrashScene): void {
    const park = s.kind === "shoulder" ? this.shoulderLane : s.lane;
    const rear = Math.min(...s.members.map((m) => m.x - m.length));
    /* A breakdown in a lane is not closed off: traffic queues right up behind it and squeezes past, so there is no
       room in its lane for the patrol to stop in (it tried, and stood in the next lane, shutting that one as well). It
       stops on the shoulder level with it, lights going, as patrols do. */
    /* When they set off. They used to leave three seconds after the last vehicle stopped and were parked at the scene
       half a minute later — while the event's own label went on saying "awaiting response" for another five minutes,
       and twice the patrol car was on the road before the crash it was going to. Now: never before the scene has
       been reported (RESPONSE_CALL_S), and timed to ARRIVE at the response time the event carries (respondS after it
       was due), the drive up the shoulder allowed for. */
    const travel = Math.max(0, rear) / SHOULDER_SPEED.police + 6;
    const wait = s.respondS === undefined ? RESPONSE_CALL_S : Math.max(RESPONSE_CALL_S, s.dueAt + s.respondS - this.time - travel);
    if (s.kind === "breakdown") {
      /* Beside the casualty — unless it broke down in the OUTER lane. There the shoulder is the recovery truck's
         only way to the front of it (the lane behind is the queue), and a patrol car standing on it level with the
         casualty shut that way: the truck stood behind it for the rest of the event and the casualty drove itself
         off. In the outer lane the patrol goes past, to beyond where the truck will stand; with no road left for
         that, it stops behind the casualty and the truck waits behind it (stepShoulder). */
      const front = Math.max(...s.members.map((m) => m.x));
      const beyond = front + 4 + RESPONDER_LENGTH.tow + 6 + RESPONDER_LENGTH.police;
      const at = s.lane !== this.cfg.laneCount - 1 ? rear + 4 : beyond <= this.cfg.length - 3 ? beyond : rear - 7;
      this.dispatchResponder("police", this.shoulderLane, at, wait, s.key);
    }
    else if (s.kind === "shoulder") this.dispatchResponder("police", park, rear - 7, wait, s.key);
    else {
      /* The police car is the one furthest back, blocking the lane behind everything (its cones go out behind it);
         the ambulance stands between it and the wreck, beside the casualties. The police get there first and leave
         the ambulance its space; the ambulance crosses in alongside it. */
      this.dispatchResponder("police", park, rear - 7 - RESPONDER_LENGTH.ambulance - 5, wait, s.key);
      this.dispatchResponder("ambulance", park, rear - 7, wait + 7, s.key);
    }
    if (s.incident) s.towAt = this.time + 75;
  }

  private sendTow(s: CrashScene): void {
    s.towSent = true;
    const front = Math.max(s.stopX, ...s.members.map((m) => m.x));
    // In front of the casualty, nose out, so that it can be winched up behind and pulled away.
    const at = front + 4 + RESPONDER_LENGTH.tow;
    /* No road left in front of it — the scene is at the very end of the simulated stretch. Sent to a point past the
       end, the truck drove up, off the picture, and was never seen to stop; the casualty then drove itself away. It
       stands on the shoulder beside the casualty instead, which is where a recovery truck waits when it cannot get
       in front. Level with the tail of the scene, so it is short of anyone already stopped on the shoulder there
       (freeShoulderSpot moves it back behind them if not). */
    if (at > this.cfg.length - 3) {
      const rear = Math.min(...s.members.map((m) => m.x - m.length));
      this.dispatchResponder("tow", this.shoulderLane, Math.max(12, rear - 6), 0, s.key);
      return;
    }
    this.dispatchResponder("tow", s.kind === "shoulder" ? this.shoulderLane : s.lane, at, 0, s.key);
  }

  /** Is somebody at this scene: a responder of its own, parked there and not yet leaving? (On the road or in a plaza.) */
  sceneAttended(sceneKey: string): boolean {
    for (const v of this.vehicles) if (v.sceneKey === sceneKey && v.role === "responder" && !v.departing && v.stillSince != null) return true;
    for (const v of this.shoulder) if (v.sceneKey === sceneKey && v.role === "responder" && !v.departing && v.stillSince != null) return true;
    return this.fac.sceneAttended(sceneKey);
  }

  /** The event's tow (or service) phase has begun: send the recovery truck — now, or as soon as the scene is at rest. */
  dispatchTow(sceneKey: string): void {
    const s = this.scenes.find((x) => x.key === sceneKey);
    if (!s || s.towWanted) return;
    s.towWanted = true;
    if (s.done && !s.towSent) this.sendTow(s);
  }

  /* Pack up and go.
   *
   * Everything this scene put on the road starts moving again: the recovery truck takes the vehicle in front of it in
   * tow, the other wrecks are driven off slowly, the responders fall in, and all of them leave by driving off the end
   * like anything else. A vehicle that was still on its way into the scene simply carries on — it never happened to it.
   * Nothing is deleted in place. */
  releaseScene(sceneKey: string): void {
    this.packUp(sceneKey, false);
  }

  /* The lanes are open again, but the scene is not over: a collision's clearing phase (the incident log has
   * BlockageCleared before SiteCleared for all but 358 of 21,804 accidents). The casualties are got out of the lane —
   * the recovery truck takes one in tow, the others are driven off slowly — and the ambulance goes with them. The
   * police stay: they move out onto the hard shoulder a little ahead of where they stood and wait there, lights on,
   * until the event ends (releaseScene). Everything used to drive off here, so the clearing phase played out on an
   * empty road under a label saying the scene was still being cleared. */
  reopenScene(sceneKey: string): void {
    this.packUp(sceneKey, true);
  }

  private packUp(sceneKey: string, policeStay: boolean): void {
    const all = [...this.vehicles, ...this.shoulder];
    for (const v of all) {
      if (v.doom && v.doom.scene.key === sceneKey) {
        v.doom = undefined;
        v.hazards = false;
        v.yaw = undefined;
        v.look = undefined;
        v.sceneKey = undefined;
      }
    }
    const mine = all.filter((v) => v.sceneKey === sceneKey && (v.role === "wreck" || v.role === "responder"));
    const S = this.shoulderLane;
    for (const v of mine) {
      if (policeStay && v.role === "responder" && v.responderKind === "police" && !v.departing) {
        // Already parked on the shoulder: it stays where it is. In a lane: out to the shoulder, rolling on to stop.
        if (!(v.onShoulder && v.stillSince != null)) {
          v.parkLane = S;
          v.holdAtX = Math.min(this.cfg.length - 6, v.x + 35);
          v.stillSince = undefined;
          v.facTarget = undefined;
        }
        continue;
      }
      v.departing = true;
      v.holdAtX = undefined;
      v.v0 = Math.min(v.v0, v.role === "wreck" ? 12 : 18);
      v.aMax = Math.min(v.aMax, 1.0);
      // Righted for the tow.
      if (v.look === "overturned") v.look = "crash";
    }
    const tow = mine.find((v) => v.role === "responder" && v.responderKind === "tow" && v.stillSince != null);
    if (tow) {
      const load = mine
        .filter((v) => v.role === "wreck" && Boolean(v.onShoulder) === Boolean(tow.onShoulder) && v.lane === tow.lane && v.x <= tow.x - tow.length + 0.5 && tow.x - tow.length - v.x < 40)
        .sort((a, b) => b.x - a.x)[0];
      if (load) {
        load.towedBy = tow;
        load.hitched = false;
        tow.towing = load;
      }
    }
    this.pendingResponders = this.pendingResponders.filter((r) => r.sceneKey !== sceneKey);
    this.scenes = this.scenes.filter((s) => s.key !== sceneKey);
  }

  /** Responders waiting to be released onto the road. `lane` is the lane they park in. */
  private pendingResponders: { kind: ResponderKind; lane: number; holdAtX: number; at: number; sceneKey?: string }[] = [];

  /** Queue a responder to come up the shoulder to the scene and park at holdAtX in `lane` (the shoulder's number for the shoulder). */
  dispatchResponder(kind: ResponderKind, lane: number, holdAtX: number, delayS: number, sceneKey?: string) {
    this.pendingResponders.push({ kind, lane, holdAtX: Math.max(10, holdAtX), at: this.time + delayS, sceneKey });
  }

  /* Responders due onto the road: onto the hard shoulder at the entrance.
   *
   * They used to enter in their lane like ordinary traffic, waiting for a gap at the entrance. With a lane closed the
   * queue reaches back to the entrance, so the gap never came: the ambulance was "dispatched" and never seen. On the
   * shoulder they get past the queue, as they do on the real road, and cross into the lane at the scene. */
  private releaseResponders() {
    if (this.pendingResponders.length === 0) return;
    const S = this.shoulderLane;
    const still: typeof this.pendingResponders = [];
    for (const r of this.pendingResponders) {
      if (this.time < r.at) { still.push(r); continue; }
      /* A works crew is not an emergency: it drives in with the traffic, in the lane it is going to close, and pulls up
         there — set off early enough to be parked before the lane shuts (sceneLeadS). Up the shoulder like an
         ambulance, it stopped level with the works and cut sideways across every lane between, standing in live
         traffic for twenty seconds, and arrived half a minute after the lane had closed round nothing. */
      if (r.kind === "works" && r.lane < this.cfg.laneCount) {
        const crew: Vehicle = {
          id: -1, lane: r.lane, x: 0, v: 0, vClass: RESPONDER_CLASS.works, profile: "normal",
          v0: 18, T: 1.6, aMax: 1.1, politeness: 0.4, lcSec: 1.6,
          scanSec: 0.5, scanTimer: 0, reactionS: 0.5, reactTimer: 0, accel: 0,
          patience: 2, exitAtX: null, stuckFor: 0,
          length: RESPONDER_LENGTH.works, spawnTime: this.time, co2: 0, laneCooldown: 0,
          laneFrom: r.lane, laneShift: 1,
          color: RESPONDER_COLOR.works,
          role: "responder", responderKind: "works", holdAtX: r.holdAtX, parkLane: r.lane, sceneKey: r.sceneKey,
        };
        if (!this.roomFor(crew, r.lane, 0)) { still.push(r); continue; }
        // At the speed of the traffic it joins, so nobody has to brake hard for it.
        const ahead = this.vehicles.filter((o) => occupiesLane(o, r.lane) && o.x > 0).sort((a, b) => a.x - b.x)[0];
        crew.v = Math.min(14, ahead ? ahead.v : 14);
        crew.id = this.nextId++;
        this.vehicles.push(crew);
        continue;
      }
      // One at a time: the last one on has to have moved off the entrance first.
      if (this.shoulder.some((o) => o.x - o.length < 4)) { still.push(r); continue; }
      const urgent = r.kind !== "works";
      this.shoulder.push({
        id: this.nextId++, lane: S, x: 0, v: SHOULDER_SPEED[r.kind] * 0.8, vClass: RESPONDER_CLASS[r.kind], profile: "normal",
        v0: urgent ? 26 : 16, T: urgent ? 0.8 : 1.6, aMax: urgent ? 2.2 : 1.1, politeness: urgent ? 0 : 0.4, lcSec: 1.3,
        scanSec: 0.5, scanTimer: 0, reactionS: 0.5, reactTimer: 0, accel: 0,
        patience: 2, exitAtX: null, stuckFor: 0,
        length: RESPONDER_LENGTH[r.kind], spawnTime: this.time, co2: 0, laneCooldown: 0,
        laneFrom: S, laneShift: 1,
        color: RESPONDER_COLOR[r.kind],
        role: "responder", responderKind: r.kind, holdAtX: r.holdAtX, parkLane: r.lane, sceneKey: r.sceneKey, onShoulder: true,
      });
    }
    this.pendingResponders = still;
  }

  /* A vehicle pulling over onto the shoulder (a shoulder breakdown, slowing), and a responder that went round something
   * stopped on the shoulder coming back onto it, once there is room there. */
  private pullOntoShoulder(): void {
    const S = this.shoulderLane;
    const outer = this.cfg.laneCount - 1;
    const moving: Vehicle[] = [];
    for (const v of this.vehicles) {
      if (v.lane !== outer || v.laneShift < 1) continue;
      const d = v.doom;
      const pulling = d !== undefined && d.scene.kind === "shoulder" && d.brakeFromV !== undefined && (v.v < 14 || d.scene.stopX - v.x < 60);
      if (v.role === "responder" && !v.departing && v.parkLane === S && v.holdAtX != null) v.holdAtX = this.freeShoulderSpot(v, v.holdAtX);
      const back =
        v.role === "responder" && !v.departing && v.parkLane === S && v.holdAtX != null &&
        !this.shoulder.some((o) => o.v < 0.5 && o.x > v.x - 2 && o.x - o.length < v.holdAtX!);
      if (!pulling && !back) continue;
      if (!this.shoulderFree(v.x, v.length, v)) continue;
      moving.push(v);
    }
    if (moving.length === 0) return;
    this.vehicles = this.vehicles.filter((v) => !moving.includes(v));
    for (const v of moving) {
      v.onShoulder = true;
      v.viaShoulder = true;
      v.laneFrom = outer;
      v.lane = S;
      v.laneShift = 0;
      this.shoulder.push(v);
    }
  }

  /* The hard shoulder. Responders run up it past the traffic at a steady pace, one behind another, and leave it for their
   * lane level with where they park — or park on it, beside a vehicle stopped there. A vehicle pulling over coasts to a
   * stop on it. A truck with a casualty in tow goes on along it to the end. Nobody in a lane sees any of this: the
   * shoulder is not a lane. */
  private stepShoulder(dt: number): void {
    if (this.shoulder.length === 0) return;
    const S = this.shoulderLane;
    const outer = this.cfg.laneCount - 1;
    const list = this.shoulder.sort((a, b) => b.x - a.x);
    const toLane: Vehicle[] = [];
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.laneShift < 1) v.laneShift = Math.min(1, v.laneShift + dt / v.lcSec);
      else v.viaShoulder = false;
      if (v.role === "wreck" && !v.departing) { this.settleWreck(v, dt); continue; }
      if (v.towedBy) { this.followTow(v, dt); continue; }
      if (v.towing && !v.towing.hitched && list.includes(v.towing)) { v.v = 0; v.accel = 0; continue; }
      if (v.role === "responder" && v.stillSince != null && !v.departing) { v.v = 0; v.accel = 0; continue; }
      const lead = i > 0 ? list[i - 1] : null;
      let a: number;
      if (v.doom) a = this.doomAccel(v);
      else {
        const v0 = v.departing ? 14 : SHOULDER_SPEED[v.responderKind ?? "police"];
        a = v.aMax * (1 - Math.pow(v.v / Math.max(1, v0), DELTA));
        if (lead) {
          const gap = Math.max(0.1, lead.x - lead.length - v.x);
          const sStar = S0 + Math.max(0, v.v * 0.9 + (v.v * (v.v - lead.v)) / (2 * Math.sqrt(v.aMax * B_COMF)));
          a -= v.aMax * Math.pow(sStar / gap, 2);
        }
        if (v.holdAtX != null && !v.departing) a = Math.min(a, this.brakeTo(v, v.holdAtX));
      }
      const vNew = Math.max(0, v.v + Math.max(-8, Math.min(v.aMax, a)) * dt);
      v.x += Math.max(0, ((v.v + vNew) / 2) * dt);
      v.v = vNew;
      v.accel = a;
      if (lead && v.x > lead.x - lead.length - MIN_CLEARANCE) {
        v.x = Math.max(0, lead.x - lead.length - MIN_CLEARANCE);
        v.v = Math.min(v.v, lead.v);
      }
      if (v.doom) { this.doomContact(v, dt); continue; }
      if (v.role !== "responder" || v.departing || v.holdAtX == null) continue;
      // Something stopped on the shoulder before its spot: round it, through the outer lane.
      const blocked = lead !== null && lead.v < 0.5 && lead.x < v.holdAtX && lead.x - lead.length - v.x < 10;
      /* Held behind one of its own scene's vehicles, parked on the shoulder, with no way round (the lane beside is a
         standing queue): after half a minute this is where it attends from. It used to wait there, counted as still
         on its way, until the event ended. */
      if (blocked && v.v < 0.3 && lead!.sceneKey === v.sceneKey && lead!.stillSince != null && !this.roomFor(v, outer, v.x)) {
        v.shoulderWait = (v.shoulderWait ?? 0) + dt;
        if (v.shoulderWait > 30) {
          v.parkLane = S;
          v.holdAtX = v.x;
          v.stillSince = this.time;
          v.v = 0;
          continue;
        }
      } else v.shoulderWait = 0;
      /* Into the lane only where the lane is shut. A scene that closes nothing (an operator's accident, a shunt in a
         queue) has traffic queued right up behind it in that lane, so there is no room to stop in it: the police and
         the ambulance stop on the shoulder beside it instead. The recovery truck still goes in, in front, where the
         lane is empty. Decided on the way (and before going round anything), so it never has to come back. */
      if (v.parkLane !== S && v.responderKind !== "tow" && v.responderKind !== "works" && (blocked || v.x >= v.holdAtX - 80)) {
        const shut = this.closureList().some((c) => c.lanes[v.parkLane!] && v.holdAtX! >= c.from && v.holdAtX! <= c.to);
        if (!shut) {
          v.parkLane = S;
          /* On the shoulder they stop in the order they get there, the police (first) nearest the scene: the spots
             were set for the lane, where the police car blocks furthest back, and kept here the ambulance would have
             had to get past it on a shoulder one vehicle wide. */
          if (v.responderKind === "police") v.holdAtX += RESPONDER_LENGTH.ambulance + 5;
          else if (v.responderKind === "ambulance") v.holdAtX -= RESPONDER_LENGTH.ambulance + 5;
        }
      }
      if (v.parkLane === S) v.holdAtX = this.freeShoulderSpot(v, v.holdAtX);
      if (v.parkLane === S) {
        if (v.x >= v.holdAtX - 0.4 || (v.v < 0.3 && v.holdAtX - v.x < 4)) {
          v.stillSince = this.time;
          v.v = 0;
        } else if (blocked && this.roomFor(v, outer, v.x)) toLane.push(v);
      } else if (blocked && v.x < v.holdAtX - 14) {
        if (this.roomFor(v, outer, v.x)) toLane.push(v);
      } else if (v.x >= v.holdAtX - 14 && this.roomFor(v, outer, v.x)) {
        toLane.push(v);
      }
    }
    for (const v of toLane) {
      v.onShoulder = false;
      v.viaShoulder = true;
      v.laneFrom = S;
      v.lane = outer;
      v.laneShift = 0;
      v.laneCooldown = v.lcSec + 0.3;
      this.vehicles.push(v);
    }
    this.shoulder = list.filter((v) => !toLane.includes(v) && v.x - v.length < this.cfg.length);
  }

  step(dt: number) {
    const before = this.time;
    this.time += dt;
    // Interventions change only between steps (the scenario binding, the operator): the closure list is rebuilt once now.
    this.closureCache = null;
    /* Discard everything collected during the warm-up.
     *
     * The rolling windows alone are not enough: at the instant the warm-up
     * ends they still hold the previous 60 s, which is exactly the filling
     * transient the warm-up exists to exclude. Clearing them here means the
     * first warm reading is built only from warm data. */
    if (before < this.warmupS && this.time >= this.warmupS) {
      this.completedInWindow = [];
      this.completedTimes = [];
      this.co2Window = [];
      this.demanded = 0;
      this.admitted = 0;
    }
    // Every lookup below reads this; it must reflect the positions the
    // decisions are made against, so it is built before any of them.
    this.rebuildLaneIndex();
    this.liveIncidents = this.interventions.incidents.filter((i) => this.incidentArmed(i));
    this.findYields();

    // Inflow across ALL lanes — a lane closure is a downstream work zone, so
    // vehicles still enter the closing lane and must merge out at the taper.
    // That zipper merge is what makes congestion emerge on a closure.
    this.demanded += (this.cfg.inflowVehPerHour / 3600) * dt;
    this.spawnAccumulator += (this.cfg.inflowVehPerHour / 3600) * dt;
    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;
      /* A new arrival joins the entrance queue, whole: class, driver and destination drawn once. Past a few the
       * surplus is not traffic waiting to enter but demand the segment cannot serve, and is counted as such (it is
       * in `demanded` and never in `admitted`) rather than stored — left uncapped the queue reached 978 vehicles
       * in a 10-minute run, a phantom that nothing rendered and that would have flooded the road when demand eased. */
      if (this.waiting.length < MAX_ENTRY_QUEUE) this.waiting.push(this.newArrival(0));
    }
    /* Whoever fits goes in, in order of arrival. One that does not fit does not hold up the rest: they are in
     * different lanes, and a truck waiting for a long gap in one lane says nothing about a car that fits in
     * another. What matters is that nobody is discarded, so a queue that clears delivers exactly the fleet that
     * arrived. */
    for (let w = 0; w < this.waiting.length; ) {
      const arrival = this.waiting[w];
      // Class first, then a lane that class is allowed in. Picking the lane
      // first and downgrading anything heavy that landed in L1 would quietly
      // delete a quarter of the buses and trucks from the whole run; choosing
      // among the legal lanes instead keeps the fleet mix exactly as
      // configured and simply spreads the heavies over the lanes they may use.
      const vClass = arrival.vClass;
      /* Destination first, because it decides which lane they join in.
       *
       * Assigning a random lane and then asking the driver to cross the
       * carriageway is what a driver would never do: someone leaving at the
       * next interchange joins near the outside. Spawned at random instead,
       * 66% of them missed their exit and were silently re-assigned to a
       * later one, so the ramps drained at a third of the turning proportion
       * they were configured with. */
      const exitAtX = arrival.exitAtX;
      const legal: number[] = [];
      for (let l = 0; l < this.cfg.laneCount; l++) if (laneAllowsClass(vClass, l)) legal.push(l);
      // A one-lane road is all inner lane; there is nowhere legal to put a
      // truck, and refusing to spawn it would silently drop freight instead.
      if (legal.length === 0) legal.push(0);
      // Not into a lent lane for anyone leaving before the far crossover: they could not get back out.
      const lent = this.cfg.borrowed;
      if (lent && exitAtX != null && exitAtX < this.cfg.length - lent.crossM && legal.some((l) => l >= lent.lanes)) {
        for (let i = legal.length - 1; i >= 0; i--) if (legal[i] < lent.lanes) legal.splice(i, 1);
      }

      /* Try every lane the class may use, not just one at random.
       *
       * A spawn is refused when the entrance of that lane is still occupied,
       * and the vehicle was then simply discarded. That is not neutral: the
       * check is `nearest < length + gap`, so a 14 m truck is refused in
       * conditions a 4.6 m car passes, and the longer the vehicle the more
       * often it is dropped. The fleet on the road therefore drifted light no
       * matter what share was configured — measured at 5.6% Class 3 against
       * the 8.9% asked for.
       *
       * Shuffle so no lane is favoured, try them all, and if the whole
       * entrance is blocked give the credit back rather than destroying the
       * vehicle: the road is full, so the arrival is delayed, not cancelled. */
      for (let i = legal.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [legal[i], legal[j]] = [legal[j], legal[i]];
      }
      let placed = false;
      /* Someone leaving soon joins towards the outside; everyone else takes
       * whichever lane the shuffle offers. The shuffle above still applies
       * within each group, so no single lane is favoured. */
      if (exitAtX != null && exitAtX < EXIT_APPROACH_M * 1.5) legal.sort((a, b) => b - a);
      for (const lane of legal) {
        if (this.spawn(lane, arrival, exitAtX)) { placed = true; break; }
      }
      if (placed) {
        this.waiting.splice(w, 1); // in; the next one shifts into slot w
        this.admitted++;
      } else {
        w++; // stays in the queue as the same vehicle and driver, see waiting
      }
    }

    // Traffic joining at the interchanges. After the mainline spawn, and the
    // index is rebuilt because both of them add vehicles the decisions below
    // have to see.
    if (this.ramps.length > 0) {
      this.spawnFromRamps(dt);
      this.rebuildLaneIndex();
    }

    // Lane-change decisions (before motion, using current state).
    for (const v of this.vehicles) {
      v.laneCooldown = Math.max(0, v.laneCooldown - dt);
      // Advance any slide already running before this step can start a new one,
      // so a manoeuvre always gets its full crossing time on screen.
      if (v.laneShift < 1) v.laneShift = Math.min(1, v.laneShift + dt / v.lcSec);
      /* Each driver decides on their own cadence, not on the simulation's. A
       * driver whose lane is closing ahead of them is watching far more
       * closely, so their clock runs faster. */
      const alert = this.laneBlockedFor(v.lane, v.x);
      // Patience runs down only while actually stuck: stopped, in a lane that
      // is closing. Any progress at all resets it.
      if (alert && v.v < CREEP_SPEED) v.stuckFor += dt;
      else v.stuckFor = 0;
      v.scanTimer -= alert ? dt * SCAN_ALERT_FACTOR : dt;
      if (v.scanTimer <= 0) {
        v.scanTimer = v.scanSec;
        this.considerLaneChange(v);
      }
    }

    // Longitudinal update (ballistic integration, clamped to >= 0).
    for (const v of this.vehicles) {
      const oldX = v.x;
      /* A wreck is where it stopped — decided BEFORE it is moved. This used to come after the integration below, which
         moved it by its own (free-road) acceleration first and only then zeroed its speed: a wreck crept downstream,
         measured at 4 m over a twenty-minute scene. */
      if (v.role === "wreck" && !v.departing) { this.settleWreck(v, dt); continue; }
      // Hitched to a recovery truck: it goes where the truck goes.
      if (v.towedBy) { this.followTow(v, dt); continue; }
      // A recovery truck waits while its load is winched up behind it.
      if (v.towing && !v.towing.hitched && this.vehicles.includes(v.towing)) { v.v = 0; v.accel = 0; continue; }
      // Parked at the scene: it stays put (the overlap pass below still makes it give way to anyone already in its cell).
      if (v.role === "responder" && v.stillSince != null && !v.departing) { v.v = 0; v.accel = 0; continue; }
      // Clamp to THIS driver's acceleration. Against the global A_MAX, every
      // driver drawn above average simply had the difference clipped off here,
      // quietly handing back the spread the traits were added to create.
      /* Recompute only when this driver's reaction time is up; otherwise keep
       * holding the acceleration they last chose. This is the lag: for up to
       * `reactionS` they are acting on a road that has already changed. */
      v.reactTimer -= dt;
      if (v.doom) {
        // Scripted every step: the moment it fails to stop IS the event, and a lag would only blur it.
        v.accel = this.doomAccel(v);
      } else if (v.role === "responder" && !v.departing && v.holdAtX != null && v.stillSince == null) {
        // On its way to its spot: following the traffic, and slowing to stop there.
        if (v.reactTimer <= 0) v.reactTimer = v.reactionS;
        v.accel = Math.min(this.idmAccel(v, v.lane), this.brakeTo(v, v.holdAtX));
        /* Standing in a live lane waiting to get across to its own, with nobody letting it: rather than stand there
           holding up a second lane, it pulls onto the shoulder and stops there. */
        v.heldFor = v.v < 0.3 && v.lane !== v.parkLane ? (v.heldFor ?? 0) + dt : 0;
        if (v.heldFor > 15 && v.responderKind !== "tow" && v.responderKind !== "works") v.parkLane = this.shoulderLane;
      } else if (v.role === "responder" && !v.departing && v.facTarget && v.stillSince == null) {
        /* Sent to a plaza or a service area. Two things an ordinary driver does that it must not:
           - miss the exit. Not yet in the lane the ramp leaves from, it stops short of the gore and waits for a way
             across (considerLaneChange gives it one as soon as there is room); it used to drive on down the
             expressway, away from the scene it was sent to.
           - wait unseen. Held in the queue for its own scene — at the gore, at the barrier's mouth — with the ramp
             behind the crash full, that is as near as it can get, and where it attends from. */
        if (v.reactTimer <= 0) v.reactTimer = v.reactionS;
        const short = v.exitAtX != null && v.lane !== this.exitLane ? this.brakeTo(v, v.exitAtX - 8) : 99;
        v.accel = Math.min(this.idmAccel(v, v.lane), short);
        v.heldFor = v.v < 0.3 ? (v.heldFor ?? 0) + dt : 0;
        if (v.heldFor > 5 && v.sceneKey !== undefined && this.fac.sceneLane(v.sceneKey) !== undefined) {
          v.stillSince = this.time;
          v.v = 0;
          v.accel = 0;
          continue;
        }
      } else if (v.reactTimer <= 0) {
        v.reactTimer = v.reactionS;
        v.accel = this.idmAccel(v, v.lane);
      }
      // Driving off: a wreck straightens up as it goes.
      if (v.role === "wreck" && v.yaw) v.yaw *= Math.max(0, 1 - dt * 1.2);
      const a = Math.max(-8, Math.min(v.aMax, v.accel));
      const vNew = Math.max(0, v.v + a * dt);
      v.x += Math.max(0, (v.v + vNew) / 2 * dt);
      v.v = vNew;
      // Safety net: a discrete step can carry a fast car *past* a stalled
      // obstacle the IDM couldn't brake for in time. Never let a car drive
      // out the far side of an accident (or closed-lane taper) — it stops
      // against it instead.
      // Waiting at a full ramp or plaza: stands in its lane until there is room.
      if (v.heldAtGore) { v.v = 0; v.accel = 0; continue; }
      /* On its way into a scene: has it happened? A wreck now is where it came to rest — it stays in the vehicle
         list, so every follower's car-following term and the overlap correction both see it, which is what makes it an
         obstacle for free. */
      if (v.doom) this.doomContact(v, dt);
      if (v.role === "wreck" && !v.departing) continue;

      /* A responder holds station once it reaches the scene. Braking into it
         rather than stopping dead, so it arrives rather than snapping to a
         halt — and it is still a normal vehicle to everyone behind. */
      if (v.role === "responder" && !v.departing && v.holdAtX != null && v.lane === v.parkLane && v.laneShift >= 1 &&
          (v.stillSince != null || v.x >= v.holdAtX - 0.4 || (v.v < 0.3 && v.holdAtX - v.x < 4))) {
        if (v.stillSince == null) v.stillSince = this.time;
        /* Park AT the station, or short of it if someone is in the way.
         *
         * Pinning straight to holdAtX let a responder stop with its nose
         * inside a car that had already committed to a lane change into that
         * cell. Once parked it is immovable, and the car is ahead of it, so
         * the correction pass has nobody it can push — the overlap simply
         * stayed. Stopping short is what a driver does, and it is the only
         * place this can be resolved. */
        let limit = v.holdAtX;
        for (const o of this.vehicles) {
          if (o === v || !occupiesLane(o, v.lane)) continue;
          if (o.x - o.length < v.x) continue;              // behind us
          limit = Math.min(limit, o.x - o.length - MIN_CLEARANCE);
        }
        v.x = Math.max(0, Math.min(v.x, limit));
        v.v = 0;
        v.accel = 0;
        continue;
      }

      const wall = this.blockPointAhead(v.lane, oldX, v);
      if (v.x > wall) {
        /* Stop against the obstacle — but behind anything already stopped
         * against it. Clamping straight to `wall` put every queued vehicle at
         * the identical coordinate, so a truck and a car ended up drawn on top
         * of one another at the taper (measured: 0.4% of ticks, worst overlap
         * 13.8 m, which is a whole articulated lorry inside a hatchback). */
        const ahead = this.firstAfter(v.lane, oldX, v);
        const limit = ahead ? Math.min(wall, ahead.x - ahead.length - S0) : wall;
        // Never below oldX: this is a brake, not a reversing manoeuvre.
        v.x = Math.max(oldX, Math.min(v.x, limit));
        v.v = 0;
      }
      this.emit(v, Math.max(0, v.x - oldX), dt);
    }

    // A wreck in tow sits on its hitch at the truck's position after the truck has moved, not one step behind it.
    for (const v of this.vehicles) if (v.towedBy && v.hitched) v.x = Math.max(v.x, v.towedBy.x - v.towedBy.length - 1.0);
    // Onto the hard shoulder: a vehicle pulling over, a responder coming back to it.
    this.pullOntoShoulder();

    /* Everything inside the plazas and service areas moves on the same tick,
     * after the carriageway: a vehicle merging back has to judge the lane as it
     * now is, and the overlap net below has to see both. */
    if (this.fac.list.length > 0) this.fac.step(dt);

    /* Overlap safety net.
     *
     * IDM braking is capped at -8 m/s² and integrated in 0.05 s steps, so a
     * follower behind a vehicle that stops instantly — one clamped at a
     * taper, or an incident dropped in front of it — can penetrate it before
     * it has slowed. Two sprites drawn through each other is the most
     * obviously wrong thing this canvas can show, and it was happening on
     * 1.8% of ticks with a worst case of 8 m.
     *
     * So positions are corrected after the fact: nobody may occupy the space
     * inside the vehicle ahead. Leaders first, so one pass propagates a
     * correction back down the queue. The clearance is deliberately far
     * smaller than S0 — this is an anti-overlap floor, not a headway rule,
     * and using S0 here would forcibly space out legitimate jams and change
     * the flow it is supposed to be rendering. */
    /* Run to a fixed point rather than once.
     *
     * A straddling vehicle now appears in two rows, so a correction made in
     * the lane it is entering can re-break the constraint in the lane it is
     * leaving, which a single pass never revisits. Iterating cleared the
     * residue the two-lane fix left behind (0.09% of ticks, worst 4.6 m).
     * Four passes is a bound, not a target — the loop stops as soon as a
     * pass changes nothing, which is almost always the first. */
    const shadows = this.fac.list.length > 0 ? this.fac.shadows() : [];
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
    for (let l = 0; l < this.cfg.laneCount; l++) {
      /* A vehicle part-way through a lane change is physically in BOTH lanes,
       * and the renderer draws it between them. Filtering on the integer lane
       * alone missed exactly that case: measured over 600 s at 5,200 veh/h
       * with an incident, 1.76% of ticks drew two sprites through each other,
       * worst case 9.0 m at 0.55 lane widths apart — an articulated lorry
       * inside a car. Every one of those pairs was a straddle; the same-lane
       * count was zero, so the net below was always correct, it simply never
       * saw half the occupants.
       *
       * Including a straddling vehicle in the lane it is leaving also makes
       * the follower there hold back until the gap is genuinely vacated,
       * which is what happens on a real carriageway. */
      const row = this.vehicles.filter((v) => occupiesLane(v, l));
      // A vehicle half off the road on a taper is still in this lane's way.
      for (const sh of shadows) if (sh.fac!.shadowLane === l) row.push(sh);
      row.sort((a, b) => b.x - a.x);
      for (let i = 1; i < row.length; i++) {
        const lead = row[i - 1];
        const me = row[i];
        const maxX = lead.x - lead.length - MIN_CLEARANCE;
        /* Never behind the entrance line. A vehicle pushed to negative x is
         * off the road: invisible, immobile, and still counted in density.
         * Measured at 925,052 vehicle-ticks in an oversaturated run, which is
         * what made density read 301/km/lane — above the physical jam
         * maximum — while the visible road looked half empty. Traffic that
         * cannot fit is refused at the entrance instead; see spawn(). */
        if (me.x > maxX + 1e-9) {
          /* A WRECK is where it stopped: that position is the scenario, and
             shoving it back would be the correction rewriting the event.
             A parked responder is different — where exactly it stopped
             carries no meaning, so it yields a metre rather than being drawn
             through. That distinction is the last 0.04%: a car already
             committed to a lane change arrives after the responder has
             parked, and since the responder is BEHIND it, there is no
             follower for the pass to push. Letting the responder give way is
             the only resolution, and it is stable because the hold below
             never moves it forward again. */
          if (me.role === "wreck" && !me.departing) continue;
          // Its own engine moves a facility vehicle; this net only keeps others out of it.
          if (me.fac) continue;
          me.x = Math.max(0, maxX);
          me.v = Math.min(me.v, lead.v); // stop pushing into it
          moved = true;
        }
      }
    }
      if (!moved) break;
    }

    // The hard shoulder, then responders onto it if any are due, then the scenes being put together.
    this.stepShoulder(dt);
    this.releaseResponders();
    this.stepScenes();
    if (this.fac.list.length > 0) this.releaseFacilityResponders();

    // A shunt in the queue behind an existing incident, if one is due.
    this.maybeSecondary(dt);

    // Vehicles peeling off at their interchange.
    this.takeExits();

    // Into the booths at a barrier plaza.
    this.enterBarriers();

    // Retire vehicles that cleared the segment; record travel time.
    const remaining: Vehicle[] = [];
    for (const v of this.vehicles) {
      if (v.x >= this.cfg.length) {
        /* Only through-traffic counts as a completed trip. A responder that
           drives off the end is not a road user the corridor served, and a
           wreck never gets there at all — counting either would inflate
           throughput with vehicles the scenario itself put on the road. */
        if (v.role === "traffic") {
          this.completedTimes.push(this.time - v.spawnTime);
          this.completedInWindow.push(this.time);
        }
      } else remaining.push(v);
    }
    this.vehicles = remaining;

    // Trim rolling windows (keep ~60 s / last 40 completions).
    const cutoff = this.time - 60;
    this.completedInWindow = this.completedInWindow.filter((t) => t >= cutoff);
    this.co2Window = this.co2Window.filter((e) => e.t >= this.time - 5);
    if (this.completedTimes.length > 40) this.completedTimes = this.completedTimes.slice(-40);
  }

  metrics(): Metrics {
    const n = this.vehicles.length;
    const avgV = n ? this.vehicles.reduce((s, v) => s + v.v, 0) / n : 0;
    const stopped = this.vehicles.filter((v) => v.v < 1).length;

    // longest standing queue (contiguous slow vehicles, any lane), in metres
    let longestQueue = 0;
    for (let l = 0; l < this.cfg.laneCount; l++) {
      const slow = this.vehicles
        .filter((v) => v.lane === l && v.v < 3)
        .sort((a, b) => a.x - b.x);
      let runStart: number | null = null;
      let prev: number | null = null;
      for (const v of slow) {
        if (prev == null || v.x - prev < 25) {
          if (runStart == null) runStart = v.x;
          prev = v.x;
        } else {
          longestQueue = Math.max(longestQueue, prev - (runStart ?? prev));
          runStart = v.x;
          prev = v.x;
        }
      }
      if (runStart != null && prev != null) longestQueue = Math.max(longestQueue, prev - runStart);
    }

    /* Measure from the end of the warm-up, not from t=0.
     *
     * The rolling windows already age old samples out, but the DENOMINATOR was
     * wrong during the transient: dividing by elapsed time while the road was
     * still filling counted an empty minute as if traffic had been flowing
     * through it, which understates throughput and makes the first reading a
     * scenario nobody chose. */
    const warm = this.time >= this.warmupS;
    const since = Math.max(1, this.time - (warm ? this.warmupS : 0));
    const windowSpanMin = Math.min(60, since) / 60;
    const throughput = this.completedInWindow.length / windowSpanMin;
    const co2g = this.co2Window.reduce((s, e) => s + e.g, 0);
    const co2Span = Math.min(5, Math.max(0.5, since));
    const co2RatePerMin = (co2g / co2Span) * 60 / 1000; // kg/min
    const avgTT = this.completedTimes.length
      ? this.completedTimes.reduce((s, t) => s + t, 0) / this.completedTimes.length
      : 0;

    return {
      activeAgents: n,
      avgSpeedKmh: avgV * 3.6,
      throughputPerMin: throughput,
      densityPerKmLane: (n / (this.cfg.length / 1000)) / this.cfg.laneCount,
      stoppedCount: stopped,
      longestQueueM: longestQueue,
      co2RatePerMin,
      avgTravelTimeS: avgTT,
      completed: this.completedInWindow.length,
      elapsedS: this.time,
      warm,
      unmetVehPerHour: Math.max(0, (this.demanded - this.admitted) / since) * 3600,
    };
  }
}

export const CLASS_META = CLASS;

/* ───────────────────────────────────────────────────────────────────────────
 * Replications
 *
 * A single run of a stochastic model is one sample, not an answer. The sandbox
 * animates one seed because that is what a sandbox is for, but any number an
 * operator is going to ACT on — "this closure costs 18% of throughput" — has
 * to come with an idea of how much of that 18% is the closure and how much is
 * the particular set of drivers this seed happened to generate.
 *
 * So the same scenario is run several times on different seeds and reported as
 * a mean with a confidence interval. If the interval straddles zero, the
 * difference is not evidence of anything.
 * ------------------------------------------------------------------------ */

export type RepStat = {
  mean: number;
  sd: number;
  /** Half-width of the 95% confidence interval on the mean. */
  ci95: number;
  n: number;
};

export type ReplicationResult = {
  runs: number;
  secondsPerRun: number;
  warmupS: number;
  avgSpeedKmh: RepStat;
  throughputPerMin: RepStat;
  longestQueueM: RepStat;
  co2RatePerMin: RepStat;
  avgTravelTimeS: RepStat;
  unmetVehPerHour: RepStat;
};

/* Student's t for a 95% two-sided interval, by degrees of freedom.
 *
 * Not the normal 1.96: at the run counts anyone will actually wait for (5-20)
 * that understates the interval by a fifth or more, which is exactly the range
 * where an honest error bar matters most. */
const T95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
  8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145,
  15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
  24: 2.064, 29: 2.045, 39: 2.023, 59: 2.001,
};
function tCrit(df: number): number {
  if (df <= 0) return 0;
  if (T95[df]) return T95[df];
  const keys = Object.keys(T95).map(Number).sort((a, b) => a - b);
  for (const k of keys) if (df < k) return T95[k];
  return 1.96;
}

function summarise(xs: number[]): RepStat {
  const n = xs.length;
  if (n === 0) return { mean: 0, sd: 0, ci95: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, sd: 0, ci95: 0, n };
  // Sample standard deviation (n-1): these are a sample of possible runs, not
  // the population of them.
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { mean, sd, ci95: tCrit(n - 1) * (sd / Math.sqrt(n)), n };
}

export type RepProgress = { done: number; total: number; label: string };

/* Runs `runs` independent replications, yielding progress so a caller can keep
 * a UI responsive. Each replication is a fresh simulation on its own seed;
 * within a run, metrics are sampled repeatedly after the warm-up and averaged,
 * because a single end-of-run snapshot is itself just one more sample. */
export function* replicate(
  cfg: Omit<SimConfig, "seed"> & { seed?: number },
  interventions: Partial<Interventions>,
  opts: { runs?: number; secondsPerRun?: number; dt?: number; sampleEvery?: number } = {},
): Generator<RepProgress, ReplicationResult, void> {
  const runs = opts.runs ?? 10;
  const secondsPerRun = opts.secondsPerRun ?? 420;
  const dt = opts.dt ?? 0.05;
  const sampleEvery = opts.sampleEvery ?? 5;
  const warmupS = cfg.warmupS ?? DEFAULT_WARMUP_S;

  const speed: number[] = [], thru: number[] = [], queue: number[] = [];
  const co2: number[] = [], tt: number[] = [], unmet: number[] = [];

  for (let r = 0; r < runs; r++) {
    // Seeds spaced widely: adjacent seeds in a cheap PRNG can correlate, and
    // correlated replications would understate the variance the whole exercise
    // exists to measure.
    const seed = (cfg.seed ?? 12345) + r * 7919;
    const sim = new TrafficSim({ ...cfg, seed }, interventions);
    const s: number[] = [], t: number[] = [], q: number[] = [];
    const c: number[] = [], a: number[] = [], u: number[] = [];
    let nextSample = warmupS + sampleEvery;
    const steps = Math.round(secondsPerRun / dt);
    for (let i = 0; i < steps; i++) {
      sim.step(dt);
      if (sim.time >= nextSample) {
        nextSample += sampleEvery;
        const m = sim.metrics();
        if (!m.warm) continue;
        s.push(m.avgSpeedKmh); t.push(m.throughputPerMin); q.push(m.longestQueueM);
        c.push(m.co2RatePerMin); a.push(m.avgTravelTimeS); u.push(m.unmetVehPerHour);
      }
      // Yield between simulated seconds so a browser caller can paint.
      if (i % Math.round(1 / dt) === 0) {
        yield { done: r + i / steps, total: runs, label: `run ${r + 1} of ${runs}` };
      }
    }
    const avg = (xs: number[]) => (xs.length ? xs.reduce((p, n2) => p + n2, 0) / xs.length : 0);
    speed.push(avg(s)); thru.push(avg(t)); queue.push(avg(q));
    co2.push(avg(c)); tt.push(avg(a)); unmet.push(avg(u));
  }

  return {
    runs, secondsPerRun, warmupS,
    avgSpeedKmh: summarise(speed),
    throughputPerMin: summarise(thru),
    longestQueueM: summarise(queue),
    co2RatePerMin: summarise(co2),
    avgTravelTimeS: summarise(tt),
    unmetVehPerHour: summarise(unmet),
  };
}

/** Blocking convenience wrapper for headless callers (scripts, validation). */
export function replicateSync(
  cfg: Omit<SimConfig, "seed"> & { seed?: number },
  interventions: Partial<Interventions>,
  opts?: Parameters<typeof replicate>[2],
): ReplicationResult {
  const g = replicate(cfg, interventions, opts);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}
