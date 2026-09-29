"use client";

import NarrativePanel, { NarrativeChip } from "./NarrativePanel";

/**
 * Narrative Explanation for the high-incident-day risk model.
 *
 * Its own endpoint for one reason: an AUC is unreadable without its base rate.
 * 0.68 reads as "68% accurate" to almost everyone, and it is not — it is the
 * chance the model scores a real high-incident day above a normal one. Whether
 * that is good depends entirely on how often those days occur. Against a 12%
 * base rate it is a useful model; against 48% it is close to worthless.
 *
 * The forecast prompt reasons in WMAPE and MASE and has no way to know that, so
 * it would report the AUC as an accuracy. This endpoint's prompt is given both
 * numbers and forbidden from stating either alone.
 *
 * The second trap is the scenario curves. They are the model's OWN fitted
 * probabilities at each rainfall or volume level, not observed frequencies and
 * not a forecast for any particular day — and when rainfall is not significant,
 * the curve still slopes. The prompt is told to say so plainly rather than
 * describe a non-significant effect as real but small.
 */

export type ScenarioPoint = { rainMm?: number; volume?: number; probability: number };

export default function HighIncidentDayNarrative({
  auc,
  baseRate,
  n,
  rainSignificant,
  rainPValue,
  topDriver,
  rainScenarios,
  volumeScenarios,
  trainedAt,
}: {
  auc: number | null;
  baseRate: number | null;
  n: number | null;
  rainSignificant: boolean | null;
  rainPValue: number | null;
  topDriver: { feature: string; effectSize: number } | null;
  rainScenarios: { rainMm: number; probability: number }[];
  volumeScenarios: { volume: number; probability: number }[];
  trainedAt: string | null;
}) {
  if (auc == null && baseRate == null && rainScenarios.length === 0) return null;

  const pct = (v: number | null) => (v == null ? null : `${(v * 100).toFixed(0)}%`);

  /* How far the model's probability moves from the driest to the wettest
     scenario on screen. Shown as a chip because it is the honest size of the
     rainfall story — and it is the number that makes a non-significant p-value
     worth reading, since a wide swing that is not significant is exactly the
     case a reader would otherwise over-interpret. */
  const rainSpan =
    rainScenarios.length >= 2
      ? {
          from: rainScenarios[0],
          to: rainScenarios[rainScenarios.length - 1],
        }
      : null;

  return (
    <NarrativePanel
      subtitle="Plain-language read-out of what makes a high-incident day more likely"
      metrics={[{ model: "High-incident-day risk (logistic regression)" }]}
      endpoint="/api/ai-insight/high-incident-day-narrative"
      subjectKey={`high-incident-day:${auc ?? "?"}:${baseRate ?? "?"}:${rainSignificant ?? "?"}:${rainScenarios
        .map((s) => `${s.rainMm}=${s.probability.toFixed(3)}`)
        .join(",")}`}
      horizonDays={1}
      chips={
        <>
          {auc != null && baseRate != null && (
            <NarrativeChip tone="neutral">
              <b style={{ color: "var(--text-primary)" }}>AUC {auc.toFixed(3)}</b>
              <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                against a {pct(baseRate)} base rate
              </span>
            </NarrativeChip>
          )}
          {rainSignificant === false && (
            <NarrativeChip tone="neutral">
              <span style={{ fontWeight: 600 }}>
                Rainfall not significant
                {rainPValue != null && ` (p = ${rainPValue.toFixed(3)})`}
              </span>
            </NarrativeChip>
          )}
          {rainSpan && (
            <NarrativeChip tone="neutral">
              <span style={{ fontWeight: 600 }}>
                {pct(rainSpan.from.probability)} → {pct(rainSpan.to.probability)} across the rain range
              </span>
            </NarrativeChip>
          )}
        </>
      }
      contextLine={
        <>
          Day-level probability for the whole corridor, scored on held-out days
          {n != null && <> · {n.toLocaleString()} days</>}
          {trainedAt && <> · trained {trainedAt}</>}
        </>
      }
      buildBody={() => ({
        auc,
        baseRate,
        n,
        rainSignificant,
        rainPValue,
        topDriver,
        rainScenarios,
        volumeScenarios,
        trainedAt,
      })}
    />
  );
}
