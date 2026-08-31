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
import { lookOf } from "../../lib/waze-report-look";

type Props = {
  title: string;
  subtitle: string;
  badge?: React.ReactNode;
  /** Hides the panel's own header — used when a parent supplies one. */
  chromeless?: boolean;
  /** Stops the flow animation while the panel is covered, e.g. by the
      maximised view. The map stays mounted so reopening is instant. */
  paused?: boolean;
  endpoint: string;
  layerColor: string;
  tone: "blue" | "purple";
  children?: React.ReactNode;
};

/**
 * Everything the report detail panel shows. Mirrors the alert properties the
 * live endpoint now emits — every field comes straight from Waze's own payload,
 * so a null here means Waze did not report it rather than that we lost it.
 */
type ReportDetail = {
  type: string;
  subtype: string | null;
  street: string | null;
  city: string | null;
  nearest_exit: string | null;
  exit_distance_m: number | null;
  reliability: number | null;
  confidence: number | null;
  report_rating: number | null;
  road_type: number | null;
  by_municipality: boolean | null;
  heading: number | null;
  reported_at: string | null;
  uuid: string | null;
  lon: number | null;
  lat: number | null;
};

/** Waze roadType codes, only the ones this corridor's feed actually emits. */
const ROAD_TYPE_LABEL: Record<number, string> = {
  1: "Street", 2: "Primary street", 3: "Freeway", 4: "Ramp", 6: "Major highway",
  7: "Minor highway", 17: "Private road", 20: "Parking lot road",
};

/** Compass point for Waze's magvar, which is degrees clockwise from north. */
const headingLabel = (deg: number) => {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return `${points[Math.round(((deg % 360) / 22.5)) % 16]} (${deg}°)`;
};

