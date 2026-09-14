/**
 * Streams the four hourly CSVs, canonicalises every plaza name through the ETL's
 * own resolver, and aggregates to (date, hour, exit, direction, role, system).
 *
 * Streaming + aggregating locally rather than loading 12.5M raw rows over the
 * wire: the Descriptive tab aggregates by plaza anyway, so the raw origin-
 * destination grain buys nothing for THIS task while costing ~10x the rows and
 * hours of transfer. The O-D pairs remain in the CSVs for the Exit-Impact map.
 */
import fs from "fs";
import readline from "readline";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const cfg = createRequire(import.meta.url)("../../config/db.cjs");
// Paths are relative to this file, so the folder works wherever it is copied.
const WORK = fileURLToPath(new URL("../../_work", import.meta.url)).replace(/\\/g, "/");

const SRC = fileURLToPath(new URL("../../../Back-End/src/etl/canonical-exit.ts", import.meta.url));
const MOD = WORK + "/ce.mjs";
execSync(`npx esbuild "${SRC}" --format=esm --outfile="${MOD}"`, { stdio: "pipe" });
const { resolvePlaza } = await import("file:///" + MOD);

const DIR = cfg.setting("RAW_TRAFFIC_DIR", undefined, true);   // set in config/.env
const OUT = WORK + "/fact_hourly.tsv";
const YEARS = [2022, 2023, 2024, 2025];

// Resolver is pure — memoise, since only ~98 distinct strings appear in 12.5M rows.
const cache = new Map();
const resolve = (s) => {
  let v = cache.get(s);
  if (v === undefined) { v = resolvePlaza(s); cache.set(s, v); }
  return v;
};

const agg = new Map();
let rows = 0, skipped = 0, unresolved = 0;
const t0 = Date.now();

for (const y of YEARS) {
  const rl = readline.createInterface({
    input: fs.createReadStream(`${DIR}/nlex_traffic_hourly_${y}.csv`, { highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });
  let first = true;
  for await (const line of rl) {
    if (first) { first = false; continue; }
    if (!line) continue;
    const c = line.split(",");
    if (c.length < 10) { skipped++; continue; }

    const ex = resolve(c[9]);
    if (ex.status === "unresolved") { unresolved++; continue; }

    // Key on the transaction plaza. OS collects at entry, CS at exit, so this
    // column is the point where the trip was actually counted — one per trip.
    const key = `${c[0]}\t${c[1]}\t${ex.canonical}\t${ex.direction ?? ""}\t${ex.role ?? ""}\t${ex.system ?? ""}\t${ex.status}`;
    let a = agg.get(key);
    if (!a) { a = [0, 0, 0, 0]; agg.set(key, a); }
    a[0] += +c[5]; a[1] += +c[6]; a[2] += +c[7]; a[3] += +c[8];
    rows++;
  }
  process.stdout.write(`  ${y} done — ${rows.toLocaleString()} rows, ${agg.size.toLocaleString()} groups\n`);
}

const ws = fs.createWriteStream(OUT);
let out = 0;
for (const [k, a] of agg) {
  ws.write(`${k}\t${a[0].toFixed(2)}\t${a[1].toFixed(2)}\t${a[2].toFixed(2)}\t${a[3].toFixed(2)}\n`);
  out++;
}
await new Promise((r) => ws.end(r));

console.log(`\nread     : ${rows.toLocaleString()} source rows`);
console.log(`skipped  : ${skipped} malformed`);
console.log(`unresolved plaza names: ${unresolved}`);
console.log(`written  : ${out.toLocaleString()} aggregated rows -> ${OUT}`);
console.log(`size     : ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB`);
console.log(`elapsed  : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
