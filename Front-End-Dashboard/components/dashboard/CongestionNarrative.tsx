"use client";

import NarrativePanel, { NarrativeChip } from "./NarrativePanel";

/**
 * Narrative Explanation for the Predictive Congestion State Map.
 *
 * It posts to its own endpoint because the numbers mean something different
 * from the forecast cards': this model is not predicting a quantity with an
 * error, it is LABELLING each exit-hour and is scored by accuracy against a
 * "nothing changes" benchmark, per hour ahead. Feeding accuracy to a prompt
 * that reasons about percentage error would have produced confident nonsense.
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
  if (!modelInfo) return null;

  const pct = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? null : `${(v * 100).toFixed(1)}%`;

  const first = horizons[0];
  const last = horizons[horizons.length - 1];
  const beatsBenchmark =
    last?.accuracy != null && last?.persistenceAccuracy != null && last.accuracy > last.persistenceAccuracy;

  return (
    <NarrativePanel
      subtitle="Plain-language read-out of how far ahead this map can be trusted"
      metrics={[{ model: modelInfo.model }]}
      horizonDays={hoursCovered}
      endpoint="/api/ai-insight/congestion-narrative"
      subjectKey={`congestion:${modelInfo.model}:${last?.horizon ?? 0}:${exitsSevere}/${exitsTotal}`}
      chips={
        <>
          <NarrativeChip tone={modelInfo.accepted ? "good" : "neutral"}>
            <b style={{ color: "var(--text-primary)" }}>{modelInfo.model}</b>
            {pct(modelInfo.accuracy) && (
              <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                {pct(modelInfo.accuracy)} accurate
              </span>
            )}
          </NarrativeChip>
          {first && last && (
            <NarrativeChip tone={beatsBenchmark ? "good" : "neutral"}>
              <span style={{ fontWeight: 600 }}>
                {beatsBenchmark
                  ? `still beats no-change at +${last.horizon}h`
                  : `no better than no-change by +${last.horizon}h`}
              </span>
            </NarrativeChip>
          )}
        </>
      }
      contextLine={
        <>
          Read from this model&apos;s held-out accuracy per hour ahead
          {first && last && (
            <>
              {" "}· {pct(first.accuracy)} at +{first.horizon}h to {pct(last.accuracy)} at +{last.horizon}h
            </>
          )}
          {modelInfo.baseline?.accuracy != null && (
            <> · benchmark {modelInfo.baseline.model} {pct(modelInfo.baseline.accuracy)}</>
          )}
        </>
      }
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
        })),
        situation: { exitsTotal, exitsSevere, hoursCovered, neverPredictsHeavy },
      })}
    />
  );
}
