"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, Gauge, TriangleAlert } from "lucide-react";
import { cachedJson } from "../../../lib/cached-json";
import {
  corridorStatusFromFeed,
  slowestReading,
  tallyExitStatuses,
  type CorridorTally,
} from "../../../lib/corridor-status";
import { displayExitName, useNlexExits } from "../../../lib/nlex-exits";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type Feed = { newestAt?: string | null; ageMinutes?: number | null; stale?: boolean };
type RealtimeFC = { features?: unknown[]; feed?: Feed };

type Status = CorridorTally & {
  ageMinutes: number | null;
  stale: boolean;
  slowest: { exit: string; speedKmh: number } | null;
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
 * traffic.
 *
 * IT MUST AGREE WITH THE PANEL BELOW IT. The first cut of this read
 * /api/dashboard/corridor-status/full, which aggregates in SQL — the very
 * endpoint lib/corridor-status.ts exists to replace, because it applies a
 * looser test than the map draws with. The two tallies sat six inches apart on
 * one screen and disagreed: 4/3/33 here against 4/2/34 there. This now reads
 * the same feed through the same derivation and the same tally rule, so they
 * cannot differ in principle rather than merely agreeing today.
 */
export default function HeroLiveStatus() {
  const { exits } = useNlexExits();
  const [s, setS] = useState<Status | null>(null);

  useEffect(() => {
    if (!exits.length) return;
    let cancelled = false;
    const load = async () => {
      try {
        // Same URL and same 25 s memo the corridor panel uses, so the two
        // share one response rather than making two round trips.
        const fc = await cachedJson<RealtimeFC>(`${BACKEND}/api/map-comparison/real-time`, 25_000);
        if (cancelled || !fc?.features) return;
        const statuses = corridorStatusFromFeed(fc as Parameters<typeof corridorStatusFromFeed>[0], exits);
        setS({
          ...tallyExitStatuses(exits, statuses),
          ageMinutes: fc.feed?.ageMinutes ?? null,
          stale: Boolean(fc.feed?.stale),
          slowest: slowestReading(statuses),
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
  }, [exits]);

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
        <span className="ds-hero-stat is-congested" title="Exit-directions crawling">
          <TriangleAlert size={14} aria-hidden="true" />
          <b>{congested}</b> congested
        </span>
        <span className="ds-hero-stat is-slow" title="Exit-directions running below normal">
          <Activity size={14} aria-hidden="true" />
          <b>{slow}</b> slow
        </span>
        <span className="ds-hero-stat is-clear" title="Exit-directions with no reported jam">
          <Gauge size={14} aria-hidden="true" />
          <b>{clear}</b> clear
        </span>
        {s.slowest && (
          <span className="ds-hero-stat is-worst" title="The slowest reading anywhere on the corridor right now">
            {/* The name here is derived client-side from the exit list, whose
                stored spelling title-cases the initialisms -- so without this
                the corridor's worst reading could be attributed to "Cdv/Ph
                Arena". */}
            slowest <b>{displayExitName(s.slowest.exit)}</b> {s.slowest.speedKmh.toFixed(0)} km/h
          </span>
        )}
      </div>
    </div>
  );
}
