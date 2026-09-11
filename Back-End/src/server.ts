import { app } from "./app.js";
import { env } from "./config/env.js";
import { verifyDbConnection } from "./config/db.js";
import { setSelfBase } from "./middleware/route-cache.js";

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
  // The route cache refreshes stale entries by calling back into this server.
  setSelfBase(`http://127.0.0.1:${env.PORT}`);
  if (process.env.CACHE_WARMER === "off") return;
  const base = `http://127.0.0.1:${env.PORT}/api`;
  // x-cache-bypass makes the warmer refill the entry rather than read it.
  const warm = (path: string) =>
    fetch(`${base}${path}`, { headers: { "x-cache-bypass": "1" } }).catch(() => undefined);

  /* Interval sits inside the TTL the route cache assigns (30 s live, 10 min
     otherwise). The list is every route that measured over ~1 s: the first
     three from the initial pass, the rest from timing all 33 GET routes.
     /incident/severity is here because it measured 120 s cold and 14 s warm;
     one refill every nine minutes is the price of nobody ever waiting on it. */
  const jobs: [string, number][] = [
    ["/map-comparison/real-time", 25_000],
    ["/dashboard/corridor-status/full", 25_000],
    ["/map-comparison/live-overview", 25_000],
    ["/traffic/forecast?months=all", 9 * 60_000],
    ["/incident/predictive", 9 * 60_000],
    ["/incident/severity", 9 * 60_000],
    ["/incident/weather-speed", 9 * 60_000],
    ["/incident/weather-correlation", 9 * 60_000],
    ["/incident/spatial", 9 * 60_000],
    ["/incident/event-breakdown", 9 * 60_000],
    ["/traffic/weather-evidence", 9 * 60_000],
    ["/emissions/forecast", 9 * 60_000],
    ["/dashboard/overview", 9 * 60_000],
  ];
  for (const [path, every] of jobs) {
    void warm(path);
    const t = setInterval(() => void warm(path), every);
    t.unref(); // never keep the process alive on its own
  }
}
