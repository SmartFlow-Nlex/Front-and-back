import { db } from "../config/db.js";
import { buildExitToExitSegments } from "../lib/exit-segments.js";

// Reads for gold.ml_incident_spatial_coefficients / ml_incident_segment_risk /
// ml_incident_spatial_metadata — written by
// Back-End/incident_model_scripts/train_incident_spatial_models.py (GWR +
// Spatial LSTM, the two per-exit models "Incident Probability Prediction"
// needed beyond the existing per-day pipeline; see that script's module
// docstring for why it is a separate pipeline from train_incident_models.py).
//
// Read-only and unfiltered by design: unlike the day-level predictive tab,
// there is no Range/Weather control here — GWR is fit once across all 20
// exits over the full corpus, and the Spatial LSTM's segment ranking is a
// single "as of the last training run" snapshot, not a windowed query.

export type GwrCoefficient = {
  exitId: number;
  exitName: string;
  latitude: number;
  longitude: number;
  km: number;
  variable: string;
  coefficient: number;
  stdError: number | null;
  tValue: number | null;
  significant: boolean | null;
};

export type SegmentRisk = {
  exitId: number;
  exitName: string;
  latitude: number;
  longitude: number;
  km: number;
  forecastDate: string;
  predictedIncidents: number;
  lastObservedCount: number | null;
  rank: number;
  // Accidents + breakdowns the trainer placed at this exit over the WHOLE history,
  // by its own rule (nearest exit on corridor_km — see loadExitEventCounts). null
  // only if that count could not be read, in which case hasData stays true so the
  // panel degrades to its old behaviour instead of hiding every exit.
  historyEventCount: number | null;
  // false when historyEventCount is exactly 0: the model never saw an incident here,
  // so its 0.0 is "no data", not "forecast safe". Until 2026-09-21 that was SCTEX and
  // Sta. Ines, and the cause was the loader, not the client's data: etl/cleaner.ts had
  // NLEX_KM_MAX = 84 (Dau's post mistaken for Sta. Ines') and rejected every row beyond
  // km-post 84.0, although the CSVs held 376 accident and 1,516 breakdown rows at km
  // 84.1-98.0. The cap is now 89 and every exit has history; this flag stays as the
  // guard so an exit with no records is never presented as low-risk.
  hasData: boolean;
};

// Same shape family as SecondaryIncidentRiskPanel's "By Km" view, but derived
// rather than independently binned: the Spatial LSTM forecasts one value per
// EXIT (20 units), not per arbitrary km position, so there is no finer
// resolution to bin into — a segment's value is the average of the two exits
// that bound it (buildExitToExitSegments' own "exit to next exit" cut, shared
// with every other By-Km view on this tab so the segments themselves can't
// drift). This is a genuine reflection of what the model actually knows
// (risk at 20 discrete points along the corridor), not a finer-grained
// prediction manufactured to fill the toggle.
export type SegmentRiskByKm = {
  label: string;
  kmStart: number;
  kmEnd: number;
  // Average of the bounding exits THAT HAVE DATA. An exit with no incident history
  // is left out of the average rather than counted as a zero: averaging in a
  // fabricated 0 would halve a real value (Dau to SCTEX read 1.0 = (2.0 + 0.0) / 2).
  predictedIncidents: number;
  // Rank among segments that have data; null for "none" (nothing to rank).
  rank: number | null;
  // full = both bounding exits have history; partial = one does (value is that
  // exit's alone); none = neither does (predictedIncidents is a placeholder 0 and
  // must not be displayed as a forecast).
  coverage: "full" | "partial" | "none";
  // Names of the bounding exits with no history, for the panel's explanation.
  noDataExits: string[];
};

export type IncidentSpatialData = {
  coefficients: GwrCoefficient[];
  segmentRisk: SegmentRisk[];
  segmentRiskByKm: SegmentRiskByKm[];
  metadata: Record<string, unknown> | null;
  trainedAt: string | null;
};

/**
 * How many incidents each exit has EVER had, by the same rule the trainer used to
 * build its per-exit series (train_incident_spatial_models.py: INCIDENT_LOCATIONS_SQL
 * + pd.merge_asof(direction="nearest") on corridor_km): every accident and breakdown
 * is assigned to the exit whose km is nearest its corridor_km. An exit that comes
 * back with 0 is one the model never saw an incident at — its forecast is
 * uninformative, not low. Returns null if the count cannot be read.
 */
async function loadExitEventCounts(exits: { exitId: number; km: number }[]): Promise<Map<number, number> | null> {
  if (!db || exits.length === 0) return null;
  try {
    const { rows } = await db.query<{ exit_id: number; n: number }>(
      `WITH ex AS (SELECT * FROM unnest($1::int[], $2::float8[]) AS t(exit_id, km)),
            ev AS (
              SELECT corridor_km::float8 AS km FROM silver.nlex_accident_events_clean
               WHERE event_start_date IS NOT NULL AND corridor_km IS NOT NULL
              UNION ALL
              SELECT corridor_km::float8 FROM silver.nlex_breakdown_events_clean
               WHERE event_encoded_date IS NOT NULL AND corridor_km IS NOT NULL
            )
       SELECT a.exit_id, count(*)::int AS n
         FROM ev
         CROSS JOIN LATERAL (SELECT ex.exit_id FROM ex ORDER BY abs(ex.km - ev.km), ex.km LIMIT 1) a
        GROUP BY a.exit_id`,
      [exits.map((e) => e.exitId), exits.map((e) => e.km)]
    );
    const counts = new Map<number, number>(exits.map((e) => [e.exitId, 0]));
    for (const r of rows) counts.set(r.exit_id, Number(r.n));
    return counts;
  } catch (error) {
    // Not fatal: the panel still renders, just without the no-data marking.
    console.error("Failed to load per-exit incident history counts:", error);
    return null;
  }
}

