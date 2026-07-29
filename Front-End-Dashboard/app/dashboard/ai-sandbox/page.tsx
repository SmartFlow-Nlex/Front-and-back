"use client";

import { useState } from "react";

const EXITS = [
  "Balintawak (Exit 1)",
  "Karuhatan (Exit 2)",
  "Valenzuela (Exit 3)",
  "Meycauayan (Exit 4)",
  "Marilao (Exit 5)",
  "Bocaue (Exit 6)",
  "Balagtas (Exit 7)",
  "Tabang (Exit 8)",
  "Santa Rita (Exit 9)",
];

export default function AiSandboxPage() {
  const [origin, setOrigin] = useState(EXITS[0]);
  const [destination, setDestination] = useState(EXITS[5]);
  const [direction, setDirection] = useState<"north" | "south">("north");
  const [inflowRate, setInflowRate] = useState(50);
  const [openLanes, setOpenLanes] = useState(4);
  const [laneCapacity, setLaneCapacity] = useState(75);

  const maxLanes = 4;

  const swapOriginDest = () => {
    setOrigin(destination);
    setDestination(origin);
  };

  return (
    <section className="ds-content ds-long">
      <h1 className="tab-title">AI Traffic Sandbox</h1>
      <div className="mini-stats-grid">
        <article className="mini-stat"><h3>Active Agents</h3><strong>10</strong></article>
        <article className="mini-stat"><h3>Average Speed</h3><strong>59.8 km/h</strong></article>
        <article className="mini-stat"><h3>Flow Stability</h3><strong className="ok">100%</strong></article>
      </div>
      <div className="sandbox-grid">
        {/* Main simulation area */}
        <article className="sandbox-main">
          <div className="sandbox-head">
            <h2>Traffic Simulation</h2>
            <div>
              <button className="btn-primary">Pause</button>
              <button className="btn-muted">Reset</button>
            </div>
          </div>
          <p>{origin} → {destination}</p>
          <div className="road-visual">
            {Array.from({ length: openLanes }, (_, i) => (
              <div key={i}>L{i + 1}</div>
            ))}
          </div>
        </article>

        {/* Simulation Parameters sidebar */}
        <aside className="sandbox-side">
          <h2>Manual Configuration</h2>

          {/* Route Configuration */}
          <div className="sandbox-section-title">Route Configuration</div>

          <label>
            Origin
            <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
              {EXITS.map((ex) => (
                <option key={ex} value={ex}>{ex}</option>
              ))}
            </select>
          </label>

          <div className="sandbox-swap-row">
            <button
              className="sandbox-swap-btn"
              onClick={swapOriginDest}
              title="Swap origin and destination"
              aria-label="Swap origin and destination"
            >
              ⇅
            </button>
          </div>

          <label>
            Destination
            <select value={destination} onChange={(e) => setDestination(e.target.value)}>
              {EXITS.map((ex) => (
                <option key={ex} value={ex}>{ex}</option>
              ))}
            </select>
          </label>

          {/* Traffic Direction */}
          <div className="sandbox-section-title">Traffic Direction</div>
          <div className="dir-toggle">
            <button
              className={direction === "north" ? "active" : ""}
              onClick={() => setDirection("north")}
            >
              North to South
            </button>
            <button
              className={direction === "south" ? "active" : ""}
              onClick={() => setDirection("south")}
            >
              South to North
            </button>
          </div>

          {/* Inflow Rate Slider */}
          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">Inflow Rate</span>
              <span className="sandbox-slider-value" style={{ color: "var(--brand-primary)" }}>{inflowRate}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={inflowRate}
              onChange={(e) => setInflowRate(Number(e.target.value))}
              className="sandbox-range inflow"
              style={{ "--range-pct": `${inflowRate}%` } as React.CSSProperties}
            />
            <span className="sandbox-slider-hint">Controls vehicle entry rate</span>
          </div>

          {/* Open Lanes Slider */}
          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">Open Lanes</span>
              <span className="sandbox-slider-value" style={{ color: "#16a34a" }}>{openLanes} / {maxLanes}</span>
            </div>
            <input
              type="range"
              min={1}
              max={maxLanes}
              step={1}
              value={openLanes}
              onChange={(e) => setOpenLanes(Number(e.target.value))}
              className="sandbox-range lanes"
              style={{ "--range-pct": `${((openLanes - 1) / (maxLanes - 1)) * 100}%` } as React.CSSProperties}
            />
            <span className="sandbox-slider-hint">Number of active lanes (max {maxLanes} for this route)</span>
          </div>

          {/* Lane Capacity Slider */}
          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">Lane Capacity</span>
              <span className="sandbox-slider-value" style={{ color: "#ea580c" }}>{laneCapacity}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={laneCapacity}
              onChange={(e) => setLaneCapacity(Number(e.target.value))}
              className="sandbox-range capacity"
              style={{ "--range-pct": `${laneCapacity}%` } as React.CSSProperties}
            />
            <span className="sandbox-slider-hint">Maximum throughput per lane</span>
          </div>
        </aside>
      </div>
    </section>
  );
}
