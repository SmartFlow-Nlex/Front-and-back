// PRESCRIBE edge cases against the running backend.
//
//   node smartflow_scripts/4_studies_audits/prescribe_edge_cases.mjs [backend]
//
// Every prescriptive output, under the conditions it has to survive: no data
// (a window outside the record), extreme demand (booths that clear almost
// nothing, a corridor with no booth-hours to give), and the policy bounds.
// It checks the answer is an answer: a success flag or an explained refusal,
// and no NaN, Infinity or negative quantity anywhere in it.
const BACKEND = process.argv[2] ?? "http://localhost:4000";

const cases = [
  ["emissions, 12 months", "/api/emissions/prescriptive?months=12"],
  ["emissions, a window with no data", "/api/emissions/prescriptive?from=2030-01-01&to=2030-03-31"],
  ["emissions, a window before the record", "/api/emissions/prescriptive?from=2019-01-01&to=2019-06-30"],
  ["emissions, the last two months on record", "/api/emissions/prescriptive?from=2026-05-01&to=2026-06-30"],
  ["emissions, heavy-shift target at its cap", "/api/emissions/prescriptive?months=12&heavyShiftPp=4.2"],
  ["emissions, heavy-shift target zero", "/api/emissions/prescriptive?months=12&heavyShiftPp=0"],
  ["traffic, defaults", "/api/traffic/prescriptive"],
  ["traffic, booths that clear 50 veh/h (extreme demand)", "/api/traffic/prescriptive?throughput=50"],
  ["traffic, the slider's slowest booth, 150 veh/h", "/api/traffic/prescriptive?throughput=150"],
  ["traffic, no booth-hours at all", "/api/traffic/prescriptive?pool=0"],
  ["traffic, one booth-hour for the corridor", "/api/traffic/prescriptive?pool=1"],
  ["traffic, booths that clear 5,000 veh/h", "/api/traffic/prescriptive?throughput=5000"],
];

function badNumbers(x, path = "") {
  const out = [];
  if (typeof x === "number") {
    if (!Number.isFinite(x)) out.push(`${path} = ${x}`);
    else if (x < 0 && /booth|staff|need|unmet|demand|tonnes|volume|count|rows|pool/i.test(path)) out.push(`${path} = ${x} (negative)`);
  } else if (Array.isArray(x)) x.forEach((v, i) => out.push(...badNumbers(v, `${path}[${i}]`)));
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) out.push(...badNumbers(v, path ? `${path}.${k}` : k));
  return out;
}

for (const [label, url] of cases) {
  const t0 = Date.now();
  let status = 0, body = null, err = null;
  try {
    const r = await fetch(BACKEND + url);
    status = r.status;
    body = await r.json();
  } catch (e) { err = e.message; }
  const ms = Date.now() - t0;
  console.log(`\n${label}  [${status}, ${ms} ms]`);
  if (err) { console.log("   FETCH FAILED:", err); continue; }
  if (!body?.success) { console.log("   refused:", body?.message ?? JSON.stringify(body).slice(0, 200)); continue; }
  const d = body.data;
  const bad = badNumbers(d);
  console.log(`   bad numbers: ${bad.length ? bad.slice(0, 8).join("; ") : "none"}`);
  if (Array.isArray(d.strategies)) {
    console.log(`   window ${d.basis?.from} to ${d.basis?.to} (record ${d.basis?.recordFrom} to ${d.basis?.recordTo}); ${d.basis?.incidentsCounted ?? 0} incidents`);
    for (const s of d.strategies) console.log(`   ${String(s.key).padEnd(11)} ${String(s.reductionPct?.toFixed?.(2) ?? s.reductionPct).padStart(7)}%  ${String(s.reductionTonnes?.toFixed?.(0) ?? s.reductionTonnes).padStart(8)} t  ${s.evidenceBounded ? "evidence-bounded" : "policy target"}  ${String(s.lever).slice(0, 60)}`);
    for (const u of d.unavailable ?? []) console.log(`   not computed: ${u.label}: ${u.reason}`);
    if (d.noData) console.log("   NO DATA:", d.noData);
  }
  if (d.shiftPlan !== undefined) {
    const plan = d.shiftPlan;
    const plazas = plan?.plazas ?? [];
    const unmet = plazas.reduce((s, p) => s + (p.hours ?? []).reduce((a, h) => a + (h.unmet ?? 0), 0), 0);
    const staffed = plazas.reduce((s, p) => s + (p.hours ?? []).reduce((a, h) => a + (h.staffed ?? h.booths ?? 0), 0), 0);
    // Booths opened must never exceed booths that exist.
    const overBooked = plazas.flatMap((p) => (p.booths == null ? [] : p.hours.filter((h) => h.staffed > p.booths).map((h) => `${p.plaza} ${h.hour}:00 ${h.staffed}>${p.booths}`)));
    console.log(`   champion ${d.champion?.model} (accepted ${d.champion?.accepted}); shift plan ${plan ? `${plan.date ?? ""} ${plazas.length} plazas, ${staffed} booth-hours staffed, ${Math.round(unmet).toLocaleString()} veh unmet` : "none"}; week ${d.week?.length ?? 0} days; congestion advice ${d.congestion?.length ?? 0} segments`);
    console.log(`   booths opened beyond those that exist: ${overBooked.length ? overBooked.slice(0, 5).join("; ") : "none"}; uncapped (no booths mapped): ${(d.basis?.plazasWithoutBooths ?? []).join(", ") || "none"}`);
    console.log(`   over capacity this week: ${d.overCapacity?.length ?? 0}${d.overCapacity?.length ? `, worst ${JSON.stringify(d.overCapacity[0])}` : ""}`);
    console.log(`   congestion segments with no forecast: ${(d.congestionMissing ?? []).join(", ") || "none"}`);
  }
}
