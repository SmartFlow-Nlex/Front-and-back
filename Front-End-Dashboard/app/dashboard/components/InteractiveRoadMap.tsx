"use client";

import { useEffect, useRef, useState } from "react";

/* ══════════════════════════════════════════════════════════════════════════════
   OFFICIAL NLEX STATION DEFINITIONS
   Each station carries: km marker · display name · per-direction access type.
   "toll-barrier" nodes (Bocaue Barrier) are flagged separately from ramp nodes.
══════════════════════════════════════════════════════════════════════════════ */

type AccessType   = "Entry Only" | "Exit Only" | "Entry & Exit";
type NodeType     = "interchange" | "toll-barrier";

interface StationDef {
  km:     number;
  name:   string;
  type:   NodeType;
  access: AccessType | null;   // null for toll-barrier nodes
}

/** NB — Balintawak (0 km) → Angeles (83 km) */
const stationsNB: (StationDef & { dir: "NB" })[] = [
  { km:  0, name: "Balintawak",          type: "interchange",  access: "Entry Only",    dir: "NB" },
  { km:  8, name: "Karuhatan",           type: "interchange",  access: "Entry Only",    dir: "NB" },
  { km: 12, name: "Mindanao Ave",        type: "interchange",  access: "Entry Only",    dir: "NB" },
  { km: 16, name: "Paso de Blas",        type: "interchange",  access: "Entry & Exit",  dir: "NB" },
  { km: 22, name: "Meycauayan",          type: "interchange",  access: "Entry & Exit",  dir: "NB" },
  { km: 27, name: "Marilao",             type: "interchange",  access: "Entry & Exit",  dir: "NB" },
  { km: 33, name: "Bocaue Interchange",  type: "interchange",  access: "Entry & Exit",  dir: "NB" },
  { km: 35, name: "Bocaue Barrier",      type: "toll-barrier", access: null,            dir: "NB" },
  { km: 37, name: "Tambubong",           type: "interchange",  access: "Entry & Exit",  dir: "NB" },
  { km: 40, name: "Tabang Guiguinto",    type: "interchange",  access: "Exit Only",     dir: "NB" },
  { km: 44, name: "Balagtas",            type: "interchange",  access: "Entry & Exit",  dir: "NB" },
  { km: 50, name: "Pulilan",             type: "interchange",  access: "Entry & Exit",  dir: "NB" },
  { km: 62, name: "San Simon",           type: "interchange",  access: "Entry & Exit",  dir: "NB" },
  { km: 73, name: "San Fernando",        type: "interchange",  access: "Entry & Exit",  dir: "NB" },
  { km: 83, name: "Angeles",             type: "interchange",  access: "Entry & Exit",  dir: "NB" },
];

/** SB — Angeles (83 km) → Balintawak (0 km) */
const stationsSB: (StationDef & { dir: "SB" })[] = [
  { km: 83, name: "Angeles",             type: "interchange",  access: "Entry & Exit",  dir: "SB" },
  { km: 73, name: "San Fernando",        type: "interchange",  access: "Entry & Exit",  dir: "SB" },
  { km: 62, name: "San Simon",           type: "interchange",  access: "Entry & Exit",  dir: "SB" },
  { km: 50, name: "Pulilan",             type: "interchange",  access: "Entry & Exit",  dir: "SB" },
  { km: 44, name: "Balagtas",            type: "interchange",  access: "Entry Only",    dir: "SB" },
  { km: 40, name: "Tabang Guiguinto",    type: "interchange",  access: "Entry Only",    dir: "SB" },
  { km: 37, name: "Tambubong",           type: "interchange",  access: "Entry & Exit",  dir: "SB" },
  { km: 35, name: "Bocaue Barrier",      type: "toll-barrier", access: null,            dir: "SB" },
  { km: 33, name: "Bocaue Interchange",  type: "interchange",  access: "Entry & Exit",  dir: "SB" },
  { km: 27, name: "Marilao",             type: "interchange",  access: "Entry & Exit",  dir: "SB" },
  { km: 22, name: "Meycauayan",          type: "interchange",  access: "Entry & Exit",  dir: "SB" },
  { km: 16, name: "Paso de Blas",        type: "interchange",  access: "Entry & Exit",  dir: "SB" },
  { km:  8, name: "Karuhatan",           type: "interchange",  access: "Entry & Exit",  dir: "SB" },
  { km: 12, name: "Mindanao Ave",        type: "interchange",  access: "Entry & Exit",  dir: "SB" },
  { km:  0, name: "Balintawak",          type: "interchange",  access: "Exit Only",     dir: "SB" },
];

/* ══════════════════════════════════════════════════════════════════════════════
   TRAFFIC STATE TYPES & LEVEL MAP
══════════════════════════════════════════════════════════════════════════════ */

type TrafficLevel  = "red" | "orange" | "green";
type TrafficRecord = { speed: string; status: string; colorClass: string };

const LEVEL_MAP: Record<TrafficLevel, TrafficRecord> = {
  red:    { speed: "15 km/h", status: "CONGESTED (10%)", colorClass: "seg-red"    },
  orange: { speed: "40 km/h", status: "SLOW (45%)",      colorClass: "seg-orange" },
  green:  { speed: "95 km/h", status: "CLEAR (90%)",     colorClass: "seg-green"  },
};

