export default function AiSandboxPage() {
  return (
    <section className="ds-content ds-long">
      <h1 className="tab-title">AI Traffic Sandbox</h1>
      <div className="mini-stats-grid">
        <article className="mini-stat"><h3>Active Agents</h3><strong>10</strong></article>
        <article className="mini-stat"><h3>Average Speed</h3><strong>59.8 km/h</strong></article>
        <article className="mini-stat"><h3>Flow Stability</h3><strong className="ok">100%</strong></article>
      </div>
      <div className="sandbox-grid">
        <article className="sandbox-main"><div className="sandbox-head"><h2>Traffic Simulation</h2><div><button className="btn-primary">Pause</button><button className="btn-muted">Reset</button></div></div><p>Balintawak (Exit 1) ? Bocaue (Exit 9)</p><div className="road-visual"><div>L1</div><div>L2</div><div>L3</div><div>L4</div></div></article>
        <aside className="sandbox-side"><h2>Simulation Parameters</h2><label>Origin<select><option>Balintawak (Exit 1)</option></select></label><label>Destination<select><option>Bocaue (Exit 9)</option></select></label><div className="dir-toggle"><button className="active">North to South</button><button>South to North</button></div></aside>
      </div>
    </section>
  );
}
