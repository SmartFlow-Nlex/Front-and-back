"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cachedJson } from "../../../lib/cached-json";

/* ══════════════════════════════════════════════════════════════════════════════
   OFFICIAL NLEX STATION DEFINITIONS
   Each station carries: km marker · display name · per-direction access type.
   "toll-barrier" nodes (Bocaue Barrier) are flagged separately from ramp nodes.
══════════════════════════════════════════════════════════════════════════════ */

import { useNlexExits, accessLabel, displayExitName, type NlexExit } from "../../../lib/nlex-exits";

/* Traffic on the carriageway.
 *
 * Decoration, deliberately: both carriageways run this same set at this same
 * pace, whatever the road is doing, so nothing about the cars can be read as a
 * measurement. What is measured is the coloured band underneath them and the
 * figures beside it. Their job is to make the strip read as a ROAD rather than
 * a progress bar, and to say which way it runs without the reader having to
 * decode an arrow.
 *
 * Fixed rather than generated, so a re-render cannot reshuffle them mid-drive,
 * and so the two carriageways carry identical traffic -- anything else would
 * invite a comparison that means nothing.
 *
 * The delays are NEGATIVE: a CSS animation given a negative delay starts part
 * way through, so the road is already full of cars on the first frame instead
 * of filling up from the left over ten seconds.
 *
 * The paints are all neutral greys and whites. Red, amber and green are spoken
 * for by the status palette, and a yellow car on a green stretch would be the
 * one thing on this panel that looks like a reading and is not.
 */
const CARS = [
  { lane: 1, dur: 11.0, delay: -0.0, paint: "#eef2f7" },
  { lane: 1, dur: 11.0, delay: -3.6, paint: "#c3cfdd" },
  { lane: 1, dur: 11.0, delay: -7.4, paint: "#dfe7f0" },
  { lane: 1, dur: 13.5, delay: -5.1, paint: "#aebdd0" },
  { lane: 2, dur: 9.5, delay: -1.1, paint: "#dfe7f0" },
  { lane: 2, dur: 9.5, delay: -4.3, paint: "#f4f7fb" },
  { lane: 2, dur: 9.5, delay: -7.7, paint: "#b9c6d6" },
  { lane: 2, dur: 12.0, delay: -2.6, paint: "#cdd8e5" },
  { lane: 3, dur: 8.0, delay: -0.5, paint: "#f4f7fb" },
  { lane: 3, dur: 8.0, delay: -3.1, paint: "#aebdd0" },
  { lane: 3, dur: 8.0, delay: -5.7, paint: "#dfe7f0" },
  { lane: 3, dur: 10.5, delay: -8.2, paint: "#c3cfdd" },
] as const;



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
          const stretchM = dir === "NB" ? r.nbStretchM : r.sbStretchM;
          const queueM = noRamp ? null : data.queueMeters;
          const share =
            queueM != null && stretchM != null && stretchM > 0
              ? Math.min(1, queueM / stretchM)
              : null;
          /* A floor of 9%, because these blocks are not to scale -- they are
             even width for uneven stretches -- so an exact share was never on
             offer here. What the band promises is that a queue is on this
             stretch and roughly how much of it; the metres and the delay are
             in the rail above, which does not round anything. */
          const bandPct = share == null ? null : Math.max(9, Math.round(share * 100));

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
              {bandPct != null && (
                /* Anchored at the exit this queue belongs to: northbound that
                   is the block's left edge, southbound its right, because the
                   block for an exit is the road ahead of it in that direction
                   and the two run opposite ways along one shared axis. */
                <i
                  className={`ds-rd-jam ${data.colorClass}`}
                  style={{ width: `${bandPct}%`, [dir === "NB" ? "left" : "right"]: 0 }}
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
        {CARS.map((c, i) => (
          <i
            key={i}
            className={`ds-rd-car lane-${c.lane}`}
            style={
              { "--dur": `${c.dur}s`, "--delay": `${c.delay}s`, "--car": c.paint } as React.CSSProperties
            }
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
