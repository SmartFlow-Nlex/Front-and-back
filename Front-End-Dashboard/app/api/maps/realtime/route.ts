import { NextResponse } from "next/server";
import type { FeatureCollection, LineString } from "geojson";
import { getDbPool } from "../../../../lib/db";

export const dynamic = "force-static";

const fallbackRealtime: FeatureCollection<LineString> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { traffic_level: "heavy", speed: 42 },
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
  try {
    const pool = getDbPool();
    if (!pool) {
      return NextResponse.json(fallbackRealtime);
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
            'segment_id', t.segment_id,
            'traffic_level', t.traffic_level,
            'speed', t.speed_kmh
          ),
          'geometry', ST_AsGeoJSON(ST_Transform(t.geom, 4326))::jsonb
        ) AS feature
        FROM traffic_realtime_segments t
        LIMIT 500
      ) fc;
    `;

    const result = await pool.query(query);
    return NextResponse.json(result.rows[0]?.geojson ?? fallbackRealtime);
  } catch {
    return NextResponse.json(fallbackRealtime);
  }
}
