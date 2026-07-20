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
  closedLanes: boolean[]; // per-lane; closed from `closurePoint` to the end
  closurePoint: number; // metres
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
  private completedTimes: number[] = []; // travel times, rolling
  private completedInWindow: number[] = []; // completion timestamps, rolling
  private co2Window: { t: number; g: number }[] = [];

  constructor(cfg: SimConfig, interventions?: Partial<Interventions>) {
    this.cfg = cfg;
    this.rng = mulberry32(cfg.seed);
    this.interventions = {
      closedLanes: Array(cfg.laneCount).fill(false),
      closurePoint: cfg.length * 0.55,
      incidents: [],
      speedLimitKmh: null,
      speedZone: [cfg.length * 0.35, cfg.length * 0.75],
      ...interventions,
    };
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
    let bestX = Infinity;
    let leadV = 0;
    // real vehicles
    for (const o of this.vehicles) {
      if (o === v || o.lane !== lane) continue;
      if (o.x > v.x && o.x < bestX) {
        bestX = o.x;
        leadV = o.v;
      }
    }
    // incidents (stopped obstacles) in this lane
    for (const inc of this.interventions.incidents) {
      if (inc.lane === lane && inc.x > v.x && inc.x < bestX) {
        bestX = inc.x;
        leadV = 0;
      }
    }
    // lane closure acts as a stopped obstacle at the taper point
    if (this.interventions.closedLanes[lane] && this.interventions.closurePoint > v.x && this.interventions.closurePoint < bestX) {
      bestX = this.interventions.closurePoint;
      leadV = 0;
    }
    if (!isFinite(bestX)) return null;
    const leadLen = leadV > 0 ? 0 : 0; // obstacles are points; vehicle length handled below
    const gap = bestX - v.x - v.length - leadLen;
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

  // MOBIL-ish lane change: pick the neighbouring lane that is safe and offers a
  // meaningfully better acceleration, with a strong pull out of a blocked lane.
  private considerLaneChange(v: Vehicle) {
    if (v.laneCooldown > 0) return;
    const here = this.idmAccel(v, v.lane);
    const mustEscape = this.interventions.closedLanes[v.lane] && v.x < this.interventions.closurePoint;
    const candidates = [v.lane - 1, v.lane + 1].filter((l) => l >= 0 && l < this.cfg.laneCount && !this.interventions.closedLanes[l]);
    let best: { lane: number; gain: number } | null = null;
    for (const lane of candidates) {
      // safety: would the new follower have to brake harder than B_SAFE?
      let follower: Vehicle | null = null;
      let fx = -Infinity;
      for (const o of this.vehicles) {
        if (o.lane === lane && o.x < v.x && o.x > fx) {
          fx = o.x;
          follower = o;
        }
      }
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
    const gap = Math.max(0.1, leadX - f.x - f.length - leadLen);
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

  step(dt: number) {
    this.time += dt;

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
      const a = Math.max(-8, Math.min(A_MAX, this.idmAccel(v, v.lane)));
      const vNew = Math.max(0, v.v + a * dt);
      const dist = Math.max(0, (v.v + vNew) / 2 * dt);
      v.x += dist;
      v.v = vNew;
      this.emit(v, dist, dt);
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
