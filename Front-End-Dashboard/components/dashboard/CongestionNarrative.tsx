"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import AiModelInsight, { type InsightMetric } from "./AiModelInsight";

/**
 * Narrative Explanation for the Predictive Congestion State Map.
 *
 * The same panel the forecast cards carry, pointed at the congestion
 * classifier's own endpoint. It has to be a different endpoint because the
 * numbers mean something different: this model is not forecasting a quantity
 * with an error, it is LABELLING each exit-hour Clear / Heavy / Severe and is
 * scored by accuracy against a "nothing changes" benchmark, per hour ahead.
 * Feeding accuracy into a prompt that reasons about WMAPE and MASE would have
 * produced confident nonsense.
 *
 * Collapsed by default, like the others: generating costs a model call, so it
 * is a deliberate action rather than something every page load spends.
 */

export type CongestionNarrativeModel = {
  model: string;
  accuracy: number | null;
  accepted: boolean;
  rejectedReason?: string | null;
  baseline?: { model: string; accuracy: number | null } | null;
};

export type CongestionNarrativeHorizon = {
  horizon: number;
  accuracy: number | null;
  persistenceAccuracy: number | null;
  n?: number | null;
};

export default function CongestionNarrative({
  modelInfo,
  horizons,
  exitsTotal,
  exitsSevere,
  hoursCovered,
  neverPredictsHeavy,
}: {
  modelInfo: CongestionNarrativeModel | null;
  horizons: CongestionNarrativeHorizon[];
  exitsTotal: number;
  exitsSevere: number;
  hoursCovered: number;
  neverPredictsHeavy: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!modelInfo) return null;

  const pct = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? null : `${(v * 100).toFixed(1)}%`;

  const first = horizons[0];
  const last = horizons[horizons.length - 1];
  const beatsBenchmark =
    last?.accuracy != null && last?.persistenceAccuracy != null && last.accuracy > last.persistenceAccuracy;

  // Only the served model is on the card, so the roster is one row. The shared
  // panel uses it for its "nothing to explain" guard and for labelling.
  const metrics: InsightMetric[] = [{ model: modelInfo.model }];

  return (
    <section
      style={{
        border: "1px solid color-mix(in srgb, #4f46e5 28%, transparent)",
        borderRadius: 12,
        background:
          "linear-gradient(135deg, color-mix(in srgb, #6366f1 11%, var(--bg-surface)), color-mix(in srgb, #4f46e5 4%, var(--bg-surface)))",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.5)",
        padding: open ? "18px 20px" : "12px 18px",
        display: "flex",
        flexDirection: "column",
        gap: open ? 14 : 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 190, display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 9, flex: "none",
              background: "linear-gradient(135deg, #6366f1, #4f46e5)", color: "#fff",
              boxShadow: "0 1px 6px rgba(79,70,229,0.35)",
            }}
          >
            <Sparkles size={15} strokeWidth={2.4} />
          </span>
          <div>
            <h4 style={{ margin: 0, fontSize: "0.98rem", fontWeight: 800, letterSpacing: "-0.01em", color: "var(--text-primary)" }}>
              Narrative Explanation
            </h4>
            {!open && (
              <p style={{ margin: "3px 0 0", fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                Plain-language read-out of how far ahead this map can be trusted
              </p>
            )}
          </div>
        </div>

        {/* Collapsed, the row still carries the verdict, so it is informative
            before anyone spends a model call on it. */}
        {!open && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flex: 1, justifyContent: "flex-end" }}>
            <span
              style={{
                display: "inline-flex", alignItems: "center", gap: 7,
                padding: "5px 11px", borderRadius: 8, fontSize: "0.735rem",
                background: modelInfo.accepted ? "var(--color-success-bg)" : "var(--bg-surface-hover)",
                border: `1px solid ${modelInfo.accepted ? "var(--color-success-border)" : "var(--border-default)"}`,
              }}
            >
              <b style={{ color: "var(--text-primary)" }}>{modelInfo.model}</b>
              {pct(modelInfo.accuracy) && (
                <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                  {pct(modelInfo.accuracy)} accurate
                </span>
              )}
            </span>
            {first && last && (
              <span
                style={{
                  display: "inline-flex", alignItems: "center",
                  padding: "5px 11px", borderRadius: 8, fontSize: "0.735rem", fontWeight: 600,
                  background: beatsBenchmark ? "var(--color-success-bg)" : "var(--bg-surface-hover)",
                  border: `1px solid ${beatsBenchmark ? "var(--color-success-border)" : "var(--border-default)"}`,
                  color: beatsBenchmark ? "var(--color-success)" : "var(--text-secondary)",
                }}
              >
                {beatsBenchmark ? `still beats no-change at +${last.horizon}h` : `no better than no-change by +${last.horizon}h`}
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
            background: open ? "var(--bg-surface)" : "linear-gradient(135deg, #6366f1, #4f46e5)",
            color: open ? "var(--text-secondary)" : "#fff",
            boxShadow: open ? "none" : "0 1px 6px rgba(79,70,229,0.35)",
          }}
        >
          {open ? "Hide report" : "Generate report"}
        </button>
      </div>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>
            Read from this model&apos;s held-out accuracy per hour ahead
            {first && last && (
              <>
                {" "}· {pct(first.accuracy)} at +{first.horizon}h to {pct(last.accuracy)} at +{last.horizon}h
              </>
            )}
            {modelInfo.baseline?.accuracy != null && (
              <> · benchmark {modelInfo.baseline.model} {pct(modelInfo.baseline.accuracy)}</>
            )}
          </p>

          <AiModelInsight
            quantity="volume"
            metrics={metrics}
            horizonDays={hoursCovered}
            endpoint="/api/ai-insight/congestion-narrative"
            subjectKey={`congestion:${modelInfo.model}:${last?.horizon ?? 0}:${exitsSevere}/${exitsTotal}`}
            buildBody={() => ({
              models: [
                {
                  model: modelInfo.model,
                  accuracy: modelInfo.accuracy,
                  accepted: modelInfo.accepted,
                  rejectedReason: modelInfo.rejectedReason ?? null,
                },
              ],
              baseline: modelInfo.baseline ?? null,
              horizons: horizons.map((h) => ({
                horizon: h.horizon,
                accuracy: h.accuracy,
                persistence: h.persistenceAccuracy,
                n: h.n ?? null,
              })),
              situation: {
                exitsTotal,
                exitsSevere,
                hoursCovered,
                neverPredictsHeavy,
              },
            })}
          />
        </div>
      )}
    </section>
  );
}
