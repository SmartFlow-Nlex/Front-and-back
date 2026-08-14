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

export default function MapComparisonPage() {
  const [activeReports, setActiveReports] = useState(5);
  const [avgSpeed, setAvgSpeed] = useState(45);
  const [timeStr, setTimeStr] = useState("");

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
          <div className="mc-search-bar">
            <Search size={16} />
            <input type="text" placeholder="Search exits (e.g., San Fernando)..." />
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

