"use client";

import { useEffect, useState } from "react";
import { mapPalette } from "../../lib/map-palette";
import { useChartTheme } from "../../lib/chart-theme";
import { AlertCircle, Clock, Gauge, RefreshCw, TrendingUp, X } from "lucide-react";
import TrafficMapPanel from "./TrafficMapPanel";
import { WAZE_REPORT_TYPES } from "../../lib/waze-reports";
// Shared with the map markers and the collapsed legend, so all three
// name and draw a report the same way.
import { lookOf } from "../../lib/waze-report-look";
import MapLegend from "./MapLegend";
// The same reading of a Waze street name the map uses to put a jam on the
// right carriageway, so a row and a ribbon never disagree about direction.
import { directionFromStreet } from "../../lib/corridor-shape";

/**
 * Maximised view of the Waze panel.
 *
 * The sidebar is fed by /api/map-comparison/live-overview, which reads the
 * warehouse rather than Redis — the Redis keys behind /real-time authenticate
 * but hold zero records, so a sidebar built on them would render zeros while the
 * same feed lands in silver.fact_waze_jams every few minutes.
 *
 * Every figure below is measured. Where one could not be derived it is not shown:
 * there is no end-to-end travel time here, because that needs a free-flow speed
 * and the jam feed only ever observes congested traffic.
 */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type Overview = {
  windowMinutes: number;
  speed: { avgInJamsKmh: number | null; slowestKmh: number | null };
  delay: { seconds: number; jamMetres: number };
  activeReports: number;
  jamCount: number;
  worstLevel: number | null;
  exits: { exit: string; avgSpeedKmh: number; worstLevel: number; jams: number; delaySeconds: number }[];
  slowestExit: { exit: string; avgSpeedKmh: number; jams: number } | null;
  alerts: {
    type: string; street: string | null; city: string | null;
    nearestExit: string; minutesAgo: number | null; reliability: number | null;
    // Carried so a row can hand the map a position and the same record the pin
    // shows. metresFromExit is named for the panel's "N m away" line.
    uuid: string | null; lon: number | null; lat: number | null;
    subtype: string | null; confidence: number | null; reportRating: number | null;
    roadType: number | null; byMunicipality: boolean | null; heading: number | null;
    metresFromExit: number | null; publishedAt: string | null;
  }[];
  timeline: { at: string; avgSpeedKmh: number; jams: number }[];
  feed: { jamsAgeMinutes: number | null; alertsAgeMinutes: number | null; stale: boolean };
};

/** Waze alert types, mapped to the icon and tone the legend uses. */


/**
 * Where a report is, in words that actually distinguish it.
 *
 * The row used to read "{street} · near {exit}", and on this corridor the street
 * is the same 76 km road for every report — "E1: North Luzon Expressway N" — so
 * the only thing separating two rows was the timestamp. Reports 2 and 3.7 km
 * apart rendered as identical lines and read as duplicates of each other. They
 * were not: distinct uuids, distinct positions, distinct distances from their
 * nearest exit.
 *
 * Naming the carriageway and the distance from the exit puts the difference on
 * screen, and is what someone would need to find the thing anyway.
 */
function whereText(a: { street?: string | null; nearestExit?: string | null; metresFromExit?: number | null; city?: string | null }): string {
  const dir = directionFromStreet(a.street);
  const side = dir === "NB" ? "Northbound" : dir === "SB" ? "Southbound" : null;

  const m = a.metresFromExit;
  const distance =
    m == null || !Number.isFinite(m)
      ? null
      : m < 950
        ? `${Math.round(m / 10) * 10} m`
        : `${(m / 1000).toFixed(1)} km`;

  const place = a.nearestExit
    ? distance
      ? `${distance} from ${a.nearestExit}`
      : `near ${a.nearestExit}`
    : (a.street ?? a.city ?? "on the corridor");

  return side ? `${side} · ${place}` : place;
}

