/* A small in-memory cache with two properties the slow endpoints need.
 *
 * TTL: the forecast tables change only when a training script re-runs, the
 * live feed is a 60-minute window, and the RDS instance behind them is small
 * (shared_buffers ~88 MB, 77% cache hit) -- the same query measured at 13 ms
 * and at 15 s depending on what the disk was doing. Serving a recent answer
 * from memory both cuts latency and keeps repeat work off that instance.
 *
 * Single-flight: three cards on one tab request the same payload within the
 * same second. Without coalescing, a cold cache runs the work three times and
 * the third caller waits longest. Concurrent callers for one key share one
 * in-flight promise.
 *
 * Failures are never cached: a rejected promise is dropped so the next caller
 * retries rather than replaying an error for the whole TTL.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Entry<T> = { at: number; value: T };

/* Request-scoped bypass. The route cache honours x-cache-bypass, but the
 * controllers behind it keep their own entries here, so a refresh request
 * was refilling the route layer with a value THIS layer still held from
 * before a retrain -- the congestion map stayed five days stale through a
 * "refresh". When the middleware runs the request inside bypassScope, every
 * cached() call on that request treats its entry as absent and reproduces it. */
export const bypassScope = new AsyncLocalStorage<{ bypass: boolean }>();

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

/* Stale-while-revalidate.
 *
 * A fresh entry is returned. An EXPIRED entry is also returned -- immediately
 * -- while one refresh runs in the background; only a key with no entry at
 * all makes the caller wait. The reason is the cold read itself: the live-map
 * feed measured 10-30 s cold on this instance, longer than a warmer interval,
 * so a strict TTL left windows where a request arrived after expiry and sat
 * on the whole read. With this, after the first fill nobody waits on the
 * database again; they get the last answer, at most one TTL old, and the
 * next caller gets the refreshed one. */
export async function cached<T>(key: string, ttlMs: number, produce: () => Promise<T>): Promise<T> {
  const bypass = bypassScope.getStore()?.bypass === true;
  const hit = bypass ? undefined : (store.get(key) as Entry<T> | undefined);
  const fresh = hit != null && Date.now() - hit.at < ttlMs;
  if (fresh) return hit!.value;

  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return hit ? hit.value : running;

  const p = produce()
    .then((value) => {
      store.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  // Background refresh must never surface as an unhandled rejection when the
  // caller was handed the stale value instead of this promise.
  p.catch(() => undefined);
  return hit ? hit.value : p;
}

/** Drop one key, or everything -- for a retrain hook or a manual refresh. */
export function invalidate(key?: string): void {
  if (key == null) { store.clear(); return; }
  store.delete(key);
}
