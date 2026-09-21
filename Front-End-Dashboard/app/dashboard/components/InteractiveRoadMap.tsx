"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cachedJson } from "../../../lib/cached-json";

/* ══════════════════════════════════════════════════════════════════════════════
   OFFICIAL NLEX STATION DEFINITIONS
   Each station carries: km marker · display name · per-direction access type.
   "toll-barrier" nodes (Bocaue Barrier) are flagged separately from ramp nodes.
══════════════════════════════════════════════════════════════════════════════ */

import { useNlexExits, accessLabel, displayExitName, type NlexExit } from "../../../lib/nlex-exits";

/* Twelve vehicles per carriageway, across three lanes, and they drive the road
 * they are on.
 *
 * Twelve cars at a fixed pace were decoration and had to say so, because a
 * stream of traffic running at the same speed over a red stretch contradicts
 * the red stretch. A car that CRAWLS where the band is red and runs where the
 * road is clear says the same thing the colours say, in the one language that
 * needs no key at all -- a reader watching it hesitate at Meycauayan has read
 * the panel without reading anything.
 *
 * They all share ONE speed profile, built once from the bands, and differ only
 * in where they start. That is what keeps them honest: every car slows over
 * the same stretch, so none can be seen sailing through a queue another is
 * stuck in. It also gives the bunching for free -- a constant head start in
 * TIME is a shrinking gap in SPACE wherever the road is slow, so they close up
 * inside a queue and string out again on clear tarmac, which is what traffic
 * does.
 *
 * Measured on the running panel: a car crosses a red band at 0.51% of the
 * track per second against 4.26% on clear road, so the crawl is 8.4x slower
 * than the run.
 *
 * The speeds are not measurements. This panel knows a queue's class, not the
 * speed of the traffic in it, so the figures below are chosen for order and
 * legibility: red slower than amber slower than clear. The measurements are
 * the band, and the metres and delay on the rail above it.
 */
const CAR_SPEED: Record<string, number> = { "seg-red": 0.12, "seg-orange": 0.4 };

/* Twelve of them, and not twelve of the same thing: an expressway carries
 * buses and container trucks as well as cars, and a strip of identical dashes
 * reads as a pattern where a mixed stream reads as traffic.
 *
 * No motorcycles. NLEX does not allow them on the mainline, and a panel about
 * this road should not show something that cannot be on it.
 *
 * The heavy vehicles are all in one lane, which is both how they are driven
 * and what makes the spacing work. Vehicles in a lane share a profile and
 * differ only in phase, so the gap between two of them is smallest in the
 * slowest zone, and it has to stay wider than the vehicle in front. Worked out
 * for the worst case -- a queue present, so there is a slow zone at all, and
 * the track at its narrowest 940 px:
 *
 *   lane 1   5 cars      gap 27 px   car 18 px
 *   lane 2   4 mixed     gap 34 px   van 22 px
 *   lane 3   3 heavy     gap 45 px   bus 28 px
 *
 * so they close right up in a queue, which is the point, and still cannot
 * overlap. A fifth heavy vehicle in lane 3 would break that.
 *
 * Those are bounds, not readings. Measured on the running panel with the
 * queues that happened to be live, the tightest gap seen was 86 px behind an
 * 18 px car, with no overlap at any sampled frame.
 */
const CAR_LANES = [
  // Lane 1 -- light traffic, closest spacing.
  { lane: 1, phase: 0.0, kind: "car", paint: "#eef2f7" },
  { lane: 1, phase: 0.2, kind: "car", paint: "#b9c6d6" },
  { lane: 1, phase: 0.4, kind: "car", paint: "#dfe7f0" },
  { lane: 1, phase: 0.6, kind: "car", paint: "#aebdd0" },
  { lane: 1, phase: 0.8, kind: "car", paint: "#cdd8e5" },
  // Lane 2 -- cars and vans.
  { lane: 2, phase: 0.09, kind: "car", paint: "#f4f7fb" },
  { lane: 2, phase: 0.34, kind: "van", paint: "#c3cfdd" },
  { lane: 2, phase: 0.59, kind: "car", paint: "#dfe7f0" },
  { lane: 2, phase: 0.84, kind: "van", paint: "#aebdd0" },
  // Lane 3 -- buses and container trucks.
  { lane: 3, phase: 0.17, kind: "truck", paint: "#e7edf4" },
  { lane: 3, phase: 0.5, kind: "bus", paint: "#cbd6e3" },
  { lane: 3, phase: 0.83, kind: "truck", paint: "#b9c6d6" },
] as const;

/** Milliseconds for one clear run of the whole corridor. */
const CAR_CLEAR_MS = 17000;

/* A little past each end, so the car arrives and leaves rather than popping
   into existence at the kerb. */
const CAR_IN = -0.04;
const CAR_OUT = 1.04;

