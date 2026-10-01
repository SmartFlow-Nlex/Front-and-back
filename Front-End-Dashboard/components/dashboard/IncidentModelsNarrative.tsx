"use client";

import NarrativePanel, { NarrativeChip } from "./NarrativePanel";

/**
 * Narrative Explanation for the severity / clearance / secondary-risk panel.
 *
 * Three models on three incompatible scales, which is exactly why this posts to
 * its own endpoint rather than the forecast one:
 *
 *   severity        accuracy, plus an ordinal MAE measured in RANKS
 *   clearance       a concordance index — an ORDERING, not an error
 *   secondary risk  AUC, meaningless unless read against the base rate
 *
 * Sent to the forecast prompt, a concordance index of 0.71 comes back described
 * as a 71% error and an AUC of 0.68 as "68% accurate". Both are wrong, both
 * read as authoritative, and an operator would resource against them.
 *
 * They share one panel rather than getting three because the useful read-out is
 * about their interaction — a clearance model that orders incidents well is
 * worth more when the severity classifier is under-calling the class that takes
 * longest to clear, and no single-model prompt could say that.
 */

export type SeverityModelRow = {
  model: string;
  accuracy: number | null;
  maeOrdinal: number | null;
  n: number | null;
};

export default function IncidentModelsNarrative({
  champion,
  severityModels,
  severityBreakdown,
  clearance,
  secondaryRisk,
  hotspots,
}: {
  champion: string | null;
  severityModels: SeverityModelRow[];
  severityBreakdown: { label: string; actualCount: number; predictedCount: number }[];
  clearance: {
    concordanceIndex: number | null;
    maeMinutes: number | null;
    n: number | null;
    medianMin: number | null;
    meanMin: number | null;
  } | null;
  secondaryRisk: {
    auc: number | null;
    baseRate: number | null;
    n: number | null;
    kmRadius: number | null;
    avgRisk: number | null;
  } | null;
  hotspots: {
    name: string;
    km: number | null;
    n: number | null;
    avgRisk: number | null;
    actualSecondaryCount: number | null;
  }[];
}) {
  if (severityModels.length === 0 && !clearance && !secondaryRisk) return null;

  const pct = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? null : `${(v * 100).toFixed(1)}%`;

  const championRow =
    severityModels.find((m) => m.model === champion) ?? severityModels[0] ?? null;

  /* Whether the risk model is actually separating anything. AUC alone reads as
     a score; against 0.5 it reads as a verdict, which is the point. */
  const aucLift =
    secondaryRisk?.auc != null && Number.isFinite(secondaryRisk.auc)
      ? secondaryRisk.auc - 0.5
      : null;

  return (
    <NarrativePanel
      subtitle="Plain-language read-out of the severity, clearance and secondary-risk models"
      metrics={[
        ...severityModels.map((m) => ({ model: m.model })),
        { model: "Clearance time (Cox PH)" },
        { model: "Secondary incident risk" },
      ]}
      endpoint="/api/ai-insight/incident-models-narrative"
      subjectKey={`incident-models:${champion ?? "none"}:${championRow?.accuracy ?? "x"}:${
        clearance?.concordanceIndex ?? "x"
      }:${secondaryRisk?.auc ?? "x"}`}
      chips={
        <>
          {championRow && pct(championRow.accuracy) && (
            <NarrativeChip tone="good">
              <b style={{ color: "var(--text-primary)" }}>{championRow.model}</b>
              <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                {pct(championRow.accuracy)} accurate
              </span>
            </NarrativeChip>
          )}
          {aucLift != null && (
            <NarrativeChip tone={aucLift > 0.1 ? "good" : "neutral"}>
              <span style={{ fontWeight: 600 }}>
                {aucLift > 0.1
                  ? `secondary risk separates (AUC ${secondaryRisk?.auc?.toFixed(2)})`
                  : `secondary risk near a coin toss (AUC ${secondaryRisk?.auc?.toFixed(2)})`}
              </span>
            </NarrativeChip>
          )}
        </>
      }
      contextLine={
        <>
          Read from the held-out scores already on this panel
          {clearance?.concordanceIndex != null && (
            <> · clearance concordance {clearance.concordanceIndex.toFixed(3)}</>
          )}
          {secondaryRisk?.baseRate != null && (
            <> · secondary incidents follow {pct(secondaryRisk.baseRate)} of the time</>
          )}
        </>
      }
      buildBody={() => ({
        severity: {
          champion: champion ?? null,
          models: severityModels.map((m) => ({
            model: m.model,
            accuracy: m.accuracy,
            maeOrdinal: m.maeOrdinal,
            n: m.n,
          })),
          breakdown: severityBreakdown.map((b) => ({
            label: b.label,
            actualCount: b.actualCount,
            predictedCount: b.predictedCount,
          })),
        },
        clearance: clearance ?? undefined,
        secondaryRisk: secondaryRisk ?? undefined,
        // Only the worst few: the panel itself ranks the full list, and every
        // extra row is prompt tokens spent on something already on screen.
        hotspots: hotspots.slice(0, 5),
      })}
    />
  );
}
