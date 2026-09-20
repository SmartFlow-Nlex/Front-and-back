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
  predictedIncidents: number;
  rank: number;
};

export type IncidentSpatialData = {
  coefficients: GwrCoefficient[];
  segmentRisk: SegmentRisk[];
  segmentRiskByKm: SegmentRiskByKm[];
  metadata: Record<string, unknown> | null;
  trainedAt: string | null;
};

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
    const segmentRiskByKm = buildExitToExitSegments(exitsForSegments)
      .map((seg) => {
        const fromVal = predictedByExit.get(seg.fromExitId);
        const toVal = predictedByExit.get(seg.toExitId);
        if (fromVal == null || toVal == null) return null;
        return { label: seg.label, kmStart: seg.segmentStart, kmEnd: seg.segmentEnd, predictedIncidents: (fromVal + toVal) / 2 };
      })
      .filter((x): x is { label: string; kmStart: number; kmEnd: number; predictedIncidents: number } => x != null)
      .sort((a, b) => b.predictedIncidents - a.predictedIncidents)
      .map((seg, i) => ({ ...seg, rank: i + 1 }));

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