/* A queue can be drawn narrower than the car is long -- a 9% band on one of
   nineteen blocks is about six pixels, and a car cannot visibly slow over
   less than its own length. The slow zone is widened to this minimum about
   the band's own centre. It is a drawing accommodation, not a claim: the
   band keeps its true width, and it is the band that is being measured. */
const CAR_MIN_ZONE = 0.018;

type Band = { pct: number; colorClass: string } | null;

/**
 * The car's run, as Web Animations keyframes plus the track position at each
 * one, built from the SAME bands the carriageway draws.
 *
 * Linear keyframes with uneven offsets: every piece of road is crossed at a
 * constant speed, and the speed changes where the colour does. That is what
 * makes the car appear to brake and pull away rather than ease about.
 */
function carJourney(bands: Band[], dir: "NB" | "SB") {
  const n = bands.length || 1;
  const zones: { a: number; b: number; speed: number }[] = [];

  bands.forEach((band, i) => {
    if (!band) return;
    const speed = CAR_SPEED[band.colorClass];
    if (!speed) return;
    const w = band.pct / 100 / n;
    /* Anchored where the band is drawn: the block's left edge going north,
       its right edge going south, because a block is the road ahead of its
       exit and the two directions run opposite ways along one axis. */
    const a = dir === "NB" ? i / n : (i + 1) / n - w;
    const mid = a + w / 2;
    const half = Math.max(w, CAR_MIN_ZONE) / 2;
    zones.push({ a: mid - half, b: mid + half, speed });
  });

  const edges = new Set<number>([CAR_IN, CAR_OUT]);
  for (const z of zones) {
    if (z.a > CAR_IN && z.a < CAR_OUT) edges.add(z.a);
    if (z.b > CAR_IN && z.b < CAR_OUT) edges.add(z.b);
  }
  const xs = [...edges].sort((p, q) => p - q);

  const pieces: { from: number; to: number; speed: number }[] = [];
  for (let i = 1; i < xs.length; i++) {
    const mid = (xs[i - 1] + xs[i]) / 2;
    // Slowest wins where two queues overlap: the car is held by the worse one.
    const speed = zones.reduce((sp, z) => (mid >= z.a && mid < z.b ? Math.min(sp, z.speed) : sp), 1);
    pieces.push({ from: xs[i - 1], to: xs[i], speed });
  }

  const total = pieces.reduce((sum, pc) => sum + (pc.to - pc.from) / pc.speed, 0);
  const order = dir === "NB" ? pieces : [...pieces].reverse();

  const stops = [{ offset: 0, x: dir === "NB" ? CAR_IN : CAR_OUT }];
  let t = 0;
  for (const pc of order) {
    t += (pc.to - pc.from) / pc.speed;
    stops.push({ offset: Math.min(1, t / total), x: dir === "NB" ? pc.to : pc.from });
  }

  return {
    stops,
    keyframes: stops.map((st) => ({ offset: st.offset, transform: `translateX(${st.x * 100}%)` })),
    durationMs: CAR_CLEAR_MS * total,
  };
}

type Journey = ReturnType<typeof carJourney>;

/** Where on the track the car is, at animation progress `p`. */
function xAtProgress(stops: Journey["stops"], p: number) {
  for (let i = 1; i < stops.length; i++) {
    if (p <= stops[i].offset) {
      const a = stops[i - 1];
      const b = stops[i];
      const t = b.offset === a.offset ? 0 : (p - a.offset) / (b.offset - a.offset);
      return a.x + t * (b.x - a.x);
    }
  }
  return stops[stops.length - 1].x;
}

/** The progress at which the car stands at `x`. The inverse of the above. */
function progressAtX(stops: Journey["stops"], x: number) {
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x)) {
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.offset + t * (b.offset - a.offset);
    }
  }
  return 0;
}



/* ══════════════════════════════════════════════════════════════════════════════
   LIVE CORRIDOR STATE

   This section used to hold three hardcoded datasets (LIVE / +1HR / +2HR). It
   now reads /api/map-comparison/real-time — the Live Map's own feed — and
   derives per-exit, per-direction status from it through the same functions the
   map draws with, so the two views cannot disagree about the road.

   It read /api/dashboard/corridor-status before, which aggregated the same jams
   in SQL but under slightly different rules: no geometric corridor test, and
   direction from bearing rather than from the street name Waze supplies. That
   was enough for this panel to call a stretch congested on the strength of a
   jam the map had discarded.

   Absence is information here: Waze only emits a record where there IS a jam, so
   an exit with no recent row is flowing freely. Every exit therefore starts clear
   and is darkened only by evidence.
══════════════════════════════════════════════════════════════════════════════ */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

