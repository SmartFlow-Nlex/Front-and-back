/**
 * Can the missing segment distances be derived from km-posts?
 *
 * bronze.nlex_theoretical_emissions carries segment_distance_km for 10 exits
 * only. Rather than assume a rule, this tests candidate rules against those 10
 * knowns and reports the fit before anything is used for the other 10.
 */
const { Pool } = require("pg");
const p = new Pool(require("../config/db.cjs").poolConfig);

(async () => {
  const km = await p.query(
    "SELECT exit_name, km_post::float km, estimated FROM gold.exit_km_post ORDER BY km_post");
  const known = await p.query(`
    SELECT e.exit_name, MIN(t.segment_distance_km)::float d
    FROM bronze.nlex_theoretical_emissions t
    JOIN bronze.nlex_exits e ON e.id = t.exit_id
    GROUP BY 1`);
  const K = new Map(known.rows.map((r) => [r.exit_name, r.d]));
  const rows = km.rows;

  // Candidate rules for the segment "owned" by an exit.
  const gapNext = (i) => (i + 1 < rows.length ? rows[i + 1].km - rows[i].km : null);
  const gapPrev = (i) => (i > 0 ? rows[i].km - rows[i - 1].km : null);
  const midspan = (i) => {
    const a = gapPrev(i), b = gapNext(i);
    if (a == null) return b;
    if (b == null) return a;
    return (a + b) / 2;                    // half each side = Thiessen-style
  };

  const rules = { "gap to NEXT": gapNext, "gap to PREV": gapPrev, "half each side": midspan };
  console.log("Testing rules against the 10 exits that HAVE a stored distance\n");
  console.log("  exit                        stored   " + Object.keys(rules).map((r) => r.padStart(14)).join(""));

  const errs = Object.fromEntries(Object.keys(rules).map((k) => [k, []]));
  rows.forEach((r, i) => {
    if (!K.has(r.exit_name)) return;
    const stored = K.get(r.exit_name);
    const vals = Object.entries(rules).map(([k, fn]) => {
      const v = fn(i);
      if (v != null) errs[k].push(Math.abs(v - stored));
      return v == null ? "  —" : v.toFixed(2);
    });
    console.log(`  ${r.exit_name.padEnd(26)} ${stored.toFixed(2).padStart(6)}   ` +
      vals.map((v) => String(v).padStart(14)).join(""));
  });

  console.log("\n  mean absolute error vs stored:");
  for (const [k, e] of Object.entries(errs)) {
    const mae = e.reduce((a, b) => a + b, 0) / e.length;
    console.log(`    ${k.padEnd(16)} MAE ${mae.toFixed(2)} km  (n=${e.length})`);
  }

  console.log("\n  stored distances summary:");
  const ds = [...K.values()].sort((a, b) => a - b);
  console.log(`    min ${ds[0]}  max ${ds[ds.length - 1]}  mean ${(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(2)} km`);
  console.log(`    total corridor if summed over 20 exits at that mean: ${(ds.reduce((a, b) => a + b, 0) / ds.length * 20).toFixed(0)} km  (corridor is ~84 km)`);

  await p.end();
})();