export async function getIncidentSpatialFromDb(): Promise<IncidentSpatialData | null> {
  if (!db) return null;
  try {
    const [coefRes, riskRes, metaRes] = await Promise.all([
      db.query<{
        exit_id: number; exit_name: string; latitude: number; longitude: number; km: number;
        variable: string; coefficient: number; std_error: number | null; t_value: number | null;
        significant: boolean | null; trained_at: string;
      }>(
        `SELECT exit_id, exit_name, latitude, longitude, km, variable, coefficient,
                std_error, t_value, significant, trained_at
         FROM gold.ml_incident_spatial_coefficients
         ORDER BY exit_id, variable`
      ),
      db.query<{
        exit_id: number; exit_name: string; latitude: number; longitude: number; km: number;
        forecast_date: string; predicted_incidents: number; last_observed_count: number | null;
        risk_rank: number; trained_at: string;
      }>(
        `SELECT exit_id, exit_name, latitude, longitude, km, forecast_date::text AS forecast_date,
                predicted_incidents, last_observed_count, risk_rank, trained_at
         FROM gold.ml_incident_segment_risk
         ORDER BY risk_rank ASC`
      ),
      db.query<{ metadata_json: Record<string, unknown>; created_at: string }>(
        `SELECT metadata_json, created_at FROM gold.ml_incident_spatial_metadata
         ORDER BY created_at DESC LIMIT 1`
      ),
    ]);

    if (coefRes.rows.length === 0 && riskRes.rows.length === 0) {
      // Tables exist (ensure_schema ran) but the pipeline hasn't written yet —
      // same "not there yet" signal the day-level predictive tab gives via a
      // 503, not an empty-but-200 response that would render a blank chart.
      return null;
    }

    const trainedAt = coefRes.rows[0]?.trained_at ?? riskRes.rows[0]?.trained_at ?? null;

    const exitsForSegments = riskRes.rows.map((r) => ({ exit_id: r.exit_id, exit_name: r.exit_name, km: Number(r.km) }));
    const predictedByExit = new Map(riskRes.rows.map((r) => [r.exit_id, Number(r.predicted_incidents)]));
    const nameByExit = new Map(riskRes.rows.map((r) => [r.exit_id, r.exit_name]));

    // Exits the model has no incident history for. Unknown (null map) counts as
    // "has data" so a failed coverage read cannot blank the whole panel.
    const historyByExit = await loadExitEventCounts(riskRes.rows.map((r) => ({ exitId: r.exit_id, km: Number(r.km) })));
    const hasData = (exitId: number): boolean => historyByExit == null || (historyByExit.get(exitId) ?? 0) > 0;

    type SegmentDraft = Omit<SegmentRiskByKm, "rank">;
    const segmentDrafts: SegmentDraft[] = [];
    for (const seg of buildExitToExitSegments(exitsForSegments)) {
      const fromVal = predictedByExit.get(seg.fromExitId);
      const toVal = predictedByExit.get(seg.toExitId);
      if (fromVal == null || toVal == null) continue;
      // Only exits with history contribute: a no-data exit's 0.0 is not a measurement.
      const usable = [
        hasData(seg.fromExitId) ? fromVal : null,
        hasData(seg.toExitId) ? toVal : null,
      ].filter((v): v is number => v != null);
      const noDataExits = [seg.fromExitId, seg.toExitId]
        .filter((id) => !hasData(id))
        .map((id) => nameByExit.get(id) ?? String(id));
      segmentDrafts.push({
        label: seg.label,
        kmStart: seg.segmentStart,
        kmEnd: seg.segmentEnd,
        predictedIncidents: usable.length > 0 ? usable.reduce((s, v) => s + v, 0) / usable.length : 0,
        coverage: usable.length === 2 ? "full" : usable.length === 1 ? "partial" : "none",
        noDataExits,
      });
    }
    // Rank only what has a forecast; a "none" segment has nothing to rank.
    const rankedIds = new Map(
      segmentDrafts
        .filter((s) => s.coverage !== "none")
        .sort((a, b) => b.predictedIncidents - a.predictedIncidents)
        .map((s, i) => [s.kmStart, i + 1] as const)
    );
    const segmentRiskByKm: SegmentRiskByKm[] = segmentDrafts
      .map((s) => ({ ...s, rank: rankedIds.get(s.kmStart) ?? null }))
      .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));

    return {
      coefficients: coefRes.rows.map((r) => ({
        exitId: r.exit_id,
        exitName: r.exit_name,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        km: Number(r.km),
        variable: r.variable,
        coefficient: Number(r.coefficient),
        stdError: r.std_error == null ? null : Number(r.std_error),
        tValue: r.t_value == null ? null : Number(r.t_value),
        significant: r.significant,
      })),
      segmentRisk: riskRes.rows.map((r) => ({
        exitId: r.exit_id,
        exitName: r.exit_name,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        km: Number(r.km),
        forecastDate: r.forecast_date,
        predictedIncidents: Number(r.predicted_incidents),
        lastObservedCount: r.last_observed_count == null ? null : Number(r.last_observed_count),
        rank: r.risk_rank,
        historyEventCount: historyByExit == null ? null : historyByExit.get(r.exit_id) ?? 0,
        hasData: hasData(r.exit_id),
      })),
      segmentRiskByKm,
      metadata: metaRes.rows[0]?.metadata_json ?? null,
      trainedAt: trainedAt ? new Date(trainedAt).toISOString() : null,
    };
  } catch (error) {
    console.error("Failed to fetch incident spatial models:", error);
    return null;
  }
}
