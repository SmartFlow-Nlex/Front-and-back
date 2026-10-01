"use client";

import NarrativePanel, { NarrativeChip } from "./NarrativePanel";

/**
 * Narrative Explanation for the incident-type priority ranking.
 *
 * Its own endpoint because what this panel crosses is not a model output at
 * all, it is three things of different provenance multiplied together, and the
 * prompt has to know which is which:
 *
 *   median clearance time   MEASURED from real incidents
 *   predicted count         the corridor forecast, APPORTIONED by historical
 *                           share — not a separate forecast per type
 *   dispatch package        operational doctrine, not predicted by anything
 *
 * A prompt told only "here are some numbers" will happily report the dispatch
 * package as a model recommendation, which would put words in the system's
 * mouth about how to staff a scene. The endpoint's prompt labels each source
 * explicitly and is told to say when it leans on the apportioned split.
 */

export type PriorityNarrativeType = {
  label: string;
  medianClearanceMin: number | null;
  predictedCount: number | null;
  sharePct: number | null;
  dispatch: string | null;
};

export default function IncidentPriorityNarrative({
  horizonDays,
  totalPredicted,
  forecastModel,
  types,
}: {
  horizonDays: number;
  totalPredicted: number | null;
  forecastModel: string | null;
  types: PriorityNarrativeType[];
}) {
  if (types.length === 0) return null;

  /* Expected blocked-road time. Computed here rather than server-side so the
     number the model is given is the same one the panel's own bars are drawn
     from — a second derivation is a second thing to drift. */
  const withLoad = types.map((t) => ({
    ...t,
    expectedLaneMinutes:
      t.medianClearanceMin != null && t.predictedCount != null
        ? t.medianClearanceMin * t.predictedCount
        : null,
  }));

  const ranked = [...withLoad]
    .filter((t) => t.expectedLaneMinutes != null)
    .sort((a, b) => (b.expectedLaneMinutes ?? 0) - (a.expectedLaneMinutes ?? 0));
  const top = ranked[0];
  const slowest = [...withLoad]
    .filter((t) => t.medianClearanceMin != null)
    .sort((a, b) => (b.medianClearanceMin ?? 0) - (a.medianClearanceMin ?? 0))[0];

  /* Worth saying out loud when they disagree: the type that costs the most road
     time is often not the one that takes longest per incident. */
  const topIsNotSlowest = top && slowest && top.label !== slowest.label;

  return (
    <NarrativePanel
      subtitle="Plain-language read-out of which incident types to resource first"
      metrics={types.map((t) => ({ model: t.label }))}
      endpoint="/api/ai-insight/incident-priority-narrative"
      subjectKey={`incident-priority:${horizonDays}:${ranked
        .map((t) => `${t.label}=${Math.round(t.expectedLaneMinutes ?? 0)}`)
        .join(",")}`}
      horizonDays={horizonDays}
      chips={
        <>
          {top && (
            <NarrativeChip tone="neutral">
              <b style={{ color: "var(--text-primary)" }}>{top.label}</b>
              <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                highest expected road time
              </span>
            </NarrativeChip>
          )}
          {topIsNotSlowest && (
            <NarrativeChip tone="neutral">
              <span style={{ fontWeight: 600 }}>
                {slowest.label} is slowest per incident
              </span>
            </NarrativeChip>
          )}
        </>
      }
      contextLine={
        <>
          Measured clearance times crossed with the {horizonDays}-day incident forecast
          {forecastModel && <> ({forecastModel})</>}
          {totalPredicted != null && <> · {Math.round(totalPredicted).toLocaleString()} incidents expected</>}
        </>
      }
      buildBody={() => ({
        horizonDays,
        totalPredicted,
        forecastModel,
        types: withLoad.map((t) => ({
          label: t.label,
          medianClearanceMin: t.medianClearanceMin,
          predictedCount: t.predictedCount,
          expectedLaneMinutes: t.expectedLaneMinutes,
          sharePct: t.sharePct,
          dispatch: t.dispatch,
        })),
      })}
    />
  );
}
