import Image from "next/image";
import { Activity, Brain, CarFront, TrendingUp } from "lucide-react";

export default function DashboardHomePage() {
  return (
    <section className="ds-content">
      <article className="ds-hero-card">
        <Image src="/smartflow-hero.png" alt="NLEX tollway" fill className="ds-hero-image" unoptimized />
        <div className="ds-hero-overlay" />
      </article>

      <section className="ds-section-block">
        <h2>SmartFlow System Overview</h2>
        <div className="ds-overview-grid">
          <article className="ds-overview-card">
            <div className="ds-overview-icon tone-blue"><TrendingUp size={20} /></div>
            <h3>Total Stations Monitored</h3>
            <div className="ds-overview-value">8</div>
            <p className="ds-note green">All systems operational</p>
          </article>
          <article className="ds-overview-card">
            <div className="ds-overview-icon tone-green"><CarFront size={20} /></div>
            <h3>Daily Average Traffic</h3>
            <div className="ds-overview-value">125K</div>
            <p className="ds-note blue">vehicles per day</p>
          </article>
          <article className="ds-overview-card">
            <div className="ds-overview-icon tone-purple"><Brain size={20} /></div>
            <h3>AI Prediction Accuracy</h3>
            <div className="ds-overview-value">87%</div>
            <p className="ds-note purple">traffic forecasting</p>
          </article>
          <article className="ds-overview-card">
            <div className="ds-overview-icon tone-orange"><Activity size={20} /></div>
            <h3>Incident Response Time</h3>
            <div className="ds-overview-value">12 min</div>
            <p className="ds-note green">-3 min improvement</p>
          </article>
        </div>
      </section>

      <section className="ds-feature-card">
        <h2>SmartFlow Key Features</h2>
        <div className="ds-feature-grid">
          <div>
            <h3>Real-Time Monitoring</h3>
            <p>Monitor traffic conditions across all NLEX stations in real-time with advanced sensor networks and data analytics.</p>
            <h3>Traffic Simulation</h3>
            <p>Interactive sandbox environment to test different traffic scenarios and optimize lane management strategies.</p>
          </div>
          <div>
            <h3>AI-Powered Predictions</h3>
            <p>Machine learning algorithms analyze historical data to forecast traffic patterns and predict congestion before it occurs.</p>
            <h3>Data Management</h3>
            <p>Upload and analyze traffic datasets to continuously improve prediction models and system performance.</p>
          </div>
          <div>
            <h3>Incident Management</h3>
            <p>Rapid detection and response to incidents with automated alerts and comprehensive incident tracking and analysis.</p>
            <h3>Map Comparison</h3>
            <p>Compare real-time Waze traffic data with AI-generated forecasts to validate prediction accuracy and insights.</p>
          </div>
        </div>
      </section>
    </section>
  );
}
