"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import mapboxgl, { GeoJSONSource } from "mapbox-gl";
import type { Point } from "geojson";
import { useEffect, useRef, useState } from "react";
import nlexGeometry from "./nlex-geometry.json";
import {
  corridorGuard, directionFromStreet, directionLabel, sliceCorridor, type LngLat,
} from "../../lib/corridor-shape";
import { corridorSegmentLevels } from "../../lib/corridor-status";
import { FALLBACK_EXITS, accessLabel, displayExitName, plazaLabel } from "../../lib/nlex-exits";
import { makePredictedQueues, shownForecastState } from "../../lib/predicted-queues";
import { useChartTheme } from "../../lib/chart-theme";
import { mapPalette } from "../../lib/map-palette";
import { isDisputedReport, isReportType, isUnconfirmedReport } from "../../lib/waze-reports";
import { lookOf } from "../../lib/waze-report-look";
import nlexRamps from "./nlex-ramps.json";
import { fmtKm } from "../../lib/km-post";
import { nearExitsText } from "../../lib/exit-lookup";
import { corridorKm } from "./corridor-km";
import { useActiveClosures, type Closure } from "./useActiveClosures";
import {
  FLOW_BANDS, STATIC_DASH, addNightCorridorImages, buildSnapshot, carriagewayShift, createJamCallouts,
  dashAt, dashPhase, type CorridorSnapshot, type StripAlert,
} from "./livemap-graphics";

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
  /* Night Corridor additions (REDESIGN_PROMPT.md 5c), all presentational. */
  /** Tilts the camera to about 50 degrees ("3D"); 2D north-up otherwise. */
  pitched?: boolean;
  /** A km post (and carriageway) to mark, from the corridor strip's hover. */
  highlight?: { km: number; dir: "NB" | "SB" | null } | null;
  /** Hands the corridor strip what this map is drawing, whenever it changes. */
  onSnapshot?: (s: CorridorSnapshot) => void;
  /** The km post under the pointer, so the strip can mark the same spot. */
  onHoverKm?: (h: { km: number; dir: "NB" | "SB" } | null) => void;
  /** The exit picked in the header: its pin is marked, and on the forecast
      map its segment carries the clock badge. */
  selectedExit?: string;
};

/* Major interchanges, for the exit names shown at corridor zoom: the two
   termini plus every interchange with two or more ramp spurs in
   nlex-ramps.json. All twenty are named once the map is zoomed in. */
