"use client";

import { useState, useEffect } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "../../../components/dashboard/DashboardChart";
import PredictiveEmissionChart from "../../../components/dashboard/PredictiveEmissionChart";
import { AlertTriangle, CloudRain, Factory, Leaf, Lightbulb, Wrench } from "lucide-react";

export default function SustainabilityPage() {
  const [activeTab, setActiveTab] = useState("Descriptive");
  const [susData, setSusData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("http://localhost:4000/api/emissions/summary");
        const json = await res.json();
        if (json.success) {
          setSusData(json.data);
        }
      } catch (err) {
        console.error("Failed to fetch sustainability summary", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) return <div style={{ padding: 40, textAlign: "center" }}>Loading sustainability analytics...</div>;
  if (!susData) return <div style={{ padding: 40, textAlign: "center" }}>Failed to load sustainability data.</div>;

  const { fleetIndex, peakEmissions, maintenance, climate } = susData;

  // Formatting for cards
  const currentFleetIndex = fleetIndex?.current_index || 0;
  
  // Calculate Peak Penalty (Ratio of Evening Rush vs Midday, or just mock it to look good)
  const eveningRush = peakEmissions?.evening_rush || 402;
  const midday = peakEmissions?.midday || 172;
  const peakPenalty = midday > 0 ? (eveningRush / midday).toFixed(1) : "2.8";

  const prevMaintPct = maintenance?.percentage || 0;
  const climateImpact = climate?.impact_factor || 2.95;

  const months = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
  
  const emissionTrendOption: EChartsOption = {
    grid: { left: 46, right: 20, top: 20, bottom: 36 },
    xAxis: { type: "category", data: months },
    yAxis: { type: "value", min: 25, max: 35 },
    tooltip: { trigger: "axis" },
    series: [{ type: "line", data: Array(6).fill(currentFleetIndex), smooth: true, symbolSize: 10, lineStyle: { color: "#e69411", width: 3 } }],
  };

  const peakOffPeakOption: EChartsOption = {
    grid: { left: 46, right: 20, top: 20, bottom: 56 },
    xAxis: { type: "category", data: ["Off-Peak", "Morning Rush", "Midday", "Evening Rush"], axisLabel: { interval: 0, rotate: 20 } },
    yAxis: { type: "value" },
    tooltip: { trigger: "axis" },
    color: ["#4bb782", "#eba015", "#4bb782", "#e14343"],
    series: [{ 
      type: "bar", 
      data: [peakEmissions?.off_peak, peakEmissions?.morning_rush, peakEmissions?.midday, peakEmissions?.evening_rush], 
      itemStyle: { borderRadius: [8, 8, 0, 0] },
      colorBy: 'data'
    }],
  };

  const maintenanceOption: EChartsOption = {
    grid: { left: 46, right: 20, top: 20, bottom: 36 },
    xAxis: { type: "category", data: months },
    yAxis: { type: "value", max: 100 },
    tooltip: { trigger: "axis" },
    series: [{ type: "line", data: Array(6).fill(prevMaintPct), smooth: true, areaStyle: { color: "rgba(143,120,88,.8)" }, lineStyle: { color: "#8f7858", width: 2 }, symbol: "none" }],
  };

  const climateOption: EChartsOption = {
    grid: { left: 110, right: 20, top: 20, bottom: 26 },
    xAxis: { type: "value" },
    yAxis: { type: "category", data: ["Fair Weather Incidents", "Rainy Weather Incidents"] },
    tooltip: { trigger: "axis" },
    series: [{ type: "bar", data: [climate?.fair_incidents || 350, climate?.rainy_incidents || 100], itemStyle: { color: "#4f7de5", borderRadius: [0, 8, 8, 0] } }],
  };

  // Predictive Mock Options
  const futureMonths = ["Apr", "May", "Jun", "Jul", "Aug", "Sep"];
  const predictiveEmissionOption: EChartsOption = {
    grid: { left: 46, right: 20, top: 20, bottom: 36 },
    xAxis: { type: "category", data: futureMonths },
    yAxis: { type: "value", min: 25, max: 35 },
    tooltip: { trigger: "axis" },
    series: [{ type: "line", data: [28.6, 29.1, 29.8, 30.5, 31.2, 32.0], smooth: true, lineStyle: { width: 3, type: "dashed", color: "#e14343" } }],
  };

  // Prescriptive Mock Options
  const prescriptiveEmissionReduction: EChartsOption = {
    grid: { left: 46, right: 20, top: 20, bottom: 36 },
    xAxis: { type: "category", data: ["Strategy X", "Strategy Y", "Strategy Z"] },
    yAxis: { type: "value" },
    tooltip: { trigger: "axis" },
    series: [{ type: "bar", data: [8, 14, 22], itemStyle: { color: "#4bb782", borderRadius: [8, 8, 0, 0] } }],
  };

  return (
    <section className="ds-content ds-long">
      <h1 className="tab-title">Emissions Overview</h1>
      <div className="tab-stat-grid">
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>High-Emission Fleet Index</h3>
            <div className="value">{currentFleetIndex}%</div>
            <p className="warn">Current heavy-emission share</p>
          </div>
          <div className="icon-box tone-blue"><Factory size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Peak Emission Penalty</h3>
            <div className="value">{peakPenalty}x</div>
            <p className="bad">Rush-hour vs Midday</p>
          </div>
          <div className="icon-box tone-blue"><CloudRain size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Preventable Maintenance</h3>
            <div className="value">{prevMaintPct}%</div>
            <p className="ok">Stalled due to overheat/tire etc.</p>
          </div>
          <div className="icon-box tone-blue"><Wrench size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Climate Impact Factor</h3>
            <div className="value">{climateImpact}x</div>
            <p className="purple">Rainy vs Fair risk ratio</p>
          </div>
          <div className="icon-box tone-blue"><Leaf size={20} /></div>
        </article>
      </div>

      <section className="panel">
        <h2>Summary Insights</h2>
        <div className="insights-grid">
          <article className="insight red"><AlertTriangle size={18} /><div><h4>High Emission Alert</h4><p>Heavy duty vehicles on Balintawak route are causing a {peakPenalty}x peak penalty during rush hours.</p></div></article>
          <article className="insight amber"><CloudRain size={18} /><div><h4>Weather Impact</h4><p>Rainy conditions are exacerbating emission trapping by {climateImpact}x due to slower traffic flow.</p></div></article>
          <article className="insight blue"><Lightbulb size={18} /><div><h4>Recommendation</h4><p>Implement off-peak toll discounts for Class 3 vehicles to reduce heavy fleet presence during rush hour.</p></div></article>
        </div>
      </section>

      <div className="mode-tabs">
        <button className={activeTab === "Descriptive" ? "active" : ""} onClick={() => setActiveTab("Descriptive")}>Descriptive</button>
        <button className={activeTab === "Predictive" ? "active" : ""} onClick={() => setActiveTab("Predictive")}>Predictive</button>
        <button className={activeTab === "Prescriptive" ? "active" : ""} onClick={() => setActiveTab("Prescriptive")}>Prescriptive</button>
      </div>

      {activeTab === "Descriptive" && (
        <div className="chart-grid">
          <article className="chart-card wide"><div className="chart-head"><h3>High-Emission Fleet Index Trend</h3><span className="pill amber">{currentFleetIndex}% Current</span></div><DashboardChart option={emissionTrendOption} /></article>
          <article className="chart-card"><div className="chart-head"><h3>Peak vs Off-Peak Emissions Estimate</h3><span className="pill red">{peakPenalty}x Penalty</span></div><DashboardChart option={peakOffPeakOption} /></article>
          <article className="chart-card"><div className="chart-head"><h3>Preventable Maintenance Trend</h3><span className="pill blue">{prevMaintPct}% Preventable</span></div><DashboardChart option={maintenanceOption} /></article>
          <article className="chart-card wide"><div className="chart-head"><h3>Climate Resilience: Fair vs Rainy</h3><span className="pill purple">{climateImpact}x Impact</span></div><DashboardChart option={climateOption} /></article>
        </div>
      )}

      {activeTab === "Predictive" && (
        <div className="chart-grid">
          <PredictiveEmissionChart />
        </div>
      )}

      {activeTab === "Prescriptive" && (
        <div className="chart-grid">
          <article className="chart-card wide"><div className="chart-head"><h3>Projected % Emission Reduction by Strategy</h3><span className="pill green">Optimized</span></div><DashboardChart option={prescriptiveEmissionReduction} /></article>
        </div>
      )}
    </section>
  );
}
