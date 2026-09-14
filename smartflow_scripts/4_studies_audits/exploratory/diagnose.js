const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);

// Day-of-week structure, restricted to the replaced span so old and new are
// compared over identical dates.
const q = (tbl) => `
  SELECT TO_CHAR(date,'Dy') dow, EXTRACT(DOW FROM date)::int k,
         ROUND(AVG(total_volume))::bigint avg,
         ROUND(STDDEV(total_volume))::bigint sd
  FROM ${tbl}
  WHERE date BETWEEN '2022-01-01' AND '2025-12-31'
  GROUP BY 1,2 ORDER BY 2`;

const varq = (tbl) => `
  WITH d AS (
    SELECT total_volume v, EXTRACT(DOW FROM date)::int k
    FROM ${tbl} WHERE date BETWEEN '2022-01-01' AND '2025-12-31'
  ), g AS (SELECT k, AVG(v) gm, COUNT(*) n FROM d GROUP BY k),
     o AS (SELECT AVG(v) om FROM d)
  SELECT
    ROUND((SELECT SUM(n*(gm-om)^2) FROM g, o) / (SELECT SUM((v-om)^2) FROM d, o) * 1000)/1000 AS dow_r2,
    ROUND(STDDEV(v))::bigint sd, ROUND(AVG(v))::bigint mean
  FROM d`;

(async () => {
  for (const [label, tbl] of [
    ["OLD (backup)", "gold.daily_traffic_volume_corrected_bak_20260829"],
    ["NEW (loaded)", "gold.daily_traffic_volume_corrected"],
  ]) {
    const r = await p.query(q(tbl));
    const v = await p.query(varq(tbl));
    console.log(`\n${label}  2022-01-01..2025-12-31`);
    console.log("  " + r.rows.map((x) => x.dow).join("     "));
    console.log("  " + r.rows.map((x) => Number(x.avg).toLocaleString().padStart(7)).join(" "));
    const a = r.rows.map((x) => Number(x.avg));
    console.log(`  weekday spread: ${(Math.max(...a) - Math.min(...a)).toLocaleString()} veh  (max/min ${(Math.max(...a) / Math.min(...a)).toFixed(3)})`);
    console.log(`  day-of-week R2: ${v.rows[0].dow_r2}   overall sd: ${Number(v.rows[0].sd).toLocaleString()}   mean: ${Number(v.rows[0].mean).toLocaleString()}`);
    console.log(`  coeff of variation: ${(Number(v.rows[0].sd) / Number(v.rows[0].mean)).toFixed(4)}`);
  }
  await p.end();
})();
