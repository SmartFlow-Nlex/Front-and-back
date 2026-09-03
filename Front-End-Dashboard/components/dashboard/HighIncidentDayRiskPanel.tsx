"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import { fmtInt, fmtNum, fmtTrainedAt } from "./incidentPredictive.shared";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

// Reads /api/incident/weather-speed's weather_incident_risk block only — a
// logistic regression scored on held-out DAYS, predicting the probability
// the whole corridor has an unusually high-incident day. Deliberately not
// the rest of that endpoint (daily speed/volume forecast, contour map,
// road_closure): those describe SPEED, a Traffic-module concern, and were
// pulled from the Incident tab for that reason. This one block is different
// — its target is incidents, not speed — so it stays, as its own small card
// rather than reappearing bundled with speed content.
//
// It also isn't redundant with PredictiveIncidentChart's own Volume/Weather
// toggles above: those ask "does removing volume/rain as a model FEATURE
// change the forecast," a black-box comparison. This is a directly readable
// logistic regression: a probability, an AUC, a significance test on rain,
// and scenario curves — a different, complementary way to see the same
// exposure story.
type Scenario = { rain_mm?: number; volume?: number; probability: number };
type RiskBlock = {
  auc: number | null;
  base_rate: number;
  n: number;
  scenarios: Scenario[];
  volumeScenarios: Scenario[];
  rainSignificant: boolean;
  rainPValue: number | null;
  topDriver: { feature: string; effectSize: number };
};
type Metadata = { weather_incident_risk?: RiskBlock };
type WeatherSpeedData = { metadata: Metadata | null; trainedAt: string | null };

const FEATURE_LABEL: Record<string, string> = {
  log_volume: "traffic volume",
  rain_mm: "rainfall",
  volume: "traffic volume",
};

