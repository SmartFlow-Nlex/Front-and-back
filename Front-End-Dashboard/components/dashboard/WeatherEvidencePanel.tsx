"use client";

import { useEffect, useState } from "react";

/**
 * Weather evidence panel.
 *
 * The chart overlays rainfall only, because five model lines plus four weather
 * series is unreadable. That invites a fair question: was rainfall singled out
 * because it predicts well? It was not — humidity correlates about twice as
 * strongly. This panel shows all four side by side so the choice reads as a
 * display decision rather than a selective one.
 *
 * Both halves are computed from the warehouse at request time: the correlations
 * over the full daily series, and the with/without comparison from the last
 * training run. Nothing here is stored prose or a hardcoded figure.
 *
 * Collapsed by default — it answers a question the reader may not have asked yet,
 * so it should not push the metrics table down the page on every load.
 */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type Correlation = {
  variable: string;
  label: string;
  pearson: number | null;
  spearman: number | null;
  days: number;
};

type ModelComparison = {
  model: string;
  withWeather: number | null;
  withoutWeather: number | null;
  deltaPts: number | null;
};

/** Conventional reading of |r| for a sample this size. */
function strengthOf(r: number | null): { label: string; tone: string } {
  const a = Math.abs(r ?? 0);
  if (r == null) return { label: "—", tone: "var(--text-muted)" };
  if (a < 0.1) return { label: "negligible", tone: "var(--text-muted)" };
  if (a < 0.3) return { label: "weak", tone: "var(--color-warning)" };
  if (a < 0.5) return { label: "moderate", tone: "var(--color-warning)" };
  return { label: "strong", tone: "var(--color-success)" };
}

