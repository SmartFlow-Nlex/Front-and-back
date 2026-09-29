"use client";

import NarrativePanel, { NarrativeChip } from "./NarrativePanel";

/**
 * Narrative Explanation for the "Time to Clear" survival curves.
 *
 * Its own endpoint, for the same reason the congestion map has one: these are
 * not forecasts and they have no error. Each curve is a measured DISTRIBUTION —
 * the share of that kind of incident still blocking the road as the minutes
 * pass — and the thing a reader needs from it is "does this kind routinely
 * outlast an hour", not "how accurate is it". A prompt that reasons in WMAPE
 * would have had nothing true to say about a median.
 *
 * The curve itself is ~100 points per group and the wrong shape to reason over,
 * so what goes to the model is what the chart already derives: the median, how
 * much is still open at the 60- and 120-minute marks, and how many real
 * incidents sit behind each line.
 */

export type ClearanceNarrativeGroup = {
  group: string;
  n: number | null;
  medianMin: number | null;
  stillOpen60: number | null;
  stillOpen120: number | null;
  isBaseline?: boolean;
};

export default function ClearanceNarrative({
  dimension,
  groups,
  trainedAt,
}: {
  dimension: string;
  groups: ClearanceNarrativeGroup[];
  trainedAt?: string | null;
}) {
  if (groups.length === 0) return null;

  const ranked = groups
    .filter((g) => !g.isBaseline && g.medianMin != null)
    .sort((a, b) => (a.medianMin ?? 0) - (b.medianMin ?? 0));
  const fastest = ranked[0];
  const slowest = ranked[ranked.length - 1];
  const worstTail = groups
    .filter((g) => g.stillOpen60 != null)
    .sort((a, b) => (b.stillOpen60 ?? 0) - (a.stillOpen60 ?? 0))[0];

  const pct = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? null : `${Math.round(v * 100)}%`;

  return (
    <NarrativePanel
      subtitle={`Plain-language read-out of how long each ${dimension} takes to clear`}
      metrics={groups.map((g) => ({ model: g.group }))}
      endpoint="/api/ai-insight/clearance-narrative"
      subjectKey={`clearance:${dimension}:${groups
        .map((g) => `${g.group}=${g.medianMin ?? "x"}`)
        .join(",")}`}
      chips={
        <>
          {slowest && (
            <NarrativeChip tone="neutral">
              <b style={{ color: "var(--text-primary)" }}>{slowest.group}</b>
              <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                slowest · {slowest.medianMin} min median
              </span>
            </NarrativeChip>
          )}
          {worstTail?.stillOpen60 != null && worstTail.stillOpen60 > 0.25 && (
            <NarrativeChip tone="neutral">
              <span style={{ fontWeight: 600 }}>
                {pct(worstTail.stillOpen60)} of {worstTail.group} still open at 1 h
              </span>
            </NarrativeChip>
          )}
        </>
      }
      contextLine={
        <>
          Read from the measured clearance curves
          {fastest && slowest && fastest.group !== slowest.group && (
            <>
              {" "}· {fastest.group} {fastest.medianMin} min to {slowest.group} {slowest.medianMin} min
            </>
          )}
          {trainedAt && <> · model fitted {trainedAt}</>}
        </>
      }
      buildBody={() => ({
        dimension,
        trainedAt: trainedAt ?? null,
        groups: groups.map((g) => ({
          group: g.group,
          n: g.n,
          medianMin: g.medianMin,
          stillOpen60: g.stillOpen60,
          stillOpen120: g.stillOpen120,
          isBaseline: g.isBaseline ?? false,
        })),
      })}
    />
  );
}
