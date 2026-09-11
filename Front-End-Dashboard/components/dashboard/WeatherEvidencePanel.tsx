"use client";

import { useEffect, useState } from "react";
import InfoTooltip from "./InfoTooltip";

/**
 * Weather as a predictor, as one flat block inside the Validation evidence
 * disclosure.
 *
 * The chart overlays rainfall alone; this shows all four weather variables'
 * correlation with daily volume and the with/without-weather test for each
 * model that can take external inputs, so the choice of rainfall reads as a
 * display decision. Both halves come from the warehouse at request time.
 *
 * It used to be a card with its own Show/Hide button and three explanatory
 * paragraphs nested inside an already-collapsed section. Now: a label, one
 * headline line, four bars, one line per model. The explanations live in the
 * info icon.
 */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type Correlation = { variable: string; label: string; pearson: number | null; spearman: number | null; days: number };
type ModelComparison = { model: string; withWeather: number | null; withoutWeather: number | null; deltaPts: number | null };

function strengthOf(r: number | null): { label: string; tone: string } {
  const a = Math.abs(r ?? 0);
  if (r == null) return { label: "—", tone: "var(--text-muted)" };
  if (a < 0.1) return { label: "negligible", tone: "var(--text-muted)" };
  if (a < 0.3) return { label: "weak", tone: "var(--color-warning)" };
  if (a < 0.5) return { label: "moderate", tone: "var(--color-warning)" };
  return { label: "strong", tone: "var(--color-success)" };
}

const LABEL: React.CSSProperties = {
  fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
  color: "var(--text-muted)", display: "inline-flex", alignItems: "center",
};

export default function WeatherEvidencePanel({ plotted = "total_rain" }: { plotted?: string }) {
  const [corr, setCorr] = useState<Correlation[]>([]);
  const [models, setModels] = useState<ModelComparison[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND}/api/traffic/weather-evidence`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j?.success) return setState("error");
        setCorr(j.data.correlations ?? []);
        setModels(j.data.modelComparison ?? []);
        setState("ready");
      })
      .catch(() => !cancelled && setState("error"));
    return () => { cancelled = true; };
  }, []);

  if (state !== "ready") return null;

  const days = corr[0]?.days ?? null;
  const strongest = corr[0];
  const maxAbs = Math.max(...corr.map((c) => Math.abs(c.pearson ?? 0)), 0.001);
  const helped = models.filter((m) => (m.deltaPts ?? 0) > 0.05).length;

  return (
    <section style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <span style={LABEL}>
          Weather as a predictor
          <InfoTooltip text={`Pearson correlation of each daily weather variable with daily corridor volume${days ? ` over ${days.toLocaleString()} days` : ""}. Rainfall is the one drawn on the chart because it is easiest to read, not because it predicts best. The per-model line is the same model trained with and without weather inputs; lower WMAPE is better. Holt-Winters and Holts Linear take no external inputs, so they have no pair.`} />
        </span>
        <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
          {strongest && (
            <>Strongest: <b style={{ color: "var(--text-primary)" }}>{strongest.label}</b> r = {strongest.pearson?.toFixed(3)}{" "}
            <span style={{ color: strengthOf(strongest.pearson).tone, fontWeight: 600 }}>{strengthOf(strongest.pearson).label}</span></>
          )}
          {models.length > 0 && (
            <> · weather inputs help <b style={{ color: helped === 0 ? "var(--text-secondary)" : "var(--color-success)" }}>{helped} of {models.length}</b> models</>
          )}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "8px 28px" }}>
        {/* Four variables, strongest first. */}
        <div style={{ display: "grid", gap: 6 }}>
          {corr.map((c) => {
            const s = strengthOf(c.pearson);
            const pct = (Math.abs(c.pearson ?? 0) / maxAbs) * 100;
            const isPlotted = c.variable === plotted;
            return (
              <div key={c.variable} style={{ display: "grid", gridTemplateColumns: "92px 1fr 54px 70px", alignItems: "center", gap: 8, fontSize: "0.78rem" }}>
                <span style={{ color: "var(--text-primary)", fontWeight: isPlotted ? 700 : 500, whiteSpace: "nowrap" }}>
                  {c.label}{isPlotted && <span style={{ marginLeft: 5, fontSize: "0.62rem", color: "var(--text-muted)", fontWeight: 500 }}>on chart</span>}
                </span>
                <span style={{ height: 5, background: "var(--bg-surface-hover)", borderRadius: 3, overflow: "hidden" }}>
                  <span style={{ display: "block", height: "100%", width: `${pct}%`, background: (c.pearson ?? 0) < 0 ? "#0ea5e9" : "#f59e0b", borderRadius: 3 }} />
                </span>
                <span style={{ textAlign: "right", color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
                  {c.pearson == null ? "—" : c.pearson.toFixed(3)}
                </span>
                <span style={{ fontSize: "0.7rem", color: s.tone }}>{s.label}</span>
              </div>
            );
          })}
        </div>

        {/* With vs without weather, one line per model. */}
        {models.length > 0 && (
          <div style={{ display: "grid", gap: 6, alignContent: "start" }}>
            {models.map((m) => {
              const d = m.deltaPts;
              const helps = d != null && d > 0.05;
              const hurts = d != null && d < -0.05;
              const tone = helps ? "var(--color-success)" : hurts ? "var(--color-danger)" : "var(--text-muted)";
              return (
                <div key={m.model} style={{ display: "grid", gridTemplateColumns: "92px 1fr auto", alignItems: "baseline", gap: 8, fontSize: "0.78rem" }}>
                  <b style={{ color: "var(--text-primary)" }}>{m.model}</b>
                  <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                    {m.withWeather?.toFixed(2)}% with · {m.withoutWeather?.toFixed(2)}% without
                  </span>
                  <b style={{ color: tone, fontVariantNumeric: "tabular-nums" }}>
                    {d == null ? "—" : helps ? `−${d.toFixed(2)} pts` : hurts ? `+${Math.abs(d).toFixed(2)} pts` : "no change"}
                  </b>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
