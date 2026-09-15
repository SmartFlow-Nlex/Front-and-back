const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);

// From the CSV (awk, one pass over nlex_traffic_hourly_2022.csv)
const csv = {
  "2022-01-01": 155195, "2022-01-02": 185758, "2022-01-03": 230925,
  "2022-01-04": 246336, "2022-01-05": 217576,
};
const CSV_YEAR_TOTAL = 106861396;

(async () => {
  const r = await p.query(
    "SELECT date::text d, total_volume::bigint v FROM gold.daily_traffic_volume_corrected WHERE date BETWEEN '2022-01-01' AND '2022-01-05' ORDER BY date"
  );
  console.log("DAILY COMPARISON  (existing gold vs new CSV)");
  console.log("  date          gold        csv         diff      csv/gold");
  for (const row of r.rows) {
    const g = Number(row.v), c = csv[row.d];
    console.log(
      `  ${row.d}  ${String(g).padStart(9)}  ${String(c).padStart(9)}  ${String(c - g).padStart(9)}   ${(c / g).toFixed(3)}`
    );
  }

  const y = await p.query(
    "SELECT SUM(total_volume)::bigint tot, ROUND(AVG(total_volume))::bigint avg, COUNT(*)::int d FROM gold.daily_traffic_volume_corrected WHERE EXTRACT(YEAR FROM date)=2022"
  );
  const gTot = Number(y.rows[0].tot);
  console.log("\nYEAR 2022");
  console.log(`  gold: total ${gTot.toLocaleString()}  avg/day ${Number(y.rows[0].avg).toLocaleString()}  days ${y.rows[0].d}`);
  console.log(`  csv : total ${CSV_YEAR_TOTAL.toLocaleString()}  avg/day ${Math.round(CSV_YEAR_TOTAL / 365).toLocaleString()}  days 365`);
  console.log(`  ratio csv/gold: ${(CSV_YEAR_TOTAL / gTot).toFixed(4)}`);

  await p.end();
})();
