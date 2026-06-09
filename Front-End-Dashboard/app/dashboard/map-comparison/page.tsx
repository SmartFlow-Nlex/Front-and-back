import TrafficMapPanel from "../../../components/maps/TrafficMapPanel";

export default function MapComparisonPage() {
  return (
    <section className="ds-content ds-long">
      <h1 className="tab-title">Traffic Map Comparison</h1>
      <div className="map-grid">
        <TrafficMapPanel
          title="Waze Real-Time Traffic"
          subtitle="Live traffic conditions"
          badge="LIVE"
          endpoint="/api/maps/realtime"
          layerColor="#4a6ff2"
          tone="blue"
        />
        <TrafficMapPanel
          title="Forecasted Traffic"
          subtitle="Predictive analysis"
          badge="PREDICTED"
          endpoint="/api/maps/forecast?horizon=2h"
          layerColor="#8a36ee"
          tone="purple"
        />
      </div>
      <div className="map-grid">
        <footer className="map-stats map-stats-card"><div><span>NLEX Exits</span><strong>26</strong></div><div><span>Active Reports</span><strong className="bad">5</strong></div><div><span>Avg Speed</span><strong className="warn">45 km/h</strong></div></footer>
        <footer className="map-stats map-stats-card"><div><span>NLEX Exits</span><strong>26</strong></div><div><span>ML Confidence</span><strong className="ok">89%</strong></div><div><span>Forecast Window</span><strong className="purple">2 hrs</strong></div></footer>
      </div>
      <section className="panel"><h2>Comparison Insights</h2><div className="insights-grid"><article className="insight blue"><div><h4>Variance Analysis</h4><p>Current traffic is 15% slower than predicted, indicating higher than expected congestion.</p></div></article><article className="insight green"><div><h4>Model Accuracy</h4><p>The AI model has achieved 87% accuracy in predicting traffic patterns for this route.</p></div></article><article className="insight amber"><div><h4>Recommendations</h4><p>Consider alternative routes during peak hours to avoid predicted congestion zones.</p></div></article></div></section>
    </section>
  );
}
