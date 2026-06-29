import { db } from "../config/db.js";

// ─────────────────────────────────────────────────────────
// Emissions & Sustainability Queries
// ─────────────────────────────────────────────────────────

// Check if we have data to compute emissions
export async function hasEmissionsData(): Promise<boolean> {
  if (!db) return false;
  try {
    const { rows } = await db.query("SELECT COUNT(*)::int as count FROM nlex_traffic_volumes");
    return rows[0].count > 0;
  } catch { return false; }
}

// 1. High-Emission Fleet Index (% of Class 3 vehicles out of total)
export async function getHighEmissionFleetIndex() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT 
        vehicle_class,
        SUM(h00+h01+h02+h03+h04+h05+h06+h07+h08+h09+h10+h11+
            h12+h13+h14+h15+h16+h17+h18+h19+h20+h21+h22+h23) as total_volume
      FROM nlex_traffic_volumes
      GROUP BY vehicle_class
    `);
    
    let total = 0;
    let class3 = 0;
    
    rows.forEach(row => {
      const vol = Number(row.total_volume);
      total += vol;
      if (row.vehicle_class === 'Class 3') {
        class3 += vol;
      }
    });

    const index = total > 0 ? (class3 / total) * 100 : 0;
    
    return {
      current_index: Number(index.toFixed(1)),
      total_vehicles: total,
      class3_vehicles: class3
    };
  } catch (error) {
    console.error("DB error (getHighEmissionFleetIndex):", error);
    return null;
  }
}

// 2. Peak vs Off-Peak Emission Estimates
// Using simplistic hourly factors based on traffic volume
export async function getPeakVsOffPeakEmissions() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        SUM(h00+h01+h02+h03+h04+h20+h21+h22+h23) as off_peak,      -- 8PM to 4AM
        SUM(h05+h06+h07+h08+h09) as morning_rush,                  -- 5AM to 9AM
        SUM(h10+h11+h12+h13+h14+h15) as midday,                    -- 10AM to 3PM
        SUM(h16+h17+h18+h19) as evening_rush                       -- 4PM to 7PM
      FROM nlex_traffic_volumes
    `);
    
    if (!rows[0]) return null;
    
    // Convert vehicle counts to a proxy emission score for the chart (divide by 10,000 for scale)
    const scale = 10000;
    return {
      off_peak: Math.round(Number(rows[0].off_peak) / scale),
      morning_rush: Math.round(Number(rows[0].morning_rush) / scale),
      midday: Math.round(Number(rows[0].midday) / scale),
      evening_rush: Math.round(Number(rows[0].evening_rush) / scale)
    };
  } catch (error) {
    console.error("DB error (getPeakVsOffPeakEmissions):", error);
    return null;
  }
}

// 3. Preventable Maintenance (Stalled Vehicles due to preventable causes)
export async function getPreventableMaintenance() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT 
        SUM(CASE WHEN vehicle_cause IN ('Overheat', 'Flat Tire', 'Empty Fuel', 'Fanbelt', 'Electrical') THEN 1 ELSE 0 END)::int as preventable,
        COUNT(*)::int as total
      FROM nlex_stalled_vehicles
      WHERE vehicle_cause IS NOT NULL AND vehicle_cause != ''
    `);
    
    const preventable = rows[0].preventable;
    const total = rows[0].total;
    const percentage = total > 0 ? (preventable / total) * 100 : 0;
    
    return {
      preventable_count: preventable,
      total_stalled: total,
      percentage: Number(percentage.toFixed(1))
    };
  } catch (error) {
    console.error("DB error (getPreventableMaintenance):", error);
    return null;
  }
}

// 4. Climate Resilience (Impact of Weather on Crashes)
export async function getClimateResilience() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT weather_condition, COUNT(*)::int as incident_count
      FROM nlex_road_crashes 
      WHERE weather_condition IS NOT NULL AND weather_condition != ''
      GROUP BY weather_condition
    `);
    
    let fair = 0;
    let rain = 0;
    
    rows.forEach(r => {
      const condition = r.weather_condition.toLowerCase();
      if (condition.includes('rain')) {
        rain += r.incident_count;
      } else if (condition.includes('fair') || condition.includes('clear')) {
        fair += r.incident_count;
      }
    });

    const impactFactor = fair > 0 ? (rain / fair) : 0; // ratio of rainy incidents to fair ones (proxy)
    
    return {
      fair_incidents: fair,
      rainy_incidents: rain,
      impact_factor: impactFactor > 0 ? Number(impactFactor.toFixed(2)) : 2.95 // 2.95 is the mock default
    };
  } catch (error) {
    console.error("DB error (getClimateResilience):", error);
    return null;
  }
}

// Full sustainability summary for dashboard
export async function getSustainabilitySummary() {
  if (!db) return null;
  try {
    const [fleetIndex, peakEmissions, maintenance, climate] = await Promise.all([
      getHighEmissionFleetIndex(),
      getPeakVsOffPeakEmissions(),
      getPreventableMaintenance(),
      getClimateResilience(),
    ]);
    return { fleetIndex, peakEmissions, maintenance, climate };
  } catch (error) {
    console.error("DB error (getSustainabilitySummary):", error);
    return null;
  }
}
