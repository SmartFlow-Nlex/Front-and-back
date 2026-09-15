const { Pool } = require("pg");
const p = new Pool(require("../config/db.cjs").poolConfig);
const APPLY = process.argv.includes("--apply");

// Known km-posts from the NLEX reference, mapped to canonical names.
const KNOWN = {
  "Balintawak": 0, "NLEX Harbor Link": 4, "Paso de Blas Valenzuela": 8,
  "Meycauayan": 16, "Marilao": 22, "Bocaue Interchange": 26,
  "Balagtas": 30, "Tabang Guiguinto": 35, "Sta. Rita Guiguinto": 40,
  // Far-end anchor. Without it the fit is extrapolated from anchors that stop
  // at km 40 and runs ~38% long — it put Sta. Ines at 116 km on an 84 km road.
  // Source: Back-End/src/etl/cleaner.ts, NLEX_KM_MAX = 84 ("Sta. Ines/Dau ~84").
  "Sta. Ines": 84,
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
    "SELECT exit_name, latitude::float lat, longitude::float lon FROM bronze.nlex_exits WHERE latitude IS NOT NULL");
  const base = r.rows.find((x) => x.exit_name === "Balintawak");
  const rows = r.rows.map((x) => ({ name: x.exit_name, dist: hav(base.lat, base.lon, x.lat, x.lon) }));

  // Least-squares km_true = a*dist + b over the known anchors. The road curves,
  // so straight-line distance runs short by a roughly constant factor.
  const anc = rows.filter((x) => KNOWN[x.name] != null);
  const n = anc.length;
  const sx = anc.reduce((s, x) => s + x.dist, 0), sy = anc.reduce((s, x) => s + KNOWN[x.name], 0);
  const sxy = anc.reduce((s, x) => s + x.dist * KNOWN[x.name], 0);
  const sxx = anc.reduce((s, x) => s + x.dist * x.dist, 0);
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const b = (sy - a * sx) / n;
  const my = sy / n;
  const ssTot = anc.reduce((s, x) => s + (KNOWN[x.name] - my) ** 2, 0);
  const ssRes = anc.reduce((s, x) => s + (KNOWN[x.name] - (a * x.dist + b)) ** 2, 0);
  console.log(`Calibration on ${n} known anchors:  km = ${a.toFixed(4)} * dist + ${b.toFixed(3)}`);
  console.log(`  R2 = ${(1 - ssRes / ssTot).toFixed(5)}   residual RMSE ${Math.sqrt(ssRes / n).toFixed(2)} km`);
  console.log("\n  anchor check:");
  anc.sort((x, y) => KNOWN[x.name] - KNOWN[y.name])
     .forEach((x) => console.log(`    ${x.name.padEnd(26)} known ${String(KNOWN[x.name]).padStart(3)}   fitted ${(a * x.dist + b).toFixed(1).padStart(6)}`));

  // Known values are used verbatim; only the unknown 11 are estimated.
  const out = rows.map((x) => ({
    name: x.name,
    km: KNOWN[x.name] != null ? KNOWN[x.name] : Math.round((a * x.dist + b) * 10) / 10,
    est: KNOWN[x.name] == null,
  })).sort((u, v) => u.km - v.km);

  console.log("\n  final corridor order (E = estimated from coordinates):");
  out.forEach((x, i) => console.log(`    ${String(i + 1).padStart(2)}. ${x.name.padEnd(26)} km ${String(x.km).padStart(5)} ${x.est ? "E" : ""}`));

  const bad = out.filter((x, i) => i > 0 && x.km < out[i - 1].km);
  console.log(`\n  monotonic ordering: ${bad.length === 0 ? "OK" : "VIOLATIONS " + bad.map((x) => x.name).join(", ")}`);

  if (!APPLY) { console.log("\n(dry run — pass --apply)"); await p.end(); return; }

  await p.query(`
    CREATE TABLE IF NOT EXISTS gold.exit_km_post (
      exit_name text PRIMARY KEY,
      km_post   numeric(6,1) NOT NULL,
      estimated boolean NOT NULL DEFAULT false,
      note      text,
      updated_at timestamptz DEFAULT now())`);
  await p.query(`COMMENT ON TABLE gold.exit_km_post IS
    'Corridor position per canonical exit, used to order the congestion map south to north. Known values come from the NLEX reference; the rest are estimated by least-squares calibration of great-circle distance from Balintawak against those anchors (R2 reported at build time). estimated=true marks the calibrated ones.'`);
  await p.query("DELETE FROM gold.exit_km_post");
  for (const x of out) {
    await p.query(
      "INSERT INTO gold.exit_km_post (exit_name, km_post, estimated, note) VALUES ($1,$2,$3,$4)",
      [x.name, x.km, x.est, x.est ? `calibrated from coordinates (km = ${a.toFixed(3)}*d + ${b.toFixed(2)})` : "NLEX reference"]);
  }
  const c = await p.query("SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE estimated)::int e FROM gold.exit_km_post");
  console.log(`\n  gold.exit_km_post: ${c.rows[0].n} exits (${c.rows[0].e} estimated)`);
  await p.end();
})();
