/* The facility plan on REAL plaza flows, and what each laid-out plaza does
 * when simulated at its busiest hour.
 *
 *   ./node_modules/.bin/tsx ../smartflow_scripts/4_studies_audits/sandbox_validation/diagnostics/facilityplan.ts <pf_NB.json> <pf_SB.json>
 *
 * The two files are saved responses of GET /api/ai-sandbox/plaza-flows?direction=NB|SB.
 */
import * as fs from "fs";
import { TrafficSim, visualLane } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/simulation";
import { planFacilities, frameFor, corridorPlaces, movementKm } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/facilityLayout";
import { FALLBACK_EXITS } from "../../../../Front-End-Dashboard/lib/nlex-exits";
import { placeFuelStations } from "../../../../Front-End-Dashboard/lib/nlex-fuel-stations";

const DT = 0.05;
const [nbFile, sbFile] = process.argv.slice(2);
type PF = { exit: string; entriesByHour: number[]; exitsByHour: number[]; entriesSource?: "paid" | "ticket" | "none"; exitsSource?: "paid" | "estimated" | "none" };
const flows: Record<"NB" | "SB", PF[]> = {
  NB: JSON.parse(fs.readFileSync(nbFile, "utf8")).data.plazas,
  SB: JSON.parse(fs.readFileSync(sbFile, "utf8")).data.plazas,
};
const stations = placeFuelStations(FALLBACK_EXITS);

function find(dir: "NB" | "SB", name: string) {
  const key = name.toLowerCase().trim();
  return flows[dir].find((x) => x.exit.toLowerCase().trim() === key) ??
    flows[dir].find((x) => { const k = x.exit.toLowerCase().trim(); return k.includes(key) || key.includes(k); }) ?? null;
}
function mainlineAt(dir: "NB" | "SB", km: number, h: number) {
  let flow = 0, any = false;
  const upstream = (at: number) => (dir === "NB" ? at <= km + 1e-6 : at >= km - 1e-6);
  for (const e of FALLBACK_EXITS) {
    const entersUp = upstream(movementKm(e.exit_name, "entry", dir, e.km));
    const leavesUp = upstream(movementKm(e.exit_name, "exit", dir, e.km));
    if (!entersUp && !leavesUp) continue;
    const f = find(dir, e.exit_name);
    if (!f) continue;
    any = true;
    // Paid transactions only, as the sandbox's own estimate (useDirectionSim.mainlineAtKm).
    if (entersUp && f.entriesSource !== "ticket") flow += f.entriesByHour[h] ?? 0;
    if (leavesUp && f.exitsSource !== "estimated") flow -= f.exitsByHour[h] ?? 0;
  }
  return any ? Math.max(0, Math.round(flow)) : null;
}

