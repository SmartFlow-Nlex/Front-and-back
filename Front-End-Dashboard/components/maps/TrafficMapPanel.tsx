"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import mapboxgl, { GeoJSONSource } from "mapbox-gl";
import type { Point } from "geojson";
import { useEffect, useRef } from "react";

type Props = {
  title: string;
  subtitle: string;
  badge: React.ReactNode;
  endpoint: string;
  layerColor: string;
  tone: "blue" | "purple";
  children?: React.ReactNode;
};

export default function TrafficMapPanel({ title, subtitle, badge, endpoint, layerColor, tone, children }: Props) {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeMarkers = useRef<mapboxgl.Marker[]>([]);
  const alertMarkersRef = useRef<mapboxgl.Marker[]>([]);


  useEffect(() => {
    if (!containerRef.current) return;

    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/streets-v12", // Mapbox Streets design matching the screenshot
      center: [120.79, 14.94],
      zoom: 9.2,
      pitch: 0, // Flat (2D)
      bearing: 0, // North up
      attributionControl: false,
    });

    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");

    const resizeObserver = new ResizeObserver(() => {
      map.resize();
    });
    resizeObserver.observe(containerRef.current);

    map.on("load", async () => {
      const response = await fetch(endpoint, { cache: "no-store" });
      const data = await response.json();
      console.log("TRAFFIC DATA LOADED:", data);

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
              5, "#b91c1c", // Standstill (Dark Red)
              "#10b981"    // Fallback (Green)
            ]
            : [
              "interpolate",
              ["linear"],
              ["get", "congestion_score"],
              0.2, "#a855f7",
              0.6, "#8b5cf6",
              0.9, "#6d28d9"
            ],
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8, 5,
            12, 10,
            16, 14
          ],
          "line-opacity": 0.85,
        },
        filter: isRealtime
          ? ["==", ["get", "feature_type"], "jam"]
          : ["==", ["geometry-type"], "LineString"],
      });

      // Incident / Alert Points Layer — native Mapbox circle (always pixel-perfect)
      map.addLayer({
        id: "traffic-points",
        type: "circle",
        source: "traffic",
        paint: {
          "circle-radius": isRealtime ? 12 : 8,
          "circle-color": "#ff0000",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
          "circle-opacity": 1,
        },
        filter: [
          "all",
          ["==", ["get", "feature_type"], "alert"],
          ["!=", ["get", "type"], "JAM"]
        ],
      });




      // Hover popup logic
      const popup = new mapboxgl.Popup({
        closeButton: false,
        closeOnClick: false,
      });

      // Point Hover
      map.on("mouseenter", "traffic-points", (e) => {
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
            <div style="font-weight: 700; font-size: 13px; text-transform: uppercase; display: flex; align-items: center; gap: 6px; color: ${props.type === "ACCIDENT" ? "#b91c1c" : props.type === "POLICE" ? "#3b82f6" : props.type === "CONSTRUCTION" ? "#f97316" : "#eab308"
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

      // Toll Plaza HTML Markers — All 20 NLEX exits with exact coordinates from official data
      if (isRealtime) {
        const tollPlazas = [
          {
            name: "Balintawak",
            shortName: "Balintawak",
            location: "Caloocan City",
            type: "Exit",
            rates: "Open system toll",
            description: "Southern terminus of NLEX.",
            coordinates: [121.00008900172813, 14.67876672198161],
          },
          {
            name: "NLEX Harbor Link",
            shortName: "Harbor Link",
            location: "Valenzuela City",
            type: "Entry and Exit",
            rates: "Open system toll",
            description: "Connects to NLEX Harbor Link / Connector segment.",
            coordinates: [121.00030793375893, 14.69346529853609],
          },
          {
            name: "Paso De Blas Valenzuela",
            shortName: "Paso de Blas",
            location: "Valenzuela City",
            type: "Entry and Exit",
            rates: "Open system toll",
            description: "Exit to Paso de Blas, Valenzuela.",
            coordinates: [120.99300157701673, 14.70821348617265],
          },
          {
            name: "Meycauayan",
            shortName: "Meycauayan",
            location: "Meycauayan, Bulacan",
            type: "Entry and Exit",
            rates: "Open system toll",
            description: "Interchange for Meycauayan, Bulacan.",
            coordinates: [120.97231561928430, 14.74638836470472],
          },
          {
            name: "Marilao",
            shortName: "Marilao",
            location: "Marilao, Bulacan",
            type: "Entry and Exit",
            rates: "Open system toll",
            description: "Exit for Marilao, Bulacan. End of open toll system.",
            coordinates: [120.95726732953010, 14.77456202043474],
          },
          {
            name: "Cdv/Ph Arena",
            shortName: "CdV/Ph Arena",
            location: "Bocaue, Bulacan",
            type: "Entry and Exit",
            rates: "Open system toll",
            description: "Exit to Ciudad de Victoria / Philippine Arena.",
            coordinates: [120.94725606760602, 14.79312378515166],
          },
          {
            name: "Bocaue Barrier",
            shortName: "Bocaue Barrier",
            location: "Bocaue, Bulacan",
            type: "Exit",
            rates: "Open system toll",
            description: "Main toll barrier. Transition from open to closed system.",
            coordinates: [120.94245608845259, 14.80245619390151],
          },
          {
            name: "Bocaue Interchange",
            shortName: "Bocaue Int.",
            location: "Bocaue, Bulacan",
            type: "Entry and Exit",
            rates: "Closed system toll",
            description: "Bocaue interchange entry/exit point.",
            coordinates: [120.93939984817274, 14.80723392515467],
          },
          {
            name: "Tambubong",
            shortName: "Tambubong",
            location: "Bocaue, Bulacan",
            type: "Entry and Exit",
            rates: "Closed system toll",
            description: "Interchange exit for Tambubong, Bocaue.",
            coordinates: [120.93507141724179, 14.81512389728283],
          },
          {
            name: "Tabang Guiguinto",
            shortName: "Tabang",
            location: "Guiguinto, Bulacan",
            type: "Entry",
            rates: "Closed system toll",
            description: "Entry point at Tabang, Guiguinto.",
            coordinates: [120.90391121629810, 14.83274649661766],
          },
          {
            name: "Balagtas",
            shortName: "Balagtas",
            location: "Balagtas, Bulacan",
            type: "Entry",
            rates: "Closed system toll",
            description: "Entry point for Balagtas, Bulacan.",
            coordinates: [120.90063378190028, 14.83443660148125],
          },
          {
            name: "Sta. Rita Guiguinto",
            shortName: "Sta. Rita",
            location: "Guiguinto, Bulacan",
            type: "Entry and Exit",
            rates: "Closed system toll",
            description: "Interchange for Sta. Rita, Guiguinto.",
            coordinates: [120.85888660798751, 14.86245340592165],
          },
          {
            name: "Pulilan",
            shortName: "Pulilan",
            location: "Pulilan, Bulacan",
            type: "Entry and Exit",
            rates: "Closed system toll",
            description: "Exit to Pulilan, Bulacan.",
            coordinates: [120.81701519028174, 14.90825804348608],
          },
          {
            name: "San Simon",
            shortName: "San Simon",
            location: "San Simon, Pampanga",
            type: "Entry and Exit",
            rates: "Closed system toll",
            description: "Interchange for San Simon, Pampanga.",
            coordinates: [120.74996867688135, 14.99013450749262],
          },
          {
            name: "San Fernando",
            shortName: "San Fernando",
            location: "San Fernando, Pampanga",
            type: "Entry and Exit",
            rates: "Closed system toll",
            description: "Exit to the City of San Fernando, Pampanga capital.",
            coordinates: [120.69485632354187, 15.04970605389222],
          },
          {
            name: "Mexico",
            shortName: "Mexico",
            location: "Mexico, Pampanga",
            type: "Entry and Exit",
            rates: "Closed system toll",
            description: "Interchange for Mexico, Pampanga.",
            coordinates: [120.66361945309848, 15.10521677624212],
          },
          {
            name: "Angeles",
            shortName: "Angeles",
            location: "Angeles City, Pampanga",
            type: "Entry and Exit",
            rates: "Closed system toll",
            description: "Exit to Angeles City, Pampanga.",
            coordinates: [120.61345871762175, 15.16311426503998],
          },
          {
            name: "Dau",
            shortName: "Dau",
            location: "Mabalacat, Pampanga",
            type: "Entry and Exit",
            rates: "Closed system toll",
            description: "Connects to SCTEX. Major junction for Clark & Subic.",
            coordinates: [120.60462937006393, 15.17800946903190],
          },
          {
            name: "SCTEX",
            shortName: "SCTEX",
            location: "Mabalacat, Pampanga",
            type: "Exit",
            rates: "Closed system toll",
            description: "SCTEX interchange connection.",
            coordinates: [120.59712067640591, 15.19630093067524],
          },
          {
            name: "Sta. Ines",
            shortName: "Sta. Ines",
            location: "Mabalacat, Pampanga",
            type: "Entry",
            rates: "Closed system toll",
            description: "Northern terminus of NLEX.",
            coordinates: [120.58783493245980, 15.22203654424792],
          },
        ];

        tollPlazas.forEach(toll => {
          const el = document.createElement("div");
          el.className = "custom-toll-marker";
          el.innerHTML = `
            <div style="
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              cursor: pointer;
            ">
              <!-- Custom Toll Gate Icon -->
              <div style="
                width: 24px;
                height: 24px;
                border-radius: 6px;
                background: linear-gradient(135deg, #0e7490 0%, #06b6d4 100%);
                border: 2px solid #ffffff;
                box-shadow: 0 4px 10px rgba(6, 182, 212, 0.4);
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
              ">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18v3H3z" fill="white" />
                  <path d="M6 9v9M18 9v9" />
                  <path d="M6 13h12" stroke="#eab308" stroke-width="3" />
                </svg>
              </div>
              <!-- Text label -->
              <div style="
                margin-top: 3px;
                background: rgba(15, 23, 42, 0.85);
                backdrop-filter: blur(4px);
                color: white;
                font-size: 8px;
                font-weight: 700;
                padding: 1px 4px;
                border-radius: 3px;
                white-space: nowrap;
                border: 1px solid rgba(255, 255, 255, 0.15);
                box-shadow: 0 2px 5px rgba(0,0,0,0.2);
                letter-spacing: 0.5px;
              ">
                ${toll.shortName}
              </div>
            </div>
          `;

          const marker = new mapboxgl.Marker({ element: el })
            .setLngLat(toll.coordinates as [number, number])
            .addTo(map);

          el.addEventListener("mouseenter", () => {
            const description = `
              <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; padding: 12px; width: 240px; border-radius: 12px; background: white; box-shadow: 0 4px 20px rgba(0,0,0,0.08); color: #1e293b; border-left: 4px solid #06b6d4;">
                <div style="font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 6px; color: #0891b2; margin-bottom: 4px;">
                  <span>🛣️</span> ${toll.name}
                </div>
                <div style="font-size: 11px; font-weight: 600; color: #475569; margin-bottom: 4px;">${toll.location}</div>
                <div style="display: inline-block; font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: #ecfeff; color: #0e7490; margin-bottom: 6px; letter-spacing: 0.3px;">${toll.type}</div>
                <div style="font-size: 11px; color: #334155; line-height: 1.4; background: #f8fafc; padding: 8px; border-radius: 6px; margin-bottom: 6px; font-weight: 500;">
                  ${toll.description}
                </div>
                <div style="font-size: 10px; color: #0891b2; border-top: 1px solid #e2e8f0; padding-top: 6px;">
                  <strong>Toll System:</strong> <span style="color: #334155;">${toll.rates}</span>
                </div>
              </div>
            `;
            popup.setLngLat(toll.coordinates as [number, number]).setHTML(description).addTo(map);
          });

          el.addEventListener("mouseleave", () => {
            popup.remove();
          });

          activeMarkers.current.push(marker);
        });
      }

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

      // Render alerts as HTML markers to ensure they are highly visible and don't rely on Mapbox GL circle layer filtering,
      // but remove CSS transitions so they don't drift during zoom.
      const renderAlerts = (geojson: any) => {
        // Clear old alert markers
        alertMarkersRef.current.forEach((m) => m.remove());
        alertMarkersRef.current = [];

        if (!geojson || !geojson.features) return;
        
        geojson.features.forEach((feature: any) => {
          if (feature.properties?.feature_type !== "alert") return;
          // Skip JAM point alerts since they are rendered as lines on the road
          if (feature.properties?.type === "JAM") return;
          if (feature.geometry?.type !== "Point") return;
          
          const coords = feature.geometry.coordinates;
          const props = feature.properties;
          const typeLabel = props.type || "Alert";
          const iconEmoji = props.type === "ACCIDENT" ? "🚗💥" : props.type === "POLICE" ? "👮" : props.type === "CONSTRUCTION" ? "🚧" : props.type === "JAM" ? "🛑" : "⚠️";
          
          let color = "#eab308"; // Hazard/Fallback (Yellow)
          let iconSvg = "";
          
          if (props.type === "ACCIDENT") {
            color = "#991b1b"; // Dark red
            iconSvg = `
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            `;
          } else if (props.type === "POLICE") {
            color = "#2563eb"; // Blue
            iconSvg = `
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
            `;
          } else if (props.type === "CONSTRUCTION") {
            color = "#ea580c"; // Orange
            iconSvg = `
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="m6 21 6-18 6 18"/>
                <path d="M4.5 21h15"/>
                <path d="M8 15h8"/>
                <path d="M9 11h6"/>
              </svg>
            `;
          } else {
            color = "#eab308"; // Yellow (Hazard / Default)
            iconSvg = `
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            `;
          }

          const el = document.createElement("div");
          el.className = "waze-alert-marker";
          el.style.display = "flex";
          el.style.alignItems = "center";
          el.style.justifyContent = "center";
          el.style.width = "28px";
          el.style.height = "28px";
          el.style.cursor = "pointer";
          
          el.innerHTML = `
            <div class="pulsing-marker-container">
              <div class="pulsing-marker-glow ${props.type?.toLowerCase() || 'hazard'}"></div>
              <div class="pulsing-marker-core ${props.type?.toLowerCase() || 'hazard'}" style="
                width: 20px !important;
                height: 20px !important;
                border-radius: 50% !important;
                border: 2px solid #ffffff !important;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3) !important;
                background-color: ${color} !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                color: white !important;
                z-index: 2 !important;
              ">
                ${iconSvg}
              </div>
            </div>
          `;
          
          const popup = new mapboxgl.Popup({ offset: 15, closeButton: false }).setHTML(`
            <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; padding: 10px; width: 220px; border-radius: 12px; background: white; box-shadow: 0 4px 20px rgba(0,0,0,0.08); color: #1e293b;">
              <div style="font-weight: 700; font-size: 13px; text-transform: uppercase; display: flex; align-items: center; gap: 6px; color: ${color}; margin-bottom: 4px;">
                <span>${iconEmoji}</span> ${typeLabel}
              </div>
              <div style="font-size: 11px; font-weight: 600; color: #475569; margin-bottom: 6px;">${props.street || "NLEX"} ${props.city ? `(${props.city})` : ""}</div>
              ${props.report_description ? `<div style="font-size: 12px; line-height: 1.4; color: #334155; margin-bottom: 8px;">"${props.report_description}"</div>` : ""}
              <div style="display: flex; gap: 12px; font-size: 10px; color: #64748b; font-weight: 500;">
                <div>Reliability: ${props.reliability || 0}/10</div>
                <div>Confidence: ${props.confidence || 0}/10</div>
              </div>
            </div>
          `);

          const marker = new mapboxgl.Marker({ element: el, anchor: "center" })
            .setLngLat(coords)
            .setPopup(popup)
            .addTo(map);
            
          alertMarkersRef.current.push(marker);
        });
      };
      
      if (isRealtime) {
        renderAlerts(data);
      }

      const source = map.getSource("traffic") as GeoJSONSource;
      const pollingInterval = setInterval(async () => {
        try {
          const fresh = await fetch(endpoint, { cache: "no-store" }).then((r) => r.json());
          source.setData(fresh);
          if (isRealtime) {
            renderAlerts(fresh);
          }
        } catch {
          // No-op polling fallback
        }
      }, 15000);
    });

    return () => {
      resizeObserver.disconnect();
      activeMarkers.current.forEach(m => m.remove());
      activeMarkers.current = [];

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


