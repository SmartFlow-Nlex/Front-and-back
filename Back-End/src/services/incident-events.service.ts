import { db } from "../config/db.js";

// Descriptive analytics over the new breakdown_data event table
// (silver.nlex_breakdown_events_clean) — a live SQL aggregation, not a
// trained-model snapshot like incident-severity.service.ts, so there's no
// "pipeline hasn't written yet" state to handle: the table either has data
// (it does, once the ETL has ingested at least one file) or the query
// returns empty arrays, which the frontend renders as an honest "no data"
// state.
//
// Was accident_data + breakdown_data until the accident-vs-breakdown monthly
// trend was removed as a duplicate of /analytics's Incident Trend chart
// (verified identical month-by-month counts once both endpoints respected
// the same Range and read the same client tables) — accident_data isn't
// read anywhere in this file anymore.
//
// breakdown_data's `deployments` column (JSONB, one entry per AAP/Patrol
// Vehicle/RAMFA/etc. dispatch) only exists on rows with deployment_count > 0
// (31% of breakdowns, verified) — response/service-time stats below are
// averaged over however many deployment records actually exist, not over
// every breakdown event.

export type BreakdownCauseCount = { mainCause: string; subCause: string; count: number };

export type DeploymentTimeStat = {
  group: string;
  n: number;
  avgResponseMin: number | null;
  medianResponseMin: number | null;
  avgServiceMin: number | null;
};

export type EventBreakdownData = {
  breakdownCauses: BreakdownCauseCount[];
  responseTimeByService: DeploymentTimeStat[];
  responseTimeByCause: DeploymentTimeStat[];
};

export type EventBreakdownFilters = {
  months: "3" | "12" | "all";
  from?: string;
  to?: string;
};

// percentile_cont always returns double precision (even over a numeric-cast
// input), and Postgres's two-argument ROUND only exists for numeric — hence
// the extra ::numeric cast on the median that AVG doesn't need. NULLIF(...,
// '') guards a small number of deployment records where parseDeployments
// (transformer.ts) matched the field but captured an empty value rather than
// the field being absent — an empty string fails a bare ::numeric cast.
//
// The BETWEEN 0 AND 1440 cap (NULLing, not dropping the record — n/other
// stats are unaffected) guards 6 of 51,082 records (verified) with values up
// to 10.5 million "minutes" — data-entry corruption, not real durations; the
// same 24h sanity cap 06-silver-remaining.sql already applies to
// clearance_minutes elsewhere in this warehouse.
const RESPONSE_MIN = "(CASE WHEN NULLIF(d->>'response_time_min', '')::numeric BETWEEN 0 AND 1440 THEN NULLIF(d->>'response_time_min', '')::numeric END)";
const SERVICE_MIN = "(CASE WHEN NULLIF(d->>'service_time_min', '')::numeric BETWEEN 0 AND 1440 THEN NULLIF(d->>'service_time_min', '')::numeric END)";
const DEPLOYMENT_STATS_SELECT = `
  COUNT(*)::int AS n,
  ROUND(AVG(${RESPONSE_MIN}), 1) AS avg_response_min,
  ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY ${RESPONSE_MIN}))::numeric, 1) AS median_response_min,
  ROUND(AVG(${SERVICE_MIN}), 1) AS avg_service_min
`;

export async function getEventBreakdownFromDb(filters: EventBreakdownFilters): Promise<EventBreakdownData | null> {
  if (!db) return null;
  try {
    // Breakdown-only now: the accident-vs-breakdown monthly trend (the one
    // query here that read silver.nlex_accident_events_clean) was removed as
    // a duplicate of /analytics's Incident Trend chart — verified identical
    // counts for every month once both respected the same Range and read the
    // same client tables. Every remaining query here is breakdown-only, so
    // the window is bounded by that table alone rather than blended with a
    // table nothing else in this file reads.
    const bounds = await db.query(
      `SELECT min(event_encoded_date)::text AS lo, max(event_encoded_date)::text AS hi
       FROM silver.nlex_breakdown_events_clean`
    );
    const minDate: string = bounds.rows[0].lo;
    const maxDate: string = bounds.rows[0].hi;

    let lo: string;
    let hi: string;
    if (filters.from && filters.to) {
      const [f, t] = filters.from <= filters.to ? [filters.from, filters.to] : [filters.to, filters.from];
      lo = f < minDate ? minDate : f;
      hi = t > maxDate ? maxDate : t;
    } else if (filters.months === "all") {
      lo = minDate;
      hi = maxDate;
    } else {
      // Same trailing-window rule as /analytics: counted back from the last
      // actual day of data, not from today's wall-clock date.
      hi = maxDate;
      lo = (
        await db.query(`SELECT GREATEST(($1::date - ($2 || ' months')::interval)::date, $3::date)::text AS lo`, [
          hi,
          filters.months,
          minDate,
        ])
      ).rows[0].lo;
    }

    const [causeRes, byServiceRes, byCauseRes] = await Promise.all([
      db.query<{ main_cause: string; sub_cause: string; n: number }>(
        `SELECT main_cause, sub_cause, COUNT(*)::int AS n
         FROM silver.nlex_breakdown_events_clean
         WHERE event_encoded_date BETWEEN $1 AND $2
         GROUP BY 1, 2 ORDER BY n DESC`,
        [lo, hi]
      ),
      db.query<{ service: string; n: number; avg_response_min: number | null; median_response_min: number | null; avg_service_min: number | null }>(
        `SELECT d->>'service' AS service, ${DEPLOYMENT_STATS_SELECT}
         FROM silver.nlex_breakdown_events_clean, jsonb_array_elements(deployments) d
         WHERE d->>'service' IS NOT NULL AND event_encoded_date BETWEEN $1 AND $2
         GROUP BY 1 ORDER BY n DESC`,
        [lo, hi]
      ),
      db.query<{ main_cause: string; n: number; avg_response_min: number | null; median_response_min: number | null; avg_service_min: number | null }>(
        `SELECT main_cause, ${DEPLOYMENT_STATS_SELECT}
         FROM silver.nlex_breakdown_events_clean, jsonb_array_elements(deployments) d
         WHERE deployments IS NOT NULL AND event_encoded_date BETWEEN $1 AND $2
         GROUP BY 1 ORDER BY n DESC`,
        [lo, hi]
      ),
    ]);

    const toStat = (n: number, avgR: number | null, medR: number | null, avgS: number | null): Omit<DeploymentTimeStat, "group"> => ({
      n,
      avgResponseMin: avgR == null ? null : Number(avgR),
      medianResponseMin: medR == null ? null : Number(medR),
      avgServiceMin: avgS == null ? null : Number(avgS),
    });

    return {
      breakdownCauses: causeRes.rows.map((r) => ({ mainCause: r.main_cause, subCause: r.sub_cause, count: r.n })),
      responseTimeByService: byServiceRes.rows.map((r) => ({
        group: r.service,
        ...toStat(r.n, r.avg_response_min, r.median_response_min, r.avg_service_min),
      })),
      responseTimeByCause: byCauseRes.rows.map((r) => ({
        group: r.main_cause,
        ...toStat(r.n, r.avg_response_min, r.median_response_min, r.avg_service_min),
      })),
    };
  } catch (error) {
    console.error("Failed to fetch event breakdown analytics:", error);
    return null;
  }
}
