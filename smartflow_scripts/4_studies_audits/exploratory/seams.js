const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);
const f = (v, d = 0) => Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

(async () => {
  const q = async (lo, hi) => (await p.query(
    `SELECT AVG(total_volume)::float a, STDDEV(total_volume)::float s, COUNT(*)::int n
     FROM gold.daily_traffic_volume_corrected WHERE date BETWEEN $1 AND $2`, [lo, hi])).rows[0];

  console.log("WHAT THE MODELS ACTUALLY TRAINED ON (gold.daily_traffic_volume_corrected)\n");
  const yr = await p.query(
    `SELECT EXTRACT(YEAR FROM date)::int y, COUNT(*)::int d, ROUND(AVG(total_volume))::bigint a,
            ROUND(STDDEV(total_volume))::bigint s
     FROM gold.daily_traffic_volume_corrected GROUP BY 1 ORDER BY 1`);
  console.log("  year   days   avg/day     std dev    source");
  for (const r of yr.rows) {
    const src = (r.y >= 2022 && r.y <= 2025) ? "NEW csv" : "OLD retained";
    console.log(`  ${r.y}   ${String(r.d).padStart(4)}  ${f(r.a).padStart(9)}  ${f(r.s).padStart(9)}    ${src}`);
  }
  const tot = await p.query("SELECT COUNT(*)::int n FROM gold.daily_traffic_volume_corrected");
  console.log(`  total: ${tot.rows[0].n} days — one continuous series, all of it fed to the retrain\n`);

  console.log("SEAM 1 — 2021-12 (old) -> 2022-01 (new)");
  const a1 = await q("2021-12-01", "2021-12-31"), b1 = await q("2022-01-01", "2022-01-31");
  console.log(`  Dec 2021  avg ${f(a1.a).padStart(9)}   sd ${f(a1.s).padStart(8)}   [OLD]`);
  console.log(`  Jan 2022  avg ${f(b1.a).padStart(9)}   sd ${f(b1.s).padStart(8)}   [NEW]`);
  console.log(`  step change: ${f(b1.a - a1.a)} veh  (${((b1.a / a1.a - 1) * 100).toFixed(1)}%)   sd ratio ${(b1.s / a1.s).toFixed(2)}\n`);

  console.log("SEAM 2 — 2025-12 (new) -> 2026-01 (old)");
  const a2 = await q("2025-12-01", "2025-12-31"), b2 = await q("2026-01-01", "2026-01-31");
  console.log(`  Dec 2025  avg ${f(a2.a).padStart(9)}   sd ${f(a2.s).padStart(8)}   [NEW]`);
  console.log(`  Jan 2026  avg ${f(b2.a).padStart(9)}   sd ${f(b2.s).padStart(8)}   [OLD]`);
  console.log(`  step change: ${f(b2.a - a2.a)} veh  (${((b2.a / a2.a - 1) * 100).toFixed(1)}%)   sd ratio ${(b2.s / a2.s).toFixed(2)}\n`);

  // Which side of the seam does the evaluation window sit on?
  console.log("WHERE THE SPLIT FALLS RELATIVE TO THE SEAMS");
  console.log("  train   2020-01-01 .. 2025-04-05   -> OLD (2020-21) + NEW (2022-Apr2025)");
  console.log("  scored  2025-04-06 .. 2026-07-25   -> NEW (to Dec 2025) + OLD (2026)");
  const sc = await p.query(`
    SELECT
      ROUND(AVG(total_volume) FILTER (WHERE date <= '2025-12-31'))::bigint newpart,
      COUNT(*) FILTER (WHERE date <= '2025-12-31')::int newdays,
      ROUND(AVG(total_volume) FILTER (WHERE date >= '2026-01-01'))::bigint oldpart,
      COUNT(*) FILTER (WHERE date >= '2026-01-01')::int olddays
    FROM gold.daily_traffic_volume_corrected
    WHERE date BETWEEN '2025-04-06' AND '2026-07-25'`);
  const s = sc.rows[0];
  console.log(`\n  The 476-day SCORED window is itself split:`);
  console.log(`    ${s.newdays} days from NEW data  avg ${f(s.newpart)}`);
  console.log(`    ${s.olddays} days from OLD data  avg ${f(s.oldpart)}`);
  console.log(`    gap between the two halves: ${f(Number(s.oldpart) - Number(s.newpart))} veh`);

  await p.end();
})();
