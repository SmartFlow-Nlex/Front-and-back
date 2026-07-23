"use client";

import { useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "../../../components/dashboard/DashboardChart";
import PredictiveEmissionChart from "../../../components/dashboard/PredictiveEmissionChart";
import { AlertTriangle, CloudRain, Factory, Leaf, Lightbulb, Wrench, Activity, CheckCircle, Zap } from "lucide-react";

const months = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
const futureMonths = ["Apr", "May", "Jun", "Jul", "Aug", "Sep"];

const emissionTrendOption: EChartsOption = {
  grid: { left: 46, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: months },
  yAxis: { type: "value", min: 25, max: 30 },
  tooltip: { trigger: "axis" },
  series: [{ type: "line", data: [27.2, 27.8, 28.5, 28.9, 28.1, 28.4], smooth: true, symbolSize: 10, lineStyle: { color: "#e69411", width: 3 } }],
};

const peakOffPeakOption: EChartsOption = {
  grid: { left: 46, right: 20, top: 20, bottom: 56 },
  xAxis: { type: "category", data: ["Off-Peak", "Morning Rush", "Midday", "Evening Rush", "Night"], axisLabel: { interval: 0, rotate: 20 } },
  yAxis: { type: "value", max: 600 },
  tooltip: { trigger: "axis" },
  color: ["#4bb782", "#eba015", "#4bb782", "#e14343", "#4bb782"],
  series: [{ type: "bar", data: [140, 315, 172, 402, 160], itemStyle: { borderRadius: [8, 8, 0, 0] } }],
};

const maintenanceOption: EChartsOption = {
  grid: { left: 46, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: months },
  yAxis: { type: "value", max: 100 },
  tooltip: { trigger: "axis" },
  series: [{ type: "line", data: [58, 61, 63, 62, 65, 64], smooth: true, areaStyle: { color: "rgba(143,120,88,.8)" }, lineStyle: { color: "#8f7858", width: 2 }, symbol: "none" }],
};

const climateOption: EChartsOption = {
  grid: { left: 110, right: 20, top: 20, bottom: 26 },
  xAxis: { type: "value", max: 140 },
  yAxis: { type: "category", data: ["Road Closures", "Response Time", "Incident Volume"] },
  tooltip: { trigger: "axis" },
  series: [{ type: "bar", data: [4, 12, 42], itemStyle: { color: "#4f7de5", borderRadius: [0, 8, 8, 0] } }],
};

// Predictive Mock Options
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

export default function SustainabilityPage() {
  const [activeTab, setActiveTab] = useState("Descriptive");

  return (
    <section className="ds-content ds-long">
      <h1 className="tab-title">Emissions Overview</h1>
      <div className="tab-stat-grid">
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>High-Emission Fleet Index</h3>
            <div className="value">28.4%</div>
            <p className="warn">Current heavy-emission share</p>
          </div>
          <div className="icon-box tone-blue"><Factory size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Peak Emission Penalty</h3>
            <div className="value">2.8x</div>
            <p className="bad">Rush-hour concentration</p>
          </div>
          <div className="icon-box tone-blue"><CloudRain size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Preventable Maintenance</h3>
            <div className="value">64%</div>
            <p className="ok">Opportunity for reduction</p>
          </div>
          <div className="icon-box tone-blue"><Wrench size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Climate Impact Factor</h3>
            <div className="value">2.95x</div>
            <p className="purple">Fair vs rainy conditions</p>
          </div>
          <div className="icon-box tone-blue"><Leaf size={20} /></div>
        </article>
      </div>

      <section className="panel">
        <h2>Summary Insights</h2>
        <div className="insights-grid">
          <article className="insight red"><AlertTriangle size={18} /><div><h4>High Emission Alert</h4><p>Heavy duty vehicles on Balintawak route are causing a 2.8x peak penalty during morning rush hours.</p></div></article>
          <article className="insight amber"><CloudRain size={18} /><div><h4>Weather Impact</h4><p>Rainy conditions are exacerbating emission trapping by 2.95x due to slower traffic flow.</p></div></article>
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
          <article className="chart-card wide"><div className="chart-head"><h3>High-Emission Fleet Index Trend</h3><span className="pill amber">28.4% Current</span></div><DashboardChart option={emissionTrendOption} /></article>
          <article className="chart-card"><div className="chart-head"><h3>Peak vs Off-Peak Emissions</h3><span className="pill red">2.8x Penalty</span></div><DashboardChart option={peakOffPeakOption} /></article>
          <article className="chart-card"><div className="chart-head"><h3>Preventable Maintenance Trend</h3><span className="pill blue">64% Preventable</span></div><DashboardChart option={maintenanceOption} /></article>
          <article className="chart-card wide"><div className="chart-head"><h3>Climate Resilience: Fair vs Rainy</h3><span className="pill purple">2.95x Impact</span></div><DashboardChart option={climateOption} /></article>
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
