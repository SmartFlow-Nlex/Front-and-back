"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import mapboxgl, { GeoJSONSource } from "mapbox-gl";
import type { Point } from "geojson";
import { useEffect, useRef, useState } from "react";
import nlexGeometry from "./nlex-geometry.json";
import { corridorGuard, sliceCorridor, type LngLat } from "../../lib/corridor-shape";
import { FALLBACK_EXITS } from "../../lib/nlex-exits";
import { useChartTheme } from "../../lib/chart-theme";
import { mapPalette } from "../../lib/map-palette";
import { isReportType } from "../../lib/waze-reports";

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
  // Reuses the charts' theme hook, so the map switches with everything else.
  const { isDark } = useChartTheme();
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeMarkers = useRef<mapboxgl.Marker[]>([]);
  const alertMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const flyToHandlerRef = useRef<((e: Event) => void) | null>(null);
  const resetViewHandlerRef = useRef<(() => void) | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // "ok" once the map builds; otherwise show a graceful fallback instead of
  // letting Mapbox throw and take the whole page down.
  const [status, setStatus] = useState<"ok" | "no-token" | "error">("ok");

  useEffect(() => {
    if (!containerRef.current) return;

    const rawToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim();
    const hasToken = Boolean(rawToken && rawToken.startsWith("pk."));
    const token = hasToken ? rawToken! : "pk.eyJ1Ijoib3BlbiIsImEiOiJvcGVuIn0.open";

    const PALETTE = mapPalette(isDark, hasToken);

    /* Both directions share one centreline and are separated in screen pixels,
       so each ribbon traces the identical real curve and the gap stays
       proportional at every zoom. Northbound takes the positive side, which is
       the side traffic keeps here.

       A "zoom" expression may only appear at the top level of a step or
       interpolate, so the interpolate has to be the outer expression and the
       per-direction case has to sit inside each stop. Nesting it the other way
       round -- one case choosing between two interpolates -- reads naturally
       but fails style validation, and Mapbox throws out of addLayer. That abort
       skipped every layer after it, which is why the corridor rendered as a
       bare band with no colours and no jams on it. */
    const side = (px: number) => [
      "case", ["==", ["get", "direction"], "NB"], px, -px,
    ];
    const OFFSET = [
      "interpolate", ["linear"], ["zoom"],
      8, side(3.6),
      12, side(7),
      16, side(11),
    ] as unknown as mapboxgl.ExpressionSpecification;

    mapboxgl.accessToken = token;
    let map: mapboxgl.Map;
    try {
      map = new mapboxgl.Map({
        container: containerRef.current,
        style: PALETTE.style,
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

    // A syntactically valid but rejected token only shows up here
    map.on("error", (e: { error?: { status?: number; message?: string } }) => {
      const status = e?.error?.status;
      if (hasToken && (status === 401 || status === 403)) {
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

    /* The API reports each segment's state but can only draw it as a straight
       chord between exits, because that is all silver.dim_location stores. The
       real alignment is in nlex-geometry.json, so the two are joined here: the
       feed says WHAT each segment is doing, the local geometry says WHERE it
       runs. Without this the ribbons cut corners across open country. */
    const corridorLine = (nlexGeometry as unknown as { coordinates: LngLat[] }).coordinates;
    const corridorExits = [...FALLBACK_EXITS]
      .sort((a, b) => a.km - b.km)
      .map((e) => [e.longitude, e.latitude] as LngLat);
    const corridorParts = sliceCorridor(corridorLine, corridorExits);

    /* The corridor as its own source: 19 segments x 2 directions, on the real
       alignment, built here rather than taken from the feed.

       It used to be drawn from whatever carriageway features the endpoint
       returned, which meant the Forecast panel -- whose endpoint sends seven
       named chords and no carriageways at all -- drew the corridor as a bare
       grey band with no state on it. The road is a fact about NLEX, not about
       one endpoint's payload, so it is built from geometry the client always
       has and the feed only colours it in. */
    // Shared with the page's stats, so the map and the counters agree on what
    // counts as a report about NLEX. See lib/corridor-shape.ts.
    const isRealtimeEndpoint = endpoint.includes("real-time");

    const guard = corridorGuard(corridorLine, corridorExits);

    /* Keeps only what is on NLEX, then puts each jam onto the corridor itself
       rather than leaving it on the geometry Waze traced. See snap() in
       lib/corridor-shape.ts for why. */
    const onlyOnCorridor = (fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection => {
      const kept = guard.filter(fc);
      return {
        ...kept,
        features: (kept.features ?? [])
          /* Alerts are shown only for the categories the legend names, so the
             map and the Active Reports tile cannot disagree about what a report
             is. ROAD_CLOSED arrives in the feed and is dropped here. */
          .filter((f) => {
            const p = f.properties as { feature_type?: string; type?: unknown } | null;
            return p?.feature_type !== "alert" || isReportType(p?.type);
          })
          .map((f) => {
          const props = f.properties as { feature_type?: string } | null;
          if (props?.feature_type !== "jam" || f.geometry?.type !== "LineString") return f;
          const snapped = guard.snap(
            f.geometry.coordinates as number[][],
            (f.properties as { street?: string })?.street,
          );
          if (!snapped) return f;
          return {
            ...f,
            properties: {
              ...f.properties,
              direction: snapped.direction,
              direction_source: snapped.directionSource,
            },
            geometry: { type: "LineString", coordinates: snapped.coords } as GeoJSON.Geometry,
          };
        }),
      };
    };

    /** Stands in for "the feed said nothing about this stretch". */
    const NO_READING = -1;

    const exitNames = [...FALLBACK_EXITS].sort((x, y) => x.km - y.km).map((e) => e.exit_name);

    const corridorBase: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: corridorParts.flatMap((coords, i) =>
        (["NB", "SB"] as const).map((direction) => ({
          type: "Feature" as const,
          properties: {
            segment_order: i + 1,
            direction,
            segment_name: exitNames[i] + " to " + exitNames[i + 1],
            from_exit: exitNames[i],
            to_exit: exitNames[i + 1],
            /* A sentinel rather than null, because Mapbox expressions have no
               null literal — comparing against one fails layer validation and
               throws, which took the whole page down. It is replaced below with
               a real level, or with free-flow where the source can justify it. */
            level: NO_READING,
          },
          geometry: { type: "LineString" as const, coordinates: coords },
        })),
      ),
    };

    /* Which segments a stretch of centreline covers. The parts are joined with
       their shared vertex dropped, so each part after the first advances the
       index by its length minus one. */
    const segmentBounds: { order: number; from: number; to: number }[] = [];
    {
      let at = 0;
      corridorParts.forEach((part, i) => {
        const to = at + part.length - 1;
        segmentBounds.push({ order: i + 1, from: at, to });
        at = to;
      });
    }

    const segmentsSpanned = (from: number, to: number): number[] =>
      segmentBounds.filter((b) => b.to >= from && b.from <= to).map((b) => b.order);

    /** Waze levels for a forecast's categorical state. */
    const FORECAST_LEVEL: Record<string, number> = { Low: 1, Medium: 3, High: 4, Severe: 5 };

    /** Colours the corridor from whichever shape of state the endpoint sends. */
    const corridorWithState = (fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection => {
      const bySegment = new Map<string, number>();

      for (const f of fc.features ?? []) {
        const q = f.properties as Record<string, unknown> | null;
        if (!q) continue;

        /* Live: coloured from the jams actually drawn on the map, not from the
           backend's carriageway levels.

           Those levels came from the backend matching every jam it received to
           the nearest segment, including the ones off the corridor -- a live
           sample had it colouring seven segments using jams on M. Villarica
           Road, Pulilan Regional Road, the Santa Ana-Mexico road and the Tabang
           spur. It also took direction from each jam's bearing, which put the
           level 4 jam on "NLEX N San Fernando Exit" onto the southbound ribbon.
           So the road was painted from reports about other roads, on the wrong
           carriageway, and disagreed with the jams drawn over it.

           Deriving the colour here from the same filtered, snapped, correctly
           directed jams means the ribbon and the jam on it can never tell two
           different stories. */
        if (q.feature_type === "jam" && f.geometry?.type === "LineString") {
          const snapped = guard.snap(
            f.geometry.coordinates as number[][],
            q.street as string | undefined,
          );
          if (!snapped) continue;
          const level = Number(q.level ?? 0);
          for (const order of segmentsSpanned(snapped.startIndex, snapped.endIndex)) {
            const key = order + ":" + snapped.direction;
            // Worst condition wins where two jams overlap a segment.
            bySegment.set(key, Math.max(bySegment.get(key) ?? 0, level));
          }
        }

        // Forecast: named "X to Y", with no direction, so it colours both ways.
        if (q.feature_type === "forecast" && typeof q.corridor_segment === "string") {
          const hit = corridorBase.features.find(
            (c) => (c.properties as { segment_name: string }).segment_name === q.corridor_segment,
          );
          if (hit) {
            const order = (hit.properties as { segment_order: number }).segment_order;
            const lvl = FORECAST_LEVEL[String(q.congestion_state)] ?? 0;
            bySegment.set(order + ":NB", lvl);
            bySegment.set(order + ":SB", lvl);
          }
        }
      }

      /* What silence means depends on the source.

         Waze only publishes congestion, so on the live feed a stretch with no
         jam is a stretch that is moving: free flow, drawn green. The forecast
         is the opposite — it covers seven of nineteen segments, and silence
         there means nobody forecast it, which is not a claim that it will be
         clear. Those stay grey. */
      const unreported = isRealtimeEndpoint ? 0 : NO_READING;

      return {
        ...corridorBase,
        features: corridorBase.features.map((f) => {
          const q = f.properties as { segment_order: number; direction: string };
          const lvl = bySegment.get(q.segment_order + ":" + q.direction);
          return { ...f, properties: { ...f.properties, level: lvl ?? unreported } };
        }),
      };
    };

    map.on("load", async () => {
      const response = await fetch(endpoint, { cache: "no-store" });
      const data = onlyOnCorridor(await response.json());

      const isRealtime = endpoint.includes("real-time");

      map.addSource("traffic", {
        type: "geojson",
        data,
      });

      // The corridor, with whatever state this endpoint could supply.
      map.addSource("nlex-corridor", {
        type: "geojson",
        data: corridorWithState(data),
      });

      /* Push the base map back. A background layer added before ours sits over
         every base layer, so the surrounding road network and labels fade and
         the corridor drawn on top of it becomes the only thing at full
         strength. */
      map.addLayer({
        id: "base-scrim",
        type: "background",
        paint: {
          "background-color": PALETTE.scrim,
          "background-opacity": PALETTE.scrimOpacity,
        },
      });

      /* The corridor, drawn the way a navigation map draws a road: a soft glow
         to lift it off the base, a white casing that reads as the roadway, and
         two coloured ribbons inside it for the two directions.

         The grey road bed and the 39 OSM ramp spurs that used to sit here are
         both gone. The spurs were the stray lines wandering off the corridor --
         18.5 km of on- and off-ramps drawn at near corridor weight, which read
         as breakage rather than as detail. */
      map.addLayer({
        id: "nlex-halo",
        type: "line",
        source: "nlex-corridor",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": PALETTE.halo,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 8, 16, 12, 30, 16, 46],
          "line-opacity": PALETTE.haloOpacity,
          "line-blur": ["interpolate", ["linear"], ["zoom"], 8, 8, 16, 20],
        },
      });

      map.addLayer({
        id: "nlex-casing",
        type: "line",
        source: "nlex-corridor",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": PALETTE.casing,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 8, 12, 15, 16, 23],
          "line-opacity": 1,
          "line-offset": OFFSET,
        },
      });

      map.addLayer({
        id: "carriageway",
        type: "line",
        source: "nlex-corridor",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": [
            "match", ["get", "level"],
            0, PALETTE.level[0],
            1, PALETTE.level[1],
            2, PALETTE.level[2],
            3, PALETTE.level[3],
            4, PALETTE.level[4],
            5, PALETTE.level[5],
            // Falls through for NO_READING. Grey says the feed reported
            // nothing here, rather than implying a free flow it never saw.
            PALETTE.noData,
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 5, 12, 10, 16, 16],
          "line-opacity": 1,
          "line-offset": OFFSET,
        },
      });

      /* Direction of travel. Chevrons rather than triangles: under line
         placement they rotate with the road, so each ribbon reads as flowing
         even where the corridor bends. */
      map.addLayer({
        id: "carriageway-arrows",
        type: "symbol",
        source: "nlex-corridor",
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": ["interpolate", ["linear"], ["zoom"], 8, 34, 14, 60],
          "text-field": "\u276F",
          "text-rotate": ["case", ["==", ["get", "direction"], "NB"], -90, 90],
          "text-size": ["interpolate", ["linear"], ["zoom"], 8, 9, 14, 13],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "text-keep-upright": false,
          "text-offset": [
            "case",
            ["==", ["get", "direction"], "NB"],
            ["literal", [0, 0.5]],
            ["literal", [0, -0.5]],
          ],
        },
        paint: {
          "text-color": PALETTE.arrow,
          "text-opacity": 0.85,
        },
      });

      // Layer 3: Jam Lines Layer (Overlays on top for realtime)
      map.addLayer({
        id: "traffic-glow",
        type: "line",
        source: "traffic",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": [
            "match", ["get", "level"],
            1, PALETTE.level[1], 2, PALETTE.level[2], 3, PALETTE.level[3],
            4, PALETTE.level[4], 5, PALETTE.level[5], PALETTE.level[0],
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 12, 12, 22, 16, 32],
          "line-opacity": isDark ? 0.28 : 0.2,
          "line-offset": OFFSET,
          "line-blur": ["interpolate", ["linear"], ["zoom"], 8, 6, 16, 16],
        },
        filter: ["==", ["get", "feature_type"], "jam"],
      });

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
            1, PALETTE.level[1], // Light
            2, PALETTE.level[2], // Moderate
            3, PALETTE.level[3], // Heavy
            4, PALETTE.level[4], // Severe
            5, PALETTE.level[5], // Standstill
            PALETTE.level[0]     // Fallback
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3.5, 12, 7, 16, 11],
          "line-opacity": 0.95,
          // Same offset as the carriageways, so a jam sits on its own direction
          // instead of straddling both.
          "line-offset": OFFSET,
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
          "circle-color": PALETTE.alert,
          "circle-stroke-color": PALETTE.alertRing,
          "circle-stroke-width": 2.5,
          "circle-opacity": 0.95,
        },
        filter: [
          "all",
          ["==", ["get", "feature_type"], "alert"],
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
          /* The label used to sit under every pin permanently, and twenty of
             them collided into an unreadable stack south of Pulilan. It is
             revealed on hover instead, so the corridor stays legible and the
             name is one pointer-move away. CSS does the showing -- see
             .toll-pin-label in globals.css. */
          el.innerHTML = `
            <div class="toll-pin">
              <div class="toll-pin-dot">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                     stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 20V9.5a1 1 0 0 1 .55-.9l7-3.5a1 1 0 0 1 .9 0l7 3.5a1 1 0 0 1 .55.9V20" />
                  <path d="M2 20h20M9 20v-5h6v5" />
                </svg>
              </div>
              <div class="toll-pin-label">${toll.shortName}</div>
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
      const pollingInterval = setInterval(async () => {
        try {
          const fresh = onlyOnCorridor(
            await fetch(endpoint, { cache: "no-store" }).then((r) => r.json()),
          );
          source.setData(fresh);
          (map.getSource("nlex-corridor") as GeoJSONSource | undefined)?.setData(
            corridorWithState(fresh),
          );
          if (isRealtime) {
            renderAlerts(fresh);
          }
        } catch {
          // No-op polling fallback
        }
      }, 15000);

      pollingRef.current = pollingInterval;
    });

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
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
  }, [endpoint, layerColor, isDark]);

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


