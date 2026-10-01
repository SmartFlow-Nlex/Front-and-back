"use client";

import NarrativePanel, { NarrativeChip } from "./NarrativePanel";

/**
 * Narrative Explanation for the two per-exit spatial models.
 *
 * Its own endpoint because this panel is the one place in the incident module
 * where a forecast and a non-forecast sit side by side, formatted identically:
 *
 *   GWR            EXPLANATORY, fitted in-sample over the corridor's exits.
 *                  Describes where risk sits. Forecasts nothing.
 *   Spatial LSTM   a real next-24h per-exit ranking, held out in time.
 *
 * "MAE 0.31" on the first line looks exactly like "MAE 0.34" on the second,
 * and a reader who takes the GWR for a forecast has been misled by the layout
 * rather than by either model. The endpoint's prompt is told the distinction as
 * a rule rather than left to infer it, and is told to prefer the LOOCV MAE over
 * the in-sample one whenever both are available.
 */

export type GwrCoefficientForNarrative = {
  exitName: string;
  km: number | null;
  variable: string;
  coefficient: number;
  tValue: number | null;
  significant: boolean | null;
};

export type SegmentRiskForNarrative = {
  exitName: string;
  km: number | null;
  rank: number;
  predictedIncidents: number;
  lastObservedCount: number | null;
};

/* The panel plots every exit; the prompt only needs the ones a reader would
   actually look at. Capped so a corridor that grows past 20 exits cannot
   quietly turn one narrative call into a very long one. */
const MAX_COEFFICIENTS = 12;
const MAX_EXITS = 10;

export default function CorridorRiskNarrative({
  gwr,
  spatialLstm,
  trainedAt,
}: {
  gwr: {
    bandwidth: number | null;
    mae: number | null;
    loocvMae: number | null;
    loocvN: number | null;
    poissonDeviance: number | null;
    n: number | null;
    variables: string[];
    coefficients: GwrCoefficientForNarrative[];
  } | null;
  spatialLstm: {
    mae: number | null;
    poissonDeviance: number | null;
    n: number | null;
    epochs: number | null;
    seqLen: number | null;
    nNeighbors: number | null;
    forecastDate: string | null;
    topExits: SegmentRiskForNarrative[];
  } | null;
  trainedAt: string | null;
}) {
  if (!gwr && !spatialLstm) return null;

  /* Ranked by absolute coefficient: a strong negative association is exactly
     as informative as a strong positive one, and sorting on the raw value
     would bury every protective effect at the bottom of the list. */
  const topCoefficients = gwr
    ? [...gwr.coefficients]
        .sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient))
        .slice(0, MAX_COEFFICIENTS)
    : [];
  const topExits = spatialLstm
    ? [...spatialLstm.topExits].sort((a, b) => a.rank - b.rank).slice(0, MAX_EXITS)
    : [];

  const names = [
    ...(gwr ? [{ model: "Local risk map (GWR)" }] : []),
    ...(spatialLstm ? [{ model: "Per-exit 24h forecast (Spatial LSTM)" }] : []),
  ];

  const worstExit = topExits[0];
  /* The gap between fitting on all exits and holding one out. Shown as a chip
     because it is the single number that says how much of the GWR's apparent
     accuracy is just it having seen the answer. */
  const loocvGap =
    gwr?.mae != null && gwr?.loocvMae != null ? gwr.loocvMae - gwr.mae : null;
  const significantCount = topCoefficients.filter((c) => c.significant).length;

  return (
    <NarrativePanel
      subtitle="Plain-language read-out of where incident risk sits along the corridor"
      metrics={names}
      endpoint="/api/ai-insight/corridor-risk-narrative"
      subjectKey={`corridor-risk:${gwr ? `gwr=${gwr.loocvMae ?? gwr.mae ?? "?"}` : "no-gwr"}:${
        spatialLstm ? `lstm=${topExits.map((e) => `${e.exitName}@${e.rank}`).join(",")}` : "no-lstm"
      }`}
      horizonDays={1}
      chips={
        <>
          {worstExit && (
            <NarrativeChip tone="neutral">
              <b style={{ color: "var(--text-primary)" }}>{worstExit.exitName}</b>
              <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                highest forecast risk, next 24h
              </span>
            </NarrativeChip>
          )}
          {loocvGap != null && (
            <NarrativeChip tone="neutral">
              <span style={{ fontWeight: 600 }}>
                GWR loses {loocvGap.toFixed(3)} MAE when held out
              </span>
            </NarrativeChip>
          )}
          {gwr && topCoefficients.length > 0 && (
            <NarrativeChip tone="neutral">
              <span style={{ fontWeight: 600 }}>
                {significantCount} of {topCoefficients.length} coefficients significant
              </span>
            </NarrativeChip>
          )}
        </>
      }
      contextLine={
        <>
          One explanatory map and one 24-hour forecast, read side by side
          {spatialLstm?.forecastDate && <> · forecast for {spatialLstm.forecastDate}</>}
          {trainedAt && <> · trained {trainedAt}</>}
        </>
      }
      buildBody={() => ({
        gwr: gwr
          ? {
              bandwidth: gwr.bandwidth,
              mae: gwr.mae,
              loocvMae: gwr.loocvMae,
              loocvN: gwr.loocvN,
              poissonDeviance: gwr.poissonDeviance,
              n: gwr.n,
              variables: gwr.variables,
              coefficients: topCoefficients.map((c) => ({
                exitName: c.exitName,
                km: c.km,
                variable: c.variable,
                coefficient: c.coefficient,
                tValue: c.tValue,
                significant: c.significant,
              })),
            }
          : null,
        spatialLstm: spatialLstm
          ? {
              mae: spatialLstm.mae,
              poissonDeviance: spatialLstm.poissonDeviance,
              n: spatialLstm.n,
              epochs: spatialLstm.epochs,
              seqLen: spatialLstm.seqLen,
              nNeighbors: spatialLstm.nNeighbors,
              forecastDate: spatialLstm.forecastDate,
              topExits: topExits.map((e) => ({
                exitName: e.exitName,
                km: e.km,
                rank: e.rank,
                predictedIncidents: e.predictedIncidents,
                lastObservedCount: e.lastObservedCount,
              })),
            }
          : null,
        trainedAt,
      })}
    />
  );
}
