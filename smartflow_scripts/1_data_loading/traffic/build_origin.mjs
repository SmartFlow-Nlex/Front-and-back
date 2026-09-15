/**
 * Origin-side companion to gold.fact_traffic_hourly.
 *
 * The exit-keyed fact table drops the entry column, which meant facilities that
 * only ever appear as an ORIGIN — Mabiga (the SCTEX Spur Road's collecting plaza)
 * among them — vanished entirely. Their trips were counted, but you could not see
 * where they came from.
 *
 * Keyed on (date, hour, entry) instead. Deliberately a SEPARATE table: adding the
 * entry dimension to the exit table would multiply it to ~12.5M rows AND make
 * SUM(total) double-count if anyone summed across both dimensions. Volume totals
 * live in the exit table; this one answers "where did the traffic come from".
 */
import fs from "fs";
import readline from "readline";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const cfg = createRequire(import.meta.url)("../../config/db.cjs");
const DIR = cfg.setting("RAW_TRAFFIC_DIR", undefined, true);   // set in config/.env
// Paths are relative to this file, so the folder works wherever it is copied.
const WORK = fileURLToPath(new URL("../../_work", import.meta.url)).replace(/\\/g, "/");

const SRC = fileURLToPath(new URL("../../../Back-End/src/etl/canonical-exit.ts", import.meta.url));
const MOD = WORK + "/ce3.mjs";
execSync(`npx esbuild "${SRC}" --format=esm --outfile="${MOD}"`, { stdio: "pipe" });
const { resolvePlaza } = await import("file:///" + MOD);

const OUT = WORK + "/fact_origin.tsv";
const cache = new Map();
const R = (s) => { let v = cache.get(s); if (v === undefined) { v = resolvePlaza(s); cache.set(s, v); } return v; };

const agg = new Map();
let rows = 0, unresolved = 0;
const t0 = Date.now();

for (const y of [2022, 2023, 2024, 2025]) {
  const rl = readline.createInterface({
    input: fs.createReadStream(`${DIR}/nlex_traffic_hourly_${y}.csv`, { highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });
  let first = true;
  for await (const line of rl) {
    if (first) { first = false; continue; }
    if (!line) continue;
    const c = line.split(",");
    if (c.length < 10) continue;
    const e = R(c[4]);
    if (e.status === "unresolved") { unresolved++; continue; }
    const name = e.canonical ?? e.base;
    const key = `${c[0]}\t${c[1]}\t${name}\t${e.direction ?? ""}\t${e.status}`;
    let a = agg.get(key);
    if (!a) { a = [0, 0, 0, 0]; agg.set(key, a); }
    a[0] += +c[5]; a[1] += +c[6]; a[2] += +c[7]; a[3] += +c[8];
    rows++;
  }
  process.stdout.write(`  ${y} done — ${rows.toLocaleString()} rows, ${agg.size.toLocaleString()} groups\n`);
}

const ws = fs.createWriteStream(OUT);
for (const [k, a] of agg) {
  ws.write(`${k}\t${a[0].toFixed(2)}\t${a[1].toFixed(2)}\t${a[2].toFixed(2)}\t${a[3].toFixed(2)}\n`);
}
await new Promise((r) => ws.end(r));

console.log(`\nread ${rows.toLocaleString()} rows | unresolved ${unresolved} | wrote ${agg.size.toLocaleString()} groups`);
console.log(`size ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB | ${((Date.now() - t0) / 1000).toFixed(1)}s`);
