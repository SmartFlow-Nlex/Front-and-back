"use client";

import { useEffect, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import { shadeFor } from "./PredictiveCorridorChart";
import { fmtInt } from "./incidentPredictive.shared";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Built directly on top of the Predictive tab's own "Predicted Incidents
// Ranking" numbers, not a separately-modeled hotspot table — this panel's
// whole point is to be a solution FOR that ranking, so it reads the exact
// same corridorForecast/kmSegmentForecast /api/incident/predictive already
// returns (and PredictiveCorridorChart already renders) rather than an
// independent per-exit prediction that could show a different top corridor
// than what the user already saw. Mirrors incidentPredictive.shared.ts's
// CorridorForecastPoint/KmSegmentForecastPoint shapes; kept in sync by hand.
type CorridorForecastPoint = { exitId: number; exitName: string; km: number; predictedIncidents: number };
type KmSegmentForecastPoint = { segmentStart: number; segmentEnd: number; label: string; predictedIncidents: number };
type PredictiveSlice = {
  corridorForecast: CorridorForecastPoint[] | null;
  kmSegmentForecast: KmSegmentForecastPoint[] | null;
  corridorForecastModel: string | null;
  corridorForecastDays: number;
};

// Mirrors PredictiveCorridorChart.tsx's own independent fetch of this same
// field — see that file's doc comment for why weather-incident-risk rides a
// separate small fetch rather than threading through the predictive response.
type WeatherIncidentRisk = { auc: number | null; base_rate: number; scenarios: { rain_mm: number; probability: number }[] };

// The optimization: a Maximal Covering Location Problem (MCLP), a classic
// 0/1 integer linear program —
//   maximize   sum_i w_i * x_i
//   subject to sum_{j in N(i)} y_j >= x_i   for every demand zone i
//              sum_j y_j <= K
//              x_i, y_j in {0,1}
// where w_i is zone i's predicted-incidents weight (straight from the
// ranking above), y_j = 1 means a patrol unit is stationed at zone j,
// x_i = 1 means zone i ends up covered, K is the fleet size, and N(i) is the
// set of zones within `radiusKm` of zone i measured along the corridor
// (|km_i - km_j|, not straight-line distance — this is a roadway, not open
// terrain). Solved EXACTLY by exhaustive search over C(n, K) site
// combinations: real optimization, not a heuristic, and exact because the
// corridor only has ~20 exits (or ~16 km segments), keeping the search space
// in the thousands of combinations even at the largest fleet sizes this UI
// allows.
type Row = { key: string; label: string; km: number; predictedIncidents: number; ratePerKm: number };

function solveMclp(weights: number[], covers: number[][], k: number): { chosen: number[]; coveredWeight: number } {
  const n = weights.length;
  let best: { chosen: number[]; coveredWeight: number } = { chosen: [], coveredWeight: 0 };
  const combo: number[] = [];
  function coverageOf(sites: number[]): number {
    const covered = new Set<number>();
    for (const j of sites) for (const i of covers[j]) covered.add(i);
    let w = 0;
    for (const i of covered) w += weights[i];
    return w;
  }
  function search(start: number) {
    if (combo.length === k) {
      const w = coverageOf(combo);
      if (w > best.coveredWeight) best = { chosen: [...combo], coveredWeight: w };
      return;
    }
    if (n - start < k - combo.length) return;
    for (let j = start; j < n; j++) {
      combo.push(j);
      search(j + 1);
      combo.pop();
    }
  }
  search(0);
  return best;
}

type Props = {
  // The Prescriptive tab's own Range control, threaded through the same way
  // PredictiveIncidentChart takes it — corridorForecast's apportionment
  // shares are computed from incidents within this window (verified: the
  // per-exit split shifts a few points between 3mo/12mo/all, even though the
  // published total forecast itself doesn't), so which exits this panel
  // recommends staffing genuinely can move with Range. Defaults to 12mo,
  // this panel's original fixed window, when unset.
  months?: "3" | "12" | "all";
  from?: string;
  to?: string;
};

export default function PrescriptiveDeploymentPanel({ months = "12", from, to }: Props) {
  const [view, setView] = useState<"exit" | "km">("exit");
  const [fleetSize, setFleetSize] = useState(4);
  const [radiusKm, setRadiusKm] = useState(8);
  const [predictive, setPredictive] = useState<PredictiveSlice | null>(null);
  const [weatherRisk, setWeatherRisk] = useState<WeatherIncidentRisk | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams();
    if (months) qs.set("months", months);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    fetch(`${BACKEND}/api/incident/predictive?${qs}`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setPredictive({
          corridorForecast: json.data.corridorForecast,
          kmSegmentForecast: json.data.kmSegmentForecast,
          corridorForecastModel: json.data.corridorForecastModel,
          corridorForecastDays: json.data.corridorForecastDays,
        });
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load the predicted-incidents ranking");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    fetch(`${BACKEND}/api/incident/weather-speed`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled || !json.success) return;
        const risk = json.data?.metadata?.weather_incident_risk as WeatherIncidentRisk | undefined;
        if (risk) setWeatherRisk(risk);
      })
      .catch(() => {
        // Supplementary — the deployment map is the point of this card, so a
        // failed fetch here just omits the speed-advisory rain context.
      });
    return () => {
      cancelled = true;
    };
  }, [months, from, to]);

  if (loading && predictive === null) {
    return (
      <article className="chart-card wide" style={{ height: "320px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>Loading patrol deployment…</div>
      </article>
    );
  }

  const useKmView = view === "km" && predictive?.kmSegmentForecast != null && predictive.kmSegmentForecast.length > 0;
  const exitRows: Row[] = (predictive?.corridorForecast ?? [])
    .slice()
    .sort((a, b) => a.km - b.km)
    .map((x, i, arr) => {
      const prevKm = i > 0 ? arr[i - 1].km : null;
      const nextKm = i < arr.length - 1 ? arr[i + 1].km : null;
      const widthKm =
        prevKm != null && nextKm != null ? (nextKm - prevKm) / 2 : prevKm != null ? x.km - prevKm : nextKm != null ? nextKm - x.km : null;
      return {
        key: `exit-${x.exitId}`, label: x.exitName, km: x.km, predictedIncidents: x.predictedIncidents,
        ratePerKm: widthKm && widthKm > 0 ? x.predictedIncidents / widthKm : x.predictedIncidents,
      };
    });
  const kmRows: Row[] = (predictive?.kmSegmentForecast ?? []).map((x) => ({
    key: `seg-${x.segmentStart}`, label: x.label, km: (x.segmentStart + x.segmentEnd) / 2, predictedIncidents: x.predictedIncidents,
    ratePerKm: x.predictedIncidents / Math.max(x.segmentEnd - x.segmentStart, 1e-9),
  }));
  const rows = useKmView ? kmRows : exitRows;

  if (error || !predictive || rows.length === 0) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "440px" }}>
          <div style={{ fontWeight: 700, color: "#334155", marginBottom: "6px" }}>Patrol deployment unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            {error ?? "No Predicted Incidents Ranking data to build a deployment from — check the Predictive tab's corridor card."}
          </div>
        </div>
      </article>
    );
  }

  const clampedFleet = Math.max(1, Math.min(fleetSize, rows.length));
  const covers = rows.map((site) => rows.map((z, i) => ({ i, d: Math.abs(site.km - z.km) })).filter((x) => x.d <= radiusKm).map((x) => x.i));
  const weights = rows.map((r) => r.predictedIncidents);
  const { chosen, coveredWeight } = solveMclp(weights, covers, clampedFleet);
  const chosenSet = new Set(chosen);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const coverageShare = totalWeight > 0 ? coveredWeight / totalWeight : 0;
  const staffedCount = chosen.length;

  // 80%-evidence-coverage cutoff, same rule the ranking/secondary-risk cards
  // use: rank by the SAME quantity being accumulated (predictedIncidents —
  // the LP's own weight), not by rate/km, since rate is width-normalized and
  // would rank a zone between two closely-spaced exits "hottest" purely from
  // a small denominator.
  const byPredicted = [...rows].sort((a, b) => b.predictedIncidents - a.predictedIncidents);
  let cumulative = 0;
  const alertRows: Row[] = [];
  for (const r of byPredicted) {
    if (cumulative >= totalWeight * 0.8) break;
    alertRows.push(r);
    cumulative += r.predictedIncidents;
  }
  const byRate = [...rows].sort((a, b) => b.ratePerKm - a.ratePerKm);
  const speedAdvisoryRows = byRate.slice(0, Math.min(3, byRate.length));
  const maxRate = Math.max(...rows.map((r) => r.ratePerKm), 1e-9);

  const slider = (label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void, suffix: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: "160px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", color: "#64748b" }}>
        <span>{label}</span>
        <span style={{ fontWeight: 700, color: "#334155" }}>{value}{suffix}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: "100%", accentColor: "#4f46e5" }} />
    </div>
  );

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
        {/* A basis, so the title wraps under the controls on a narrow card
            instead of shrinking into a 110px column beside them. */}
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
            Resource Staging &amp; Patrol Repositioning
            <InfoTooltip text="A solution for the Predictive tab's own Predicted Incidents Ranking: an exact linear program (Maximal Covering Location solve) that recommends exactly where to pre-position patrol and tow-truck units — which exits or km segments to station them at — to cover as much predicted incident risk as possible, cutting response time during high-risk windows. Fleet size and coverage radius are yours to set — nothing in the warehouse records NLEX's actual patrol fleet." />
          </h3>
          <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
            Built from the {predictive.corridorForecastModel ? `${predictive.corridorForecastModel} ` : ""}
            {predictive.corridorForecastDays}-day forecast, apportioned the same way as the ranking above.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", flexShrink: 0 }}>
          <div style={{ display: "inline-flex", gap: "2px", padding: "3px", background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef", borderRadius: "999px", alignSelf: "flex-end" }}>
            {(["exit", "km"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                disabled={v === "km" && (predictive.kmSegmentForecast == null || predictive.kmSegmentForecast.length === 0)}
                style={{
                  padding: "4px 12px", borderRadius: "999px", border: "none", cursor: "pointer",
                  background: view === v ? "#4f46e5" : "transparent",
                  color: view === v ? "#fff" : "#4b5e7d",
                  fontWeight: 600, fontSize: "0.72rem", whiteSpace: "nowrap",
                }}
              >
                {v === "exit" ? "By Exit" : "By Km"}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: "16px", padding: "10px 14px", borderRadius: "10px", background: "#f8fafc", border: "1px solid #e2e8f0" }}>
            {slider("Fleet size", fleetSize, 1, Math.min(12, rows.length), 1, setFleetSize, " units")}
            {slider("Coverage radius", radiusKm, 1, 40, 1, setRadiusKm, " km")}
          </div>
        </div>
      </div>

      <div style={{ padding: "10px 14px", borderRadius: "10px", background: "#eef2ff", border: "1px solid #c7d2fe" }}>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#312e81" }}>
          <strong>Recommended staging: {chosen.map((j) => rows[j].label).join(", ")}.</strong> Pre-position patrol
          and tow-truck units at these {staffedCount} {useKmView ? "segments" : "exits"} — a {radiusKm}km radius from
          each covers <strong>{(coverageShare * 100).toFixed(0)}%</strong> of the ranking&apos;s{" "}
          {fmtInt(totalWeight)}-incident forecast ({fmtInt(coveredWeight)} of {fmtInt(totalWeight)}) —{" "}
          {coverageShare >= 0.8
            ? "this fleet size/radius combination reaches most of the ranking's predicted risk."
            : "a larger fleet or wider radius would be needed to cover most of the ranking's predicted risk."}
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "24px", alignItems: "start" }}>
        {/* Left: the LP deployment map itself. */}
        <div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "6px" }}>
            <div>
              <div style={{ fontSize: "0.68rem", fontWeight: 800, color: "#4f46e5", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                LP deployment map
              </div>
              <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Corridor order (Km 0 first)</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "14px", fontSize: "0.7rem", color: "#64748b", flexWrap: "wrap" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ color: "#4f46e5" }}>●</span> staffed
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ color: "#cbd5e1" }}>○</span> not staffed
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: 10, height: 10, borderRadius: "999px", background: "linear-gradient(90deg, #818cf8, #3730a3)", display: "inline-block" }} />
                darker = higher incidents/km
              </span>
              <span style={{ color: "#94a3b8" }}>· Hover a row for details</span>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
            {rows.map((r, j) => {
              const staffed = chosenSet.has(j);
              const pct = Math.max((r.ratePerKm / maxRate) * 100, 2);
              return (
                <div
                  key={r.key}
                  onMouseEnter={() => setHoveredKey(r.key)}
                  onMouseLeave={() => setHoveredKey((k) => (k === r.key ? null : k))}
                  style={{
                    position: "relative", display: "grid",
                    gridTemplateColumns: "18px minmax(100px, 200px) 1fr 60px",
                    columnGap: "10px", alignItems: "center", padding: "4px 8px", borderRadius: "8px",
                    background: staffed ? "rgba(79,70,229,0.08)" : hoveredKey === r.key ? "rgba(79,70,229,0.05)" : "transparent",
                  }}
                >
                  <span style={{ fontSize: "0.72rem", color: staffed ? "#4f46e5" : "#cbd5e1" }}>{staffed ? "●" : "○"}</span>
                  <span
                    style={{ fontSize: "0.78rem", fontWeight: staffed ? 700 : 500, color: staffed ? "#312e81" : "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={useKmView ? r.label : `${r.label} (Km ${r.km})`}
                  >
                    {r.label}
                  </span>
                  <div style={{ position: "relative" }}>
                    <div style={{ height: 12, borderRadius: "999px", background: "#eef1f7", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, borderRadius: "999px", background: shadeFor(r.ratePerKm / maxRate) }} />
                    </div>
                    {hoveredKey === r.key && (
                      <div
                        style={{
                          position: "absolute", left: 0, bottom: "calc(100% + 6px)", zIndex: 20, pointerEvents: "none",
                          background: "#0f172a", color: "#f1f5f9", borderRadius: "8px", padding: "8px 10px",
                          fontSize: "0.72rem", lineHeight: 1.5, minWidth: "200px", boxShadow: "0 10px 24px rgba(15,23,42,0.28)",
                        }}
                      >
                        <div style={{ fontWeight: 700 }}>{useKmView ? r.label : `${r.label} (Km ${r.km})`}</div>
                        <div>{r.predictedIncidents.toFixed(2)} predicted incidents · {predictive.corridorForecastDays}d</div>
                        <div style={{ color: "#94a3b8" }}>
                          {staffed
                            ? `Staffed — covers ${covers[j].length} zone${covers[j].length === 1 ? "" : "s"} within ${radiusKm}km`
                            : covers[j].length > 0
                              ? `Not staffed — reachable by ${covers[j].length} other zone${covers[j].length === 1 ? "" : "s"}' radius`
                              : "Not staffed — outside every staffed zone's radius"}
                        </div>
                      </div>
                    )}
                  </div>
                  <span style={{ justifySelf: "end", fontSize: "0.72rem", color: "#64748b" }}>{r.ratePerKm.toFixed(2)}/km</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Hotspot monitoring alert, stacked above Proactive speed advisory. */}
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "12px" }}>
            <h4 style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#0f172a", fontWeight: 700 }}>Hotspot monitoring alert</h4>
            <p style={{ color: "#94a3b8", fontSize: "0.72rem", margin: "0 0 8px 0" }}>
              {useKmView ? "Segments" : "Exits"} carrying at least 80% of the ranking&apos;s predicted incident total
              between them — same evidence-coverage cutoff used on the ranking cards above, not an arbitrary top-N.
              {alertRows.length > rows.length / 2 && (
                <> That takes {alertRows.length} of {rows.length} — risk here is spread across most of the corridor
                rather than concentrated in a handful of spots, so the cutoff genuinely needs this many.</>
              )}
            </p>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.68rem", color: "#94a3b8", fontWeight: 600, padding: "0 0 3px 0" }}>
              <span>{useKmView ? "Segment" : "Exit"}</span>
              <span>Predicted incidents</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "220px", overflowY: "auto" }}>
              {alertRows.map((r) => (
                <div key={r.key} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", padding: "3px 0", borderTop: "1px solid #f1f5f9" }}>
                  <span style={{ color: "#334155" }}>{r.label}</span>
                  <span style={{ color: "#b45309", fontWeight: 700 }}>{fmtInt(r.predictedIncidents)}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "12px" }}>
            <h4 style={{ margin: "0 0 4px 0", fontSize: "0.85rem", color: "#0f172a", fontWeight: 700 }}>Proactive speed advisory</h4>
            <p style={{ color: "#94a3b8", fontSize: "0.72rem", margin: "0 0 8px 0" }}>
              Top 3 hotspots by density (predicted incidents per km) — advise reduced speed here first as rainfall
              rises. The percentages below are the weather-incident-risk model&apos;s own probability of a
              corridor-wide high-incident day at each rainfall level{weatherRisk ? ` (AUC ${weatherRisk.auc?.toFixed(3) ?? "—"})` : ""}.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {speedAdvisoryRows.map((r) => (
                <div key={r.key} style={{ fontSize: "0.78rem", padding: "3px 0", borderTop: "1px solid #f1f5f9" }}>
                  <span style={{ color: "#334155", fontWeight: 600 }}>{r.label}</span>
                  <span style={{ color: "#94a3b8" }}> — {useKmView ? "" : `Km ${r.km}, `}{r.ratePerKm.toFixed(2)} incidents/km</span>
                </div>
              ))}
            </div>
            {weatherRisk && (
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" }}>
                {weatherRisk.scenarios.map((s) => (
                  <div key={s.rain_mm} style={{ padding: "4px 8px", borderRadius: "6px", background: "#f8fafc", border: "1px solid #e2e8f0", fontSize: "0.68rem" }}>
                    <div style={{ color: "#94a3b8" }}>{s.rain_mm}mm rain</div>
                    <div style={{ fontWeight: 700, color: "#0f172a" }}>{(s.probability * 100).toFixed(1)}%</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
