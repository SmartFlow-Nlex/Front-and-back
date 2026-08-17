"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/* ══════════════════════════════════════════════════════════════════════════════
   OFFICIAL NLEX STATION DEFINITIONS
   Each station carries: km marker · display name · per-direction access type.
   "toll-barrier" nodes (Bocaue Barrier) are flagged separately from ramp nodes.
══════════════════════════════════════════════════════════════════════════════ */

import { useNlexExits, accessLabel, type NlexExit } from "../../../lib/nlex-exits";

type AccessType   = "Entry Only" | "Exit Only" | "Entry & Exit" | "No Access";
type NodeType     = "interchange" | "toll-barrier";

interface StationDef {
  km:     number;
  name:   string;
  type:   NodeType;
  access: AccessType | null;   // null for toll-barrier nodes
}


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

/** Shared corridor list -> the station shape this component renders. */
function toStations(exits: NlexExit[], dir: "NB" | "SB"): (StationDef & { dir: "NB" | "SB" })[] {
  const rows = exits.map((x) => ({
    km: x.km,
    name: x.exit_name,
    type: x.node_type,
    access: accessLabel(x, dir) as AccessType | null,
    dir,
  }));
  // Northbound runs up the km-posts, southbound back down them.
  return dir === "NB" ? rows : [...rows].reverse();
}

export default function InteractiveRoadMap() {
  // One corridor list for every tab. See lib/nlex-exits.
  const { exits } = useNlexExits();
  const stationsNB = toStations(exits, "NB");
  const stationsSB = toStations(exits, "SB");

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

  /* ─── Tooltip access/type row ─── */
  const renderAccessRow = (station: StationDef & { dir: string }) => {
    if (station.type === "toll-barrier") {
      const operation = station.dir === "NB" ? "ON (Mainline Entry)" : "OFF (Pay & Exit)";
      return (
        <>
          <div className="ds-tooltip-row px-3">
            <span>Type:</span>
            <span style={{ fontWeight: 700, color: "#f59e0b" }}>Mainline Toll Plaza</span>
          </div>
          <div className="ds-tooltip-row px-3">
            <span>Operation:</span>
            <span>{operation}</span>
          </div>
        </>
      );
    }
    return (
      <div className="ds-tooltip-row px-3">
        <span>Access:</span>
        <span>{station.access}</span>
      </div>
    );
  };

  /* ─── Track renderer ─── */
  const renderTrack = (
    title:    string,
    stations: typeof stationsNB | typeof stationsSB,
    isSB:     boolean,
  ) => (
    <div className="ds-track-row">
      <h3 className="ds-track-title">{title}</h3>
      {/* Scroll wrapper: 20 exits with long names do not fit a fixed width. */}
      <div className="ds-track-scroll">
      <div className="ds-roadmap-track">
        {(stations as (StationDef & { dir: string })[]).map((station, i) => {
          const data        = statusByExit.get(statusKey(station.name, station.dir)) ?? CLEAR;
          const isActive    = activeStation === `${station.name}-${station.dir}`;
          const nextStation = stations[i + 1] as (StationDef & { dir: string }) | undefined;
          const total       = stations.length;
          const tooltipAlign =
            i <= 1         ? "tip-left"  :
            i >= total - 2 ? "tip-right" :
            "";

          return (
            <div
              key={`${station.name}-${station.dir}`}
              className="ds-roadmap-stop"
              style={{ "--delay": `${i * 0.05}s` } as React.CSSProperties}
            >
              <div
                className={`ds-roadmap-node ${data.colorClass} ${isActive ? "is-active" : ""}`}
                onMouseEnter={() => setActiveStation(`${station.name}-${station.dir}`)}
                onMouseLeave={() => setActiveStation(null)}
              >
                <span className="ds-node-km">{station.km}KM</span>

                <div className="ds-node-dot hex">
                  <div className="ds-node-pulse" />
                  <HexagonRoad />
                </div>

                <span className="ds-node-name">{station.name}</span>

                {isActive && (
                  <div className={`ds-roadmap-tooltip ${tooltipAlign} bg-white shadow-xl z-50`}>
                    <strong>NODE: {station.name} ({station.dir})</strong>

                    {/* Access / type row — context-aware */}
                    {renderAccessRow(station)}

                    <div className="ds-tooltip-row px-3">
                      <span>Status:</span>
                      <span className={`ds-status-badge ${data.colorClass}`}>{data.status}</span>
                    </div>
                    <div className="ds-tooltip-row px-3">
                      <span>Slowest speed:</span>
                      <span>{data.speed}</span>
                    </div>
                    {data.level != null && (
                      <div className="ds-tooltip-row px-3">
                        <span>Waze jam level:</span>
                        <span>{data.level} of 5</span>
                      </div>
                    )}
                    <div className="ds-tooltip-row px-3">
                      <span>Active jams:</span>
                      <span>{data.jamCount === 0 ? "None reported" : data.jamCount}</span>
                    </div>
                    {nextStation && (
                      <div className="ds-tooltip-row px-3">
                        <span>Next exit:</span>
                        <span>{nextStation.name}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {nextStation && (
                <div className={`ds-roadmap-segment ${data.colorClass}`}>
                  <div className="ds-segment-fill" />
                  <span className="ds-segment-arrow">{isSB ? "<" : ">"}</span>
                        </div>
              )}
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );

  /* ─── Header copy ─── */
  const headerTitle = "Live Corridor Status";

  const headerSub = feedError
    ? "Feed unavailable — is the backend running on port 4000?"
    : feedLoading
      ? "Reading the Waze feed…"
      : corridor?.feed.newestAt
        ? `${corridor.feed.stale ? "Feed may be stale · last" : "Last"} report ${
            corridor.feed.ageMinutes != null && corridor.feed.ageMinutes < 1
              ? "just now"
              : `${corridor.feed.ageMinutes} min ago`
          } · ${corridor.windowMinutes}-min window`
        : "No jam reports on the corridor right now";

  /* ─── Render ─── */
  return (
    <section id="nlex-roadmap" className="ds-roadmap-section dual-track">
      <div className="ds-roadmap-header-row">
        <div className="ds-roadmap-header">
          <h2>
            {headerTitle}
            {corridor?.feed.stale && (
              <span className="ds-demo-badge" title="The Waze ingester has not written a row recently">
                Stale feed
              </span>
            )}
          </h2>
          <p className="ds-roadmap-subtitle">NLEX EXPRESSWAY • METRO MANILA → CENTRAL LUZON</p>
        </div>
        <div className="ds-header-right">
          <div className="ds-roadmap-legend">
            <span className="ds-legend-item"><span className="ds-legend-dot seg-red" /> Congested</span>
            <span className="ds-legend-item"><span className="ds-legend-dot seg-orange" /> Slow</span>
            <span className="ds-legend-item"><span className="ds-legend-dot seg-green" /> Clear</span>
          </div>
          <span className="ds-last-update">{headerSub}</span>
        </div>
      </div>

      <div ref={containerRef} className={`ds-roadmap-container ${isVisible ? "is-visible" : ""}`}>
        {renderTrack("Northbound (NB)", stationsNB, false)}
        {renderTrack("Southbound (SB)", stationsSB, true)}
      </div>

    </section>
  );
}
