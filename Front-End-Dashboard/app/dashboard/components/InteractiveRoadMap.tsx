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

  /* ─── One direction at a time, drawn as a road ────────────────────────────
     Showing both carriageways side by side meant each got a thin bar and neither
     could look like anything. Picking a direction frees the width to draw an
     actual carriageway — asphalt, lane markings, traffic colour laid over it —
     and the corridor reads top to bottom the way you would drive it.

     Northbound runs up the km posts, southbound back down them, so the list
     order flips with the toggle rather than the labels merely being swapped. */

  const [dir, setDir] = useState<"NB" | "SB">("NB");

  const rows = useMemo(() => {
    const ordered = dir === "NB" ? exits : [...exits].reverse();
    return ordered.map((x) => ({
      exit: x,
      data: statusByExit.get(statusKey(x.exit_name, dir)) ?? CLEAR,
      access: accessLabel(x, dir),
    }));
  }, [exits, statusByExit, dir]);

  /** Counts for the direction on screen. Cells with no ramp are skipped rather
      than counted clear — they draw as a break in the road, and a tally that
      disagreed with the drawing would be worse than none. */
  const tally = useMemo(() => {
    const t = { congested: 0, slow: 0, clear: 0 };
    for (const r of rows) {
      if (r.access === "No Access") continue;
      if (r.data.colorClass === "seg-red") t.congested++;
      else if (r.data.colorClass === "seg-orange") t.slow++;
      else t.clear++;
    }
    return t;
  }, [rows]);

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
    <section id="nlex-roadmap" className="ds-rd">
      <header className="ds-rd-head">
        <div className="ds-rd-titles">
          <h2>
            Live Corridor Status
            {corridor?.feed.stale && (
              <span className="ds-rd-stale" title="The Waze ingester has not written a row recently">
                Stale feed
              </span>
            )}
          </h2>
          <p>NLEX Expressway · Metro Manila → Central Luzon</p>
        </div>

        <div className="ds-rd-meta">
          <div className="ds-rd-dirs" role="radiogroup" aria-label="Carriageway">
            {(["NB", "SB"] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={dir === d}
                className={`ds-rd-dir ${dir === d ? "active" : ""}`}
                onClick={() => setDir(d)}
              >
                <span className="ds-rd-caret" aria-hidden="true">{d === "NB" ? "▲" : "▼"}</span>
                {d === "NB" ? "Northbound" : "Southbound"}
              </button>
            ))}
          </div>

          <div className="ds-rd-tally" aria-label="Corridor summary">
            <span className="seg-red">{tally.congested} congested</span>
            <span className="seg-orange">{tally.slow} slow</span>
            <span className="seg-green">{tally.clear} clear</span>
          </div>
          <span className="ds-rd-updated">{headerSub}</span>
        </div>
      </header>

      <div ref={containerRef} className={`ds-rd-body ${isVisible ? "is-visible" : ""} dir-${dir.toLowerCase()}`}>
        <ol className="ds-rd-list">
          {rows.map(({ exit, data, access }, i) => {
            const noAccess = access === "No Access";
            const key = `${exit.exit_name}-${dir}`;
            const isActive = activeStation === key;

            return (
              <li
                key={key}
                className={`ds-rd-row ${noAccess ? "no-ramp" : data.colorClass} ${isActive ? "is-active" : ""}`}
                style={{ "--delay": `${Math.min(i, 14) * 0.025}s` } as React.CSSProperties}
                onMouseEnter={() => setActiveStation(key)}
                onMouseLeave={() => setActiveStation(null)}
              >
                <span className="ds-rd-km">{exit.km.toFixed(1)}</span>

                {/* The carriageway. Asphalt, lane markings and flow arrows are
                    all drawn in CSS on this element, and every row's is the same
                    height with no gap, so the road runs continuously down the
                    list instead of reading as twenty separate tiles. */}
                <span className="ds-rd-way" aria-hidden="true">
                  <span className="ds-rd-traffic" />
                  <span className="ds-rd-lanes" />
                  <span className="ds-rd-flow" />
                </span>

                {/* Slip road out to the exit marker. */}
                <span className="ds-rd-ramp" aria-hidden="true" />
                <span className="ds-rd-node" aria-hidden="true"><HexagonRoad /></span>

                <button
                  type="button"
                  className="ds-rd-info"
                  onFocus={() => setActiveStation(key)}
                  onBlur={() => setActiveStation(null)}
                  aria-label={`${exit.exit_name}, km ${exit.km.toFixed(1)}, ${dir}: ${noAccess ? "no ramp" : data.status.toLowerCase()}`}
                >
                  <span className="ds-rd-name">
                    {exit.exit_name}
                    {exit.node_type === "toll-barrier" && <em className="ds-rd-toll">toll</em>}
                  </span>
                  <span className="ds-rd-state">
                    {noAccess ? (
                      <span className="ds-rd-noramp">No ramp this way</span>
                    ) : (
                      <>
                        <span className="ds-rd-badge">{data.status}</span>
                        <span className="ds-rd-speed">{data.speed}</span>
                      </>
                    )}
                  </span>
                </button>

                {isActive && !noAccess && (
                  <div className="ds-rd-tip" role="tooltip">
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
                    <div className="ds-tooltip-row"><span>Slowest speed</span><span>{data.speed}</span></div>
                    {data.level != null && (
                      <div className="ds-tooltip-row"><span>Waze jam level</span><span>{data.level} of 5</span></div>
                    )}
                    <div className="ds-tooltip-row">
                      <span>Active jams</span><span>{data.jamCount === 0 ? "None reported" : data.jamCount}</span>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <footer className="ds-rd-foot">
        <div className="ds-rd-legend">
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
