"use client";

import { useEffect, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import { fmtInt } from "./incidentPredictive.shared";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Feeds off the same corridorForecast the Predicted Incidents Ranking above
// already shows (predicted incidents per exit, apportioned from the total
// forecast by historical share) — this panel's own contribution is turning
// that ranking into two operational outputs neither existing panel produces:
// a ready-to-post VMS message template per hotspot, and a suggested
// alternate-route exit to advise diverting through, derived from the
// corridor's own real exit ordering (by km) rather than an assumed detour.
type CorridorForecastPoint = { exitId: number; exitName: string; km: number; historicalCount: number; historicalShare: number; predictedIncidents: number };
type PredictiveSlice = {
  corridorForecast: CorridorForecastPoint[] | null;
  corridorForecastDays: number;
  corridorForecastModel: string | null;
};

type Tier = "HIGH" | "MODERATE" | "ADVISORY";
const TIER_WORD: Record<Tier, string> = { HIGH: "CAUTION", MODERATE: "ADVISORY", ADVISORY: "NOTICE" };
const TIER_COLOR: Record<Tier, string> = { HIGH: "#dc2626", MODERATE: "#f59e0b", ADVISORY: "#4f46e5" };

function tierFor(share: number): Tier {
  if (share >= 0.15) return "HIGH";
  if (share >= 0.05) return "MODERATE";
  return "ADVISORY";
}

type Props = {
  // The Prescriptive tab's own Range control. corridorForecast's per-exit
  // apportionment shares are computed from incidents within this window
  // (the published total forecast doesn't move, but which exits look
  // hottest can) — see PrescriptiveDeploymentPanel's own doc comment for the
  // verification. Defaults to this panel's original fixed 12mo when unset.
  months?: "3" | "12" | "all";
  from?: string;
  to?: string;
};

export default function VmsAdvisoryPanel({ months = "12", from, to }: Props) {
  const [predictive, setPredictive] = useState<PredictiveSlice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          corridorForecastDays: json.data.corridorForecastDays,
          corridorForecastModel: json.data.corridorForecastModel,
        });
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load VMS advisory data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [months, from, to]);

  if (loading && predictive === null) {
    return (
      <article className="chart-card wide" style={{ height: "320px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>Loading VMS advisory feed…</div>
      </article>
    );
  }

  const exits = predictive?.corridorForecast ?? [];
  if (error || !predictive || exits.length === 0) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "440px" }}>
          <div style={{ fontWeight: 700, color: "#334155", marginBottom: "6px" }}>VMS advisory feed unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            {error ?? "No Predicted Incidents Ranking data to build advisories from — check the Predictive tab's corridor card."}
          </div>
        </div>
      </article>
    );
  }

  const totalPredicted = exits.reduce((s, x) => s + x.predictedIncidents, 0);
  const byKm = [...exits].sort((a, b) => a.km - b.km);
  const upstreamOf = (exitId: number): CorridorForecastPoint | null => {
    const idx = byKm.findIndex((x) => x.exitId === exitId);
    return idx > 0 ? byKm[idx - 1] : null;
  };

  // Top 5 by predicted volume — a VMS network is a physical, limited set of
  // signs, so this reads as "where to point them first," not an exhaustive
  // coverage cutoff the way the ranking/deployment panels use elsewhere.
  const hotspots = [...exits]
    .filter((x) => x.predictedIncidents > 0)
    .sort((a, b) => b.predictedIncidents - a.predictedIncidents)
    .slice(0, Math.min(5, exits.length));

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          Variable Message Sign (VMS) &amp; Advisory Routing
          <InfoTooltip text="A solution for the Predictive tab's own Predicted Incidents Ranking: turns the top predicted-incident exits into ready-to-post VMS message templates and a suggested divert-via exit, derived from the corridor's own real exit ordering — not an assumed detour. Tier (CAUTION / ADVISORY / NOTICE) is each exit's own share of the total forecast, not a fixed rank cutoff." />
        </h3>
      </div>
      <p style={{ color: "#64748b", fontSize: "0.82rem", margin: 0 }}>
        Built from the {predictive.corridorForecastModel ? `${predictive.corridorForecastModel} ` : ""}
        {predictive.corridorForecastDays}-day forecast — the same ranking the panels above are built from, read as a
        VMS deployment list instead of a staffing or dispatch one.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {hotspots.map((x) => {
          const share = totalPredicted > 0 ? x.predictedIncidents / totalPredicted : 0;
          const tier = tierFor(share);
          const upstream = upstreamOf(x.exitId);
          return (
            <div
              key={x.exitId}
              style={{
                display: "grid", gridTemplateColumns: "180px 1fr", gap: "16px",
                padding: "12px 14px", borderRadius: "10px", background: "#f8fafc", border: "1px solid #e2e8f0",
              }}
            >
              <div
                style={{
                  fontFamily: "monospace", fontSize: "0.82rem", fontWeight: 700, color: "#fff",
                  background: "#0f172a", borderRadius: "6px", padding: "10px", textAlign: "center",
                  display: "flex", flexDirection: "column", justifyContent: "center", gap: "4px",
                  border: `2px solid ${TIER_COLOR[tier]}`,
                }}
              >
                <div style={{ color: TIER_COLOR[tier] }}>{TIER_WORD[tier]}</div>
                <div>INCIDENT RISK</div>
                <div>KM {Math.round(x.km)} · {x.exitName.toUpperCase()}</div>
              </div>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                  <span style={{ fontWeight: 700, color: "#0f172a", fontSize: "0.88rem" }}>{x.exitName}</span>
                  <span
                    style={{
                      fontSize: "0.66rem", fontWeight: 700, color: "#fff", background: TIER_COLOR[tier],
                      borderRadius: "999px", padding: "2px 8px", letterSpacing: "0.03em",
                    }}
                  >
                    {tier}
                  </span>
                  <span style={{ fontSize: "0.72rem", color: "#94a3b8" }}>
                    {fmtInt(x.predictedIncidents)} predicted ({(share * 100).toFixed(0)}% of corridor total)
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: "0.8rem", color: "#475569" }}>
                  {upstream
                    ? <>Alternate route feed: advise <strong>{x.exitName}</strong>-bound traffic to divert via{" "}
                      <strong>{upstream.exitName}</strong> (Km {upstream.km}) if conditions worsen.</>
                    : <>Southernmost hotspot on the corridor — no upstream exit to route traffic through instead.</>}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}
