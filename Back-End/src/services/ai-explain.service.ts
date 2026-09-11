import { chat, extractJson, GlmError } from "../lib/glm.client.js";
import { getDashboardOverview } from "./dashboard.service.js";
import { getTrafficAnalyticsFromDb } from "./traffic.service.js";
import { getEmissionsAnalyticsFromDb } from "./emissions.service.js";
import { getCorridorStatusFull } from "./corridor-status.service.js";
import { getMaintenanceSchedulesFromDb } from "./maintenance.service.js";

/* ══════════════════════════════════════════════════════════════════════════════
   AI EXPLAIN — PLAIN-LANGUAGE BRIEFINGS FOR THE NON-PREDICTIVE MODULES

   The forecast panels have their own generator (ai-insight.service.ts). This one
   covers everything else: the overview, the descriptive traffic and emissions
   tabs, live corridor status and the maintenance schedule.

   Two design rules, both carried over from the sandbox parser:

   1. THE SERVER FETCHES ITS OWN DATA. The client names a feature; it does not
      send rows. A page holding 365 daily records would otherwise ship all of
      them through the browser and into a prompt, and two callers could describe
      the same corridor differently depending on what each had loaded.

   2. CODE DECIDES, THE MODEL PHRASES. Every comparison, direction, ranking and
      threshold below is computed in TypeScript and handed over as a finished
      statement. Asked to work out "is 2.74 worse than 2.73", a small model gets
      it wrong often enough to matter, and the mistake reads as confident prose.
      So it is never asked. It receives facts and writes sentences.
══════════════════════════════════════════════════════════════════════════════ */

export type Feature =
  | "overview"
  | "traffic_analytics"
  | "emissions_analytics"
  | "corridor_status"
  | "maintenance";

export type Explanation = {
  /** One sentence naming the single most important thing. */
  headline: string;
  /** 2-5 supporting observations. */
  points: string[];
  /** Something the reader should be careful about, or null. */
  watchOut: string | null;
  /** The facts the prose was built from, so a reader can check it. */
  facts: string[];
};

