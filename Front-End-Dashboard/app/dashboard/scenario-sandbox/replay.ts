import type { Interventions, Vehicle, VehicleClass } from "./simulation";

/* ══════════════════════════════════════════════════════════════════════════════
   REPLAY — scrub back over what just happened

   An incident in this sandbox is over in seconds. An operator watching the
   metrics, or reading the scenario panel, or simply looking at the other
   carriageway, misses the moment the lane blocks and has no way back to it:
   the only controls are play, pause and reset, and reset throws the run away.

   So every step is recorded and can be played back. Deliberately NOT a
   rewind of the engine — restoring a microsimulation to an earlier state
   means restoring every driver's reaction phase and the RNG cursor with it,
   and any mistake there silently changes the run the operator is judging.
   This records the PICTURE instead: enough of each frame to redraw it exactly,
   and nothing that could feed back into the physics.

   The consequence is worth stating plainly, because it shapes what the button
   can offer: you can review what happened, but you cannot resume from the
   middle of it and get a different outcome. Rewinding and letting go returns
   you to the live simulation, which has carried on the whole time.
══════════════════════════════════════════════════════════════════════════════ */

/** The fields the canvas actually reads. Verified against drawCarriageway. */
export type ReplayVehicle = {
  id: number;
  lane: number;
  laneFrom: number;
  laneShift: number;
  x: number;
  v: number;
  vClass: VehicleClass;
  length: number;
  accel: number;
  spawnTime: number;
  color: string;
};

export type ReplayFrame = {
  time: number;
  vehicles: ReplayVehicle[];
  incidents: { lane: number; x: number; secondary?: boolean }[];
  closedLanes: boolean[];
  closurePoint: number;
  closureEnd: number;
  speedLimitKmh: number | null;
  speedZone: [number, number];
};

/** What the renderer needs; a frame is dressed up as this to be drawn. */
export type SimLike = {
  time: number;
  vehicles: ReplayVehicle[];
  cfg: { laneCount: number; length: number };
  interventions: Interventions;
};

type Source = {
  time: number;
  vehicles: Vehicle[];
  interventions: Interventions;
  cfg: { laneCount: number; length: number };
};

/* 8 Hz. The engine steps at 20 Hz, but a frame every 125 ms is smooth enough
 * to review and costs two-fifths of the memory. At ~200 vehicles a frame is
 * roughly 2 KB, so the default 90-second window is a few megabytes — small
 * enough to hold for both carriageways without the tab growing without bound,
 * which a per-step buffer would do within a minute. */
const DEFAULT_HZ = 8;
const DEFAULT_WINDOW_S = 90;

export class ReplayBuffer {
  private frames: ReplayFrame[] = [];
  private lastAt = -Infinity;
  private readonly interval: number;
  private readonly capacity: number;

  constructor(windowS: number = DEFAULT_WINDOW_S, hz: number = DEFAULT_HZ) {
    this.interval = 1 / hz;
    this.capacity = Math.max(2, Math.ceil(windowS * hz));
  }

  /** Throttled; call every step and it keeps its own cadence. */
  record(sim: Source): void {
    if (sim.time - this.lastAt < this.interval) return;
    this.lastAt = sim.time;

    const iv = sim.interventions;
    this.frames.push({
      time: sim.time,
      // Copied field by field, not by reference: the engine mutates these
      // objects in place every step, so storing the vehicle itself would give
      // a buffer of N pointers to one ever-changing present.
      vehicles: sim.vehicles.map((v) => ({
        id: v.id,
        lane: v.lane,
        laneFrom: v.laneFrom,
        laneShift: v.laneShift,
        x: v.x,
        v: v.v,
        vClass: v.vClass,
        length: v.length,
        accel: v.accel,
        spawnTime: v.spawnTime,
        color: v.color,
      })),
      incidents: iv.incidents.map((i) => ({ lane: i.lane, x: i.x, secondary: i.secondary })),
      closedLanes: [...iv.closedLanes],
      closurePoint: iv.closurePoint,
      closureEnd: iv.closureEnd,
      speedLimitKmh: iv.speedLimitKmh,
      speedZone: [iv.speedZone[0], iv.speedZone[1]],
    });

    if (this.frames.length > this.capacity) this.frames.shift();
  }

  get length(): number {
    return this.frames.length;
  }

  /** Seconds of history held, 0 when there is nothing to review. */
  get spanS(): number {
    if (this.frames.length < 2) return 0;
    return this.frames[this.frames.length - 1].time - this.frames[0].time;
  }

  get firstTime(): number | null {
    return this.frames[0]?.time ?? null;
  }

  get lastTime(): number | null {
    return this.frames[this.frames.length - 1]?.time ?? null;
  }

  frame(index: number): ReplayFrame | null {
    if (index < 0 || index >= this.frames.length) return null;
    return this.frames[index];
  }

  /** The frame nearest a sim time — for jumping to a moment rather than an index. */
  indexAt(time: number): number {
    if (this.frames.length === 0) return -1;
    let lo = 0;
    let hi = this.frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.frames[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    // Pick whichever neighbour is actually closer.
    if (lo > 0 && Math.abs(this.frames[lo - 1].time - time) < Math.abs(this.frames[lo].time - time)) return lo - 1;
    return lo;
  }

  /** Dress a frame as something the renderer will accept. */
  asSimLike(index: number, cfg: { laneCount: number; length: number }): SimLike | null {
    const f = this.frame(index);
    if (!f) return null;
    return {
      time: f.time,
      vehicles: f.vehicles,
      cfg,
      interventions: {
        closedLanes: f.closedLanes,
        closurePoint: f.closurePoint,
        closureEnd: f.closureEnd,
        incidents: f.incidents,
        speedLimitKmh: f.speedLimitKmh,
        speedZone: f.speedZone,
        // Draft overlays are live-editing affordances; a recording has none.
        showClosurePreview: false,
        closureDraft: null,
      },
    };
  }

  /** The index of the last frame at which something happened worth seeing.
   *
   *  This is the button an operator actually wants: not "go back 10 seconds"
   *  but "show me the thing I missed". Returns null when the recording holds
   *  nothing of the kind, which is how the control knows to stay hidden —
   *  an empty road has nothing to replay and the button should not be there.
   *
   *  "Something" is an obstruction APPEARING: an incident added, or a lane
   *  going closed. The second matters because scheduled roadworks never touch
   *  the incident list — they close a lane — so keying only on incidents left
   *  the one scenario family that lasts longest unreplayable. */
  lastEventIndex(): number | null {
    const closedCount = (f: ReplayFrame) => f.closedLanes.reduce((n, c) => n + (c ? 1 : 0), 0);
    for (let i = this.frames.length - 1; i > 0; i--) {
      const now = this.frames[i];
      const prev = this.frames[i - 1];
      if (now.incidents.length > prev.incidents.length) return i;
      if (closedCount(now) > closedCount(prev)) return i;
    }
    return null;
  }

  clear(): void {
    this.frames = [];
    this.lastAt = -Infinity;
  }
}
