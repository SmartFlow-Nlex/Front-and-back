"use client";

import { useState, useEffect, useMemo } from "react";
import { ChevronDown, Clock, Map, Maximize2, Milestone, Navigation, Search, ZoomIn, ZoomOut } from "lucide-react";
import type { Feature } from "geojson";
import TrafficMapPanel from "../../../components/maps/TrafficMapPanel";
import ForecastExpandModal from "../../../components/maps/ForecastExpandModal";
import ForecastHorizonPicker, { type HorizonRangeKey } from "../../../components/maps/ForecastHorizonPicker";
import { useChartTheme } from "../../../lib/chart-theme";
import { mapPalette } from "../../../lib/map-palette";
import WazeLiveModal from "../../../components/maps/WazeLiveModal";
import MapLegend, { FORECAST_KEY } from "../../../components/maps/MapLegend";
import PageHeader from "../../../components/dashboard/PageHeader";
import { cachedJson } from "../../../lib/cached-json";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

import { displayExitName, FALLBACK_EXITS, useNlexExits, type NlexExit } from "../../../lib/nlex-exits";
import { corridorGuard, type LngLat } from "../../../lib/corridor-shape";
import { isActiveReport, WAZE_REPORT_TYPES } from "../../../lib/waze-reports";
import { lookOf } from "../../../lib/waze-report-look";
import nlexGeometry from "../../../components/maps/nlex-geometry.json";

/* The same test the map uses, so the counters below cannot disagree with what
   is drawn. Built once at module scope because it is derived from static
   geometry and costs a few milliseconds. */
const CORRIDOR = corridorGuard(
  (nlexGeometry as unknown as { coordinates: LngLat[] }).coordinates,
  [...FALLBACK_EXITS].sort((a, b) => a.km - b.km).map((e) => [e.longitude, e.latitude] as LngLat),
);

type ExitHit = NlexExit;

