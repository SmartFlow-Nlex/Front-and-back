"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useNlexExits } from "../../../lib/nlex-exits";
import { Car } from "lucide-react";
import PageHeader from "../../../components/dashboard/PageHeader";
import { TrafficSim, CLASS_META, mixHex, type Metrics, type Interventions } from "./simulation";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";


const SEG_LENGTH = 280; // metres of corridor shown (a representative merge stretch)
const SIM_DT = 0.2; // fixed physics timestep (s)

const SPEED_STEPS = [0.5, 1, 2, 4] as const;

type Baseline = { avgSpeedKmh: number; throughputPerMin: number; longestQueueM: number; co2RatePerMin: number; avgTravelTimeS: number };

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export default function AiSandboxPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<TrafficSim | null>(null);
  const rafRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const metricAccRef = useRef<number>(0);
  const simAccRef = useRef<number>(0);

  // Corridor exits come from the shared list so this tab, maintenance and the
  // map all offer the same set. See lib/nlex-exits.
  const { exits: EXITS } = useNlexExits();
  const [origin, setOrigin] = useState(0);
  const [destination, setDestination] = useState(4);
  const [laneCount, setLaneCount] = useState(4);
  const [inflow, setInflow] = useState(4500);
  const [dataAnchor, setDataAnchor] = useState<number | null>(null);
  const [simSpeed, setSimSpeed] = useState<(typeof SPEED_STEPS)[number]>(1);
  const [running, setRunning] = useState(true);

  const [closedLanes, setClosedLanes] = useState<boolean[]>(Array(4).fill(false));
  const [speedLimit, setSpeedLimit] = useState<number | null>(null);
  const [incidentCount, setIncidentCount] = useState(0);
  const [placingIncident, setPlacingIncident] = useState(false);

  // Simulation Controls card can flip between the manual controls and an
  // (in-training) natural-language command prompt for the NLEX corridor.
  const [sideMode, setSideMode] = useState<"controls" | "command">("controls");
  const [command, setCommand] = useState("");
  const [commandNote, setCommandNote] = useState<string | null>(null);

  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);

  // Anchor the inflow default to observed NLEX volume (falls back gracefully).
  useEffect(() => {
    fetch(`${BACKEND}/api/traffic/analytics?months=12`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!j.success) return;
        const daily = j.data.kpis.totalVolume / Math.max(1, j.data.kpis.days);
        const peakHourly = Math.round((daily / 24) * 1.6); // peak-hour factor
        const anchored = Math.max(1500, Math.min(8000, peakHourly));
        setDataAnchor(anchored);
        setInflow(anchored);
      })
      .catch(() => {});
  }, []);

  const buildInterventions = useCallback(
    (lanes: number): Partial<Interventions> => ({
      closedLanes: Array(lanes).fill(false),
      closurePoint: SEG_LENGTH * 0.55,
      incidents: [],
      speedLimitKmh: null,
      speedZone: [SEG_LENGTH * 0.3, SEG_LENGTH * 0.8],
    }),
    []
  );

  // (Re)create the sim when structural config changes.
  const rebuild = useCallback(() => {
    simRef.current = new TrafficSim(
      { length: SEG_LENGTH, laneCount, inflowVehPerHour: inflow, seed: 12345 },
      buildInterventions(laneCount)
    );
    setClosedLanes(Array(laneCount).fill(false));
    setSpeedLimit(null);
    setIncidentCount(0);
    setBaseline(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneCount, buildInterventions]);

  useEffect(() => {
    rebuild();
  }, [rebuild]);

  // Live-apply inflow without discarding the running sim.
  useEffect(() => {
    if (simRef.current) simRef.current.cfg.inflowVehPerHour = inflow;
  }, [inflow]);

  // Live-apply interventions.
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    sim.interventions.closedLanes = closedLanes;
    sim.interventions.speedLimitKmh = speedLimit;
  }, [closedLanes, speedLimit]);

  // Animation + physics loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);
      const sim = simRef.current;
      if (!sim) return;
      const dtReal = Math.min(0.1, (now - (lastFrameRef.current || now)) / 1000);
      lastFrameRef.current = now;

      if (running) {
        // advance sim time = real time × simSpeed, in fixed steps for stability.
        // A persistent accumulator carries the sub-timestep remainder between
        // frames, so slow (1×) speeds still integrate correctly.
        simAccRef.current += dtReal * simSpeed;
        let guard = 0;
        while (simAccRef.current >= SIM_DT && guard < 60) {
          sim.step(SIM_DT);
          simAccRef.current -= SIM_DT;
          guard++;
        }
        if (guard >= 60) simAccRef.current = 0; // don't spiral if a frame stalls
        metricAccRef.current += dtReal;
        if (metricAccRef.current >= 0.25) {
          metricAccRef.current = 0;
          setMetrics(sim.metrics());
        }
      }
      render(ctx, canvas, sim);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, simSpeed]);

  // Incident placement: arm "placing" mode, then let the user click the
  // simulation to choose exactly where (which lane / how far along) the
  // incident is dropped. One accident per click — re-arm to drop another.
  const togglePlacing = () => setPlacingIncident((p) => !p);

  const placeIncidentAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!placingIncident) return;
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas || !sim) return;

    // Invert the same geometry the renderer uses to map the click back to
    // (lane, x-in-metres). Keep these formulas in sync with render().
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const L = sim.cfg.length;
    const lanes = sim.cfg.laneCount;
    const pad = 8;
    const laneH = Math.min((cssH - pad * 2) / lanes, 88);
    const roadTop = (cssH - laneH * lanes) / 2;

    const lane = Math.max(0, Math.min(lanes - 1, Math.floor((cy - roadTop) / laneH)));
    const x = Math.max(0, Math.min(L, (cx / cssW) * L));
    sim.addIncident(lane, x);
    setIncidentCount(sim.interventions.incidents.length);
    setPlacingIncident(false); // one accident per click; re-arm to drop another
  };

  // Esc leaves incident-placing mode.
  useEffect(() => {
    if (!placingIncident) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlacingIncident(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placingIncident]);

  // The natural-language command AI isn't wired up yet (still being trained),
  // so for now the prompt just acknowledges the input as a preview.
  const runCommand = () => {
    const text = command.trim();
    if (!text) return;
    setCommandNote(
      `🤖 Command received: "${text}". The AI that turns this into traffic actions is still being trained, so nothing was applied yet — natural-language control is coming soon.`
    );
  };
  const clearIncidents = () => {
    const sim = simRef.current;
    if (!sim) return;
    sim.interventions.incidents = [];
    setIncidentCount(0);
  };

  const toggleLane = (i: number) => setClosedLanes((prev) => prev.map((c, idx) => (idx === i ? !c : c)));

  const captureBaseline = () => {
    if (!metrics) return;
    setBaseline({
      avgSpeedKmh: metrics.avgSpeedKmh,
      throughputPerMin: metrics.throughputPerMin,
      longestQueueM: metrics.longestQueueM,
      co2RatePerMin: metrics.co2RatePerMin,
      avgTravelTimeS: metrics.avgTravelTimeS,
    });
  };

  const anyIntervention = closedLanes.some(Boolean) || speedLimit != null || incidentCount > 0;
  const recommendation = getRecommendation(metrics, baseline, closedLanes, incidentCount, speedLimit);
  const originExit = EXITS[Math.min(origin, EXITS.length - 1)];
  const destExit = EXITS[Math.min(destination, EXITS.length - 1)];

  return (
    <section className="ds-content sandbox-page">
      <PageHeader
        icon={Car}
        title="AI Traffic Sandbox"
        subtitle={`Agent-based what-if simulation · ${originExit?.exit_name} → ${destExit?.exit_name} corridor`}
      />

      {/* Live metric tiles */}
      <div className="sandbox-metric-row">
        <MetricTile label="Active agents" value={metrics ? fmt(metrics.activeAgents) : "…"} />
        <MetricTile
          label="Avg speed"
          value={metrics ? `${fmt(metrics.avgSpeedKmh)} km/h` : "…"}
          delta={baseline && metrics ? pctDelta(metrics.avgSpeedKmh, baseline.avgSpeedKmh) : null}
          goodWhenUp
        />
        <MetricTile
          label="Throughput"
          value={metrics ? `${fmt(metrics.throughputPerMin)}/min` : "…"}
          delta={baseline && metrics ? pctDelta(metrics.throughputPerMin, baseline.throughputPerMin) : null}
          goodWhenUp
        />
        <MetricTile
          label="Longest queue"
          value={metrics ? `${fmt(metrics.longestQueueM)} m` : "…"}
          delta={baseline && metrics ? pctDelta(metrics.longestQueueM, baseline.longestQueueM) : null}
        />
        <MetricTile
          label="CO₂ rate"
          value={metrics ? `${fmt(metrics.co2RatePerMin, 1)} kg/min` : "…"}
          delta={baseline && metrics ? pctDelta(metrics.co2RatePerMin, baseline.co2RatePerMin) : null}
        />
        <MetricTile label="Density" value={metrics ? `${fmt(metrics.densityPerKmLane)}/km/ln` : "…"} />
      </div>

      <div className="sandbox-grid" style={{ marginTop: 14 }}>
        {/* Simulation canvas + recommendation */}
        <article className="sandbox-main">
          <div className="sandbox-head">
            <h2>Traffic Simulation</h2>
            <div>
              <div className="sandbox-speed-seg">
                {SPEED_STEPS.map((s) => (
                  <button key={s} className={simSpeed === s ? "active" : ""} onClick={() => setSimSpeed(s)}>
                    {s}×
                  </button>
                ))}
              </div>
              <button className="btn-primary" onClick={() => setRunning((r) => !r)}>
                {running ? "Pause" : "Play"}
              </button>
              <button className="btn-muted" onClick={rebuild}>
                Reset
              </button>
            </div>
          </div>

          <canvas
            ref={canvasRef}
            className={`sandbox-canvas ${placingIncident ? "placing" : ""}`}
            onClick={placeIncidentAt}
          />

          <div className="sandbox-legend">
            <span><i style={{ background: CLASS_META[1].color }} /> Class 1 · light</span>
            <span><i style={{ background: CLASS_META[2].color }} /> Class 2 · medium</span>
            <span><i style={{ background: CLASS_META[3].color }} /> Class 3 · heavy</span>
            <span><i style={{ background: "#dc2626" }} /> stopped / incident</span>
          </div>

          <div className={`sandbox-reco ${recommendation.tone}`}>
            <strong>Prescriptive recommendation</strong>
            <p>{recommendation.text}</p>
          </div>
        </article>

        {/* Controls */}
        <aside className="sandbox-side">
          <div className="sandbox-side-head">
            <h2>{sideMode === "command" ? "Command Prompt" : "Simulation Controls"}</h2>
            <div className="sandbox-mode-seg" role="tablist">
              <button
                role="tab"
                aria-selected={sideMode === "controls"}
                className={sideMode === "controls" ? "active" : ""}
                onClick={() => setSideMode("controls")}
              >
                Controls
              </button>
              <button
                role="tab"
                aria-selected={sideMode === "command"}
                className={sideMode === "command" ? "active" : ""}
                onClick={() => setSideMode("command")}
              >
                Command
              </button>
            </div>
          </div>

          {sideMode === "controls" ? (
          <div className="sandbox-side-scroll">
          <div className="sandbox-section-title">Corridor</div>
          <label>
            Origin
            <select value={origin} onChange={(e) => setOrigin(Number(e.target.value))}>
              {EXITS.map((ex, i) => (
                <option key={ex.exit_id} value={i} disabled={i >= destination}>
                  {ex.exit_name} (Km {ex.km})
                </option>
              ))}
            </select>
          </label>
          <label>
            Destination
            <select value={destination} onChange={(e) => setDestination(Number(e.target.value))}>
              {EXITS.map((ex, i) => (
                <option key={ex.exit_id} value={i} disabled={i <= origin}>
                  {ex.exit_name} (Km {ex.km})
                </option>
              ))}
            </select>
          </label>

          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">Inflow</span>
              <span className="sandbox-slider-value" style={{ color: "var(--brand-primary)" }}>{fmt(inflow)} veh/hr</span>
            </div>
            <input
              type="range"
              min={1000}
              max={8000}
              step={100}
              value={inflow}
              onChange={(e) => setInflow(Number(e.target.value))}
              className="sandbox-range inflow"
              style={{ "--range-pct": `${((inflow - 1000) / 7000) * 100}%` } as React.CSSProperties}
            />
            <span className="sandbox-slider-hint">
              {dataAnchor ? `Observed NLEX peak ≈ ${fmt(dataAnchor)} veh/hr` : "Vehicle entry rate"}
            </span>
          </div>

          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">Lanes</span>
              <span className="sandbox-slider-value" style={{ color: "#16a34a" }}>{laneCount}</span>
            </div>
            <input
              type="range"
              min={2}
              max={5}
              step={1}
              value={laneCount}
              onChange={(e) => setLaneCount(Number(e.target.value))}
              className="sandbox-range lanes"
              style={{ "--range-pct": `${((laneCount - 2) / 3) * 100}%` } as React.CSSProperties}
            />
            <span className="sandbox-slider-hint">Changing lanes resets the run</span>
          </div>

          <div className="sandbox-section-title">Interventions</div>

          <span className="sandbox-mini-label">Close a lane (traffic must merge out)</span>
          <div className="sandbox-lane-toggles">
            {Array.from({ length: laneCount }, (_, i) => (
              <button key={i} className={closedLanes[i] ? "closed" : ""} onClick={() => toggleLane(i)}>
                L{i + 1}
              </button>
            ))}
          </div>

          <div className="sandbox-btn-row">
            <button
              className={`btn-muted ${placingIncident ? "active" : ""}`}
              onClick={togglePlacing}
            >
              {placingIncident ? "Placing… (click map)" : "Drop incident"}
            </button>
            <button className="btn-muted" onClick={clearIncidents} disabled={incidentCount === 0}>
              Clear ({incidentCount})
            </button>
          </div>
          {placingIncident && (
            <p className="sandbox-place-hint">
              Click a lane on the simulation to drop an incident · Esc to cancel
            </p>
          )}

          <div className="sandbox-slider-group">
            <div className="sandbox-slider-header">
              <span className="sandbox-slider-label">Speed limit zone</span>
              <span className="sandbox-slider-value" style={{ color: "#ea580c" }}>
                {speedLimit == null ? "off" : `${speedLimit} km/h`}
              </span>
            </div>
            <input
              type="range"
              min={20}
              max={100}
              step={5}
              value={speedLimit ?? 100}
              onChange={(e) => setSpeedLimit(Number(e.target.value) >= 100 ? null : Number(e.target.value))}
              className="sandbox-range capacity"
              style={{ "--range-pct": `${(((speedLimit ?? 100) - 20) / 80) * 100}%` } as React.CSSProperties}
            />
            <span className="sandbox-slider-hint">Slide to 100 to disable</span>
          </div>

          <div className="sandbox-section-title">Baseline comparison</div>
          <p className="sandbox-mini-label" style={{ marginTop: 0 }}>
            Capture a baseline with no interventions, then apply changes to see the deltas above.
          </p>
          <div className="sandbox-btn-row">
            <button className="btn-primary" onClick={captureBaseline} disabled={!metrics} style={{ marginLeft: 0 }}>
              Capture baseline
            </button>
            {baseline && (
              <button className="btn-muted" onClick={() => setBaseline(null)}>
                Clear
              </button>
            )}
          </div>
          {baseline && (
            <p className="sandbox-baseline-note">
              Baseline: {fmt(baseline.avgSpeedKmh)} km/h · {fmt(baseline.throughputPerMin)}/min
              {anyIntervention ? " · comparing against current interventions" : " · no interventions applied yet"}
            </p>
          )}
          </div>
          ) : (
          <div className="sandbox-side-scroll">
            <div className="ai-command">
              <p className="ai-command-sub">
                Type natural-language commands to control traffic on the NLEX corridor.
              </p>
              <textarea
                className="ai-command-input"
                rows={4}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={'Try: "From Balintawak close lane 4" or "Set 2 lanes open"'}
              />
              <button
                className="ai-command-btn"
                onClick={runCommand}
                disabled={!command.trim()}
              >
                Execute Command
              </button>
              {commandNote && <p className="ai-command-note">{commandNote}</p>}
            </div>
          </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function MetricTile({
  label,
  value,
  delta,
  goodWhenUp,
}: {
  label: string;
  value: string;
  delta?: number | null;
  goodWhenUp?: boolean;
}) {
  let cls = "";
  if (delta != null && Math.abs(delta) >= 1) {
    const positive = delta > 0;
    const good = goodWhenUp ? positive : !positive;
    cls = good ? "up" : "down";
  }
  return (
    <article className="sandbox-metric">
      <h3>{label}</h3>
      <div className="sandbox-metric-val">{value}</div>
      {delta != null && Math.abs(delta) >= 1 ? (
        <span className={`sandbox-metric-delta ${cls}`}>
          {delta > 0 ? "+" : ""}
          {delta.toFixed(0)}% vs baseline
        </span>
      ) : (
        <span className="sandbox-metric-delta muted">{delta != null ? "≈ baseline" : " "}</span>
      )}
    </article>
  );
}

function pctDelta(cur: number, base: number): number | null {
  if (base <= 0.001) return null;
  return ((cur - base) / base) * 100;
}

function getRecommendation(
  m: Metrics | null,
  base: Baseline | null,
  closedLanes: boolean[],
  incidents: number,
  speedLimit: number | null
): { text: string; tone: "good" | "warn" | "bad" } {
  if (!m) return { text: "Warming up the simulation…", tone: "good" };
  const closed = closedLanes.filter(Boolean).length;
  const speedDrop = base ? (base.avgSpeedKmh - m.avgSpeedKmh) / Math.max(1, base.avgSpeedKmh) : 0;

  if (incidents > 0 && m.longestQueueM > 120) {
    return {
      text: `An incident is holding back a ${fmt(m.longestQueueM)} m queue and average speed is ${fmt(m.avgSpeedKmh)} km/h. Deploy responders to clear it before the queue spills upstream.`,
      tone: "bad",
    };
  }
  if (closed > 0 && (m.avgSpeedKmh < 20 || speedDrop > 0.3)) {
    return {
      text: `With ${closed} lane${closed > 1 ? "s" : ""} closed, flow has collapsed to ${fmt(m.avgSpeedKmh)} km/h${base ? ` (${(speedDrop * 100).toFixed(0)}% below baseline` : ""}${base ? ")" : ""}. Reopen a lane or schedule this closure during off-peak demand.`,
      tone: "bad",
    };
  }
  if (m.stoppedCount > 6 || m.longestQueueM > 80) {
    return {
      text: `Congestion is building — ${m.stoppedCount} vehicles stopped, queue ${fmt(m.longestQueueM)} m. Consider opening an additional toll/travel lane or metering inflow upstream.`,
      tone: "warn",
    };
  }
  if (speedLimit != null && m.avgSpeedKmh > 40) {
    return {
      text: `The ${speedLimit} km/h zone is holding flow smooth at ${fmt(m.avgSpeedKmh)} km/h with throughput ${fmt(m.throughputPerMin)}/min. Configuration is stable.`,
      tone: "good",
    };
  }
  return {
    text: `Flow is stable at ${fmt(m.avgSpeedKmh)} km/h and ${fmt(m.throughputPerMin)} vehicles/min clearing the segment. Maintain the current configuration.`,
    tone: "good",
  };
}

// --------------------------------------------------------------------------
// Canvas rendering — pure draw from sim state, no mutation.
// --------------------------------------------------------------------------
function render(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, sim: TrafficSim) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const L = sim.cfg.length;
  const lanes = sim.cfg.laneCount;
  const pad = 8;
  // Let lanes grow to fill the taller canvas. Vehicle length and width are
  // bounded independently below (true-to-scale), so lanes just gain breathing
  // room instead of stretching the cars. The cap only prevents absurdly tall
  // lanes on very large screens.
  const laneH = Math.min((cssH - pad * 2) / lanes, 88);
  const roadH = laneH * lanes;
  const roadTop = (cssH - roadH) / 2;
  const mToPx = cssW / L;
  const xPx = (x: number) => x * mToPx;

  // asphalt
  ctx.fillStyle = "#20293a";
  roundRect(ctx, 0, roadTop, cssW, roadH, 10);
  ctx.fill();

  // speed-limit zone
  if (sim.interventions.speedLimitKmh != null) {
    const [z0, z1] = sim.interventions.speedZone;
    ctx.fillStyle = "rgba(234,88,12,0.16)";
    ctx.fillRect(xPx(z0), roadTop, xPx(z1 - z0), roadH);
  }

  // lane dividers
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([14, 14]);
  for (let l = 1; l < lanes; l++) {
    const y = roadTop + l * laneH;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cssW, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // closed-lane hatching + taper
  for (let l = 0; l < lanes; l++) {
    if (!sim.interventions.closedLanes[l]) continue;
    const y = roadTop + l * laneH;
    const x0 = xPx(sim.interventions.closurePoint);
    ctx.fillStyle = "rgba(220,38,38,0.28)";
    ctx.fillRect(x0, y, cssW - x0, laneH);
    ctx.strokeStyle = "rgba(255,120,120,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x0, y + laneH / 2);
    ctx.lineTo(x0 + 14, y + 4);
    ctx.moveTo(x0, y + laneH / 2);
    ctx.lineTo(x0 + 14, y + laneH - 4);
    ctx.stroke();
  }

  // vehicles — top-down sprites, front facing the direction of travel (right).
  // Length is true-to-scale; width uses the true vehicle width with a small
  // exaggeration for legibility, capped to the lane. This keeps a car longer
  // than it is wide and keeps stopped vehicles from overlapping.
  const minLen: Record<number, number> = { 1: 14, 2: 26, 3: 40 };
  const widthM: Record<number, number> = { 1: 1.9, 2: 2.5, 3: 2.6 };
  // Keep the length scale modest so queued sprites don't overhang into each
  // other (cars are spaced by their *physical* length): a bigger factor here
  // reads as an overlapping pile rather than a line. Width can be exaggerated
  // more for legibility since it doesn't affect car-following spacing.
  const lenScale = 1.25;
  const widScale = 1.6;
  for (const v of sim.vehicles) {
    const y = roadTop + v.lane * laneH + laneH * 0.5;
    const len = Math.max(minLen[v.vClass], v.length * mToPx) * lenScale;
    const wid = Math.min(laneH * 0.82, widthM[v.vClass] * mToPx * 1.7 * widScale);
    drawVehicle(ctx, xPx(v.x), y, len, wid, v.vClass, v.color, v.v < 3);
  }

  // incidents
  for (const inc of sim.interventions.incidents) {
    const y = roadTop + inc.lane * laneH + laneH * 0.5;
    ctx.fillStyle = "#dc2626";
    ctx.beginPath();
    ctx.arc(xPx(inc.x), y, Math.min(8, laneH * 0.32), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 10px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("!", xPx(inc.x), y);
  }

  // direction arrow
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "10px system-ui";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("▶ traffic flow", 8, roadTop + 4);
}

// Top-down vehicle sprite. Local frame: front (nose) at x=0, body extends to
// -len (behind). Class 1 = car, 2 = bus, 3 = articulated semi.
function drawVehicle(
  ctx: CanvasRenderingContext2D,
  xFront: number,
  yCenter: number,
  len: number,
  wid: number,
  vClass: 1 | 2 | 3,
  color: string,
  slow: boolean
) {
  const glass = "rgba(196,220,255,0.92)";
  const headlight = "#fff3b0";
  const brake = slow ? "#ff4d4d" : "#c62828";
  ctx.save();
  ctx.translate(xFront, yCenter);

  // soft shadow
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  roundRect(ctx, -len, -wid / 2 + 2.5, len, wid, Math.min(5, wid / 2));
  ctx.fill();

  if (vClass === 3) {
    // ---- articulated semi: trailer (back) + cab (front) ----
    const cabLen = len * 0.3;
    const trailerLen = len * 0.62;
    const gap = len * 0.08;
    // trailer — light tint of this agent's own colour so the whole rig matches
    ctx.fillStyle = mixHex(color, "#ffffff", 0.6);
    roundRect(ctx, -len, -wid / 2, trailerLen, wid, 3);
    ctx.fill();
    ctx.strokeStyle = mixHex(color, "#0b1226", 0.25);
    ctx.lineWidth = 1;
    ctx.stroke();
    // cab
    ctx.fillStyle = color;
    roundRect(ctx, -cabLen, -wid / 2, cabLen, wid, 4);
    ctx.fill();
    // windshield across the cab front
    ctx.fillStyle = glass;
    roundRect(ctx, -cabLen * 0.42, -wid / 2 + 2, cabLen * 0.32, wid - 4, 1.5);
    ctx.fill();
    // coupling gap line
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.moveTo(-trailerLen + gap * 0.5, -wid / 2);
    ctx.lineTo(-trailerLen + gap * 0.5, wid / 2);
    ctx.stroke();
    // lights
    ctx.fillStyle = headlight;
    dot(ctx, -1.5, -wid / 2 + 2.5, 1.4);
    dot(ctx, -1.5, wid / 2 - 2.5, 1.4);
    ctx.fillStyle = brake;
    ctx.fillRect(-len, -wid / 2 + 1.5, 1.8, 2.4);
    ctx.fillRect(-len, wid / 2 - 3.9, 1.8, 2.4);
    ctx.restore();
    return;
  }

  // ---- car / bus body ----
  ctx.fillStyle = color;
  roundRect(ctx, -len, -wid / 2, len, wid, vClass === 1 ? Math.min(6, wid / 2) : 3);
  ctx.fill();

  // subtle roof highlight
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  roundRect(ctx, -len * 0.72, -wid / 2 + 1.5, len * 0.5, wid - 3, 2);
  ctx.fill();

  if (vClass === 1) {
    // windshield (front) + rear window
    ctx.fillStyle = glass;
    roundRect(ctx, -len * 0.34, -wid / 2 + 2, len * 0.2, wid - 4, 1.5);
    ctx.fill();
    roundRect(ctx, -len * 0.82, -wid / 2 + 2.5, len * 0.14, wid - 5, 1.5);
    ctx.fill();
  } else {
    // bus: front windshield + a run of side windows
    ctx.fillStyle = glass;
    roundRect(ctx, -len * 0.2, -wid / 2 + 2, len * 0.12, wid - 4, 1.5);
    ctx.fill();
    ctx.fillStyle = "rgba(196,220,255,0.6)";
    const n = 4;
    for (let i = 0; i < n; i++) {
      const wx = -len * 0.3 - i * (len * 0.13);
      roundRect(ctx, wx, -wid / 2 + 2.5, len * 0.08, wid - 5, 1);
      ctx.fill();
    }
  }

  // head / tail lights
  ctx.fillStyle = headlight;
  dot(ctx, -1.5, -wid / 2 + 2.5, 1.4);
  dot(ctx, -1.5, wid / 2 - 2.5, 1.4);
  ctx.fillStyle = brake;
  ctx.fillRect(-len, -wid / 2 + 1.5, 1.8, 2.4);
  ctx.fillRect(-len, wid / 2 - 3.9, 1.8, 2.4);

  ctx.restore();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
