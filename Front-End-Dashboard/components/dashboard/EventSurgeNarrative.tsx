"use client";

import NarrativePanel, { NarrativeChip } from "./NarrativePanel";

/**
 * Narrative Explanation for Event Surge Impact by Exit.
 *
 * Its own endpoint again, for the same reason as the congestion map's: this is
 * not a forecast of a series but an UPLIFT — how much more traffic an exit
 * takes on an Arena event day than on a matched normal day — and its honest
 * benchmark is ignoring the event entirely, not a seasonal-naive repeat.
 */

export type EventSurgeValidationRow = {
  model: string;
  wmape: number | null;
  accepted?: boolean | null;
  diagnosis?: string | null;
};

export default function EventSurgeNarrative({
  models,
  noAdjustment,
  eventDays,
  firstEvent,
  lastEvent,
  mode,
  eventTitle,
  eventDate,
  venue,
  exitsMaterial,
  exitsTotal,
  totalAdded,
  upliftPct,
  topExit,
  topAdded,
  topSharePct,
  top2SharePct,
}: {
  models: EventSurgeValidationRow[];
  noAdjustment: { model: string; wmape: number | null } | null;
  eventDays: number | null;
  firstEvent: string | null;
  lastEvent: string | null;
  mode: "observed" | "upcoming";
  eventTitle: string | null;
  eventDate: string | null;
  venue: string | null;
  exitsMaterial: number;
  exitsTotal: number;
  totalAdded: number;
  upliftPct: number | null;
  topExit: string | null;
  topAdded: number | null;
  topSharePct: number | null;
  top2SharePct: number | null;
}) {
  const champ = models[0] ?? null;
  if (!champ) return null;

  // Does the event adjustment earn its place against doing nothing at all?
  const beatsDoingNothing =
    champ.wmape != null && noAdjustment?.wmape != null && champ.wmape < noAdjustment.wmape;

  return (
    <NarrativePanel
      subtitle="Plain-language read-out of how far to trust this event estimate"
      metrics={models.map((m) => ({ model: m.model }))}
      endpoint="/api/ai-insight/event-surge-narrative"
      subjectKey={`event:${champ.model}:${mode}:${eventTitle ?? "observed"}:${exitsMaterial}/${exitsTotal}`}
      chips={
        <>
          <NarrativeChip tone={champ.accepted ? "good" : "neutral"}>
            <b style={{ color: "var(--text-primary)" }}>{champ.model}</b>
            {champ.wmape != null && (
              <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                {champ.wmape.toFixed(1)}% error
              </span>
            )}
          </NarrativeChip>
          {noAdjustment?.wmape != null && (
            <NarrativeChip tone={beatsDoingNothing ? "good" : "neutral"}>
              <span style={{ fontWeight: 600 }}>
                {beatsDoingNothing ? "beats ignoring the event" : "no better than ignoring the event"}
              </span>
            </NarrativeChip>
          )}
        </>
      }
      contextLine={
        <>
          Read from the held-out event-day error
          {eventDays != null && <> · measured on {eventDays} past event days</>}
          {noAdjustment?.wmape != null && (
            <> · ignoring the event scores {noAdjustment.wmape.toFixed(2)}%</>
          )}
        </>
      }
      buildBody={() => ({
        models: models.map((m) => ({
          model: m.model,
          wmape: m.wmape,
          accepted: m.accepted ?? null,
          diagnosis: m.diagnosis ?? null,
        })),
        noAdjustment,
        coverage: { eventDays, firstEvent, lastEvent },
        situation: {
          mode,
          eventTitle,
          eventDate,
          venue,
          exitsMaterial,
          exitsTotal,
          totalAdded,
          upliftPct,
          topExit,
          topAdded,
          topSharePct,
          top2SharePct,
        },
      })}
    />
  );
}
