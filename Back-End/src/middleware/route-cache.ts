import type { Request, Response, NextFunction } from "express";
import { bypassScope } from "../utils/ttl-cache.js";

/* Route-level cache for GET JSON responses.
 *
 * Eight more endpoints measured slow after the first three were cached by
 * hand -- /incident/severity at 120 s cold and 14 s warm, weather-speed at
 * 19 s, emissions/forecast at 8 s, weather-evidence at 4.5 s -- and every one
 * of them reads tables that change only when a script re-runs. Wrapping
 * each controller individually does not scale and misses the next route
 * someone adds, so this sits once on /api and applies to any successful GET.
 *
 * Behaviour:
 *   - TTL by path prefix: live feeds 30 s, everything else 10 min.
 *   - Single-flight: concurrent misses for one URL share one handler run.
 *   - Stale-while-revalidate: an expired entry is served immediately and a
 *     background self-request refreshes it, so after the first fill no user
 *     waits on a slow query.
 *   - Writes invalidate: any non-GET under a prefix clears that prefix, so a
 *     PATCH to /maintenance/:id/status is followed by a fresh list.
 *   - Only 200 JSON bodies are stored; errors and 401s pass through untouched.
 *   - x-cache-bypass: 1 skips the cache and refills it (the refresher and the
 *     warmer use it).
 */
type Entry = { at: number; status: number; body: unknown };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const refreshing = new Set<string>();

const LIVE_PREFIXES = ["/api/map-comparison/real-time", "/api/map-comparison/live-overview", "/api/traffic/realtime", "/api/dashboard/corridor-status"];
const SHORT_PREFIXES = ["/api/maintenance", "/api/audit-log", "/api/health"];

export function ttlFor(url: string): number {
  if (LIVE_PREFIXES.some((p) => url.startsWith(p))) return 30_000;
  if (SHORT_PREFIXES.some((p) => url.startsWith(p))) return 15_000;
  return 10 * 60_000;
}

function prefixOf(url: string): string {
  // "/api/incident/predictive?x=1" -> "/api/incident"
  const m = /^(\/api\/[^/?]+)/.exec(url);
  return m ? m[1] : url;
}

export function invalidatePrefix(prefix: string): void {
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
}

let selfBase: string | null = null;
/** The warmer and the background refresher call back into this server. */
export function setSelfBase(base: string): void { selfBase = base; }

function refreshInBackground(url: string): void {
  if (!selfBase || refreshing.has(url)) return;
  refreshing.add(url);
  fetch(`${selfBase}${url}`, { headers: { "x-cache-bypass": "1" } })
    .catch(() => undefined)
    .finally(() => refreshing.delete(url));
}

export function routeCache(req: Request, res: Response, next: NextFunction): void {
  const url = req.originalUrl;

  if (req.method !== "GET") {
    // A write under a prefix makes every cached read under it suspect.
    res.on("finish", () => { if (res.statusCode < 400) invalidatePrefix(prefixOf(url)); });
    return next();
  }

  const bypass = req.headers["x-cache-bypass"] === "1";
  const ttl = ttlFor(url);
  const hit = store.get(url);
  const fresh = hit != null && Date.now() - hit.at < ttl;

  if (!bypass && hit && fresh) {
    res.setHeader("X-Cache", "HIT");
    res.status(hit.status).json(hit.body);
    return;
  }
  if (!bypass && hit && !fresh) {
    // Serve what we have now; bring the next reader a fresh copy.
    res.setHeader("X-Cache", "STALE");
    res.status(hit.status).json(hit.body);
    refreshInBackground(url);
    return;
  }

  // Miss (or bypass). Coalesce concurrent misses for this URL: later callers
  // wait for the first run, then answer from the store.
  const running = inflight.get(url);
  if (running && !bypass) {
    running.then(() => {
      const e = store.get(url);
      if (e) { res.setHeader("X-Cache", "HIT"); res.status(e.status).json(e.body); }
      else res.status(503).json({ success: false, message: "Upstream produced no cacheable response" });
    });
    return;
  }

  let settle!: () => void;
  const p = new Promise<void>((r) => { settle = r; });
  inflight.set(url, p);

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode === 200) store.set(url, { at: Date.now(), status: 200, body });
    res.setHeader("X-Cache", bypass ? "REFRESH" : "MISS");
    return originalJson(body);
  }) as typeof res.json;
  res.on("finish", () => { inflight.delete(url); settle(); });
  res.on("close", () => { inflight.delete(url); settle(); });
  // A bypass reaches past this layer to the controllers' own TTL cache; see
  // bypassScope in utils/ttl-cache.
  if (bypass) bypassScope.run({ bypass: true }, () => next());
  else next();
}