const sinceLabel = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m ago`;
  return `${Math.floor(h / 24)}d ${h % 24}h ago`;
};

export default function TrafficMapPanel({ title, subtitle, badge, endpoint, layerColor, tone, children, chromeless = false, paused = false }: Props) {
  // Reuses the charts' theme hook, so the map switches with everything else.
  const { isDark } = useChartTheme();
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeMarkers = useRef<mapboxgl.Marker[]>([]);
  const alertMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const flyToHandlerRef = useRef<((e: Event) => void) | null>(null);
  const resetViewHandlerRef = useRef<(() => void) | null>(null);
  const showReportHandlerRef = useRef<((e: Event) => void) | null>(null);
  const flowFrameRef = useRef<number | null>(null);
  /* Read inside the animation frame rather than closed over, so pausing does
     not have to tear the map down and rebuild it. */
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
    // The flow images keep themselves animating by requesting repaints. Paused,
    // they stop asking and the map goes idle, so coming back needs one nudge.
    if (!paused) mapRef.current?.triggerRepaint();
  }, [paused]);
  // "ok" once the map builds; otherwise show a graceful fallback instead of
  // letting Mapbox throw and take the whole page down.
  const [status, setStatus] = useState<"ok" | "no-token" | "error">("ok");
  // The report a reader clicked, or null when the panel is closed. Held here
  // rather than in a Mapbox popup because a popup is anchored to the pin and
  // scrolls off with it; a panel stays put and has room for the full record.
  const [selectedReport, setSelectedReport] = useState<ReportDetail | null>(null);

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

    const PALETTE = mapPalette(isDark);

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
      "interpolate", ["exponential", 2], ["zoom"],
      /* Offset is in screen pixels, and a pixel covers 151230 / 2^zoom metres
         at this latitude — 37 m at z12, 2.3 m at z16 — so a fixed pixel offset
         means a wildly varying real one. Above z15 that matters and the
         exponential-2 curve cancels it: the metres a pixel covers halve with
         each zoom step while the interpolation doubles, holding roughly 15 m
         either side of the centreline, which is about NLEX's separation.

         Below z15 it cannot be honoured. Two ribbons 15 m apart are a fifth of
         a pixel at z12, so drawing them faithfully would merge them into one
         line — and an offset smaller than half the line width makes them
         overlap into a single band with no roadbed showing between, which is
         exactly what a 2 px floor did here. The floor is therefore set by the
         drawing, not the geography: 7 px against a 9 px ribbon leaves 5 px of
         casing visible down the middle. At that zoom the pair still sits well
         inside the road's own drawn width, so it reads as a divided highway
         rather than as two roads. */
      9, side(7),
      15, side(7),
      18, side(24),
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
    /* The Current alerts list asks for a report by dispatching this. The map
       owns both the camera and the detail panel, so the sidebar hands over the
       record it already has rather than the two components trying to share
       state — same pattern as nlex:flyto above. */
    const onShowReport = (e: Event) => {
      const d = (e as CustomEvent<ReportDetail>).detail;
      if (!d) return;
      setSelectedReport(d);
      if (d.lon != null && d.lat != null && Number.isFinite(d.lon) && Number.isFinite(d.lat)) {
        map.flyTo({ center: [d.lon, d.lat], zoom: 13, duration: 900 });
      }
    };

    window.addEventListener("nlex:flyto", onFlyTo);
    window.addEventListener("nlex:resetview", onResetView);
    window.addEventListener("nlex:showreport", onShowReport);
    flyToHandlerRef.current = onFlyTo;
    resetViewHandlerRef.current = onResetView;
    showReportHandlerRef.current = onShowReport;

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

    /* map.on("load") is asynchronous, so a theme switch or an unmount can tear
       the effect down before it fires. Everything started in there — the
       animation frame and the poll — has to check this, or it runs on a map
       that has already been removed. Each toggle used to leave another rAF loop
       and another 15-second poll behind, all of them writing dash values to the
       same six layers, which is what made the flow stutter and jump. */
    let disposed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

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
      /* Traffic changes far more slowly than the fifteen-second poll. Handing
         Mapbox an identical FeatureCollection still costs a full re-tessellation
         of 38 offset ribbons and the six pattern layers over them, which lands
         as a hitch in the animation on a fifteen-second beat — the thing that
         reads as the flow stuttering. So the corridor and the feed are only
         pushed when something they show actually differs. */
      const signature = (fc: GeoJSON.FeatureCollection) =>
        (fc.features ?? [])
          .map((f) => {
            const q = f.properties as Record<string, unknown> | null;
            return `${q?.feature_type ?? ""}:${q?.segment_order ?? q?.uuid ?? ""}:${q?.direction ?? ""}:${q?.level ?? ""}`;
          })
          .join("|");

      let lastCorridorSig = "";
      let lastFeedSig = "";

      const corridorAtLoad = corridorWithState(data);
      lastCorridorSig = signature(corridorAtLoad);
      lastFeedSig = signature(data);
      map.addSource("nlex-corridor", {
        type: "geojson",
        data: corridorAtLoad,
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
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 8, 12, 15, 16, 17, 18, 28],
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
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 5, 12, 9, 16, 11, 18, 18],
          "line-opacity": 1,
          "line-offset": OFFSET,
        },
      });

      /* Flow. A pale pulse travelling along each ribbon, so the corridor reads
         as moving traffic rather than a static coloured band.

         Drawn with a scrolling line-pattern rather than an animated
         line-dasharray. Dashes cannot loop smoothly: with a pattern
         [lead, gap, rest] of constant period, the lit block slides by
         (period - gap) and then jumps back by the gap. Here that was a 4-unit
         jump in a 7-unit period, so the light crawled forward and snapped back
         57% of the way, every cycle, on every ribbon. That snap is what read as
         glitching, and it cannot be tuned out — the jump *is* the gap, so it
         only shrinks by making the line almost solid, at which point there is
         no dash left to travel.

         A pattern image has no such seam. The pulse fades to nothing at both
         edges of the image, so however far it is scrolled the tiles still meet
         at zero and the motion is continuous. Scrolling is done by rewriting
         the image, which is 2 KB, rather than by re-evaluating a paint property
         on six layers.

         Six images: two carriageways x three speed tiers. Two carriageways
         because the pulse has to travel north on one and south on the other.
         Three tiers because the speed is the message — a free stretch races and
         a standstill crawls, so the eye reads rate the way it reads colour. */
      const FLOW_TIERS = [
        { id: "fast", levels: [0, 1], cycleMs: 1100, opacity: 0.55 },
        { id: "mid",  levels: [2, 3], cycleMs: 2600, opacity: 0.5 },
        { id: "slow", levels: [4, 5], cycleMs: 6000, opacity: 0.45 },
      ] as const;

      const PW = 32;   // pattern length in texels; repeat is scaled to line width
      const PH = 8;

      const rgb = ((hex: string) => {
        const h = hex.replace("#", "");
        const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
        return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
      })(PALETTE.arrow.startsWith("#") ? PALETTE.arrow : "#ffffff");

      /* A soft band that reaches zero well before the edges of the image, which
         is what makes the tiling seam invisible at any scroll offset. */
      const pulse = (u: number) => {
        const w = ((u % 1) + 1) % 1;
        const d = Math.abs(w - 0.5);
        const k = Math.max(0, 1 - d / 0.22);
        return k * k * (3 - 2 * k);   // smoothstep, so it has no hard shoulders
      };

      /* Written into an existing buffer rather than allocating one, because
         this runs on every animated frame for every ribbon. */
      const writePulse = (data: Uint8Array, phase: number, opacity: number) => {
        for (let x = 0; x < PW; x++) {
          const a = Math.round(pulse(x / PW + phase) * opacity * 255);
          for (let y = 0; y < PH; y++) {
            const i = (y * PW + x) * 4;
            data[i] = rgb[0];
            data[i + 1] = rgb[1];
            data[i + 2] = rgb[2];
            data[i + 3] = a;
          }
        }
      };

      const flowImageId = (dir: string, tier: string) => `flow-${dir.toLowerCase()}-${tier}`;

      for (const dir of ["NB", "SB"] as const) {
        for (const tier of FLOW_TIERS) {
          const id = flowImageId(dir, tier.id);

          /* An animated StyleImage, which is how Mapbox actually drives a
             moving pattern: it calls render() once per frame for every image a
             visible layer is using, and repaints when render() returns true.

             Rewriting the bytes with map.updateImage() from our own animation
             frame did nothing at all — the data changed but nothing asked the
             map to redraw, so the pulses sat frozen on the ribbons. Owning the
             clock here also means Mapbox skips the work when no layer is using
             the image, which is most of them for most of the day: almost every
             segment sits at level 0, so the mid and slow images back nothing. */
          const sign = dir === "NB" ? -1 : 1;
          const data = new Uint8Array(PW * PH * 4);
          writePulse(data, 0, tier.opacity);
          let lastWrite = 0;

          const image = {
            width: PW,
            height: PH,
            data,
            render() {
              // Behind the maximised view there is nothing to see. Returning
              // without asking for another frame lets the map go idle; the
              // paused effect below kicks it again on the way back.
              if (pausedRef.current) return false;

              /* render() only runs as part of a repaint, so an animated image
                 has to ask for the next one or the map settles and never calls
                 it again. This is why the pulses sat frozen: the bytes were
                 being rewritten, but nothing was drawing them. */
              map.triggerRepaint();

              const now = performance.now();
              // 30fps is indistinguishable here and halves the texture uploads.
              // Returning false only says the pixels are unchanged; the repaint
              // above keeps the loop alive.
              if (now - lastWrite < 33) return false;
              lastWrite = now;
              writePulse(data, sign * ((now % tier.cycleMs) / tier.cycleMs), tier.opacity);
              return true;
            },
          };

          if (!map.hasImage(id)) {
            map.addImage(id, image as unknown as Parameters<typeof map.addImage>[1]);
          }

          map.addLayer({
            id: `carriageway-flow-${dir.toLowerCase()}-${tier.id}`,
            type: "line",
            source: "nlex-corridor",
            layout: { "line-join": "round", "line-cap": "butt" },
            // NO_READING (-1) matches no tier, so an unreported stretch stays
            // still rather than claiming a flow nothing measured.
            filter: [
              "all",
              ["==", ["get", "direction"], dir],
              ["in", ["get", "level"], ["literal", tier.levels]],
            ],
            paint: {
              "line-pattern": id,
              "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 12, 4.5, 16, 5.5, 18, 9],
              "line-offset": OFFSET,
            },
          });
        }
      }

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

      /* The jam overlay and the alert circle layer are both gone.

         Waze's jam lines were drawn over the corridor as separate coloured
         fragments with their own hover card. They were the loose lines lying
         beside and across the road: the same congestion the ribbon already
         shows, drawn a second time from geometry that is not quite the
         corridor's, so the two disagreed wherever they overlapped. The ribbon's
         colour is derived from exactly these jams -- filtered to the corridor,
         snapped onto it, and given the direction Waze names -- so dropping the
         overlay loses no information. It leaves one statement about congestion
         rather than two competing ones.

         The circle layer under the reports went with it. Reports are drawn as
         HTML markers further down, which carry the icons and the click-through,
         so every report had a plain dot sitting under its own pin. */

      /* The plaza hover card. Offset and anchored below the pin so the card
         opens clear of it — it used to open centred on the marker, so the pin
         and its label sat on top of the card and covered the location line. */
      const popup = new mapboxgl.Popup({
        closeButton: false,
        closeOnClick: false,
        // Offset only: letting Mapbox choose the side means the card flips
        // rather than running off the top of the panel near Sta. Ines.
        offset: 20,
      });

      // Point Hover


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

        /* Kept so the pins can be thinned out when they overlap; see
           declutterPlazas below. */
        const plazaPins: { el: HTMLElement; lngLat: [number, number]; name: string }[] = [];

        tollPlazas.forEach(toll => {
          const el = document.createElement("div");
          el.className = "custom-toll-marker";
          /* No label on the pin. It used to sit under every pin permanently,
             collided into an unreadable stack south of Pulilan, and was moved to
             hover — but hovering also opens the card, which names the plaza
             properly, so the label was a second copy of the name floating over
             the card that had just replaced it. */
          el.innerHTML = `
            <div class="toll-pin">
              <div class="toll-pin-dot">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                     stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 20V9.5a1 1 0 0 1 .55-.9l7-3.5a1 1 0 0 1 .9 0l7 3.5a1 1 0 0 1 .55.9V20" />
                  <path d="M2 20h20M9 20v-5h6v5" />
                </svg>
              </div>
            </div>
          `;

          /* Above the report pins. A report lands on the carriageway, which is
             where the plaza sits, so when the two coincided the report took the
             hover and the plaza underneath could not be reached. */
          el.style.zIndex = "6";

          const marker = new mapboxgl.Marker({ element: el })
            .setLngLat(toll.coordinates as [number, number])
            .addTo(map);

          plazaPins.push({ el, lngLat: toll.coordinates as [number, number], name: toll.shortName });

          el.addEventListener("mouseenter", () => {
            /* No inline chrome: the container is styled in globals.css, so
               this is only content. The road mark replaces an emoji, matching
               the pin the reader just hovered. */
            const description = `
              <div class="nlex-pop" style="--pop-accent:#0e7490">
                <div class="nlex-pop-head">
                  <span class="nlex-pop-mark">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                         stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M4 20V9.5a1 1 0 0 1 .55-.9l7-3.5a1 1 0 0 1 .9 0l7 3.5a1 1 0 0 1 .55.9V20" />
                      <path d="M2 20h20M9 20v-5h6v5" />
                    </svg>
                  </span>
                  <span class="nlex-pop-name">
                    <span class="nlex-pop-title">${toll.name}</span>
                    <span class="nlex-pop-sub">${toll.location}</span>
                  </span>
                </div>
                <div class="nlex-pop-body">
                  <p class="nlex-pop-note">${toll.description}</p>
                </div>
                <div class="nlex-pop-foot">Toll system &middot; ${toll.rates}</div>
              </div>
            `;
            popup.setLngLat(toll.coordinates as [number, number]).setHTML(description).addTo(map);
          });

          el.addEventListener("mouseleave", () => {
            popup.remove();
          });

          activeMarkers.current.push(marker);
        });

        /* Twenty plazas on a corridor this long means several of them land on
           the same few pixels when zoomed out — Bocaue Barrier, Bocaue
           Interchange, Tambubong and CDV/PH Arena sit inside about two
           kilometres. Stacked, they read as one smudge and only the topmost can
           be hovered.

           So the pins are thinned by what is actually on screen rather than by
           a zoom threshold: walking south to north, a pin is kept if it is far
           enough from the last one kept, and hidden otherwise. Zooming in
           spreads them out and the hidden ones come back on their own. Nothing
           is removed from the map — only hidden — so this never changes what
           the corridor contains, just how much of it is legible at once. */
        const PIN_GAP_PX = 26;

        const declutterPlazas = () => {
          const kept: { x: number; y: number }[] = [];
          for (const pin of plazaPins) {
            const q = map.project(pin.lngLat);
            const clash = kept.some(
              (k) => Math.abs(k.x - q.x) < PIN_GAP_PX && Math.abs(k.y - q.y) < PIN_GAP_PX,
            );
            pin.el.style.display = clash ? "none" : "";
            if (!clash) kept.push({ x: q.x, y: q.y });
          }
        };

        declutterPlazas();
        map.on("zoom", declutterPlazas);
        map.on("move", declutterPlazas);
      }

      // Line Hover


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
          /* One title, from the shared look. This printed the label and then
             the raw type beside it — "Hazard on road HAZARD", "Road closed
             ROAD CLOSED" — because the variable holding the label was still
             named after the emoji it replaced and the raw type was never
             dropped from the markup. */
          /* One shared definition of how a report looks — see
             lib/waze-report-look.tsx. This was an if/else chain that knew about
             ACCIDENT, POLICE and CONSTRUCTION and sent everything else to the
             generic hazard pin, so all 7 live ROAD_CLOSED reports drew as
             hazards. */
          const look = lookOf(props.type);
          const color = look.colour;
          const iconSvg = look.svg;

          const el = document.createElement("div");
          el.className = "waze-alert-marker";
          el.style.zIndex = "5";
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
          
          // Hover keeps a one-line identifier; the full record is a click away.
          // Two affordances rather than one: the popup answers "what is this pin"
          // while moving the mouse, the panel answers "tell me everything" only
          // when the reader asks for it.
          /* Where, not just what. The street is the same 76 km road for every
             report on this corridor, so on its own it does not distinguish one
             card from the next; the exit and the distance to it do. Same
             reasoning as the sidebar rows. */
          const exitText = props.nearest_exit
            ? Number.isFinite(Number(props.exit_distance_m))
              ? `${Number(props.exit_distance_m) < 950
                  ? `${Math.round(Number(props.exit_distance_m) / 10) * 10} m`
                  : `${(Number(props.exit_distance_m) / 1000).toFixed(1)} km`} from ${props.nearest_exit}`
              : `near ${props.nearest_exit}`
            : (props.street ?? "On the corridor");

          const popup = new mapboxgl.Popup({ offset: 15, closeButton: false, closeOnClick: false }).setHTML(`
            <div class="nlex-pop" style="--pop-accent:${color}">
              <div class="nlex-pop-head">
                <span class="nlex-pop-mark">${look.svg}</span>
                <span class="nlex-pop-name">
                  <span class="nlex-pop-title">${look.label}</span>
                  <span class="nlex-pop-sub">${exitText}</span>
                </span>
              </div>
              <div class="nlex-pop-foot">Click for the full report</div>
            </div>
          `);

          /* Centred on the report's own position. Bottom-anchoring and lifting
             it put the pin's centre about 20 px above the coordinates Waze gave
             — nearly 200 m at z13 — so reports floated off the road they were
             on. Overlap with the plaza pins is settled by stacking instead:
             plazas sit above reports and stay hoverable. */
          const marker = new mapboxgl.Marker({ element: el, anchor: "center" })
            .setLngLat(coords as [number, number])
            .addTo(map);

          // Hover shows the summary; click opens the detail panel. setPopup is
          // deliberately not used — it binds the popup to click, which would put
          // the summary and the panel on the same gesture.
          el.addEventListener("mouseenter", () => popup.setLngLat(coords as [number, number]).addTo(map));
          el.addEventListener("mouseleave", () => popup.remove());
          el.addEventListener("click", (ev) => {
            // Without this the map's own click handler runs too and closes the
            // panel in the same gesture that opened it.
            ev.stopPropagation();
            popup.remove();
            setSelectedReport({
              type: props.type ?? "ALERT",
              subtype: props.subtype ?? null,
              street: props.street ?? null,
              city: props.city ?? null,
              nearest_exit: props.nearest_exit ?? null,
              exit_distance_m: props.exit_distance_m ?? null,
              reliability: props.reliability ?? null,
              confidence: props.confidence ?? null,
              report_rating: props.report_rating ?? null,
              road_type: props.road_type ?? null,
              by_municipality: props.by_municipality ?? null,
              heading: props.heading ?? null,
              reported_at: props.reported_at ?? null,
              uuid: props.uuid ?? null,
              lon: Array.isArray(coords) ? Number(coords[0]) : null,
              lat: Array.isArray(coords) ? Number(coords[1]) : null,
            });
            map.flyTo({ center: coords as [number, number], zoom: Math.max(map.getZoom(), 12), duration: 600 });
          });

          alertMarkersRef.current.push(marker);
        });
      };
      
      /* Drive the flow dashes.

         The sequence is the standard Mapbox marching-ants set: each step shifts
         the gap along a fixed 4-unit dash, and cycling them makes the dash
         appear to travel. Stepping NB forward and SB backward through the same
         sequence is what makes the two carriageways run opposite ways.

         Each tier keeps its own clock, so the fast ribbon advances roughly
         seven times for every one step of the standstill ribbon. One rAF loop
         drives all of them rather than three timers, and it parks itself when
         the tab is backgrounded instead of animating a map nobody is watching. */
      /* Scrolling the pattern is a texture rewrite, so phase is a continuous
         float and every frame lands exactly where the clock says. Nothing is
         quantised and nothing accumulates, so a dropped frame costs a frame of
         motion rather than putting the ribbons out of step with each other.

         The corridor runs south to north and so does the pattern's x axis, so
         northbound scrolls one way and southbound the other. */

      if (isRealtime) {
        renderAlerts(data);
      }

      const source = map.getSource("traffic") as GeoJSONSource;
      pollTimer = setInterval(async () => {
        if (disposed) return;
        try {
          const fresh = onlyOnCorridor(
            await fetch(endpoint, { cache: "no-store" }).then((r) => r.json()),
          );

          const feedSig = signature(fresh);
          if (feedSig !== lastFeedSig) {
            lastFeedSig = feedSig;
            source.setData(fresh);
            // Markers are torn down and rebuilt, so they only move when the
            // reports do.
            if (isRealtime) renderAlerts(fresh);
          }

          const corridorNow = corridorWithState(fresh);
          const corridorSig = signature(corridorNow);
          if (corridorSig !== lastCorridorSig) {
            lastCorridorSig = corridorSig;
            /* Which tiers are on screen no longer needs tracking here: Mapbox
               calls render() only for images a visible layer is using, so a
               tier with no segments costs nothing on its own. */
            (map.getSource("nlex-corridor") as GeoJSONSource | undefined)?.setData(corridorNow);
          }
        } catch {
          // No-op polling fallback
        }
      }, 15000);
    });

    return () => {
      disposed = true;
      if (pollTimer != null) {
        // Was assigned to an unused local and never cleared, so every rebuild
        // left a live 15-second fetch running against a removed map.
        clearInterval(pollTimer);
        pollTimer = null;
      }
      resizeObserver.disconnect();
      if (flowFrameRef.current != null) {
        cancelAnimationFrame(flowFrameRef.current);
        flowFrameRef.current = null;
      }
      activeMarkers.current.forEach(m => m.remove());
      activeMarkers.current = [];

      if (flyToHandlerRef.current) {
        window.removeEventListener("nlex:flyto", flyToHandlerRef.current);
        flyToHandlerRef.current = null;
      }
      if (showReportHandlerRef.current) {
        window.removeEventListener("nlex:showreport", showReportHandlerRef.current);
        showReportHandlerRef.current = null;
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

        {/* Report detail. Anchored inside the map container so it sits over the
            canvas without leaving the panel, and every row is omitted rather
            than zero-filled when Waze did not report that field. */}
        {selectedReport && (
          <div className="wz-report-detail" role="dialog" aria-label="Waze report detail">
            <header>
              <div>
                <span className="wz-rd-type">{selectedReport.type.replace(/_/g, " ")}</span>
                {selectedReport.subtype && (
                  <span className="wz-rd-sub">{selectedReport.subtype.replace(/_/g, " ").toLowerCase()}</span>
                )}
              </div>
              <button type="button" onClick={() => setSelectedReport(null)} aria-label="Close report detail">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </header>

            <p className="wz-rd-where">
              {selectedReport.street ?? "NLEX"}
              {selectedReport.city ? ` · ${selectedReport.city}` : ""}
            </p>

            {selectedReport.reported_at && (
              <p className="wz-rd-when">
                Reported {sinceLabel(selectedReport.reported_at)}
                <span>{new Date(selectedReport.reported_at).toLocaleString()}</span>
              </p>
            )}

            <dl className="wz-rd-grid">
              {selectedReport.reliability != null && (
                <div><dt>Reliability</dt><dd>{selectedReport.reliability}/10</dd></div>
              )}
              {selectedReport.confidence != null && (
                <div><dt>Confidence</dt><dd>{selectedReport.confidence}/10</dd></div>
              )}
              {selectedReport.report_rating != null && (
                <div><dt>Report rating</dt><dd>{selectedReport.report_rating}/5</dd></div>
              )}
              {selectedReport.nearest_exit && (
                <div>
                  <dt>Nearest exit</dt>
                  <dd>
                    {selectedReport.nearest_exit}
                    {selectedReport.exit_distance_m != null && (
                      <span className="wz-rd-note">
                        {selectedReport.exit_distance_m < 1000
                          ? ` ${selectedReport.exit_distance_m} m away`
                          : ` ${(selectedReport.exit_distance_m / 1000).toFixed(1)} km away`}
                      </span>
                    )}
                  </dd>
                </div>
              )}
              {selectedReport.heading != null && (
                <div><dt>Heading</dt><dd>{headingLabel(selectedReport.heading)}</dd></div>
              )}
              {selectedReport.road_type != null && (
                <div>
                  <dt>Road type</dt>
                  <dd>{ROAD_TYPE_LABEL[selectedReport.road_type] ?? `Type ${selectedReport.road_type}`}</dd>
                </div>
              )}
              {selectedReport.by_municipality != null && (
                <div>
                  <dt>Source</dt>
                  <dd>{selectedReport.by_municipality ? "Municipality account" : "Waze driver"}</dd>
                </div>
              )}
              {selectedReport.lat != null && selectedReport.lon != null && (
                <div>
                  <dt>Coordinates</dt>
                  <dd>{selectedReport.lat.toFixed(5)}, {selectedReport.lon.toFixed(5)}</dd>
                </div>
              )}
            </dl>

            {selectedReport.uuid && <p className="wz-rd-id">Waze ID {selectedReport.uuid}</p>}
          </div>
        )}
      </div>
    </article>
  );
}


