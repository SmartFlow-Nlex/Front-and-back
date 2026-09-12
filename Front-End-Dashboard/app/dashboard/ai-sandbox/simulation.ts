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

export type VehicleClass = 1 | 2 | 3;
export type DriverProfile = "cautious" | "normal" | "aggressive";

export type Vehicle = {
  id: number;
  lane: number;
  x: number; // metres from segment start
  v: number; // m/s
  vClass: VehicleClass;
  profile: DriverProfile;
  v0: number; // desired free-flow speed (m/s)
  length: number; // m
  spawnTime: number; // sim seconds
  co2: number; // grams emitted so far
  laneCooldown: number; // seconds until next lane change allowed
  color: string; // the agent's own paint — class hue with per-vehicle variation
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
  incidents: { lane: number; x: number }[]; // stalled obstacles
  speedLimitKmh: number | null; // applies in the speed zone
  speedZone: [number, number]; // [from, to] metres
};

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
};

export type SimConfig = {
  length: number; // segment length (m)
  laneCount: number;
  inflowVehPerHour: number; // total across all open lanes
  seed: number;
};

// Per-class kinematics. Heavier = slower desired speed, longer, more CO2/km.
// Colours are a colourblind-safe categorical trio (validated) so each class is
// identifiable at a glance; red is deliberately avoided (it marks a stopped car).
const CLASS = {
  1: { v0: 30, len: 4.6, co2PerM: 0.16, color: "#3e67ef", share: 0.78 }, // light — blue
  2: { v0: 25, len: 9, co2PerM: 0.55, color: "#1f9d57", share: 0.16 }, // medium — green
  3: { v0: 22, len: 14, co2PerM: 0.95, color: "#9b5de5", share: 0.06 }, // heavy — purple
} as const;

// Driver profile modifiers: time headway T, desired-speed factor, politeness.
const PROFILE = {
  cautious: { T: 1.8, v0f: 0.92, politeness: 0.5 },
  normal: { T: 1.4, v0f: 1.0, politeness: 0.3 },
  aggressive: { T: 1.0, v0f: 1.12, politeness: 0.1 },
} as const;

// IDM constants
const A_MAX = 1.4; // max accel m/s^2
const B_COMF = 2.0; // comfortable decel m/s^2
const S0 = 2.5; // minimum bumper gap m
const DELTA = 4;
const INCIDENT_LENGTH = 5; // a stalled vehicle occupies ~5 m of lane