/* ══════════════════════════════════════════════════════════════════════════════
   THREE MOCK DATASETS  (key = "stationName-DIR")
══════════════════════════════════════════════════════════════════════════════ */

type DatasetKey = string;
type Dataset    = Record<DatasetKey, TrafficLevel>;

/** SLOT 0 — LIVE */
const LIVE_DATA: Dataset = {
  /* NB */
  "Balintawak-NB":         "red",
  "Karuhatan-NB":          "orange",
  "Mindanao Ave-NB":       "orange",
  "Paso de Blas-NB":       "green",
  "Meycauayan-NB":         "red",
  "Marilao-NB":            "green",
  "Bocaue Interchange-NB": "green",
  "Bocaue Barrier-NB":     "orange",   // toll plaza — traffic slows to pay
  "Tambubong-NB":          "green",
  "Tabang Guiguinto-NB":   "green",
  "Balagtas-NB":           "green",
  "Pulilan-NB":            "green",
  "San Simon-NB":          "green",
  "San Fernando-NB":       "green",
  "Angeles-NB":            "green",
  /* SB */
  "Angeles-SB":            "green",
  "San Fernando-SB":       "green",
  "San Simon-SB":          "green",
  "Pulilan-SB":            "green",
  "Balagtas-SB":           "green",
  "Tabang Guiguinto-SB":   "green",
  "Tambubong-SB":          "green",
  "Bocaue Barrier-SB":     "orange",   // toll collection point
  "Bocaue Interchange-SB": "green",
  "Marilao-SB":            "orange",
  "Meycauayan-SB":         "red",
  "Paso de Blas-SB":       "green",
  "Karuhatan-SB":          "green",
  "Mindanao Ave-SB":       "orange",
  "Balintawak-SB":         "red",
};

/** SLOT 1 — +1 HR forecast: congestion spreads toward metro, toll backs up */
const PLUS1HR_DATA: Dataset = {
  /* NB */
  "Balintawak-NB":         "orange",   // easing
  "Karuhatan-NB":          "red",      // building
  "Mindanao Ave-NB":       "red",
  "Paso de Blas-NB":       "orange",   // new slow
  "Meycauayan-NB":         "red",      // still heavy
  "Marilao-NB":            "orange",   // spreading
  "Bocaue Interchange-NB": "green",
  "Bocaue Barrier-NB":     "red",      // toll queue growing
  "Tambubong-NB":          "orange",
  "Tabang Guiguinto-NB":   "green",
  "Balagtas-NB":           "green",
  "Pulilan-NB":            "green",
  "San Simon-NB":          "green",
  "San Fernando-NB":       "green",
  "Angeles-NB":            "green",
  /* SB */
  "Angeles-SB":            "green",
  "San Fernando-SB":       "green",
  "San Simon-SB":          "green",
  "Pulilan-SB":            "green",
  "Balagtas-SB":           "orange",   // slow build
  "Tabang Guiguinto-SB":   "orange",
  "Tambubong-SB":          "green",
  "Bocaue Barrier-SB":     "red",      // heavy toll queue
  "Bocaue Interchange-SB": "orange",   // spill-back
  "Marilao-SB":            "red",
  "Meycauayan-SB":         "red",
  "Paso de Blas-SB":       "orange",
  "Karuhatan-SB":          "orange",
  "Mindanao Ave-SB":       "red",
  "Balintawak-SB":         "red",
};

/** SLOT 2 — +2 HR forecast: NB clears, SB hits evening peak */
const PLUS2HR_DATA: Dataset = {
  /* NB */
  "Balintawak-NB":         "green",    // cleared
  "Karuhatan-NB":          "orange",   // residual
  "Mindanao Ave-NB":       "orange",
  "Paso de Blas-NB":       "green",
  "Meycauayan-NB":         "orange",   // easing
  "Marilao-NB":            "green",
  "Bocaue Interchange-NB": "green",
  "Bocaue Barrier-NB":     "green",    // toll queue cleared
  "Tambubong-NB":          "green",
  "Tabang Guiguinto-NB":   "green",
  "Balagtas-NB":           "green",
  "Pulilan-NB":            "green",
  "San Simon-NB":          "green",
  "San Fernando-NB":       "green",
  "Angeles-NB":            "green",
  /* SB */
  "Angeles-SB":            "green",
  "San Fernando-SB":       "green",
  "San Simon-SB":          "green",
  "Pulilan-SB":            "green",
  "Balagtas-SB":           "red",      // evening exodus
  "Tabang Guiguinto-SB":   "orange",
  "Tambubong-SB":          "orange",
  "Bocaue Barrier-SB":     "orange",
  "Bocaue Interchange-SB": "red",      // backed up
  "Marilao-SB":            "red",
  "Meycauayan-SB":         "red",
  "Paso de Blas-SB":       "red",      // worst of day
  "Karuhatan-SB":          "orange",
  "Mindanao Ave-SB":       "red",
  "Balintawak-SB":         "red",
};

