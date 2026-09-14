const { Pool } = require("pg");
const p = new Pool(require("../config/db.cjs").poolConfig);

const SOURCES = [
  ["exit_name_map",        "SELECT DISTINCT canonical_exit n FROM gold.exit_name_map WHERE canonical_exit IS NOT NULL"],
  ["exit_direction_role",  "SELECT DISTINCT exit_name n FROM gold.exit_direction_role"],
  ["fact_traffic_hourly",  "SELECT DISTINCT exit_canonical n FROM gold.fact_traffic_hourly"],
  ["descriptive matview",  "SELECT DISTINCT toll_plaza n FROM public.nlex_traffic_volume"],
  ["silver clean",         "SELECT DISTINCT toll_plaza n FROM silver.nlex_traffic_volume_clean"],
  ["bronze exits",         "SELECT DISTINCT exit_name n FROM bronze.nlex_exits"],
];

(async () => {
  const sets = {};
  for (const [label, q] of SOURCES) {
    try { sets[label] = new Set((await p.query(q)).rows.map((r) => r.n)); }
    catch (e) { sets[label] = null; console.log(`  ${label}: ERROR ${e.message.slice(0, 50)}`); }
  }

  const all = new Set();
  Object.values(sets).forEach((s) => s && s.forEach((x) => all.add(x)));
  const names = [...all].sort((a, b) => a.localeCompare(b));

  console.log("EXIT NAME PRESENCE ACROSS TABLES");
  const hdr = Object.keys(sets).map((k) => k.slice(0, 8).padEnd(9)).join("");
  console.log("  " + "name".padEnd(28) + hdr);
  for (const n of names) {
    const marks = Object.values(sets).map((s) => (s && s.has(n) ? "  x      " : "  -      ")).join("");
    console.log("  " + n.padEnd(28) + marks);
  }

  // Casing / formatting heuristics
  console.log("\nFORMATTING REVIEW");
  const ACRONYMS = ["CDV", "PH", "NLEX", "SCTEX", "TPLEX", "SFEX", "DMIA", "IC"];
  const issues = [];
  for (const n of names) {
    for (const w of n.split(/[\s/]+/)) {
      const up = w.replace(/[^A-Za-z]/g, "").toUpperCase();
      if (ACRONYMS.includes(up) && w.replace(/[^A-Za-z]/g, "") !== up) {
        issues.push(`  ${n.padEnd(28)} "${w}" should be "${up}" (acronym)`);
      }
    }
    if (/\bDe\b/.test(n)) issues.push(`  ${n.padEnd(28)} "De" — Filipino/Spanish place names normally lowercase "de"`);
    if (/\s{2,}|^\s|\s$/.test(n)) issues.push(`  ${n.padEnd(28)} whitespace problem`);
  }
  console.log(issues.length ? issues.join("\n") : "  none flagged");

  console.log("\nABBREVIATION CONSISTENCY");
  const sta = names.filter((n) => /^Sta\.?\s/i.test(n));
  console.log("  Sta. forms: " + (sta.join(" | ") || "none"));
  const dotted = sta.filter((n) => /^Sta\./.test(n)).length;
  console.log(`  ${dotted} of ${sta.length} use "Sta." with a period` + (dotted === sta.length ? "  (consistent)" : "  <-- INCONSISTENT"));

  await p.end();
})();
