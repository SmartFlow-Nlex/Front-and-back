"use client";

import { useEffect, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import { shadeFor } from "./PredictiveCorridorChart";
import { fmtInt, fmtNum } from "./incidentPredictive.shared";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Reads /api/incident/spatial — the two per-exit models from
// train_incident_spatial_models.py that, until now, had a working endpoint
// and nothing rendering it: GWR's local coefficient map (explanatory, fit
// in-sample over the 20 exits) and the Spatial LSTM's next-24h per-exit
// ranking (a genuine, temporally-held-out forecast). Kept as one panel with
// two clearly separated halves rather than two cards, since the point of
// showing both together is the contrast — one is a forecast, the other
// isn't, and conflating them would be the mistake this panel exists to avoid.
type GwrCoefficient = {
  exitId: number; exitName: string; km: number; variable: string;
  coefficient: number; stdError: number | null; tValue: number | null; significant: boolean | null;
};
type SegmentRisk = {
  exitId: number; exitName: string; km: number; forecastDate: string;
  predictedIncidents: number; lastObservedCount: number | null; rank: number;
};
type GwrMetrics = { MAE: number; Poisson_Deviance: number; n: number; loocv_mae: number | null; loocv_n: number };
type LstmMetrics = { MAE: number; Poisson_Deviance: number; n?: number; epochs?: number };
type Metadata = {
  gwr?: { bandwidth: number; metrics: GwrMetrics; variables: string[] };
  spatial_lstm?: { metrics: LstmMetrics; seq_len: number; n_neighbors: number };
};
type SpatialData = {
  coefficients: GwrCoefficient[];
  segmentRisk: SegmentRisk[];
  metadata: Metadata | null;
  trainedAt: string | null;
};

const VARIABLE_LABEL: Record<string, string> = {
  km: "Corridor position",
  access_count: "Access-point count",
  mean_log_volume: "Typical traffic volume",
};

export default function CorridorRiskModelsPanel() {
  const [data, setData] = useState<SpatialData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND}/api/incident/spatial`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setData(json.data as SpatialData);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load spatial risk models");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <article className="chart-card wide" style={{ height: "320px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>Loading corridor risk models…</div>
      </article>
    );
  }

  if (error || !data || (data.segmentRisk.length === 0 && data.coefficients.length === 0)) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "420px" }}>
          <div style={{ fontWeight: 700, color: "#334155", marginBottom: "6px" }}>Corridor risk models unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            {error ?? "The spatial pipeline hasn't written its output yet — run train_incident_spatial_models.py --write-db."}
          </div>
        </div>
      </article>
    );
  }

  const lstmMeta = data.metadata?.spatial_lstm;
  const gwrMeta = data.metadata?.gwr;
  const ranked = [...data.segmentRisk].sort((a, b) => a.rank - b.rank);
  const maxPredicted = Math.max(...ranked.map((r) => r.predictedIncidents), 1e-9);

  const sigByExit = new Map<number, GwrCoefficient[]>();
  for (const c of data.coefficients) {
    if (c.variable === "intercept" || !c.significant) continue;
    const arr = sigByExit.get(c.exitId) ?? [];
    arr.push(c);
    sigByExit.set(c.exitId, arr);
  }
  const exitsWithSignal = [...sigByExit.entries()]
    .map(([exitId, coefs]) => {
      const ref = data.coefficients.find((c) => c.exitId === exitId)!;
      return { exitId, exitName: ref.exitName, km: ref.km, coefs };
    })
    .sort((a, b) => a.km - b.km);

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "18px" }}>
      <div>
        <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          Corridor Risk Models — Spatial LSTM &amp; GWR
          <InfoTooltip text="Two per-exit models, distinct from the corridor breakdown above (which apportions the daily forecast's total by historical location share). The Spatial LSTM is trained specifically on each exit's own history plus its neighbors' — a genuine next-24h forecast. GWR is a separate, explanatory-only fit: with only 20 exits there's no meaningful train/test split, so it's scored in-sample and via leave-one-exit-out, not treated as a forecast." />
        </h3>
        <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 0 0" }}>
          {data.trainedAt ? `Last trained ${new Date(data.trainedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}
        </p>
      </div>

      {/* Spatial LSTM — the genuine forecast */}
      <div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "8px" }}>
          <div>
            <div style={{ fontSize: "0.68rem", fontWeight: 800, color: "#4f46e5", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              Spatial LSTM — next-24h forecast
            </div>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Each exit's own recent history + its nearest neighbors', temporally held out</div>
          </div>
          {lstmMeta && (
            <div style={{ display: "flex", gap: "10px", fontSize: "0.72rem", color: "#94a3b8" }}>
              <span>Holdout MAE {fmtNum(lstmMeta.metrics.MAE, 3)}</span>
              <span>Poisson deviance {fmtNum(lstmMeta.metrics.Poisson_Deviance, 3)}</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          {ranked.map((r) => {
            const key = `seg-${r.exitId}`;
            const pct = Math.max((r.predictedIncidents / maxPredicted) * 100, r.predictedIncidents > 0 ? 2 : 0);
            return (
              <div
                key={key}
                onMouseEnter={() => setHoveredKey(key)}
                onMouseLeave={() => setHoveredKey((k) => (k === key ? null : k))}
                style={{
                  position: "relative", display: "grid",
                  gridTemplateColumns: "26px minmax(120px, 190px) 1fr 56px",
                  columnGap: "10px", alignItems: "center", padding: "5px 8px", borderRadius: "8px",
                  background: hoveredKey === key ? "rgba(79,70,229,0.06)" : "transparent",
                }}
              >
                <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "#0f172a", textAlign: "right" }}>{r.rank}</span>
                <span
                  title={`${r.exitName} (Km ${r.km})`}
                  style={{ fontSize: "0.8rem", fontWeight: 600, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {r.exitName}
                </span>
                <div style={{ position: "relative" }}>
                  <div style={{ height: 14, borderRadius: "999px", background: "#eef1f7", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, borderRadius: "999px", background: shadeFor(r.predictedIncidents / maxPredicted), transition: "width 0.2s ease" }} />
                  </div>
                  {hoveredKey === key && (
                    <div style={{
                      position: "absolute", right: 0, bottom: "calc(100% + 8px)", zIndex: 20, pointerEvents: "none",
                      background: "#0f172a", color: "#f1f5f9", borderRadius: "8px", padding: "8px 10px",
                      fontSize: "0.72rem", lineHeight: 1.5, minWidth: "190px", boxShadow: "0 10px 24px rgba(15,23,42,0.28)",
                    }}>
                      <div style={{ fontWeight: 700 }}>{r.exitName} (Km {r.km})</div>
                      <div>Predicted next 24h: {fmtNum(r.predictedIncidents, 2)}</div>
                      <div style={{ color: "#94a3b8" }}>Last observed: {r.lastObservedCount != null ? fmtInt(r.lastObservedCount) : "—"}</div>
                    </div>
                  )}
                </div>
                <span style={{ justifySelf: "end", padding: "2px 8px", borderRadius: "8px", background: "#fff", border: "1.5px solid #e2e8f0", fontSize: "0.76rem", fontWeight: 700, color: "#1e1b4b" }}>
                  {fmtNum(r.predictedIncidents, 1)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* GWR — explanatory only, honestly labeled */}
      <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "14px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "8px" }}>
          <div>
            <div style={{ fontSize: "0.68rem", fontWeight: 800, color: "#b45309", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              GWR — explanatory, not a forecast
            </div>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Does an exit&apos;s incident rate relate to its structural traits differently along the corridor?</div>
          </div>
        </div>
        {gwrMeta && (
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "10px" }}>
            <div style={{ flex: "1 1 160px", padding: "10px 14px", borderRadius: "10px", background: "#fffbeb", border: "1px solid #fde68a" }}>
              <div style={{ fontSize: "0.68rem", color: "#92400e", fontWeight: 600, textTransform: "uppercase" }}>In-sample MAE</div>
              <div style={{ fontSize: "1.2rem", fontWeight: 700, color: "#78350f" }}>{fmtNum(gwrMeta.metrics.MAE, 3)}</div>
              <div style={{ fontSize: "0.68rem", color: "#92400e" }}>fit and scored on the same 20 exits</div>
            </div>
            <div style={{ flex: "1 1 160px", padding: "10px 14px", borderRadius: "10px", background: "#f8fafc", border: "1px solid #e2e8f0" }}>
              <div style={{ fontSize: "0.68rem", color: "#64748b", fontWeight: 600, textTransform: "uppercase" }}>Leave-one-exit-out MAE</div>
              <div style={{ fontSize: "1.2rem", fontWeight: 700, color: "#0f172a" }}>
                {gwrMeta.metrics.loocv_mae != null ? fmtNum(gwrMeta.metrics.loocv_mae, 3) : "—"}
              </div>
              <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>each exit predicted from the other 19 — the honest number</div>
            </div>
          </div>
        )}
        {exitsWithSignal.length > 0 ? (
          <table style={{ width: "100%", fontSize: "0.76rem", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                <th style={{ fontWeight: 600, paddingBottom: "4px" }}>Exit</th>
                <th style={{ fontWeight: 600, paddingBottom: "4px" }}>Locally significant trait(s)</th>
              </tr>
            </thead>
            <tbody>
              {exitsWithSignal.map((row) => (
                <tr key={row.exitId} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "4px 0", color: "#334155", fontWeight: 600 }}>{row.exitName} (Km {row.km})</td>
                  <td style={{ padding: "4px 0", color: "#64748b" }}>
                    {row.coefs
                      .map((c) => `${VARIABLE_LABEL[c.variable] ?? c.variable} (${c.coefficient > 0 ? "+" : ""}${fmtNum(c.coefficient, 2)})`)
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: "#94a3b8", fontSize: "0.78rem", margin: 0 }}>No locally significant coefficients at |t| &gt; 1.96 in the current fit.</p>
        )}
      </div>
    </article>
  );
}