const B_SAFE = 4.0; // MOBIL: max decel a follower may be forced into
const LC_THRESHOLD = 0.2; // MOBIL: incentive threshold m/s^2
const LC_BIAS_ESCAPE = 3.0; // strong pull to leave a lane that's blocked ahead

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
  interventions: Interventions;
  time = 0;
  private rng: () => number;
  private nextId = 1;
  private spawnAccumulator = 0;

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

  constructor(cfg: SimConfig, interventions?: Partial<Interventions>) {
    this.cfg = cfg;
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
    const { closurePoint: cFrom, closureEnd: cTo } = this.interventions;
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
        if (this.interventions.closedLanes[lane] && x >= cFrom && x <= cTo) {
          x -= 10;
          continue;
        }
        const vClass = this.pickClass();
        const profile = this.pickProfile();
        const c = CLASS[vClass];
        const p = PROFILE[profile];
        const v0 = c.v0 * p.v0f;
        const v = v0 * (0.85 + 0.15 * this.rng());
        this.vehicles.push({
          id: this.nextId++,
          lane,
          x,
          v,
          vClass,
          profile,
          v0,
          length: c.len,
          // Negative so the first throughput readings are not skewed by a
          // cohort that appears to have crossed the segment instantly.
          spawnTime: -(this.cfg.length - x) / Math.max(1, v),
          co2: 0,
          laneCooldown: 0,
          color: varyColor(c.color, this.rng()),
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
    if (r < CLASS[1].share) return 1;
    if (r < CLASS[1].share + CLASS[2].share) return 2;
    return 3;
  }

  private pickProfile(): DriverProfile {
    const r = this.rng();
    return r < 0.25 ? "cautious" : r < 0.85 ? "normal" : "aggressive";
  }

  private spawn(lane: number) {
    const vClass = this.pickClass();
    const profile = this.pickProfile();
    const c = CLASS[vClass];
    const p = PROFILE[profile];
    // don't spawn on top of a vehicle sitting near the entrance
    const nearest = this.vehicles
      .filter((v) => v.lane === lane)
      .reduce((min, v) => Math.min(min, v.x), Infinity);
    if (nearest < c.len + S0 + 4) return false;
    this.vehicles.push({
      id: this.nextId++,
      lane,
      x: 0,
      v: Math.min(c.v0 * p.v0f, 22) * (0.6 + 0.3 * this.rng()),
      vClass,
      profile,
      v0: c.v0 * p.v0f,
      length: c.len,
      spawnTime: this.time,
      co2: 0,
      laneCooldown: 0,
      color: varyColor(c.color, this.rng()),
    });
    return true;
  }

  // Desired speed at a position, honouring an active speed-limit zone.
  private desiredSpeed(v: Vehicle): number {
    const { speedLimitKmh, speedZone } = this.interventions;
    if (speedLimitKmh != null && v.x >= speedZone[0] && v.x <= speedZone[1]) {
      return Math.min(v.v0, speedLimitKmh / 3.6);
    }
    return v.v0;
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
    for (const inc of this.interventions.incidents) {
      if (inc.lane === lane && inc.x > v.x && inc.x < bestX) {
        bestX = inc.x;
        leadV = 0;
        leadLen = INCIDENT_LENGTH;
      }
    }
    // A closure acts as a stopped obstacle at its taper — but only for traffic
    // that has not already passed the far end. Without the second test a
    // vehicle that has cleared the works still braked for a barrier behind it.
    if (
      this.interventions.closedLanes[lane] &&
      v.x < this.interventions.closureEnd &&
      this.interventions.closurePoint > v.x &&
      this.interventions.closurePoint < bestX
    ) {
      bestX = this.interventions.closurePoint;
      leadV = 0;
      leadLen = 0;
    }
    if (!isFinite(bestX)) return null;
    const gap = bestX - v.x - leadLen;
    return { gap: Math.max(0.1, gap), dv: v.v - leadV };
  }

  private idmAccel(v: Vehicle, lane: number): number {
    const p = PROFILE[v.profile];
    const v0 = this.desiredSpeed(v);
    const free = A_MAX * (1 - Math.pow(v.v / Math.max(1, v0), DELTA));
    const lead = this.leaderAhead(v, lane);
    if (!lead) return free;
    const sStar = S0 + Math.max(0, v.v * p.T + (v.v * lead.dv) / (2 * Math.sqrt(A_MAX * B_COMF)));
    const interaction = -A_MAX * Math.pow(sStar / lead.gap, 2);
    return free + interaction;
  }

  // Would merging a vehicle of `length` at front-position `x` land it on top of
  // (or right up against) a stalled incident in `lane`? Used to stop cars from
  // changing lanes directly onto an accident.
  private incidentTooCloseInLane(lane: number, x: number, length: number): boolean {
    for (const inc of this.interventions.incidents) {
      if (inc.lane !== lane) continue;
      const incFront = inc.x;
      const incRear = inc.x - INCIDENT_LENGTH;
      // the vehicle would occupy [x - length, x]; require an S0 buffer each side
      if (incFront > x - length - S0 && incRear < x + S0) return true;
    }
    return false;
  }

  // MOBIL-ish lane change: pick the neighbouring lane that is safe and offers a
  // meaningfully better acceleration, with a strong pull out of a blocked lane.
  private considerLaneChange(v: Vehicle) {
    if (v.laneCooldown > 0) return;
    const here = this.idmAccel(v, v.lane);
    // Blocked for THIS vehicle only while it is upstream of the works.
    const blockedFor = (lane: number) =>
      this.interventions.closedLanes[lane] && v.x < this.interventions.closureEnd;
    const mustEscape = blockedFor(v.lane) && v.x < this.interventions.closurePoint;
    const candidates = [v.lane - 1, v.lane + 1].filter(
      (l) => l >= 0 && l < this.cfg.laneCount && !blockedFor(l),
    );
    let best: { lane: number; gain: number } | null = null;
    for (const lane of candidates) {
      // never change lanes onto (or right up against) an accident
      if (this.incidentTooCloseInLane(lane, v.x, v.length)) continue;
      // safety: would the new follower have to brake harder than B_SAFE?
      const follower = this.lastBefore(lane, v.x, v);
      if (follower) {
        const gapToMe = v.x - follower.x - follower.length;
        if (gapToMe < S0) continue;
        const followerAccel = this.idmAccelAgainst(follower, v.x, v.v, v.length);
        if (followerAccel < -B_SAFE) continue;
      }
      const there = this.idmAccel(v, lane);
      let gain = there - here;
      if (mustEscape) gain += LC_BIAS_ESCAPE;
      if (gain > LC_THRESHOLD && (!best || gain > best.gain)) best = { lane, gain };
    }
    if (best) {
      v.lane = best.lane;
      v.laneCooldown = 2.0;
    }
  }

  // IDM accel of `f` if a vehicle were at position `leadX` moving `leadV`.
  private idmAccelAgainst(f: Vehicle, leadX: number, leadV: number, leadLen: number): number {
    const p = PROFILE[f.profile];
    const v0 = this.desiredSpeed(f);
    const free = A_MAX * (1 - Math.pow(f.v / Math.max(1, v0), DELTA));
    const gap = Math.max(0.1, leadX - f.x - leadLen);
    const dv = f.v - leadV;
    const sStar = S0 + Math.max(0, f.v * p.T + (f.v * dv) / (2 * Math.sqrt(A_MAX * B_COMF)));
    return free - A_MAX * Math.pow(sStar / gap, 2);
  }

  private emit(v: Vehicle, dist: number, dt: number) {
    const base = CLASS[v.vClass].co2PerM;
    const vKmh = v.v * 3.6;
    // congestion penalty: crawling burns far more per metre; idling still emits
    const congestion = 1 + Math.max(0, (30 - vKmh) / 30) * 1.2;
    const moving = base * dist * congestion;
    const idle = v.v < 0.5 ? CLASS[v.vClass].co2PerM * 6 * dt : 0; // g while stopped
    const g = moving + idle;
    v.co2 += g;
    this.co2Window.push({ t: this.time, g });
  }

  // Nearest impassable point ahead of `fromX` in a lane: the rear of a stalled
  // incident, or a closed lane's taper. Infinity if the lane is clear ahead.
  private blockPointAhead(lane: number, fromX: number): number {
    let wall = Infinity;
    for (const inc of this.interventions.incidents) {
      if (inc.lane !== lane) continue;
      const rear = inc.x - INCIDENT_LENGTH;
      if (rear >= fromX && rear < wall) wall = rear;
    }
    if (this.interventions.closedLanes[lane]) {
      const cp = this.interventions.closurePoint;
      // Only a wall to traffic that still has to get past the works.
      if (fromX < this.interventions.closureEnd && cp >= fromX && cp < wall) wall = cp;
    }
    return wall;
  }

  // Place a stalled-vehicle incident. Any car sitting on that spot is absorbed
  // into the accident (removed) so nothing appears to drive out of it.
  addIncident(lane: number, x: number) {
    const front = x + 1;
    const rear = x - INCIDENT_LENGTH - 1;
    this.vehicles = this.vehicles.filter(
      (v) => v.lane !== lane || v.x - v.length >= front || v.x <= rear
    );
    this.interventions.incidents.push({ lane, x });
  }

  step(dt: number) {
    this.time += dt;
    // Every lookup below reads this; it must reflect the positions the
    // decisions are made against, so it is built before any of them.
    this.rebuildLaneIndex();

    // Inflow across ALL lanes — a lane closure is a downstream work zone, so
    // vehicles still enter the closing lane and must merge out at the taper.
    // That zipper merge is what makes congestion emerge on a closure.
    this.spawnAccumulator += (this.cfg.inflowVehPerHour / 3600) * dt;
    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;
      const lane = Math.floor(this.rng() * this.cfg.laneCount);
      this.spawn(lane);
    }

    // Lane-change decisions (before motion, using current state).
    for (const v of this.vehicles) {
      v.laneCooldown = Math.max(0, v.laneCooldown - dt);
      this.considerLaneChange(v);
    }

    // Longitudinal update (ballistic integration, clamped to >= 0).
    for (const v of this.vehicles) {
      const oldX = v.x;
      const a = Math.max(-8, Math.min(A_MAX, this.idmAccel(v, v.lane)));
      const vNew = Math.max(0, v.v + a * dt);
      v.x += Math.max(0, (v.v + vNew) / 2 * dt);
      v.v = vNew;
      // Safety net: a discrete step can carry a fast car *past* a stalled
      // obstacle the IDM couldn't brake for in time. Never let a car drive
      // out the far side of an accident (or closed-lane taper) — it stops
      // against it instead.
      const wall = this.blockPointAhead(v.lane, oldX);
      if (v.x > wall) {
        v.x = wall;
        v.v = 0;
      }
      this.emit(v, Math.max(0, v.x - oldX), dt);
    }

    // Retire vehicles that cleared the segment; record travel time.
    const remaining: Vehicle[] = [];
    for (const v of this.vehicles) {
      if (v.x >= this.cfg.length) {
        this.completedTimes.push(this.time - v.spawnTime);
        this.completedInWindow.push(this.time);
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

    const windowSpanMin = Math.min(60, Math.max(1, this.time)) / 60;
    const throughput = this.completedInWindow.length / windowSpanMin;
    const co2g = this.co2Window.reduce((s, e) => s + e.g, 0);
    const co2Span = Math.min(5, Math.max(0.5, this.time));
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
    };
  }
}

export const CLASS_META = CLASS;
