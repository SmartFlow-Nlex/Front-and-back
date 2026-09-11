"use client";

import { useState } from "react";
import AiModelInsight, { type InsightMetric } from "./AiModelInsight";

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
  /** Trainer's note. A value starting "tied with" means this model is not
   *  separable from the leader, so a rank badge would overstate the result. */
  diagnosis?: string | null;
};

export type NarrativeModelKey = string;

/**
 * The volume module's vocabulary. Kept as the DEFAULT so that panel is
 * unaffected, but every map is overridable: the emissions panel forecasts a
 * different quantity with a different model family, and hardcoding one module's
 * model names here would have meant either a second copy of this component or a
 * narrative that named models the reader is not looking at.
 */
export type NarrativeVocab = {
  /** UI key -> model_name as stored in gold.ml_model_metrics */
  dbName: Record<string, string>;
  label: Record<string, string>;
  color: Record<string, string>;
  /** Describes the method, not this run. */
  howItWorks: Record<string, string>;
  /** Models with a weather-free twin, enabling a with/without comparison. */
  noWeatherTwin?: Partial<Record<string, string>>;
  /** Unit suffix for MAE, e.g. "veh" or "t". Omit for none. */
  maeUnit?: string;
  /** How MAE/RMSE are rendered. Volume counts are integers; tonnes are not. */
  fmtMagnitude?: (n: number | null | undefined) => string | null;
};

const DB_NAME: Record<string, string> = {
  LSTM: "LSTM",
  Prophet: "Prophet",
  HoltWinters: "HoltWinters",
  SARIMAX: "SARIMAX",
  HoltsLinear: "Holts_Linear",
};

const NO_WEATHER_TWIN: Partial<Record<string, string>> = {
  Prophet: "Prophet_nw",
  SARIMAX: "SARIMAX_nw",
  LSTM: "LSTM_nw",
};

/** Same hues the chart uses, so a chip reads as the same model as its line. */
const COLOR: Record<string, string> = {
  LSTM: "#16a34a",
  Prophet: "#f59e0b",
  HoltWinters: "#8b5cf6",
  SARIMAX: "#ef4444",
  HoltsLinear: "#db2777",
};

const LABEL: Record<string, string> = {
  LSTM: "LSTM",
  Prophet: "Prophet",
  HoltWinters: "Holt-Winters",
  SARIMAX: "SARIMAX",
  HoltsLinear: "Holts Linear",
};

/** Describes the method, not this run — hence static. */
const HOW_IT_WORKS: Record<string, string> = {
  LSTM: "Neural network. Predicts one day at a time and feeds its own output back, so early errors compound across the horizon.",
  Prophet: "Splits the series into trend, weekly and yearly seasonality, then adds them back together.",
  HoltWinters: "Exponential smoothing over level, trend and a 7-day seasonal index, weighted toward recent days.",
  SARIMAX: "Seasonal ARIMA (1,1,1)(1,1,1,7) — autocorrelation plus a weekly cycle, with weather as optional inputs.",
  HoltsLinear: "Level and trend only. No seasonal term, so it cannot represent the weekly cycle at all.",
};

