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
 *   - Only 200 JSON bodies are stored; errors and 401s pass through untouched,
 *     and so does anything a route behind authenticateToken answers.
 *   - x-cache-bypass: 1 skips the cache and refills it (the refresher and the
 *     warmer use it).
 */
type Entry = { at: number; status: number; body: unknown };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const refreshing = new Set<string>();

/* Endpoints behind authenticateToken, which must never be cached.
 *
 * This middleware is mounted on /api AHEAD of the router, so it answers before
 * any route-level auth middleware runs. A protected GET that reached the store
 * was therefore served from it to whoever asked next, with no token required --
 * an authorization bypass through the cache rather than around the middleware.
 * The 10-minute default TTL applied to most of these.
 *
 * Only the protected members of each group are listed. /emissions/analytics and
 * /audit-log/list are public by design and keep their caching.
 */
const PROTECTED_PREFIXES = [
  "/api/emissions/index",
  "/api/emissions/peak-penalty",
  "/api/emissions/resilience",
  "/api/audit-log/export",
  "/api/ai-sandbox/results",
  "/api/data-management",
  "/api/upload",
];

/** True when a URL must bypass the cache because authorization decides the answer. */
function isProtected(url: string): boolean {
  return PROTECTED_PREFIXES.some((p) => url.startsWith(p));
}

const LIVE_PREFIXES = ["/api/map-comparison/real-time", "/api/map-comparison/live-overview", "/api/traffic/realtime", "/api/dashboard/corridor-status"];
const SHORT_PREFIXES = ["/api/maintenance", "/api/audit-log", "/api/health"];
/* Rewritten by the congestion pipeline every hour, and each response carries
   the base_ts it was computed from. Ten minutes of that is a forecast map
   captioned with the wrong base hour; the read behind it is one horizon of
   nineteen rows, so a short TTL costs little. */
const FORECAST_PREFIXES = ["/api/map-comparison/forecast"];

/* Historical reads (2026-10-15): three hours, not ten minutes. The record they read changes only when an upload
   is published (which clears this cache, below) or a model is retrained (weekly), so a ten-minute lifetime made
   the warmer re-run every heavy query six times an hour for answers that had not changed. On the micro RDS
   instance that drained its CPU and disk burst credits to zero and throttled the whole database. */
const RECORD_TTL_MS = 3 * 60 * 60_000;

export function ttlFor(url: string): number {
  if (LIVE_PREFIXES.some((p) => url.startsWith(p))) return 30_000;
  if (SHORT_PREFIXES.some((p) => url.startsWith(p))) return 15_000;
  if (FORECAST_PREFIXES.some((p) => url.startsWith(p))) return 60_000;
  return RECORD_TTL_MS;
}

/** When each URL was last asked for by a reader (not by the warmer), so live feeds are only kept warm while watched. */
const lastRead = new Map<string, number>();
export function lastReadAt(url: string): number {
  return lastRead.get(url) ?? 0;
}

/* New data published: every cached answer may be out of date. Each one is refetched in the background, a second
   and a half apart so the database is not hit with all of them at once, and served stale until its turn. */
function refreshEverything(): void {
  [...store.keys()].forEach((url, i) => {
    const t = setTimeout(() => refreshInBackground(url), i * 1_500);
    t.unref?.();
  });
}

/* An empty answer is never worth serving stale.
 *
 * The congestion pipeline rewrites its table hourly and can extend how far
 * ahead it reaches. Before one such run /forecast?hours=24 genuinely had no
 * rows, so this cache stored an empty FeatureCollection whose model block
 * reported maxHorizon 12 - correct at the time. After the run the warehouse
 * held 168 horizons, but the next reader was still handed that empty body,
 * and the horizon picker reads maxHorizon from it: the "Next 24 h" and "Next
 * 7 days" buttons stayed disabled, so nobody could ask a second time and
 * collect the fresh copy the background refresh had just fetched.
 *
 * Reproducing an empty result is cheap and can only improve on it, so a stale
 * entry with no payload is treated as a miss rather than as an answer. */
function isEmptyPayload(body: unknown): boolean {
  if (body == null || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.features)) return b.features.length === 0;
  if (Array.isArray(b.data)) return b.data.length === 0;
  return false;
}

function prefixOf(url: string): string {
  // "/api/incident/predictive?x=1" -> "/api/incident"
  const m = /^(\/api\/[^/?]+)/.exec(url);
  return m ? m[1] : url;
}

/* A write also bumps its group's generation (17 Oct 2026, testers' MS-8: "cancel seems to delete it").
   Clearing the entries was not enough on its own: a read that STARTED before the write -- a background
   refresh, or another page's poll -- finished after it and put the old answer back, so the maintenance
   page was served a list where the cancelled job was still "scheduled": gone from Scheduled, missing
   from Cancelled, and Restore acting on stale data. An answer is now stored only if its group's
   generation is the one it started under, so nothing read before a write can outlive it. */
