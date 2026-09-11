import { db } from "../config/db.js";
// Reused rather than duplicated: the corridor's one authoritative exit list
// (see its own doc comment for why km is derived rather than hardcoded).
// gold.ml_incident_severity_predictions stores each prediction's raw
// km_value but not which exit it's nearest to — resolved here in JS rather
// than in SQL or at training time, since it's a simple min-abs-distance
// lookup over 20 rows and doing it here means a schema/exit-list change
// never requires re-running the Python pipeline.
import { searchExitsInDb } from "./map-comparison.service.js";
// Same exit-to-exit segments incident.service.ts's kmSegmentForecast uses —
// shared so this panel's "By Km" view can't drift from that one again.
import { buildExitToExitSegments, segmentIndexForKm } from "../lib/exit-segments.js";

// Reads for gold.ml_incident_severity_predictions / ml_incident_survival_curve /
// ml_incident_severity_metadata — written by
// Back-End/incident_model_scripts/train_incident_severity_models.py
// (Ordinal Logistic + XGBoost for severity, Cox PH for the clearance
// survival curve, a small logistic regression for secondary-incident risk),
// trained on accident_data (silver.nlex_accident_events_clean), not the
// older road/moto-crash tables. `severity` is derived from real recorded
// injury/fatality counts, and "clearance time" is a real
// site_cleared - event_start_date elapsed time — see that script's module
// docstring for the two data gaps this closes relative to the old source.

const SEVERITY_LABEL: Record<number, string> = { 0: "Property Damage Only", 1: "Injury", 2: "Fatal" };

// dimension: "baseline" (the one reference curve, shown regardless of which
// toggle is active), "severity" (PDO/Injury/Fatal), "damage_to_property" (No
// Property Damage / Property Damage — replaced the old road/moto "source"
// split when this moved to accident_data), "km", or "both" (the 2x3 cross of
// severity x damage_to_property) — see train_incident_severity_models.py's
// fit_cox_ph for why these are separate toggled views rather than every
// curve on one chart, and for n: sample size behind this one curve, as low
// as 15 for the thinnest "both" cells.
export type SurvivalCurvePoint = { group: string; dimension: string; timeMin: number; survivalProbability: number; n: number };

export type SeverityBreakdownRow = {
  severityCode: number;
  label: string;
  actualCount: number;
  predictedCount: number;
};

// avgClearanceMin rides alongside avgRisk (not a separate query) so a
// prioritization tool that needs both — "which zones combine high secondary
// risk with slow clearance" — can pair them without hoping two independently
// computed groupings happen to land on the same rows. See
// SecondaryRiskMitigationPanel.tsx's doc comment for why that pairing is the
// actual point: secondary risk alone says WHERE, clearance speed is the
// lever that actually changes it.
export type SecondaryRiskByExit = {
  exitId: number;
  exitName: string;
  km: number;
  n: number;
  avgRisk: number;
  avgClearanceMin: number;
  actualSecondaryCount: number;
};

// Same rows as SecondaryRiskByExit, grouped by km position instead of
// nearest exit — quantile bins (equal incident COUNT, unequal km width).
// km_value is near-continuous in accident_data (946 distinct values,
// verified directly against train_incident_severity_models.py's training
// set — StartKM is recorded to the nearest 100m), so a fixed grid would work
// reasonably well here too; quantile bins are kept for the same guarantee
// they gave the old, coarser data: every segment has comparable evidence
// behind it, regardless of how incidents happen to cluster along the
// corridor.
export type SecondaryRiskByKmSegment = {
  label: string;
  kmStart: number;
  kmEnd: number;
  n: number;
  avgRisk: number;
  avgClearanceMin: number;
  actualSecondaryCount: number;
};

export type IncidentSeverityData = {
  survivalCurve: SurvivalCurvePoint[];
  severityBreakdown: SeverityBreakdownRow[];
  avgPredictedClearanceMin: number | null;
  avgSecondaryRisk: number | null;
  secondaryRiskByExit: SecondaryRiskByExit[];
  secondaryRiskByKmSegment: SecondaryRiskByKmSegment[];
  trainedAt: string | null;
  metadata: Record<string, unknown> | null;
};

