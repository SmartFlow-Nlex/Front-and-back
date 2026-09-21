/**
 * Checks the AI Sandbox's service-area stops and toll plaza (simulation.ts).
 *
 * 1. Stops OFF changes nothing. A service area with a 0% stop share must draw
 *    no random numbers, so a seeded run is vehicle-for-vehicle identical to
 *    one with no service areas at all. (Checked against the pre-change
 *    simulation too when it was introduced: identical positions for all 264
 *    vehicles after 600 s.)
 * 2. Stops ON takes vehicles off the road and brings them back after their
 *    dwell.
 * 3. A toll barrier slows traffic to about the booth speed just before it and
 *    releases it after.
 *
 * RUN (from Front-End-Dashboard):
 *   npx tsx ../smartflow_scripts/4_studies_audits/sandbox_agents_check.mts
 */
const sim = await import(
  new URL("../../Front-End-Dashboard/app/dashboard/ai-sandbox/simulation.ts", import.meta.url).href
);

const ramps = [
  { x: 1200, onVehPerHour: 600, offFraction: 0.12, name: "A" },
  { x: 2600, onVehPerHour: 400, offFraction: 0.08, name: "B" },
];

function run(extra: Record<string, unknown>, secs = 600) {
  const s = new sim.TrafficSim({ length: 4000, laneCount: 4, inflowVehPerHour: 5200, seed: 777, ramps, warmupS: 60, ...extra });
  for (let i = 0; i < secs / 0.05; i++) s.step(0.05);
  const sig = s.vehicles.map((v: any) => `${v.id}:${v.x.toFixed(6)}:${v.lane}`).join("|");
  return { s, sig, m: s.metrics() };
}

let ok = true;
const check = (label: string, pass: boolean, detail: string) => {
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label} — ${detail}`);
};

const none = run({});
const off = run({ services: [{ x: 2000, stopFraction: 0, dwellMeanS: 1800, name: "S" }], tolls: [] });
check("stops off is RNG-neutral", none.sig === off.sig,
  `${none.s.vehicles.length} vs ${off.s.vehicles.length} vehicles, throughput ${none.m.throughputPerMin} vs ${off.m.throughputPerMin}/min`);

const on = run({ services: [{ x: 2000, stopFraction: 0.17, dwellMeanS: 60, name: "S" }] });
const back = on.s.vehicles.filter((v: any) => v.joinedFrom === "service").length;
check("stops on: vehicles park and rejoin", on.s.parked.length > 0 && back > 0,
  `${on.s.parked.length} parked now, ${back} back on the road after a stop`);

const t = run({ tolls: [{ x: 2000, boothKmh: 20, name: "T" }] }, 300);
const mean = (lo: number, hi: number) => {
  const vs = t.s.vehicles.filter((v: any) => v.x >= lo && v.x < hi).map((v: any) => v.v * 3.6);
  return vs.length ? vs.reduce((a: number, b: number) => a + b, 0) / vs.length : NaN;
};
const atBooth = mean(1900, 2000);
const after = mean(2500, 2700);
check("toll slows to booth speed", atBooth < 30 && after > 60,
  `${atBooth.toFixed(1)} km/h in the 100 m before the booth, ${after.toFixed(1)} km/h 500-700 m after`);

process.exit(ok ? 0 : 1);
