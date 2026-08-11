import { NextResponse } from "next/server";
import type { FeatureCollection, LineString } from "geojson";
import { getDbPool } from "../../../../lib/db";

export const dynamic = "force-static";

const fallbackForecast: FeatureCollection<LineString> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { congestion_score: 0.78, horizon: "2h" },
      geometry: {
        type: "LineString",
        coordinates: [
          [120.9842, 14.6575],
          [120.9905, 14.673],
          [121.0002, 14.6911],
          [121.009, 14.7105],
          [121.0172, 14.728],
        ],
      },
    },
  ],
};

export async function GET() {
  const horizon = "2h";

  try {
    const pool = getDbPool();
    if (!pool) {
      return NextResponse.json(fallbackForecast);
    }

    const query = `
      SELECT jsonb_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(jsonb_agg(feature), '[]'::jsonb)
      ) AS geojson
      FROM (
        SELECT jsonb_build_object(
          'type', 'Feature',
          'properties', jsonb_build_object(
            'segment_id', p.segment_id,
            'congestion_score', p.congestion_score,
            'horizon', p.horizon
          ),
          'geometry', ST_AsGeoJSON(ST_Transform(p.geom, 4326))::jsonb
        ) AS feature
        FROM traffic_forecast_segments p
        WHERE p.horizon = $1
        LIMIT 500
      ) fc;
    `;

    const result = await pool.query(query, [horizon]);
    return NextResponse.json(result.rows[0]?.geojson ?? fallbackForecast);
  } catch {
    return NextResponse.json(fallbackForecast);
  }
}
