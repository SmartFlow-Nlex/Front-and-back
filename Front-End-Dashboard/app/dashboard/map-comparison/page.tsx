"use client";

import { useState, useEffect } from "react";
import { AlertCircle, AlertTriangle, CarFront, ChevronDown, Clock, Cone, Map, Maximize2, Milestone, Navigation, Search, ShieldAlert, ZoomIn, ZoomOut } from "lucide-react";
import type { Feature } from "geojson";
import TrafficMapPanel from "../../../components/maps/TrafficMapPanel";
import WazeLiveModal from "../../../components/maps/WazeLiveModal";
import PageHeader from "../../../components/dashboard/PageHeader";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

import { displayExitName, useNlexExits, type NlexExit } from "../../../lib/nlex-exits";

type ExitHit = NlexExit;

export default function MapComparisonPage() {
  const [wazeMax, setWazeMax] = useState(false);
  const [activeReports, setActiveReports] = useState(5);
  const [avgSpeed, setAvgSpeed] = useState(45);
  const [timeStr, setTimeStr] = useState("");

  // Exit picker. The whole corridor is loaded once and shown as a dropdown in
  // geographic order (Balintawak in the south through to Sta. Ines in the
  // north), so the list itself tells you where along NLEX you are.
  // Same corridor list as the dashboard road map, AI sandbox and maintenance.
  const { exits } = useNlexExits();
  const [selectedExit, setSelectedExit] = useState<string>("");
  const [exitOpen, setExitOpen] = useState(false);

  const flyToExit = (x: ExitHit) => {
    setSelectedExit(x.exit_name);
    setExitOpen(false);
    window.dispatchEvent(
      new CustomEvent("nlex:flyto", {
        detail: { lng: Number(x.longitude), lat: Number(x.latitude), name: x.exit_name },
      })
    );
  };

  const resetView = () => {
    setSelectedExit("");
    setExitOpen(false);
    window.dispatchEvent(new CustomEvent("nlex:resetview"));
  };

  // Live running clock
  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      setTimeStr(
        now.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        })
      );
    };
    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, []);

  // Poll real-time Waze data to update stats
  useEffect(() => {
    async function fetchStats() {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000"}/api/map-comparison/real-time`, { cache: "no-store" });
        const geojson = await response.json();
        if (geojson && geojson.features) {
          const features = geojson.features as Feature[];

          // Count Waze active alerts (points)
          const alertCount = features.filter(
            (f: Feature) => f.properties && f.properties.feature_type === "alert"
          ).length;

          // Calculate average speed from jams
          const jams = features.filter(
            (f: Feature) =>
              f.properties &&
              f.properties.feature_type === "jam" &&
              Number(f.properties.speed) > 0
          );
          
          let averageSpeed = 45; // default fallback if no jams are active
          if (jams.length > 0) {
            const sumSpeed = jams.reduce(
              (sum: number, j: Feature) => sum + Number(j.properties?.speed || 0),
              0
            );
            averageSpeed = Math.round(sumSpeed / jams.length);
          }

          setActiveReports(alertCount);
          setAvgSpeed(averageSpeed);
        }
      } catch (error) {
        console.error("Failed to fetch live stats from real-time Waze endpoint:", error);
      }
    }

    fetchStats();
    // Poll every 15 seconds to match Mapbox layer refresh
    const interval = setInterval(fetchStats, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="ds-content ds-long">
      <PageHeader
        icon={Map}
        title="Traffic Map Comparison"
        subtitle="Side-by-side live traffic sources across the NLEX corridor"
        actions={
          <div className="mc-search-bar" style={{ position: "relative", cursor: "pointer" }}>
            <Milestone size={16} />
            <button
              type="button"
              onClick={() => setExitOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={exitOpen}
              style={{
                flex: 1, display: "flex", alignItems: "center", gap: "8px",
                border: "none", background: "transparent", cursor: "pointer",
                font: "inherit", color: selectedExit ? "#0f172a" : "#94a3b8",
                textAlign: "left", padding: 0,
              }}
            >
              {selectedExit || "Jump to exit…"}
              <ChevronDown size={14} style={{ marginLeft: "auto", flexShrink: 0, color: "#64748b" }} />
            </button>

            {exitOpen && (
              <ul
                role="listbox"
                style={{
                  position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 30,
                  margin: 0, padding: "4px", listStyle: "none", maxHeight: "320px", overflowY: "auto",
                  background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef",
                  borderRadius: "10px", boxShadow: "0 8px 24px rgba(15,23,42,0.12)",
                }}
              >
                <li>
                  <button
                    onClick={resetView}
                    style={{
                      display: "flex", width: "100%", alignItems: "center", gap: "8px",
                      padding: "8px 12px", border: "none", background: "transparent",
                      textAlign: "left", cursor: "pointer", borderRadius: "6px",
                      fontSize: "0.85rem", color: "#64748b", borderBottom: "1px solid #eef2f7",
                    }}
                  >
                    Whole corridor
                  </button>
                </li>
                {exits.length === 0 ? (
                  <li style={{ padding: "10px 12px", fontSize: "0.85rem", color: "#64748b" }}>
                    Exit list unavailable
                  </li>
                ) : (
                  exits.map((x) => {
                    const on = x.exit_name === selectedExit;
                    return (
                      <li key={x.exit_id} role="option" aria-selected={on}>
                        <button
                          onClick={() => flyToExit(x)}
                          style={{
                            display: "flex", width: "100%", alignItems: "baseline", gap: "8px",
                            padding: "8px 12px", border: "none", cursor: "pointer",
                            borderRadius: "6px", fontSize: "0.88rem", textAlign: "left",
                            background: on ? "#eef2fb" : "transparent",
                            fontWeight: on ? 700 : 500, color: "#0f172a",
                          }}
                        >
                          <span style={{
                            fontSize: "0.7rem", color: "var(--text-muted)", minWidth: "1.4rem",
                            fontVariantNumeric: "tabular-nums",
                          }}>{x.exit_id}</span>
                          {displayExitName(x.exit_name)}
                          <span style={{ marginLeft: "auto", fontSize: "0.72rem", color: "var(--text-muted)" }}>
                            Km {x.km}
                          </span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            )}
          </div>
        }
      />

      <div className="map-grid mc-map-grid">
        {/* Left Map: Waze Real-Time */}
        <div className="mc-panel-wrapper">
          <TrafficMapPanel
            title="Waze Real-Time Traffic"
            subtitle="Live traffic conditions"
            badge={
              <>
                <i className="mc-dot green" style={{ display: "inline-block", marginRight: "6px", verticalAlign: "middle" }}></i>
                LIVE | {timeStr || "Loading..."}
                <button
                  type="button"
                  className="mc-maximise"
                  style={{ marginLeft: 10 }}
                  onClick={() => setWazeMax(true)}
                >
                  <Maximize2 size={13} /> Expand
                </button>
              </>
            }
            endpoint={`${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000"}/api/map-comparison/real-time`}
            layerColor="#4a6ff2"
            tone="blue"
          >

            {/* Waze Legend Overlay */}
            <div className="mc-legend-card waze-legend">
              <div className="mc-legend-section">
                <h4>Traffic Density</h4>
                <div className="mc-density-row"><span className="mc-density-line green"></span> Light</div>
                <div className="mc-density-row"><span className="mc-density-line yellow"></span> Moderate</div>
                <div className="mc-density-row"><span className="mc-density-line orange"></span> Heavy</div>
                <div className="mc-density-row"><span className="mc-density-line red"></span> Severe</div>
                <div className="mc-density-row"><span className="mc-density-line nodata"></span> Not reported</div>
              </div>
              {/* Both directions are now drawn, so the reader needs to know
                  which ribbon is which. The chevrons on the map say it too, but
                  only once you are zoomed in far enough to read them. */}
              <div className="mc-legend-section">
                <h4>Direction</h4>
                <div className="mc-density-row"><span className="mc-dir-chip">&#10095;</span> Northbound &middot; to Central Luzon</div>
                <div className="mc-density-row"><span className="mc-dir-chip flip">&#10095;</span> Southbound &middot; to Metro Manila</div>
              </div>
              <div className="mc-legend-section">
                <h4>Waze Reports</h4>
                <div className="mc-report-row"><span className="mc-icon-bg red"><CarFront size={12} /></span> Traffic Jam</div>
                <div className="mc-report-row"><span className="mc-icon-bg orange"><Cone size={12} /></span> Construction</div>
                <div className="mc-report-row"><span className="mc-icon-bg blue"><ShieldAlert size={12} /></span> Police</div>
                <div className="mc-report-row"><span className="mc-icon-bg darkred"><AlertTriangle size={12} /></span> Accident</div>
                <div className="mc-report-row"><span className="mc-icon-bg yellow"><AlertCircle size={12} /></span> Hazard</div>
                <div className="mc-report-row"><span className="mc-icon-bg cyan" style={{ backgroundColor: "#06b6d4" }}><Milestone size={12} /></span> Toll Plaza</div>
              </div>
            </div>
          </TrafficMapPanel>

          {/* Waze Footer Stats */}
          <div className="mc-footer-stats">
            <div className="mc-stat-item">
              <span className="mc-stat-label">Toll Plazas</span>
              <span className="mc-stat-value blue">20</span>
            </div>
            <div className="mc-stat-item">
              <span className="mc-stat-label">Active Reports</span>
              <span className="mc-stat-value red">{activeReports}</span>
            </div>
            <div className="mc-stat-item">
              <span className="mc-stat-label">Avg Speed</span>
              <span className="mc-stat-value orange">{avgSpeed} km/h</span>
            </div>
          </div>
        </div>

        {/* Right Map: Forecasted Traffic */}
        <div className="mc-panel-wrapper">
          <TrafficMapPanel
            title="Forecasted Traffic"
            subtitle="Predictive analysis"
            badge="PREDICTED"
            endpoint={`${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000"}/api/map-comparison/forecast`}
            layerColor="#a855f7"
            tone="purple"
          >
            {/* Forecast Controls Overlay */}
            <div className="mc-forecast-controls">
              <div className="mc-control-dropdown">
                <Clock size={14} className="mc-purple-text" /> Forecast Time
                <div className="mc-select-wrapper">
                  <select><option>+30 minutes</option></select>
                  <ChevronDown size={14} />
                </div>
              </div>
              <button className="mc-icon-btn"><Navigation size={18} className="mc-purple-text" /></button>
              <div className="mc-zoom-group">
                <button className="mc-icon-btn"><ZoomIn size={18} className="mc-purple-text" /></button>
                <button className="mc-icon-btn"><ZoomOut size={18} className="mc-purple-text" /></button>
              </div>
            </div>

            {/* Forecast Legend Overlay */}
            <div className="mc-legend-card forecast-legend">
              <div className="mc-legend-section">
                <h4><span className="mc-dot purple"></span> AI Prediction Layers</h4>
                <p className="mc-sub-label">Travel Time Zones</p>
                <div className="mc-density-row"><span className="mc-density-box p-15"></span> 15 min</div>
                <div className="mc-density-row"><span className="mc-density-box p-30"></span> 30 min</div>
                <div className="mc-density-row"><span className="mc-density-box p-60"></span> 60 min</div>
              </div>
              <div className="mc-legend-section mt-3">
                <p className="mc-sub-label">Predicted Congestion</p>
                <div className="mc-density-row"><span className="mc-density-line p-low"></span> Low</div>
                <div className="mc-density-row"><span className="mc-density-line p-med"></span> Medium</div>
                <div className="mc-density-row"><span className="mc-density-line p-high"></span> High</div>
              </div>
            </div>
          </TrafficMapPanel>

          {/* Forecast Footer Stats */}
          <div className="mc-footer-stats">
            <div className="mc-stat-item">
              <span className="mc-stat-label">NLEX Exits</span>
              <span className="mc-stat-value purple">20</span>
            </div>
            <div className="mc-stat-item">
              <span className="mc-stat-label">ML Confidence</span>
              <span className="mc-stat-value green">89%</span>
            </div>
            <div className="mc-stat-item">
              <span className="mc-stat-label">Forecast Window</span>
              <span className="mc-stat-value purple">30 min</span>
            </div>
          </div>
        </div>

      </div>
      <WazeLiveModal open={wazeMax} onClose={() => setWazeMax(false)} />
    </section>
  );
}

