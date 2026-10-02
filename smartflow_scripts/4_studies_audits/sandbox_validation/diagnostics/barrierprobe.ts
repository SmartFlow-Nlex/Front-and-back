/* A wide barrier (Bocaue's 24 booths) at its recorded peak: stop at the first
 * time two vehicles in it are drawn into each other, and print what both were
 * doing for the seconds before — which lane, where, how fast, how hard braking.
 *
 *   ./node_modules/.bin/tsx ../smartflow_scripts/4_studies_audits/sandbox_validation/diagnostics/barrierprobe.ts [inflow] [booths] [seed]
 */
import { TrafficSim } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/simulation";
import { boothDwellFor, DRAW_W_FRAC, type FacilitySpec } from "../../../../Front-End-Dashboard/app/dashboard/scenario-sandbox/facilities";

const DT = 0.05;
const inflow = Number(process.argv[2] ?? 3872);
const booths = Number(process.argv[3] ?? 24);
const seed = Number(process.argv[4] ?? 21);
const L = 1400;
const spec: FacilitySpec = { id: "bar", kind: "barrier", name: "bar", x: 400, booths, serviceSec: boothDwellFor(350), tollMode: "pay" };
const s: any = new TrafficSim({ length: L, laneCount: 4, inflowVehPerHour: inflow, seed, warmupS: 0, facilities: [spec] },
  { closedLanes: [false, false, false, false], closurePoint: L, closureEnd: L, incidents: [], speedLimitKmh: null, speedZone: [0, 0] } as any);
const f = s.fac.list[0];
const clear = DRAW_W_FRAC * f.pitch;

// The facility diagnostic's own measure of "drawn into each other".
function bodyOverlap(A: any, B: any): number {
  const inside = (P: any, Q: any) => {
    let n = 0;
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const u = P.tu + (P.u - P.tu) * t;
      const w = P.tw + (P.w - P.tw) * t;
      const lo = Math.min(Q.tu, Q.u), hi = Math.max(Q.tu, Q.u);
      if (u < lo || u > hi || hi - lo < 1e-6) continue;
      const qw = Q.tw + (Q.w - Q.tw) * ((u - Q.tu) / (Q.u - Q.tu));
      if (Math.abs(w - qw) < clear) n++;
    }
    return (n / 9) * Math.abs(P.u - P.tu);
  };
  return Math.max(inside(A, B), inside(B, A));
}

const served = () => f.stations.reduce((n: number, st: any) => n + st.served, 0);
let served0 = 0;
type Row = { t: number; path: number; role: string; s: number; u: number; w: number; tu: number; tw: number; v: number; acc: number; len: number; served: boolean };
const hist = new Map<number, Row[]>();
let t = 0;
for (let i = 0; i < 1500 / DT; i++) {
  s.step(DT);
  t += DT;
  if (i === Math.round(300 / DT)) served0 = served();
  for (const a of f.agents) {
    const fa = a.fac;
    const h = hist.get(a.id) ?? [];
    h.push({ t, path: fa.path, role: f.paths[fa.path].role, s: fa.s, u: fa.u, w: fa.w, tu: fa.tu, tw: fa.tw, v: a.v, acc: a.accel, len: a.length, served: fa.served });
    if (h.length > 80) h.shift();
    hist.set(a.id, h);
  }
  if (i % 4 !== 0) continue;
  const ag = f.agents;
  for (let x = 0; x < ag.length; x++) for (let y = x + 1; y < ag.length; y++) {
    const A = ag[x], B = ag[y];
    if (A.fac.path === B.fac.path) continue;
    const ov = bodyOverlap(A.fac, B.fac);
    if (ov <= 1) continue;
    console.log(`t=${t.toFixed(2)} s: ${ov.toFixed(2)} m drawn overlap between #${A.id} and #${B.id} (clear ${clear.toFixed(3)} lane units, pitch ${f.pitch.toFixed(3)})`);
    for (const V of [A, B]) {
      console.log(`  #${V.id} length ${V.length.toFixed(1)} m`);
      for (const r of (hist.get(V.id) ?? []).filter((_, k, all) => k % 4 === 0 || k === all.length - 1)) {
        console.log(`    t ${r.t.toFixed(2)}  ${r.role.padEnd(10)}#${String(r.path).padStart(3)} s ${r.s.toFixed(1).padStart(6)}  u ${r.u.toFixed(1).padStart(7)} w ${r.w.toFixed(3).padStart(7)}  tail u ${r.tu.toFixed(1).padStart(7)} w ${r.tw.toFixed(3).padStart(7)}  v ${r.v.toFixed(2).padStart(5)} acc ${r.acc.toFixed(2).padStart(6)}`);
      }
    }
    process.exit(0);
  }
}
console.log(`no drawn overlap over 1 m in 25 minutes; served ${(((served() - served0) / 1200) * 3600).toFixed(0)}/h of ${inflow}/h asked, ${f.agents.length} inside at the end`);