export async function getIncidentSeverityFromDb(): Promise<IncidentSeverityData | null> {
  if (!db) return null;
  try {
    const [curveRes, actualRes, predRes, avgRes, metaRes, riskRowsRes, exitRows] = await Promise.all([
      db.query<{ group_label: string; dimension: string; time_min: number; survival_probability: number; n: number }>(
        `SELECT group_label, dimension, time_min, survival_probability, n
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
      db.query<{
        km_value: number; secondary_incident_risk: number | null; actual_had_secondary: boolean | null;
        predicted_clearance_min: number | null;
      }>(
        `SELECT km_value, secondary_incident_risk, actual_had_secondary, predicted_clearance_min
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
    const byExit = new Map<
      number,
      { exitName: string; km: number; n: number; sumRisk: number; secondaryCount: number; sumClearance: number; clearanceN: number }
    >();
    if (exits.length > 0) {
      for (const row of riskRowsRes.rows) {
        const nearest = exits.reduce((best, x) =>
          Math.abs(x.km - row.km_value) < Math.abs(best.km - row.km_value) ? x : best
        );
        const entry = byExit.get(nearest.exit_id) ?? {
          exitName: nearest.exit_name, km: nearest.km, n: 0, sumRisk: 0, secondaryCount: 0, sumClearance: 0, clearanceN: 0,
        };
        entry.n += 1;
        entry.sumRisk += Number(row.secondary_incident_risk);
        if (row.actual_had_secondary) entry.secondaryCount += 1;
        // predicted_clearance_min can be null on rows where Cox PH's
        // per-row prediction didn't resolve — averaged over its own count,
        // not `n`, so a handful of nulls don't quietly drag the average down.
        if (row.predicted_clearance_min != null) {
          entry.sumClearance += Number(row.predicted_clearance_min);
          entry.clearanceN += 1;
        }
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
        avgClearanceMin: v.clearanceN > 0 ? v.sumClearance / v.clearanceN : 0,
        actualSecondaryCount: v.secondaryCount,
      }))
      .sort((a, b) => b.avgRisk - a.avgRisk);

    // Exit-to-exit corridor segments — the same segmentation
    // incident.service.ts's kmSegmentForecast uses (see lib/exit-segments.ts),
    // so this panel's "By Km" view lines up with the Predicted Incidents
    // Ranking's instead of each inventing its own, disagreeing bins. A
    // segment with no predictions at all is dropped rather than kept at
    // n=0: unlike an incident count, an average risk/clearance time has no
    // honest value to report from zero rows.
    const segments = buildExitToExitSegments(exits);
    const bySegmentIdx = new Map<
      number,
      { n: number; sumRisk: number; secondaryCount: number; sumClearance: number; clearanceN: number }
    >();
    for (const row of riskRowsRes.rows) {
      const idx = segmentIndexForKm(row.km_value, segments);
      if (idx < 0) continue;
      const entry = bySegmentIdx.get(idx) ?? { n: 0, sumRisk: 0, secondaryCount: 0, sumClearance: 0, clearanceN: 0 };
      entry.n += 1;
      entry.sumRisk += Number(row.secondary_incident_risk);
      if (row.actual_had_secondary) entry.secondaryCount += 1;
      if (row.predicted_clearance_min != null) {
        entry.sumClearance += Number(row.predicted_clearance_min);
        entry.clearanceN += 1;
      }
      bySegmentIdx.set(idx, entry);
    }
    const secondaryRiskByKmSegment: SecondaryRiskByKmSegment[] = segments
      .map((seg, i) => {
        const v = bySegmentIdx.get(i);
        if (!v || v.n === 0) return null;
        return {
          label: seg.label,
          kmStart: seg.segmentStart,
          kmEnd: seg.segmentEnd,
          n: v.n,
          avgRisk: v.sumRisk / v.n,
          avgClearanceMin: v.clearanceN > 0 ? v.sumClearance / v.clearanceN : 0,
          actualSecondaryCount: v.secondaryCount,
        };
      })
      .filter((x): x is SecondaryRiskByKmSegment => x != null);

    const avg = avgRes.rows[0];
    return {
      survivalCurve: curveRes.rows.map((r) => ({
        group: r.group_label,
        dimension: r.dimension,
        timeMin: Number(r.time_min),
        survivalProbability: Number(r.survival_probability),
        n: r.n,
      })),
      severityBreakdown,
      avgPredictedClearanceMin: avg?.avg_clearance == null ? null : Number(avg.avg_clearance),
      avgSecondaryRisk: avg?.avg_risk == null ? null : Number(avg.avg_risk),
      secondaryRiskByExit,
      secondaryRiskByKmSegment,
      trainedAt: avg?.trained_at ? new Date(avg.trained_at).toISOString() : null,
      metadata: metaRes.rows[0]?.metadata_json ?? null,
    };
  } catch (error) {
    console.error("Failed to fetch incident severity models:", error);
    return null;
  }
}
