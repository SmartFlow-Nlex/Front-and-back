import { db } from "../config/db.js";

// Reads for gold.ml_weather_speed_forecast / ml_weather_speed_contour /
// ml_weather_speed_metadata — written by
// Back-End/incident_model_scripts/train_incident_weather_speed_models.py
// (SARIMAX/LSTM/GRU/XGBoost for daily speed+volume, two logistic
// regressions for road-closure and weather-incident-risk, XGBoost again at
// exit-hour grain for the contour map). See that script's module docstring
// for the data-quality caveat every caption here inherits: this
// warehouse's avg_speed_kmh is synthetic and does not behave like a real
// highway's speed (it correlates POSITIVELY with jam level), and a
// corrupted tail (2026-04-19 onward) is excluded from training entirely.

export type ContourCell = {
  exitId: number;
  exitName: string;
  km: number;
  hourOfDay: number;
  scenario: "dry" | "wet";
  predictedSpeedKmh: number;
};

export type DailyForecastPoint = {
  date: string;
  actualSpeedKmh: number | null;
  predictedSpeedKmh: number;
  speedModel: string;
  actualVolume: number | null;
  predictedVolume: number | null;
  rainMm: number | null;
};

export type WeatherSpeedData = {
  contour: ContourCell[];
  dailyForecast: DailyForecastPoint[];
  metadata: Record<string, unknown> | null;
  trainedAt: string | null;
};

export async function getIncidentWeatherSpeedFromDb(): Promise<WeatherSpeedData | null> {
  if (!db) return null;
  try {
    const [contourRes, forecastRes, metaRes] = await Promise.all([
      db.query<{
        exit_id: number; exit_name: string; km: number; hour_of_day: number;
        scenario: "dry" | "wet"; predicted_speed_kmh: number;
      }>(
        `SELECT exit_id, exit_name, km, hour_of_day, scenario, predicted_speed_kmh
         FROM gold.ml_weather_speed_contour
         ORDER BY exit_id, hour_of_day, scenario`
      ),
      db.query<{
        forecast_date: string; actual_speed_kmh: number | null; predicted_speed_kmh: number;
        speed_model: string; actual_volume: number | null; predicted_volume: number | null;
        rain_mm: number | null; trained_at: string;
      }>(
        `SELECT forecast_date::text AS forecast_date, actual_speed_kmh, predicted_speed_kmh, speed_model,
                actual_volume, predicted_volume, rain_mm, trained_at
         FROM gold.ml_weather_speed_forecast
         ORDER BY forecast_date ASC`
      ),
      db.query<{ metadata_json: Record<string, unknown>; created_at: string }>(
        `SELECT metadata_json, created_at FROM gold.ml_weather_speed_metadata
         ORDER BY created_at DESC LIMIT 1`
      ),
    ]);

    if (contourRes.rows.length === 0 && forecastRes.rows.length === 0) {
      return null;
    }

    return {
      contour: contourRes.rows.map((r) => ({
        exitId: r.exit_id,
        exitName: r.exit_name,
        km: Number(r.km),
        hourOfDay: r.hour_of_day,
        scenario: r.scenario,
        predictedSpeedKmh: Number(r.predicted_speed_kmh),
      })),
      dailyForecast: forecastRes.rows.map((r) => ({
        date: r.forecast_date,
        actualSpeedKmh: r.actual_speed_kmh == null ? null : Number(r.actual_speed_kmh),
        predictedSpeedKmh: Number(r.predicted_speed_kmh),
        speedModel: r.speed_model,
        actualVolume: r.actual_volume == null ? null : Number(r.actual_volume),
        predictedVolume: r.predicted_volume == null ? null : Number(r.predicted_volume),
        rainMm: r.rain_mm == null ? null : Number(r.rain_mm),
      })),
      metadata: metaRes.rows[0]?.metadata_json ?? null,
      trainedAt: forecastRes.rows[0]?.trained_at ? new Date(forecastRes.rows[0].trained_at).toISOString() : null,
    };
  } catch (error) {
    console.error("Failed to fetch weather-adjusted speed models:", error);
    return null;
  }
}
