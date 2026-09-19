"use client";

import { useEffect, useRef, useState } from "react";
import AiModelInsight, { type InsightMetric } from "./AiModelInsight";
import { Sparkles } from "lucide-react";
import { createPortal } from "react-dom";
import { META, type ModelKey, type ModelMetric } from "./incidentPredictive.shared";

/**
 * Generative narrative for the incident forecast chart. Ported from
 * ModelNarrative.tsx (the traffic-volume equivalent) with the same design
 * contract:
 *
 * Every sentence is COMPOSED FROM the modelMetrics rows the chart's own table
 * is already showing — there is no stored prose and no hardcoded figure. The
 * only static content is the one-line description of what each model family
 * does, which is a property of the algorithm rather than of this particular
 * run. Where a value is missing the sentence is dropped rather than guessed.
 *
 * Two deliberate departures from the traffic version, because the incident
 * pipeline's data contract is genuinely different (see incident.service.ts /
 * incidentPredictive.shared.ts) rather than because this component decided to
 * simplify:
 *
 *   1. No accepted/rejected/rank/rejected_reason columns exist on
 *      ModelMetric — the incident pipeline (train_incident_models.py) has a
 *      CHAMPION concept instead (select_champion(): eligible = MASE <= 1.0,
 *      then highest R2 or lowest MAE among the eligible). The verdict line
 *      below is built from that same rule, applied live to each row's own
 *      MASE — "does not beat the naive weekly baseline" is computed from the
 *      number in front of it, not read from a stored reason string, since no
 *      such column exists to read from. Whether the champion was picked by R2
 *      or by MAE isn't exposed on the API response (metadata.evaluation
 *      .selected_by never reaches modelInfo), so that clause stays generic
 *      rather than asserting a criterion this component can't confirm.
 *
 *   2. No weather-model twins (SARIMAX_nw / Prophet_nw / LSTM_nw don't exist
 *      here — rainfall is one input feature every model gets, not a toggle).
 *      "Does weather help this model?" is instead answered by re-scoring the
 *      SAME model on wet-only vs dry-only days, which is exactly what
 *      data.weatherMetrics already computes and PredictiveIncidentChart
 *      already renders as its own panel. Duplicating that as a narrative
 *      sentence would need both wet AND dry numbers in one response, and the
 *      API only ever returns the currently-selected slice — so this
 *      component states which slice the numbers below reflect (the same
 *      thing ModelNarrative's "weather-driven variants" strapline does)
 *      rather than fabricating a comparison the data can't support.
 */

const HOW_IT_WORKS: Record<ModelKey, string> = {
  XGBoost: "Gradient-boosted decision trees over lag, rolling-mean and calendar features — each new tree corrects the previous ensemble's errors.",
  RandomForest: "An ensemble of decision trees, each trained on a bootstrapped sample of days, averaged together.",
  Poisson_GLM: "Generalized linear model with a Poisson link — assumes the variance of daily incident counts equals their mean.",
  NegBinomial_GLM: "Generalized linear model with a negative-binomial link — like the Poisson GLM but lets variance exceed the mean, the usual case for real count data.",
  SARIMAX: "Seasonal ARIMA(1,0,1)(1,0,1,7) — autocorrelation plus a weekly cycle, with calendar flags and rainfall as exogenous inputs.",
  LSTM: "Small recurrent neural network reading the last 14 days of counts. Predicts one day at a time and feeds its own output back in for the days after.",
  GRU: "Gated recurrent unit, a lighter cousin of the LSTM with fewer internal gates, over the same 14-day lookback window.",
};

const fmt2 = (n: number | null | undefined) => (n == null || !isFinite(n) ? null : n.toFixed(2));
const fmt3 = (n: number | null | undefined) => (n == null || !isFinite(n) ? null : n.toFixed(3));

/**
 * Hover tooltip for a metric label — the formula, as a fixed property of the
 * metric (like HOW_IT_WORKS is a fixed property of the model), not anything
 * read from a row. Shared by the stat strip below and by
 * PredictiveIncidentChart's table/header labels, so a formula can't drift
 * between the two places it's shown.
 *
 * Rendered through a portal into document.body instead of as a normal
 * absolutely-positioned child. The metrics table wraps its <table> in a div
 * with `overflow-x: auto` — CSS computes overflow-y on that div to "auto" as
 * well the moment overflow-x is anything but "visible" (a same-element
 * visible/non-visible mix isn't allowed), so a tooltip positioned relative to
 * a header cell inside it was being clipped by that div's own scroll box
 * before it ever reached the page, rendering as nothing. A portal escapes
 * that ancestor's overflow (and any stacking context a page nav bar sets up)
 * entirely, so it's positioned in viewport (`position: fixed`) coordinates
 * taken from the trigger's own bounding box and re-measured on scroll/resize.
 */
