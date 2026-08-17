"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/* ══════════════════════════════════════════════════════════════════════════════
   OFFICIAL NLEX STATION DEFINITIONS
   Each station carries: km marker · display name · per-direction access type.
   "toll-barrier" nodes (Bocaue Barrier) are flagged separately from ramp nodes.
══════════════════════════════════════════════════════════════════════════════ */

import { useNlexExits, accessLabel, type NlexExit } from "../../../lib/nlex-exits";



/* ══════════════════════════════════════════════════════════════════════════════
   LIVE CORRIDOR STATE

   This section used to hold three hardcoded datasets (LIVE / +1HR / +2HR). It now
   reads /api/dashboard/corridor-status, which derives per-exit, per-direction
   status from the same Waze jam feed the Live Map uses.

   Absence is information here: Waze only emits a record where there IS a jam, so
   an exit with no recent row is flowing freely. Every exit therefore starts clear
   and is darkened only by evidence.
══════════════════════════════════════════════════════════════════════════════ */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type SegmentStatus = "clear" | "slow" | "congested";

type ExitStatus = {
  exit: string;
  direction: "NB" | "SB";
  status: SegmentStatus;
  level: number | null;
  speedKmh: number | null;
  jamCount: number;
  observedAt: string | null;
};

type CorridorStatus = {
  windowMinutes: number;
  segments: ExitStatus[];
  feed: { newestAt: string | null; ageMinutes: number | null; stale: boolean };
};

type TrafficRecord = {
  colorClass: string;
  status: string;
  speed: string;
  level: number | null;
  jamCount: number;
};

const CLEAR: TrafficRecord = {
  colorClass: "seg-green",
  status: "CLEAR",
  speed: "Free flowing",
  level: null,
  jamCount: 0,
};

const COLOR_CLASS: Record<SegmentStatus, string> = {
  clear: "seg-green",
  slow: "seg-orange",
  congested: "seg-red",
};

/** Matches on name because the feed keys by exit name, as the shared list does. */
function statusKey(name: string, dir: string) {
  return `${name.toLowerCase().trim()}-${dir}`;
}

function buildLookup(data: CorridorStatus | null): Map<string, TrafficRecord> {
  const map = new Map<string, TrafficRecord>();
  if (!data) return map;
  for (const s of data.segments) {
    map.set(statusKey(s.exit, s.direction), {
      colorClass: COLOR_CLASS[s.status],
      status: s.status.toUpperCase(),
      speed: s.speedKmh != null ? `${s.speedKmh} km/h` : "—",
      level: s.level,
      jamCount: s.jamCount,
    });
  }
  return map;
}

/** Node glyph: a hexagon with lane markings, used for every station dot. */
const HexagonRoad = () => (
  <svg width="24" height="24" viewBox="0 0 32 32" className="ds-hex-svg">
    <polygon points="16,2 30,10 30,22 16,30 2,22 2,10" fill="none" stroke="currentColor" strokeWidth="2.5" />
    <path d="M12,6 L9,26 M20,6 L23,26 M16,8 L16,12 M16,16 L16,20" stroke="currentColor" strokeWidth="2" strokeDasharray="2 3" />
  </svg>
);

/** Polls the corridor feed. 60s because the ingester writes every few minutes —
    faster would just re-fetch the same rows. */
function useCorridorStatus() {
  const [data, setData] = useState<CorridorStatus | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`${BACKEND}/api/dashboard/corridor-status`, { cache: "no-store" });
        const json = await r.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setData(json.data);
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return { data, error, loading };
}


/* ══════════════════════════════════════════════════════════════════════════════
   COMPONENT
══════════════════════════════════════════════════════════════════════════════ */