/* Shared with the live map: same shapes, same derivation. */
import { corridorSegmentLevels, corridorStatusFromFeed, tallyExitStatuses, type ExitStatus, type SegmentStatus } from "../../../lib/corridor-status";
import { mapPalette } from "../../../lib/map-palette";
import { useChartTheme } from "../../../lib/chart-theme";

type CorridorStatus = {
  windowMinutes: number;
  segments: ExitStatus[];
  /* Level per `${segmentOrder}:${direction}` — what the map paints the road
     between two exits with. The panel colours its blocks from this so the two
     views show the same road in the same colour, rather than two readings of
     the same jams. */
  segmentLevels: Map<string, number>;
  feed: { newestAt: string | null; ageMinutes: number | null; stale: boolean };
};

type TrafficRecord = {
  colorClass: string;
  status: string;
  speed: string;
  level: number | null;
  jamCount: number;
  /** How far the worst queue here stretches, already formatted. Null when Waze
   *  reported nothing, so the row is left out rather than showing a zero. */
  queue: string | null;
  /** What that queue is costing, already formatted. Null when not reported. */
  delay: string | null;
  /** The same queue in metres, for drawing it against the stretch it sits in.
   *  The formatted strings above are for reading; this is for measuring. */
  queueMeters: number | null;
};

/**
 * Waze's documented jam scale: a level is a share of free-flow speed, not a
 * severity word someone chose. The bands below are the published definition —
 * which is 0-5, not 1-5, so the earlier labelling here was a level short.
 *
 * Level 0 has never appeared in this feed (Waze emits a jam only where there is
 * congestion) but it is part of the field, so it is listed rather than assumed
 * away.
 */
const JAM_SCALE: { level: number; band: string; label: string }[] = [
  { level: 0, band: "100–80% of free-flow speed", label: "free flow" },
  { level: 1, band: "80–61%", label: "light" },
  { level: 2, band: "60–41%", label: "moderate" },
  { level: 3, band: "40–21%", label: "heavy" },
  { level: 4, band: "20–1%", label: "severe" },
  { level: 5, band: "blocked road", label: "blocked" },
];

const JAM_LEVEL_LABEL: Record<number, string> = Object.fromEntries(
  JAM_SCALE.map((r) => [r.level, r.label]),
);

const CLEAR: TrafficRecord = {
  colorClass: "seg-green",
  status: "CLEAR",
  speed: "Free flowing",
  level: null,
  jamCount: 0,
  queue: null,
  delay: null,
  queueMeters: null,
};

/* Waze's six levels are six colours, and they are the map's.

   This panel used to paint three — one green, one orange, one red — from hues
   of its own that appear nowhere else. So a stretch Waze called level 3 was
   orange on the Live Map and red here, and level 2 was amber there and orange
   here. The two views agreed on the number and disagreed on the colour, which
   is the part a reader actually sees.

   Worse, the panel's own key already described all six bands while painting
   three, so it disagreed with the road beside it as well.

   Both now read mapPalette, the same table the Mapbox paint expression uses. A
   level renders in one colour across the whole dashboard, and it follows the
   theme, which the hardcoded hues never did. */
const levelColour = (palette: ReturnType<typeof mapPalette>, level: number) =>
  palette.level[Math.max(0, Math.min(5, Math.round(level))) as 0 | 1 | 2 | 3 | 4 | 5];

const COLOR_CLASS: Record<SegmentStatus, string> = {
  clear: "seg-green",
  slow: "seg-orange",
  congested: "seg-red",
};

/** Matches on name because the feed keys by exit name, as the shared list does. */
/* Metres under a kilometre, kilometres above it: "1430 m" is a number to
   convert in your head, "1.4 km" is a distance. */
const queueLabel = (m: number | null) =>
  m == null || m <= 0 ? null : m >= 1000 ? `${(m / 1000).toFixed(1)} km queued` : `${m} m queued`;

/* Seconds are how Waze ships it and minutes are how a delay is discussed. */
const delayLabel = (sec: number | null) => {
  if (sec == null || sec <= 0) return null;
  const mins = Math.round(sec / 60);
  if (mins < 1) return "under a minute lost";
  if (mins < 60) return `~${mins} min lost`;
  return `~${Math.floor(mins / 60)} h ${mins % 60} min lost`;
};

function statusKey(name: string, dir: string) {
  return `${name.toLowerCase().trim()}-${dir}`;
}

function buildLookup(data: CorridorStatus | null): Map<string, TrafficRecord> {
  const map = new Map<string, TrafficRecord>();
  if (!data) return map;
  for (const s of data.segments) {
    map.set(statusKey(s.exit, s.direction), {
      colorClass: COLOR_CLASS[s.status],
      status: s.status.toUpperCase(),
      speed: s.speedKmh != null ? `${s.speedKmh} km/h` : "—",
      level: s.level,
      jamCount: s.jamCount,
      queue: queueLabel(s.longestQueueMeters),
      delay: delayLabel(s.delaySeconds),
      queueMeters: s.longestQueueMeters,
    });
  }
  return map;
}

