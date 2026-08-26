"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import mapboxgl, { GeoJSONSource } from "mapbox-gl";
import type { Point } from "geojson";
import { useEffect, useRef, useState } from "react";
import nlexGeometry from "./nlex-geometry.json";
import nlexRamps from "./nlex-ramps.json";

type Props = {
  title: string;
  subtitle: string;
  badge?: React.ReactNode;
  /** Hides the panel's own header — used when a parent supplies one. */
  chromeless?: boolean;
  endpoint: string;
  layerColor: string;
  tone: "blue" | "purple";
  children?: React.ReactNode;
};

export default function TrafficMapPanel({ title, subtitle, badge, endpoint, layerColor, tone, children, chromeless = false }: Props) {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeMarkers = useRef<mapboxgl.Marker[]>([]);
  const alertMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const flyToHandlerRef = useRef<((e: Event) => void) | null>(null);
  const resetViewHandlerRef = useRef<(() => void) | null>(null);
  // "ok" once the map builds; otherwise show a graceful fallback instead of
  // letting Mapbox throw and take the whole page down.
  const [status, setStatus] = useState<"ok" | "no-token" | "error">("ok");

  useEffect(() => {
    if (!containerRef.current) return;

    // A Mapbox public token always starts with "pk.". Checking only for a
    // non-empty string is not enough: the committed .env ships a
    // "YOUR_MAPBOX_PUBLIC_TOKEN_HERE" placeholder, which is truthy, so it slips
    // past and Mapbox then fails at tile-fetch time with a 401. That failure is
    // asynchronous, so the try/catch below never sees it and the panel sits
    // blank with no explanation. Validate the shape up front instead.
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim();
    if (!token || !token.startsWith("pk.")) {
      setStatus("no-token");
      return;
    }

    mapboxgl.accessToken = token;
    let map: mapboxgl.Map;
    try {
      map = new mapboxgl.Map({
        container: containerRef.current,
        style: "mapbox://styles/mapbox/light-v11", // Gray base map
        center: [120.79, 14.94],
        zoom: 9.2,
        minZoom: 9.0, // Max zoom out restricted to this view
        maxBounds: [
          [120.4, 14.5], // Southwest bound (Manila Bay area)
          [121.2, 15.3]  // Northeast bound (past Sta. Ines)
        ],
        pitch: 0, // Flat (2D)
        bearing: 0, // North up
        attributionControl: false,
      });
    } catch (err) {
      console.error("Mapbox failed to initialize:", err);
      setStatus("error");
      return;
    }

    setStatus("ok");
    mapRef.current = map;

    // A syntactically valid but rejected token (revoked, wrong account, URL
    // restriction not matching) only shows up here, as a 401 on the first tile
    // or style request. Without this the panel would stay blank and silent.
    map.on("error", (e: { error?: { status?: number; message?: string } }) => {
      const status = e?.error?.status;
      if (status === 401 || status === 403) {
        console.error("Mapbox rejected the access token:", e.error?.message);
        setStatus("error");
      }
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");

    // The header's exit search broadcasts a pick; both panels fly to it together
    // so the two maps stay on the same place for comparison.
    const onFlyTo = (e: Event) => {
      const d = (e as CustomEvent<{ lng: number; lat: number }>).detail;
      if (!d || !Number.isFinite(d.lng) || !Number.isFinite(d.lat)) return;
      map.flyTo({ center: [d.lng, d.lat], zoom: 12.5, duration: 900 });
    };
    // "Whole corridor" returns both panels to the opening view.
    const onResetView = () => {
      map.flyTo({ center: [120.79, 14.94], zoom: 9.2, duration: 900 });
    };
    window.addEventListener("nlex:flyto", onFlyTo);
    window.addEventListener("nlex:resetview", onResetView);
    flyToHandlerRef.current = onFlyTo;
    resetViewHandlerRef.current = onResetView;

    // Hide all other roads from the base map so ONLY the NLEX corridor is visible
    map.on("style.load", () => {
      const layers = map.getStyle().layers;
      if (layers) {
        layers.forEach((layer) => {
          if (
            layer.id.includes("road") ||
            layer.id.includes("bridge") ||
            layer.id.includes("tunnel") ||
            (layer as Record<string, unknown>)["source-layer"] === "road"
          ) {
            map.setLayoutProperty(layer.id, "visibility", "none");
          }
        });
      }
    });

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

      // Add the base NLEX corridor source
      map.addSource("nlex-corridor", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: nlexGeometry as GeoJSON.Geometry,
            },
          ],
        },
      });

      // NLEX Entrance / Exit ramps (on- & off-ramps into and out of the corridor).
      // Sourced from OSM motorway_link/motorway geometry, so they trace the real road centerlines.
      // NOTE: the ramp layers themselves are added AFTER the mainline (further below) so that on
      // entrance/exit sections the teal fully replaces the orange instead of the two overlapping.
      map.addSource("nlex-ramps", {
        type: "geojson",
        data: nlexRamps as GeoJSON.FeatureCollection,
      });

      // Layer 1: Base NLEX Casing
      map.addLayer({
        id: "nlex-casing",
        type: "line",
        source: "nlex-corridor",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": "#475569", // Slate grey border
          "line-width": [
            "interpolate", ["exponential", 1.5], ["zoom"],
            8,   3,
            12,  7,
            16,  16,
          ],
          "line-opacity": 0.8,
        },
      }); 

      // Layer 2: Base NLEX Surface
      map.addLayer({
        id: "nlex-surface",
        type: "line",
        source: "nlex-corridor",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": "#f59e0b", // Solid Orange
          "line-width": [
            "interpolate", ["exponential", 1.5], ["zoom"],
            8,   1.5,
            12,  4.5,
            16,  12,
          ],
          "line-opacity": 0.9,
        },
      });

      // Entrance / Exit ramp casing — drawn ON TOP of the mainline and at least as wide as the
      // corridor casing, so where a ramp coincides with the corridor the teal fully covers the
      // orange (no orange/teal overlap on entrance & exit sections).
      map.addLayer({
        id: "nlex-ramp-casing",
        type: "line",
        source: "nlex-ramps",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": "#0f766e", // Deep teal border (keeps ramps reading as teal, not grey)
          "line-width": [
            "interpolate", ["exponential", 1.5], ["zoom"],
            8,   3.5,
            12,  8,
            16,  18,
          ],
          "line-opacity": 1,
        },
      });

      // Entrance / Exit ramp surface — teal fill, matches the corridor width so it reads as the
      // same expressway while clearly marking the on/off ramps.
      map.addLayer({
        id: "nlex-ramp-surface",
        type: "line",
        source: "nlex-ramps",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": "#14b8a6", // Teal / Emerald — entrance & exit ramps
          "line-width": [
            "interpolate", ["exponential", 1.5], ["zoom"],
            8,   1.6,
            12,  4.8,
            16,  12.5,
          ],
          "line-opacity": 1,
        },
      });

      /* The corridor itself, both carriageways.
         Drawn before the jam fragments so those sit on top of it. Waze only
         reports congestion, so a segment with no jam is flowing rather than
         unknown — level 0 is therefore green, not grey. A casing line underneath
         gives each ribbon an edge so the two directions stay distinct where they
         run close together. */
      map.addLayer({
        id: "carriageway-casing",
        type: "line",
        source: "traffic",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 6, 12, 11, 16, 16],
          "line-opacity": 0.9,
        },
        filter: ["==", ["get", "feature_type"], "carriageway"],
      });

      map.addLayer({
        id: "carriageway",
        type: "line",
        source: "traffic",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          // Same levels and hues the legend lists.
          "line-color": [
            "match",
            ["get", "level"],
            0, "#10b981",  // no jam reported — flowing
            1, "#10b981",
            2, "#f59e0b",
            3, "#f97316",
            4, "#ef4444",
            5, "#b91c1c",
            "#10b981",
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3.5, 12, 7, 16, 11],
          "line-opacity": 0.95,
        },
        filter: ["==", ["get", "feature_type"], "carriageway"],
      });

      /* Direction of travel, as arrows riding the ribbon. Northbound and
         southbound are offset to opposite sides, so the arrow tells the reader
         which side is which without a second legend. */
      map.addLayer({
        id: "carriageway-arrows",
        type: "symbol",
        source: "traffic",
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 90,
          "text-field": ["case", ["==", ["get", "direction"], "NB"], "\u25B2", "\u25BC"],
          "text-size": 11,
          "text-allow-overlap": false,
          "text-keep-upright": false,
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "rgba(0,0,0,0.35)",
          "text-halo-width": 1,
        },
        filter: ["==", ["get", "feature_type"], "carriageway"],
      });

      // Layer 3: Jam Lines Layer (Overlays on top for realtime)
      map.addLayer({
        id: "traffic-line",
        type: "line",
        source: "traffic",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": [
            "match",
            ["get", "level"],
            1, "#10b981", // Light (Green)
            2, "#f59e0b", // Moderate (Yellow/Orange)
            3, "#f97316", // Heavy (Orange)
            4, "#ef4444", // Severe (Red)
            5, "#b91c1c", // Standstill (Dark Red)
            "#10b981"    // Fallback (Green)
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
        filter: ["==", ["get", "feature_type"], "jam"],
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
          <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; padding: 10px; width: 220px; border-radius: 12px; background: var(--bg-surface); box-shadow: 0 4px 20px rgba(0,0,0,0.18); color: var(--text-primary);">
            <div style="font-weight: 700; font-size: 13px; text-transform: uppercase; display: flex; align-items: center; gap: 6px; color: ${props.type === "ACCIDENT" ? "#b91c1c" : props.type === "POLICE" ? "#3b82f6" : props.type === "CONSTRUCTION" ? "#f97316" : "#eab308"
          }; margin-bottom: 4px;">
              <span>${iconEmoji}</span> ${typeLabel}
            </div>
            <div style="font-size: 11px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px;">${props.street || "NLEX"} ${props.city ? `(${props.city})` : ""}</div>
            ${props.report_description ? `<div style="font-size: 11px; color: var(--text-secondary); line-height: 1.4; background: var(--bg-surface-hover); padding: 6px; border-radius: 6px; margin-bottom: 6px;">"${props.report_description}"</div>` : ""}
            <div style="font-size: 10px; color: var(--text-muted); border-top: 1px solid var(--border-default); padding-top: 6px; display: flex; justify-content: space-between;">
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
                <div style="font-size: 11px; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px;">${toll.location}</div>
                <div style="display: inline-block; font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: #ecfeff; color: #0e7490; margin-bottom: 6px; letter-spacing: 0.3px;">${toll.type}</div>
                <div style="font-size: 11px; color: var(--text-secondary); line-height: 1.4; background: var(--bg-surface-hover); padding: 8px; border-radius: 6px; margin-bottom: 6px; font-weight: 500;">
                  ${toll.description}
                </div>
                <div style="font-size: 10px; color: #0891b2; border-top: 1px solid #e2e8f0; padding-top: 6px;">
                  <strong>Toll System:</strong> <span style="color: var(--text-secondary);">${toll.rates}</span>
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
              <div style="font-size: 11px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px;">${props.street || "NLEX Corridor"} ${props.city ? `(${props.city})` : ""}</div>
              <div style="font-size: 11px; color: var(--text-secondary); line-height: 1.5; border-top: 1px solid var(--border-default); padding-top: 6px;">
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
              <div style="font-size: 11px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px;">Segment: ${props.segment_id || "NLEX"}</div>
              <div style="font-size: 11px; color: var(--text-secondary); line-height: 1.5; border-top: 1px solid var(--border-default); padding-top: 6px;">
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
      const renderAlerts = (geojson: GeoJSON.FeatureCollection | Record<string, unknown>) => {
        // Clear old alert markers
        alertMarkersRef.current.forEach((m) => m.remove());
        alertMarkersRef.current = [];

        if (!geojson || !("features" in geojson) || !Array.isArray(geojson.features)) return;
        
        geojson.features.forEach((feature: GeoJSON.Feature) => {
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
              <div style="font-size: 11px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px;">${props.street || "NLEX"} ${props.city ? `(${props.city})` : ""}</div>
              ${props.report_description ? `<div style="font-size: 12px; line-height: 1.4; color: var(--text-secondary); margin-bottom: 8px;">"${props.report_description}"</div>` : ""}
              <div style="display: flex; gap: 12px; font-size: 10px; color: #64748b; font-weight: 500;">
                <div>Reliability: ${props.reliability || 0}/10</div>
                <div>Confidence: ${props.confidence || 0}/10</div>
              </div>
            </div>
          `);

          const marker = new mapboxgl.Marker({ element: el, anchor: "center" })
            .setLngLat(coords as [number, number])
            .setPopup(popup)
            .addTo(map);
            
          alertMarkersRef.current.push(marker);
        });
      };
      
      if (isRealtime) {
        renderAlerts(data);
      }

      const source = map.getSource("traffic") as GeoJSONSource;
      const _pollingInterval = setInterval(async () => {
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

      if (flyToHandlerRef.current) {
        window.removeEventListener("nlex:flyto", flyToHandlerRef.current);
        flyToHandlerRef.current = null;
      }
      if (resetViewHandlerRef.current) {
        window.removeEventListener("nlex:resetview", resetViewHandlerRef.current);
        resetViewHandlerRef.current = null;
      }
      map.remove();
      mapRef.current = null;
    };
  }, [endpoint, layerColor]);

  return (
    <article className={`map-card${chromeless ? " chromeless" : ""}`}>
      {/* The maximised view supplies its own header, so the panel's is dropped
          there rather than stacking two title bars. */}
      {!chromeless && (
        <header className={`map-head ${tone}`}>
          <div>
            <h3>{title}</h3>
            <p>{subtitle}</p>
          </div>
          <span>{badge}</span>
        </header>
      )}
      <div className="map-canvas-container">
        <div className="map-canvas mapbox" ref={containerRef} />
        {status !== "ok" && (
          <div className="map-fallback">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 20 3 17V4l6 3 6-3 6 3v13l-6-3-6 3Z" />
              <path d="M9 7v13M15 4v13" />
            </svg>
            {status === "no-token" ? (
              <>
                <p className="map-fallback-title">Map unavailable</p>
                <p className="map-fallback-body">
                  No Mapbox token is set. Put your token (it starts with <code>pk.</code>) in{" "}
                  <code>NEXT_PUBLIC_MAPBOX_TOKEN</code> inside{" "}
                  <code>Front-End-Dashboard/.env.local</code>, then restart the dev server. The
                  committed <code>.env</code> ships a placeholder, which does not count as a token.
                </p>
              </>
            ) : (
              <>
                <p className="map-fallback-title">Map token rejected</p>
                <p className="map-fallback-body">
                  Mapbox refused the token. It may be revoked, from another account, or restricted
                  to URLs that do not include this one. Check the browser console for the exact
                  error.
                </p>
              </>
            )}
          </div>
        )}
        {children}
      </div>
    </article>
  );
}