export default function InteractiveRoadMap() {
  // One corridor list for every tab. See lib/nlex-exits.
  const { exits } = useNlexExits();

  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible,       setIsVisible]       = useState(false);
  const [activeStation,   setActiveStation]   = useState<string | null>(null);

  const { data: corridor, error: feedError, loading: feedLoading } = useCorridorStatus();
  const statusByExit = useMemo(() => buildLookup(corridor), [corridor]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setIsVisible(true); obs.disconnect(); } },
      { threshold: 0.1 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  /* ─── Corridor rows ───────────────────────────────────────────────────────
     Rebuilt from two horizontally-scrolling tracks into one vertical list.

     The old layout gave each of 20 exits a 104px column, so each direction was
     ~2,100px wide behind its own scrollbar. You could never see the corridor at
     once, the two scrollbars did not move together, and exit names had to be
     rotated 45 degrees to fit — which is why they collided in the screenshots.

     One row per exit, with northbound on the left and southbound on the right,
     fixes all three: names read horizontally, nothing scrolls sideways, and the
     two directions for a given exit finally sit next to each other, which is the
     comparison this panel exists to support. */

  const rows = useMemo(() => {
    return exits.map((x) => {
      const nb = statusByExit.get(statusKey(x.exit_name, "NB")) ?? CLEAR;
      const sb = statusByExit.get(statusKey(x.exit_name, "SB")) ?? CLEAR;
      return { exit: x, nb, sb };
    });
  }, [exits, statusByExit]);

  /** Counts for the header, so the state of the corridor is legible without
      reading 40 cells.

      Cells with no ramp in that direction are skipped rather than counted clear:
      they render as a dash, and a tally that disagreed with what is drawn would
      be worse than no tally. */
  const tally = useMemo(() => {
    const t = { congested: 0, slow: 0, clear: 0 };
    for (const r of rows) {
      for (const [dir, d] of [["NB", r.nb], ["SB", r.sb]] as const) {
        if (accessLabel(r.exit, dir) === "No Access") continue;
        if (d.colorClass === "seg-red") t.congested++;
        else if (d.colorClass === "seg-orange") t.slow++;
        else t.clear++;
      }
    }
    return t;
  }, [rows]);

  const renderCell = (
    exit: NlexExit,
    dir: "NB" | "SB",
    data: TrafficRecord,
  ) => {
    const key = `${exit.exit_name}-${dir}`;
    const isActive = activeStation === key;
    const access = accessLabel(exit, dir);
    // "No Access" is a fact about the ramp, not a traffic state, so it reads as
    // a dash rather than a green bar implying free-flowing traffic.
    const noAccess = access === "No Access";

    return (
      <div
        className={`ds-cx-cell ${dir === "NB" ? "nb" : "sb"} ${noAccess ? "none" : data.colorClass} ${isActive ? "is-active" : ""}`}
        onMouseEnter={() => setActiveStation(key)}
        onMouseLeave={() => setActiveStation(null)}
        onFocus={() => setActiveStation(key)}
        onBlur={() => setActiveStation(null)}
        tabIndex={0}
        role="button"
        aria-label={`${exit.exit_name} ${dir}: ${noAccess ? "no access" : data.status.toLowerCase()}`}
      >
        <span className="ds-cx-bar" />
        <span className="ds-cx-state">{noAccess ? "—" : data.status}</span>

        {isActive && !noAccess && (
          <div className={`ds-cx-tip ${dir === "NB" ? "tip-nb" : "tip-sb"}`} role="tooltip">
            <strong>{exit.exit_name} · {dir}</strong>
            {exit.node_type === "toll-barrier" ? (
              <>
                <div className="ds-tooltip-row"><span>Type</span><span className="warn">Mainline toll plaza</span></div>
                <div className="ds-tooltip-row">
                  <span>Operation</span><span>{dir === "NB" ? "On (mainline entry)" : "Off (pay & exit)"}</span>
                </div>
              </>
            ) : (
              <div className="ds-tooltip-row"><span>Access</span><span>{access}</span></div>
            )}
            <div className="ds-tooltip-row">
              <span>Status</span><span className={`ds-status-badge ${data.colorClass}`}>{data.status}</span>
            </div>
            <div className="ds-tooltip-row"><span>Slowest speed</span><span>{data.speed}</span></div>
            {data.level != null && (
              <div className="ds-tooltip-row"><span>Waze jam level</span><span>{data.level} of 5</span></div>
            )}
            <div className="ds-tooltip-row">
              <span>Active jams</span><span>{data.jamCount === 0 ? "None reported" : data.jamCount}</span>
            </div>
          </div>
        )}
      </div>
    );
  };

  /* ─── Header copy ─── */
  const headerSub = feedError
    ? "Feed unavailable — is the backend running on port 4000?"
    : feedLoading
      ? "Reading the Waze feed…"
      : corridor?.feed.newestAt
        ? `${corridor.feed.stale ? "Feed may be stale · last" : "Last"} report ${
            corridor.feed.ageMinutes != null && corridor.feed.ageMinutes < 1
              ? "just now"
              : `${corridor.feed.ageMinutes} min ago`
          } · ${corridor.windowMinutes}-minute window`
        : "No jam reports on the corridor right now";

  /* ─── Render ─── */
  return (
    <section id="nlex-roadmap" className="ds-cx">
      <header className="ds-cx-head">
        <div className="ds-cx-titles">
          <h2>
            Live Corridor Status
            {corridor?.feed.stale && (
              <span className="ds-cx-stale" title="The Waze ingester has not written a row recently">
                Stale feed
              </span>
            )}
          </h2>
          <p>NLEX Expressway · Metro Manila → Central Luzon</p>
        </div>

        <div className="ds-cx-meta">
          {/* The tally answers "is anything wrong" before any cell is read. */}
          <div className="ds-cx-tally" aria-label="Corridor summary">
            <span className="seg-red">{tally.congested} congested</span>
            <span className="seg-orange">{tally.slow} slow</span>
            <span className="seg-green">{tally.clear} clear</span>
          </div>
          <span className="ds-cx-updated">{headerSub}</span>
        </div>
      </header>

      <div ref={containerRef} className={`ds-cx-body ${isVisible ? "is-visible" : ""}`}>
        <div className="ds-cx-colhead" aria-hidden="true">
          <span>Northbound</span>
          <span className="mid">Exit</span>
          <span>Southbound</span>
        </div>

        <ol className="ds-cx-list">
          {rows.map(({ exit, nb, sb }, i) => (
            <li
              key={exit.exit_name}
              className={`ds-cx-row ${exit.node_type === "toll-barrier" ? "is-barrier" : ""}`}
              style={{ "--delay": `${Math.min(i, 12) * 0.03}s` } as React.CSSProperties}
            >
              {renderCell(exit, "NB", nb)}

              <div className="ds-cx-mid">
                <span className="ds-cx-km">{exit.km.toFixed(1)}</span>
                <span className="ds-cx-node" aria-hidden="true">
                  <HexagonRoad />
                </span>
                <span className="ds-cx-name">{exit.exit_name}</span>
              </div>

              {renderCell(exit, "SB", sb)}
            </li>
          ))}
        </ol>
      </div>

      <footer className="ds-cx-foot">
        <div className="ds-cx-legend">
          <span><i className="seg-red" /> Congested</span>
          <span><i className="seg-orange" /> Slow</span>
          <span><i className="seg-green" /> Clear</span>
          <span><i className="none" /> No ramp</span>
        </div>
        <p>
          Waze jam reports matched to the nearest exit; direction from jam bearing.
          An exit with no report is flowing freely.
        </p>
      </footer>
    </section>
  );
}
