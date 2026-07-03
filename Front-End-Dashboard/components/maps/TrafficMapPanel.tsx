"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl, { GeoJSONSource } from "maplibre-gl";
import type { Point } from "geojson";
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
  const mapRef = useRef<maplibregl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json", // Free premium Mapbox-compatible style
      center: [121.002, 14.69],
      zoom: 10.3,
      attributionControl: false,
    });

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", async () => {
      const response = await fetch(endpoint, { cache: "no-store" });
      const data = await response.json();

      const isRealtime = endpoint.includes("real-time");

      map.addSource("traffic", {
        type: "geojson",
        data,
      });

      // Jam Lines Layer
      map.addLayer({
        id: "traffic-line",
        type: "line",
        source: "traffic",
        paint: {
          "line-color": isRealtime
            ? [
                "match",
                ["get", "level"],
                1, "#10b981", // Light (Green)
                2, "#f59e0b", // Moderate (Yellow/Orange)
                3, "#f97316", // Heavy (Orange)
                4, "#ef4444", // Severe (Red)
                layerColor    // Fallback
              ]
            : [
                "interpolate",
                ["linear"],
                ["get", "congestion_score"],
                0.2, "#a855f7",
                0.6, "#8b5cf6",
                0.9, "#6d28d9"
              ],
          "line-width": 5,
          "line-opacity": 0.78,
        },
        filter: ["==", ["geometry-type"], "LineString"],
      });

      // Incident / Alert Points Layer
      map.addLayer({
        id: "traffic-points",
        type: "circle",
        source: "traffic",
        paint: {
          "circle-radius": isRealtime ? 7 : 5,
          "circle-color": isRealtime
            ? [
                "match",
                ["get", "type"],
                "ACCIDENT", "#b91c1c",     // Crimson
                "JAM", "#ef4444",          // Red
                "CONSTRUCTION", "#f97316", // Orange
                "POLICE", "#3b82f6",       // Blue
                "HAZARD", "#eab308",       // Yellow
                "#ffffff"                  // Fallback
              ]
            : "#ffffff",
          "circle-stroke-color": isRealtime ? "#ffffff" : layerColor,
          "circle-stroke-width": 2,
        },
        filter: ["==", ["geometry-type"], "Point"],
      });

      // Hover popup logic
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
      });

      // Point Hover
      map.on("mouseenter", "traffic-points", (e) => {
        if (!isRealtime) return;
        map.getCanvas().style.cursor = "pointer";
        const features = map.queryRenderedFeatures(e.point, { layers: ["traffic-points"] });
        if (!features.length) return;
        
        const feature = features[0];
        const geom = feature.geometry as Point;
        const coordinates = [...geom.coordinates] as [number, number];
        const props = feature.properties;
        if (!props) return;

        while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
          coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
        }

        const typeLabel = props.type || "Alert";
        const iconEmoji = props.type === "ACCIDENT" ? "🚗💥" : props.type === "POLICE" ? "👮" : props.type === "CONSTRUCTION" ? "🚧" : props.type === "JAM" ? "🛑" : "⚠️";
        
        const description = `
          <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; padding: 10px; width: 220px; border-radius: 12px; background: white; box-shadow: 0 4px 20px rgba(0,0,0,0.08); color: #1e293b;">
            <div style="font-weight: 700; font-size: 13px; text-transform: uppercase; display: flex; align-items: center; gap: 6px; color: ${
              props.type === "ACCIDENT" ? "#b91c1c" : props.type === "POLICE" ? "#3b82f6" : props.type === "CONSTRUCTION" ? "#f97316" : "#eab308"
            }; margin-bottom: 4px;">
              <span>${iconEmoji}</span> ${typeLabel}
            </div>
            <div style="font-size: 11px; font-weight: 600; color: #475569; margin-bottom: 6px;">${props.street || "NLEX"} ${props.city ? `(${props.city})` : ""}</div>
            ${props.report_description ? `<div style="font-size: 11px; color: #334155; line-height: 1.4; background: #f8fafc; padding: 6px; border-radius: 6px; margin-bottom: 6px;">"${props.report_description}"</div>` : ""}
            <div style="font-size: 10px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 6px; display: flex; justify-content: space-between;">
              <span>Reliability: <strong>${props.reliability || 0}/10</strong></span>
              <span>Confidence: <strong>${props.confidence || 0}/5</strong></span>
            </div>
          </div>
        `;

        popup.setLngLat(coordinates).setHTML(description).addTo(map);
      });

      map.on("mouseleave", "traffic-points", () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });

      // Line Hover
      map.on("mouseenter", "traffic-line", (e) => {
        map.getCanvas().style.cursor = "pointer";
        const features = map.queryRenderedFeatures(e.point, { layers: ["traffic-line"] });
        if (!features.length) return;
        
        const feature = features[0];
        const props = feature.properties;
        if (!props) return;

        let description = "";

        if (isRealtime) {
          const severity = props.level === 4 ? "Severe" : props.level === 3 ? "Heavy" : props.level === 2 ? "Moderate" : "Light";
          const severityColor = props.level === 4 ? "#ef4444" : props.level === 3 ? "#f97316" : props.level === 2 ? "#f59e0b" : "#10b981";
          
          description = `
            <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; padding: 10px; width: 180px; border-radius: 12px; background: white; box-shadow: 0 4px 20px rgba(0,0,0,0.08); color: #1e293b;">
              <div style="font-weight: 700; font-size: 13px; color: ${severityColor}; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                🚗 ${severity} Jam
              </div>
              <div style="font-size: 11px; font-weight: 600; color: #475569; margin-bottom: 6px;">${props.street || "NLEX Corridor"} ${props.city ? `(${props.city})` : ""}</div>
              <div style="font-size: 11px; color: #334155; line-height: 1.5; border-top: 1px solid #f1f5f9; padding-top: 6px;">
                Avg Speed: <strong>${props.speed || 0} km/h</strong><br/>
                Delay: <strong>${Math.round((props.delay_seconds || 0) / 60)} min</strong>
              </div>
            </div>
          `;
        } else {
          // Forecast map
          const score = Math.round((props.congestion_score || 0) * 100);
          description = `
            <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; padding: 10px; width: 180px; border-radius: 12px; background: white; box-shadow: 0 4px 20px rgba(0,0,0,0.08); color: #1e293b;">
              <div style="font-weight: 700; font-size: 13px; color: #a855f7; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                🔮 Predicted Traffic
              </div>
              <div style="font-size: 11px; font-weight: 600; color: #475569; margin-bottom: 6px;">Segment: ${props.segment_id || "NLEX"}</div>
              <div style="font-size: 11px; color: #334155; line-height: 1.5; border-top: 1px solid #f1f5f9; padding-top: 6px;">
                Congestion Index: <strong>${score}%</strong><br/>
                Horizon: <strong>${props.horizon || "2h"}</strong>
              </div>
            </div>
          `;
        }

        popup.setLngLat(e.lngLat).setHTML(description).addTo(map);
      });

      map.on("mouseleave", "traffic-line", () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });

      const source = map.getSource("traffic") as GeoJSONSource;
      setInterval(async () => {
        try {
          const fresh = await fetch(endpoint, { cache: "no-store" }).then((r) => r.json());
          source.setData(fresh);
        } catch {
          // No-op polling fallback
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