export default function HighIncidentDayRiskPanel() {
  const [data, setData] = useState<WeatherSpeedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"rain" | "volume">("rain");

  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND}/api/incident/weather-speed`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setData({ metadata: json.data.metadata, trainedAt: json.data.trainedAt });
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load high-incident-day risk");
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
        <div style={{ color: "#64748b" }}>Loading high-incident-day risk…</div>
      </article>
    );
  }

  const risk = data?.metadata?.weather_incident_risk;
  if (error || !risk || risk.scenarios.length === 0) {
    return (
      <article className="chart-card wide" style={{ height: "260px", padding: "20px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: "440px" }}>
          <div style={{ fontWeight: 700, color: "#334155", marginBottom: "6px" }}>High-incident-day risk unavailable</div>
          <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            {error ?? "The weather/speed pipeline hasn't written its output yet — run train_incident_weather_speed_models.py --write-db."}
          </div>
        </div>
      </article>
    );
  }

  const rainScenarios = risk.scenarios;
  const volScenarios = risk.volumeScenarios ?? [];
  const rainRange = rainScenarios[rainScenarios.length - 1].probability - rainScenarios[0].probability;
  const volRange = volScenarios.length > 0 ? volScenarios[volScenarios.length - 1].probability - volScenarios[0].probability : null;
  const featureLabel = FEATURE_LABEL[risk.topDriver.feature] ?? risk.topDriver.feature;

  const activeScenarios = view === "rain" ? rainScenarios : volScenarios;
  const barOption: EChartsOption = {
    grid: { left: 56, right: 24, top: 24, bottom: 48 },
    tooltip: {
      trigger: "item",
      formatter: (p: unknown) => {
        const s = activeScenarios[(p as { dataIndex: number }).dataIndex];
        const x = view === "rain" ? `${s.rain_mm}mm rain` : `${fmtInt(s.volume ?? 0)} vehicles`;
        return `<b>${x}</b><br/>${(s.probability * 100).toFixed(1)}% probability of a high-incident day`;
      },
    },
    xAxis: {
      type: "category",
      data: activeScenarios.map((s) => (view === "rain" ? `${s.rain_mm}mm` : fmtInt(s.volume ?? 0))),
      name: view === "rain" ? "Rainfall scenario" : "Daily volume scenario",
      nameLocation: "middle",
      nameGap: 32,
      axisLabel: { color: "#64748b", fontSize: 11 },
      axisLine: { lineStyle: { color: "#cbd5e1" } },
    },
    yAxis: {
      type: "value",
      name: "Probability of a high-incident day",
      nameLocation: "middle",
      nameGap: 48,
      min: 0,
      axisLabel: { color: "#64748b", formatter: (v: number) => `${Math.round(v * 100)}%` },
      splitLine: { lineStyle: { color: "#eef1f7" } },
    },
    series: [
      {
        type: "bar",
        data: activeScenarios.map((s) => s.probability),
        barMaxWidth: 60,
        itemStyle: { color: "#4f46e5", borderRadius: [4, 4, 0, 0] },
        label: {
          show: true, position: "top", color: "#334155", fontSize: 11, fontWeight: 600,
          formatter: (p: unknown) => `${((p as { value: number }).value * 100).toFixed(1)}%`,
        },
      },
    ],
  };

  return (
    <article className="chart-card wide" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: "1.05rem", color: "#0f172a", fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          High-Incident-Day Risk
          <InfoTooltip text="Probability the WHOLE corridor has an unusually high-incident day — a logistic regression scored on held-out days, not a per-location risk (that's what the ranking and Secondary Incident Risk above already cover). Modeled against both traffic volume and rainfall scenarios, so which one actually moves the needle is a live comparison, not assumed from the model's name." />
        </h3>
        <div style={{ display: "inline-flex", gap: "2px", padding: "3px", background: "var(--bg-surface, #fff)", border: "1px solid #dce2ef", borderRadius: "999px", flexShrink: 0 }}>
          {(["rain", "volume"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              disabled={v === "volume" && volScenarios.length === 0}
              style={{
                padding: "4px 12px", borderRadius: "999px", border: "none", cursor: "pointer",
                background: view === v ? "#4f46e5" : "transparent",
                color: view === v ? "#fff" : "#4b5e7d",
                fontWeight: 600, fontSize: "0.72rem", whiteSpace: "nowrap",
                opacity: v === "volume" && volScenarios.length === 0 ? 0.4 : 1,
              }}
            >
              {v === "rain" ? "By Rainfall" : "By Volume"}
            </button>
          ))}
        </div>
      </div>
      <p style={{ color: "#64748b", fontSize: "0.82rem", margin: 0 }}>
        {risk.rainSignificant
          ? `Rainfall is a statistically significant driver here (p=${fmtNum(risk.rainPValue, 3)})`
          : `Rainfall isn't a statistically significant driver here (p=${fmtNum(risk.rainPValue, 3)})`} — swinging from{" "}
        {rainScenarios[0].rain_mm}mm to {rainScenarios[rainScenarios.length - 1].rain_mm}mm of rain moves the
        probability by {(rainRange * 100).toFixed(1)} points ({(rainScenarios[0].probability * 100).toFixed(1)}% to{" "}
        {(rainScenarios[rainScenarios.length - 1].probability * 100).toFixed(1)}%).
        {volRange != null && (
          <>
            {" "}
            {volRange > Math.abs(rainRange) ? "Volume matters far more" : "Volume moves it by comparably less"}: the
            model&apos;s top driver is <strong>{featureLabel}</strong>, whose own scenario curve moves from{" "}
            {(volScenarios[0].probability * 100).toFixed(1)}% to{" "}
            {(volScenarios[volScenarios.length - 1].probability * 100).toFixed(1)}%.
          </>
        )}
      </p>

      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 120px", padding: "10px 14px", borderRadius: "10px", background: "#f8fafc", border: "1px solid #e2e8f0" }}>
          <div style={{ fontSize: "0.7rem", color: "#94a3b8", fontWeight: 600, textTransform: "uppercase" }}>Model AUC</div>
          <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "#0f172a" }}>{fmtNum(risk.auc, 3)}</div>
        </div>
        <div style={{ flex: "1 1 120px", padding: "10px 14px", borderRadius: "10px", background: "#f8fafc", border: "1px solid #e2e8f0" }}>
          <div style={{ fontSize: "0.7rem", color: "#94a3b8", fontWeight: 600, textTransform: "uppercase" }}>Base rate</div>
          <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "#0f172a" }}>{(risk.base_rate * 100).toFixed(1)}%</div>
        </div>
        <div style={{ flex: "1 1 120px", padding: "10px 14px", borderRadius: "10px", background: "#f8fafc", border: "1px solid #e2e8f0" }}>
          <div style={{ fontSize: "0.7rem", color: "#94a3b8", fontWeight: 600, textTransform: "uppercase" }}>Held-out days</div>
          <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "#0f172a" }}>{fmtInt(risk.n)}</div>
        </div>
      </div>

      <DashboardChart option={barOption} height={300} />

      <p style={{ color: "#94a3b8", fontSize: "0.72rem", margin: 0 }}>
        &ldquo;High-incident day&rdquo; is corridor-wide, above this model&apos;s own base rate of{" "}
        {(risk.base_rate * 100).toFixed(1)}% — trained {fmtTrainedAt(data?.trainedAt ?? null)}.
      </p>
    </article>
  );
}
