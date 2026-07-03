"use client";

import { useState } from "react";
import { CalendarDays, Clock3, Lightbulb, Percent, Shuffle, TrendingUp, TriangleAlert, Activity, CheckCircle, Zap } from "lucide-react";
import type { EChartsOption } from "echarts";
import DashboardChart from "../../../components/dashboard/DashboardChart";
import PredictiveVolumeChart from "../../../components/dashboard/PredictiveVolumeChart";

const months = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
const futureMonths = ["Apr", "May", "Jun", "Jul", "Aug", "Sep"];

const trafficTrendOption: EChartsOption = {
  grid: { left: 46, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: months },
  yAxis: { type: "value" },
  tooltip: { trigger: "axis" },
  series: [{ type: "line", data: [108000, 112000, 115000, 118000, 121000, 124000], smooth: true, symbolSize: 9, lineStyle: { width: 3, color: "#3e67ef" } }],
};

const fleetShareOption: EChartsOption = {
  grid: { left: 40, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: months },
  yAxis: { type: "value", max: 100 },
  tooltip: { trigger: "axis" },
  series: [{ type: "line", data: [73, 72, 71, 71, 72, 72], smooth: true, areaStyle: { color: "rgba(224,107,71,.8)" }, lineStyle: { color: "#e06b47", width: 2 }, symbol: "none" }],
};

const exitsOption: EChartsOption = {
  grid: { left: 46, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: ["Balintawak", "Bocaue", "Sta. Rita", "San Simon", "Dau", "Others"] },
  yAxis: { type: "value" },
  tooltip: { trigger: "axis" },
  series: [{ type: "bar", data: [32, 21, 16, 13, 11, 6], itemStyle: { color: "#4f7de5", borderRadius: [8, 8, 0, 0] } }],
};

const directionalOption: EChartsOption = {
  grid: { left: 46, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: ["6 AM", "9 AM", "12 PM", "3 PM", "6 PM", "9 PM"] },
  yAxis: { type: "value" },
  tooltip: { trigger: "axis" },
  series: [{ type: "line", data: [2100, 2800, 3200, 3600, 4100, 2400], smooth: true, areaStyle: { color: "rgba(104,165,218,.9)" }, lineStyle: { color: "#5a9fd6", width: 2 }, symbol: "none" }],
};

// Predictive Mock Options
const predictiveTrendOption: EChartsOption = {
  grid: { left: 46, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: futureMonths },
  yAxis: { type: "value", min: 100000 },
  tooltip: { trigger: "axis" },
  series: [{ type: "line", data: [126000, 129000, 134000, 138000, 142000, 148000], smooth: true, lineStyle: { width: 3, type: "dashed", color: "#e14343" } }],
};

// Prescriptive Mock Options
const prescriptiveImpactOption: EChartsOption = {
  grid: { left: 46, right: 20, top: 20, bottom: 36 },
  xAxis: { type: "category", data: ["Strategy A", "Strategy B", "Strategy C"] },
  yAxis: { type: "value" },
  tooltip: { trigger: "axis" },
  series: [{ type: "bar", data: [15, 25, 40], itemStyle: { color: "#29b471", borderRadius: [8, 8, 0, 0] } }],
};

export default function TrafficPage() {
  const [activeTab, setActiveTab] = useState("Descriptive");

  return (
    <section className="ds-content ds-long">
      <h1 className="tab-title">Traffic Overview</h1>
      <div className="tab-stat-grid">
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Average Daily Traffic (ADT)</h3>
            <div className="value">125,847</div>
            <p className="ok">+12.5% trend rate vs last month</p>
          </div>
          <div className="icon-box tone-blue"><TrendingUp size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Heavy Fleet Share</h3>
            <div className="value">28.4%</div>
            <p>Class 2 &amp; 3 vehicles</p>
          </div>
          <div className="icon-box tone-blue"><Percent size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Peak Exit Concentration</h3>
            <div className="value">Balintawak</div>
            <p>33% of total exits</p>
          </div>
          <div className="icon-box tone-blue"><CalendarDays size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Directional Imbalance Ratio</h3>
            <div className="value">1.18</div>
            <p>NB 54% / SB 46%</p>
          </div>
          <div className="icon-box tone-blue"><Shuffle size={20} /></div>
        </article>
      </div>

      <section className="panel">
        <h2>Summary Insights</h2>
        <div className="insights-grid">
          <article className="insight blue"><Clock3 size={18} /><div><h4>Peak Hour Management</h4><p>Traffic peaks at 4-6 PM with 5,800 vehicles/hour. Consider implementing dynamic toll pricing during peak periods.</p></div></article>
          <article className="insight amber"><TriangleAlert size={18} /><div><h4>Heavy Fleet Alert</h4><p>28.4% heavy vehicle ratio exceeds optimal threshold. Monitor road wear and maintenance schedules.</p></div></article>
          <article className="insight green"><Lightbulb size={18} /><div><h4>Forecasting Accuracy</h4><p>AI model achieves 87% accuracy in traffic prediction. Continue training with real-time data for improvement.</p></div></article>
        </div>
      </section>

      <div className="mode-tabs">
        <button className={activeTab === "Descriptive" ? "active" : ""} onClick={() => setActiveTab("Descriptive")}>Descriptive</button>
        <button className={activeTab === "Predictive" ? "active" : ""} onClick={() => setActiveTab("Predictive")}>Predictive</button>
        <button className={activeTab === "Prescriptive" ? "active" : ""} onClick={() => setActiveTab("Prescriptive")}>Prescriptive</button>
      </div>

      {activeTab === "Descriptive" && (
        <div className="chart-grid">
          <article className="chart-card wide"><div className="chart-head"><h3>Average Daily Traffic Trend</h3><span className="pill green">+12.5% Growth</span></div><DashboardChart option={trafficTrendOption} /></article>
          <article className="chart-card"><div className="chart-head"><h3>Heavy Fleet Share Over Time</h3><span className="pill amber">Class 2 &amp; 3</span></div><DashboardChart option={fleetShareOption} /></article>
          <article className="chart-card"><div className="chart-head"><h3>Exit Distribution by Station</h3><span className="pill blue">Peak: Balintawak</span></div><DashboardChart option={exitsOption} /></article>
          <article className="chart-card wide"><div className="chart-head"><h3>Directional Flow Analysis</h3><span className="pill purple">NB 54% / SB 46%</span></div><DashboardChart option={directionalOption} /></article>
        </div>
      )}

      {activeTab === "Predictive" && (
        <div className="chart-grid">
          <PredictiveVolumeChart />
        </div>
      )}

      {activeTab === "Prescriptive" && (
        <div className="chart-grid">
          <article className="chart-card wide"><div className="chart-head"><h3>Projected Impact of Strategies (Throughput Gain)</h3><span className="pill green">Optimized</span></div><DashboardChart option={prescriptiveImpactOption} /></article>
        </div>
      )}
    </section>
  );
}
