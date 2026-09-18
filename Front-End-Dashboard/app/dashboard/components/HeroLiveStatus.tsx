"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, Gauge, TriangleAlert } from "lucide-react";
import { cachedJson } from "../../../lib/cached-json";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

/* The shape this panel needs out of /api/dashboard/corridor-status/full.
   Everything is optional because the hero must never be the reason the home
   page fails: if the feed is down the strip hides itself and the banner
   underneath is still a banner. */
type Dir = { status?: string | null; speedKmh?: number | null; jamCount?: number | null };
type Payload = {
  counts?: { congested?: number; slow?: number; clear?: number };
  feed?: { ageMinutes?: number | null; stale?: boolean };
  exits?: { display_name?: string; exit_name?: string; directions?: Record<string, Dir | null> }[];
};

type Status = {
  congested: number;
  slow: number;
  clear: number;
  ageMinutes: number | null;
  stale: boolean;
  slowest: { name: string; speed: number } | null;
};

/** Counts up to `value` once, then tracks it directly.
 *
 *  The count-up is for arrival, not for updates: a number that re-animates
 *  every poll is a number nobody can read. After the first run it snaps, so a
 *  refresh that moves 4 congested points to 5 simply shows 5. */
function useCountUp(value: number | null, duration = 900) {
  const [shown, setShown] = useState(0);
  const played = useRef(false);
  useEffect(() => {
    if (value == null) return;
    if (played.current) {
      setShown(value);
      return;
    }
    played.current = true;
    if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      // Ease-out cubic: fast enough to feel instant, slow enough to be read.
      setShown(Math.round(value * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return shown;
}

/**
 * Live corridor status, laid over the hero banner.
 *
 * The home page opened on a static picture. It is a good picture, but it says
 * the same thing at 3 AM on a clear Sunday as it does mid-rush with four exits
 * crawling — so the first screen of a live traffic system carried no live
 * traffic. This puts the corridor's current state on it: how many points are
 * congested right now, where the worst one is, and how old the reading is.
 *
 * It reads the same endpoint the corridor panel below already polls, through
 * the same 25 s memo, so it costs no extra round trip.
 */
export default function HeroLiveStatus() {
  const [s, setS] = useState<Status | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        /* The API answers {success, data}. cachedJson hands back the parsed
           body untouched, so unwrap here rather than assuming either shape. */
        const body = await cachedJson<Payload | { data?: Payload }>(
          `${BACKEND}/api/dashboard/corridor-status/full`, 25_000);
        const d = ((body as { data?: Payload })?.data ?? body) as Payload;
        if (cancelled || !d?.counts) return;

        // The slowest moving point on the corridor, in either direction.
        let slowest: { name: string; speed: number } | null = null;
        for (const e of d.exits ?? []) {
          for (const dir of Object.values(e.directions ?? {})) {
            const v = dir?.speedKmh;
            if (typeof v !== "number") continue;
            if (!slowest || v < slowest.speed) {
              slowest = { name: e.display_name || e.exit_name || "—", speed: v };
            }
          }
        }
        setS({
          congested: d.counts.congested ?? 0,
          slow: d.counts.slow ?? 0,
          clear: d.counts.clear ?? 0,
          ageMinutes: d.feed?.ageMinutes ?? null,
          stale: Boolean(d.feed?.stale),
          slowest,
        });
      } catch {
        /* Silent: the banner stands on its own. */
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const congested = useCountUp(s?.congested ?? null);
  const slow = useCountUp(s?.slow ?? null);
  const clear = useCountUp(s?.clear ?? null);

  if (!s) return null;

  const calm = s.congested === 0;
  const headline = calm
    ? "Corridor flowing"
    : `${s.congested} point${s.congested === 1 ? "" : "s"} congested`;
  const age =
    s.ageMinutes == null ? "—" : s.ageMinutes < 1 ? "just now" : `${Math.round(s.ageMinutes)} min ago`;

  return (
    <div className="ds-hero-live" role="status" aria-label="Live corridor status">
      <div className="ds-hero-live-main">
        <span className={`ds-live-dot${s.stale ? " is-stale" : ""}`} aria-hidden="true" />
        <div>
          <div className="ds-hero-live-kicker">{s.stale ? "Feed stale" : "Live"} · {age}</div>
          <div className={`ds-hero-live-headline${calm ? " is-calm" : ""}`}>{headline}</div>
        </div>
      </div>

      <div className="ds-hero-live-stats">
        <span className="ds-hero-stat is-congested" title="Direction-segments crawling">
          <TriangleAlert size={14} aria-hidden="true" />
          <b>{congested}</b> congested
        </span>
        <span className="ds-hero-stat is-slow" title="Direction-segments running below normal">
          <Activity size={14} aria-hidden="true" />
          <b>{slow}</b> slow
        </span>
        <span className="ds-hero-stat is-clear" title="Direction-segments with no reported jam">
          <Gauge size={14} aria-hidden="true" />
          <b>{clear}</b> clear
        </span>
        {s.slowest && (
          <span className="ds-hero-stat is-worst" title="The slowest reading anywhere on the corridor right now">
            slowest <b>{s.slowest.name}</b> {s.slowest.speed.toFixed(0)} km/h
          </span>
        )}
      </div>
    </div>
  );
}
