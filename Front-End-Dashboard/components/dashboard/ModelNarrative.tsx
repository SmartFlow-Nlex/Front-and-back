"use client";

import { useState } from "react";

/**
 * Generative narrative for the forecast chart.
 *
 * Every sentence is COMPOSED FROM gold.ml_model_metrics at render time — there is
 * no stored prose and no hardcoded figure. Re-run the pipeline with a different
 * split, horizon or model set and this text changes with it. The only static
 * content is the one-line description of what each model family does, which is a
 * property of the algorithm rather than of this particular run.
 *
 * Rule followed throughout: never state something the metrics do not support.
 * Where a value is missing the sentence is dropped rather than guessed.
 */

export type MetricRow = {
  model_name: string;
  wmape: number | null;
  mae: number | null;
  rmse: number | null;
  r2: number | null;
  mase: number | null;
  rank: number | null;
  accepted: boolean | null;
  rejected_reason: string | null;
  uses_weather: boolean | null;
  aic: number | null;
  bic: number | null;
};

export type NarrativeModelKey = "LSTM" | "Prophet" | "HoltWinters" | "SARIMAX" | "HoltsLinear";

/** UI key -> model_name as stored in gold.ml_model_metrics */
const DB_NAME: Record<NarrativeModelKey, string> = {
  LSTM: "LSTM",
  Prophet: "Prophet",
  HoltWinters: "HoltWinters",
  SARIMAX: "SARIMAX",
  HoltsLinear: "Holts_Linear",
};

/** Models that were also trained without weather, enabling a with/without comparison */
const NO_WEATHER_TWIN: Partial<Record<NarrativeModelKey, string>> = {
  Prophet: "Prophet_nw",
  SARIMAX: "SARIMAX_nw",
  LSTM: "LSTM_nw",
};

/** Same hues the chart uses, so a chip reads as the same model as its line. */
const COLOR: Record<NarrativeModelKey, string> = {
  LSTM: "#16a34a",
  Prophet: "#f59e0b",
  HoltWinters: "#8b5cf6",
  SARIMAX: "#ef4444",
  HoltsLinear: "#db2777",
};

const LABEL: Record<NarrativeModelKey, string> = {
  LSTM: "LSTM",
  Prophet: "Prophet",
  HoltWinters: "Holt-Winters",
  SARIMAX: "SARIMAX",
  HoltsLinear: "Holts Linear",
};

/** Describes the method, not this run — hence static. */
const HOW_IT_WORKS: Record<NarrativeModelKey, string> = {
  LSTM: "Neural network. Predicts one day at a time and feeds its own output back, so early errors compound across the horizon.",
  Prophet: "Splits the series into trend, weekly and yearly seasonality, then adds them back together.",
  HoltWinters: "Exponential smoothing over level, trend and a 7-day seasonal index, weighted toward recent days.",
  SARIMAX: "Seasonal ARIMA (1,1,1)(1,1,1,7) — autocorrelation plus a weekly cycle, with weather as optional inputs.",
  HoltsLinear: "Level and trend only. No seasonal term, so it cannot represent the weekly cycle at all.",
};

const fmt2 = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? null : n.toFixed(2);
const fmtInt = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? null : Math.round(n).toLocaleString("en-US");

/** MASE is a ratio against the seasonal-naive benchmark — never a percentage. */
function maseSentence(mase: number | null): string {
  if (mase == null || !isFinite(mase)) return "";
  const pct = Math.abs(1 - mase) * 100;
  if (mase < 1) return `MASE ${mase.toFixed(3)} — ${pct.toFixed(0)}% better than repeating last week.`;
  if (mase > 1) return `MASE ${mase.toFixed(3)} — ${pct.toFixed(0)}% worse than repeating last week.`;
  return `MASE ${mase.toFixed(3)} — level with repeating last week.`;
}

