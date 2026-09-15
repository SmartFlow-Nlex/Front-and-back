/** Volume by ENTRY-side facility, to see whether any of the "connecting" names
 *  is really the SCTEX spur-road plaza under a different label. */
import fs from "fs";
import readline from "readline";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const cfg = createRequire(import.meta.url)("../../config/db.cjs");
const DIR = cfg.setting("RAW_TRAFFIC_DIR", undefined, true);   // set in config/.env

const SRC = fileURLToPath(new URL("../../../Back-End/src/etl/canonical-exit.ts", import.meta.url));
const MOD = fileURLToPath(new URL("../../_work/ce2.mjs", import.meta.url));
execSync(`npx esbuild "${SRC}" --format=esm --outfile="${MOD}"`, { stdio: "pipe" });
const { resolvePlaza } = await import("file:///" + MOD);

const cache = new Map();
const R = (s) => { let v = cache.get(s); if (v === undefined) { v = resolvePlaza(s); cache.set(s, v); } return v; };

const agg = new Map();
let total = 0;
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
    const e = R(c[4]);                       // entry_plaza_name
    const v = +c[8];
    const k = `${e.status}|${e.canonical ?? e.base}`;
    agg.set(k, (agg.get(k) ?? 0) + v);
    total += v;
  }
}

const rows = [...agg.entries()].sort((a, b) => b[1] - a[1]);
console.log(`Total tolled volume 2022-2025: ${Math.round(total).toLocaleString()}\n`);
console.log("ENTRY-side facility                     status        volume        share");
for (const [k, v] of rows) {
  const [st, name] = k.split("|");
  console.log(`  ${name.padEnd(34)} ${st.padEnd(11)} ${Math.round(v).toLocaleString().padStart(13)}  ${((v / total) * 100).toFixed(2)}%`);
}
