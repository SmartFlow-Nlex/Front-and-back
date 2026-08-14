"use client";

import { useState, useEffect } from "react";
import { 
  CarFront, Cone, ShieldAlert, AlertTriangle, AlertCircle, 
  Clock, ChevronDown, Navigation, ZoomIn, ZoomOut, Search,
  Milestone, Map
} from "lucide-react";
import type { Feature } from "geojson";
import TrafficMapPanel from "../../../components/maps/TrafficMapPanel";
import PageHeader from "../../../components/dashboard/PageHeader";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type ExitHit = { exit_id: number; exit_name: string; latitude: number; longitude: number };

export default function MapComparisonPage() {
  const [activeReports, setActiveReports] = useState(5);
  const [avgSpeed, setAvgSpeed] = useState(45);
  const [timeStr, setTimeStr] = useState("");

  // Exit search — the box used to be a bare input with no handler.
  const [exitQuery, setExitQuery] = useState("");
  const [exitHits, setExitHits] = useState<ExitHit[]>([]);
  const [exitOpen, setExitOpen] = useState(false);

  useEffect(() => {
    const q = exitQuery.trim();
    if (q.length < 2) {
      setExitHits([]);
      return;
    }
    let cancelled = false;
    // Debounced so a fast typist does not fire a request per keystroke.
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`${BACKEND}/api/map-comparison/exits?query=${encodeURIComponent(q)}`);
        const j = await r.json();
        if (!cancelled) setExitHits(Array.isArray(j.data) ? j.data : []);
      } catch {
        if (!cancelled) setExitHits([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [exitQuery]);

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
          <div className="mc-search-bar" style={{ position: "relative" }}>
            <Search size={16} />
            <input
              type="text"
              placeholder="Search exits (e.g., San Fernando)..."
              value={exitQuery}
              onChange={(e) => {
                setExitQuery(e.target.value);
                setExitOpen(true);
              }}
              onFocus={() => setExitOpen(true)}
              onBlur={() => setTimeout(() => setExitOpen(false), 150)}
              aria-label="Search NLEX exits"
            />
            {exitOpen && exitQuery.trim().length >= 2 && (
              <ul
                style={{
                  position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 30,
                  margin: 0, padding: "4px", listStyle: "none", maxHeight: "260px", overflowY: "auto",
                  background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef",
                  borderRadius: "10px", boxShadow: "0 8px 24px rgba(15,23,42,0.12)",
                }}
              >
                {exitHits.length === 0 ? (
                  <li style={{ padding: "10px 12px", fontSize: "0.85rem", color: "#64748b" }}>
                    No exit matches “{exitQuery.trim()}”
                  </li>
                ) : (
                  exitHits.map((x) => (
                    <li key={x.exit_id}>
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setExitQuery(x.exit_name);
                          setExitOpen(false);
                          window.dispatchEvent(
                            new CustomEvent("nlex:flyto", {
                              detail: { lng: Number(x.longitude), lat: Number(x.latitude), name: x.exit_name },
                            })
                          );
                        }}
                        style={{
                          display: "flex", width: "100%", alignItems: "baseline", gap: "8px",
                          padding: "8px 12px", border: "none", background: "transparent",
                          textAlign: "left", cursor: "pointer", borderRadius: "6px", fontSize: "0.88rem",
                        }}
                      >
                        <span style={{ fontWeight: 600, color: "#0f172a" }}>{x.exit_name}</span>
                        <span style={{ fontSize: "0.72rem", color: "#94a3b8", marginLeft: "auto" }}>
                          Exit {x.exit_id}
                        </span>
                      </button>
                    </li>
                  ))
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
              </div>
              <div className="mc-legend-section">
                <h4>Waze Reports</h4>
                <div className="mc-report-row"><span className="mc-icon-bg red"><CarFront size={12} /></span> Traffic Jam</div>
                <div className="mc-report-row"><span className="mc-icon-bg orange"><Cone size={12} /></span> Construction</div>
                <div className="mc-report-row"><span className="mc-icon-bg blue"><ShieldAlert size={12} /></span> Police</div>
                <div className="mc-report-row"><span className="mc-icon-bg darkred"><AlertTriangle size={12} /></span> Accident</div>
                <div className="mc-report-row"><span className="mc-icon-bg yellow"><AlertCircle size={12} /></span> Hazard</div>
                <div className="mc-report-row"><span className="mc-icon-bg cyan" style={{ backgroundColor: "#06b6d4" }}><Milestone size={12} /></span> Toll Plaza</div>
                <div className="mc-report-row"><span className="mc-density-line" style={{ backgroundColor: "#14b8a6" }}></span> Entry / Exit Ramp</div>
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
    </section>
  );
}