export default function ModelNarrative({
  selected,
  metrics,
  showWeather,
  scoredDays,
  windowStart,
  windowEnd,
  horizonDays,
}: {
  selected: NarrativeModelKey[];
  metrics: MetricRow[];
  showWeather: boolean;
  scoredDays: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  horizonDays: number;
}) {
  // Collapsed by default: the report is a deliberate action, not something that
  // pushes the metrics table off screen every time the page loads.
  const [open, setOpen] = useState(false);

  if (!metrics || metrics.length === 0) return null;

  const byName = new Map(metrics.map((m) => [m.model_name, m]));

  // With Weather OFF the prose must describe the weather-free twin, otherwise it
  // would narrate a different forecast than the one currently drawn.
  const rowFor = (k: NarrativeModelKey): MetricRow | undefined => {
    const twin = NO_WEATHER_TWIN[k];
    if (!showWeather && twin && byName.has(twin)) return byName.get(twin);
    return byName.get(DB_NAME[k]);
  };

  const accepted = metrics
    .filter((m) => m.accepted)
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const best = accepted[0];

  return (
    <section
      style={{
        border: "1px solid #e8edf5",
        borderRadius: 12,
        background: "#fff",
        padding: open ? "18px 20px" : "12px 18px",
        display: "flex",
        flexDirection: "column",
        gap: open ? 14 : 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 190 }}>
          <h4 style={{ margin: 0, fontSize: "0.98rem", fontWeight: 700, color: "#0f172a" }}>
            Narrative Explanation
          </h4>
          {!open && (
            <p style={{ margin: "3px 0 0", fontSize: "0.78rem", color: "#64748b" }}>
              Plain-language read-out of how {selected.length === 1 ? "the selected model" : `the ${selected.length} selected models`} performed
            </p>
          )}
        </div>

        {/* Collapsed, the row was mostly dead space. These chips put the headline
            verdict in it, so the strip is informative even before it is opened. */}
        {!open && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flex: 1, justifyContent: "flex-end" }}>
            {selected.map((k) => {
              const r = rowFor(k);
              if (!r) return null;
              const isAcc = !!r.accepted;
              const mase = r.mase != null && isFinite(r.mase) ? r.mase : null;
              return (
                <span
                  key={k}
                  title={isAcc ? `Accepted — rank ${r.rank} of ${metrics.length}` : r.rejected_reason ?? "Rejected"}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 7,
                    padding: "5px 11px", borderRadius: 8, fontSize: "0.735rem",
                    background: isAcc ? "#f0fdf4" : "#f8fafc",
                    border: `1px solid ${isAcc ? "#bbf7d0" : "#e6ebf3"}`,
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: COLOR[k] }} />
                  <b style={{ color: "#0f172a" }}>{LABEL[k]}</b>
                  <span style={{ fontWeight: 700, fontSize: "0.66rem", color: isAcc ? "#15803d" : "#94a3b8" }}>
                    {isAcc ? `RANK #${r.rank}` : "REJECTED"}
                  </span>
                  {r.wmape != null && (
                    <span style={{ color: "#475569" }}>{r.wmape.toFixed(2)}%</span>
                  )}
                  {mase != null && (
                    <span style={{ color: mase < 1 ? "#15803d" : "#b91c1c", fontWeight: 600 }}>
                      MASE {mase.toFixed(2)}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}

        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px",
            marginLeft: open ? "auto" : 0, flexShrink: 0,
            borderRadius: 999, cursor: "pointer", fontSize: "0.76rem", fontWeight: 600,
            border: open ? "1px solid #cbd5e1" : "1px solid transparent",
            background: open ? "#fff" : "linear-gradient(135deg, #6366f1, #4f46e5)",
            color: open ? "#475569" : "#fff",
            boxShadow: open ? "none" : "0 1px 6px rgba(79,70,229,0.35)",
          }}
        >
          {open ? "Hide report" : "Generate report"}
        </button>
      </div>

      {open && (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <p style={{ margin: 0, fontSize: "0.8rem", color: "#64748b" }}>
          Generated from the stored validation metrics for the models currently selected
          {scoredDays != null && windowStart && windowEnd ? (
            <>
              {" "}· {scoredDays.toLocaleString()} scored days, {windowStart} to {windowEnd},
              forecasting {horizonDays} days ahead
            </>
          ) : null}
          {showWeather ? " · weather-driven variants" : " · weather-free variants"}
        </p>

        {selected.map((k) => {
        const r = rowFor(k);
        if (!r) {
          return (
            <article key={k} style={{ fontSize: "0.85rem", color: "#64748b" }}>
              <b style={{ color: "#0f172a" }}>{LABEL[k]}</b> — no stored metrics for this model yet.
            </article>
          );
        }

        const isAcc = !!r.accepted;
        const wmape = fmt2(r.wmape);
        const mae = fmtInt(r.mae);
        const rmse = fmtInt(r.rmse);

        // With vs without weather, only when both variants exist
        const twinName = NO_WEATHER_TWIN[k];
        const twin = twinName ? byName.get(twinName) : undefined;
        const base = byName.get(DB_NAME[k]);
        let weatherLine: string | null = null;
        if (twin && base && base.wmape != null && twin.wmape != null) {
          const delta = twin.wmape - base.wmape; // > 0 => weather version is better
          const pair = `${base.wmape.toFixed(2)}% with vs ${twin.wmape.toFixed(2)}% without`;
          if (Math.abs(delta) < 0.05) weatherLine = `Weather made no real difference — ${pair}.`;
          else if (delta > 0) weatherLine = `Weather helped by ${delta.toFixed(2)} pts — ${pair}.`;
          else weatherLine = `Weather hurt it by ${Math.abs(delta).toFixed(2)} pts — ${pair}.`;
        }

        const icLine =
          r.aic != null && r.bic != null
            ? `AIC ${Math.round(r.aic).toLocaleString()} · BIC ${Math.round(r.bic).toLocaleString()} — fit to history within the ARIMA family only, not forecasting skill.`
            : null;

        const verdictLine = isAcc
          ? `Accepted${r.rank != null ? ` — rank #${r.rank} of ${metrics.length}` : ""}.`
          : r.rejected_reason
          ? `Rejected — ${r.rejected_reason}.`
          : "Rejected.";

        const vsBest =
          best && best.wmape != null && r.wmape != null && r.model_name !== best.model_name
            ? ` ${(r.wmape - best.wmape).toFixed(2)} pts behind ${best.model_name.replace("_nw", " (no weather)")} at ${best.wmape.toFixed(2)}%.`
            : "";

        // Compact stat strip — scannable, and keeps the prose down to verdicts.
        const stats: { label: string; value: string; tone?: string }[] = [];
        if (wmape) stats.push({ label: "WMAPE", value: `${wmape}%`, tone: COLOR[k] });
        if (mae) stats.push({ label: "MAE", value: `${mae} veh` });
        if (rmse) stats.push({ label: "RMSE", value: rmse });
        if (r.r2 != null && isFinite(r.r2)) stats.push({ label: "R²", value: r.r2.toFixed(3) });
        if (r.mase != null && isFinite(r.mase))
          stats.push({ label: "MASE", value: r.mase.toFixed(3), tone: r.mase < 1 ? "#15803d" : "#b91c1c" });

        return (
          <article
            key={k}
            style={{
              borderLeft: `3px solid ${isAcc ? "#16a34a" : "#cbd5e1"}`,
              paddingLeft: 14,
              display: "flex",
              flexDirection: "column",
              gap: 7,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
              <b style={{ fontSize: "0.9rem", color: "#0f172a" }}>{LABEL[k]}</b>
              <span
                style={{
                  fontSize: "0.64rem", fontWeight: 700, padding: "2px 7px", borderRadius: 999,
                  background: isAcc ? "#dcfce7" : "#f1f5f9",
                  color: isAcc ? "#15803d" : "#64748b",
                }}
              >
                {isAcc ? `RANK #${r.rank ?? "—"}` : "REJECTED"}
              </span>
              {!showWeather && twinName && r.model_name === twinName && (
                <span style={{ fontSize: "0.66rem", color: "#94a3b8" }}>weather-free</span>
              )}
              <span style={{ fontSize: "0.78rem", color: "#64748b" }}>{HOW_IT_WORKS[k]}</span>
            </div>

            {/* Numbers as a strip rather than buried in a sentence */}
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {stats.map((st) => (
                <span key={st.label} style={{ display: "inline-flex", alignItems: "baseline", gap: 5 }}>
                  <span style={{ fontSize: "0.64rem", color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {st.label}
                  </span>
                  <b style={{ fontSize: "0.84rem", color: st.tone ?? "#0f172a" }}>{st.value}</b>
                </span>
              ))}
            </div>

            <div style={{ fontSize: "0.8rem", color: "#4b5e7d", lineHeight: 1.5 }}>
              {maseSentence(r.mase)}
              {weatherLine ? <> {weatherLine}</> : null}
            </div>

            {icLine && (
              <div style={{ fontSize: "0.74rem", color: "#94a3b8" }}>{icLine}</div>
            )}

            <div style={{ fontSize: "0.8rem", fontWeight: 600, color: isAcc ? "#15803d" : "#b45309" }}>
              {verdictLine}
              <span style={{ fontWeight: 400, color: "#64748b" }}>{vsBest}</span>
            </div>
          </article>
        );
      })}

      <p
        style={{
          margin: 0,
          fontSize: "0.74rem",
          color: "#94a3b8",
          lineHeight: 1.5,
          borderTop: "1px solid #eef2f7",
          paddingTop: 10,
        }}
      >
        All figures are out-of-sample: each was produced by a model refit on data ending before the
        days it predicted. Accuracy beyond {horizonDays} days ahead is not covered by these numbers,
        and the Future band is a projection rather than a validated forecast.
      </p>
      </div>
      )}
    </section>
  );
}
