import { db } from "../config/db.js";

// ─────────────────────────────────────────────────────────
// Traffic Volume Queries — reads from nlex_traffic_volumes
// ─────────────────────────────────────────────────────────

// Check if we have real traffic data
export async function hasTrafficData(): Promise<boolean> {
  if (!db) return false;
  try {
    const { rows } = await db.query("SELECT COUNT(*)::int as count FROM nlex_traffic_volumes");
    return rows[0].count > 0;
  } catch { return false; }
}

// ADT — Average Daily Traffic (sum of all hourly columns per day, then average)
export async function getADT() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        ROUND(AVG(daily_total)) as adt,
        MIN(daily_total) as min_daily,
        MAX(daily_total) as max_daily,
        COUNT(DISTINCT date) as total_days
      FROM (
        SELECT date,
          SUM(h00+h01+h02+h03+h04+h05+h06+h07+h08+h09+h10+h11+
              h12+h13+h14+h15+h16+h17+h18+h19+h20+h21+h22+h23) as daily_total
        FROM nlex_traffic_volumes
        GROUP BY date
      ) daily
    `);
    return rows[0];
  } catch (error) {
    console.error("DB error (getADT):", error);
    return null;
  }
}

// Monthly ADT trend
export async function getMonthlyADT() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        TO_CHAR(date, 'YYYY-MM') as month,
        ROUND(AVG(daily_total)) as adt
      FROM (
        SELECT date,
          SUM(h00+h01+h02+h03+h04+h05+h06+h07+h08+h09+h10+h11+
              h12+h13+h14+h15+h16+h17+h18+h19+h20+h21+h22+h23) as daily_total
        FROM nlex_traffic_volumes
        GROUP BY date
      ) daily
      GROUP BY TO_CHAR(date, 'YYYY-MM')
      ORDER BY month
    `);
    return rows;
  } catch (error) {
    console.error("DB error (getMonthlyADT):", error);
    return null;
  }
}

// Directional flow — NB vs SB totals
export async function getDirectionalFlow() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT direction,
        SUM(h00+h01+h02+h03+h04+h05+h06+h07+h08+h09+h10+h11+
            h12+h13+h14+h15+h16+h17+h18+h19+h20+h21+h22+h23) as total
      FROM nlex_traffic_volumes
      GROUP BY direction
      ORDER BY direction
    `);
    return rows;
  } catch (error) {
    console.error("DB error (getDirectionalFlow):", error);
    return null;
  }
}

// Vehicle class distribution
export async function getVehicleClassDistribution() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT vehicle_class,
        SUM(h00+h01+h02+h03+h04+h05+h06+h07+h08+h09+h10+h11+
            h12+h13+h14+h15+h16+h17+h18+h19+h20+h21+h22+h23) as total
      FROM nlex_traffic_volumes
      GROUP BY vehicle_class
      ORDER BY vehicle_class
    `);
    return rows;
  } catch (error) {
    console.error("DB error (getVehicleClassDistribution):", error);
    return null;
  }
}

// Exit (Toll Plaza) distribution
export async function getExitDistribution() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT toll_plaza,
        SUM(h00+h01+h02+h03+h04+h05+h06+h07+h08+h09+h10+h11+
            h12+h13+h14+h15+h16+h17+h18+h19+h20+h21+h22+h23) as total
      FROM nlex_traffic_volumes
      GROUP BY toll_plaza
      ORDER BY total DESC
    `);
    return rows;
  } catch (error) {
    console.error("DB error (getExitDistribution):", error);
    return null;
  }
}

// Hourly flow pattern — average across all days
export async function getHourlyPattern() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        ROUND(AVG(h00)) as "00", ROUND(AVG(h01)) as "01", ROUND(AVG(h02)) as "02",
        ROUND(AVG(h03)) as "03", ROUND(AVG(h04)) as "04", ROUND(AVG(h05)) as "05",
        ROUND(AVG(h06)) as "06", ROUND(AVG(h07)) as "07", ROUND(AVG(h08)) as "08",
        ROUND(AVG(h09)) as "09", ROUND(AVG(h10)) as "10", ROUND(AVG(h11)) as "11",
        ROUND(AVG(h12)) as "12", ROUND(AVG(h13)) as "13", ROUND(AVG(h14)) as "14",
        ROUND(AVG(h15)) as "15", ROUND(AVG(h16)) as "16", ROUND(AVG(h17)) as "17",
        ROUND(AVG(h18)) as "18", ROUND(AVG(h19)) as "19", ROUND(AVG(h20)) as "20",
        ROUND(AVG(h21)) as "21", ROUND(AVG(h22)) as "22", ROUND(AVG(h23)) as "23"
      FROM nlex_traffic_volumes
    `);
    if (!rows[0]) return null;

    // Convert to array format for charts
    const hourly = [];
    for (let h = 0; h < 24; h++) {
      const key = h.toString().padStart(2, "0");
      hourly.push({
        hour: `${key}:00`,
        avgVolume: Number(rows[0][key]) || 0,
      });
    }
    return hourly;
  } catch (error) {
    console.error("DB error (getHourlyPattern):", error);
    return null;
  }
}

// Full traffic summary for the dashboard
export async function getTrafficSummary() {
  if (!db) return null;
  try {
    const [adt, directional, vehicleClass, exits, hourly, monthly] = await Promise.all([
      getADT(),
      getDirectionalFlow(),
      getVehicleClassDistribution(),
      getExitDistribution(),
      getHourlyPattern(),
      getMonthlyADT(),
    ]);
    return { adt, directional, vehicleClass, exits, hourly, monthly };
  } catch (error) {
    console.error("DB error (getTrafficSummary):", error);
    return null;
  }
}