/** Node glyph: a hexagon with lane markings, used for every station dot. */
const HexagonRoad = () => (
  <svg width="24" height="24" viewBox="0 0 32 32" className="ds-hex-svg">
    <polygon points="16,2 30,10 30,22 16,30 2,22 2,10" fill="none" stroke="currentColor" strokeWidth="2.5" />
    <path d="M12,6 L9,26 M20,6 L23,26 M16,8 L16,12 M16,16 L16,20" stroke="currentColor" strokeWidth="2" strokeDasharray="2 3" />
  </svg>
);

/** Polls the corridor feed. 60s because the ingester writes every few minutes —
    faster would just re-fetch the same rows. */
function useCorridorStatus() {
  const [data, setData] = useState<CorridorStatus | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        /* The live map's own feed, run through the live map's own rules.
           This used to read /api/dashboard/corridor-status, which aggregated
           the same jams in SQL under slightly different ones — it skipped the
           geometric corridor test and took direction from bearing alone — so
           this panel and the map disagreed about which stretches were busy.
           Both now derive from one payload through one function. */
        // 25 s memo: the panel polls anyway, and the Live Map reads the same
        // URL, so the two share one response instead of two round trips.
        const fc = await cachedJson<Parameters<typeof corridorStatusFromFeed>[0] & { feed?: { windowMinutes?: number; newestAt?: string | null; ageMinutes?: number | null; stale?: boolean } }>(
          `${BACKEND}/api/map-comparison/real-time`, 25_000);
        if (cancelled) return;
        if (!fc?.features) throw new Error("Feed unavailable");
        setData({
          windowMinutes: fc.feed?.windowMinutes ?? 60,
          segments: corridorStatusFromFeed(fc),
          segmentLevels: corridorSegmentLevels(fc),
          feed: {
            newestAt: fc.feed?.newestAt ?? null,
            ageMinutes: fc.feed?.ageMinutes ?? null,
            stale: fc.feed?.stale ?? false,
          },
        });
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return { data, error, loading };
}


/* ══════════════════════════════════════════════════════════════════════════════
   COMPONENT
══════════════════════════════════════════════════════════════════════════════ */

