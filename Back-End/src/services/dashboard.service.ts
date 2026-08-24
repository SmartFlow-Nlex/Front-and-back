import { getTrafficAnalyticsFromDb } from "./traffic.service.js";
import { getIncidentAnalyticsFromDb } from "./incident.service.js";
import { getEmissionsAnalyticsFromDb } from "./emissions.service.js";

/**
 * Compact summary for the Home tab.
 *
 * Composed from the three analytics services rather than its own SQL, which is
 * the point: the home page cannot quietly disagree with the tab a reader clicks
 * into next, because both numbers come from the same query. All three services
 * already cache with a TTL, so this shares their warm entries instead of adding
 * load.
 *
 * The alternative — bespoke overview queries — is how a dashboard ends up
 * reporting one total on the landing page and a different one two clicks in.
 */

export type OverviewMetric = {
  value: number | null;
  /** Percent change against the previous comparable window, null if unknowable. */
  deltaPct: number | null;
};

const pct = (cur: number, prev: number): number | null =>
  prev > 0 ? ((cur - prev) / prev) * 100 : null;

export async function getDashboardOverview(months: "3" | "12" | "all" = "12") {
  // Parallel because they are independent, and any one of them may be a cache
  // miss that has to touch the warehouse.
  const [traffic, incident, emissions] = await Promise.all([
    getTrafficAnalyticsFromDb({ months }),
    getIncidentAnalyticsFromDb({ months }),
    getEmissionsAnalyticsFromDb({ months }),
  ]);

  const t = traffic as {
    range: { from: string; to: string };
    meta: { plazas: string[]; minDate: string; maxDate: string };
    kpis: {
      totalVolume: number; prevTotalVolume: number; days: number; prevDays: number;
      congestionIndex: number | null; prevCongestionIndex: number | null;
    };
    byPlaza: { plaza: string; v: number }[];
    hourDow: { dow: number; hour: number; v: number }[];
    speedByHour: { hour: number; speed: number }[];
  };
  const i = incident as {
    kpis: {
      totalIncidents: number; prevTotalIncidents: number; injuries: number;
      fatalities: number; avgResponseMin: number | null;
    };
    hotspots: { km_bin: number; total: number }[];
  };
  const e = emissions as {
    kpis: { totalCo2T: number; prevCo2T: number; avgAqi: number | null; avgPm25: number | null };
  };

  // Average day, not the raw window total: the current and previous windows can
  // hold a different number of days, so totals are not comparable on their own.
  const adt = t.kpis.days > 0 ? t.kpis.totalVolume / t.kpis.days : 0;
  const prevAdt = t.kpis.prevDays > 0 ? t.kpis.prevTotalVolume / t.kpis.prevDays : 0;

  const busiestPlaza = t.byPlaza[0] ?? null;
  const plazaTotal = t.byPlaza.reduce((s, r) => s + r.v, 0);

  let peak: { dow: number; hour: number; v: number } | null = null;
  for (const r of t.hourDow) if (!peak || r.v > peak.v) peak = r;

  const topHotspot = i.hotspots[0] ?? null;

  return {
    range: t.range,
    // What the warehouse actually holds, so the UI can say "through <date>"
    // instead of implying the numbers are from this minute.
    coverage: { minDate: t.meta.minDate, maxDate: t.meta.maxDate },

    volume: { value: adt, deltaPct: pct(adt, prevAdt) } satisfies OverviewMetric,
    congestion: {
      value: t.kpis.congestionIndex,
      // Congestion index is already a rate, so the change is in points, not a
      // percent of a percent.
      deltaPoints:
        t.kpis.congestionIndex != null && t.kpis.prevCongestionIndex != null
          ? t.kpis.congestionIndex - t.kpis.prevCongestionIndex
          : null,
    },
    incidents: {
      value: i.kpis.totalIncidents,
      deltaPct: pct(i.kpis.totalIncidents, i.kpis.prevTotalIncidents),
      injuries: i.kpis.injuries,
      fatalities: i.kpis.fatalities,
      avgResponseMin: i.kpis.avgResponseMin,
    },
    emissions: {
      totalCo2T: e.kpis.totalCo2T,
      deltaPct: pct(e.kpis.totalCo2T, e.kpis.prevCo2T),
      avgAqi: e.kpis.avgAqi,
      avgPm25: e.kpis.avgPm25,
    },

    highlights: {
      busiestPlaza: busiestPlaza
        ? {
            name: busiestPlaza.plaza,
            sharePct: plazaTotal > 0 ? (busiestPlaza.v / plazaTotal) * 100 : null,
          }
        : null,
      peakWindow: peak ? { dow: peak.dow, hour: peak.hour, volume: peak.v } : null,
      worstSegmentKm: topHotspot ? topHotspot.km_bin : null,
      plazaCount: t.meta.plazas.length,
    },

    generatedAt: new Date().toISOString(),
  };
}

/** Kept for the existing `GET /api/dashboard` probe. */
export async function getDashboardData() {
  return {
    module: "dashboard",
    message: "dashboard API ready",
    updatedAt: new Date().toISOString(),
  };
}
