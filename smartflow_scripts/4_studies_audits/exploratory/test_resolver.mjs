import fs from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

// Compile the TS module to JS on the fly so we test the real source.
const SRC = fileURLToPath(new URL("../../../Back-End/src/etl/canonical-exit.ts", import.meta.url));
const OUT = fileURLToPath(new URL("../../_work/canonical-exit.mjs", import.meta.url));
execSync(`npx esbuild "${SRC}" --format=esm --outfile="${OUT}"`, { stdio: "pipe" });

const { resolvePlaza, canonicalExits } = await import("file:///" + OUT);

// One raw plaza string per line, e.g. the distinct entry/exit names pulled from
// the hourly CSVs. The original list was a temp file that no longer exists.
const NAMES_FILE = process.argv[2];
if (!NAMES_FILE) {
  console.error("Usage: node test_resolver.mjs <file with one raw plaza name per line>");
  process.exit(1);
}
const names = fs.readFileSync(NAMES_FILE, "utf8")
  .split("\n").map((s) => s.replace(/\r$/, "")).filter((s) => s.length > 0);

const byStatus = { nlex: [], connecting: [], no_ticket: [], unresolved: [] };
const canonSet = new Set();
for (const n of names) {
  const r = resolvePlaza(n);
  byStatus[r.status].push({ raw: n, canon: r.canonical, dir: r.direction, role: r.role, sys: r.system });
  if (r.status === "nlex") canonSet.add(r.canonical);
}

console.log(`INPUT: ${names.length} distinct raw plaza strings\n`);
for (const k of ["nlex", "connecting", "no_ticket", "unresolved"]) {
  console.log(`  ${k.padEnd(12)} ${String(byStatus[k].length).padStart(3)}`);
}

console.log(`\nDistinct canonical NLEX exits reached: ${canonSet.size} of 20`);
const missing = canonicalExits().filter((c) => !canonSet.has(c));
console.log("  not present in these files: " + (missing.length ? missing.join(", ") : "none"));

if (byStatus.unresolved.length) {
  console.log("\n!! UNRESOLVED (would be flagged, not dropped):");
  byStatus.unresolved.forEach((u) => console.log(`   "${u.raw}"  base=""`));
} else {
  console.log("\nNo unresolved names.");
}

console.log("\nSample parses:");
["Meycauayan SB (Entry OS)", "TAMBOBONG NB ", "SANTA RITA NB ENTRY",
 "Mexico NB/SB (Exit CS)", "CIUDAD DE VICTORIA SB", "SFEX (OUTBOUND TIPO)",
 "No Ticket ", "NEW CLARK CITY INTERCHANGE "].forEach((s) => {
  const r = resolvePlaza(s);
  console.log(`  "${s}"\n     -> ${r.canonical}  [${r.status}]  dir=${r.direction}  role=${r.role}  sys=${r.system}`);
});