function run(label: string, dir: "NB" | "SB", fromKm: number, toKm: number, hour: number, inflow: number) {
  const L = Math.round((toKm - fromKm) * 1000);
  const plan = planFacilities({
    direction: dir, fromKm, toKm, segLengthM: L, laneCount: 4, exits: FALLBACK_EXITS, stations,
    flowAt: (n, h) => { const f = find(dir, n); return f ? { entries: f.entriesByHour[h] ?? 0, exits: f.exitsByHour[h] ?? 0, entriesSource: f.entriesSource, exitsSource: f.exitsSource } : null; },
    peakAt: (n) => { const f = find(dir, n); return f ? { entries: Math.max(...f.entriesByHour), exits: Math.max(...f.exitsByHour), entriesSource: f.entriesSource, exitsSource: f.exitsSource } : null; },
    mainlineAt: (km, h) => mainlineAt(dir, km, h),
    fallbackHourly: () => null, hour, inflow,
  });
  console.log(`\n${label}  ${dir} Km ${fromKm}-${toKm} (${L} m), hour ${hour}, inflow ${inflow}`);
  for (const f of plan.facilities) console.log(`   ${f.kind.padEnd(12)} ${f.name.padEnd(38)} x=${f.x.toFixed(0).padStart(5)} booths=${f.booths} km ${f.km?.toFixed(2)} ${f.arrivalsVehPerHour != null ? `arrive ${f.arrivalsVehPerHour}/h` : f.turnFraction != null ? `turn ${(f.turnFraction * 100).toFixed(1)}%` : ""}
      ${f.basis}`);
  if (plan.ramps.length) console.log(`   point ramps kept: ${plan.ramps.map((r) => `${r.name} @${r.x.toFixed(0)} (${r.onVehPerHour ? `+${r.onVehPerHour}/h` : `-${(r.offFraction * 100).toFixed(1)}%`})`).join(", ")}`);
  const sim: any = new TrafficSim(
    { length: L, laneCount: 4, inflowVehPerHour: inflow, seed: 5, warmupS: 60, facilities: plan.facilities, ramps: plan.ramps, secondaryIncidents: false },
    { closedLanes: [false, false, false, false], closurePoint: L, closureEnd: L, incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any,
  );
  let overlapTicks = 0, ticks = 0;
  for (let i = 0; i < 900 / DT; i++) {
    sim.step(DT);
    if (i % 10 !== 0) continue;
    ticks++;
    // mainline overlaps, as drawn
    const vs = sim.vehicles;
    let hit = false;
    for (let a = 0; a < vs.length && !hit; a++) for (let b = a + 1; b < vs.length; b++) {
      if (Math.abs(visualLane(vs[a]) - visualLane(vs[b])) >= 0.75) continue;
      if (Math.min(vs[a].x, vs[b].x) - Math.max(vs[a].x - vs[a].length, vs[b].x - vs[b].length) > 0.05) { hit = true; break; }
    }
    if (hit) overlapTicks++;
  }
  const m = sim.metrics();
  console.log(`   after 15 min: mainline ${m.avgSpeedKmh.toFixed(0)} km/h, ${m.activeAgents} on the road, mainline overlap ticks ${((100 * overlapTicks) / ticks).toFixed(2)}%`);
  for (const st of sim.facilityStats()) console.log(`   ${st.name.padEnd(38)} inside ${String(st.inside).padStart(3)}  queued ${String(st.queued).padStart(3)}  served ${st.servedPerHour.toFixed(0).padStart(5)}/h  wait ${st.meanWaitS.toFixed(0).padStart(3)} s  waiting off-road ${st.pending}`);
}

const peakOf = (dir: "NB" | "SB") => (n: string) => {
  const f = find(dir, n);
  return f ? { entries: Math.max(...f.entriesByHour), exits: Math.max(...f.exitsByHour), entriesSource: f.entriesSource, exitsSource: f.exitsSource } : null;
};

// The jump list, as the app shows it.
const places = {
  NB: corridorPlaces("NB", FALLBACK_EXITS, stations, peakOf("NB"), 4),
  SB: corridorPlaces("SB", FALLBACK_EXITS, stations, peakOf("SB"), 4),
};
for (const dir of ["NB", "SB"] as const) {
  console.log(`\n${dir} jump list: ${places[dir].length} places`);
  for (const p of places[dir]) console.log(`   ${p.kind.padEnd(12)} ${p.name.padEnd(42)} km ${p.km.toFixed(2)}  booths ${String(p.booths).padStart(2)}  frame ${p.frame.fromKm.toFixed(2)}-${p.frame.toKm.toFixed(2)}`);
}

// Each place framed as the app frames it, simulated at a busy hour.
const framed = (dir: "NB" | "SB", id: string) => {
  const p = places[dir].find((q) => q.id === id);
  if (!p) throw new Error(`no place ${id} on ${dir}`);
  return p.frame;
};
const runs: [string, "NB" | "SB", { fromKm: number; toKm: number }, number][] = [
  ["Bocaue barrier, 24 booths mapped", "SB", framed("SB", "barrier:7:SB"), 7],
  ["Bocaue barrier's own entry, 4 lanes", "SB", framed("SB", "entry:7:SB"), 7],
  ["Bocaue, northbound (no barrier mapped)", "NB", frameFor(27.2, "barrier", 12, "NB"), 18],
  ["San Fernando exit plaza, 7 lanes", "NB", framed("NB", "exit:15:NB"), 18],
  ["Balagtas exit plaza, 6 lanes", "NB", framed("NB", "exit:11:NB"), 18],
  ["Angeles exit plaza, shared, 6 lanes", "SB", framed("SB", "exit:17:SB"), 18],
  ["Meycauayan entry plaza, 5 lanes", "SB", framed("SB", "entry:4:SB"), 17],
  ["Meycauayan, northbound (entry 3 + free exit)", "NB", framed("NB", "entry:4:NB"), 18],
  ["Meycauayan, the operator's own 0.6 km view", "NB", { fromKm: 19.91, toKm: 20.51 }, 7],
  ["Meycauayan, the operator's own 0.6 km view", "SB", { fromKm: 19.91, toKm: 20.51 }, 7],
  ["Tambubong entry, closed system (ticket)", "NB", framed("NB", "entry:9:NB"), 18],
  ["San Fernando, southbound (entry 5 + exit 3)", "SB", framed("SB", "exit:15:SB"), 17],
  ["Harbor Link junction (plaza up the link)", "NB", frameFor(13.63, "entry_ramp", 0, "NB"), 18],
  ["Petron Marilao service area", "NB", frameFor(22.46, "service_area", 4, "NB"), 18],
];
for (const [label, dir, w, hour] of runs) {
  const inflow = mainlineAt(dir, dir === "NB" ? w.fromKm : w.toKm, hour) || 3500;
  run(label, dir, w.fromKm, w.toKm, hour, Math.min(4 * 2200, Math.max(600, inflow)));
}
