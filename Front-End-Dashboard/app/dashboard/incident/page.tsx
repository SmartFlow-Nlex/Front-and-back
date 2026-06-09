import { AlertTriangle, Clock3, Lightbulb, MapPin, Radar, Siren } from "lucide-react";
import type { EChartsOption } from "echarts";
import DashboardChart from "../../../components/dashboard/DashboardChart";

const months = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

const clearanceOption: EChartsOption = {
  grid: { left: 46, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: months },
  yAxis: { type: "value", min: 0, max: 16 },
  tooltip: { trigger: "axis" },
  series: [{ type: "line", data: [15.2, 14.8, 14.2, 13.6, 13.1, 12.3], smooth: true, symbolSize: 9, lineStyle: { width: 3, color: "#29b471" } }],
};

const targetOption: EChartsOption = {
  grid: { left: 46, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: months },
  yAxis: { type: "value", min: 0, max: 3.8 },
  tooltip: { trigger: "axis" },
  series: [
    { type: "line", data: [3.4, 3.2, 3.1, 2.8, 2.8, 2.7], smooth: true, symbolSize: 8, lineStyle: { width: 3, color: "#3e67ef" } },
    { type: "line", data: [3.5, 3.5, 3.5, 3.5, 3.5, 3.5], smooth: true, symbolSize: 6, lineStyle: { width: 2, type: "dashed", color: "#ef4444" } },
  ],
};

const enforcementOption: EChartsOption = {
  grid: { left: 90, right: 20, top: 20, bottom: 26 },
  xAxis: { type: "value" },
  yAxis: { type: "category", data: ["Speeding Violations", "Lane Violations", "Overloading", "Reckless Driving", "Other Violations"] },
  tooltip: { trigger: "axis" },
  series: [{ type: "bar", data: [245, 188, 156, 131, 97], itemStyle: { color: "#e14343", borderRadius: [0, 8, 8, 0] } }],
};

const severityOption: EChartsOption = {
  color: ["#44b87e", "#eba015", "#e14343"],
  grid: { left: 46, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: ["Minor", "Moderate", "Severe"] },
  yAxis: { type: "value", max: 300 },
  tooltip: { trigger: "axis" },
  series: [{ type: "bar", data: [282, 134, 36], itemStyle: { borderRadius: [8, 8, 0, 0] } }],
};

export default function IncidentPage() {
  return (
    <section className="ds-content ds-long">
      <h1 className="tab-title">Incident Analysis</h1>
      <div className="tab-stat-grid">
        <article className="tab-stat-card"><div className="icon-box tone-blue"><Clock3 size={20} /></div><h3>Avg Incident Clearance Time</h3><div className="value">12.3 min</div><p className="ok">18% efficiency gain</p></article>
        <article className="tab-stat-card"><div className="icon-box tone-blue"><MapPin size={20} /></div><h3>Incident Rate (per 10K)</h3><div className="value">2.8</div><p className="ok">Below target of 3.5</p></article>
        <article className="tab-stat-card"><div className="icon-box tone-blue"><Radar size={20} /></div><h3>Proactive Enforcement Rate</h3><div className="value">68%</div><p className="ok">Apprehensions vs crashes</p></article>
        <article className="tab-stat-card"><div className="icon-box tone-blue"><Siren size={20} /></div><h3>Severe Impact Rate</h3><div className="value">8.2%</div><p className="bad">High-risk incidents</p></article>
      </div>

      <section className="panel">
        <h2>Summary Insights</h2>
        <div className="insights-grid">
          <article className="insight red"><AlertTriangle size={18} /><div><h4>Critical Alert</h4><p>Balintawak Barrier shows 45% increase in incidents during rainy conditions. Enhanced monitoring recommended.</p></div></article>
          <article className="insight amber"><Radar size={18} /><div><h4>Pattern Detected</h4><p>80% of stalled vehicle incidents occur during 3-6 PM timeframe. Consider proactive patrols.</p></div></article>
          <article className="insight blue"><Lightbulb size={18} /><div><h4>Recommendation</h4><p>Weather-based incident prediction model accuracy: 87%. Continue training with real-time data.</p></div></article>
        </div>
      </section>

      <div className="mode-tabs"><button className="active">Descriptive</button><button>Predictive</button><button>Prescriptive</button></div>

      <div className="chart-grid">
        <article className="chart-card"><div className="chart-head"><h3>Incident Clearance Time Trend</h3><span className="pill green">18% Improvement</span></div><DashboardChart option={clearanceOption} /></article>
        <article className="chart-card"><div className="chart-head"><h3>Incident Rate vs Target</h3><span className="pill green">Below Target</span></div><DashboardChart option={targetOption} /></article>
        <article className="chart-card"><div className="chart-head"><h3>Proactive Enforcement Analysis</h3><span className="pill blue">68% Rate</span></div><DashboardChart option={enforcementOption} /></article>
        <article className="chart-card"><div className="chart-head"><h3>Incident Severity Distribution</h3><span className="pill red">8.2% Severe</span></div><DashboardChart option={severityOption} /></article>
      </div>
    </section>
  );
}
