import type { Metrics } from "./simulation";

/**
 * Corridor totals for Both mode, from the two directions' own readouts.
 *
 * Which metrics get a total, and how (agreed in the Phase D1 design):
 *
 *   sum        activeAgents, throughputPerMin, co2RatePerMin, stoppedCount, unmetVehPerHour
 *              — counts and rates of physically separate traffic add up.
 *   max        longestQueueM — a corridor is only as good as its worst queue; two 80 m queues
 *              are not one 160 m queue.
 *   weighted   avgSpeedKmh — FLOW-weighted by throughputPerMin, never a plain mean. A direction
 *              moving 40 vehicles a minute says more about how the corridor performs than one
 *              moving 4, and (a + b) / 2 would let a near-empty carriageway pull the headline.
 *   none       densityPerKmLane — vehicles per km per lane on two separate carriageways has no
 *              meaningful sum or mean. Shown per direction only, and the UI says so.
 *
 * Pure, so verify.ts can pin every rule (including the zero-flow case) without a browser.
 */

export type CorridorMetrics = {
  activeAgents: number;
  throughputPerMin: number;
  co2RatePerMin: number;
  longestQueueM: number;
  stoppedCount: number;
  unmetVehPerHour: number;
  /**
   * Flow-weighted mean of the two directions' average speeds, weight = throughputPerMin.
   * Null when neither direction has completed a vehicle yet: with no flow there is no weight, and
   * falling back to a plain mean would be exactly the number this field exists to avoid.
   */
  flowWeightedAvgSpeedKmh: number | null;
};

/** What a flow-weighted mean needs from one direction: its speed and the flow that weights it. */
export type SpeedAndFlow = { readonly avgSpeedKmh: number; readonly throughputPerMin: number };

/** Σ(speed × flow) / Σ(flow). Null when there is no flow to weight by. */
export function flowWeightedSpeed(a: SpeedAndFlow, b: SpeedAndFlow): number | null {
  const wa = Math.max(0, a.throughputPerMin);
  const wb = Math.max(0, b.throughputPerMin);
  const total = wa + wb;
  if (!(total > 0)) return null;
  return (a.avgSpeedKmh * wa + b.avgSpeedKmh * wb) / total;
}

export function combineMetrics(nb: Metrics, sb: Metrics): CorridorMetrics {
  return {
    activeAgents: nb.activeAgents + sb.activeAgents,
    throughputPerMin: nb.throughputPerMin + sb.throughputPerMin,
    co2RatePerMin: nb.co2RatePerMin + sb.co2RatePerMin,
    longestQueueM: Math.max(nb.longestQueueM, sb.longestQueueM),
    stoppedCount: nb.stoppedCount + sb.stoppedCount,
    unmetVehPerHour: nb.unmetVehPerHour + sb.unmetVehPerHour,
    flowWeightedAvgSpeedKmh: flowWeightedSpeed(nb, sb),
  };
}

/** The four figures a baseline snapshot keeps (see Baseline in useDirectionSim). */
export type BaselineFigures = {
  readonly avgSpeedKmh: number;
  readonly throughputPerMin: number;
  readonly longestQueueM: number;
  readonly co2RatePerMin: number;
};

export type CorridorBaseline = {
  throughputPerMin: number;
  co2RatePerMin: number;
  longestQueueM: number;
  flowWeightedAvgSpeedKmh: number | null;
};

/** The corridor "before", built by the same rules as the corridor "now" so the two are comparable. */
export function combineBaselines(nb: BaselineFigures, sb: BaselineFigures): CorridorBaseline {
  return {
    throughputPerMin: nb.throughputPerMin + sb.throughputPerMin,
    co2RatePerMin: nb.co2RatePerMin + sb.co2RatePerMin,
    longestQueueM: Math.max(nb.longestQueueM, sb.longestQueueM),
    flowWeightedAvgSpeedKmh: flowWeightedSpeed(nb, sb),
  };
}
