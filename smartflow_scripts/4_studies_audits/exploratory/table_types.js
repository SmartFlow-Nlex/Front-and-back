const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);

const targets = [
  ["bronze", "nlex_emissions"], ["bronze", "nlex_exits"], ["bronze", "nlex_traffic_volume"],
  ["gold", "daily_emissions_summary"], ["gold", "daily_weather_summary"],
  ["gold", "exit_direction_role"], ["gold", "exit_name_map"],
  ["gold", "live_nlex_incidents"], ["gold", "live_nlex_jams"],
  ["public", "dim_location"], ["public", "fact_hourly_weather"], ["public", "hourly_weather"],
  ["public", "nlex_emissions"], ["public", "nlex_exits"], ["public", "source_scores"],
  ["public", "v_nlex_galaxy_hourly"],
  ["silver", "dim_location"], ["silver", "hourly_weather_clean"],
  ["silver", "nlex_emissions_clean"], ["silver", "nlex_exit_reference"],
  ["silver", "nlex_exits_clean"], ["silver", "nlex_traffic_volume_clean"],
];

(async () => {
  const r = await p.query(
    "SELECT table_schema s, table_name t, table_type ty FROM information_schema.tables WHERE table_schema IN ('bronze','silver','gold','public')"
  );
  const typeOf = new Map(r.rows.map((x) => [`${x.s}.${x.t}`, x.ty]));
  const mv = await p.query("SELECT schemaname s, matviewname t FROM pg_matviews");
  const mvSet = new Set(mv.rows.map((x) => `${x.s}.${x.t}`));

  const base = [], views = [], mats = [];
  for (const [s, t] of targets) {
    const key = `${s}.${t}`;
    if (mvSet.has(key)) mats.push(key);
    else if (typeOf.get(key) === "BASE TABLE") base.push(key);
    else views.push(`${key}  [${typeOf.get(key) ?? "unknown"}]`);
  }
  console.log("BASE TABLES (safe to UPDATE):");
  base.forEach((x) => console.log("  " + x));
  console.log("\nVIEWS (derive from base — must NOT be updated):");
  views.length ? views.forEach((x) => console.log("  " + x)) : console.log("  none");
  console.log("\nMATERIALIZED VIEWS (need REFRESH after):");
  mats.length ? mats.forEach((x) => console.log("  " + x)) : console.log("  none");
  await p.end();
})();