const DATASETS: [Dataset, Dataset, Dataset] = [LIVE_DATA, PLUS1HR_DATA, PLUS2HR_DATA];

function getTrafficData(name: string, dir: string, slot: 0 | 1 | 2): TrafficRecord {
  const level: TrafficLevel = DATASETS[slot][`${name}-${dir}`] ?? "green";
  return LEVEL_MAP[level];
}

/* ══════════════════════════════════════════════════════════════════════════════
   SVG ICON
══════════════════════════════════════════════════════════════════════════════ */

const HexagonRoad = () => (
  <svg width="24" height="24" viewBox="0 0 32 32" className="ds-hex-svg">
    <polygon points="16,2 30,10 30,22 16,30 2,22 2,10" fill="none" stroke="currentColor" strokeWidth="2.5" />
    <path d="M12,6 L9,26 M20,6 L23,26 M16,8 L16,12 M16,16 L16,20" stroke="currentColor" strokeWidth="2" strokeDasharray="2 3" />
  </svg>
);

/* ══════════════════════════════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════════════════════════════ */

const SLOT_LABELS    = ["LIVE", "+1 HR", "+2 HR"] as const;
const SLOT_THUMB_LEFT = ["0%", "50%", "100%"]    as const;

/* ══════════════════════════════════════════════════════════════════════════════
   COMPONENT
══════════════════════════════════════════════════════════════════════════════ */

export default function InteractiveRoadMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible,       setIsVisible]       = useState(false);
  const [activeStation,   setActiveStation]   = useState<string | null>(null);
  const [predictionSlot,  setPredictionSlot]  = useState<0 | 1 | 2>(0);

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
          <div className="ds-tooltip-row">
            <span>Type:</span>
            <span style={{ fontWeight: 700, color: "#f59e0b" }}>Mainline Toll Plaza</span>
          </div>
          <div className="ds-tooltip-row">
            <span>Operation:</span>
            <span>{operation}</span>
          </div>
        </>
      );
    }
    return (
      <div className="ds-tooltip-row">
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
      <div className="ds-roadmap-track">
        {(stations as (StationDef & { dir: string })[]).map((station, i) => {
          const data        = getTrafficData(station.name, station.dir, predictionSlot);
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
                  <div className={`ds-roadmap-tooltip ${tooltipAlign}`}>
                    <strong>NODE: {station.name} ({station.dir})</strong>

                    {/* Access / type row — context-aware */}
                    {renderAccessRow(station)}

                    <div className="ds-tooltip-row">
                      <span>Status:</span>
                      <span className={`ds-status-badge ${data.colorClass}`}>{data.status}</span>
                    </div>
                    <div className="ds-tooltip-row">
                      <span>Avg. Speed:</span>
                      <span>{data.speed}</span>
                    </div>
                    <div className="ds-tooltip-row">
                      <span>Incidents:</span>
                      <span>None</span>
                    </div>
                    {nextStation && (
                      <div className="ds-tooltip-row">
                        <span>Next KM:</span>
                        <span>5 min ({nextStation.name})</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {nextStation && (
                <div className={`ds-roadmap-segment ${data.colorClass}`}>
                  <div className="ds-segment-fill" />
                  <span className="ds-segment-arrow">{isSB ? "<" : ">"}</span>
                  {isSB && <span className="ds-segment-time">5 min</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  /* ─── Header copy ─── */
  const headerTitle = predictionSlot === 0
    ? "Live Traffic Status"
    : `Predicted Traffic — ${SLOT_LABELS[predictionSlot]}`;

  const headerSub = predictionSlot === 0
    ? `Last Update: ${new Date().toLocaleTimeString()}`
    : `Forecast generated: ${new Date().toLocaleTimeString()}`;

  /* ─── Render ─── */
  return (
    <section id="nlex-roadmap" className="ds-roadmap-section dual-track">
      <div className="ds-roadmap-header-row">
        <div className="ds-roadmap-header">
          <h2>{headerTitle}</h2>
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

      <div className="ds-roadmap-controls">
        <div className="ds-control-left">
          <span className="ds-control-label">PREDICTION TIME:</span>

          {SLOT_LABELS.map((label, idx) => (
            <span
              key={label}
              className={`ds-control-val${predictionSlot === idx ? " active" : ""}`}
              onClick={() => setPredictionSlot(idx as 0 | 1 | 2)}
              style={{ cursor: "pointer" }}
            >
              {idx > 0 && "| "}{label}
            </span>
          ))}

          <div className="ds-slider-track">
            <div
              className="ds-slider-thumb"
              style={{
                left: SLOT_THUMB_LEFT[predictionSlot],
                transform: `translateX(${predictionSlot === 0 ? "0" : predictionSlot === 1 ? "-50%" : "-100%"}) translateY(-50%)`,
                transition: "left 0.3s ease",
              }}
            />
          </div>
        </div>

        <div className="ds-control-right">
          <button className="ds-toggle-btn active">NB <span className="ds-dot green" /></button>
          <button className="ds-toggle-btn">SB <span className="ds-dot red" /></button>
        </div>
      </div>
    </section>
  );
}
