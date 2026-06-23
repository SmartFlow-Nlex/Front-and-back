"use client";

import { useEffect, useRef, useState } from "react";

/* ─── NLEX Station Data ─── */
const baseStations = [
  { km: 0,  name: "Balintawak" },
  { km: 8,  name: "Mindanao Ave" },
  { km: 12, name: "Valenzuela" },
  { km: 16, name: "Karuhatan" },
  { km: 19, name: "Paso de Blas" },
  { km: 22, name: "Tabang" },
  { km: 25, name: "Bocaue" },
  { km: 29, name: "Marilao" },
  { km: 32, name: "Meycauayan" },
  { km: 37, name: "Marilao North" },
  { km: 40, name: "Pulilan" },
  { km: 43, name: "Calumpit" },
  { km: 48, name: "Apalit" },
  { km: 52, name: "San Fernando" },
  { km: 56, name: "San Fernando South" },
  { km: 60, name: "Angeles/Sindalan" },
];

const stationsNB = baseStations.map(s => ({
  ...s,
  color: ["Balintawak", "Meycauayan"].includes(s.name) ? "red" :
         ["Mindanao Ave", "Valenzuela"].includes(s.name) ? "orange" : "green",
  dir: "NB"
}));

const stationsSB = baseStations.map(s => ({
  ...s,
  name: `SB ${s.name}`,
  color: ["SB Meycauayan", "SB Balintawak"].includes(`SB ${s.name}`) ? "red" :
         ["SB Mindanao Ave", "SB Marilao North"].includes(`SB ${s.name}`) ? "orange" : "green",
  dir: "SB"
}));

/* Mock Traffic Data */
const getTrafficData = (name: string, dir: string) => {
  const isCongested = ["Balintawak", "Meycauayan", "SB Meycauayan", "SB Balintawak"].includes(name);
  const isSlow = ["Mindanao Ave", "Valenzuela", "SB Mindanao Ave", "SB Marilao North"].includes(name);
  
  if (isCongested) return { speed: "15 km/h", status: "CONGESTED (10%)", colorClass: "seg-red" };
  if (isSlow) return { speed: "40 km/h", status: "SLOW (45%)", colorClass: "seg-orange" };
  return { speed: "95 km/h", status: "CLEAR (90%)", colorClass: "seg-green" };
};

const HexagonRoad = () => (
  <svg width="24" height="24" viewBox="0 0 32 32" className="ds-hex-svg">
    <polygon points="16,2 30,10 30,22 16,30 2,22 2,10" fill="none" stroke="currentColor" strokeWidth="2.5" />
    <path d="M12,6 L9,26 M20,6 L23,26 M16,8 L16,12 M16,16 L16,20" stroke="currentColor" strokeWidth="2" strokeDasharray="2 3" />
  </svg>
);

export default function InteractiveRoadMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [activeStation, setActiveStation] = useState<string | null>(null);

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

  const renderTrack = (title: string, stations: typeof stationsNB, isSB: boolean) => (
    <div className="ds-track-row">
      <h3 className="ds-track-title">{title}</h3>
      <div className="ds-roadmap-track">
        {stations.map((station, i) => {
          const data = getTrafficData(station.name, station.dir);
          const isActive = activeStation === station.name;
          const nextStation = stations[i + 1];

          return (
            <div key={station.name} className="ds-roadmap-stop" style={{ "--delay": `${i * 0.05}s` } as React.CSSProperties}>
              <div
                className={`ds-roadmap-node ${data.colorClass} ${isActive ? "is-active" : ""}`}
                onMouseEnter={() => setActiveStation(station.name)}
                onMouseLeave={() => setActiveStation(null)}
              >
                <span className="ds-node-km">{station.km}KM</span>
                
                <div className="ds-node-dot hex">
                  <div className="ds-node-pulse" />
                  <HexagonRoad />
                </div>

                <span className="ds-node-name">{station.name}</span>

                {isActive && (
                  <div className="ds-roadmap-tooltip">
                    <strong>NODE: {station.name.replace("SB ", "")} ({station.dir})</strong>
                    <div className="ds-tooltip-row"><span>Status:</span><span className={`ds-status-badge ${data.colorClass}`}>{data.status}</span></div>
                    <div className="ds-tooltip-row"><span>Avg. Speed:</span><span>{data.speed}</span></div>
                    <div className="ds-tooltip-row"><span>Incidents:</span><span>None</span></div>
                    {nextStation && <div className="ds-tooltip-row"><span>Next KM:</span><span>5 min ({nextStation.name.replace("SB ", "")})</span></div>}
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

  return (
    <section id="nlex-roadmap" className="ds-roadmap-section dual-track">
      <div className="ds-roadmap-header-row">
        <div className="ds-roadmap-header">
          <h2>Live Traffic Map</h2>
          <p className="ds-roadmap-subtitle">NLEX EXPRESSWAY • METRO MANILA → CENTRAL LUZON</p>
        </div>
        <div className="ds-header-right">
          <div className="ds-roadmap-legend">
            <span className="ds-legend-item"><span className="ds-legend-dot seg-red" /> Congested</span>
            <span className="ds-legend-item"><span className="ds-legend-dot seg-orange" /> Slow</span>
            <span className="ds-legend-item"><span className="ds-legend-dot seg-green" /> Clear</span>
          </div>
          <span className="ds-last-update">Last Update: {new Date().toLocaleTimeString()}</span>
        </div>
      </div>

      <div ref={containerRef} className={`ds-roadmap-container ${isVisible ? "is-visible" : ""}`}>
        {renderTrack("Northbound (NB)", stationsNB, false)}
        {renderTrack("South Track: Southbound (SB)", stationsSB, true)}
      </div>

      <div className="ds-roadmap-controls">
        <div className="ds-control-left">
          <span className="ds-control-label">PREDICTION TIME:</span>
          <span className="ds-control-val active">LIVE</span>
          <span className="ds-control-val">| +1 HR</span>
          <span className="ds-control-val">| +2 HR</span>
          <div className="ds-slider-track">
            <div className="ds-slider-thumb" />
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
