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
        const typeColor = props.type === "ACCIDENT" ? "#b91c1c" : props.type === "POLICE" ? "#3b82f6" : props.type === "CONSTRUCTION" ? "#f97316" : props.type === "JAM" ? "#ef4444" : "#eab308";
        const typeBg = props.type === "ACCIDENT" ? "#fef2f2" : props.type === "POLICE" ? "#eff6ff" : props.type === "CONSTRUCTION" ? "#fff7ed" : props.type === "JAM" ? "#fef2f2" : "#fefce8";
        
        const description = `
          <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; width: 240px; border-radius: 14px; background: #fff; overflow: hidden; box-shadow: 0 12px 40px rgba(7,17,38,0.18);">
            <div style="height: 3px; background: linear-gradient(90deg, ${typeColor}, ${typeColor}88);"></div>
            <div style="padding: 14px 16px 12px;">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                <span style="font-size: 16px; line-height: 1;">${iconEmoji}</span>
                <span style="font-weight: 800; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: ${typeColor}; background: ${typeBg}; padding: 3px 10px; border-radius: 20px;">${typeLabel}</span>
              </div>
              <div style="font-size: 12px; font-weight: 700; color: #1e293b; margin-bottom: 2px;">${props.street || "NLEX"}</div>
              ${props.city ? `<div style="font-size: 11px; color: #64748b;">${props.city}</div>` : ""}
              ${props.report_description ? `<div style="font-size: 11px; color: #475569; line-height: 1.45; background: #f8fafc; padding: 8px 10px; border-radius: 8px; margin-top: 8px; border-left: 3px solid ${typeColor}22;">${props.report_description}</div>` : ""}
              <div style="display: flex; gap: 16px; margin-top: 10px; padding-top: 8px; border-top: 1px solid #f1f5f9;">
                <div style="font-size: 10px; color: #94a3b8;">Reliability <span style="font-weight: 800; color: #475569;">${props.reliability || 0}/10</span></div>
                <div style="font-size: 10px; color: #94a3b8;">Confidence <span style="font-weight: 800; color: #475569;">${props.confidence || 0}/5</span></div>
              </div>
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
          const severityBg = props.level === 4 ? "#fef2f2" : props.level === 3 ? "#fff7ed" : props.level === 2 ? "#fffbeb" : "#f0fdf4";
          const delayMin = Math.round((props.delay_seconds || 0) / 60);
          
          description = `
            <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; width: 220px; border-radius: 14px; background: #fff; overflow: hidden; box-shadow: 0 12px 40px rgba(7,17,38,0.18);">
              <div style="height: 3px; background: linear-gradient(90deg, ${severityColor}, ${severityColor}66);"></div>
              <div style="padding: 14px 16px 12px;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                  <span style="font-size: 15px; line-height: 1;">🚗</span>
                  <span style="font-weight: 800; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: ${severityColor}; background: ${severityBg}; padding: 3px 10px; border-radius: 20px;">${severity} Jam</span>
                </div>
                <div style="font-size: 12px; font-weight: 700; color: #1e293b; margin-bottom: 2px;">${props.street || "NLEX Corridor"}</div>
                ${props.city ? `<div style="font-size: 11px; color: #64748b;">${props.city}</div>` : ""}
                <div style="display: flex; gap: 12px; margin-top: 10px; padding-top: 8px; border-top: 1px solid #f1f5f9;">
                  <div style="flex: 1; text-align: center; padding: 6px; background: #f8fafc; border-radius: 8px;">
                    <div style="font-size: 14px; font-weight: 800; color: #1e293b;">${props.speed || 0}</div>
                    <div style="font-size: 9px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em;">km/h</div>
                  </div>
                  <div style="flex: 1; text-align: center; padding: 6px; background: #f8fafc; border-radius: 8px;">
                    <div style="font-size: 14px; font-weight: 800; color: #1e293b;">${delayMin}</div>
                    <div style="font-size: 9px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em;">min delay</div>
                  </div>
                </div>
              </div>
            </div>
          `;
        } else {
          // Forecast map
          const score = Math.round((props.congestion_score || 0) * 100);
          const congLevel = score >= 70 ? "High" : score >= 40 ? "Medium" : "Low";
          const congColor = score >= 70 ? "#7c3aed" : score >= 40 ? "#8b5cf6" : "#a855f7";
          const congBg = score >= 70 ? "#f3e8ff" : score >= 40 ? "#f5f0ff" : "#faf5ff";
          description = `
            <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; width: 220px; border-radius: 14px; background: #fff; overflow: hidden; box-shadow: 0 12px 40px rgba(7,17,38,0.18);">
              <div style="height: 3px; background: linear-gradient(90deg, #a855f7, #6d28d9);"></div>
              <div style="padding: 14px 16px 12px;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                  <span style="font-size: 15px; line-height: 1;">🔮</span>
                  <span style="font-weight: 800; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: ${congColor}; background: ${congBg}; padding: 3px 10px; border-radius: 20px;">${congLevel} Congestion</span>
                </div>
                <div style="font-size: 12px; font-weight: 700; color: #1e293b; margin-bottom: 6px;">Segment: ${props.segment_id || "NLEX"}</div>
                <div style="display: flex; gap: 12px; margin-top: 4px; padding-top: 8px; border-top: 1px solid #f1f5f9;">
                  <div style="flex: 1; text-align: center; padding: 6px; background: #faf5ff; border-radius: 8px;">
                    <div style="font-size: 14px; font-weight: 800; color: #6d28d9;">${score}%</div>
                    <div style="font-size: 9px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em;">congestion</div>
                  </div>
                  <div style="flex: 1; text-align: center; padding: 6px; background: #faf5ff; border-radius: 8px;">
                    <div style="font-size: 14px; font-weight: 800; color: #6d28d9;">${props.horizon || "2h"}</div>
                    <div style="font-size: 9px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em;">horizon</div>
                  </div>
                </div>
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


