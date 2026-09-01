import { db } from "../config/db.js";
// Reused rather than duplicated: the corridor's one authoritative exit list
// (see its own doc comment for why km is derived rather than hardcoded).
// gold.ml_incident_severity_predictions stores each prediction's raw
// km_value but not which exit it's nearest to — resolved here in JS rather
// than in SQL or at training time, since it's a simple min-abs-distance
// lookup over 20 rows and doing it here means a schema/exit-list change
// never requires re-running the Python pipeline.
import { searchExitsInDb } from "./map-comparison.service.js";

// Reads for gold.ml_incident_severity_predictions / ml_incident_survival_curve /
// ml_incident_severity_metadata — written by
// Back-End/incident_model_scripts/train_incident_severity_models.py
// (Ordinal Logistic + XGBoost for severity, Cox PH for the clearance
// survival curve, a small logistic regression for secondary-incident risk).
// See that script's module docstring for two data caveats that shape every
// number this returns: `severity` is derived from injury/fatality counts
// (the source column is 100% NULL), and "clearance time" is really the
// report-to-response duration — no scene-cleared timestamp exists in the
// warehouse.

const SEVERITY_LABEL: Record<number, string> = { 0: "Property Damage Only", 1: "Injury", 2: "Fatal" };

export type SurvivalCurvePoint = { group: string; timeMin: number; survivalProbability: number };

export type SeverityBreakdownRow = {
  severityCode: number;
  label: string;
  actualCount: number;
  predictedCount: number;
};

export type SecondaryRiskByExit = {
  exitId: number;
  exitName: string;
  km: number;
  n: number;
  avgRisk: number;
  actualSecondaryCount: number;
};

export type IncidentSeverityData = {
  survivalCurve: SurvivalCurvePoint[];
  severityBreakdown: SeverityBreakdownRow[];
  avgPredictedClearanceMin: number | null;
  avgSecondaryRisk: number | null;
  secondaryRiskByExit: SecondaryRiskByExit[];
  trainedAt: string | null;
  metadata: Record<string, unknown> | null;
};

export async function getIncidentSeverityFromDb(): Promise<IncidentSeverityData | null> {
  if (!db) return null;
  try {
    const [curveRes, actualRes, predRes, avgRes, metaRes, riskRowsRes, exitRows] = await Promise.all([
      db.query<{ group_label: string; time_min: number; survival_probability: number }>(
        `SELECT group_label, time_min, survival_probability
         FROM gold.ml_incident_survival_curve
         ORDER BY group_label, time_min`
      ),
      db.query<{ actual_severity_code: number; n: number }>(
        `SELECT actual_severity_code, COUNT(*)::int AS n
         FROM gold.ml_incident_severity_predictions
         GROUP BY actual_severity_code`
      ),
      db.query<{ predicted_severity_code: number; n: number }>(
        `SELECT predicted_severity_code, COUNT(*)::int AS n
         FROM gold.ml_incident_severity_predictions
         GROUP BY predicted_severity_code`
      ),
      db.query<{ avg_clearance: number | null; avg_risk: number | null; trained_at: string | null }>(
        `SELECT AVG(predicted_clearance_min) AS avg_clearance,
                AVG(secondary_incident_risk) AS avg_risk,
                MAX(trained_at)::text AS trained_at
         FROM gold.ml_incident_severity_predictions`
      ),
      db.query<{ metadata_json: Record<string, unknown>; created_at: string }>(
        `SELECT metadata_json, created_at FROM gold.ml_incident_severity_metadata
         ORDER BY created_at DESC LIMIT 1`
      ),
      db.query<{ km_value: number; secondary_incident_risk: number | null; actual_had_secondary: boolean | null }>(
        `SELECT km_value, secondary_incident_risk, actual_had_secondary
         FROM gold.ml_incident_severity_predictions
         WHERE secondary_incident_risk IS NOT NULL`
      ),
      searchExitsInDb(""),
    ]);

    if (curveRes.rows.length === 0 && actualRes.rows.length === 0) {
      // Tables exist (ensure_schema ran) but the pipeline hasn't written yet.
      return null;
    }

    const actualByCode = new Map(actualRes.rows.map((r) => [r.actual_severity_code, r.n]));
    const predByCode = new Map(predRes.rows.map((r) => [r.predicted_severity_code, r.n]));
    const codes = new Set([...actualByCode.keys(), ...predByCode.keys()]);
    const severityBreakdown = Array.from(codes)
      .sort((a, b) => a - b)
      .map((code) => ({
        severityCode: code,
        label: SEVERITY_LABEL[code] ?? `Code ${code}`,
        actualCount: actualByCode.get(code) ?? 0,
        predictedCount: predByCode.get(code) ?? 0,
      }));

    // Nearest exit per prediction, by km_value — the same "closest post"
    // rule resolveExitForLocation's km branch uses in incident.service.ts,
    // just against a numeric km_value directly rather than a regex-matched
    // one, since these rows already carry it.
    const exits = (exitRows ?? []) as { exit_id: number; exit_name: string; km: number }[];
    const byExit = new Map<number, { exitName: string; km: number; n: number; sumRisk: number; secondaryCount: number }>();
    if (exits.length > 0) {
      for (const row of riskRowsRes.rows) {
        const nearest = exits.reduce((best, x) =>
          Math.abs(x.km - row.km_value) < Math.abs(best.km - row.km_value) ? x : best
        );
        const entry = byExit.get(nearest.exit_id) ?? {
          exitName: nearest.exit_name, km: nearest.km, n: 0, sumRisk: 0, secondaryCount: 0,
        };
        entry.n += 1;
        entry.sumRisk += Number(row.secondary_incident_risk);
        if (row.actual_had_secondary) entry.secondaryCount += 1;
        byExit.set(nearest.exit_id, entry);
      }
    }
    const secondaryRiskByExit = Array.from(byExit.entries())
      .map(([exitId, v]) => ({
        exitId,
        exitName: v.exitName,
        km: v.km,
        n: v.n,
        avgRisk: v.sumRisk / v.n,
        actualSecondaryCount: v.secondaryCount,
      }))
      .sort((a, b) => b.avgRisk - a.avgRisk);

    const avg = avgRes.rows[0];
    return {
      survivalCurve: curveRes.rows.map((r) => ({
        group: r.group_label,
        timeMin: Number(r.time_min),
        survivalProbability: Number(r.survival_probability),
      })),
      severityBreakdown,
      avgPredictedClearanceMin: avg?.avg_clearance == null ? null : Number(avg.avg_clearance),
      avgSecondaryRisk: avg?.avg_risk == null ? null : Number(avg.avg_risk),
      secondaryRiskByExit,
      trainedAt: avg?.trained_at ? new Date(avg.trained_at).toISOString() : null,
      metadata: metaRes.rows[0]?.metadata_json ?? null,
    };
  } catch (error) {
    console.error("Failed to fetch incident severity models:", error);
    return null;
  }
}
