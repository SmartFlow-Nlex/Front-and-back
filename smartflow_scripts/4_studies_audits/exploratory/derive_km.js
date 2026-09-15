const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);

// The 10 values currently hardcoded in PredictiveCongestionChart.tsx, used here
// only to CHECK the derived figures — not as the source of truth.
const KNOWN = {
  Balintawak: 0, "Mindanao Ave": 2, Karuhatan: 4, Valenzuela: 8, Meycauayan: 16,
  Marilao: 22, Bocaue: 26, Balagtas: 30, Tabang: 35, "Santa Rita": 40,
};
// Those legacy labels predate canonicalisation; map them to the canonical names.
const ALIAS = {
  "Mindanao Ave": "NLEX Harbor Link", Karuhatan: "NLEX Harbor Link",
  Valenzuela: "Paso de Blas Valenzuela", Bocaue: "Bocaue Interchange",
  Tabang: "Tabang Guiguinto", "Santa Rita": "Sta. Rita Guiguinto",
};

const R = 6371;
const hav = (a, b, c, d) => {
  const t = (x) => (x * Math.PI) / 180;
  const dLat = t(c - a), dLon = t(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

(async () => {
  const r = await p.query(
    "SELECT exit_name, latitude::float lat, longitude::float lon FROM bronze.nlex_exits WHERE latitude IS NOT NULL ORDER BY exit_name");
  const base = r.rows.find((x) => x.exit_name === "Balintawak");
  if (!base) throw new Error("Balintawak (km 0) not found");

  const out = r.rows
    .map((x) => ({ name: x.exit_name, km: hav(base.lat, base.lon, x.lat, x.lon) }))
    .sort((a, b) => a.km - b.km);

  console.log("Derived corridor position (great-circle km from Balintawak)\n");
  console.log("  exit                        derived   known   delta");
  const canon2known = {};
  for (const [k, v] of Object.entries(KNOWN)) canon2known[ALIAS[k] ?? k] = v;

  let checked = 0, maxErr = 0;
  for (const x of out) {
    const k = canon2known[x.name];
    const d = k == null ? "" : (x.km - k).toFixed(1);
    if (k != null) { checked++; maxErr = Math.max(maxErr, Math.abs(x.km - k)); }
    console.log(`  ${x.name.padEnd(26)} ${x.km.toFixed(1).padStart(7)} ${(k ?? "—").toString().padStart(7)} ${d.padStart(7)}`);
  }
  console.log(`\n  checked against ${checked} known values | max deviation ${maxErr.toFixed(1)} km`);

  // Ordering is what the chart actually needs — verify it matches.
  const knownOrder = Object.entries(canon2known).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  const derivedOrder = out.filter((x) => canon2known[x.name] != null).map((x) => x.name);
  const seen = new Set();
  const knownDedup = knownOrder.filter((n) => !seen.has(n) && seen.add(n));
  console.log(`  known order  : ${knownDedup.join(" -> ")}`);
  console.log(`  derived order: ${derivedOrder.join(" -> ")}`);
  console.log(`  ORDER MATCHES: ${JSON.stringify(knownDedup) === JSON.stringify(derivedOrder)}`);

  console.log("\n  all 20, corridor order:");
  out.forEach((x, i) => console.log(`    ${String(i + 1).padStart(2)}. ${x.name.padEnd(26)} km ${x.km.toFixed(1)}`));
  await p.end();
})();