export function MetricHint({ hint, children }: { hint: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  const measure = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.top, left: rect.left + rect.width / 2 });
  };

  const openTip = () => {
    measure();
    setShow(true);
  };
  const closeTip = () => setShow(false);

  // Re-measure while open so the tooltip tracks its trigger through a scroll
  // (the table's own horizontal scrollbar included) instead of freezing in a
  // stale spot once the portal has escaped that container.
  useEffect(() => {
    if (!show) return;
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  return (
    <span
      ref={ref}
      onMouseEnter={openTip}
      onMouseLeave={closeTip}
      onFocus={openTip}
      onBlur={closeTip}
      tabIndex={0}
      style={{ cursor: "help", borderBottom: "1px dotted #94a3b8", outline: "none" }}
    >
      {children}
      {show &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            role="tooltip"
            style={{
              position: "fixed",
              top: pos.top - 8,
              left: pos.left,
              transform: "translate(-50%, -100%)",
              background: "#0f172a",
              color: "#e2e8f0",
              padding: "9px 11px",
              borderRadius: 7,
              fontSize: "0.7rem",
              fontWeight: 400,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              whiteSpace: "pre-line",
              lineHeight: 1.55,
              width: "max-content",
              maxWidth: 260,
              // Above any sticky/fixed page chrome (nav bar included) —
              // this renders in document.body, outside every ancestor
              // stacking context this component would otherwise inherit.
              zIndex: 2147483647,
              boxShadow: "0 6px 18px rgba(0,0,0,0.3)",
              textAlign: "left",
              textTransform: "none",
              letterSpacing: "normal",
              pointerEvents: "none",
            }}
          >
            {hint}
            <span
              style={{
                position: "absolute",
                top: "100%",
                left: "50%",
                transform: "translateX(-50%)",
                width: 0,
                height: 0,
                borderLeft: "5px solid transparent",
                borderRight: "5px solid transparent",
                borderTop: "5px solid #0f172a",
              }}
            />
          </span>,
          document.body
        )}
    </span>
  );
}

/** Formula text per metric. `row` supplies the numbers for a real plugged-in
 * calculation where one can be reconstructed from figures already on screen
 * (MASE = MAE ÷ naive MAE, and both MAE and MASE are already displayed) —
 * everywhere else only the general formula is shown, since the underlying
 * sums (Σ|actual|, ΣSSE, …) never reach the frontend and a plug-in there
 * would have to be invented rather than computed.
 */
export function metricHintFor(label: string, row?: ModelMetric | null): string {
  switch (label) {
    case "WMAPE":
      return "Weighted MAPE\n= Σ|actual − predicted| ÷ Σ|actual| × 100\n\nTotal error as a share of total incidents — one big miss on a busy day counts more than the same miss on a quiet one.";
    case "MAE":
      return "Mean Absolute Error\n= average of |actual − predicted|\n\nSame units as the forecast (incidents/day).";
    case "RMSE":
      return "Root Mean Squared Error\n= √(average of (actual − predicted)²)\n\nSquares each error before averaging, so a few big misses pull it up more than MAE does.";
    case "R²":
    case "R² Score":
      return "R² (coefficient of determination)\n= 1 − (Σ squared error ÷ Σ squared deviation from the actual mean)\n\n1.0 = perfect fit, 0 = no better than always predicting the average, negative = worse than that.";
    case "MASE": {
      const naive =
        row?.MAE != null && row?.MASE != null && isFinite(row.MAE) && isFinite(row.MASE) && row.MASE > 0
          ? row.MAE / row.MASE
          : null;
      return (
        "Mean Absolute Scaled Error\n= this model's MAE ÷ MAE of a naive “same day last week” forecast" +
        (naive != null
          ? `\n= ${row!.MAE!.toFixed(3)} ÷ ${naive.toFixed(3)} = ${row!.MASE!.toFixed(3)}`
          : "") +
        "\n\nBelow 1.0 beats that baseline; at or above 1.0 does not."
      );
    }
    case "N":
      return "Number of days this model was actually scored against in the current Range/Weather view.";
    default:
      return "";
  }
}

/** Brief per-model explanation for the "Real-World ML Validation Metrics"
 * table's Model column hover — the same fixed, algorithm-level description
 * used in the expanded narrative cards below, exposed here so the table
 * doesn't need its own copy. */
export function modelHintFor(key: ModelKey): string {
  return HOW_IT_WORKS[key] ?? "";
}

