const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);
const f = (v) => Number(v ?? 0).toLocaleString("en-US");

(async () => {
  // 1. What does nlex_exit_id resolve to?
  const ids = await p.query(
    "SELECT nlex_exit_id id, COUNT(*)::int n FROM bronze.waze_hourly_jams GROUP BY 1 ORDER BY 1");
  console.log(`nlex_exit_id values in waze_hourly_jams: ${ids.rowCount}`);
  let lookup = null;
  for (const t of ["bronze.nlex_exits", "silver.nlex_exits_clean", "silver.nlex_exit_reference"]) {
    try {
      const c = await p.query(
        "SELECT column_name c FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2", t.split("."));
      const names = c.rows.map((r) => r.c);
      const idc = names.find((x) => /^(id|exit_id|nlex_exit_id)$/i.test(x));
      const nc = names.find((x) => /exit_name|name/i.test(x));
      if (idc && nc) { lookup = { t, idc, nc }; break; }
    } catch { /* skip */ }
  }
  if (lookup) {
    console.log(`  resolving via ${lookup.t} (${lookup.idc} -> ${lookup.nc})`);
    const j = await p.query(`
      SELECT w.nlex_exit_id id, e."${lookup.nc}" nm, COUNT(*)::int n
      FROM bronze.waze_hourly_jams w LEFT JOIN ${lookup.t} e ON e."${lookup.idc}" = w.nlex_exit_id
      GROUP BY 1,2 ORDER BY 1`);
    j.rows.forEach((r) => console.log(`    ${String(r.id).padStart(3)}  ${String(r.nm ?? "(unmapped)").padEnd(26)} ${f(r.n)}`));
  } else {
    console.log("  no id->name lookup table found");
    ids.rows.forEach((r) => console.log(`    ${String(r.id).padStart(3)}  ${f(r.n)}`));
  }

  // 2. The free-flow problem: can this data ever express >60 km/h?
  const sp = await p.query(`
    SELECT COUNT(*) FILTER (WHERE avg_speed_kmh >= 60)::int gt60,
           COUNT(*) FILTER (WHERE avg_speed_kmh >= 30 AND avg_speed_kmh < 60)::int mid,
           COUNT(*) FILTER (WHERE avg_speed_kmh > 0 AND avg_speed_kmh < 30)::int lo,
           COUNT(*) FILTER (WHERE avg_speed_kmh = 0)::int zero,
           COUNT(*)::int total
    FROM bronze.waze_hourly_jams`);
  const s = sp.rows[0];
  console.log("\nspeed distribution in the jam table:");
  console.log(`  >= 60 km/h (free flow) : ${f(s.gt60)}   <-- dashboard's free-flow band`);
  console.log(`  30-60 km/h (heavy)     : ${f(s.mid)}`);
  console.log(`  0-30  km/h (severe)    : ${f(s.lo)}`);
  console.log(`  exactly 0              : ${f(s.zero)}`);
  console.log(`  total                  : ${f(s.total)}`);

  // 3. Coverage: are jam rows only the congested hours, or every hour?
  const cov = await p.query(`
    SELECT COUNT(DISTINCT date_day)::int days,
           COUNT(DISTINCT nlex_exit_id)::int exits,
           COUNT(*)::int rows
    FROM bronze.waze_hourly_jams`);
  const c = cov.rows[0];
  const possible = c.days * 24 * c.exits;
  console.log(`\ncoverage: ${f(c.rows)} rows of ${f(possible)} possible (${c.days} days x 24h x ${c.exits} exits) = ${((c.rows / possible) * 100).toFixed(1)}%`);

  // 4. Overlap with the traffic fact table (feature source)
  const ov = await p.query(`
    SELECT COUNT(*)::int n FROM (
      SELECT DISTINCT date_day d FROM bronze.waze_hourly_jams
      INTERSECT SELECT DISTINCT date FROM gold.fact_traffic_hourly) x`);
  console.log(`\ndays overlapping gold.fact_traffic_hourly: ${f(ov.rows[0].n)} of 1,461`);

  // 5. Jam level as an alternative label
  const lv = await p.query(
    "SELECT ROUND(avg_jam_level)::int lvl, COUNT(*)::int n, ROUND(AVG(avg_speed_kmh)::numeric,1) spd FROM bronze.waze_hourly_jams GROUP BY 1 ORDER BY 1");
  console.log("\navg_jam_level vs speed (candidate label):");
  lv.rows.forEach((r) => console.log(`  level ${r.lvl}  ${f(r.n).padStart(8)} rows   mean speed ${r.spd} km/h`));

  await p.end();
})();
