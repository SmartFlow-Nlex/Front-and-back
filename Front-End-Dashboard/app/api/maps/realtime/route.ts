import { NextResponse } from "next/server";
import type { FeatureCollection, LineString } from "geojson";

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
  return NextResponse.json(fallbackRealtime);
}
