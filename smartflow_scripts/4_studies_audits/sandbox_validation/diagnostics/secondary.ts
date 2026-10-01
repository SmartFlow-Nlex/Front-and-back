/* Does the secondary-incident hazard reproduce the rate it is calibrated to?
 *
 * gold.ml_incident_severity_metadata: base_rate 0.11511 over n = 4,361 — 11.5%
 * of NLEX incidents are followed by another within 2 km. The engine uses a
 * constant hazard of 0.00536 per incident-minute, which over the corridor's
 * 22.8-minute mean clearance (silver.nlex_accident_events_clean) should give
 * back that 11.5%.
 *
 * There is a second thing to check, and it is the one likelier to be wrong.
 * The draw fires per tick, but a secondary is only PLACED if there is a queued
 * vehicle to put it behind. On a quiet road the hazard fires and nothing
 * happens, so the realised rate sits below the calibrated one. That is the
 * right behaviour — a shunt needs traffic to shunt into — but it means the
 * target is only met when the road is actually busy, and that needs showing
 * rather than assuming.
 *
 * Kept deliberately small (400 m, 2 lanes) so a run finishes: the statistic
 * is about the hazard, not the geometry.
 */
import { TrafficSim } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/simulation";

const DT = 0.05;
const TARGET = 0.11511; // gold.ml_incident_severity_metadata
const MEAN_CLEARANCE_MIN = 22.8; // silver.nlex_accident_events_clean
const HAZARD_PER_MIN = 0.00536;
const TRIALS = 200;

function trial(seed: number, minutes: number, inflow: number): boolean {
  const sim: any = new TrafficSim(
    { length: 400, laneCount: 2, inflowVehPerHour: inflow, seed, secondaryIncidents: true, warmupS: 0 },
    {
      closedLanes: [false, false],
      closurePoint: 300, closureEnd: 380,
      incidents: [], speedLimitKmh: null, speedZone: [0, 0],
    } as any,
  );
  for (let i = 0; i < 40 / DT; i++) sim.step(DT); // let a queue form
  sim.addIncident(1, 300);
  const steps = (minutes * 60) / DT;
  for (let i = 0; i < steps; i++) sim.step(DT);
  return sim.interventions.incidents.some((x: any) => x.secondary);
}

function arm(label: string, minutes: number, inflow: number) {
  let hit = 0;
  for (let t = 0; t < TRIALS; t++) if (trial(4000 + t * 13, minutes, inflow)) hit++;
  const share = hit / TRIALS;
  const expected = 1 - Math.exp(-HAZARD_PER_MIN * minutes);
  const se = Math.sqrt((expected * (1 - expected)) / TRIALS);
  const z = (share - expected) / Math.max(1e-9, se);
  console.log(
    `${label.padEnd(30)} simulated ${(share * 100).toFixed(2).padStart(5)}%` +
      `   hazard predicts ${(expected * 100).toFixed(2).padStart(5)}%` +
      `   z = ${z.toFixed(2).padStart(6)}${Math.abs(z) < 2.5 ? "" : "   <-- OFF"}`,
  );
}

console.log(`calibration target: ${(TARGET * 100).toFixed(2)}% over ${MEAN_CLEARANCE_MIN} min, ${TRIALS} trials each\n`);
arm("congested, 22.8 min", MEAN_CLEARANCE_MIN, 3200);
arm("congested, 60 min", 60, 3200);
arm("light traffic, 22.8 min", MEAN_CLEARANCE_MIN, 700);
console.log(
  "\nThe light-traffic arm is EXPECTED to fall short: the hazard fires but there\n" +
    "is no queue to place a secondary behind. A shunt needs traffic to shunt into.",
);