export default function InteractiveRoadMap() {
  // One corridor list for every tab. See lib/nlex-exits.
  const { exits } = useNlexExits();

  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible,       setIsVisible]       = useState(false);
  const [activeStation,   setActiveStation]   = useState<string | null>(null);

  const { data: corridor, error: feedError, loading: feedLoading } = useCorridorStatus();
  const statusByExit = useMemo(() => buildLookup(corridor), [corridor]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setIsVisible(true); obs.disconnect(); } },
      { threshold: 0.1 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  /* ─── The corridor, both carriageways ─────────────────────────────────────
     Drawn as a divided highway: northbound on top, southbound below, exits in
     the median between them. One shared km axis running left to right, so a
     given exit sits at the same point on both roads and the two directions can
     be compared by looking straight down the column.

     Exits are spaced evenly rather than by true km. Several sit within a
     kilometre of each other (15.2 / 15.8 / 16.8, and 20.7 / 21.1), so a
     to-scale axis would pile their labels up at the metro end and leave the far
     end empty. */

  const [scaleOpen, setScaleOpen] = useState(false);

  /* What the reader is pointing at on the road itself, as opposed to which
     exit they are near. A band is a queue on one carriageway, so it can say
     things the exit rail cannot: how much road it covers and what it costs. */
  const [hoveredJam, setHoveredJam] = useState<{
    exit: string;
    dir: "NB" | "SB";
    status: string;
    queue: string | null;
    delay: string | null;
    level: number | null;
  } | null>(null);

  const rows = useMemo(
    () =>
      exits.map((x, i) => ({
        exit: x,
        /* The stretch each block stands for is the road ahead of that exit in
           that direction: going north it is the segment leaving exit i, going
           south the one leaving it back towards Manila. The first southbound
           block and the last northbound block have no road ahead of them, so
           they stay clear. Segment orders are 1-based. */
        nbSegment: i + 1 <= exits.length - 1 ? `${i + 1}:NB` : null,
        sbSegment: i >= 1 ? `${i}:SB` : null,
        /* How long that stretch is on the ground. The blocks are drawn at even
           width because several exits sit within a kilometre of each other, so
           a queue can only be shown against the stretch it is IN -- a fifth of
           this block means a fifth of this stretch, not a fifth of the
           corridor. */
        nbStretchM: i + 1 <= exits.length - 1 ? (exits[i + 1].km - x.km) * 1000 : null,
        sbStretchM: i >= 1 ? (x.km - exits[i - 1].km) * 1000 : null,
        nb: statusByExit.get(statusKey(x.exit_name, "NB")) ?? CLEAR,
        sb: statusByExit.get(statusKey(x.exit_name, "SB")) ?? CLEAR,
        nbAccess: accessLabel(x, "NB"),
        sbAccess: accessLabel(x, "SB"),
      })),
    [exits, statusByExit],
  );

  /* Counts across both carriageways, from the shared rule in
     lib/corridor-status so the hero strip on the same page cannot reach a
     different total. Exits with no ramp in a direction are skipped rather than
     counted clear — they draw as bare tarmac, and a tally that disagreed with
     the drawing would be worse than none. */
  const tally = useMemo(
    () => tallyExitStatuses(exits, corridor?.segments ?? []),
    [exits, corridor],
  );

  /* The hovered exit fills a reserved rail above the road rather than a floating
     tooltip, which had to be positioned somewhere and covered the row it was
     describing wherever it went. With both carriageways on screen the rail earns
     its place twice over: one hover reports the exit in both directions. */
  const focused = useMemo(
    () => rows.find((r) => r.exit.exit_name === activeStation) ?? null,
    [rows, activeStation],
  );

  useEffect(() => {
    if (!scaleOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setScaleOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scaleOpen]);

  /* ─── Header copy ─── */
  const headerSub = feedError
    ? "Feed unavailable — is the backend running on port 4000?"
    : feedLoading
      ? "Reading the Waze feed…"
      : corridor?.feed.newestAt
        ? `${corridor.feed.stale ? "Feed may be stale · last" : "Last"} report ${
            corridor.feed.ageMinutes != null && corridor.feed.ageMinutes < 1
              ? "just now"
              : `${corridor.feed.ageMinutes} min ago`
          } · ${corridor.windowMinutes}-minute window`
        : "No jam reports on the corridor right now";

  const railFacts = (label: string, data: TrafficRecord, access: string | null) => (
    <span className="ds-rd-rail-dir">
      <span className="ds-rd-rail-dirname">{label}</span>
      <span className="ds-rd-facts">
        {access === "No Access" ? (
          <b className="muted">No ramp in this direction</b>
        ) : (
          <>
            <b className={data.colorClass}>{data.status}</b>
            <span>{data.speed}</span>
            {data.level != null && (
              <span title="Waze grades every jam 1 to 5 by how badly traffic is moving">
                Jam level {data.level} of 5 · {JAM_LEVEL_LABEL[data.level] ?? "unknown"}
              </span>
            )}
            <span>
              {data.jamCount === 0
                ? "No active jams"
                : `${data.jamCount} active jam${data.jamCount === 1 ? "" : "s"}`}
            </span>
            {/* Queue length and delay are not here. They describe one stretch
                of road, and this rail describes an exit in both directions --
                so they belonged to the coloured band, which is the thing on
                screen that IS that stretch. Hovering it fills this same rail. */}
          </>
        )}
      </span>
    </span>
  );

  /** One carriageway. Both are built from the same markup so they read as one
      road split down the middle rather than two unrelated strips. */
  const { isDark } = useChartTheme();
  const palette = mapPalette(isDark);

  /* The coloured band on one block: how much of it is queued, and in what
     condition. Read BOTH by the band that is drawn and by the car that has to
     slow over it, so the two cannot drift apart -- a car crawling past clear
     tarmac, or running straight through a red band, would be worse than no car
     at all. */
  const jamBand = (r: (typeof rows)[number], dir: "NB" | "SB"): Band => {
    const data = dir === "NB" ? r.nb : r.sb;
    if ((dir === "NB" ? r.nbAccess : r.sbAccess) === "No Access") return null;
    const stretchM = dir === "NB" ? r.nbStretchM : r.sbStretchM;
    const queueM = data.queueMeters;
    const share =
      queueM != null && stretchM != null && stretchM > 0 ? Math.min(1, queueM / stretchM) : null;
    if (share == null) return null;
    /* A floor of 9%, because these blocks are not to scale -- they are even
       width for uneven stretches -- so an exact share was never on offer here.
       What the band promises is that a queue is on this stretch and roughly how
       much of it; the metres and the delay are in the rail above, which does
       not round anything. */
    return { pct: Math.max(9, Math.round(share * 100)), colorClass: data.colorClass };
  };

  /* One plan per carriageway, rebuilt only when the congestion picture really
     changes. `rows` is a fresh array on every poll, so keying the animation on
     it restarted the car every fifteen seconds. */
  const bands = useMemo(
    () => ({ NB: rows.map((r) => jamBand(r, "NB")), SB: rows.map((r) => jamBand(r, "SB")) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  );
  const bandsRef = useRef(bands);
  bandsRef.current = bands;
  const carSig = useMemo(() => JSON.stringify(bands), [bands]);
  const carPlan = useMemo(
    () => ({
      NB: carJourney(bandsRef.current.NB, "NB"),
      SB: carJourney(bandsRef.current.SB, "SB"),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [carSig],
  );

  const carEls = useRef<Record<"NB" | "SB", (HTMLElement | null)[]>>({ NB: [], SB: [] });
  const carAnims = useRef<Partial<Record<"NB" | "SB", { anims: Animation[]; plan: Journey }>>>({});

  useEffect(() => {
    /* Driven from the Web Animations API rather than a CSS keyframes rule,
       because the keyframes depend on live data: a rule would have to be
       written into a <style> tag and reparsed on every change. This stays on
       the compositor either way -- it is still a transform. */
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const running = carAnims.current;

    for (const dir of ["NB", "SB"] as const) {
      const els = carEls.current[dir].filter((el): el is HTMLElement => el != null);
      const previous = running[dir];
      if (!els.length || reduced) {
        previous?.anims.forEach((a) => a.cancel());
        delete running[dir];
        continue;
      }

      /* Carried over by POSITION, not by time. The picture changes when a jam
         appears or clears, and the run is a different length either side of
         that -- keeping the time fraction would teleport the cars down the
         corridor at the exact moment the reader is looking at them. The lead
         car is the one tracked; the others keep their spacing from it. */
      const wasAt = previous
        ? xAtProgress(
            previous.plan.stops,
            previous.anims[0]?.effect?.getComputedTiming().progress ?? 0,
          )
        : null;
      previous?.anims.forEach((a) => a.cancel());

      const plan = carPlan[dir];
      const base = wasAt == null ? 0 : progressAtX(plan.stops, wasAt);
      const anims = els.map((el, i) => {
        const anim = el.animate(plan.keyframes, {
          duration: plan.durationMs,
          iterations: Infinity,
          easing: "linear",
        });
        anim.currentTime = ((base + (CAR_LANES[i]?.phase ?? 0)) % 1) * plan.durationMs;
        return anim;
      });
      running[dir] = { anims, plan };
    }

    return () => {
      for (const dir of ["NB", "SB"] as const) {
        running[dir]?.anims.forEach((a) => a.cancel());
        delete running[dir];
      }
    };
  }, [carPlan]);

  const carriageway = (
    dir: "NB" | "SB",
    pick: (r: (typeof rows)[number]) => { data: TrafficRecord; access: string | null },
  ) => (
    <div className={`ds-rd-way dir-${dir.toLowerCase()}`}>
      <div className="ds-rd-segs">
        {rows.map((r) => {
          const { data, access } = pick(r);
          /* Coloured from THIS EXIT's status - the same value the hover rail
             and the tally read.

             It used to colour by the segment the block sits over, which is
             what the Live Map paints that stretch with, and the two answer
             different questions:

               - Attribution. A block in Angeles' column is the road between
                 Angeles and Dau, so a jam belonging to Dau turned Angeles
                 orange while the rail said Angeles was CLEAR.
               - Scale. The segment used Waze's raw 0-5 level, the rail used
                 classify(). Level 1 is "slow" to classify() and green on the
                 level palette, so Paso de Blas read SLOW over a green road.

             One source now, so the block, the words beside it and the chips
             above it cannot disagree. Gradation survives: the level still
             picks the shade, but only within the band its own status allows,
             so a level-4 jam is deeper than a level-3 and nothing classed
             slow can ever render green. */
          const noRamp = access === "No Access";

          /* The queue drawn over the length it occupies, the way the Live Map
             draws it, instead of the whole block taking the colour. A 213 m
             queue in an 8 km stretch was turning the entire stretch red.
             The block keeps the road; this is what is happening on it. */
          const band = jamBand(r, dir);

          return (
            <span
              key={`${dir}-${r.exit.exit_name}`}
              /* The status this block is painted from, on the element itself:
                 the block, the rail and the chips are meant to be one answer,
                 and a mismatch is otherwise only findable by eye. */
              data-status={noRamp ? "no-ramp" : data.colorClass}
              data-exit={r.exit.exit_name}
              /* Three classes, three colours, and they are the legend's own:
                 .ds-rd-seg.seg-red/.seg-orange/.seg-green are declared once in
                 globals.css beside .ds-rd-legend i.seg-*, so the key under the
                 road and the road itself cannot drift apart.

                 This used to paint an inline background from Waze's 0-5 level
                 palette, which put five shades on a road whose legend offers
                 three, and overrode these rules while doing it. The level is
                 not lost - the hover rail still reports "jam level 4 of 5". */
              className={`ds-rd-seg ${noRamp ? "no-ramp" : "seg-green"} ${
                activeStation === r.exit.exit_name ? "is-active" : ""
              }`}
              title={
                data.queue
                  ? `${displayExitName(r.exit.exit_name)} ${dir} — ${data.queue}${data.delay ? `, ${data.delay}` : ""}`
                  : undefined
              }
            >
              {band && (
                /* Anchored at the exit this queue belongs to: northbound that
                   is the block's left edge, southbound its right, because the
                   block for an exit is the road ahead of it in that direction
                   and the two run opposite ways along one shared axis. */
                <i
                  className={`ds-rd-jam ${band.colorClass}`}
                  style={{ width: `${band.pct}%`, [dir === "NB" ? "left" : "right"]: 0 }}
                  /* Focusable as well as hoverable: the detail is only
                     reachable by pointer otherwise, and it is the one place
                     the queue's length and cost are stated. */
                  tabIndex={0}
                  role="button"
                  aria-label={`${displayExitName(r.exit.exit_name)} ${dir}, ${data.status.toLowerCase()}${data.queue ? `, ${data.queue}` : ""}${data.delay ? `, ${data.delay}` : ""}`}
                  onMouseEnter={() =>
                    setHoveredJam({
                      exit: r.exit.exit_name, dir, status: data.status,
                      queue: data.queue, delay: data.delay, level: data.level,
                    })
                  }
                  onFocus={() =>
                    setHoveredJam({
                      exit: r.exit.exit_name, dir, status: data.status,
                      queue: data.queue, delay: data.delay, level: data.level,
                    })
                  }
                  onMouseLeave={() => setHoveredJam(null)}
                  onBlur={() => setHoveredJam(null)}
                />
              )}
            </span>
          );
        })}
      </div>
      <div className="ds-rd-lanes" />
      <div className="ds-rd-flow" />
      <div className="ds-rd-cars" aria-hidden="true">
        {CAR_LANES.map((c, i) => (
          <i
            key={`${c.lane}-${c.phase}`}
            className={`ds-rd-car lane-${c.lane}`}
            data-kind={c.kind}
            style={{ "--car": c.paint } as React.CSSProperties}
            ref={(el) => {
              carEls.current[dir][i] = el;
            }}
          />
        ))}
      </div>
    </div>
  );

  /* ─── Render ─── */
  return (
    <section id="nlex-roadmap" className="ds-rd">
      <header className="ds-rd-head">
        <div className="ds-rd-titles">
          <h2>
            Live Corridor Status
            {corridor?.feed.stale && (
              <span className="ds-rd-stale" title="The Waze ingester has not written a row recently">
                Stale feed
              </span>
            )}
          </h2>
          <p className="ds-rd-updated">{headerSub}</p>
        </div>

        <div className="ds-rd-meta">
          <div className="ds-rd-tally" aria-label="Corridor summary, both directions">
            <span className="seg-red">{tally.congested} congested</span>
            <span className="seg-orange">{tally.slow} slow</span>
            <span className="seg-green">{tally.clear} clear</span>
          </div>
        </div>
      </header>

      {/* Detail rail — reserved, so it never overlaps the road or the labels. */}
      <div className="ds-rd-rail" aria-live="polite">
        {hoveredJam ? (
          /* The queue wins the rail while it is pointed at. It is the more
             specific thing -- one carriageway, one stretch -- and the reader
             had to be over it deliberately to ask. */
          <>
            <span className="ds-rd-rail-name">
              {displayExitName(hoveredJam.exit)}
              <em>{hoveredJam.dir}</em>
            </span>
            <span className="ds-rd-rail-facts">
              <span className="ds-rd-rail-dir">
                <span className="ds-rd-facts">
                  <b className={COLOR_CLASS[hoveredJam.status.toLowerCase() as SegmentStatus] ?? ""}>
                    {hoveredJam.status}
                  </b>
                  {hoveredJam.queue && (
                    <span title="The longest single queue Waze reported here. Reports overlap, so they are not added together.">
                      {hoveredJam.queue}
                    </span>
                  )}
                  {hoveredJam.delay && (
                    <span title="Waze's own estimate of the time lost to this queue, against free-flow speed.">
                      {hoveredJam.delay}
                    </span>
                  )}
                  {hoveredJam.level != null && (
                    <span>Jam level {hoveredJam.level} of 5</span>
                  )}
                </span>
              </span>
            </span>
          </>
        ) : focused ? (
          <>
            <span className="ds-rd-rail-name">
              {displayExitName(focused.exit.exit_name)}
              <em>km {focused.exit.km.toFixed(1)}</em>
            </span>
            <span className="ds-rd-rail-facts">
              {railFacts("NB", focused.nb, focused.nbAccess)}
              {railFacts("SB", focused.sb, focused.sbAccess)}
            </span>
          </>
        ) : (
          <span className="ds-rd-rail-hint">
            Hover an exit for its access and speed, or a coloured stretch for how long that queue is.
          </span>
        )}
      </div>

      <div ref={containerRef} className={`ds-rd-body ${isVisible ? "is-visible" : ""}`}>
        <div className="ds-rd-scroll">
          <div className="ds-rd-track" style={{ "--lanes": rows.length } as React.CSSProperties}>
            {/* Southbound on top, northbound underneath.

                The corridor is drawn with km increasing to the right, so
                northbound traffic runs left to right and southbound runs right
                to left. Traffic in the Philippines keeps to the RIGHT of the
                road, and the right-hand side of a driver heading right is the
                near side of the page -- so northbound belongs at the bottom and
                southbound at the top. Drawn the other way round, the diagram
                showed the two streams passing each other on the wrong sides,
                which is exactly the sort of detail a reader who drives this
                road every day notices first. */}
            <p className="ds-rd-caption top">
              <span aria-hidden="true">←</span> Southbound (SB) · to Metro Manila
            </p>
            {carriageway("SB", (r) => ({ data: r.sb, access: r.sbAccess }))}

            {/* Median: one set of markers serving both carriageways, so an exit
                is a single target rather than two that have to be kept in step. */}
            <ol className="ds-rd-stops">
              {rows.map((r) => {
                const bothClosed = r.nbAccess === "No Access" && r.sbAccess === "No Access";
                return (
                  <li
                    key={r.exit.exit_name}
                    className={`ds-rd-stop ${bothClosed ? "no-ramp" : ""} ${
                      activeStation === r.exit.exit_name ? "is-active" : ""
                    }`}
                  >
                    <button
                      type="button"
                      className="ds-rd-hit"
                      onMouseEnter={() => setActiveStation(r.exit.exit_name)}
                      onMouseLeave={() => setActiveStation(null)}
                      onFocus={() => setActiveStation(r.exit.exit_name)}
                      onBlur={() => setActiveStation(null)}
                      aria-label={`${displayExitName(r.exit.exit_name)}, km ${r.exit.km.toFixed(1)}. Northbound ${
                        r.nbAccess === "No Access" ? "no ramp" : r.nb.status.toLowerCase()
                      }. Southbound ${r.sbAccess === "No Access" ? "no ramp" : r.sb.status.toLowerCase()}.`}
                    >
                      <span className="ds-rd-node" aria-hidden="true"><HexagonRoad /></span>
                      <span className="ds-rd-km">{r.exit.km.toFixed(1)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>

            {carriageway("NB", (r) => ({ data: r.nb, access: r.nbAccess }))}
            <p className="ds-rd-caption bottom">
              <span aria-hidden="true">→</span> Northbound (NB) · to Central Luzon
            </p>

            {/* Names sit under the whole diagram, shared by both carriageways. */}
            <ol className="ds-rd-labels">
              {rows.map((r) => (
                <li key={`lbl-${r.exit.exit_name}`}>
                  <button
                    type="button"
                    className={`ds-rd-label ${activeStation === r.exit.exit_name ? "is-active" : ""}`}
                    onMouseEnter={() => setActiveStation(r.exit.exit_name)}
                    onMouseLeave={() => setActiveStation(null)}
                    onFocus={() => setActiveStation(r.exit.exit_name)}
                    onBlur={() => setActiveStation(null)}
                    tabIndex={-1}
                    aria-hidden="true"
                  >
                    {displayExitName(r.exit.exit_name)}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      <footer className="ds-rd-foot">
        <div className="ds-rd-legend">
          <span><i className="seg-red" /> Congested</span>
          <span><i className="seg-orange" /> Slow</span>
          <span><i className="seg-green" /> Clear</span>
          <button type="button" className="ds-rd-scale-btn" onClick={() => setScaleOpen(true)}>
            <span aria-hidden="true">?</span> Jam levels
          </button>
        </div>
        <p>
          Waze jam reports matched to the nearest exit; direction from jam bearing.
          An exit with no report is flowing freely.
        </p>
      </footer>

      {scaleOpen && (
        <div
          className="ds-rd-scale-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Waze jam level scale"
          onClick={() => setScaleOpen(false)}
        >
          <div className="ds-rd-scale" onClick={(e) => e.stopPropagation()}>
            <div className="ds-rd-scale-head">
              <h3>Waze jam levels</h3>
              <button type="button" onClick={() => setScaleOpen(false)} aria-label="Close">×</button>
            </div>

            <p className="ds-rd-scale-intro">
              A level is how far traffic has fallen below free-flow speed on that
              stretch — not a count of vehicles. Waze publishes the scale as 0 to 5.
            </p>

            <ul className="ds-rd-scale-list">
              {JAM_SCALE.map((r) => (
                <li key={r.level}>
                  <span className="ds-rd-scale-chip" style={{ background: levelColour(palette, r.level) }}>{r.level}</span>
                  <span className="ds-rd-scale-band">{r.band}</span>
                  <span className="ds-rd-scale-word">{r.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