/** MASE is a ratio against the seasonal-naive (lag-7) benchmark — never a percentage. */
function maseSentence(mase: number | null): string {
  if (mase == null || !isFinite(mase)) return "";
  const pct = Math.abs(1 - mase) * 100;
  if (mase < 1) return `MASE ${mase.toFixed(3)} — ${pct.toFixed(0)}% better than repeating last week.`;
  if (mase > 1) return `MASE ${mase.toFixed(3)} — ${pct.toFixed(0)}% worse than repeating last week.`;
  return `MASE ${mase.toFixed(3)} — level with repeating last week.`;
}

export default function IncidentNarrative({
  selected,
  metrics,
  scoringCaption,
  weather,
  horizonDays,
}: {
  selected: ModelKey[];
  metrics: ModelMetric[];
  /** The chart's own caption for this exact table — reused so the two can never disagree. */
  scoringCaption: string;
  weather: "all" | "dry" | "wet";
  horizonDays: number;
}) {
  // Collapsed by default: the report is a deliberate action, not something that
  // pushes the metrics table off screen every time the page loads.
  const [open, setOpen] = useState(false);

  if (!metrics || metrics.length === 0) return null;

  const byModel = new Map(metrics.map((m) => [m.model, m]));

  return (
    <section
      style={{
        border: "1px solid color-mix(in srgb, #4f46e5 28%, transparent)",
        borderRadius: 12,
        background: "linear-gradient(135deg, color-mix(in srgb, #6366f1 11%, var(--bg-surface)), color-mix(in srgb, #4f46e5 4%, var(--bg-surface)))",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.5)",
        padding: open ? "18px 20px" : "12px 18px",
        display: "flex",
        flexDirection: "column",
        gap: open ? 14 : 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 190, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 9, flex: "none",
            background: "linear-gradient(135deg, #6366f1, #4f46e5)", color: "#fff", boxShadow: "0 1px 6px rgba(79,70,229,0.35)" }}>
            <Sparkles size={15} strokeWidth={2.4} />
          </span>
          <div>
          <h4 style={{ margin: 0, fontSize: "0.98rem", fontWeight: 800, letterSpacing: "-0.01em", color: "#0f172a" }}>
            Narrative Explanation
          </h4>
          {!open && (
            <p style={{ margin: "3px 0 0", fontSize: "0.78rem", color: "#64748b" }}>
              Plain-language read-out of how {selected.length === 1 ? "the selected model" : `the ${selected.length} selected models`} performed
            </p>
          )}
          </div>
        </div>

        {/* Collapsed, the row was mostly dead space. These chips put the headline
            verdict in it, so the strip is informative even before it is opened. */}
        {!open && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flex: 1, justifyContent: "flex-end" }}>
            {selected.map((k) => {
              const r = byModel.get(k);
              if (!r) return null;
              const mase = r.MASE != null && isFinite(r.MASE) ? r.MASE : null;
              return (
                <span
                  key={k}
                  title={r.isChampion ? "Champion — the pipeline's selected model" : r.source === "holdout" ? "No scored days in the current view — showing the full-holdout numbers" : undefined}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 7,
                    padding: "5px 11px", borderRadius: 8, fontSize: "0.735rem",
                    background: r.isChampion ? "#f0fdf4" : "#f8fafc",
                    border: `1px solid ${r.isChampion ? "#bbf7d0" : "#e6ebf3"}`,
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: META[k]?.color ?? "#64748b" }} />
                  <b style={{ color: "#0f172a" }}>{META[k]?.label ?? k}</b>
                  <span style={{ fontWeight: 700, fontSize: "0.66rem", color: r.isChampion ? "#15803d" : "#94a3b8" }}>
                    {r.isChampion ? "CHAMPION" : "CANDIDATE"}
                  </span>
                  {r.WMAPE != null && (
                    <span style={{ color: "#475569" }}>{r.WMAPE.toFixed(2)}%</span>
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
          {scoringCaption}
          {weather !== "all" ? ` · scored on ${weather} days only` : null}
        </p>

      {/* The read-out is the language model's alone. The metrics it was given
          are the ones on the card above, so the two cannot disagree. */}
      <AiModelInsight
        quantity="incidents"
        horizonDays={horizonDays}
        weatherMode={weather === "all" ? null : "with"}
        labelFor={(name) => META[name as ModelKey]?.label ?? name}
        metrics={selected
          .map((k) => byModel.get(k))
          .filter((r): r is ModelMetric => !!r)
          .map<InsightMetric>((r) => ({
            model: r.model,
            wmape: r.WMAPE,
            mae: r.MAE,
            rmse: r.RMSE,
            r2: r.R2,
            mase: r.MASE,
            // The incident pipeline marks one champion rather than ranking the
            // roster, and scores every candidate — so there is no rank to send
            // and nothing here is rejected.
            rank: null,
            accepted: true,
            diagnosis: r.Diagnosis,
          }))}
      />

      </div>
      )}
    </section>
  );
}