const VOLUME_VOCAB: NarrativeVocab = {
  dbName: DB_NAME, label: LABEL, color: COLOR, howItWorks: HOW_IT_WORKS,
  noWeatherTwin: NO_WEATHER_TWIN, maeUnit: "veh",
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
  vocab = VOLUME_VOCAB,
  quantityNote,
  quantity = "volume",
}: {
  selected: NarrativeModelKey[];
  metrics: MetricRow[];
  showWeather?: boolean;
  /** Model names, colours and descriptions. Defaults to the volume module's. */
  vocab?: NarrativeVocab;
  /** Appended to the closing caveat, for module-specific limitations. */
  quantityNote?: string;
  /** Which quantity is being forecast — steers the AI summary's framing. */
  quantity?: "volume" | "incidents" | "emissions";
  scoredDays: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  horizonDays: number;
}) {
  // Collapsed by default: the report is a deliberate action, not something that
  // pushes the metrics table off screen every time the page loads.
  const [open, setOpen] = useState(false);

  if (!metrics || metrics.length === 0) return null;

  const { dbName: DBN, label: LBL, color: CLR, howItWorks: HOW } = vocab;
  const TWIN = vocab.noWeatherTwin ?? {};
  const fmtMag = vocab.fmtMagnitude ?? fmtInt;

  const byName = new Map(metrics.map((m) => [m.model_name, m]));

  // With Weather OFF the prose must describe the weather-free twin, otherwise it
  // would narrate a different forecast than the one currently drawn.
  const rowFor = (k: NarrativeModelKey): MetricRow | undefined => {
    const twin = TWIN[k];
    if (!showWeather && twin && byName.has(twin)) return byName.get(twin);
    return byName.get(DBN[k]);
  };

  const rankedCount = metrics.filter((m) => m.rank != null).length || metrics.length;
  const isTied = (r: MetricRow) => typeof r.diagnosis === "string" && r.diagnosis.startsWith("tied with");

  const accepted = metrics
    .filter((m) => m.accepted)
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const best = accepted[0];

  return (
    <section
      style={{
        border: "1px solid #e8edf5",
        borderRadius: 12,
        background: "var(--bg-surface)",
        padding: open ? "18px 20px" : "12px 18px",
        display: "flex",
        flexDirection: "column",
        gap: open ? 14 : 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 190 }}>
          <h4 style={{ margin: 0, fontSize: "0.98rem", fontWeight: 700, color: "var(--text-primary)" }}>
            Narrative Explanation
          </h4>
          {!open && (
            <p style={{ margin: "3px 0 0", fontSize: "0.78rem", color: "var(--text-secondary)" }}>
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
                  title={isAcc ? `Accepted — rank ${r.rank} of ${rankedCount}` : r.rejected_reason ?? "Rejected"}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 7,
                    padding: "5px 11px", borderRadius: 8, fontSize: "0.735rem",
                    background: isAcc ? "var(--color-success-bg)" : "var(--bg-surface-hover)",
                    border: `1px solid ${isAcc ? "var(--color-success-border)" : "var(--border-default)"}`,
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: CLR[k] }} />
                  <b style={{ color: "var(--text-primary)" }}>{LBL[k]}</b>
                  <span style={{ fontWeight: 700, fontSize: "0.66rem", color: isAcc ? "var(--color-success)" : "var(--text-muted)" }}>
                    {isAcc ? (isTied(r) ? "CO-CHAMPION" : `RANK #${r.rank}`) : "REJECTED"}
                  </span>
                  {r.wmape != null && (
                    <span style={{ color: "var(--text-secondary)" }}>{r.wmape.toFixed(2)}%</span>
                  )}
                  {mase != null && (
                    <span style={{ color: mase < 1 ? "var(--color-success)" : "var(--color-danger)", fontWeight: 600 }}>
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
            background: open ? "var(--bg-surface)" : "linear-gradient(135deg, #6366f1, #4f46e5)",
            color: open ? "var(--text-secondary)" : "var(--bg-surface)",
            boxShadow: open ? "none" : "0 1px 6px rgba(79,70,229,0.35)",
          }}
        >
          {open ? "Hide report" : "Generate report"}
        </button>
      </div>

      {open && (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          Generated from the stored validation metrics for the models currently selected
          {scoredDays != null && windowStart && windowEnd ? (
            <>
              {" "}· {scoredDays.toLocaleString()} scored days, {windowStart} to {windowEnd},
              forecasting {horizonDays} days ahead
            </>
          ) : null}
          {showWeather === undefined ? null : showWeather ? " · weather-driven variants" : " · weather-free variants"}
        </p>

      {/* The read-out is the language model's alone. The metrics it was given
          are the ones on the card above, so the two cannot disagree. */}
      <AiModelInsight
        quantity={quantity}
        horizonDays={horizonDays}
        scoredDays={scoredDays}
        windowStart={windowStart}
        windowEnd={windowEnd}
        weatherMode={showWeather === undefined ? null : showWeather ? "with" : "without"}
        labelFor={(name) => {
          const key = Object.keys(DBN).find((k) => DBN[k] === name);
          return key ? LBL[key] ?? name : name;
        }}
        metrics={selected
          .map((k) => rowFor(k))
          .filter((r): r is MetricRow => !!r)
          .map<InsightMetric>((r) => ({
            model: r.model_name,
            wmape: r.wmape,
            mae: r.mae,
            rmse: r.rmse,
            r2: r.r2,
            mase: r.mase,
            rank: r.rank,
            accepted: r.accepted,
            rejectedReason: r.rejected_reason,
            diagnosis: r.diagnosis ?? null,
          }))}
      />

      </div>
      )}
    </section>
  );
}