export default function WeatherEvidencePanel({ plotted = "total_rain" }: { plotted?: string }) {
  const [corr, setCorr] = useState<Correlation[]>([]);
  const [models, setModels] = useState<ModelComparison[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [open, setOpen] = useState(false);

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

  // A supporting panel should never block the page or show an error box.
  if (state !== "ready") return null;

  const days = corr[0]?.days ?? null;
  const strongest = corr[0];               // service returns them sorted by |r|
  const maxAbs = Math.max(...corr.map((c) => Math.abs(c.pearson ?? 0)), 0.001);

  // Verdict is derived, not asserted: does weather meaningfully help ANY model?
  const helped = models.filter((m) => (m.deltaPts ?? 0) > 0.05).length;
  const verdict =
    models.length === 0 ? null
    : helped === 0 ? "No model improves with weather"
    : `Helps ${helped} of ${models.length} models`;

  return (
    <section
      style={{
        border: "1px solid var(--border-default)", borderRadius: 12,
        background: "var(--bg-surface)",
        padding: open ? "16px 20px" : "12px 18px",
        display: "flex", flexDirection: "column", gap: open ? 14 : 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 210 }}>
          <h4 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 700, color: "var(--text-primary)" }}>
            Does weather predict traffic?
          </h4>
          {!open && (
            <p style={{ margin: "3px 0 0", fontSize: "0.78rem", color: "var(--text-secondary)" }}>
              Correlations for all four variables, and the with/without model test
            </p>
          )}
        </div>

        {/* Collapsed, the headline finding still shows — the panel is informative
            before it is opened, rather than an unlabelled button. */}
        {!open && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flex: 1, justifyContent: "flex-end" }}>
            {strongest && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 7,
                padding: "5px 11px", borderRadius: 8, fontSize: "0.735rem",
                background: "var(--bg-surface-hover)", border: "1px solid var(--border-default)",
              }}>
                <span style={{ color: "var(--text-secondary)" }}>Strongest</span>
                <b style={{ color: "var(--text-primary)" }}>{strongest.label}</b>
                <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                  r = {strongest.pearson?.toFixed(3)}
                </span>
                <span style={{ color: strengthOf(strongest.pearson).tone, fontWeight: 600 }}>
                  {strengthOf(strongest.pearson).label}
                </span>
              </span>
            )}
            {verdict && (
              <span style={{
                display: "inline-flex", alignItems: "center",
                padding: "5px 11px", borderRadius: 8, fontSize: "0.735rem", fontWeight: 600,
                background: helped === 0 ? "var(--bg-surface-hover)" : "var(--color-success-bg)",
                border: `1px solid ${helped === 0 ? "var(--border-default)" : "var(--color-success-border)"}`,
                color: helped === 0 ? "var(--text-secondary)" : "var(--color-success)",
              }}>
                {verdict}
              </span>
            )}
          </div>
        )}

        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px",
            marginLeft: open ? "auto" : 0, flexShrink: 0,
            borderRadius: 999, cursor: "pointer", fontSize: "0.76rem", fontWeight: 600,
            border: open ? "1px solid var(--border-strong)" : "1px solid transparent",
            background: open ? "var(--bg-surface)" : "linear-gradient(135deg, #38bdf8, #0284c7)",
            color: open ? "var(--text-secondary)" : "#fff",
            boxShadow: open ? "none" : "0 1px 6px rgba(2,132,199,0.35)",
          }}
        >
          {open ? "Hide evidence" : "Show evidence"}
        </button>
      </div>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--text-secondary)" }}>
            All four variables are inputs to Prophet, SARIMAX and the LSTM. The chart overlays
            rainfall alone for readability — these are the numbers behind that choice
            {days ? <> · {days.toLocaleString()} days</> : null}
          </p>

          {/* Correlations, strongest first, with a bar so relative size is visible */}
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {corr.map((c) => {
              const s = strengthOf(c.pearson);
              const pct = (Math.abs(c.pearson ?? 0) / maxAbs) * 100;
              const isPlotted = c.variable === plotted;
              return (
                <div key={c.variable} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: "0.79rem" }}>
                  <span style={{ width: 96, color: "var(--text-primary)", fontWeight: isPlotted ? 700 : 500 }}>
                    {c.label}
                    {isPlotted && (
                      <span style={{ marginLeft: 5, fontSize: "0.62rem", color: "var(--text-muted)" }}>on chart</span>
                    )}
                  </span>
                  <span style={{ flex: 1, height: 6, background: "var(--bg-surface-hover)", borderRadius: 3, overflow: "hidden" }}>
                    <span style={{
                      display: "block", height: "100%", width: `${pct}%`,
                      background: (c.pearson ?? 0) < 0 ? "#0ea5e9" : "#f59e0b", borderRadius: 3,
                    }} />
                  </span>
                  <span style={{ width: 62, textAlign: "right", color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
                    {c.pearson == null ? "—" : c.pearson.toFixed(3)}
                  </span>
                  <span style={{ width: 78, fontSize: "0.72rem", color: s.tone }}>{s.label}</span>
                </div>
              );
            })}
          </div>

          {strongest && (
            <p style={{ margin: 0, fontSize: "0.76rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
              Strongest is <b style={{ color: "var(--text-primary)" }}>{strongest.label}</b> at r ={" "}
              {strongest.pearson?.toFixed(3)} — still {strengthOf(strongest.pearson).label}. Rainfall is
              plotted because it is the variable a reader can interpret at a glance, not because it
              predicts best.
            </p>
          )}

          {/* The controlled test: same model, same protocol, weather in vs out */}
          {models.length > 0 && (
            <div style={{ borderTop: "1px solid var(--border-default)", paddingTop: 12 }}>
              <div style={{ fontSize: "0.79rem", fontWeight: 700, color: "var(--text-primary)", marginBottom: 7 }}>
                Same model, trained with and without weather
              </div>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                {models.map((m) => {
                  const d = m.deltaPts;
                  const helps = d != null && d > 0.05;
                  const hurts = d != null && d < -0.05;
                  const tone = helps ? "var(--color-success)" : hurts ? "var(--color-danger)" : "var(--text-muted)";
                  return (
                    <span key={m.model} style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>
                      <b style={{ color: "var(--text-primary)" }}>{m.model}</b>{" "}
                      {m.withWeather?.toFixed(2)}% vs {m.withoutWeather?.toFixed(2)}%{" "}
                      <b style={{ color: tone }}>
                        {d == null ? "—" : helps ? `helps +${d.toFixed(2)}` : hurts ? `hurts ${d.toFixed(2)}` : "no difference"}
                      </b>
                    </span>
                  );
                })}
              </div>
              <p style={{ margin: "8px 0 0", fontSize: "0.74rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
                Lower WMAPE is better. Holt-Winters and Holts Linear are absent because they are
                univariate — the method has no mechanism for external inputs, so there is no
                with/without pair to compare.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