const agoText = (m: number | null) => (m == null ? "—" : m < 1 ? "Just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`);

/**
 * Waze jam levels and the colours the Mapbox layer paints them, kept in step by
 * hand because the two live in different files. Level is a share of free-flow
 * speed: 1 is barely slowed, 5 is a blocked road.
 */
/** Labels only — the colours come from the same palette the map paints with. */
const LEVELS = [
  { level: 1, label: "Light" },
  { level: 2, label: "Moderate" },
  { level: 3, label: "Heavy" },
  { level: 4, label: "Severe" },
  { level: 5, label: "Standstill" },
];

/** Speed bands for the sidebar's own readouts, which have no level to hand. */
function band(kmh: number): { key: string; label: string } {
  if (kmh >= 40) return { key: "light", label: "Light" };
  if (kmh >= 25) return { key: "moderate", label: "Moderate" };
  if (kmh >= 12) return { key: "heavy", label: "Heavy" };
  return { key: "severe", label: "Severe" };
}

export default function WazeLiveModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { isDark } = useChartTheme();
  const palette = mapPalette(isDark);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [clock, setClock] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BACKEND}/api/map-comparison/live-overview`, { cache: "no-store" });
      const j = await r.json();
      if (!j.success) throw new Error();
      setData(j.data);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  // Only polls while open — a hidden modal refreshing every half minute is load
  // nobody asked for.
  useEffect(() => {
    if (!open) return;
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const tick = () => setClock(new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    tick();
    const id = setInterval(tick, 1000);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { clearInterval(id); window.removeEventListener("keydown", onKey); };
  }, [open, onClose]);

  if (!open) return null;

  const avg = data?.speed.avgInJamsKmh ?? null;
  const delayMin = data ? Math.round(data.delay.seconds / 60) : null;
  const worst = data?.slowestExit ?? null;

  // Position on the density strip: where the corridor's average sits between a
  // standstill and free-flowing, so the marker is derived rather than placed.
  const densityPct = avg == null ? 0 : Math.max(0, Math.min(100, 100 - (avg / 50) * 100));

  return (
    <div className="wz-backdrop" role="dialog" aria-modal="true" aria-label="Waze real-time traffic" onClick={onClose}>
      <div className="wz-shell" onClick={(e) => e.stopPropagation()}>
        <header className="wz-head">
          <div className="wz-brand">
            <span className="wz-mark" aria-hidden="true">🚦</span>
            <div>
              <h2>Waze Real-Time Traffic</h2>
              <p>Live traffic conditions</p>
            </div>
          </div>
          <div className="wz-head-right">
            <span className={`wz-live ${data?.feed.stale ? "stale" : ""}`}>
              <i /> {data?.feed.stale ? "STALE" : "LIVE"} <b>{clock}</b>
            </span>
            <button type="button" className="wz-btn" onClick={load} disabled={loading}>
              <RefreshCw size={14} className={loading ? "wz-spin" : ""} /> Refresh
            </button>
            <button type="button" className="wz-btn wz-close" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="wz-body">
          <div className="wz-map">
            <TrafficMapPanel
              title="Waze Real-Time Traffic"
              subtitle="Live traffic conditions"
              chromeless
              endpoint={`${BACKEND}/api/map-comparison/real-time`}
              layerColor="#4a6ff2"
              tone="blue"
            >
              {/* The same component the collapsed panel uses, so the key
                  cannot describe one map in the panel and another here. */}
              <div className="wz-legend">
                <MapLegend />
              </div>
            </TrafficMapPanel>
          </div>

          <aside className="wz-side">
            <h3 className="wz-side-title">Corridor Overview</h3>

            {error ? (
              <p className="wz-empty">Live feed unavailable — is the backend running on port 4000?</p>
            ) : (
              <>
                <div className="wz-kpis">
                  <div className="wz-kpi speed">
                    <span className="wz-kpi-label">Avg speed in jams</span>
                    <span className="wz-kpi-value">{avg ?? "—"}<em>km/h</em><Gauge size={14} /></span>
                  </div>
                  <div className="wz-kpi reports">
                    <span className="wz-kpi-label">Active reports</span>
                    <span className="wz-kpi-value">{data?.activeReports ?? "—"}<AlertCircle size={14} /></span>
                  </div>
                  <div className="wz-kpi delay">
                    <span className="wz-kpi-label">Current delay</span>
                    <span className="wz-kpi-value">
                      {delayMin == null ? "—" : delayMin >= 60 ? `${Math.floor(delayMin / 60)}h ${delayMin % 60}m` : `${delayMin}m`}
                      <Clock size={14} />
                    </span>
                  </div>
                </div>

                <h4 className="wz-sec">Traffic density</h4>
                <div className="wz-density">
                  <span className="wz-density-bar" />
                  <span className="wz-density-mark" style={{ left: `${densityPct}%` }} />
                </div>
                <p className="wz-note">
                  {data && data.exits.length > 0
                    ? `${data.jamCount} jams across ${data.exits.length} exits · worst is ${band(data.exits[0].avgSpeedKmh).label.toLowerCase()}`
                    : "No jams reported on the corridor"}
                </p>

                {/* Every report, not the first six. The tile counted them all while
                    the list showed six, so the two disagreed by however many
                    were hidden — the list is the thing people read to find out
                    what the number means. It scrolls instead of truncating. */}
                <h4 className="wz-sec">
                  Current alerts{data?.alerts?.length ? ` (${data.alerts.length})` : ""}
                </h4>
                <ul className="wz-alerts">
                  {(data?.alerts ?? []).map((a, i) => {
                    const look = lookOf(a.type);
                    const Icon = look.icon;
                    /* A row is a button, not decoration: it points at a real
                       place on the map. The map owns both the camera and the
                       detail panel, so the record travels to it on an event
                       rather than being lifted into shared state here. */
                    const locatable = a.lon != null && a.lat != null;
                    return (
                      <li key={`${a.uuid ?? a.type}-${i}`}>
                        <button
                          type="button"
                          className="wz-alert-row"
                          disabled={!locatable}
                          title={locatable ? "Show this report on the map" : "Waze gave no position for this report"}
                          onClick={() => {
                            window.dispatchEvent(
                              new CustomEvent("nlex:showreport", {
                                detail: {
                                  type: a.type,
                                  subtype: a.subtype,
                                  street: a.street,
                                  city: a.city,
                                  nearest_exit: a.nearestExit,
                                  exit_distance_m: a.metresFromExit,
                                  reliability: a.reliability,
                                  confidence: a.confidence,
                                  report_rating: a.reportRating,
                                  road_type: a.roadType,
                                  by_municipality: a.byMunicipality,
                                  heading: a.heading,
                                  reported_at: a.publishedAt,
                                  uuid: a.uuid,
                                  lon: a.lon,
                                  lat: a.lat,
                                },
                              }),
                            );
                          }}
                        >
                          <span className={`wz-chip ${look.tone}`}><Icon size={12} /></span>
                          <span className="wz-alert-text">
                            <b>{look.label}</b>
                            <em>{whereText(a)}</em>
                          </span>
                          <span className="wz-alert-age">{agoText(a.minutesAgo)}</span>
                        </button>
                      </li>
                    );
                  })}
                  {data && data.alerts.length === 0 && <li className="wz-empty-row">No alerts on the corridor right now</li>}
                </ul>

                {worst && (
                  <div className="wz-worst">
                    <span className="wz-worst-head"><TrendingUp size={13} /> Slowest stretch</span>
                    <b>{worst.exit}</b>
                    <span className="wz-worst-speed">Avg speed {worst.avgSpeedKmh} km/h · {worst.jams} jam{worst.jams === 1 ? "" : "s"}</span>
                  </div>
                )}

                <p className="wz-updated">
                  Jams {agoText(data?.feed.jamsAgeMinutes ?? null).toLowerCase()} ·
                  {" "}alerts {agoText(data?.feed.alertsAgeMinutes ?? null).toLowerCase()} ·
                  {" "}{data?.windowMinutes}-min window
                </p>
              </>
            )}
          </aside>
        </div>

        {data && data.timeline.length > 1 && (
          <footer className="wz-timeline">
            <span className="wz-timeline-label">Speed in jams, last 3 hours</span>
            <div className="wz-spark">
              {data.timeline.map((t) => {
                const h = Math.max(4, Math.min(100, (t.avgSpeedKmh / 50) * 100));
                return (
                  <span
                    key={t.at}
                    className={`wz-spark-bar ${band(t.avgSpeedKmh).key}`}
                    style={{ height: `${h}%` }}
                    title={`${new Date(t.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })} · ${t.avgSpeedKmh} km/h · ${t.jams} jams`}
                  />
                );
              })}
            </div>
            <span className="wz-timeline-label">
              {new Date(data.timeline[0].at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
              {" → "}
              {new Date(data.timeline[data.timeline.length - 1].at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
            </span>
          </footer>
        )}
      </div>
    </div>
  );
}