export default function MapComparisonPage() {
  const [wazeMax, setWazeMax] = useState(false);
  const [forecastMax, setForecastMax] = useState(false);
  const { isDark } = useChartTheme();
  const forecastColours = mapPalette(isDark).level;
  /* What produced the forecast, fetched with it. The panel drew model output
     but said nothing about the model, so a reader had no way to tell a
     prediction from a decoration. */
  /** How far ahead the map is showing. The endpoint takes hours_ahead, so this
   *  is the one piece of state the forecast panel needs. */
  const [horizon, setHorizon] = useState(1);
  const [horizonRange, setHorizonRange] = useState<HorizonRangeKey>("12h");

  const [forecastModel, setForecastModel] = useState<{
    name: string | null;
    accuracy: number | null;
    trainedAt: string | null;
    rejectedCount: number;
    horizonVaries: boolean;
    horizons: number;
    minHorizon: number | null;
    /** What the warehouse can answer, which is not what the model could serve:
     *  the pipeline writes as many hours ahead as it was asked for. */
    maxHorizon: number | null;
  } | null>(null);

  const [activeReports, setActiveReports] = useState<number | null>(null);
  const [avgSpeed, setAvgSpeed] = useState<number | null>(null);
  const [timeStr, setTimeStr] = useState("");

  // Exit picker. The whole corridor is loaded once and shown as a dropdown in
  // geographic order (Balintawak in the south through to Sta. Ines in the
  // north), so the list itself tells you where along NLEX you are.
  // Same corridor list as the dashboard road map, AI sandbox and maintenance.
  const { exits } = useNlexExits();
  const [selectedExit, setSelectedExit] = useState<string>("");
  const [exitOpen, setExitOpen] = useState(false);

  const flyToExit = (x: ExitHit) => {
    setSelectedExit(x.exit_name);
    setExitOpen(false);
    window.dispatchEvent(
      new CustomEvent("nlex:flyto", {
        detail: { lng: Number(x.longitude), lat: Number(x.latitude), name: x.exit_name },
      })
    );
  };

  const resetView = () => {
    setSelectedExit("");
    setExitOpen(false);
    window.dispatchEvent(new CustomEvent("nlex:resetview"));
  };

  // Live running clock
  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      setTimeStr(
        now.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        })
      );
    };
    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    cachedJson<{ model?: unknown }>(`${BACKEND}/api/map-comparison/forecast?hours=1`, 10 * 60_000)
      .then((j) => { if (!cancelled && j?.model) setForecastModel(j.model as never); })
      .catch(() => {/* the panel simply says nothing about the model */});
    return () => { cancelled = true; };
  }, []);

  // Poll real-time Waze data to update stats
  useEffect(() => {
    async function fetchStats() {
      try {
        // Shared with the Home corridor panel through the same memo.
        const geojson = await cachedJson<{ features?: Feature[] }>(`${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000"}/api/map-comparison/real-time`, 25_000);
        if (geojson && geojson.features) {
          const features = geojson.features as Feature[];

          /* Only what is actually on NLEX. The feed is polled over a bounding
             box, so counting it whole reported the surrounding road network as
             corridor activity: every alert in a sample was off the corridor,
             the nearest by 334 m, and three of seven jams sat on Pulilan
             Regional Road up to 1.4 km away. */
          const onNlex = features.filter((f: Feature) => CORRIDOR.onCorridor(f));

          /* Reports, not density. A jam line measures how fast the road is
             moving and belongs to the colour of the corridor; an alert is
             somebody reporting something. Counting both added two different
             units together. Only the five categories the legend names count --
             see lib/waze-reports.ts. */
/* On the corridor and of a counted type. Both halves matter: the
             feed carries reports branded NLEX that sit up to 1.8 km off the
             road, on spurs and entries. */
          const alertCount = onNlex.filter((f: Feature) => isActiveReport(f)).length;

          const jams = onNlex.filter(
            (f: Feature) =>
              f.properties &&
              f.properties.feature_type === "jam" &&
              Number(f.properties.speed) > 0
          );
          
          /* No jams means nothing to average, not 45 km/h. The old fallback
             was an invented number sitting in a tile labelled as live. */
          let averageSpeed: number | null = null;
          if (jams.length > 0) {
            const sumSpeed = jams.reduce(
              (sum: number, j: Feature) => sum + Number(j.properties?.speed || 0),
              0
            );
            averageSpeed = Math.round(sumSpeed / jams.length);
          }

          setActiveReports(alertCount);
          setAvgSpeed(averageSpeed);
        }
      } catch (error) {
        console.error("Failed to fetch live stats from real-time Waze endpoint:", error);
      }
    }

    fetchStats();
    // Poll every 15 seconds to match Mapbox layer refresh
    const interval = setInterval(fetchStats, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="ds-content ds-long">
      <PageHeader
        icon={Map}
        title="Traffic Map Comparison"
        subtitle="Side-by-side live traffic sources across the NLEX corridor"
        actions={
          <div className="mc-search-bar" style={{ position: "relative", cursor: "pointer" }}>
            <Milestone size={16} />
            <button
              type="button"
              onClick={() => setExitOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={exitOpen}
              style={{
                flex: 1, display: "flex", alignItems: "center", gap: "8px",
                border: "none", background: "transparent", cursor: "pointer",
                font: "inherit", color: selectedExit ? "#0f172a" : "#94a3b8",
                textAlign: "left", padding: 0,
              }}
            >
              {selectedExit || "Jump to exit…"}
              <ChevronDown size={14} style={{ marginLeft: "auto", flexShrink: 0, color: "#64748b" }} />
            </button>

            {exitOpen && (
              <ul
                role="listbox"
                style={{
                  position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 30,
                  margin: 0, padding: "4px", listStyle: "none", maxHeight: "320px", overflowY: "auto",
                  background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef",
                  borderRadius: "10px", boxShadow: "0 8px 24px rgba(15,23,42,0.12)",
                }}
              >
                <li>
                  <button
                    onClick={resetView}
                    style={{
                      display: "flex", width: "100%", alignItems: "center", gap: "8px",
                      padding: "8px 12px", border: "none", background: "transparent",
                      textAlign: "left", cursor: "pointer", borderRadius: "6px",
                      fontSize: "0.85rem", color: "#64748b", borderBottom: "1px solid #eef2f7",
                    }}
                  >
                    Whole corridor
                  </button>
                </li>
                {exits.length === 0 ? (
                  <li style={{ padding: "10px 12px", fontSize: "0.85rem", color: "#64748b" }}>
                    Exit list unavailable
                  </li>
                ) : (
                  exits.map((x) => {
                    const on = x.exit_name === selectedExit;
                    return (
                      <li key={x.exit_id} role="option" aria-selected={on}>
                        <button
                          onClick={() => flyToExit(x)}
                          style={{
                            display: "flex", width: "100%", alignItems: "baseline", gap: "8px",
                            padding: "8px 12px", border: "none", cursor: "pointer",
                            borderRadius: "6px", fontSize: "0.88rem", textAlign: "left",
                            background: on ? "#eef2fb" : "transparent",
                            fontWeight: on ? 700 : 500, color: "#0f172a",
                          }}
                        >
                          <span style={{
                            fontSize: "0.7rem", color: "var(--text-muted)", minWidth: "1.4rem",
                            fontVariantNumeric: "tabular-nums",
                          }}>{x.exit_id}</span>
                          {displayExitName(x.exit_name)}
                          <span style={{ marginLeft: "auto", fontSize: "0.72rem", color: "var(--text-muted)" }}>
                            Km {x.km}
                          </span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            )}
          </div>
        }
      />

      <div className="map-grid mc-map-grid">
        {/* Left Map: Waze Real-Time */}
        <div className="mc-panel-wrapper">
          <TrafficMapPanel
            title="Waze Real-Time Traffic"
            subtitle="Live traffic conditions"
            badge={
              <>
                <i className="mc-dot green" style={{ display: "inline-block", marginRight: "6px", verticalAlign: "middle" }}></i>
                LIVE | {timeStr || "Loading..."}
                <button
                  type="button"
                  className="mc-maximise"
                  style={{ marginLeft: 10 }}
                  onClick={() => setWazeMax(true)}
                >
                  <Maximize2 size={13} /> Expand
                </button>
              </>
            }
            endpoint={`${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000"}/api/map-comparison/real-time`}
            layerColor="#4a6ff2"
            tone="blue"
            paused={wazeMax}
          >

            {/* Waze Legend Overlay */}
            {/* One legend, shared with the maximised view — see
                components/maps/MapLegend.tsx. This used to be written out by
                hand here, with four densities in colours that were not the
                map's and no Standstill at all. */}
            <details className="mc-legend-card waze-legend">
              <summary>Legend</summary>
              <MapLegend />
            </details>
          </TrafficMapPanel>

          {/* Waze Footer Stats */}
          <div className="mc-footer-stats">
            <div className="mc-stat-item">
              <span className="mc-stat-label">Toll Plazas</span>
              <span className="mc-stat-value blue">20</span>
            </div>
            <div className="mc-stat-item">
              <span className="mc-stat-label">Active Reports</span>
              <span className="mc-stat-value red">{activeReports ?? "\u2014"}</span>
            </div>
            <div className="mc-stat-item">
              <span className="mc-stat-label">Avg Speed</span>
              <span className="mc-stat-value orange">{avgSpeed == null ? "\u2014" : `${avgSpeed} km/h`}</span>
            </div>
          </div>
        </div>

        {/* Right Map: Forecasted Traffic */}
        <div className="mc-panel-wrapper">
          <TrafficMapPanel
            title="Forecasted Traffic"
            subtitle="Predictive analysis"
            badge={
              <>
                PREDICTED
                <button
                  type="button"
                  className="mc-maximise"
                  style={{ marginLeft: 10 }}
                  onClick={() => setForecastMax(true)}
                >
                  <Maximize2 size={13} /> Expand
                </button>
              </>
            }
            endpoint={`${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000"}/api/map-comparison/forecast?hours=${horizon}`}
            layerColor="#a855f7"
            tone="purple"
          >
            {/* Forecast Controls Overlay */}
            <div className="mc-forecast-controls">
              <ForecastHorizonPicker
                horizon={horizon}
                setHorizon={setHorizon}
                range={horizonRange}
                setRange={setHorizonRange}
                maxHorizon={forecastModel?.maxHorizon ?? null}
              />

              <div className="mc-model-card">
                <span className="mc-model-head">
                  <Clock size={13} className="mc-purple-text" /> Forecast model
                </span>
                {forecastModel?.name ? (
                  <>
                    <span className="mc-model-name">
                      {forecastModel.name}
                      {forecastModel.accuracy != null && (
                        <em>{Math.round(forecastModel.accuracy * 100)}% accurate</em>
                      )}
                    </span>
                    <span className="mc-model-note">
                      {forecastModel.trainedAt
                        ? `Trained ${new Date(forecastModel.trainedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`
                        : "Training date unknown"}
                      {forecastModel.rejectedCount > 0 && ` · beat ${forecastModel.rejectedCount} others`}
                    </span>
                    {/* Said plainly rather than implied by a control that
                        cannot change anything. */}
                    <span className="mc-model-note">
                      {forecastModel.horizonVaries
                        ? `Varies across ${forecastModel.horizons} h ahead`
                        : "Same outlook for every hour ahead"}
                    </span>
                  </>
                ) : (
                  <span className="mc-model-note">Model details unavailable</span>
                )}
              </div>
              <button className="mc-icon-btn"><Navigation size={18} className="mc-purple-text" /></button>
              <div className="mc-zoom-group">
                <button className="mc-icon-btn"><ZoomIn size={18} className="mc-purple-text" /></button>
                <button className="mc-icon-btn"><ZoomOut size={18} className="mc-purple-text" /></button>
              </div>
            </div>

            {/* Forecast Legend Overlay */}
            <details className="mc-legend-card forecast-legend">
              <summary>Legend</summary>
              <div className="mc-legend-section">
                <p className="mc-sub-label">Predicted congestion</p>
                {FORECAST_KEY.map((k) => (
                  <div key={k.state} className="mc-density-row">
                    {/* Straight from the palette the map draws with, so the key
                        cannot describe a different map to the one beside it. */}
                    <span
                      className="mc-density-line"
                      style={{ background: forecastColours[k.level] }}
                    />
                    {k.label}
                  </div>
                ))}
              </div>
              <div className="mc-legend-section mt-3">
                <p className="mc-sub-label">On the map</p>
                <div className="mc-density-row">
                  <span className="mc-legend-pin" aria-hidden="true" /> NLEX exit
                </div>
              </div>
            </details>

          </TrafficMapPanel>

          {/* Forecast Footer Stats */}
          <div className="mc-footer-stats">
            <div className="mc-stat-item">
              <span className="mc-stat-label">NLEX Exits</span>
              <span className="mc-stat-value purple">20</span>
            </div>
            <div className="mc-stat-item">
              <span className="mc-stat-label">ML Confidence</span>
              <span className="mc-stat-value green">
                {forecastModel?.accuracy == null
                  ? "\u2014"
                  : `${Math.round(forecastModel.accuracy * 100)}%`}
              </span>
            </div>
            <div className="mc-stat-item">
              <span className="mc-stat-label">Forecast Window</span>
              <span className="mc-stat-value purple">{`+${horizon} h`}</span>
            </div>
          </div>
        </div>

      </div>

      <WazeLiveModal open={wazeMax} onClose={() => setWazeMax(false)} />

      {/* Handed the page's own horizon state, so expanding shows the same hour
          and changing the hour in either place moves both. */}
      <ForecastExpandModal
        open={forecastMax}
        onClose={() => setForecastMax(false)}
        horizon={horizon}
        setHorizon={setHorizon}
        range={horizonRange}
        setRange={setHorizonRange}
        maxHorizon={forecastModel?.maxHorizon ?? null}
        model={forecastModel}
      />
    </section>
  );
}

