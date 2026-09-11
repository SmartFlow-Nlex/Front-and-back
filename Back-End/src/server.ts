import { app } from "./app.js";
import { env } from "./config/env.js";
import { verifyDbConnection } from "./config/db.js";

app.listen(env.PORT, async () => {
  console.log(`smartflow-backend running on http://localhost:${env.PORT}`);
  await verifyDbConnection();
  startCacheWarmer();
});

/* Keep the slow endpoints warm so no user request lands on a cold cache.
 *
 * The RDS instance behind this API is small and its cold reads are erratic:
 * the live-map queries plan at 13 ms and 73 ms, yet a cold request measured
 * 10-16 s repeatedly, with no other session on the database. A TTL cache
 * turns that into 5 ms for everyone after the first caller -- but the first
 * caller still waits. Refreshing each key from here, just inside its TTL,
 * moves the slow read off the request path entirely. The cost is one query
 * per interval whether or not anyone is looking, which on these intervals is
 * a few dozen queries an hour.
 *
 * Self-requests to the real routes, deliberately: they exercise the same
 * handlers, cache keys and defaults the browser uses, so a key can never be
 * warmed under one name and requested under another.
 */
function startCacheWarmer(): void {
  if (process.env.CACHE_WARMER === "off") return;
  const base = `http://127.0.0.1:${env.PORT}/api`;
  const warm = (path: string) =>
    fetch(`${base}${path}`, { headers: { "x-cache-warmer": "1" } }).catch(() => undefined);

  // Interval sits inside the TTL each handler uses (30 s / 10 min).
  const jobs: [string, number][] = [
    ["/map-comparison/real-time", 25_000],
    ["/traffic/forecast?months=all", 9 * 60_000],
    ["/incident/predictive", 9 * 60_000],
  ];
  for (const [path, every] of jobs) {
    void warm(path);
    const t = setInterval(() => void warm(path), every);
    t.unref(); // never keep the process alive on its own
  }
}