const generation = new Map<string, number>();
const generationOf = (url: string) => generation.get(prefixOf(url)) ?? 0;

export function invalidatePrefix(prefix: string): void {
  generation.set(prefix, (generation.get(prefix) ?? 0) + 1);
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

  /*
   * What may be stored, and who may be served from the store.
   *
   * The path list is the first guard: those routes never touch the store.
   *
   * The second guard used to skip the cache for any request carrying an
   * Authorization header. That stopped being cheap when the dashboard began
   * attaching the user's token to every backend request (lib/backend-auth.ts):
   * from then on no signed-in reader was ever served from here, and each page
   * waited out its slow reads in full -- the sandbox 20-30 s, the audit log
   * 3-4 s -- while the warmer refilled entries nobody read.
   *
   * Since 7 Oct 2026 that guard sits on the STORE side instead.
   * authenticateToken marks every response it lets through
   * (res.locals.authRequired) and a marked response is never stored, so the
   * store holds only answers given without asking who was calling -- the same
   * for everybody -- and anyone may be served from it. A protected endpoint
   * added later and forgotten in the list above is still never stored.
   */
  if (isProtected(url)) {
    return next();
  }

  if (req.method !== "GET") {
    // A write under a prefix makes every cached read under it suspect. Not the
    // page-view beacon: every page opened posts to /audit-log/activity, so the
    // audit log's entries were cleared on each navigation and never served.
    // Audited actions clear them instead (writeAudit, services/audit.ts).
    if (!url.startsWith("/api/audit-log/activity")) {
      res.on("finish", () => { if (res.statusCode < 400) invalidatePrefix(prefixOf(url)); });
    }
    // A published upload or an undo changes the record every module reads (a ?mode=check dry run does not).
    if (/^\/api\/upload\/(file|[^/]+\/undo)/.test(url) && !/[?&]mode=check/.test(url)) {
      res.on("finish", () => { if (res.statusCode < 400) refreshEverything(); });
    }
    return next();
  }

  // Only the server's own warmer and refresher send this, from this machine. From anyone else it would let a
  // stranger force every heavy query to rerun on the shared database at will (2 Nov 2026), so it is ignored.
  const fromHere = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
  const bypass = req.headers["x-cache-bypass"] === "1" && fromHere;
  if (!bypass) lastRead.set(url, Date.now());
  const ttl = ttlFor(url);
  const hit = store.get(url);
  const fresh = hit != null && Date.now() - hit.at < ttl;

  if (!bypass && hit && fresh) {
    res.setHeader("X-Cache", "HIT");
    res.status(hit.status).json(hit.body);
    return;
  }
  if (!bypass && hit && !fresh && !isEmptyPayload(hit.body)) {
    // Serve what we have now; bring the next reader a fresh copy.
    res.setHeader("X-Cache", "STALE");
    res.status(hit.status).json(hit.body);
    refreshInBackground(url);
    return;
  }
  // An expired entry holding nothing falls through to the miss path below, so
  // this caller waits for a real answer instead of being told there is none.

  // Miss (or bypass). Coalesce concurrent misses for this URL: later callers
  // wait for the first run, then answer from the store. A caller that finds
  // nothing there -- the run failed, answered with something other than JSON,
  // or was a protected route, which is never stored -- runs the handler itself
  // and gets its own answer (this used to be a 503 for everyone waiting).
  const running = inflight.get(url);
  if (running && !bypass) {
    running.then(() => {
      const e = store.get(url);
      if (e) { res.setHeader("X-Cache", "HIT"); res.status(e.status).json(e.body); }
      else runHandler(res, next, url, false);
    });
    return;
  }

  let settle!: () => void;
  const p = new Promise<void>((r) => { settle = r; });
  inflight.set(url, p);
  const done = () => { if (inflight.get(url) === p) inflight.delete(url); settle(); };
  res.on("finish", done);
  res.on("close", done);
  runHandler(res, next, url, bypass);
}

/** Run the route's own handler, keeping its answer when it is the same for everybody. */
function runHandler(res: Response, next: NextFunction, url: string, bypass: boolean): void {
  const originalJson = res.json.bind(res);
  const startedUnder = generationOf(url);
  res.json = ((body: unknown) => {
    // authRequired: authenticateToken let this through, so the answer depends on who asked.
    // startedUnder: a write to this group since the handler began makes this answer stale.
    // noStore: the route answered, but with something incomplete it does not want kept (17 Oct 2026).
    if (res.statusCode === 200 && !res.locals.authRequired && !res.locals.noStore && generationOf(url) === startedUnder) {
      store.set(url, { at: Date.now(), status: 200, body });
    }
    res.setHeader("X-Cache", bypass ? "REFRESH" : "MISS");
    return originalJson(body);
  }) as typeof res.json;
  // A bypass reaches past this layer to the controllers' own TTL cache; see
  // bypassScope in utils/ttl-cache.
  if (bypass) bypassScope.run({ bypass: true }, () => next());
  else next();
}
