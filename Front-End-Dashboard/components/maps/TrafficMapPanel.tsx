"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import mapboxgl, { GeoJSONSource } from "mapbox-gl";
import { useEffect, useRef } from "react";

type Props = {
  title: string;
  subtitle: string;
  badge: string;
  endpoint: string;
  layerColor: string;
  tone: "blue" | "purple";
  children?: React.ReactNode;
};

export default function TrafficMapPanel({ title, subtitle, badge, endpoint, layerColor, tone, children }: Props) {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token || !containerRef.current) return;

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [121.002, 14.69],
      zoom: 10.3,
      attributionControl: false,
    });

    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", async () => {
      const response = await fetch(endpoint, { cache: "no-store" });
      const data = await response.json();

      map.addSource("traffic", {
        type: "geojson",
        data,
      });

      map.addLayer({
        id: "traffic-line",
        type: "line",
        source: "traffic",
        paint: {
          "line-color": layerColor,
          "line-width": 5,
          "line-opacity": 0.78,
        },
      });

      map.addLayer({
        id: "traffic-points",
        type: "circle",
        source: "traffic",
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-color": layerColor,
          "circle-stroke-width": 2,
        },
      });

      const source = map.getSource("traffic") as GeoJSONSource;
      setInterval(async () => {
        try {
          const fresh = await fetch(endpoint, { cache: "no-store" }).then((r) => r.json());
          source.setData(fresh);
        } catch {
          // no-op polling fallback
        }
      }, 15000);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [endpoint, layerColor]);

  return (
    <article className="map-card">
      <header className={`map-head ${tone}`}>
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <span>{badge}</span>
      </header>
      <div className="map-canvas-container">
        <div className="map-canvas mapbox" ref={containerRef} />
        {children}
      </div>
    </article>
  );
}
