const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);

const SPAN = "date BETWEEN '2022-01-01' AND '2025-12-31'";
const OLD = "gold.daily_traffic_volume_corrected_bak_20260829";
const NEW = "gold.daily_traffic_volume_corrected";

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
function acf(a, lag) {
  const m = mean(a);
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) den += (a[i] - m) ** 2;
  for (let i = lag; i < a.length; i++) num += (a[i] - m) * (a[i - lag] - m);
  return num / den;
}
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(q * (s.length - 1))]; };
const f = (v, d = 0) => Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const row = (label, o, n, d = 0, suffix = "") =>
  console.log(`  ${label.padEnd(30)} ${(f(o, d) + suffix).padStart(14)} ${(f(n, d) + suffix).padStart(14)}`);

(async () => {
  const get = async (t) => (await p.query(`SELECT date::text d, total_volume::float v FROM ${t} WHERE ${SPAN} ORDER BY date`)).rows;
  const O = await get(OLD), N = await get(NEW);
  const ov = O.map((r) => r.v), nv = N.map((r) => r.v);

  console.log(`Comparison over 2022-01-01..2025-12-31 (${O.length} days both)\n`);
  console.log("  " + "".padEnd(30) + "           OLD            NEW");
  console.log("  " + "-".repeat(60));

  console.log("\n  LEVEL & SPREAD");
  row("mean daily volume", mean(ov), mean(nv));
  row("median", pct(ov, .5), pct(nv, .5));
  row("std deviation", sd(ov), sd(nv));
  row("coefficient of variation", sd(ov) / mean(ov), sd(nv) / mean(nv), 4);
  row("minimum", Math.min(...ov), Math.min(...nv));
  row("maximum", Math.max(...ov), Math.max(...nv));
  row("range (max-min)", Math.max(...ov) - Math.min(...ov), Math.max(...nv) - Math.min(...nv));
  row("5th percentile", pct(ov, .05), pct(nv, .05));
  row("95th percentile", pct(ov, .95), pct(nv, .95));

  console.log("\n  PERSISTENCE (autocorrelation)");
  row("lag-1 (yesterday)", acf(ov, 1), acf(nv, 1), 4);
  row("lag-7 (same day last week)", acf(ov, 7), acf(nv, 7), 4);
  row("lag-14", acf(ov, 14), acf(nv, 14), 4);
  row("lag-365 (same day last year)", acf(ov, 365), acf(nv, 365), 4);

  const diff = (a) => a.slice(1).map((x, i) => Math.abs(x - a[i]));
  console.log("\n  DAY-TO-DAY VOLATILITY");
  row("mean |change| vs prev day", mean(diff(ov)), mean(diff(nv)));
  row("as % of mean level", mean(diff(ov)) / mean(ov) * 100, mean(diff(nv)) / mean(nv) * 100, 2, "%");

  console.log("\n  DAY-OF-WEEK PROFILE (avg volume)");
  const dow = (rows) => {
    const g = Array.from({ length: 7 }, () => []);
    rows.forEach((r) => g[new Date(r.d + "T00:00:00").getDay()].push(r.v));
    return g.map(mean);
  };
  const dO = dow(O), dN = dow(N);
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  names.forEach((nm, i) => {
    const rank = (arr, i) => [...arr].sort((a, b) => b - a).indexOf(arr[i]) + 1;
    console.log(`  ${nm.padEnd(30)} ${f(dO[i]).padStart(14)} ${f(dN[i]).padStart(14)}    rank ${rank(dO, i)} -> ${rank(dN, i)}`);
  });

  console.log("\n  MONTHLY PROFILE (avg volume)");
  const mon = (rows) => {
    const g = Array.from({ length: 12 }, () => []);
    rows.forEach((r) => g[Number(r.d.slice(5, 7)) - 1].push(r.v));
    return g.map(mean);
  };
  const mO = mon(O), mN = mon(N);
  const mnames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  mnames.forEach((nm, i) => row(nm, mO[i], mN[i]));
  row("month spread (max-min)", Math.max(...mO) - Math.min(...mO), Math.max(...mN) - Math.min(...mN));

  console.log("\n  YEAR-OVER-YEAR GROWTH");
  for (const y of [2022, 2023, 2024, 2025]) {
    const o = mean(O.filter((r) => r.d.startsWith(String(y))).map((r) => r.v));
    const n = mean(N.filter((r) => r.d.startsWith(String(y))).map((r) => r.v));
    row(String(y), o, n);
  }

  console.log("\n  EXTREME DAYS");
  const top = (rows, k) => [...rows].sort((a, b) => b.v - a.v).slice(0, k);
  const bot = (rows, k) => [...rows].sort((a, b) => a.v - b.v).slice(0, k);
  console.log("   OLD highest: " + top(O, 3).map((r) => `${r.d} ${f(r.v)}`).join(" | "));
  console.log("   NEW highest: " + top(N, 3).map((r) => `${r.d} ${f(r.v)}`).join(" | "));
  console.log("   OLD lowest : " + bot(O, 3).map((r) => `${r.d} ${f(r.v)}`).join(" | "));
  console.log("   NEW lowest : " + bot(N, 3).map((r) => `${r.d} ${f(r.v)}`).join(" | "));

  console.log("\n  CORRELATION BETWEEN THE TWO SERIES");
  const mo = mean(ov), mn = mean(nv);
  let num = 0, d1 = 0, d2 = 0;
  for (let i = 0; i < ov.length; i++) { num += (ov[i] - mo) * (nv[i] - mn); d1 += (ov[i] - mo) ** 2; d2 += (nv[i] - mn) ** 2; }
  console.log(`   Pearson r = ${(num / Math.sqrt(d1 * d2)).toFixed(4)}  (how much the two agree day by day)`);

  await p.end();
})();
