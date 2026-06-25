import { 
  CarFront, Cone, ShieldAlert, AlertTriangle, AlertCircle, 
  Clock, ChevronDown, Navigation, ZoomIn, ZoomOut, Search 
} from "lucide-react";
import TrafficMapPanel from "../../../components/maps/TrafficMapPanel";

export default function MapComparisonPage() {
  return (
    <section className="ds-content ds-long">
      <div className="mc-top-bar">
        <h1 className="tab-title">Traffic Map Comparison</h1>
        <div className="mc-search-bar">
          <Search size={16} />
          <input type="text" placeholder="Search exits (e.g., San Fernando)..." />
        </div>
      </div>

      <div className="map-grid mc-map-grid">
        {/* Left Map: Waze Real-Time */}
        <div className="mc-panel-wrapper">
          <TrafficMapPanel
            title="Waze Real-Time Traffic"
            subtitle="Live traffic conditions"
            badge="LIVE"
            endpoint="/api/maps/realtime"
            layerColor="#4a6ff2"
            tone="blue"
          >
            {/* Waze Live Clock Overlay */}
            <div className="mc-live-clock">
              <span className="mc-dot green"></span> LIVE | 11:44:15 PM
            </div>

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
              </div>
            </div>
          </TrafficMapPanel>

          {/* Waze Footer Stats */}
          <div className="mc-footer-stats">
            <div className="mc-stat-item">
              <span className="mc-stat-label">NLEX Exits</span>
              <span className="mc-stat-value blue">26</span>
            </div>
            <div className="mc-stat-item">
              <span className="mc-stat-label">Active Reports</span>
              <span className="mc-stat-value red">5</span>
            </div>
            <div className="mc-stat-item">
              <span className="mc-stat-label">Avg Speed</span>
              <span className="mc-stat-value orange">45 km/h</span>
            </div>
          </div>
        </div>

        {/* Right Map: Forecasted Traffic */}
        <div className="mc-panel-wrapper">
          <TrafficMapPanel
            title="Forecasted Traffic"
            subtitle="Predictive analysis"
            badge="PREDICTED"
            endpoint="/api/maps/forecast?horizon=2h"
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
              <span className="mc-stat-value purple">26</span>
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
