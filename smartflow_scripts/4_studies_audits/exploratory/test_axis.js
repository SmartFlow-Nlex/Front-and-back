// Replays the new labelIndices against the real served dates, at each
// granularity, to confirm the ticks land on month starts and stay put.
const { Pool } = require("pg");
const p = new Pool(require("../../config/db.cjs").poolConfig);

function labelIndices(isoDates, futureStart) {
  const n = isoDates.length;
  const keep = new Set();
  if (n === 0) return keep;
  const monthStarts = [];
  let prevYm = "";
  for (let i = 0; i < n; i++) {
    const ym = isoDates[i]?.slice(0, 7) ?? "";
    if (ym && ym !== prevYm) { monthStarts.push(i); prevYm = ym; }
  }
  if (monthStarts.length > 0) {
    const step = monthStarts.length <= 12 ? 1 : Math.ceil(monthStarts.length / 12);
    for (let i = 0; i < monthStarts.length; i += step) keep.add(monthStarts[i]);
  } else {
    const stride = Math.max(1, Math.ceil(n / 12));
    for (let i = 0; i < n; i += stride) keep.add(i);
  }
  const mustLabel = [futureStart, n - 1].filter((i) => i >= 0 && i < n);
  const mustSet = new Set(mustLabel);
  const minGap = Math.max(2, Math.floor(n / 24));
  for (const m of mustLabel) {
    for (const k of Array.from(keep)) {
      if (!mustSet.has(k) && Math.abs(k - m) < minGap) keep.delete(k);
    }
    keep.add(m);
  }
  return keep;
}

const OLD = (n, futureStart) => {
  const keep = new Set();
  const stride = Math.max(1, Math.ceil(n / 12));
  for (let i = 0; i < n; i += stride) keep.add(i);
  return keep;
};

(async () => {
  const r = await p.query(
    "SELECT forecast_date::text d, is_future FROM gold.ml_predictive_volume ORDER BY forecast_date");
  const all = r.rows.map((x) => x.d);
  // Chart shows the last 365 training days plus holdout + future.
  const firstHold = r.rows.findIndex((x) => !x.is_future && all.indexOf(x.d) >= 0 && x.is_future === false);
  const futIdxAll = r.rows.findIndex((x) => x.is_future);
  const startIdx = Math.max(0, futIdxAll - 365 - 294);
  const win = all.slice(startIdx);
  const futureStartWin = futIdxAll - startIdx;

  const gran = {
    Daily: win,
    Weekly: win.filter((_, i) => i % 7 === 0),
    Monthly: [...new Map(win.map((d) => [d.slice(0, 7), d])).values()],
  };

  for (const [name, iso] of Object.entries(gran)) {
    const fs = name === "Daily" ? futureStartWin
      : iso.findIndex((d) => d >= all[futIdxAll]);
    const keep = [...labelIndices(iso, fs)].sort((a, b) => a - b);
    const labels = keep.map((i) => iso[i]);
    const onFirst = labels.filter((d) => d.endsWith("-01")).length;
    console.log(`\n${name}  (${iso.length} points, futureStart ${fs})`);
    console.log("  new: " + labels.join("  "));
    console.log(`       ${onFirst}/${labels.length} land on a month start (rest are the 2 forced forecast markers)`);
    const oldKeep = [...OLD(iso.length, fs)].sort((a, b) => a - b);
    console.log("  old: " + oldKeep.map((i) => iso[i]).join("  "));
  }

  // Do the three granularities agree on their month ticks?
  const sets = Object.entries(gran).map(([n, iso]) => {
    const fs = n === "Daily" ? futureStartWin : iso.findIndex((d) => d >= all[futIdxAll]);
    return new Set([...labelIndices(iso, fs)].map((i) => iso[i].slice(0, 7)));
  });
  const common = [...sets[0]].filter((m) => sets[1].has(m) && sets[2].has(m));
  console.log(`\nmonths labelled in ALL three granularities: ${common.length} of ${sets[0].size}`);
  console.log("  " + common.join(", "));
  await p.end();
})();
