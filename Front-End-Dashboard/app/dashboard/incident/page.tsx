"use client";

import { useState, useEffect } from "react";
import { AlertTriangle, Clock3, Lightbulb, MapPin, Radar, Siren } from "lucide-react";
import type { EChartsOption } from "echarts";
import DashboardChart from "../../../components/dashboard/DashboardChart";
import PredictiveIncidentChart from "../../../components/dashboard/PredictiveIncidentChart";

export default function IncidentPage() {
  const [activeTab, setActiveTab] = useState("Descriptive");
  const [incidentData, setIncidentData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("http://localhost:4000/api/incident/summary");
        const json = await res.json();
        if (json.success) {
          setIncidentData(json.data);
        }
      } catch (err) {
        console.error("Failed to fetch incident summary", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) return <div style={{ padding: 40, textAlign: "center" }}>Loading incident analytics...</div>;
  if (!incidentData) return <div style={{ padding: 40, textAlign: "center" }}>Failed to load incident data.</div>;

  const { counts, avgClearance, causes, weather, severity, stalledCauses, violations } = incidentData;

  // Formatting for cards
  const totalIncidents = counts 
    ? Number(counts.road_crashes) + Number(counts.motorcycle_crashes) + Number(counts.stalled_vehicles) 
    : 0;

  const clearanceMins = avgClearance || 0;
  
  const severeIncidents = severity?.find((s: any) => s.severity === "Severe")?.count || 0;
  const severeRate = totalIncidents > 0 ? ((Number(severeIncidents) / totalIncidents) * 100).toFixed(1) : "0.0";

  const totalApprehensions = counts ? Number(counts.apprehensions) : 0;
  const proactiveRate = (totalApprehensions + totalIncidents) > 0 
    ? ((totalApprehensions / (totalApprehensions + totalIncidents)) * 100).toFixed(0)
    : "0";

  // Mock trend data for charts since we don't have historical months in DB summary yet
  const months = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
  
  const clearanceOption: EChartsOption = {
    grid: { left: 46, right: 20, top: 20, bottom: 36 },
    xAxis: { type: "category", data: months },
    yAxis: { type: "value" },
    tooltip: { trigger: "axis" },
    // Fill with current average to show it on the chart
    series: [{ type: "line", data: Array(6).fill(clearanceMins), smooth: true, symbolSize: 9, lineStyle: { width: 3, color: "#29b471" } }],
  };

  const topViolations = violations?.slice(0, 5) || [];
  const enforcementOption: EChartsOption = {
    grid: { left: 140, right: 20, top: 20, bottom: 26 },
    xAxis: { type: "value" },
    yAxis: { type: "category", data: topViolations.map((v: any) => v.violation.length > 20 ? v.violation.substring(0, 20) + "..." : v.violation) },
    tooltip: { trigger: "axis" },
    series: [{ type: "bar", data: topViolations.map((v: any) => Number(v.count)), itemStyle: { color: "#e14343", borderRadius: [0, 8, 8, 0] } }],
  };

  const topStalledCauses = stalledCauses?.slice(0, 5) || [];
  const stalledOption: EChartsOption = {
    grid: { left: 100, right: 20, top: 20, bottom: 26 },
    xAxis: { type: "value" },
    yAxis: { type: "category", data: topStalledCauses.map((c: any) => c.vehicle_cause) },
    tooltip: { trigger: "axis" },
    series: [{ type: "bar", data: topStalledCauses.map((c: any) => Number(c.count)), itemStyle: { color: "#3e67ef", borderRadius: [0, 8, 8, 0] } }],
  };

  const severityLevels = ["Minor", "Moderate", "Severe"];
  const severityData = severityLevels.map(level => {
    const found = severity?.find((s: any) => s.severity === level);
    return found ? Number(found.count) : 0;
  });
  
  const severityOption: EChartsOption = {
    color: ["#44b87e", "#eba015", "#e14343"],
    grid: { left: 46, right: 20, top: 20, bottom: 36 },
    xAxis: { type: "category", data: severityLevels },
    yAxis: { type: "value" },
    tooltip: { trigger: "axis" },
    series: [{ type: "bar", data: severityData, itemStyle: { borderRadius: [8, 8, 0, 0] }, colorBy: 'data' }],
  };

  // Predictive Mock Options
  const futureMonths = ["Apr", "May", "Jun", "Jul", "Aug", "Sep"];
  const predictiveIncidentOption: EChartsOption = {
    grid: { left: 46, right: 20, top: 20, bottom: 36 },
    xAxis: { type: "category", data: futureMonths },
    yAxis: { type: "value", min: 0, max: 5 },
    tooltip: { trigger: "axis" },
    series: [{ type: "line", data: [2.7, 2.5, 2.8, 3.1, 2.6, 2.4], smooth: true, lineStyle: { width: 3, type: "dashed", color: "#eba015" } }],
  };

  // Prescriptive Mock Options
  const prescriptiveResourceOption: EChartsOption = {
    grid: { left: 46, right: 20, top: 20, bottom: 36 },
    xAxis: { type: "category", data: ["Ambulance", "Tow Truck", "Patrol", "Fire"] },
    yAxis: { type: "value" },
    tooltip: { trigger: "axis" },
    series: [{ type: "bar", data: [3, 5, 8, 2], itemStyle: { color: "#4f7de5", borderRadius: [8, 8, 0, 0] } }],
  };

  return (
    <section className="ds-content ds-long">
      <h1 className="tab-title">Incident Analysis</h1>
      <div className="tab-stat-grid">
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Avg Incident Clearance Time</h3>
            <div className="value">{clearanceMins} min</div>
            <p className="ok">Real DB Average</p>
          </div>
          <div className="icon-box tone-blue"><Clock3 size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Total Incidents Logged</h3>
            <div className="value">{totalIncidents.toLocaleString()}</div>
            <p className="ok">Crashes & Stalled Vehicles</p>
          </div>
          <div className="icon-box tone-blue"><MapPin size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Proactive Enforcement Rate</h3>
            <div className="value">{proactiveRate}%</div>
            <p className="ok">Apprehensions vs Total Incidents</p>
          </div>
          <div className="icon-box tone-blue"><Radar size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Severe Impact Rate</h3>
            <div className="value">{severeRate}%</div>
            <p className="bad">High-risk crashes</p>
          </div>
          <div className="icon-box tone-blue"><Siren size={20} /></div>
        </article>
      </div>

      <section className="panel">
        <h2>Summary Insights</h2>
        <div className="insights-grid">
          <article className="insight red"><AlertTriangle size={18} /><div><h4>Critical Alert</h4><p>Balintawak Barrier shows 45% increase in incidents during rainy conditions. Enhanced monitoring recommended.</p></div></article>
          <article className="insight amber"><Radar size={18} /><div><h4>Pattern Detected</h4><p>80% of stalled vehicle incidents occur during 3-6 PM timeframe. Consider proactive patrols.</p></div></article>
          <article className="insight blue"><Lightbulb size={18} /><div><h4>Recommendation</h4><p>Weather-based incident prediction model accuracy: 87%. Continue training with real-time data.</p></div></article>
        </div>
      </section>

      <div className="mode-tabs">
        <button className={activeTab === "Descriptive" ? "active" : ""} onClick={() => setActiveTab("Descriptive")}>Descriptive</button>
        <button className={activeTab === "Predictive" ? "active" : ""} onClick={() => setActiveTab("Predictive")}>Predictive</button>
        <button className={activeTab === "Prescriptive" ? "active" : ""} onClick={() => setActiveTab("Prescriptive")}>Prescriptive</button>
      </div>

      {activeTab === "Descriptive" && (
        <div className="chart-grid">
          <article className="chart-card wide"><div className="chart-head"><h3>Incident Clearance Time Average</h3><span className="pill green">Database Value</span></div><DashboardChart option={clearanceOption} /></article>
          <article className="chart-card"><div className="chart-head"><h3>Top Violations</h3><span className="pill blue">Enforcement</span></div><DashboardChart option={enforcementOption} /></article>
          <article className="chart-card"><div className="chart-head"><h3>Stalled Vehicle Causes</h3><span className="pill purple">Top 5</span></div><DashboardChart option={stalledOption} /></article>
          <article className="chart-card wide"><div className="chart-head"><h3>Incident Severity Distribution</h3><span className="pill red">{severeRate}% Severe</span></div><DashboardChart option={severityOption} /></article>
        </div>
      )}

      {activeTab === "Predictive" && (
        <div className="chart-grid">
          <PredictiveIncidentChart />
        </div>
      )}

      {activeTab === "Prescriptive" && (
        <div className="chart-grid">
          <article className="chart-card wide"><div className="chart-head"><h3>Recommended Asset Pre-positioning</h3><span className="pill blue">Optimized</span></div><DashboardChart option={prescriptiveResourceOption} /></article>
        </div>
      )}
    </section>
  );
}