const fmt = (n: number, dp = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** "up 1.2%" / "down 0.4%" / "unchanged" — the direction decided here, not there. */
function delta(pct: number | null | undefined, unit = "%"): string {
  if (pct == null || !Number.isFinite(pct)) return "no comparison available";
  if (Math.abs(pct) < 0.05) return "essentially unchanged";
  return `${pct > 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}${unit}`;
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* ─────────────────────────────────────────────────────────────────────────────
   FACT BUILDERS — one per feature. Each returns finished statements.
───────────────────────────────────────────────────────────────────────────── */

type Built = { audience: string; subject: string; facts: string[] };

async function buildOverview(months: "3" | "12" | "all"): Promise<Built | null> {
  const d: any = await getDashboardOverview(months);
  if (!d) return null;

  const facts = [
    `Reporting window: ${d.range.from} to ${d.range.to}.`,
    `Average daily volume ${fmt(d.volume.value)} vehicles, ${delta(d.volume.deltaPct)} against the previous period.`,
    `Congestion index ${d.congestion.value}, ${
      Math.abs(d.congestion.deltaPoints) < 0.005
        ? "level with"
        : `${d.congestion.deltaPoints > 0 ? "up" : "down"} ${Math.abs(d.congestion.deltaPoints).toFixed(2)} points against`
    } the previous period.`,
    `${fmt(d.incidents.value)} incidents, ${delta(d.incidents.deltaPct)}, including ${fmt(
      d.incidents.injuries,
    )} injuries and ${fmt(d.incidents.fatalities)} fatalities.`,
    `Mean incident response time ${d.incidents.avgResponseMin} minutes.`,
    `Total CO2 ${fmt(d.emissions.totalCo2T)} tonnes, ${delta(d.emissions.deltaPct)}. Mean AQI ${
      d.emissions.avgAqi
    }, mean PM2.5 ${d.emissions.avgPm25} ug/m3.`,
  ];

  if (d.highlights?.busiestPlaza) {
    facts.push(
      `Busiest plaza: ${d.highlights.busiestPlaza.name}, carrying ${d.highlights.busiestPlaza.sharePct.toFixed(
        1,
      )}% of corridor volume across ${d.highlights.plazaCount} plazas.`,
    );
  }
  if (d.highlights?.peakWindow) {
    const p = d.highlights.peakWindow;
    facts.push(
      `Busiest hour of the week: ${DOW[p.dow] ?? `day ${p.dow}`} at ${String(p.hour).padStart(2, "0")}:00, ${fmt(
        p.volume,
      )} vehicles.`,
    );
  }
  if (d.highlights?.worstSegmentKm != null) {
    facts.push(`Most congested point: km ${d.highlights.worstSegmentKm}.`);
  }
  if (d.coverage) {
    facts.push(
      `The warehouse holds data from ${d.coverage.minDate} to ${d.coverage.maxDate}; anything after that is not observed.`,
    );
  }

  return {
    audience: "a traffic control centre manager opening the dashboard for a situation briefing",
    subject: "overall NLEX corridor performance",
    facts,
  };
}

async function buildTraffic(months: "3" | "12" | "all"): Promise<Built | null> {
  const d: any = await getTrafficAnalyticsFromDb({ months });
  if (!d) return null;

  const k = d.kpis;
  const volPct =
    k.prevTotalVolume > 0 ? ((k.totalVolume - k.prevTotalVolume) / k.prevTotalVolume) * 100 : null;

  const facts = [
    `Window ${d.range.from} to ${d.range.to}, ${fmt(k.days)} days across ${d.meta.plazas.length} plazas.`,
    `Total volume ${fmt(k.totalVolume)} vehicles, ${delta(volPct)} on the previous ${fmt(
      k.prevDays,
    )} days.`,
    `Congestion index ${k.congestionIndex} versus ${k.prevCongestionIndex} previously.`,
  ];

  // Top plazas by share — ranking computed here, never left to the model.
  if (Array.isArray(d.byPlaza) && d.byPlaza.length) {
    const total = d.byPlaza.reduce((s: number, p: any) => s + Number(p.v || 0), 0);
    const top = [...d.byPlaza].sort((a: any, b: any) => b.v - a.v).slice(0, 3);
    facts.push(
      `Highest-volume plazas: ${top
        .map((p: any) => `${p.plaza} (${((p.v / total) * 100).toFixed(1)}%)`)
        .join(", ")}.`,
    );
  }

  // Busiest and quietest hour-of-week.
  if (Array.isArray(d.hourDow) && d.hourDow.length) {
    const sorted = [...d.hourDow].sort((a: any, b: any) => b.v - a.v);
    const hi = sorted[0];
    const lo = sorted[sorted.length - 1];
    facts.push(
      `Peak hour-of-week: ${DOW[hi.dow]} ${String(hi.hour).padStart(2, "0")}:00 at ${fmt(hi.v)} vehicles. ` +
        `Quietest: ${DOW[lo.dow]} ${String(lo.hour).padStart(2, "0")}:00 at ${fmt(lo.v)}.`,
    );
  }

  // Slowest hours by observed speed.
  if (Array.isArray(d.speedByHour) && d.speedByHour.length) {
    const withSpeed = d.speedByHour.filter((h: any) => h.speed != null);
    if (withSpeed.length) {
      const slow = [...withSpeed].sort((a: any, b: any) => a.speed - b.speed).slice(0, 3);
      facts.push(
        `Slowest hours by observed speed: ${slow
          .map((h: any) => `${String(h.hour).padStart(2, "0")}:00 (${h.speed} km/h)`)
          .join(", ")}.`,
      );
    }
  }

  // Holidays with the largest effect either way.
  if (Array.isArray(d.holidayImpact) && d.holidayImpact.length) {
    const sorted = [...d.holidayImpact].sort(
      (a: any, b: any) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct),
    );
    facts.push(
      `Largest holiday effects on volume: ${sorted
        .slice(0, 3)
        .map((h: any) => `${h.label} ${h.deviationPct > 0 ? "+" : ""}${h.deviationPct}%`)
        .join(", ")}.`,
    );
  }

  return {
    audience: "a traffic analyst reviewing corridor demand patterns",
    subject: "observed NLEX traffic volume and congestion",
    facts,
  };
}

async function buildEmissions(months: "3" | "12" | "all"): Promise<Built | null> {
  const d: any = await getEmissionsAnalyticsFromDb({ months });
  if (!d) return null;

  const k = d.kpis;
  const pct = k.prevCo2T > 0 ? ((k.totalCo2T - k.prevCo2T) / k.prevCo2T) * 100 : null;

  const facts = [
    `Window ${d.range.from} to ${d.range.to}.`,
    `Total CO2 ${fmt(k.totalCo2T, 1)} tonnes, ${delta(pct)} on the previous period.`,
    `Mean AQI ${k.avgAqi} over ${fmt(k.aqiSamples)} samples; mean PM2.5 ${k.avgPm25} ug/m3.`,
  ];

  if (Array.isArray(d.classes) && d.classes.length) {
    const total = d.classes.reduce((s: number, c: any) => s + Number(c.co2_t || 0), 0);
    // Fleet share is stated rather than left implied by the raw counts. Given
    // only the vehicle totals, glm-4.5-flash worked the percentage out itself
    // and reported 4.9% where the figure is 4.2% — a small error, but one that
    // lands in the middle of the sentence the whole panel is built around.
    const fleet = d.classes.reduce((s: number, c: any) => s + Number(c.volume || 0), 0);
    for (const c of d.classes) {
      facts.push(
        `${c.label}: ${fmt(c.co2_t, 1)} t CO2 (${((c.co2_t / total) * 100).toFixed(1)}% of total CO2) ` +
          `from ${fmt(c.volume)} vehicles, which is ${((c.volume / Math.max(1, fleet)) * 100).toFixed(1)}% ` +
          `of the fleet, at ${c.co2_g_per_km} g/km.`,
      );
    }
    // Emission intensity per vehicle — the comparison that makes the split
    // meaningful, computed rather than implied.
    const perVeh = d.classes
      .map((c: any) => ({ label: c.label, g: (c.co2_t * 1e6) / Math.max(1, c.volume) }))
      .sort((a: any, b: any) => b.g - a.g);
    facts.push(
      `CO2 per vehicle: ${perVeh
        .map((p: any) => `${p.label} ${fmt(p.g, 0)} g`)
        .join(", ")} — so a single heavier vehicle contributes more than a light one even where its share of the fleet is small.`,
    );
  }

  if (Array.isArray(d.heatmap) && d.heatmap.length) {
    const hi = [...d.heatmap].sort((a: any, b: any) => b.v - a.v)[0];
    facts.push(
      `Highest-emitting hour of the week: ${DOW[hi.dow]} ${String(hi.hour).padStart(2, "0")}:00 at ${fmt(
        hi.v,
        1,
      )} t.`,
    );
  }

  facts.push(
    "CO2 is derived from traffic volume times published per-class emission factors, not measured directly.",
  );

  return {
    audience: "a sustainability officer reporting corridor emissions",
    subject: "NLEX corridor CO2 and air quality",
    facts,
  };
}

async function buildCorridor(): Promise<Built | null> {
  const d: any = await getCorridorStatusFull();
  if (!d) return null;

  const c = d.counts;
  const total = (c.congested ?? 0) + (c.slow ?? 0) + (c.clear ?? 0);
  const facts = [
    `Live snapshot generated ${d.generatedAt}, from a feed ${d.feed.ageMinutes} minutes old.`,
    d.feed.stale
      ? "The feed is STALE — older than 30 minutes, so this picture may not reflect the road now."
      : "The feed is current.",
    `Of ${total} exit/direction pairs with a ramp: ${c.congested} congested, ${c.slow} slow, ${c.clear} clear.`,
    `That puts ${(((c.congested ?? 0) / Math.max(1, total)) * 100).toFixed(0)}% of the corridor in a congested state.`,
  ];

  // Name the worst locations rather than making the model scan the array.
  const bad: { name: string; dir: string; speed: number | null; level: number | null }[] = [];
  for (const x of d.exits ?? []) {
    for (const dir of ["NB", "SB"] as const) {
      const s = x[dir === "NB" ? "nb" : "sb"];
      if (!s || !s.hasRamp) continue;
      if (s.status === "congested") {
        bad.push({ name: x.display_name ?? x.exit_name, dir, speed: s.speedKmh, level: s.level });
      }
    }
  }
  bad.sort((a, b) => (a.speed ?? 999) - (b.speed ?? 999));
  if (bad.length) {
    facts.push(
      `Congested locations, slowest first: ${bad
        .slice(0, 8)
        .map((b) => `${b.name} ${b.dir}${b.speed != null ? ` (${b.speed} km/h)` : ""}`)
        .join(", ")}.`,
    );
  } else {
    facts.push("No exit/direction pair is currently congested.");
  }

  return {
    audience: "a control-room operator deciding where to send resources in the next hour",
    subject: "live NLEX corridor conditions",
    facts,
  };
}

async function buildMaintenance(): Promise<Built | null> {
  const rows: any = await getMaintenanceSchedulesFromDb("all");
  if (!rows) return null;
  if (!rows.length) {
    return {
      audience: "a maintenance planner",
      subject: "the NLEX maintenance schedule",
      facts: ["There are no maintenance schedules recorded."],
    };
  }

  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);

  const facts = [
    `${rows.length} maintenance schedules recorded.`,
    `By status: ${[...byStatus.entries()].map(([s, n]) => `${s} ${n}`).join(", ")}.`,
  ];

  const now = Date.now();
  const upcoming = rows
    .filter((r: any) => r.start_time && new Date(r.start_time).getTime() >= now)
    .sort((a: any, b: any) => +new Date(a.start_time) - +new Date(b.start_time))
    .slice(0, 6);

  if (upcoming.length) {
    facts.push(
      `Next scheduled: ${upcoming
        .map(
          (r: any) =>
            `${r.location ?? r.exit_name ?? "unnamed location"} on ${String(r.start_time).slice(0, 10)}` +
            `${r.lanes_affected != null ? `, ${r.lanes_affected} lane(s) affected` : ""}` +
            `${r.status ? ` [${r.status}]` : ""}`,
        )
        .join("; ")}.`,
    );
  } else {
    facts.push("No schedules are dated in the future — every record is in the past.");
  }

  return {
    audience: "a maintenance planner deciding whether the current plan is sensible",
    subject: "the NLEX maintenance schedule",
    facts,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   PROMPT
───────────────────────────────────────────────────────────────────────────── */

const SYSTEM = `You brief traffic operations staff on the North Luzon Expressway. Reply with JSON only.

OUTPUT SHAPE
{
  "headline": "one sentence naming the single most important thing in the facts",
  "points": ["2 to 5 short observations, each grounded in a supplied fact"],
  "watchOut": "one limitation or risk the facts themselves show, or null"
}

RULES
- You are given a list of FACTS. Every number and every comparison in them has already been computed. Use them exactly as written.
- Never state a number that is not in the facts. Never recompute, re-derive or estimate one. If a comparison is not in the facts, do not make it.
- Do not speculate about causes you were not told. "Volume rose 1.2%" is supportable; "volume rose because of the new interchange" is not.
- Say what the numbers mean for someone doing the job, not what the numbers are. A reader can already see the figures on screen.
- If something in the facts is a problem — a stale feed, a gap in coverage, a rise in fatalities — lead with it rather than burying it.
- watchOut is for a limitation the facts demonstrate. If they show none, return null. Never invent one.
- Plain English. No jargon you do not define in the same sentence.`;

function buildUser(b: Built): string {
  return [
    `SUBJECT: ${b.subject}.`,
    `READER: ${b.audience}.`,
    "",
    "FACTS",
    ...b.facts.map((f) => `  - ${f}`),
    "",
    "Write the briefing from these facts alone.",
  ].join("\n");
}

function validate(raw: unknown, facts: string[]): Explanation {
  const o = (raw ?? {}) as Record<string, unknown>;

  const headline =
    typeof o.headline === "string" && o.headline.trim() ? o.headline.trim() : "No summary was produced.";

  const points = Array.isArray(o.points)
    ? o.points.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim()).slice(0, 6)
    : [];

  const raw2 = typeof o.watchOut === "string" ? o.watchOut.trim() : "";
  // Models answer an "or null" field with the word "None" often enough that it
  // has to be filtered, or the panel renders a caveat reading "None".
  const watchOut =
    raw2 && !/^(none|null|n\/a|no (caveats?|limitations?|risks?)\.?)$/i.test(raw2) ? raw2 : null;

  return { headline, points, watchOut, facts };
}

/* ─────────────────────────────────────────────────────────────────────────────
   ENTRY POINT
───────────────────────────────────────────────────────────────────────────── */

export async function explain(
  feature: Feature,
  months: "3" | "12" | "all" = "12",
): Promise<Explanation> {
  let built: Built | null;
  switch (feature) {
    case "overview":
      built = await buildOverview(months);
      break;
    case "traffic_analytics":
      built = await buildTraffic(months);
      break;
    case "emissions_analytics":
      built = await buildEmissions(months);
      break;
    case "corridor_status":
      built = await buildCorridor();
      break;
    case "maintenance":
      built = await buildMaintenance();
      break;
  }

  if (!built) {
    throw new GlmError(
      "The data behind this panel is unavailable, so there is nothing to explain.",
      "upstream_error",
    );
  }

  const content = await chat({
    system: SYSTEM,
    user: buildUser(built),
    json: true,
    maxTokens: 1400,
    // Slightly above zero: at exactly 0 the points came out as a flat restatement
    // of the fact list in the same order.
    temperature: 0.3,
  });

  return validate(extractJson(content), built.facts);
}
