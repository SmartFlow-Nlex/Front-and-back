"use client";

import { useState, useEffect } from "react";
import { CalendarDays, Clock3, Lightbulb, Percent, Shuffle, TrendingUp, TriangleAlert } from "lucide-react";
import type { EChartsOption } from "echarts";
import DashboardChart from "../../../components/dashboard/DashboardChart";
import PredictiveVolumeChart from "../../../components/dashboard/PredictiveVolumeChart";

export default function TrafficPage() {
  const [activeTab, setActiveTab] = useState("Descriptive");
  const [trafficData, setTrafficData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("http://localhost:4000/api/traffic/summary");
        const json = await res.json();
        if (json.success) {
          setTrafficData(json.data);
        }
      } catch (err) {
        console.error("Failed to fetch traffic summary", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) return <div style={{ padding: 40, textAlign: "center" }}>Loading traffic analytics...</div>;
  if (!trafficData) return <div style={{ padding: 40, textAlign: "center" }}>Failed to load traffic data.</div>;

  const { adt, directional, vehicleClass, exits, hourly, monthly } = trafficData;

  // Formatting for cards
  const totalAdt = adt?.adt || 0;
  
  // Calculate Class 2 & 3 share
  let totalVehicles = 0;
  let heavyVehicles = 0;
  vehicleClass?.forEach((c: any) => {
    const val = Number(c.total);
    totalVehicles += val;
    if (c.vehicle_class === "Class 2" || c.vehicle_class === "Class 3") {
      heavyVehicles += val;
    }
  });
  const heavyShare = totalVehicles > 0 ? ((heavyVehicles / totalVehicles) * 100).toFixed(1) : "0.0";

  // Top exit
  const topExit = exits && exits.length > 0 ? exits[0].toll_plaza : "N/A";
  const topExitShare = exits && exits.length > 0 && totalVehicles > 0 ? ((Number(exits[0].total) / totalVehicles) * 100).toFixed(0) : "0";

  // Directional ratio
  let nb = 0, sb = 0;
  directional?.forEach((d: any) => {
    if (d.direction === "NB") nb = Number(d.total);
    if (d.direction === "SB") sb = Number(d.total);
  });
  const dirTotal = nb + sb;
  const nbPct = dirTotal > 0 ? Math.round((nb / dirTotal) * 100) : 0;
  const sbPct = dirTotal > 0 ? Math.round((sb / dirTotal) * 100) : 0;
  const imbalance = sb > 0 ? (nb / sb).toFixed(2) : "1.00";

  // Charts Options
  const months = monthly?.map((m: any) => m.month) || [];
  const adtTrend = monthly?.map((m: any) => Number(m.adt)) || [];
  
  const trafficTrendOption: EChartsOption = {
    grid: { left: 56, right: 20, top: 20, bottom: 36 },
    xAxis: { type: "category", data: months },
    yAxis: { type: "value" },
    tooltip: { trigger: "axis" },
    series: [{ type: "line", data: adtTrend, smooth: true, symbolSize: 9, lineStyle: { width: 3, color: "#3e67ef" } }],
  };

  const fleetShareOption: EChartsOption = {
    grid: { left: 40, right: 20, top: 20, bottom: 36 },
    xAxis: { type: "category", data: months },
    yAxis: { type: "value", max: 100 },
    tooltip: { trigger: "axis" },
    // Simplified heavy share mock trend matching current %
    series: [{ type: "line", data: Array(months.length).fill(Number(heavyShare)), smooth: true, areaStyle: { color: "rgba(224,107,71,.8)" }, lineStyle: { color: "#e06b47", width: 2 }, symbol: "none" }],
  };

  const top5Exits = exits?.slice(0, 5) || [];
  const exitsOption: EChartsOption = {
    grid: { left: 56, right: 20, top: 20, bottom: 46 },
    xAxis: { type: "category", data: top5Exits.map((e: any) => e.toll_plaza), axisLabel: { rotate: 30 } },
    yAxis: { type: "value" },
    tooltip: { trigger: "axis" },
    series: [{ type: "bar", data: top5Exits.map((e: any) => Number(e.total)), itemStyle: { color: "#4f7de5", borderRadius: [8, 8, 0, 0] } }],
  };

  const hourlyLabels = hourly?.map((h: any) => h.hour) || [];
  const hourlyValues = hourly?.map((h: any) => h.avgVolume) || [];
  const directionalOption: EChartsOption = {
    grid: { left: 56, right: 20, top: 20, bottom: 36 },
    xAxis: { type: "category", data: hourlyLabels, axisLabel: { interval: 3 } },
    yAxis: { type: "value" },
    tooltip: { trigger: "axis" },
    series: [{ type: "line", data: hourlyValues, smooth: true, areaStyle: { color: "rgba(104,165,218,.9)" }, lineStyle: { color: "#5a9fd6", width: 2 }, symbol: "none" }],
  };

  // Predictive Mock Options
  const futureMonths = ["Apr", "May", "Jun", "Jul", "Aug", "Sep"];
  const predictiveTrendOption: EChartsOption = {
    grid: { left: 56, right: 20, top: 20, bottom: 36 },
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

  return (
    <section className="ds-content ds-long">
      <h1 className="tab-title">Traffic Overview</h1>
      <div className="tab-stat-grid">
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Average Daily Traffic (ADT)</h3>
            <div className="value">{Number(totalAdt).toLocaleString()}</div>
            <p className="ok">Real-time DB aggregate</p>
          </div>
          <div className="icon-box tone-blue"><TrendingUp size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Heavy Fleet Share</h3>
            <div className="value">{heavyShare}%</div>
            <p>Class 2 &amp; 3 vehicles</p>
          </div>
          <div className="icon-box tone-blue"><Percent size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Peak Exit Concentration</h3>
            <div className="value">{topExit}</div>
            <p>{topExitShare}% of total volume</p>
          </div>
          <div className="icon-box tone-blue"><CalendarDays size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Directional Imbalance Ratio</h3>
            <div className="value">{imbalance}</div>
            <p>NB {nbPct}% / SB {sbPct}%</p>
          </div>
          <div className="icon-box tone-blue"><Shuffle size={20} /></div>
        </article>
      </div>

      <section className="panel">
        <h2>Summary Insights</h2>
        <div className="insights-grid">
          <article className="insight blue"><Clock3 size={18} /><div><h4>Peak Hour Management</h4><p>Traffic peaks at 4-6 PM. Consider implementing dynamic toll pricing during peak periods.</p></div></article>
          <article className="insight amber"><TriangleAlert size={18} /><div><h4>Heavy Fleet Alert</h4><p>{heavyShare}% heavy vehicle ratio. Monitor road wear and maintenance schedules.</p></div></article>
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
          <article className="chart-card wide"><div className="chart-head"><h3>Average Daily Traffic Trend</h3><span className="pill green">Database Aggregate</span></div><DashboardChart option={trafficTrendOption} /></article>
          <article className="chart-card"><div className="chart-head"><h3>Heavy Fleet Share</h3><span className="pill amber">Class 2 &amp; 3</span></div><DashboardChart option={fleetShareOption} /></article>
          <article className="chart-card"><div className="chart-head"><h3>Exit Distribution by Station</h3><span className="pill blue">Top 5 Toll Plazas</span></div><DashboardChart option={exitsOption} /></article>
          <article className="chart-card wide"><div className="chart-head"><h3>Hourly Traffic Pattern (All Plazas)</h3><span className="pill purple">24-hour Profile</span></div><DashboardChart option={directionalOption} /></article>
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