export const MAJOR_EXITS: Set<string> = (() => {
  const count = new Map<string, number>();
  for (const f of (nlexRamps as unknown as { features: { properties: { interchange: string } }[] }).features) {
    // "Balagtas / Tabang" names two exits; "Cdv/Ph Arena" is one name with a slash in it.
    for (const part of f.properties.interchange.split(" / ")) {
      const k = part.trim().toLowerCase();
      if (k) count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const sorted = [...FALLBACK_EXITS].sort((a, b) => a.km - b.km);
  const out = new Set<string>([sorted[0].exit_name.toLowerCase(), sorted[sorted.length - 1].exit_name.toLowerCase()]);
  for (const e of FALLBACK_EXITS) {
    const name = e.exit_name.toLowerCase();
    let n = count.get(name) ?? 0;
    // "Tabang" in the ramps file is the exit stored as "Tabang Guiguinto".
    if (!n) for (const [k, v] of count) if (name.startsWith(k + " ")) n += v;
    if (n >= 2) out.add(name);
  }
  return out;
})();

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
  first_report_at: string | null;
  reports_here: number | null;
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

/* Where a queue begins, relative to the toll plazas either side of it.

   "Starts 340 m from San Simon" was true and not much use: it never said
   which side, so the reader could not tell whether the queue is on the
   approach to the plaza or already past it -- which is the difference
   between joining the back of it before the toll and meeting it after.

   Measured against the exits by latitude. The corridor runs
   north-north-west for its whole length and the twenty exits are strictly
   increasing in latitude with km-post, checked, so latitude orders the
   corridor exactly and needs no projection.

   A and B are named in TRAVEL order: A is the plaza this traffic has
   already passed, B the one it is coming to. That is what lets the words
   be "past" and "before" rather than "north of" and "south of", which a
   driver would have to translate. */
const CORRIDOR_BY_KM = [...FALLBACK_EXITS].sort((a, b) => a.km - b.km);
const M_LON_C = 111320 * Math.cos((15 * Math.PI) / 180);
const M_LAT_C = 110574;
const groundM = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * M_LON_C, (a[1] - b[1]) * M_LAT_C);

type QueueWhere = {
  rel_kind: "at" | "past" | "before" | "between";
  rel_a: string | null;
  rel_b: string | null;
  rel_m: number | null;
  /* The km post where the queue begins, so the card can name the marker a
     driver would actually pass. Interpolated between the two plazas either
     side by how far the point is from each: km differences along this
     corridor ARE distances, so the split is the same in both units. */
  rel_km: number | null;
};

/* Which way a REPORT is facing.

   A report is a point, so there is no line to take a bearing from. Waze
   sends two clues and they mostly agree: the carriageway in the street name
   ("E1: North Luzon Expressway S") and magvar, the reporter's own heading.
   Checked over four hundred snapshots, they agree on 98 of the 104 reports
   where the street says anything at all -- 50 southbound, 48 northbound --
   and disagree on 6.

   The street wins those six, for the same reason it wins for jams: it names
   the carriageway the report is ON, where magvar is where one driver
   happened to be pointing, which a stop or a turn can spoil. Another 22
   reports had no direction in the street at all, and for those the heading
   is the only thing there is.

   The corridor runs north-north-west, so a northbound driver is heading
   about 340 degrees: anything within ninety degrees of that is northbound,
   the rest southbound. */
const directionOfReport = (
  street: unknown,
  heading: unknown,
): { dir: "NB" | "SB" | null; source: "street" | "heading" | null } => {
  const named = directionFromStreet(typeof street === "string" ? street : null);
  if (named) return { dir: named, source: "street" };
  const h = heading == null ? null : Number(heading);
  if (h == null || !Number.isFinite(h)) return { dir: null, source: null };
  const north = ((h % 360) + 360) % 360;
  return { dir: north >= 250 || north <= 70 ? "NB" : "SB", source: "heading" };
};

const queueWhere = (upstream: [number, number], dir: "NB" | "SB"): QueueWhere | null => {
  if (CORRIDOR_BY_KM.length < 2) return null;
  const lat = upstream[1];
  // The pair of exits this point sits between, south first.
  let i = 0;
  while (i < CORRIDOR_BY_KM.length - 2 && CORRIDOR_BY_KM[i + 1].latitude <= lat) i++;
  const south = CORRIDOR_BY_KM[i];
  const north = CORRIDOR_BY_KM[i + 1];

  // Travel order: northbound passes the southern one first.
  const behind = dir === "NB" ? south : north;
  const ahead = dir === "NB" ? north : south;
  const dBehind = groundM(upstream, [behind.longitude, behind.latitude]);
  const dAhead = groundM(upstream, [ahead.longitude, ahead.latitude]);

  const dSouth = groundM(upstream, [south.longitude, south.latitude]);
  const dNorth = groundM(upstream, [north.longitude, north.latitude]);
  const along = dSouth + dNorth;
  const rel_km = along > 0 ? south.km + (north.km - south.km) * (dSouth / along) : south.km;

  const nearest = dBehind <= dAhead ? behind : ahead;
  const nearestM = Math.min(dBehind, dAhead);
  /* Close enough to call it the plaza itself.

     This was 250 m, on the reasoning that an interchange is a few hundred
     metres of ramps. Too generous: it swallowed the very distinction the
     line exists to draw. A southbound queue at Bocaue began 214 m north of
     the plaza -- two hundred metres of stopped traffic that a driver meets
     BEFORE the toll -- and the card called it "at Bocaue Interchange",
     which tells that driver nothing about where to expect it.

     Eighty metres is about the toll booths themselves, so "at" now means
     at, and anything beyond gets the side it is on. */
  if (nearestM < 80) {
    return { rel_kind: "at", rel_a: nearest.exit_name, rel_b: null, rel_m: null, rel_km };
  }
  /* Neither end of the stretch is close: the queue begins out in the
     middle of it, and naming one plaza would put it nearer that plaza than
     it is. */
  const span = dBehind + dAhead;
  const frac = span > 0 ? dBehind / span : 0.5;
  if (frac > 0.33 && frac < 0.67) {
    return { rel_kind: "between", rel_a: behind.exit_name, rel_b: ahead.exit_name, rel_m: null, rel_km };
  }
  return dBehind < dAhead
    ? { rel_kind: "past", rel_a: behind.exit_name, rel_b: null, rel_m: Math.round(dBehind), rel_km }
    : { rel_kind: "before", rel_a: ahead.exit_name, rel_b: null, rel_m: Math.round(dAhead), rel_km };
};

/** Metres, or kilometres once that reads better. Matches the queue card. */
const fmtM = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

const sinceLabel = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m ago`;
  return `${Math.floor(h / 24)}d ${h % 24}h ago`;
};

/** A report's full record, for the strip's icons: the same fields the pin's click hands the detail panel. */
const reportDetailOf = (props: Record<string, unknown>, coords: [number, number]): ReportDetail => {
  const v = <T,>(k: string) => (props[k] ?? null) as T | null;
  return {
    type: String(props.type ?? "ALERT"),
    subtype: v<string>("subtype"),
    street: v<string>("street"),
    city: v<string>("city"),
    nearest_exit: v<string>("nearest_exit"),
    exit_distance_m: v<number>("exit_distance_m"),
    reliability: v<number>("reliability"),
    confidence: v<number>("confidence"),
    report_rating: v<number>("report_rating"),
    road_type: v<number>("road_type"),
    by_municipality: v<boolean>("by_municipality"),
    heading: v<number>("heading"),
    reported_at: v<string>("reported_at"),
    first_report_at: v<string>("first_report_at"),
    reports_here: v<number>("reports_here"),
    uuid: v<string>("uuid"),
    lon: Number(coords[0]),
    lat: Number(coords[1]),
  };
};

export default function TrafficMapPanel({
  title, subtitle, badge, endpoint, layerColor, tone, children, chromeless = false, paused = false,
  pitched = false, highlight = null, onSnapshot, onHoverKm, selectedExit,
}: Props) {
  // Reuses the charts' theme hook, so the map switches with everything else.
  const { isDark } = useChartTheme();
  /* Night Corridor: handles the map effect sets up, so the props below can
     reach a map that is built once per endpoint/theme without rebuilding it. */
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const onHoverKmRef = useRef(onHoverKm);
  onHoverKmRef.current = onHoverKm;
  const pitchedRef = useRef(pitched);
  pitchedRef.current = pitched;
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const selectedExitRef = useRef(selectedExit);
  selectedExitRef.current = selectedExit;
  const closures = useActiveClosures();
  const closuresRef = useRef<Closure[] | null>(closures);
  closuresRef.current = closures;
  const reducedRef = useRef(false);
  const visibleRef = useRef(true);
  const kickRef = useRef<(() => void) | null>(null);
  const applyPitchRef = useRef<((on: boolean) => void) | null>(null);
  const applyHighlightRef = useRef<((h: Props["highlight"]) => void) | null>(null);
  const applyClosuresRef = useRef<((c: Closure[] | null) => void) | null>(null);
  const applyExitRef = useRef<((name: string | undefined) => void) | null>(null);
  useEffect(() => { kickRef.current?.(); }, [paused]);
  useEffect(() => { applyPitchRef.current?.(pitched); }, [pitched]);
  useEffect(() => { applyHighlightRef.current?.(highlight); }, [highlight]);
  useEffect(() => { applyClosuresRef.current?.(closures); }, [closures]);
  useEffect(() => { applyExitRef.current?.(selectedExit); }, [selectedExit]);
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
        /* Dark basemap only: its labels are drawn locally in the interface
           face rather than fetched from CARTO's glyph server, which does not
           serve every font the style names (each miss was a console error). */
        ...(isDark ? { localFontFamily: getComputedStyle(document.body).fontFamily || "sans-serif" } : {}),
      });
    } catch (err) {
      console.error("Mapbox failed to initialize:", err);
      setStatus("error");
      return;
    }

    setStatus("ok");
    mapRef.current = map;

    /* A handle for debugging, in development only.
       Layer problems on this map are invisible from the outside: a filter that
       matches nothing and a layer that was never added look identical in a
       screenshot, and neither prints anything. Being able to ask the live style
       what it is holding turns that into one question. */
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as Record<string, unknown>).__nlexMaps ??= {};
      ((window as unknown as Record<string, Record<string, unknown>>).__nlexMaps)[
        endpoint.includes("real-time") ? "live" : "forecast"
      ] = map;
    }

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
    /* The basemap's attribution, always visible: the dark style is CARTO's
       free Dark Matter, whose terms ask for "© CARTO, © OpenStreetMap
       contributors" on the map; the light Mapbox style names its own. */
    map.addControl(new mapboxgl.AttributionControl({ compact: false }), "bottom-right");

    /* Motion is decoration here, so it stops for readers who ask for less of
       it, and whenever nobody can see the map (scrolled away, or another tab). */
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedRef.current = motionQuery.matches;
    const onMotionPref = () => {
      reducedRef.current = motionQuery.matches;
      applyMotionRef?.();
      kickRef.current?.();
      map.triggerRepaint();
    };
    motionQuery.addEventListener("change", onMotionPref);
    let applyMotionRef: (() => void) | null = null;
    const io = new IntersectionObserver((entries) => {
      const seen = entries.some((en) => en.isIntersecting);
      visibleRef.current = seen;
      if (seen) {
        map.triggerRepaint();
        kickRef.current?.();
      }
    });
    io.observe(containerRef.current);
    const onVisibility = () => kickRef.current?.();
    document.addEventListener("visibilitychange", onVisibility);

    // The header's exit search broadcasts a pick; both panels fly to it together
    // so the two maps stay on the same place for comparison.
    const onFlyTo = (e: Event) => {
      const d = (e as CustomEvent<{ lng: number; lat: number; zoom?: number }>).detail;
      if (!d || !Number.isFinite(d.lng) || !Number.isFinite(d.lat)) return;
      map.flyTo({ center: [d.lng, d.lat], zoom: d.zoom ?? 12.5, duration: 900 });
    };
    // "Whole corridor" returns both panels to the opening view.
    const onResetView = () => {
      map.flyTo({ center: [120.79, 14.94], zoom: 9.2, duration: 900 });
    };
    /* The Current alerts list asks for a report by dispatching this. The map
       owns both the camera and the detail panel, so the sidebar hands over the
       record it already has rather than the two components trying to share
       state — same pattern as nlex:flyto above.

       The camera moves on BOTH panels and the detail panel opens on only one.
       This component is mounted twice, live and forecast, and the event goes to
       the window, so both were answering it: clicking a hazard put a card
       reading "Reported 14 min ago · Waze driver" over the forecast map, which
       does not carry reports at all -- renderAlerts is realtime-only, so the
       forecast map was describing a marker it had never drawn, and describing
       an observation on a panel whose whole job is prediction.

       The flyTo stays on both, because keeping the two maps over the same
       stretch is the point of having them side by side. */
    const showsReports = endpoint.includes("real-time");
    const onShowReport = (e: Event) => {
      const d = (e as CustomEvent<ReportDetail>).detail;
      if (!d) return;
      if (showsReports) setSelectedReport(d);
      if (d.lon != null && d.lat != null && Number.isFinite(d.lon) && Number.isFinite(d.lat)) {
        map.flyTo({ center: [d.lon, d.lat], zoom: 13, duration: 900 });
      }
    };

    window.addEventListener("nlex:flyto", onFlyTo);
    window.addEventListener("nlex:resetview", onResetView);
    // A zoom asked for before this map was ready (a jam clicked on the Overview), taken up now.
    const pending = (window as unknown as { __nlexPendingFly?: { lng: number; lat: number; zoom?: number } }).__nlexPendingFly;
    if (pending) onFlyTo(new CustomEvent("nlex:flyto", { detail: pending }));
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

    /* Where each queue begins, for the plaza declutter further down. Queues
       start at interchanges, so their markers land under the exit pins almost
       by definition -- which is why congestion only appeared once the reader
       had zoomed in far enough to separate them.

       The whole line is kept, not only the head. Two different questions get
       asked of it below and they need different things: whether a queue is
       COVERING an exit pin is about pixels and only the marker matters, but
       whether an exit IS congested is about the ground and the queue's body
       counts as much as its start. */
    const queuePins: { at: [number, number]; line: [number, number][]; level: number }[] = [];

    /* What the exit PLATES are coloured from, which is not the same thing on
       both maps.

       The live map has jams: individual queues with their own geometry, so an
       exit is red when a queue is standing on it. The forecast has none -- it
       carries a predicted state per SEGMENT, which is what paints its ribbons
       -- so `queuePins` is empty there and every plate came out plain. The
       forecast map was drawing a red road past a white exit name and saying
       nothing about which exit the congestion was at, while the live map beside
       it named its own in red.

       So the forecast plates read the levelled corridor segments instead. A
       segment runs between two exits and the whole of it is drawn congested,
       so both of its ends take the colour -- which is what the picture already
       says.

       Bumped whenever either source is rebuilt, so the per-exit levels below
       can be worked out once rather than on every frame of a pan. */
    const segmentState: { line: [number, number][]; level: number }[] = [];
    let stateVersion = 0;

    const setSegmentState = (fc: GeoJSON.FeatureCollection) => {
      segmentState.length = 0;
      for (const f of fc.features ?? []) {
        const lvl = Number((f.properties as { level?: unknown })?.level ?? NO_READING);
        // NO_READING is -1: nobody forecast that stretch, which is not a claim.
        if (!(lvl >= 1) || f.geometry?.type !== "LineString") continue;
        segmentState.push({ line: f.geometry.coordinates as [number, number][], level: lvl });
      }
      stateVersion++;
    };

    /* map.on("load") is asynchronous, so a theme switch or an unmount can tear
       the effect down before it fires. Everything started in there — the
       animation frame and the poll — has to check this, or it runs on a map
       that has already been removed. Each toggle used to leave another rAF loop
       and another 15-second poll behind, all of them writing dash values to the
       same six layers, which is what made the flow stutter and jump. */
    let disposed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    /* Set once the Night Corridor graphics exist; tears them down with the map. */
    let cleanupGraphics: (() => void) | null = null;

    const guard = corridorGuard(corridorLine, corridorExits);

    /* Forecast: each predicted jam drawn over the stretch it would occupy, on
       the side(s) that exit actually jams on. See lib/predicted-queues.ts,
       which holds the whole rule so it can be run and checked on its own. */
    const predicted = makePredictedQueues(guard.centreline, FALLBACK_EXITS);
    const withPredictedQueues = (fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection =>
      isRealtimeEndpoint ? fc : predicted.withPredictedQueues(fc);

    /* Keeps only what is on NLEX, then puts each jam onto the corridor itself
       rather than leaving it on the geometry Waze traced. See snap() in
       lib/corridor-shape.ts for why. */
    const onlyOnCorridor = (fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection => {
      const kept = guard.filter(fc);

      /* A marker per queue, at the point it starts.
         Drawn because the true extent is often too small to find. The corridor
         is 85 km and the panel is about 950 px wide, so a pixel is roughly 90 m
         and the 228 m queue at Pulilan is two and a half pixels of road -- there,
         correct, and invisible. Zoomed out, most of the feed looks like an empty
         expressway.
         The line still carries the extent and is still the thing that says how
         much road is queued; this only says "a queue begins here", which is true
         at every zoom. Both carry the same properties, so hovering either one
         opens the same card. */
      const marks: GeoJSON.Feature[] = [];
      queuePins.length = 0;
      stateVersion++;

      const out = {
        ...kept,
        features: (kept.features ?? [])
          /* Alerts are shown only for the categories the legend names, so the
             map and the Active Reports tile cannot disagree about what a report
             is. ROAD_CLOSED arrives in the feed and is dropped here. */
          .filter((f) => {
            const p = f.properties as Record<string, unknown> | null;
            if (p?.feature_type !== "alert") return true;
            // Disputed reports are dropped; merely uncorroborated ones are kept
            // and drawn faintly, because that is what a new report looks like.
            return isReportType(p?.type) && !isDisputedReport(p);
          })
          .map((f) => {
          const props = f.properties as { feature_type?: string } | null;
          if (props?.feature_type !== "jam" || f.geometry?.type !== "LineString") return f;
          const snapped = guard.snap(
            f.geometry.coordinates as number[][],
            (f.properties as { street?: string })?.street,
          );
          if (!snapped) return f;
          const properties = {
            ...f.properties,
            direction: snapped.direction,
            direction_source: snapped.directionSource,
          };
          /* The queue's upstream end -- the back of it, where traffic arrives.

             snap() returns the centreline slice, and a slice is always in
             corridor order, south to north, whichever way the traffic on it is
             going. Taking coords[0] therefore marked the southern end every
             time, which is the back of a northbound queue and the FRONT of a
             southbound one. Five of the nine queues in a live sample were
             southbound, so the marker and the "starts at" attribution were
             pointing at the wrong end of better than half of them.

             The geometry itself is left in corridor order on purpose: the
             ribbons are drawn from it with line-offset, whose side depends on
             the direction the line runs, and the flow patterns scroll along
             it. Reversing the coordinates would move southbound queues onto
             the other carriageway and run their animation backwards. Only the
             END being picked out changes here. */
          const coords = snapped.coords;
          const head = (snapped.direction === "SB" ? coords[coords.length - 1] : coords[0]) as
            | [number, number]
            | undefined;
          if (head) {
            queuePins.push({
              at: head,
              line: coords as [number, number][],
              level: Number((f.properties as { level?: unknown })?.level ?? 0),
            });
            const where = queueWhere(head, snapped.direction);
            const marked = { ...properties, ...(where ?? {}) };
            marks.push({
              type: "Feature",
              properties: { ...marked, feature_type: "jam_mark" },
              geometry: { type: "Point", coordinates: head },
            });
            return {
              ...f,
              properties: marked,
              geometry: { type: "LineString", coordinates: coords } as GeoJSON.Geometry,
            };
          }
          return {
            ...f,
            properties,
            geometry: { type: "LineString", coordinates: coords } as GeoJSON.Geometry,
          };
        }),
      };

      /* Worst last, so the worst is on top.
         Everything in jam-extent is one layer, and Mapbox paints a layer's
         features in the order the source lists them -- so a 4.9 km level-1
         queue arriving after a 188 m level-3 one covered it completely. The
         road read amber at Meycauayan while the card for the queue under the
         cursor said Congested, which is two different answers about one point.
         Waze reports overlap constantly here: that pair was the slow run up
         from Paso de Blas lying across the standstill at Meycauayan, and both
         were true.
         Longer first within a severity, so a short queue is never buried by a
         long one of its own colour either. The markers are ordered the same
         way, for the same reason. */
      const bySeverity = (a: GeoJSON.Feature, b: GeoJSON.Feature) => {
        const lv = (f: GeoJSON.Feature) => Number((f.properties as { level?: unknown })?.level ?? 0);
        const len = (f: GeoJSON.Feature) => Number((f.properties as { length_m?: unknown })?.length_m ?? 0);
        return lv(a) - lv(b) || len(b) - len(a);
      };
      const isJam = (f: GeoJSON.Feature) =>
        (f.properties as { feature_type?: string } | null)?.feature_type === "jam";

      return {
        ...out,
        features: [
          ...out.features.filter((f) => !isJam(f)),
          ...out.features.filter(isJam).sort(bySeverity),
          ...marks.sort(bySeverity),
        ],
      };
    };

    /** Stands in for "the feed said nothing about this stretch". */
    const NO_READING = -1;

    const exitNames = [...FALLBACK_EXITS].sort((x, y) => x.km - y.km).map((e) => e.exit_name);
    /* Km post at each exit, south to north: segment N runs from [N-1] to [N]. */
    const exitKmByOrder = CORRIDOR_BY_KM.map((e) => e.km);

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
    /* The endpoint sends Low / Med / High. This table said "Medium", so every
       medium segment missed and fell through to 0 - free flow - and drew as
       clear green, while Low mapped to 1, which is amber. The two busiest
       states on the corridor were being shown the wrong way round: a building
       stretch looked empty and an empty one looked like light traffic.

       Levels are the shared map palette's: 0 clear, 2 amber, 4 red. Both
       spellings are accepted so a future rename of the label cannot silently
       reintroduce the same fallthrough. */
    const FORECAST_LEVEL: Record<string, number> = {
      Low: 0,
      Med: 2,
      Medium: 2,
      High: 4,
      Severe: 5,
    };

    /** Colours the corridor from whichever shape of state the endpoint sends. */
    const corridorWithState = (fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection => {
      /* One derivation, shared with the Home tab's corridor panel. It used to
         live here as its own loop over the same guard and the same snap, which
         meant the two views agreed only for as long as nobody edited one of
         them. */
      const bySegment = new Map<string, number>(corridorSegmentLevels(fc));

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
        // Jams are handled once, below, by the shared derivation.

        // Forecast: named "X to Y", with no direction, so it colours both ways.
        if (q.feature_type === "forecast" && typeof q.corridor_segment === "string") {
          const hit = corridorBase.features.find(
            (c) => (c.properties as { segment_name: string }).segment_name === q.corridor_segment,
          );
          if (hit) {
            const order = (hit.properties as { segment_order: number }).segment_order;
            /* Where the forecast carries a typical queue, the queue is drawn
               over its own length (withPredictedQueues) and the segment under
               it is road that was forecast, so it is green, as on the live
               map. Only a forecast with no queue to draw still colours the
               whole segment, so a predicted jam is never silently lost. */
            const lvl = q.jam_queue_m != null ? 0 : FORECAST_LEVEL[shownForecastState(q)] ?? 0;
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
      const data = onlyOnCorridor(withPredictedQueues(await response.json()));
      // Rebuilt (new hour, new theme) or unmounted while the feed was loading:
      // this map is gone, so there is nothing left to draw on.
      if (disposed) return;

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
      setSegmentState(corridorAtLoad);
      lastCorridorSig = signature(corridorAtLoad);
      lastFeedSig = signature(data);
      map.addSource("nlex-corridor", {
        type: "geojson",
        data: corridorAtLoad,
      });

      /* Night Corridor: the images the new layers draw with, and the active
         maintenance closures (read-only, /api/maintenance/list). */
      addNightCorridorImages(map, PALETTE);
      const K = corridorKm();
      const closuresFC = (list: Closure[] | null): GeoJSON.FeatureCollection => ({
        type: "FeatureCollection",
        features: (list ?? []).flatMap((c) => {
          const a = Math.max(K.kmStart, Math.min(K.kmEnd, Number(c.start_km)));
          const b = Math.max(K.kmStart, Math.min(K.kmEnd, Number(c.end_km)));
          // Wholly off the corridor's km posts, or no length: nothing to draw.
          if (Math.abs(b - a) < 0.01) return [];
          const dirs: ("NB" | "SB")[] = c.direction === "Both" ? ["NB", "SB"] : [c.direction === "SB" ? "SB" : "NB"];
          return dirs.map((direction) => ({
            type: "Feature" as const,
            properties: {
              id: c.id, title: c.title, description: c.description, direction,
              start_km: Number(c.start_km), end_km: Number(c.end_km), lane_closure: c.lane_closure,
              starts_at: c.starts_at, ends_at: c.ends_at, status: c.status,
            },
            geometry: { type: "LineString" as const, coordinates: K.sliceKm(a, b) },
          }));
        }),
      });
      map.addSource("lm-closures", { type: "geojson", data: closuresFC(closuresRef.current) });
      applyClosuresRef.current = (list) => {
        if (disposed) return;
        (map.getSource("lm-closures") as GeoJSONSource | undefined)?.setData(closuresFC(list));
      };

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
      /* The lit ribbon's outer light: wider and fainter than the halo, the
         glow the corridor throws on the ground around it, in both themes. */
      map.addLayer({
        id: "lm-ribbon-glow",
        type: "line",
        source: "nlex-corridor",
        filter: ["==", ["get", "direction"], "NB"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": PALETTE.glow,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 8, 34, 12, 64, 16, 96],
          "line-opacity": PALETTE.glowOpacity,
          "line-blur": ["interpolate", ["linear"], ["zoom"], 8, 18, 16, 40],
        },
      });

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

      /* The road surface (5 Oct 2026): an edge line, then the asphalt, as one
         band on the centreline wide enough to hold both offset ribbons. Drawn
         once (northbound features only: both directions share a centreline).
         Widths follow the ribbons: 2 x (offset + half the ribbon) + 3 px. */
      const ROADBED_WIDTH = ["interpolate", ["linear"], ["zoom"], 8, 22, 12, 26, 15, 28, 16, 33, 17, 46, 18, 69] as unknown as mapboxgl.ExpressionSpecification;
      const ROAD_EDGE_WIDTH = ["interpolate", ["linear"], ["zoom"], 8, 25, 12, 29, 15, 31, 16, 36, 17, 49, 18, 72] as unknown as mapboxgl.ExpressionSpecification;
      map.addLayer({
        id: "lm-road-edge",
        type: "line",
        source: "nlex-corridor",
        filter: ["==", ["get", "direction"], "NB"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": PALETTE.roadEdge, "line-width": ROAD_EDGE_WIDTH, "line-opacity": 1 },
      });
      map.addLayer({
        id: "lm-roadbed",
        type: "line",
        source: "nlex-corridor",
        filter: ["==", ["get", "direction"], "NB"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": PALETTE.roadbed, "line-width": ROADBED_WIDTH, "line-opacity": 1 },
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

      /* (The forecast map's dashed dark casing was removed on 16 Oct 2026: at corridor zoom it read as
         stray black lines around every stretch. The soft hatch below and the panel's own forecast
         labelling say "predicted" without it.) */

      /* The median: a fine dashed line between the two carriageways. */
      map.addLayer({
        id: "lm-median",
        type: "line",
        source: "nlex-corridor",
        filter: ["==", ["get", "direction"], "NB"],
        layout: { "line-join": "round", "line-cap": "butt" },
        paint: {
          "line-color": PALETTE.median,
          "line-opacity": PALETTE.medianOpacity,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 1.2, 16, 1.6, 18, 2.4],
          "line-dasharray": [4, 3],
        },
      });

      map.addLayer({
        id: "carriageway",
        type: "line",
        source: "nlex-corridor",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          /* Live: plain asphalt. Forecast: coloured by the predicted state.
             The difference is not cosmetic -- the two maps know different
             things about where congestion is.

             Waze gives every jam its own LINESTRING and its own length_meters,
             and the two agree to the metre, so on the live map the exact extent
             of each queue is known. Painting this ribbon with the worst jam
             ANYWHERE in its exit-to-exit segment threw that away: the segments
             run several kilometres, so a 300 m queue at one end turned the whole
             span red and the map showed far more congestion than the feed
             contained. The colour now lives on jam-extent below, over the length
             each queue actually occupies, and this is the road under it.

             The forecast now works the same way. The model predicts one
             state per exit, and each predicted jam carries the typical queue
             length and distance from the plaza for that exit and hour, from
             four years of Waze history, so withPredictedQueues draws it over
             that length and this ribbon is the green road under it. A forecast
             segment is coloured whole only when it has no queue to draw, and
             grey still means nobody forecast that stretch. */
          "line-color": isRealtimeEndpoint
            ? /* Green, and flat green, on the live map.
                 Not a neutral roadbed: Waze emits a record only where there IS
                 a jam, so a stretch it says nothing about is one that is
                 flowing, and green states that. Grey would have claimed the
                 feed had no opinion, which is a weaker thing than the feed
                 actually says.
                 Flat, because the congestion lives on jam-extent above, over
                 the length each queue actually covers. Banding this ribbon by
                 its segment's worst jam is what turned a 400 m queue into
                 nine kilometres of red.
                 It also carries the flow pulse, which is drawn in white at
                 about half opacity: over green it reads, over a grey roadbed it
                 washed out and the corridor looked static. */
              PALETTE.status.clear
            : [
                "match", ["get", "level"],
                0, PALETTE.status.clear,
                [1, 2], PALETTE.status.slow,
                [3, 4, 5], PALETTE.status.congested,
                // NO_READING: nobody forecast this stretch. Grey says so rather
                // than implying a free flow the model never claimed.
                PALETTE.noData,
              ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 5, 12, 9, 16, 11, 18, 18],
          "line-opacity": 1,
          "line-offset": OFFSET,
        },
      });

      /* The forecast finish, part 2: the same three colours under a soft
         diagonal hatch. Forecast map only, forecast stretches only. */
      if (!isRealtimeEndpoint) {
        map.addLayer({
          id: "lm-forecast-hatch",
          type: "line",
          source: "nlex-corridor",
          filter: [">=", ["get", "level"], 0],
          layout: { "line-join": "round", "line-cap": "butt" },
          paint: {
            "line-pattern": "lm-hatch",
            "line-opacity": 0.35, // a hint of texture, not noise (16 Oct 2026)
            "line-width": ["interpolate", ["linear"], ["zoom"], 8, 5, 12, 9, 16, 11, 18, 18],
            "line-offset": OFFSET,
          },
        });
      }

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

      /* Registers one animated pulse image and hands back its id.
         An animated StyleImage is how Mapbox actually drives a moving pattern:
         it calls render() once per frame for every image a visible layer is
         using, and repaints when render() returns true. Rewriting the bytes
         with map.updateImage() from our own animation frame did nothing --
         the data changed but nothing asked the map to redraw.

         Call this IMMEDIATELY BEFORE the layer that uses it. An animated image
         registered while no layer references it is never staged into a pattern
         atlas, and adding the layer later does not stage it: the layer then
         draws nothing at all, silently. That is exactly why the queue flow was
         invisible while the ribbon's worked -- the mid and slow images were
         built up here and first referenced a hundred lines further down. The
         proof was a plain non-animated image added at that later point, which
         painted immediately, and flow-nb-fast moved onto the queue layer,
         which did not. */
      const addFlowImage = (
        id: string,
        dir: "NB" | "SB",
        cycleMs: number,
        opacity: number,
      ) => {
        if (map.hasImage(id)) return id;
        // Northbound scrolls one way and southbound the other, so each ribbon
        // reads as travelling in its own direction.
        const sign = dir === "NB" ? -1 : 1;
        const data = new Uint8Array(PW * PH * 4);
        writePulse(data, 0, opacity);
        let lastWrite = 0;
        map.addImage(id, {
          width: PW,
          height: PH,
          data,
          render() {
            // Behind the maximised view there is nothing to see. Returning
            // without asking for another frame lets the map go idle; the
            // paused effect below kicks it again on the way back.
            if (pausedRef.current) return false;
            // Same for reduced motion (a still frame stays drawn) and for a
            // map nobody can see; both kick a repaint when that changes.
            if (reducedRef.current || !visibleRef.current) return false;
            // render() only runs as part of a repaint, so an animated image has
            // to ask for the next one or the map settles and never calls it
            // again.
            map.triggerRepaint();
            const now = performance.now();
            // 30fps is indistinguishable here and halves the texture uploads.
            if (now - lastWrite < 33) return false;
            lastWrite = now;
            writePulse(data, sign * ((now % cycleMs) / cycleMs), opacity);
            return true;
          },
        } as unknown as Parameters<typeof map.addImage>[1]);
        return id;
      };

      for (const dir of ["NB", "SB"] as const) {
        for (const tier of FLOW_TIERS) {
          /* Live: the ribbon pulses at a single speed, so the other two tiers
             get no layer -- and therefore no image, since an image nothing
             references is wasted work and, worse, cannot be staged later. The
             queues below build their own. */
          if (isRealtimeEndpoint && tier.id !== "fast") continue;

          const id = addFlowImage(flowImageId(dir, tier.id), dir, tier.cycleMs, tier.opacity);

          map.addLayer({
            id: `carriageway-flow-${dir.toLowerCase()}-${tier.id}`,
            type: "line",
            source: "nlex-corridor",
            layout: { "line-join": "round", "line-cap": "butt" },
            /* Live: one speed for the whole ribbon, because the ribbon is flat
               green and the queues above it carry the state. Picking the tier
               from the segment's worst jam would crawl nine kilometres of
               clear road for one 400 m queue -- the same overreach that
               flattening the colour was meant to end. The queues get their own
               flow below, at a speed that does follow severity.

               Forecast: no queue overlay exists, so there the tier still
               follows the predicted level, and NO_READING (-1) matches no tier
               so an unforecast stretch stays still rather than claiming a flow
               nothing measured. */
            filter: isRealtimeEndpoint
              ? ["all", ["==", ["get", "direction"], dir]]
              : [
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

      /* Directional flow, the no-data half: a static grey dash down every
         ribbon. The ribbons carry no measured speed (Waze reports speed only
         inside a jam), so nothing moves here; the moving dashes ride on the
         queues further up, at their own measured speed. */
      for (const dir of ["NB", "SB"] as const) {
        map.addLayer({
          id: `lm-lane-dash-${dir.toLowerCase()}`,
          type: "line",
          source: "nlex-corridor",
          filter: ["==", ["get", "direction"], dir],
          layout: { "line-join": "round", "line-cap": "butt" },
          paint: {
            "line-color": PALETTE.lane,
            "line-opacity": PALETTE.laneOpacity,
            "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 12, 1.4, 16, 1.8, 18, 2.6],
            "line-dasharray": [3, 4],
            "line-offset": OFFSET,
          },
        });
      }

      /* Active maintenance closures: hatched stretches between their start and
         end km, on their own carriageway(s). */
      map.addLayer({
        id: "lm-closure-casing",
        type: "line",
        source: "lm-closures",
        layout: { "line-join": "round", "line-cap": "butt" },
        paint: {
          "line-color": PALETTE.ink,
          "line-opacity": 0.9,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 8, 12, 13, 16, 15, 18, 23],
          "line-offset": OFFSET,
        },
      });
      map.addLayer({
        id: "lm-closure-hatch",
        type: "line",
        source: "lm-closures",
        layout: { "line-join": "round", "line-cap": "butt" },
        paint: {
          "line-pattern": "lm-closure",
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 5.5, 12, 10, 16, 12, 18, 19],
          "line-offset": OFFSET,
        },
      });

      /* The queues themselves, each over the length it actually covers. This
         is now the only layer on the map that states congestion.

         An earlier build drew Waze's jam lines raw and they landed beside and
         across the corridor rather than on it -- the geometry follows Waze's
         own road graph, not ours. They were dropped for that reason and the
         colour folded into the ribbon instead, which is what spread one short
         queue across a whole segment.

         What makes them drawable now is the snap in the loader above: each jam
         is projected onto the corridor centreline and given the direction it
         belongs to, so it rides the same ribbon at the same offset. Only jams
         the snapper resolved are drawn -- one it could not keeps its raw Waze
         geometry, and direction_source is absent, so it is filtered out here
         rather than drawn off-road. */
      /* A casing under every queue.
         A 200 m queue is two pixels of road at corridor zoom, and amber on
         green at two pixels is a colour change the eye skims over -- the thing
         that made short congestion hard to find even once it was drawn in the
         right place. An outline gives it an edge, and an edge is what makes a
         small mark register as an object rather than as noise on the ribbon.
         Cheap, and it never overstates: the casing is centred on the queue, so
         it grows the mark sideways, never along the road. */
      /* Forecast only: how much further a predicted queue may reach (out to
         its 75th-percentile length). Faint and dashed, under the casing, so the
         solid queue always reads first and this reads as a possibility. */
      map.addLayer({
        id: "jam-tail",
        type: "line",
        source: "traffic",
        filter: ["==", ["get", "feature_type"], "jam_tail"],
        layout: { "line-join": "round", "line-cap": "butt" },
        paint: {
          "line-color": [
            "match", ["get", "level"],
            [1, 2], PALETTE.status.slow,
            [3, 4, 5], PALETTE.status.congested,
            PALETTE.noData,
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 5, 12, 9, 16, 11, 18, 18],
          "line-opacity": 0.55,
          "line-dasharray": [1.2, 1],
          "line-offset": OFFSET,
        },
      });

      /* Jam callout, part 1: each queue's real extent glows softly under it,
         pulsing (still under reduced motion). Same filter and colours as
         jam-extent, so it marks exactly the road the queue covers. */
      map.addLayer({
        id: "lm-jam-pulse",
        type: "line",
        source: "traffic",
        filter: ["all", ["==", ["get", "feature_type"], "jam"], ["has", "direction_source"]],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": [
            "match", ["get", "level"],
            0, PALETTE.status.clear,
            [1, 2], PALETTE.status.slow,
            [3, 4, 5], PALETTE.status.congested,
            PALETTE.noData,
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 18, 12, 26, 16, 30, 18, 42],
          "line-blur": ["interpolate", ["linear"], ["zoom"], 8, 6, 16, 12],
          "line-opacity": 0.28,
          "line-offset": OFFSET,
        },
      });

      map.addLayer({
        id: "jam-casing",
        type: "line",
        source: "traffic",
        filter: [
          "all",
          ["==", ["get", "feature_type"], "jam"],
          ["has", "direction_source"],
        ],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": PALETTE.casing,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 11, 12, 17, 16, 20, 18, 30],
          "line-opacity": 0.9,
          "line-offset": OFFSET,
        },
      });

      map.addLayer({
        id: "jam-extent",
        type: "line",
        // "traffic", not "nlex-corridor": the corridor source carries only the
        // 38 carriageway ribbons. The jams arrive on the feed and live here,
        // already snapped onto the centreline by the loader above.
        source: "traffic",
        filter: [
          "all",
          ["==", ["get", "feature_type"], "jam"],
          ["has", "direction_source"],
        ],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          // The same three bands, and the same hexes, the legend names.
          "line-color": [
            "match", ["get", "level"],
            0, PALETTE.status.clear,
            [1, 2], PALETTE.status.slow,
            [3, 4, 5], PALETTE.status.congested,
            PALETTE.noData,
          ],
          /* A little wider than the ribbon's 5/9/11/18, so a queue stands
             proud of the road instead of sitting flush in it. Width is the one
             dimension that can be exaggerated honestly here: it says nothing
             about how much road is queued, which is the length, and that stays
             exactly what Waze measured. */
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 7, 12, 12, 16, 14, 18, 23],
          "line-offset": OFFSET,
        },
      });

      if (!isRealtimeEndpoint) {
        map.addLayer({
          id: "lm-forecast-hatch-jam",
          type: "line",
          source: "traffic",
          filter: ["all", ["==", ["get", "feature_type"], "jam"], ["has", "direction_source"]],
          layout: { "line-join": "round", "line-cap": "butt" },
          paint: {
            "line-pattern": "lm-hatch",
            "line-opacity": 0.35, // a hint of texture, not noise (16 Oct 2026)
            "line-width": ["interpolate", ["linear"], ["zoom"], 8, 7, 12, 12, 16, 14, 18, 23],
            "line-offset": OFFSET,
          },
        });
      }

      /* Where each queue starts. See the marker note in onlyOnCorridor: at
         corridor zoom a 228 m queue is under three pixels of road, so the
         extent alone leaves most of the feed looking like an empty expressway.

         It shrinks as the map zooms in, because by then the line itself carries
         the answer and the dot is only in the way. Collision is left ON -- the
         default -- so a cluster of overlapping reports at one interchange
         resolves to a single dot rather than a pile of them. */
      /* The markers, translated onto the carriageway they belong to.
         The ribbons are drawn with line-offset, which is in PIXELS, so they sit
         to either side of the centreline by an amount that changes with zoom.
         A circle is a plain point on the centreline, so the dots were landing
         in the median between the two roads rather than on either of them.
         circle-translate is the only offset a circle has, and it is in pixels
         too -- so it can track the ribbon where a metres-based nudge to the
         geometry could only ever match at one zoom.
         It is a fixed screen direction rather than a normal to the road, which
         is why there is one layer per carriageway: NLEX runs north-north-west
         its whole length, so the ribbons sit almost due east and west of the
         centreline, and east/west is within a few pixels of right across the
         zooms these dots are visible at. */
      const MARK_SHIFT = (dir: "NB" | "SB") => {
        const px = dir === "NB" ? 1 : -1;
        return [
          "interpolate", ["exponential", 2], ["zoom"],
          9, ["literal", [7 * px, 0]],
          15, ["literal", [7 * px, 0]],
          18, ["literal", [24 * px, 0]],
        ] as unknown as mapboxgl.ExpressionSpecification;
      };

      const markFilter = (dir: "NB" | "SB") => [
        "all",
        ["==", ["get", "feature_type"], "jam_mark"],
        ["has", "direction_source"],
        ["==", ["get", "direction"], dir],
      ] as unknown as mapboxgl.ExpressionSpecification;

      const markColour = [
        "match", ["get", "level"],
        0, PALETTE.status.clear,
        [1, 2], PALETTE.status.slow,
        [3, 4, 5], PALETTE.status.congested,
        PALETTE.noData,
      ] as unknown as mapboxgl.ExpressionSpecification;

      for (const dir of ["NB", "SB"] as const) {
        /* No halo. There was a soft wash of the queue's colour under each dot,
           to make a short queue findable at corridor zoom -- but a 32-pixel
           amber cloud reads as a length of amber ROAD, not as a marker. A
           671 m queue at Dau looked like a long slow stretch zoomed out and
           turned into a short hook zoomed in, which is the map telling two
           different stories about one queue.
           A ringed dot cannot be mistaken for road: it is a marker, it says
           "a queue starts here", and the line says how far it runs. */
        map.addLayer({
          id: `jam-mark-${dir.toLowerCase()}`,
          type: "circle",
          source: "traffic",
          filter: markFilter(dir),
          paint: {
            "circle-color": markColour,
            // A red dot on an orange road needs the ring more than the fill:
            // the white edge is what separates it from what it stands on.
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 7, 11, 8.5, 11.8, 7, 13.2, 0],
            "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 11.8, 3, 13.2, 0],
            "circle-stroke-color": PALETTE.casing,
            // Handed over to the line by z13.2. The marker exists to make a
            // short queue findable across 78 km of corridor, and it stops
            // earning its place the moment the queue can be seen without it --
            // at z13 a 200 m queue is already eleven pixels of coloured road.
            // Past that the dot is not helping the reader find the queue, it
            // is standing on the queue it points at.
            "circle-opacity": ["interpolate", ["linear"], ["zoom"], 11.8, 1, 13.2, 0],
            "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 11.8, 1, 13.2, 0],
            "circle-translate": MARK_SHIFT(dir),
          },
        });
      }

      /* The queues move too, and slower than the road around them.
         That contrast is the point: the green ribbon runs at the clear pace
         and a queue laid over it crawls, so which stretch is struggling reads
         before any colour is decoded.

         Borrowed from the images the ribbon already built -- mid for the slow
         band, slow for the congested one -- rather than new ones, so there are
         still six animated textures on the map and not twelve.

         Level 5 gets no layer at all. A blocked road is not moving, and a
         pulse travelling along it would say it is; leaving it static is the
         honest rendering and it makes a standstill stand out from a crawl.

         Inserted beneath jam-mark so the dots stay on top. */
      const JAM_FLOW = [
        // Higher opacity than the ribbon's: white at half strength reads over
        // green, but amber and red are darker and swallow it.
        { levels: [1, 2], key: "queue-slow", cycleMs: 2600, opacity: 0.7 },
        { levels: [3, 4], key: "queue-heavy", cycleMs: 6000, opacity: 0.62 },
      ] as const;

      for (const dir of ["NB", "SB"] as const) {
        for (const t of JAM_FLOW) {
          // Built here, not in the loop above: see addFlowImage.
          const img = addFlowImage(
            `flow-${dir.toLowerCase()}-${t.key}`, dir, t.cycleMs, t.opacity,
          );
          map.addLayer(
            {
              id: `jam-flow-${dir.toLowerCase()}-${t.key}`,
              type: "line",
              source: "traffic",
              layout: { "line-join": "round", "line-cap": "butt" },
              filter: [
                "all",
                ["==", ["get", "feature_type"], "jam"],
                ["has", "direction_source"],
                ["==", ["get", "direction"], dir],
                ["in", ["get", "level"], ["literal", [...t.levels]]],
              ],
              paint: {
                "line-pattern": img,
                "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 12, 4.5, 16, 5.5, 18, 9],
                "line-offset": OFFSET,
              },
            },
            "jam-mark-nb",
          );
        }
      }

      /* Directional flow, the measured half: dashes travelling along each
         queue in its direction of travel, NB and SB separately, at a rate
         scaled from that queue's own speed (live: Waze speed_kmh; forecast:
         the typical in-jam speed the prediction carries). A queue reported at
         0 km/h gets still dashes; one with no speed at all gets the grey
         no-data dash. Stepped by the animation loop below; hidden under
         reduced motion, which leaves the static arrows. */
      const jamFilter = (dir: "NB" | "SB", extra: unknown[]) => [
        "all",
        ["==", ["get", "feature_type"], "jam"],
        ["has", "direction_source"],
        ["==", ["get", "direction"], dir],
        ...extra,
      ] as unknown as mapboxgl.FilterSpecification;
      // A speed only counts when Waze (or the forecast) actually sent a number.
      const hasSpeed = ["==", ["typeof", ["get", "speed"]], "number"];
      const speedOf = ["to-number", ["get", "speed"]];
      const DASH_W = ["interpolate", ["linear"], ["zoom"], 8, 1.6, 12, 2.4, 16, 3, 18, 4.5] as unknown as mapboxgl.ExpressionSpecification;
      const flowLayers: { id: string; rate: number; dir: "NB" | "SB"; key: number }[] = [];
      for (const dir of ["NB", "SB"] as const) {
        const d = dir.toLowerCase();
        map.addLayer({
          id: `lm-flow-${d}-nodata`,
          type: "line",
          source: "traffic",
          filter: jamFilter(dir, [["!=", ["typeof", ["get", "speed"]], "number"]]),
          layout: { "line-join": "round", "line-cap": "butt" },
          paint: { "line-color": PALETTE.lane, "line-opacity": PALETTE.laneOpacity, "line-width": DASH_W, "line-dasharray": STATIC_DASH, "line-offset": OFFSET },
        }, "jam-mark-nb");
        map.addLayer({
          id: `lm-flow-${d}-stop`,
          type: "line",
          source: "traffic",
          filter: jamFilter(dir, [hasSpeed, ["==", speedOf, 0]]),
          layout: { "line-join": "round", "line-cap": "butt" },
          paint: { "line-color": PALETTE.dash, "line-opacity": 0.8, "line-width": DASH_W, "line-dasharray": STATIC_DASH, "line-offset": OFFSET },
        }, "jam-mark-nb");
        for (const band of FLOW_BANDS) {
          const id = `lm-flow-${d}-${band.id}`;
          map.addLayer({
            id,
            type: "line",
            source: "traffic",
            filter: jamFilter(dir, [hasSpeed, [">=", speedOf, band.min], ["<", speedOf, band.max]]),
            layout: { "line-join": "round", "line-cap": "butt" },
            /* Still dashes (16 Oct 2026, user report of glitching lines): animating line-dasharray
               re-rasterises the dash pattern on every step, so the dashes flickered and snapped.
               The motion now comes only from the smooth scrolling glow (jam-flow), whose speed
               already follows the queue's severity. */
            paint: { "line-color": PALETTE.dash, "line-opacity": 0.6, "line-width": DASH_W, "line-dasharray": STATIC_DASH, "line-offset": OFFSET },
          }, "jam-mark-nb");
          void band.rate;
        }
      }

      /* Direction of travel. Chevrons rather than triangles: under line
         placement they rotate with the road, so each ribbon reads as flowing
         even where the corridor bends.

         Drawn as icons (lm-chevron-fwd / -back) rather than the "\u276F" glyph:
         the dark basemap's glyph server has no such character, so a text
         arrow drew nothing there. Same placement, spacing and colour. */
      map.addLayer({
        id: "carriageway-arrows",
        type: "symbol",
        source: "nlex-corridor",
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": ["interpolate", ["linear"], ["zoom"], 8, 34, 14, 60],
          "icon-image": ["case", ["==", ["get", "direction"], "NB"], "lm-chevron-fwd", "lm-chevron-back"],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.62, 14, 0.9],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-rotation-alignment": "map",
          "icon-keep-upright": false,
          "icon-offset": [
            "case",
            ["==", ["get", "direction"], "NB"],
            ["literal", [0, 9]],
            ["literal", [0, -9]],
          ],
        },
        paint: {
          "icon-opacity": 0.85,
        },
      });

      /* The alert circle layer is gone. Reports are drawn as HTML markers
         further down, which carry the icons and the click-through, so every
         report had a plain dot sitting under its own pin.

         The jam overlay came back, as jam-extent above. It had been removed
         because Waze's raw lines landed beside and across the corridor and
         disagreed with the ribbon wherever they overlapped -- but the fix for
         that was the snapper, not deleting the layer. Folding the colour into
         the ribbon instead meant a segment-wide maximum: one short queue
         painted kilometres of road. The overlay carries the extent, so the
         ribbon no longer has to. */

      /* What a queue is, on hover. Every figure here is a Waze field carried
         straight through -- length_meters, delay_seconds, duration_minutes and
         speed_kmh -- so the card reports measurements rather than anything
         derived. A field Waze did not send is omitted rather than shown as a
         zero, which would read as "no delay" instead of "not reported". */
      /* A hover card that opens ACROSS the corridor rather than along it.
         Left to itself Mapbox picks whichever side has room in the viewport,
         and that is regularly the side the road runs down, so the card covered
         the very thing under the cursor. NLEX runs roughly north-north-west to
         south-south-east for its whole length, so east and west are both
         broadly across it: opening horizontally clears the road, and the only
         question left is which side has space.
         Two instances per card, because a Popup fixes its anchor at
         construction and there is no public way to change it afterwards.
         Anchor "left" puts the card's left edge on the point, so it opens to
         the east; "right" opens to the west. */
      const sideCard = (className?: string) => {
        const make = (anchor: "left" | "right") =>
          new mapboxgl.Popup({ closeButton: false, closeOnClick: false, anchor, offset: 18, className });
        const pair = { left: make("left"), right: make("right") };
        return {
          show(lngLat: mapboxgl.LngLatLike, html: string) {
            // Open away from the panel edge: anchored east near the right edge
            // the card runs off the map, and a fixed anchor will not flip back.
            const px = map.project(lngLat);
            const side: "left" | "right" = px.x < map.getCanvas().clientWidth / 2 ? "left" : "right";
            pair[side === "left" ? "right" : "left"].remove();
            pair[side].setLngLat(lngLat).setHTML(html).addTo(map);
          },
          remove() {
            pair.left.remove();
            pair.right.remove();
          },
        };
      };

      /* `mjp-pop`, not `map-card`. Mapbox puts the popup's class on its OUTER
         wrapper, and .map-card is the dashboard's generic surface -- background,
         border, radius, shadow -- so the wrapper took a full card of its own and
         .map-card .mapboxgl-popup-content painted a second one inside it. What
         the reader saw was a white panel sitting behind and above the card,
         offset by the popup's own tip and spacing. One class, one surface. */
      const jamCard = sideCard("mjp-pop");
      /* Declared here rather than beside the plaza markers below, because the
         queue handler closes it: whichever is declared second would otherwise
         be out of scope for the other. */
      const plazaCard = sideCard("mjp-pop");
      /* One card for every report rather than one per marker: they are only
         ever shown one at a time, and sharing it means a report's summary is
         placed by the same rule as everything else on this map. */
      const reportCard = sideCard("mjp-pop");

      const km = (m: number) =>
        m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
      const mins = (sec: number) => {
        const m = Math.round(sec / 60);
        if (m < 1) return "under a minute";
        if (m < 60) return `${m} min`;
        const h = Math.floor(m / 60);
        return `${h} h ${m % 60} min`;
      };

      const LEVEL_WORD: Record<number, string> = {
        0: "Clear", 1: "Slow", 2: "Slow", 3: "Congested", 4: "Congested", 5: "Blocked",
      };

      /* Street names arrive from Waze, so they are outside data going into
         innerHTML. Escaped rather than trusted. */
      const esc = (v: unknown) =>
        String(v ?? "").replace(/[&<>"']/g, (ch) =>
          ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
        );

      /* Where the queue begins, the way a driver would say it. Under 100 m the
         distance is noise against an interchange's own footprint, so it reads
         as "at" rather than claiming a precision the match does not have. */
      /* Where the queue begins, said the way a driver would say it: which
         plaza they will have passed, or are coming to, when they reach the
         back of it. See queueWhere for how the side is worked out.

         Falls back to the old wording when the corridor position could not be
         established, which keeps a queue describable rather than silent. */
      const startsLine = (p: Record<string, unknown>) => {
        const kind = p.rel_kind as string | undefined;
        const a = p.rel_a as string | undefined;
        const b = p.rel_b as string | undefined;
        const m = p.rel_m == null ? null : Number(p.rel_m);
        /* Named as the facility, not just the place: "before Meycauayan" could
           be the municipality, which is kilometres of it, where "before
           Meycauayan Toll Plaza" is a point on the road. */
        const nm = (x: string) => esc(plazaLabel(x));
        if (kind === "at" && a) return `Starts at ${nm(a)}`;
        if (kind === "past" && a && m != null) return `Starts ${km(m)} past ${nm(a)}`;
        if (kind === "before" && a && m != null) return `Starts ${km(m)} before ${nm(a)}`;
        if (kind === "between" && a && b) return `Starts midway between ${nm(a)} and ${nm(b)}`;

        const exit = p.starts_at;
        const metres = p.starts_m == null ? null : Number(p.starts_m);
        if (typeof exit !== "string" || !exit) return null;
        if (metres == null) return `Starts near ${nm(exit)}`;
        if (metres < 100) return `Starts at ${nm(exit)}`;
        return `Starts ${km(metres)} from ${nm(exit)}`;
      };

      // The line and its marker carry identical properties, so both open the
      // same card: whichever one the reader happens to find answers them.
      const onJamMove = (e: mapboxgl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        map.getCanvas().style.cursor = "pointer";
        const p = (f.properties ?? {}) as Record<string, unknown>;
        const lvl = Number(p.level ?? 0);
        const len = p.length_m == null ? null : Number(p.length_m);
        const delay = p.delay_seconds == null ? null : Number(p.delay_seconds);
        const running = p.running_min == null ? null : Number(p.running_min);
        const speed = p.speed == null ? null : Number(p.speed);
        const where = startsLine(p);

        const row = (label: string, value: string) =>
          `<div class="mjp-row"><span>${label}</span><b>${value}</b></div>`;
        // The card's answer: the same row, set larger.
        const answerRow = (label: string, value: string) =>
          `<div class="mjp-row mjp-answer"><span>${label}</span><b>${value}</b></div>`;

        /* The queue wins over the plaza beneath it. Hovering a queue that
           starts at an interchange put both cards up at once, overlapping;
           a plaza is a fixed landmark the reader can find again, the queue is
           what they were pointing at. Same order the pin declutter uses. */
        plazaCard.remove();

        /* A predicted queue reads like a real one, with three differences said
           out loud: it is a forecast with a chance, its figures are what jams
           here typically look like rather than a measurement, and its
           direction is not forecast. */
        if (p.predicted === true) {
          // Never "100%": scored against what happened, the cells the model put
          // at 100% jammed 86% of the time. Same wording as the congestion card.
          const pc = p.p_congested == null ? null : Number(p.p_congested);
          const chance = pc == null ? null : pc >= 0.95 ? ">95" : pc <= 0.05 ? "<5" : String(Math.round(pc * 100));
          const basis =
            p.jam_basis === "hour" ? "Typical for this exit at this hour, from Waze jams 2022–2026"
            : p.jam_basis === "exit" ? "Typical for this exit at any hour, from Waze jams 2022–2026"
            : "Corridor-wide typical; this exit has too little history of its own";
          jamCard.show(
            e.lngLat,
            `<div class="mjp">
               <div class="mjp-head is-${lvl >= 3 ? "congested" : "slow"}">
                 Predicted &middot; ${lvl >= 3 ? "Congested" : "Slow"}
                 <span>${p.rel_km == null ? "" : `km ${fmtKm(Number(p.rel_km), 0)}`}</span>
               </div>
               ${/* Night Corridor order of importance: the delay answers first,
                    then the queue and where it is, then confidence and its
                    basis, then traffic volume. Same values, same words. */ ""}
               ${delay != null && delay > 0 ? answerRow("Est. delay", `~${mins(delay)}`) : ""}
               ${len != null ? row("Queue length", `~${km(len)}`) : ""}
               ${p.length_p75_m != null ? row("May extend to", `~${km(Number(p.length_p75_m))}`) : ""}
               <div class="mjp-where">${where ?? esc(p.nearest_exit ?? "NLEX")}</div>
               ${speed != null && speed > 0 ? row("Speed", `~${speed} km/h`) : ""}
               ${chance != null ? row("Chance of a jam", `${chance}%`) : ""}
               ${/* The basis and the side rule as labelled rows rather than a
                    paragraph: same facts, same numbers, fewer words. */ ""}
               ${row("Basis",
                 p.jam_basis === "hour" ? "This exit, this hour"
                 : p.jam_basis === "exit" ? "This exit, any hour"
                 : "Corridor-wide (too little history here)")}
               ${p.jam_basis === "hour" || p.jam_basis === "exit" ? row("Source", "Waze jams 2022–2026") : ""}
               ${p.side_share != null
                 ? row("This side", `${Math.round(Number(p.side_share) * 100)}% of jams at this time${
                     p.dir_jam_hours != null ? ` (${Number(p.dir_jam_hours)} live jam-hours)` : ""}`)
                 : ""}
               <div class="mjp-where mjp-basis">${
                 p.side_share != null
                   ? "The other side is drawn only at 40% or more."
                   : "No live jams here yet to pick a side, so both are drawn."}</div>

               ${p.vol_median != null && p.vol_rel != null
                 ? row("Typical traffic", `~${Math.round(Number(p.vol_median) / 10) * 10} veh/h · ${Number(p.vol_rel).toFixed(1)}×`)
                 : ""}
               ${p.vol_rel != null && Number(p.vol_rel) < 0.7
                 ? `<div class="mjp-where mjp-warn">A jam in a quiet hour is usually an incident or roadworks.</div>`
                 : ""}
             </div>`,
          );
          return;
        }

        jamCard.show(
          e.lngLat,
            `<div class="mjp">
               <div class="mjp-head is-${lvl >= 3 ? "congested" : lvl >= 1 ? "slow" : "clear"}">
                 ${LEVEL_WORD[lvl] ?? "Reported"}
                 <span>${String(p.direction ?? "")}${
                   p.rel_km == null ? "" : ` &middot; km ${fmtKm(Number(p.rel_km), 0)}`
                 }</span>
               </div>
               ${delay != null && delay > 0 ? answerRow("Est. delay", mins(delay)) : ""}
               ${len != null ? row("Queue length", km(len)) : ""}
               <div class="mjp-where">${where ?? esc(p.street ?? p.nearest_exit ?? "NLEX")}</div>
               ${speed != null && speed > 0 ? row("Speed", `${speed} km/h`) : ""}
               ${running != null && running > 0 ? row("Going on for", mins(running * 60)) : ""}
             </div>`,
        );
      };

      const onJamLeave = () => {
        map.getCanvas().style.cursor = "";
        jamCard.remove();
      };

      for (const id of ["jam-extent", "jam-mark-nb", "jam-mark-sb", "jam-tail"] as const) {
        map.on("mousemove", id, onJamMove);
        map.on("mouseleave", id, onJamLeave);
      }

      /* A maintenance closure on hover, in the same card as everything else.
         Every line is a field of the schedule as the Maintenance page stores it. */
      const closureCard = sideCard("mjp-pop");
      const when = (iso: unknown) =>
        typeof iso === "string" && iso
          ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
          : "—";
      map.on("mousemove", "lm-closure-hatch", (e: mapboxgl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        map.getCanvas().style.cursor = "pointer";
        const p = (f.properties ?? {}) as Record<string, unknown>;
        const r = (label: string, value: string) => `<div class="mjp-row"><span>${label}</span><b>${value}</b></div>`;
        closureCard.show(
          e.lngLat,
          `<div class="mjp">
             <div class="mjp-head is-closure">Maintenance <span>${p.direction === "SB" ? "Southbound" : "Northbound"} &middot; km ${fmtKm(Number(p.start_km))}–${fmtKm(Number(p.end_km))}</span></div>
             <div class="mjp-where">${esc(p.title)}</div>
             ${/* The exits either end, so the km range needs no lookup. */ ""}
             ${r("Exits", esc(nearExitsText(FALLBACK_EXITS, Number(p.start_km), Number(p.end_km))))}
             ${r("Lanes closed", esc(p.lane_closure))}
             ${r("Status", p.status === "in_progress" ? "In progress" : esc(p.status))}
             ${r("Scheduled", `${esc(when(p.starts_at))} – ${esc(when(p.ends_at))}`)}
             ${p.description ? `<p class="mjp-note">${esc(p.description)}</p>` : ""}
           </div>`,
        );
      });
      map.on("mouseleave", "lm-closure-hatch", () => {
        map.getCanvas().style.cursor = "";
        closureCard.remove();
      });

      /* Strip <-> map, map half: the km post under the pointer, handed to the
         corridor strip when the pointer is on (or within a few pixels of) the
         corridor. The carriageway is the side of the centreline it is on. */
      let hoverRaf = 0;
      let hoverEvt: mapboxgl.MapMouseEvent | null = null;
      let lastHover = "";
      const emitHover = (h: { km: number; dir: "NB" | "SB" } | null) => {
        const key = h ? `${h.dir}:${h.km.toFixed(2)}` : "";
        if (key === lastHover) return;
        lastHover = key;
        onHoverKmRef.current?.(h);
      };
      map.on("mousemove", (e: mapboxgl.MapMouseEvent) => {
        hoverEvt = e;
        if (hoverRaf) return;
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = 0;
          const ev = hoverEvt;
          if (!ev || disposed || !onHoverKmRef.current) return;
          const loc = K.locate([ev.lngLat.lng, ev.lngLat.lat]);
          const px = map.project(loc.at);
          const off = Math.hypot(px.x - ev.point.x, px.y - ev.point.y);
          emitHover(off <= 26 ? { km: loc.km, dir: ev.point.x >= px.x ? "NB" : "SB" } : null);
        });
      });
      map.getCanvas().addEventListener("mouseleave", () => emitHover(null));

      /* Strip <-> map, strip half: a ring on the spot the strip is pointing at. */
      const ringEl = document.createElement("div");
      ringEl.className = "lm-hover-ring";
      ringEl.setAttribute("aria-hidden", "true");
      const ring = new mapboxgl.Marker({ element: ringEl, anchor: "center" });
      let ringOn: Props["highlight"] = null;
      const placeRing = () => {
        if (!ringOn) {
          ring.remove();
          return;
        }
        ring.setLngLat(K.pointAtKm(ringOn.km)).setOffset([carriagewayShift(map.getZoom(), ringOn.dir), 0]).addTo(map);
      };
      applyHighlightRef.current = (h) => {
        if (disposed) return;
        ringOn = h ?? null;
        placeRing();
        placeClock();
      };

      /* The forecast finish, part 3: a clock badge on the selected forecast
         segment -- the one the strip points at, else one clicked on the map,
         else the exit picked in the header, else the segment of the likeliest
         predicted jam. Forecast map only. */
      const clockEl = document.createElement("div");
      clockEl.className = "lm-clock";
      clockEl.setAttribute("aria-hidden", "true");
      const clock = new mapboxgl.Marker({ element: clockEl, anchor: "center" });
      let clickedOrder: number | null = null;
      let exitOrder: number | null = null;
      let defaultOrder: number | null = null;
      let clockHours: number | null = null;
      const orderAtKm = (km: number) => {
        for (let i = 1; i < exitKmByOrder.length; i++) if (km <= exitKmByOrder[i]) return i;
        return exitKmByOrder.length - 1;
      };
      const forecastDefault = (fc: GeoJSON.FeatureCollection) => {
        let best: { order: number; rank: number; pc: number } | null = null;
        let hours: number | null = null;
        for (const f of fc.features ?? []) {
          const q = f.properties as Record<string, unknown> | null;
          if (q?.feature_type !== "forecast") continue;
          if (q.hours_ahead != null && Number.isFinite(Number(q.hours_ahead))) hours = Number(q.hours_ahead);
          const state = shownForecastState(q);
          const rank = state === "High" ? 2 : state === "Med" ? 1 : 0;
          if (!rank) continue;
          const hit = corridorBase.features.find(
            (c) => (c.properties as { segment_name: string }).segment_name === q.corridor_segment,
          );
          if (!hit) continue;
          const pc = Number(q.p_congested ?? 0);
          const order = (hit.properties as { segment_order: number }).segment_order;
          if (!best || rank > best.rank || (rank === best.rank && pc > best.pc)) best = { order, rank, pc };
        }
        defaultOrder = best?.order ?? null;
        clockHours = hours;
      };
      const placeClock = () => {
        if (isRealtimeEndpoint) return;
        const order = ringOn ? orderAtKm(ringOn.km) : clickedOrder ?? exitOrder ?? defaultOrder;
        const part = order != null ? corridorParts[order - 1] : null;
        if (!part || part.length < 2 || clockHours == null) {
          clock.remove();
          return;
        }
        clockEl.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>+${clockHours} h</span>`;
        clock.setLngLat(part[Math.floor(part.length / 2)] as [number, number]).addTo(map);
      };
      if (!isRealtimeEndpoint) {
        forecastDefault(data);
        map.on("click", "carriageway", (e: mapboxgl.MapLayerMouseEvent) => {
          const o = Number((e.features?.[0]?.properties as { segment_order?: number } | undefined)?.segment_order);
          if (Number.isFinite(o)) {
            clickedOrder = o;
            placeClock();
          }
        });
      }
      applyExitRef.current = (name) => {
        if (disposed) return;
        const i = name ? CORRIDOR_BY_KM.findIndex((x) => x.exit_name.toLowerCase().trim() === name.toLowerCase().trim()) : -1;
        exitOrder = i < 0 ? null : Math.min(i + 1, CORRIDOR_BY_KM.length - 1);
        if (name) clickedOrder = null;
        placeClock();
        markSelectedPin?.(name);
      };
      let markSelectedPin: ((name: string | undefined) => void) | null = null;

      // Point Hover


      /* Where the live reports are, so the plaza pins can get out of their way.
         Declared out here rather than beside the plazas, because renderAlerts
         fills it and the plaza declutter reads it. */
      const reportPins: [number, number][] = [];

      /* Set by the plaza block below. renderAlerts calls it once the reports
         have moved, so a plaza that has just been uncovered — or has just
         started covering something — is re-evaluated straight away rather than
         waiting for the reader to pan. */
      let rethinkPlazaPins: (() => void) | null = null;

      // Toll Plaza HTML Markers — All 20 NLEX exits with exact coordinates from
      // official data.
      //
      // Drawn on the forecast map too. These pins are infrastructure: the name,
      // the municipality, the toll system. Nothing in the card is a live
      // reading, so there is nothing here that would be untrue of a map showing
      // next Tuesday — and without them the forecast was a coloured line with
      // no way to tell which exit any stretch of it belonged to.
      {
        /* Names here are written as they are stored, and restored to their
           proper casing at the point of display by displayExitName -- the same
           function the rest of the dashboard uses. The stored spelling is
           title-cased, which mangles the initialisms ("Cdv/Ph Arena" for
           CDV/PH), and it cannot simply be corrected: exit_name is a match key
           as well as a label, joining the live feed, the volume rows and the
           ETL's canonical plaza list. Fixing the caption in place here would
           have left this one list disagreeing with all of them. */
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
        const plazaPins: { el: HTMLElement; lngLat: [number, number]; name: string; index: number }[] = [];

        tollPlazas.forEach(toll => {
          const el = document.createElement("div");
          el.className = "custom-toll-marker";
          /* No label on the pin. It used to sit under every pin permanently,
             collided into an unreadable stack south of Pulilan, and was moved to
             hover — but hovering also opens the card, which names the plaza
             properly, so the label was a second copy of the name floating over
             the card that had just replaced it. */
          /* The name rides alongside from the middle zooms on, where there is
             room for it. Zoomed out it is left off: twenty names along the
             corridor is soup, and the shape alone is enough to say "exit". */
          /* Night Corridor: the plate carries the km post too, from the same
             exit list the card and the exit picker read, and major
             interchanges are marked so they keep their names at corridor zoom. */
          const kmStat = FALLBACK_EXITS.find(
            (x) => x.exit_name.toLowerCase().trim() === toll.name.toLowerCase().trim(),
          );
          el.dataset.major = MAJOR_EXITS.has(toll.name.toLowerCase().trim()) ? "1" : "0";
          el.dataset.exit = toll.name.toLowerCase().trim();
          el.innerHTML = `
            <div class="toll-pin">
              <div class="toll-pin-dot">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                     stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 20V9.5a1 1 0 0 1 .55-.9l7-3.5a1 1 0 0 1 .9 0l7 3.5a1 1 0 0 1 .55.9V20" />
                  <path d="M2 20h20M9 20v-5h6v5" />
                </svg>
              </div>
              <span class="toll-pin-name">${displayExitName(toll.shortName)}${
                kmStat ? `<span class="toll-pin-km">Km ${fmtKm(kmStat.km)}</span>` : ""
              }</span>
            </div>
          `;

          /* Above the report pins. A report lands on the carriageway, which is
             where the plaza sits, so when the two coincided the report took the
             hover and the plaza underneath could not be reached. */
          el.style.zIndex = "6";

          const marker = new mapboxgl.Marker({ element: el })
            .setLngLat(toll.coordinates as [number, number])
            .addTo(map);

          plazaPins.push({
            el,
            lngLat: toll.coordinates as [number, number],
            name: displayExitName(toll.shortName),
            /* Position along the corridor, which is the order this list is
               written in. The side a name opens on is derived from it, so the
               side is a property of the EXIT rather than of the view. */
            index: plazaPins.length,
          });

          el.addEventListener("mouseenter", () => {
            /* The same card the queues use, in the exit's own colour, because
               the two are read one after the other on the same map and were
               built as different objects: one a tight table of measurements,
               the other three stacked paragraphs.

               It also said less than it looked like it did. "Angeles / Angeles
               City, Pampanga / Exit to Angeles City, Pampanga. / Toll system ·
               Closed system toll" is the location twice and the word toll three
               times. The place is stated once now, and the room that frees goes
               to things the reader cannot see on the map: how far along the
               corridor this is, and which directions it can be used from. */
            const stat = FALLBACK_EXITS.find(
              (x) => x.exit_name.toLowerCase().trim() === toll.name.toLowerCase().trim(),
            );

            const nb = stat ? accessLabel(stat, "NB") : null;
            const sb = stat ? accessLabel(stat, "SB") : null;
            const access =
              nb && sb && nb === sb ? `${nb}, both ways`
              : nb && sb ? `NB ${nb} · SB ${sb}`
              : nb ? `NB ${nb}`
              : sb ? `SB ${sb}`
              : null;

            /* The description is kept only where it says something the two
               lines above do not. Half of them are the name and the town again
               in a full sentence -- "Interchange for Meycauayan, Bulacan." --
               and half carry something real, like which system the toll changes
               to at Bocaue Barrier. Comparing the words rather than listing the
               entries by hand means a new plaza is judged on what it says. */
            const STOP = new Set([
              "exit", "entry", "to", "for", "the", "and", "of", "at", "a", "an",
              "interchange", "point", "toll", "plaza", "nlex", "city",
            ]);
            const words = (v: string) =>
              v.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
            const known = new Set([...words(toll.name), ...words(toll.location)]);
            const adds = words(toll.description).some((w) => !STOP.has(w) && !known.has(w));

            const row = (label: string, value: string) =>
              `<div class="mjp-row"><span>${label}</span><b>${value}</b></div>`;

            const description = `
              <div class="mjp">
                <div class="mjp-head is-exit">
                  ${esc(displayExitName(toll.name))}
                  <!-- The exit's official km post, printed whole. -->
                  <span>${stat ? `km ${fmtKm(stat.km)}` : esc(toll.type)}</span>
                </div>
                ${row("Where", esc(toll.location))}
                ${access ? row("Access", esc(access)) : ""}
                ${row("Toll", esc(toll.rates.replace(/\s*toll\s*$/i, "")))}
                ${adds ? `<p class="mjp-note">${esc(toll.description)}</p>` : ""}
              </div>
            `;
            plazaCard.show(toll.coordinates as [number, number], description);
          });

          el.addEventListener("mouseleave", () => {
            plazaCard.remove();
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
        /* An exit is drawn at the weight the zoom can carry.
           A 26 px badge is right when the reader is looking at one interchange
           and far too heavy across 78 km of corridor: twenty of them dominated
           the road, and any of them landed on top of the congestion beside it.
           So the badge becomes a node -- a small ringed dot, the way a transit
           map marks a station -- and grows back into the full pin on the way
           in. At the smaller sizes it no longer swallows what it sits next to,
           so it is hidden far less often. */
        const plazaTier = (z: number) => (z < 11.5 ? "far" : z < 13.5 ? "mid" : "near");
        /* Kept in step with the rendered sizes in globals.css -- and with the
           NAME, from the middle zooms on. Spacing on the marker alone let two
           rings stand clear while their labels ran through each other, which
           is how Balagtas and Tabang ended up overlapping. What has to be kept
           apart is the whole mark, so the gap grows where the name does. It is
           measured vertically, which is where these labels stack: they sit on
           one line each, so the height that matters is the text, not its
           length. */
        const TIER_GAP_PX = { far: 26, mid: 30, near: 34 } as const;

        /* Names are set out on LEADERS -- a rule running from the ring out to a
           plate placed clear of the road -- rather than pressed against the
           marker.

           The leader is always HORIZONTAL, and that is the whole trick. Two
           horizontal rules at different heights cannot cross, so however many
           names are out at once none of them ever tangles, and a name is found
           by running the eye straight out from its ring with nothing to follow.
           An earlier attempt let names step up and down the corridor as well,
           which crossed, and looked like a diagram of string.

           Sides alternate by position along the corridor and do not depend on
           the view, so a name stays on the side the reader last saw it on
           however they pan. It flips only where the plate would otherwise run
           off the edge of the map. Alternating also halves the crowding before
           any search begins: neighbouring exits set out in opposite directions,
           so their plates start nowhere near each other. */
        const DOT_W = { far: 13, mid: 17, near: 26 } as const;
        /* The shortest reach, and it is deliberately not the shortest that
           fits. Hard against the ring, a plate sits on the carriageway it is
           naming and the rule is too short to read as a rule -- the name looks
           dropped there rather than placed. Setting every name out by the same
           minimum is what makes a screenful of them look deliberate. */
        const LEAD_BASE = { far: 32, mid: 32, near: 38 } as const;
        const LEAD_STEP = 14;

        /* How hard a name is allowed to work to find a place, and how much air
           it has to leave around itself. Both are set by the zoom, and both
           tighten as the view widens.

           Zoomed out, twenty exits share a few hundred pixels and there is no
           arrangement of twenty names that is worth reading. A name that can
           only fit by reaching most of the way across the map is not being
           placed, it is being crammed, and the map it leaves behind is a wall
           of plates with the road somewhere underneath. So at the corridor view
           a name gets three tries and stands down if none of them is clear --
           the names that survive are the ones with room around them, which is
           what makes the view calm.

           Zoomed in the constraint disappears on its own, because the exits
           have spread out, so the search is allowed to run and everything is
           named. */
        const LEAD_TRIES = { wide: 2, mid: 6, near: 16 } as const;

        /* Clearance around a placed plate. Air is what stops a group of names
           reading as one block, and the less room there is the more of it each
           name needs to stay separate. */
        const PLATE_PAD = { wide: 18, mid: 9, near: 3 } as const;

        /* Names are thinned on their own zoom scale, not the one that sizes the
           rings.

           plazaTier calls everything below z11.5 "far", which is right for a
           marker -- a ring is small until you are close. It is wrong for a
           name: at z9 the whole corridor is on screen and twenty names cannot
           be read, while at z11 there are four exits in view with room to
           spare, and holding both to the same rule gave six names out of nine
           at a zoom where all nine would have been fine. */
        const labelBand = (z: number) => (z < 10.3 ? "wide" : z < 12.5 ? "mid" : "near");
        const LABEL_H = 15;
        /* How much height a leader claims.

           It is not the thickness of the rule, which is a pixel and a half. It
           is how far another leader has to be before the two stop reading as a
           pair. Four exits within a few pixels of each other at Bocaue each ran
           a long rule out to the same side, and four near-parallel lines an
           inch apart read as a bundle of wires laid over the map rather than as
           four names pointing at four places. Claiming real height forces them
           apart or makes the extra ones stand down, and either is better than
           the bundle.

           It shrinks as the view tightens, because by then the exits have
           separated on their own and a tall band would only cost names that
           had room. */
        const LEAD_H = { wide: 24, mid: 14, near: 8 } as const;

        type Box = { x0: number; x1: number; y0: number; y1: number };
        const overlaps = (a: Box, b: Box) =>
          a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

        /* Plate widths come from the DOM rather than from a guess at the
           character count, and are cached per tier: they change with the type
           size and with nothing else, so this is one layout per zoom band
           rather than one per frame of a pan. */
        const plateW = new Map<HTMLElement, number>();
        let measuredTier: string | null = null;

        /* The worst state standing on each exit, worked out once per change of
           the feed rather than once per pin per frame. The live map compares an
           exit against a handful of short jam lines, which is cheap either way;
           the forecast map compares it against thirty-eight corridor segments
           of a hundred vertices each, and doing that on every mousemove of a
           pan is three quarters of a million distance tests a second. */
        const plateLevel = new Map<HTMLElement, number>();
        let levelVersion = -1;

        /* How far an exit is from a queue, on the GROUND, in metres.

           The colour on a plate used to come from the same pixel test that
           decides whether two pins overlap, and those are different questions.
           Thirty pixels is thirty metres zoomed in and more than a kilometre
           zoomed out, so Harbor Link wore "slow" for a queue measured 700 m up
           the road and shed it again on the way in: the map claiming traffic
           until the reader looked closely enough to catch it out.

           Fixed 15N scaling, the same projection lib/corridor-shape.ts uses,
           so a distance measured here and a distance measured there are the
           same number.

           Measured to the nearest point of the whole queue, not to its head.
           A queue that begins three kilometres back and ends at this
           interchange is on this interchange, and the head is the only part of
           it that is not. */
        const M_LON = 111320 * Math.cos((15 * Math.PI) / 180);
        const M_LAT = 110574;
        const metresToQueue = (p: [number, number], line: [number, number][]) => {
          const px = p[0] * M_LON;
          const py = p[1] * M_LAT;
          if (line.length === 1) return Math.hypot(px - line[0][0] * M_LON, py - line[0][1] * M_LAT);
          let best = Infinity;
          for (let i = 1; i < line.length; i++) {
            const ax = line[i - 1][0] * M_LON;
            const ay = line[i - 1][1] * M_LAT;
            const dx = line[i][0] * M_LON - ax;
            const dy = line[i][1] * M_LAT - ay;
            const len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
            best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
          }
          return best;
        };

        /* Close enough that the queue is AT this interchange rather than on the
           stretch beyond it. The exits either side are kilometres away, so
           nothing hangs on the exact figure: it only has to be wider than a
           junction and narrower than the gap between two exits. */
        const EXIT_QUEUE_M = 450;

        const declutterPlazas = () => {
          const tier = plazaTier(map.getZoom());
          for (const pin of plazaPins) pin.el.dataset.tier = tier;
          const gap = TIER_GAP_PX[tier];

          const near = (a: { x: number; y: number }, b: { x: number; y: number }, g: number) =>
            Math.abs(a.x - b.x) < g && Math.abs(a.y - b.y) < g;

          const queuePts = queuePins.map((q) => ({ p: map.project(q.at), level: q.level }));

          /* An exit with a queue on it keeps its RING hidden and its NAME.
             The two occupy the same point -- a queue starts at an interchange
             -- and hiding the whole marker to let the congestion through threw
             away the one label the reader most wants: the exit where something
             is happening. The callout already sets the name off the road, so
             only the ring is in the way. What is left is the red dot, and the
             leader running from it to the name of the exit it is at. */
          /* The worst queue standing on this exit, or -1 for none. Worst
             rather than nearest: if two are on one interchange, the name should
             carry the one that matters. */
          /* Two tests, deliberately measured in different units.

             coversPin is PIXELS: is a queue marker sitting on top of this ring?
             That is a question about the screen, and it has to move with the
             zoom, because what overlaps at one zoom is clear at the next.

             queueLevelOn is METRES: is this exit actually standing on a queue?
             That is a question about the road, and it must NOT move with the
             zoom, because the road does not. */
          const coversPin = (q: { x: number; y: number }) =>
            queuePts.some((k) => near(k.p, q, gap));
          if (levelVersion !== stateVersion) {
            // Forecast: its predicted queues where it has them, plus any
            // segment still coloured whole because it had no queue to draw.
            const source = isRealtimeEndpoint ? queuePins : [...queuePins, ...segmentState];
            for (const pin of plazaPins) {
              plateLevel.set(
                pin.el,
                source.reduce(
                  (worst, k) =>
                    metresToQueue(pin.lngLat, k.line) <= EXIT_QUEUE_M ? Math.max(worst, k.level) : worst,
                  -1,
                ),
              );
            }
            levelVersion = stateVersion;
          }

          /* And those exits are considered first. Keeping them in corridor
             order meant a name survived or was dropped according to where it
             happened to fall in the list, so the exits worth naming were as
             likely to go as any other. */
          const ordered = [...plazaPins]
            .map((pin) => ({ pin, q: map.project(pin.lngLat), level: plateLevel.get(pin.el) ?? -1 }))
            .sort((a, b) =>
              Number(b.level >= 0) - Number(a.level >= 0) ||
              // Then major interchanges, so they are the names that survive.
              Number(b.pin.el.dataset.major === "1") - Number(a.pin.el.dataset.major === "1"));

          if (measuredTier !== tier) {
            /* Shown first, then measured. A hidden element measures zero, so a
               name that stood down at the last tier came back with no width at
               the next one and was placed against a guess -- and a name placed
               against the wrong width is the one thing this whole arrangement
               is supposed to rule out. Every pin is about to be re-decided
               below, so nothing is lost by revealing them all here. */
            for (const pin of plazaPins) {
              pin.el.style.display = "";
              // Measured with the name showing, whatever the last band hid.
              delete pin.el.dataset.label;
            }
            for (const pin of plazaPins) {
              const plate = pin.el.querySelector(".toll-pin-name") as HTMLElement | null;
              const w = plate?.offsetWidth ?? 0;
              if (w > 0) plateW.set(pin.el, w);
            }
            measuredTier = tier;
          }

          const width = map.getCanvas().clientWidth;
          const height = map.getCanvas().clientHeight;
          const half = DOT_W[tier] / 2;
          const base = LEAD_BASE[tier];
          const band = labelBand(map.getZoom());
          const tries = LEAD_TRIES[band];
          const pad = PLATE_PAD[band];
          const leadH = LEAD_H[band];

          /* What a callout has to stay clear of: the reports, every exit ring,
             and the callouts already placed. Reports are still the thing the
             reader came to see, so a name gives way to one -- it gives way by
             reaching further out rather than by disappearing. */
          const obstacles: Box[] = reportPins
            .map((c) => map.project(c))
            .map((c) => ({ x0: c.x - 13, x1: c.x + 13, y0: c.y - 13, y1: c.y + 13 }));

          /* The rings are held separately because a callout starts AT its own
             ring and so overlaps it by definition. Lumping them in with
             everything else made every name collide with itself, and the whole
             corridor went unlabelled. */
          const rings: Box[] = ordered.map((o) => ({
            x0: o.q.x - half - 3, x1: o.q.x + half + 3,
            y0: o.q.y - half - 3, y1: o.q.y + half + 3,
          }));

          /* `lead` is measured the way the stylesheet measures it: from the
             left edge of the dot, which is where `left` on .toll-pin-name
             starts counting. */
          const boxes = (q: { x: number; y: number }, side: "east" | "west", lead: number, w: number) => {
            const plateX = side === "east" ? q.x - half + lead : q.x + half - lead - w;
            return {
              plate: { x0: plateX, x1: plateX + w, y0: q.y - LABEL_H / 2, y1: q.y + LABEL_H / 2 },
              rule: {
                x0: side === "east" ? q.x : plateX,
                x1: side === "east" ? plateX + w : q.x,
                y0: q.y - leadH / 2,
                y1: q.y + leadH / 2,
              },
            };
          };

          for (let oi = 0; oi < ordered.length; oi++) {
            const { pin, q, level } = ordered[oi];

            /* Off the top or the bottom of the map, so there is nowhere to put
               the name at all. A plate sits level with its ring and reaching
               further out only moves it sideways, so this is settled before any
               side or length is tried.

               It used to be settled nowhere. Names were bounded left and right
               and never up and down, so on a short, wide panel a name past the
               edge was placed anyway: invisible to the reader, counted as
               drawn, and holding room a name still on screen could have used.
               Measured on a 1600x840 window, five of the fourteen -- Sta. Ines
               fifty-four pixels past the edge, Balintawak thirty-six. */
            if (q.y - LABEL_H / 2 < 4 || q.y + LABEL_H / 2 > height - 4) {
              pin.el.style.display = "none";
              continue;
            }

            /* At corridor zoom only the major interchanges (and any exit with
               a queue on it) are named; the rest keep their rings and get
               their names back on the way in. */
            if (band === "wide" && level < 0 && pin.el.dataset.major !== "1") {
              pin.el.style.display = "";
              pin.el.dataset.label = "off";
              pin.el.dataset.ring = coversPin(q) ? "off" : "on";
              delete pin.el.dataset.queue;
              continue;
            }
            delete pin.el.dataset.label;

            const w = plateW.get(pin.el) ?? 60;
            const home: "east" | "west" = pin.index % 2 === 0 ? "east" : "west";
            const sides: ("east" | "west")[] = [home, home === "east" ? "west" : "east"];
            /* A PLATE has to be clear of everything. A RULE only has to be
               clear of the other plates and the reports.

               The difference is what a reader loses. A rule crossing someone
               else's name strikes it through and is unreadable; a rule passing
               close to a bare ring is a line near a circle, which costs
               nothing. Holding rules to the stricter test made every name in
               the Bocaue cluster reach past four rings it was only grazing,
               and most of them ran out of room and went unlabelled. */
            const blockedPlate = (b: Box) =>
              obstacles.some((o) => overlaps(b, o)) ||
              rings.some((r, ri) => ri !== oi && overlaps(b, r));
            const blockedRule = (b: Box) => obstacles.some((o) => overlaps(b, o));

            let placed: { side: "east" | "west"; lead: number; plate: Box; rule: Box } | null = null;
            for (const side of sides) {
              for (let i = 0; i < tries; i++) {
                const lead = base + i * LEAD_STEP;
                const b = boxes(q, side, lead, w);
                // Off the edge of the map: stop reaching that way, try the other side.
                if (b.plate.x0 < 4 || b.plate.x1 > width - 4) break;
                if (blockedPlate(b.plate) || blockedRule(b.rule)) continue;
                placed = { side, lead, plate: b.plate, rule: b.rule };
                break;
              }
              if (placed) break;
            }

            /* Nowhere to put it on either side. It stands down until there is
               room, and zooming in makes room on its own: the exits spread
               apart on screen while the plates stay the same size. */
            if (!placed) {
              pin.el.style.display = "none";
              continue;
            }

            pin.el.style.display = "";
            pin.el.dataset.side = placed.side;
            pin.el.style.setProperty("--lead", String(placed.lead) + "px");
            /* Stored with its clearance built in, and tested without it, so the
               gap between two plates comes out at exactly one pad rather than
               two. */
            obstacles.push(
              {
                x0: placed.plate.x0 - pad, x1: placed.plate.x1 + pad,
                y0: placed.plate.y0 - pad, y1: placed.plate.y1 + pad,
              },
              placed.rule,
            );
            pin.el.dataset.ring = coversPin(q) ? "off" : "on";
            /* The name carries the condition, in the same three words and the
               same three colours the legend uses. An exit standing on a queue
               is the one the reader is looking for, and it was reading exactly
               like the eleven that are clear. */
            if (level >= 3) pin.el.dataset.queue = "congested";
            else if (level >= 1) pin.el.dataset.queue = "slow";
            else delete pin.el.dataset.queue;
          }
        };

        rethinkPlazaPins = declutterPlazas;
        markSelectedPin = (name) => {
          const k = (name ?? "").toLowerCase().trim();
          for (const pin of plazaPins) {
            if (k && pin.el.dataset.exit === k) pin.el.dataset.selected = "on";
            else delete pin.el.dataset.selected;
          }
        };
        markSelectedPin(selectedExitRef.current);
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
        reportPins.length = 0;

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

          /* Nobody has corroborated this one yet. The ring is set here rather
             than in the stylesheet because the core carries an inline
             "border: ... !important", and an inline !important outranks an
             author rule, so a CSS border-style never applied. */
          const unconfirmed = isUnconfirmedReport(props);

          const el = document.createElement("div");
          el.className = `waze-alert-marker${unconfirmed ? " unconfirmed" : ""}`;
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
                border: 2px ${unconfirmed ? "dashed" : "solid"} #ffffff !important;
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
          /* Which way the report faces, ahead of where it is. On a corridor
             where both directions are drawn separately, "southbound" is often
             the first thing that decides whether it matters to the reader. */
          const dirText = directionLabel(props.street as string | undefined, props.heading as number | undefined);

          const exitText = props.nearest_exit
            ? Number.isFinite(Number(props.exit_distance_m))
              ? `${Number(props.exit_distance_m) < 950
                  ? `${Math.round(Number(props.exit_distance_m) / 10) * 10} m`
                  : `${(Number(props.exit_distance_m) / 1000).toFixed(1)} km`} from ${props.nearest_exit}`
              : `near ${props.nearest_exit}`
            : (props.street ?? "On the corridor");

          const summary = `
            <div class="nlex-pop" style="--pop-accent:${color}">
              <div class="nlex-pop-head">
                <span class="nlex-pop-mark">${look.svg}</span>
                <span class="nlex-pop-name">
                  <span class="nlex-pop-title">${look.label}</span>
                  <span class="nlex-pop-sub">${dirText ? `${dirText} &middot; ` : ""}${exitText}</span>
                </span>
              </div>
              <div class="nlex-pop-foot">Click for the full report</div>
            </div>
          `;

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
          el.addEventListener("mouseenter", () => reportCard.show(coords as [number, number], summary));
          el.addEventListener("mouseleave", () => reportCard.remove());
          el.addEventListener("click", (ev) => {
            // Without this the map's own click handler runs too and closes the
            // panel in the same gesture that opened it.
            ev.stopPropagation();
            reportCard.remove();
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
              first_report_at: props.first_report_at ?? null,
              reports_here: props.reports_here ?? null,
              uuid: props.uuid ?? null,
              lon: Array.isArray(coords) ? Number(coords[0]) : null,
              lat: Array.isArray(coords) ? Number(coords[1]) : null,
            });
            map.flyTo({ center: coords as [number, number], zoom: Math.max(map.getZoom(), 12), duration: 600 });
          });

          alertMarkersRef.current.push(marker);
          reportPins.push(coords as [number, number]);
        });

        rethinkPlazaPins?.();
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

      /* ---- Night Corridor: strip snapshot, jam callouts, motion, 3D ------- */
      const alertOf = (p: Record<string, unknown>, coords: [number, number]): StripAlert | null => {
        if (!Number.isFinite(coords?.[0]) || !Number.isFinite(coords?.[1])) return null;
        const { dir } = directionOfReport(p.street, p.heading);
        return {
          km: K.locate(coords).km,
          dir,
          type: String(p.type ?? ""),
          unconfirmed: isUnconfirmedReport(p),
          detail: reportDetailOf(p, coords) as unknown as Record<string, unknown>,
        };
      };
      let lastFeedAt = "";
      const emitSnapshot = (fc: GeoJSON.FeatureCollection, corridor: GeoJSON.FeatureCollection) => {
        lastFeedAt = String((fc as { feed?: { newestAt?: string } }).feed?.newestAt ?? "");
        onSnapshotRef.current?.(buildSnapshot({
          kind: isRealtimeEndpoint ? "live" : "forecast",
          feed: fc,
          corridor,
          exitKmByOrder,
          alertOf,
        }));
      };

      // Jam callout, part 2: the leader-line labels.
      const callouts = createJamCallouts(map, mapboxgl.Marker, map.getContainer());
      let layoutRaf = 0;
      const scheduleLayout = () => {
        if (layoutRaf) return;
        layoutRaf = requestAnimationFrame(() => {
          layoutRaf = 0;
          if (disposed) return;
          callouts.layout();
          if (ringOn) placeRing();
        });
      };
      map.on("move", scheduleLayout);
      callouts.set(data.features ?? []);

      /* The animation loop: steps the flow dashes' line-dasharray and the jam
         glow, at most 30 times a second, only while someone can see it. */
      let hasMotion = false;
      const noteMotion = (fc: GeoJSON.FeatureCollection) => {
        hasMotion = (fc.features ?? []).some((f) => {
          const q = f.properties as Record<string, unknown> | null;
          return q?.feature_type === "jam" && q?.direction_source != null;
        });
      };
      noteMotion(data);
      let animRaf = 0;
      let lastFrame = 0;
      const shouldRun = () =>
        !disposed && hasMotion && !reducedRef.current && visibleRef.current && !pausedRef.current && !document.hidden;
      const frame = (now: number) => {
        animRaf = 0;
        if (!shouldRun()) return;
        if (now - lastFrame >= 33) {
          lastFrame = now;
          for (const L of flowLayers) {
            const s = dashPhase(now, L.rate, L.dir);
            if (s !== L.key) {
              L.key = s;
              map.setPaintProperty(L.id, "line-dasharray", dashAt(s));
            }
          }
          map.setPaintProperty("lm-jam-pulse", "line-opacity", 0.14 + 0.26 * (0.5 + 0.5 * Math.sin((now / 2400) * Math.PI * 2)));
        }
        animRaf = requestAnimationFrame(frame);
      };
      kickRef.current = () => {
        if (!animRaf && shouldRun()) animRaf = requestAnimationFrame(frame);
      };
      applyMotionRef = () => {
        if (disposed) return;
        const vis = reducedRef.current ? "none" : "visible";
        for (const L of flowLayers) map.setLayoutProperty(L.id, "visibility", vis);
        if (reducedRef.current) map.setPaintProperty("lm-jam-pulse", "line-opacity", 0.28);
      };
      kickRef.current();

      /* Optional 3D: tilt to about 50 degrees, and extrude buildings only if
         the basemap has a building layer to extrude. 2D north-up otherwise. */
      const ensureBuildings = () => {
        if (map.getLayer("lm-buildings-3d")) return true;
        const b = (map.getStyle().layers ?? []).find(
          (l) => (l as { "source-layer"?: string })["source-layer"] === "building" && typeof (l as { source?: unknown }).source === "string",
        ) as { source: string } | undefined;
        if (!b) return false;
        try {
          map.addLayer(
            {
              id: "lm-buildings-3d",
              type: "fill-extrusion",
              source: b.source,
              "source-layer": "building",
              minzoom: 13,
              layout: { visibility: "none" },
              paint: {
                "fill-extrusion-color": isDark ? "#1a2236" : "#d9dde5",
                "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 0],
                "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
                "fill-extrusion-opacity": 0.75,
              },
            },
            "nlex-halo",
          );
          return true;
        } catch {
          return false;
        }
      };
      applyPitchRef.current = (on) => {
        if (disposed) return;
        map.easeTo({ pitch: on ? 50 : 0, bearing: 0, duration: reducedRef.current ? 0 : 700 });
        if (ensureBuildings()) map.setLayoutProperty("lm-buildings-3d", "visibility", on ? "visible" : "none");
      };
      if (pitchedRef.current) applyPitchRef.current(true);

      placeClock();
      if (highlightRef.current) applyHighlightRef.current?.(highlightRef.current);
      if (selectedExitRef.current) applyExitRef.current?.(selectedExitRef.current);

      const afterPoll = (
        fresh: GeoJSON.FeatureCollection,
        corridorNow: GeoJSON.FeatureCollection,
        feedChanged: boolean,
        corridorChanged: boolean,
      ) => {
        if (feedChanged) {
          callouts.set(fresh.features ?? []);
          noteMotion(fresh);
          kickRef.current?.();
          if (!isRealtimeEndpoint) {
            forecastDefault(fresh);
            placeClock();
          }
        }
        const feedAt = String((fresh as { feed?: { newestAt?: string } }).feed?.newestAt ?? "");
        if (feedChanged || corridorChanged || feedAt !== lastFeedAt) emitSnapshot(fresh, corridorNow);
      };
      cleanupGraphics = () => {
        callouts.clear();
        ring.remove();
        clock.remove();
        if (layoutRaf) cancelAnimationFrame(layoutRaf);
        if (animRaf) cancelAnimationFrame(animRaf);
        if (hoverRaf) cancelAnimationFrame(hoverRaf);
        kickRef.current = null;
        applyPitchRef.current = null;
        applyHighlightRef.current = null;
        applyClosuresRef.current = null;
        applyExitRef.current = null;
      };
      emitSnapshot(data, corridorAtLoad);

      if (isRealtime) {
        renderAlerts(data);
      }

      const source = map.getSource("traffic") as GeoJSONSource;
      pollTimer = setInterval(async () => {
        if (disposed) return;
        try {
          const fresh = onlyOnCorridor(withPredictedQueues(
            await fetch(endpoint, { cache: "no-store" }).then((r) => r.json()),
          ));

          const feedSig = signature(fresh);
          const feedChanged = feedSig !== lastFeedSig;
          if (feedSig !== lastFeedSig) {
            lastFeedSig = feedSig;
            source.setData(fresh);
            // Markers are torn down and rebuilt, so they only move when the
            // reports do.
            if (isRealtime) renderAlerts(fresh);
          }

          const corridorNow = corridorWithState(fresh);
          const corridorSig = signature(corridorNow);
          const corridorChanged = corridorSig !== lastCorridorSig;
          if (corridorSig !== lastCorridorSig) {
            lastCorridorSig = corridorSig;
            setSegmentState(corridorNow);
            /* Which tiers are on screen no longer needs tracking here: Mapbox
               calls render() only for images a visible layer is using, so a
               tier with no segments costs nothing on its own. */
            (map.getSource("nlex-corridor") as GeoJSONSource | undefined)?.setData(corridorNow);
          }
          afterPoll(fresh, corridorNow, feedChanged, corridorChanged);
        } catch {
          // No-op polling fallback
        }
      }, 15000);
    });

    return () => {
      disposed = true;
      cleanupGraphics?.();
      io.disconnect();
      motionQuery.removeEventListener("change", onMotionPref);
      document.removeEventListener("visibilitychange", onVisibility);
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
    <article className={`map-card${chromeless ? " chromeless" : ""}`} data-kind={endpoint.includes("real-time") ? "live" : "forecast"}>
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

            {/* When this kind of thing was FIRST reported at this spot.

                The live feed is one snapshot, so the line above is only this
                report's own publication: a hazard at a site that has been
                reported on and off for weeks still reads as an hour old. The
                warehouse remembers every report it has ingested, so this is the
                earliest of them within 150 m, of this same kind.

                Not windowed, by request -- it reaches back as far as the
                history goes, which on this corridor is currently about seven
                weeks. That makes it a fact about the PLACE, not about this
                problem, and the count is shown beside it so it cannot be read
                as one unbroken closure: "64 reports here since 7 Aug" says what
                it is. With no earlier record the first report is this one, and
                the line says so rather than inventing a date. */}
            {(() => {
              const first = selectedReport.first_report_at ?? selectedReport.reported_at;
              if (!first) return null;
              const n = selectedReport.reports_here ?? 0;
              const earlier = selectedReport.first_report_at != null && n > 1;
              return (
                <p className="wz-rd-first">
                  <span className="wz-rd-first-k">First report</span>
                  <span className="wz-rd-first-v">
                    {new Date(first).toLocaleString()}
                    <em>
                      {earlier
                        ? `${n} reports here since then`
                        : "no earlier report on record here"}
                    </em>
                  </span>
                </p>
              );
            })()}

            <dl className="wz-rd-grid">
              {selectedReport.reliability != null && (
                <div><dt>Reliability</dt><dd>{selectedReport.reliability}/10</dd></div>
              )}
              {selectedReport.confidence != null && (
                <div><dt>Confidence</dt><dd>{selectedReport.confidence}/10</dd></div>
              )}
              {/* "Rating", not "Report rating": the longer label wrapped onto two
                  lines in a third-width column and pushed its value out of line
                  with the two beside it. Next to Reliability and Confidence it
                  is unambiguous. */}
              {selectedReport.report_rating != null && (
                <div><dt>Rating</dt><dd>{selectedReport.report_rating}/5</dd></div>
              )}
              {selectedReport.nearest_exit && (
                <div className="wz-rd-wide">
                  <dt>Nearest exit</dt>
                  <dd>
                    {/* Which SIDE of the plaza, not just how far from it. A
                        distance alone leaves the reader to guess whether they
                        meet this before the toll or after, which is the thing
                        they are looking at the card to find out. Same wording
                        and the same measurement as the queue card. */}
                    {(() => {
                      const { dir } = directionOfReport(selectedReport.street, selectedReport.heading);
                      const at =
                        selectedReport.lon != null && selectedReport.lat != null
                          ? ([selectedReport.lon, selectedReport.lat] as [number, number])
                          : null;
                      const w = dir && at ? queueWhere(at, dir) : null;
                      const k = w?.rel_kind;
                      const a = w?.rel_a;
                      const b = w?.rel_b;
                      const m = w?.rel_m;
                      if (k === "at" && a) return `At ${plazaLabel(a)}`;
                      if (k === "past" && a && m != null) return `${fmtM(m)} past ${plazaLabel(a)}`;
                      if (k === "before" && a && m != null) return `${fmtM(m)} before ${plazaLabel(a)}`;
                      if (k === "between" && a && b) {
                        return `Midway between ${plazaLabel(a)} and ${plazaLabel(b)}`;
                      }
                      return (
                        <>
                          {selectedReport.nearest_exit}
                          {selectedReport.exit_distance_m != null && (
                            <span className="wz-rd-note">
                              {selectedReport.exit_distance_m < 1000
                                ? ` ${selectedReport.exit_distance_m} m away`
                                : ` ${(selectedReport.exit_distance_m / 1000).toFixed(1)} km away`}
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </dd>
                </div>
              )}
              {(() => {
                /* Worked out here rather than carried on the record, so a
                   report opened from the alerts list says the same thing as one
                   clicked on the map -- the list hands over its own row and
                   knows nothing about the corridor. */
                const { dir, source } = directionOfReport(selectedReport.street, selectedReport.heading);
                if (!dir) return null;
                return (
                  /* Full width: "Southbound" plus where it was read from does
                     not fit a third of the card, and wrapped it collided with
                     the row beneath. */
                  <div className="wz-rd-wide">
                    <dt>Direction</dt>
                    <dd>
                      {dir === "NB" ? "Northbound" : "Southbound"}
                      <span className="wz-rd-note">
                        {source === "street" ? " from road name" : " from heading"}
                      </span>
                    </dd>
                  </div>
                );
              })()}
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
                <div className="wz-rd-wide">
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


