import { chat, extractJson, GlmError } from "../lib/glm.client.js";

/* ══════════════════════════════════════════════════════════════════════════════
   AI INSIGHT — PLAIN-LANGUAGE READ-OUT OF A TRAINED MODEL'S METRICS

   This sits ON TOP OF the existing narrative panels, it does not replace them.
   ModelNarrative.tsx and IncidentNarrative.tsx compose their prose from the
   metrics deterministically and are careful never to state something the
   numbers do not support; that guarantee is worth keeping, and a language model
   cannot make it.

   What the model adds is the judgement the template cannot reach: which model a
   reader should actually trust here, whether the gap between rank 1 and rank 2
   is meaningful, and what the accuracy implies for someone planning around the
   forecast.

   Everything it is told is already on the operator's screen. No live corridor
   data, no database rows, no credentials — only the metric table the user is
   looking at, so a leak through the prompt discloses nothing they cannot see.
══════════════════════════════════════════════════════════════════════════════ */

export type Quantity = "volume" | "incidents" | "emissions";

/** One model's scored metrics, as the dashboard already holds them. */
export type MetricInput = {
  model: string;
  wmape?: number | null;
  mae?: number | null;
  rmse?: number | null;
  r2?: number | null;
  mase?: number | null;
  rank?: number | null;
  accepted?: boolean | null;
  rejectedReason?: string | null;
  diagnosis?: string | null;
};

export type InsightRequest = {
  quantity: Quantity;
  metrics: MetricInput[];
  horizonDays: number;
  scoredDays?: number | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  weatherMode?: "with" | "without" | null;
  /** The seasonal naive's own MASE on the scored days. When given, a model beats the benchmark by scoring
      under it, not under 1 (the traffic trainer's acceptance rule since 20 Oct 2026). */
  naiveMase?: number | null;
};

export type Insight = {
  /** 2-4 sentences an operations reader can act on. */
  summary: string;
  /** One line per model, in the order supplied. */
  perModel: { model: string; verdict: string }[];
  /** The single most important caveat, or null when there is nothing to add. */
  caveat: string | null;
  /** One closing "What this means: ..." line, for the endpoints that ask for it. */
  meaning?: string | null;
  /** "template" when the text was composed from the figures because the language model failed. */
  source?: "ai" | "template";
};

const UNITS: Record<Quantity, { noun: string; unit: string; audience: string }> = {
  volume: {
    noun: "daily vehicle volume on the NLEX corridor",
    unit: "vehicles per day",
    audience: "a traffic control centre planning staffing and lane allocation",
  },
  incidents: {
    noun: "daily road incident counts on the NLEX corridor",
    unit: "incidents per day",
    audience: "a traffic control centre positioning response units",
  },
  emissions: {
    noun: "daily CO2 emissions from NLEX corridor traffic",
    unit: "tonnes CO2 per day",
    audience: "a sustainability team reporting against emission targets",
  },
};

const SYSTEM = `You explain forecasting model results to traffic operations staff who are not statisticians. Reply with JSON only.

OUTPUT SHAPE
{
  "summary": "2-4 sentences: which model to trust here and what its accuracy means in practice",
  "perModel": [{"model": "<exact name as given>", "verdict": "one sentence"}],
  "caveat": "the single most important limitation, or null"
}

HOW TO READ THE METRICS
- WMAPE is percentage error. Lower is better. Do not call a WMAPE strong or weak by a fixed cut: judge it against the benchmark label below and, where the quantity has one, the project's design target (traffic volume: WMAPE 12% or less; corridor CO2: 15% or less). Say whether the target is met; for any other quantity, rely on the benchmark label alone.
- MASE compares against simply repeating last week. Do not interpret the raw number yourself — each model is labelled BEATS-BENCHMARK, FAILS-BENCHMARK or LEVEL-WITH-BENCHMARK, and that label is authoritative.
- R2 near 1 is good, near 0 means the model explains little, and negative means it is worse than predicting the average.
- MAE and RMSE are in the quantity's own units. RMSE far above MAE means a few large misses rather than steady drift.

RULES
- Never state a number that was not given to you. Never estimate one.
- Every claim must be traceable to a metric above. You know NOTHING about how these models were built, what data they saw, what weather or events they did or did not cover, or how they will behave in future. Do not speculate about any of it.
- Repeat each model's benchmark label faithfully. A model marked FAILS-BENCHMARK did not beat simply repeating last week — say so plainly in its verdict whatever its other metrics look like, because burying that misleads the reader. Never say a BEATS-BENCHMARK model failed, or the reverse.
- If a model was rejected, say so and give the stated reason.
- A "diagnosis" beginning "tied with" means the model is not statistically separable from the named model. Say the two are level and that picking between them is not supported by these numbers. Do not rank one above the other.
- Translate into consequences. "WMAPE 8% means a 10,000-vehicle day is typically read within about 800 vehicles" is useful; "WMAPE is 8%" alone is not.
- Do not recommend retraining, more data, or model changes. The reader operates this system, they do not build it.
- Plain English. No jargon that is not defined in the sentence that uses it.

THE CAVEAT FIELD
Use it ONLY for a limitation the supplied numbers themselves demonstrate — a short scoring window, a model that beat the others while failing the MASE benchmark, a wide gap between MAE and RMSE, a tie that makes the ranking arbitrary. If the numbers show no such problem, return null. Never invent a limitation about data coverage, weather, events, or anything else you were not told.`;

function buildUserMessage(req: InsightRequest): string {
  const u = UNITS[req.quantity];
  const lines: string[] = [];

  lines.push(`QUANTITY FORECAST: ${u.noun}, measured in ${u.unit}.`);
  lines.push(`READER: ${u.audience}.`);
  lines.push(`FORECAST HORIZON: ${req.horizonDays} days ahead.`);

  if (req.scoredDays != null && req.windowStart && req.windowEnd) {
    lines.push(
      `SCORED ON: ${req.scoredDays} days of held-out data, ${req.windowStart} to ${req.windowEnd}.`,
    );
  }
  if (req.weatherMode) {
    lines.push(
      req.weatherMode === "with"
        ? "VARIANT: these are the weather-driven model variants."
        : "VARIANT: these are the weather-free model variants — rainfall was removed as an input.",
    );
  }

  if (req.naiveMase != null && Number.isFinite(req.naiveMase)) {
    lines.push(
      `BENCHMARK: simply repeating last week scored MASE ${req.naiveMase.toFixed(3)} on these same days, so a model beats it by scoring below that, not below 1. A MASE above 1 here means the scored days were harder than the training years, not that the model failed.`,
    );
  }

  lines.push("", "MODEL METRICS");
  for (const m of req.metrics) {
    const parts: string[] = [];
    const add = (label: string, v: number | null | undefined, dp = 3) => {
      if (v == null || !Number.isFinite(v)) return;
      parts.push(`${label} ${v.toFixed(dp)}`);
    };
    add("WMAPE", m.wmape, 2);
    add("MAE", m.mae, 2);
    add("RMSE", m.rmse, 2);
    add("R2", m.r2);
    add("MASE", m.mase);
    // The benchmark comparison is decided here rather than left to the model:
    // asked to read MASE itself, glm-4.5-flash inverted the comparison and told
    // the reader a model had failed when it had passed. It is a fixed threshold
    // on a number already in hand, so there is no reason to delegate it.
    // The bar is the naive's own MASE on these days when the module supplies it: on 2026 traffic the scored
    // days were rougher than the training years, the naive itself scored 1.555, and "MASE < 1" told readers
    // that Prophet (1.203, 23% less error than the naive) failed.
    const bar = req.naiveMase != null && Number.isFinite(req.naiveMase) ? req.naiveMase : 1;
    if (m.mase != null && Number.isFinite(m.mase)) {
      parts.push(
        m.mase < bar * 0.995
          ? "BEATS-BENCHMARK"
          : m.mase > bar * 1.005
            ? "FAILS-BENCHMARK"
            : "LEVEL-WITH-BENCHMARK",
      );
    }
    if (m.rank != null) parts.push(`rank ${m.rank}`);
    parts.push(m.accepted === false ? "REJECTED" : "accepted");
    if (m.rejectedReason) parts.push(`reason: ${m.rejectedReason}`);
    if (m.diagnosis) parts.push(`diagnosis: ${m.diagnosis}`);
    lines.push(`  ${m.model}: ${parts.join(", ") || "no scored metrics"}`);
  }

  lines.push(
    "",
    `Write one verdict for each of the ${req.metrics.length} models above, using their exact names.`,
  );
  return lines.join("\n");
}

/** Coerce the model's reply into the Insight shape, dropping anything unusable. */
/* Shared by the incident module's own narrative service, which needs the same
 * guarantees — drop a verdict naming a model that was not sent, and treat the
 * word "None" as an absent caveat — without duplicating them. */
export function validate(raw: unknown, req: InsightRequest): Insight {
  const o = (raw ?? {}) as Record<string, unknown>;

  const summary =
    typeof o.summary === "string" && o.summary.trim().length > 0
      ? o.summary.trim()
      : "No summary was produced.";

  /* Match on a normalised form, then emit the SUPPLIED spelling.
   *
   * The rule that a verdict naming a model we did not send is a hallucination
   * stays exactly as it was — this only stops a difference of case, spacing or
   * a stray full stop counting as a different model. Asked for "Clearance time
   * (Cox PH)" the model returns "Clearance Time (Cox PH)" often enough that on
   * roughly half of calls every verdict was dropped and the panel rendered a
   * summary with no per-model lines under it.
   *
   * Still an equality test on the normalised strings, so it can never attach a
   * verdict to a DIFFERENT model in the roster; and the name rendered is the
   * one we supplied, never the model's spelling of it. */
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim();
  const supplied = new Map(req.metrics.map((m) => [norm(m.model), m.model]));
  const perModel: { model: string; verdict: string }[] = [];

  if (Array.isArray(o.perModel)) {
    for (const item of o.perModel) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const model = typeof r.model === "string" ? r.model.trim() : "";
      const verdict = typeof r.verdict === "string" ? r.verdict.trim() : "";
      // A verdict for a model that was not sent is a hallucination — drop it
      // rather than showing the reader a row that is not on their chart.
      const canonical = supplied.get(norm(model));
      if (!model || !verdict || !canonical) continue;
      perModel.push({ model: canonical, verdict });
    }
  }

  // Models routinely answer the "or null" half of a schema with the WORD
  // "None", which would otherwise render as a caveat reading "None".
  const caveatRaw = typeof o.caveat === "string" ? o.caveat.trim() : "";
  const caveat =
    caveatRaw.length > 0 && !/^(none|null|n\/a|no caveats?\.?)$/i.test(caveatRaw)
      ? caveatRaw
      : null;

  return { summary, perModel, caveat };
}

/* ── Congestion: a classifier, scored per hour ahead ──────────────────────── */

export type CongestionModelInput = {
  model: string;
  accuracy?: number | null;
  accepted?: boolean | null;
  rejectedReason?: string | null;
};

export type CongestionInsightRequest = {
  models: CongestionModelInput[];
  baseline?: { model: string; accuracy: number | null } | null;
  horizons?: { horizon: number; accuracy: number | null; persistence: number | null; n?: number | null }[];
  situation?: {
    exitsTotal: number;
    exitsSevere: number;
    hoursCovered: number;
    neverPredictsHeavy?: boolean;
    windowStart?: string | null;
    windowEnd?: string | null;
    severeBelowKmh?: number | null;
    heavyBelowKmh?: number | null;
  };
};

/* Two benchmarks, named apart (17 Oct 2026, testers TR-9: "the narrative report has an error"). The card
   compares the model's overall accuracy with the EXIT-HOUR PROFILE (each exit doing what it usually does at
   that hour), and its per-hour accuracy with NOTHING CHANGES (each exit staying as it is now). This prompt
   used to call both "nothing changes", so the read-out could hang the profile's 60% on the wrong idea and
   contradict the card it sits under. It is also told the window the map covers, so it can open with the
   dates and times a reader is looking at, and where measured accuracy stops. */
/* 19 Oct 2026, testers TR-9 again ("error in the narrative report"; "write narratives as plain sentences
   with context for non-analytics readers"). Two more faults, both in what the model was TOLD:
     - the classes were defined here as Severe under 30 km/h and Heavy 30-60 km/h, while the card and the
       trainer cut at 10 and 20 km/h, so the read-out defined Severe differently from the legend above it;
     - every measured horizon to +168h was sent whatever range the map showed, so a 12-hour view was
       described with week-ahead figures.
   The cuts now come from the payload, the client sends only the horizons the map shows, the reply ends
   with a "What this means" line, and a reply that fails or quotes a percentage it was not given is
   replaced by a read-out composed from the figures (congestionTemplate), so the panel never shows an
   error or a wrong number where the report should be. */
const CONGESTION_SYSTEM = `You explain a traffic congestion CLASSIFIER to traffic operations staff who are not statisticians. Reply with JSON only.

OUTPUT SHAPE
{
  "summary": "2-3 short plain sentences on how far ahead this map can be trusted. Do NOT restate the forecast window or how many exits are expected to be Severe: the reader is told both in the sentence just before yours.",
  "perModel": [{"model": "<exact name as given>", "verdict": "one plain sentence"}],
  "caveat": "the single most important limitation, or null",
  "meaning": "ONE short sentence beginning exactly 'What this means:' telling a control-room operator what to do with this map"
}

WHAT THE MODEL DOES
It labels every exit-hour on the corridor as Clear, Heavy or Severe from Waze jam reports, using the speed cuts given in the message (CLASSES). Clear means no jam was reported or traffic is moving. It is scored on held-out hours by ACCURACY: the share of exit-hours whose label it got right.

HOW TO READ THE NUMBERS
- Accuracy is a percentage of exit-hours classified correctly. It is NOT an error and NOT a probability of congestion.
- There are TWO different benchmarks. Never confuse them, and never call one by the other's name:
  1. The EXIT-HOUR PROFILE: assume each exit does what it usually does at this hour on this weekday. It is compared with the model's OVERALL accuracy.
  2. NOTHING CHANGES: assume each exit stays in the state it is in right now. It is given PER HOUR AHEAD.
  A forecaster that cannot beat a benchmark adds nothing over it, however high its raw accuracy looks.
- Accuracy is given PER HOUR AHEAD. Whether it holds up or decays across the horizon is the single most useful thing for a reader deciding how far ahead to plan.
- "Nothing changes" decays with distance. A model whose accuracy holds flat while that benchmark falls is becoming MORE valuable further out, not less.
- Accuracy was measured only for the hours ahead listed. If the map shows more hours than that, the hours beyond the last listed one have NO measured accuracy: say so plainly, and do not extend the trend.

RULES
- Never state a number that was not given to you. Never estimate one.
- Every claim must be traceable to a number above. You know NOTHING about how the model was built, what data it saw, or how it will behave in future. Do not speculate.
- If a model is marked rejected, say so and give the stated reason.
- Translate into consequences a control room can act on: how far ahead the map is worth trusting, and what a wrong label would cost.
- Never state a date or a clock time: the window is said for you, in a sentence placed before yours. Speak of "hours ahead" instead.
- Define a class only with the CLASSES speeds given in the message. Never state any other speed.
- Do not recommend retraining, more data, or model changes. The reader operates this system, they do not build it.
- Plain English in short sentences, for a reader who has never studied statistics. Give a percentage a meaning where it helps ("right about two times in three"). No jargon that is not defined in the sentence that uses it. Do not use words like "horizon", "classifier", "persistence", "benchmark" or "held-out" in the output; say "hours ahead", "the model", "assuming nothing changes", "tested on past hours it had not seen".
- Quote percentages exactly as given (one decimal place), or not at all.

THE CAVEAT FIELD
Use it ONLY for a limitation the supplied numbers demonstrate — accuracy that decays sharply with distance, a model that barely clears a benchmark, a class the model never predicts, hours on the map beyond the measured horizon. If the numbers show no such problem, return null. Never invent a limitation you were not told about.`;

function buildCongestionMessage(req: CongestionInsightRequest): string {
  const pct = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? null : `${(v * 100).toFixed(1)}%`;
  const lines: string[] = [];

  lines.push(
    "TASK: classify each exit-hour on the NLEX corridor as Clear, Heavy or Severe.",
    "READER: a traffic control centre deciding how far ahead to act on the congestion map.",
  );

  const { severe, heavy } = speedCuts(req);
  lines.push(`CLASSES: Severe = jams crawling under ${severe} km/h; Heavy = jams at ${severe}-${heavy} km/h; Clear = no jam reported, or moving faster than that.`);

  if (req.situation) {
    const s = req.situation;
    const window = s.windowStart && s.windowEnd ? `, from ${s.windowStart} to ${s.windowEnd} (Philippine time)` : "";
    lines.push(
      `CURRENTLY SHOWN: the next ${s.hoursCovered} hours${window}, ${s.exitsSevere} of ${s.exitsTotal} exits expected to be Severe at some point.`,
    );
    if (s.neverPredictsHeavy) {
      lines.push("NOTE: in this window the model never outputs the Heavy class, so in practice it is deciding between Clear and Severe.");
    }
  }

  lines.push("", "MODEL ACCURACY (share of held-out exit-hours labelled correctly)");
  for (const m of req.models) {
    const parts = [pct(m.accuracy) ? `accuracy ${pct(m.accuracy)}` : null].filter(Boolean);
    if (m.accepted === true) parts.push("ACCEPTED");
    if (m.accepted === false) parts.push(`REJECTED${m.rejectedReason ? ` (${m.rejectedReason})` : ""}`);
    lines.push(`- ${m.model}: ${parts.length ? parts.join(", ") : "no metrics supplied"}`);
  }

  if (req.baseline && pct(req.baseline.accuracy)) {
    lines.push(
      "",
      `OVERALL BENCHMARK, the exit-hour profile (each exit does what it usually does at this hour and weekday): ${req.baseline.model} at ${pct(req.baseline.accuracy)}. Compare the model's OVERALL accuracy with this. This is NOT the "nothing changes" benchmark.`,
    );
  }

  if (req.horizons?.length) {
    lines.push("", "ACCURACY BY HOUR AHEAD (model vs the \"nothing changes\" benchmark: each exit stays as it is now)");
    for (const h of req.horizons) {
      const a = pct(h.accuracy) ?? "n/a";
      const p = pct(h.persistence) ?? "n/a";
      lines.push(`- +${h.horizon}h: model ${a}, nothing-changes ${p}${h.n ? `, scored on ${h.n.toLocaleString()} exit-hours` : ""}`);
    }
    const lastMeasured = Math.max(...req.horizons.map((h) => h.horizon));
    if (req.situation && req.situation.hoursCovered > lastMeasured) {
      lines.push(
        `NOTE: accuracy was measured only up to +${lastMeasured}h. The map shows ${req.situation.hoursCovered} hours, so hours beyond +${lastMeasured}h have NO measured accuracy.`,
      );
    }
  }

  return lines.join("\n");
}

/** The card's speed cuts; 10 and 20 km/h are the trainer's (congestionEval.thresholds_kmh). */
function speedCuts(req: CongestionInsightRequest): { severe: number; heavy: number } {
  return { severe: req.situation?.severeBelowKmh ?? 10, heavy: req.situation?.heavyBelowKmh ?? 20 };
}

const pct1 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : `${(v * 100).toFixed(1)}%`);

/** "about 2 times in 3" style wording for a share, for readers who do not think in percentages. */
function timesIn(v: number): string {
  const options: [number, number][] = [[1, 2], [3, 5], [2, 3], [7, 10], [3, 4], [4, 5], [9, 10]];
  let best = options[0];
  for (const o of options) if (Math.abs(o[0] / o[1] - v) < Math.abs(best[0] / best[1] - v)) best = o;
  return `about ${best[0]} times in ${best[1]}`;
}

/* The read-out composed from the figures alone: what the panel shows when the language model fails,
   times out or quotes a number it was not given. Every figure in it is one the request carried. */
/* The opening sentence: the window's dates and times and what the map expects in it. Composed here for
   the AI reply too, not asked of the model, because a date or a count restated by a language model is a
   date or a count it can get wrong, and this is the sentence the panel shows first. */
function congestionOpening(req: CongestionInsightRequest): string | null {
  const s = req.situation;
  if (!s) return null;
  const { severe } = speedCuts(req);
  const window = s.windowStart && s.windowEnd ? `From ${s.windowStart} to ${s.windowEnd}` : `Over the next ${s.hoursCovered} hours`;
  return s.exitsSevere > 0
    ? `${window}, the map expects ${s.exitsSevere} of ${s.exitsTotal} exits to reach Severe (traffic crawling under ${severe} km/h) at some point.`
    : `${window}, the map does not expect any of the ${s.exitsTotal} exits to reach Severe (traffic crawling under ${severe} km/h).`;
}

export function congestionTemplate(req: CongestionInsightRequest): Insight {
  const m = req.models[0];
  const s = req.situation;
  const hz = (req.horizons ?? []).filter((h) => h.accuracy != null);
  const first = hz[0];
  const last = hz[hz.length - 1];
  const sentences: string[] = [];

  const opening = congestionOpening(req);
  if (opening) sentences.push(opening);
  if (m?.accuracy != null) {
    const base = req.baseline?.accuracy;
    sentences.push(
      `Tested on past hours it had not seen, ${m.model} labelled ${pct1(m.accuracy)} of exit-hours correctly, ${timesIn(m.accuracy)}` +
        (base != null ? `; assuming each exit does what it usually does at that hour got ${pct1(base)}.` : "."),
    );
  }
  // The first hour ahead at which assuming nothing changes does as well as the model, if any.
  const firstLoss = hz.find((h) => h.persistence != null && h.accuracy! <= h.persistence);
  if (first && last && last.horizon !== first.horizon) {
    sentences.push(
      `It was right ${pct1(first.accuracy)} of the time ${first.horizon} hour${first.horizon === 1 ? "" : "s"} ahead and ${pct1(last.accuracy)} at ${last.horizon} hours ahead` +
        (last.persistence != null ? `, where assuming nothing changes was right ${pct1(last.persistence)} of the time.` : "."),
    );
  }

  const lastMeasured = last?.horizon ?? 0;
  const beyond = s && lastMeasured > 0 && s.hoursCovered > lastMeasured;
  const meaning = !last
    ? "What this means: treat the map as a guide and confirm on the live map before sending units."
    : !firstLoss
      ? "What this means: for every hour ahead it was tested on, the map beats assuming today's conditions continue, so it is worth planning on; confirm on the live map before sending units."
      : firstLoss === first
        // No nearer hour to plan on when it already loses at the first one tested.
        ? `What this means: even ${firstLoss.horizon} hour${firstLoss.horizon === 1 ? "" : "s"} ahead the map is no better than assuming today's conditions continue, so treat it as rough and go by the live map before sending units.`
        : `What this means: from ${firstLoss.horizon} hour${firstLoss.horizon === 1 ? "" : "s"} ahead the map is no better than assuming today's conditions continue, so plan on the nearer hours and treat the later ones as rough.`;

  return {
    summary: sentences.join(" ") || "There are no measured figures to describe for this view.",
    perModel: m
      ? [{
          model: m.model,
          verdict:
            m.accepted === false
              ? `Rejected${m.rejectedReason ? `: ${m.rejectedReason}` : ""}.`
              : m.accuracy != null && req.baseline?.accuracy != null
                ? `Accepted; right on ${pct1(m.accuracy)} of past exit-hours, ${m.accuracy > req.baseline.accuracy ? "better than" : "no better than"} the usual-for-the-hour guess (${pct1(req.baseline.accuracy)}).`
                : "Accepted.",
        }]
      : [],
    caveat: beyond ? `Accuracy was only measured up to ${lastMeasured} hours ahead; the later hours on the map have no measured accuracy.` : null,
    meaning,
    source: "template",
  };
}

/* A percentage in the reply that is not one of the request's (to within rounding) is a made-up number. */
function quotesUnknownPercent(text: string, req: CongestionInsightRequest): boolean {
  const known = [
    ...req.models.map((m) => m.accuracy),
    req.baseline?.accuracy,
    ...(req.horizons ?? []).flatMap((h) => [h.accuracy, h.persistence]),
  ].filter((v): v is number => v != null && Number.isFinite(v)).map((v) => v * 100);
  for (const hit of text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
    const n = Number(hit[1]);
    if (!known.some((k) => Math.abs(k - n) <= 0.51)) return true;
  }
  return false;
}

export async function generateCongestionInsight(req: CongestionInsightRequest): Promise<Insight> {
  if (req.models.length === 0) {
    throw new GlmError("No model metrics were supplied.", "bad_model_output");
  }
  try {
    const content = await chat({
      system: CONGESTION_SYSTEM,
      user: buildCongestionMessage(req),
      json: true,
      maxTokens: 1400,
      temperature: 0.3,
    });
    const raw = extractJson(content);
    // Same shaping as the forecast path, with this endpoint's own roster.
    const out = validate(raw, { quantity: "volume", metrics: req.models.map((m) => ({ model: m.model })), horizonDays: 1 });
    const o = (raw ?? {}) as Record<string, unknown>;
    const said = typeof o.meaning === "string" ? o.meaning.trim() : "";
    const meaning = said ? (/^what this means:/i.test(said) ? said : `What this means: ${said}`) : congestionTemplate(req).meaning;
    const all = [out.summary, out.caveat ?? "", meaning ?? "", ...out.perModel.map((p) => p.verdict)].join(" ");
    const { severe, heavy } = speedCuts(req);
    // A speed other than the card's cuts, or a percentage it was not given, and the reply is not used.
    const badSpeed = [...all.matchAll(/(\d+)\s*km\/h/gi)].some((h) => ![severe, heavy].includes(Number(h[1])));
    // So is one that names a date or clock time itself: the opening sentence below already does, correctly.
    const datesItself = /\b\d{1,2}\s?(?:AM|PM)\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/.test(all);
    if (out.summary === "No summary was produced." || badSpeed || datesItself || quotesUnknownPercent(all, req)) {
      console.warn("[ai-insight] congestion reply failed the figure check; serving the composed read-out");
      return congestionTemplate(req);
    }
    const opening = congestionOpening(req);
    return { ...out, summary: opening ? `${opening} ${out.summary}` : out.summary, meaning, source: "ai" };
  } catch (err) {
    // Never an error where the report should be: the figures can always be read out plainly.
    console.warn("[ai-insight] congestion narrative fell back to the composed read-out:", err instanceof Error ? err.message : err);
    return congestionTemplate(req);
  }
}

/* ── Event surge: an uplift, benchmarked against ignoring the event ───────── */

export type EventSurgeInsightRequest = {
  models: { model: string; wmape?: number | null; accepted?: boolean | null; diagnosis?: string | null }[];
  noAdjustment?: { model: string; wmape: number | null } | null;
  coverage?: { eventDays?: number | null; firstEvent?: string | null; lastEvent?: string | null };
  situation?: {
    mode: "observed" | "upcoming";
    eventTitle?: string | null;
    eventDate?: string | null;
    venue?: string | null;
    exitsMaterial: number;
    exitsTotal: number;
    totalAdded: number;
    upliftPct?: number | null;
    topExit?: string | null;
    topAdded?: number | null;
    topSharePct?: number | null;
    top2SharePct?: number | null;
  };
};

const EVENT_SYSTEM = `You explain an event-impact estimate to traffic operations staff who are not statisticians. Reply with JSON only.

OUTPUT SHAPE
{
  "summary": "2-4 sentences: how much to trust this estimate and what it means for the day named",
  "perModel": [{"model": "<exact name as given>", "verdict": "one sentence"}],
  "caveat": "the single most important limitation, or null"
}

WHAT IS BEING ESTIMATED
Not a time series. For each NLEX exit, how much MORE traffic it takes on a Philippine Arena event day than on a matched normal day — the same weekday in the same month. That extra traffic is the "uplift". The estimate is fitted on earlier event days and scored on later event days it never saw.

HOW TO READ THE NUMBERS
- WMAPE is percentage error on those held-out event days. Lower is better. Do not call it strong or weak by a fixed cut: judge it against the baseline it is compared with in the input.
- "Ignoring the event" is the do-nothing benchmark: predict the ordinary day and make no allowance for the event at all. Beating it is the whole point. If the estimate does not beat it, the event adjustment is not earning its place, whatever its own error looks like.
- The number of event days behind the estimate matters more than usual here: these are dozens of days, not thousands, so a small count is a real limit on confidence.

RULES
- Never state a number that was not given to you. Never estimate one.
- Every claim must be traceable to a number above. You know NOTHING about which acts played, how many tickets sold, or how the venue operates. Do not speculate.
- perModel must contain exactly one entry for EVERY model listed under ACCURACY, using its name exactly as given. Never leave it empty.
- Speak about the day the card is actually showing. If no upcoming event is named, you are describing the AVERAGE past event day — do not call it "the upcoming event day".
- Translate into consequences a control room can act on: which exits to staff, and how much of the surge sits in how few places.
- Do not recommend retraining, more data, or model changes. The reader operates this system, they do not build it.
- Plain English. No jargon that is not defined in the sentence that uses it.

THE CAVEAT FIELD
Use it ONLY for a limitation the supplied facts demonstrate — few event days behind the estimate, an estimate barely beating "ignoring the event", a venue that is not the one the uplift was measured on, or a surge concentrated in very few exits. If the facts show no such problem, return null. Never invent one.`;

function buildEventMessage(req: EventSurgeInsightRequest): string {
  const lines: string[] = [];
  const n = (v: number | null | undefined, dp = 0) =>
    v == null || !Number.isFinite(v) ? null : v.toLocaleString("en-US", { maximumFractionDigits: dp });

  lines.push(
    "TASK: estimate the extra traffic each NLEX exit takes on a Philippine Arena event day, against the same weekday in the same month.",
    "READER: a traffic control centre deciding where to put staff and lanes on an event day.",
  );

  if (req.coverage?.eventDays != null) {
    const span =
      req.coverage.firstEvent && req.coverage.lastEvent
        ? `, ${req.coverage.firstEvent} to ${req.coverage.lastEvent}`
        : "";
    lines.push(`MEASURED ON: ${req.coverage.eventDays} past event days${span}.`);
  }

  if (req.situation) {
    const s = req.situation;
    lines.push(
      "",
      "WHAT THE CARD SHOWS NOW",
      s.mode === "upcoming" && s.eventTitle
        ? `- A forecast for an upcoming event: ${s.eventTitle}${s.eventDate ? ` on ${s.eventDate}` : ""}${s.venue ? ` at the ${s.venue}` : ""}.`
        : "- The average pattern across past Philippine Arena event days. NO upcoming event is selected: describe the typical event day, not a future one.",
      `- ${n(s.totalAdded)} extra vehicles across the corridor${s.upliftPct != null ? `, ${s.upliftPct.toFixed(1)}% above a normal day at the exits that move` : ""}.`,
      `- ${s.exitsMaterial} of ${s.exitsTotal} exits show a material rise.`,
    );
    if (s.topExit) {
      lines.push(
        `- Biggest single exit: ${s.topExit}, +${n(s.topAdded)} vehicles${s.topSharePct != null ? ` (${s.topSharePct.toFixed(0)}% of the surge)` : ""}.`,
      );
    }
    if (s.top2SharePct != null) {
      lines.push(`- The two biggest exits carry ${s.top2SharePct.toFixed(0)}% of the surge between them.`);
    }
    if (s.venue && !/arena/i.test(s.venue)) {
      lines.push(
        `- NOTE: the uplift was measured on Philippine Arena days. This event is at the ${s.venue}, a different venue in the same complex, so the scale may not carry across.`,
      );
    }
  }

  lines.push("", "ACCURACY ON HELD-OUT EVENT DAYS");
  for (const m of req.models) {
    const parts: string[] = [];
    if (m.wmape != null && Number.isFinite(m.wmape)) parts.push(`WMAPE ${m.wmape.toFixed(2)}%`);
    if (m.accepted === true) parts.push("ACCEPTED");
    if (m.accepted === false) parts.push("REJECTED");
    if (m.diagnosis) parts.push(m.diagnosis);
    lines.push(`- ${m.model}: ${parts.length ? parts.join(", ") : "no metrics supplied"}`);
  }
  if (req.noAdjustment && req.noAdjustment.wmape != null) {
    lines.push(
      "",
      `DO-NOTHING BENCHMARK: ${req.noAdjustment.model} at WMAPE ${req.noAdjustment.wmape.toFixed(2)}%. An estimate at or above this adds nothing.`,
    );
  }

  return lines.join("\n");
}

export async function generateEventSurgeInsight(req: EventSurgeInsightRequest): Promise<Insight> {
  if (req.models.length === 0) {
    throw new GlmError("No model metrics were supplied.", "bad_model_output");
  }
  const content = await chat({
    system: EVENT_SYSTEM,
    user: buildEventMessage(req),
    json: true,
    maxTokens: 1400,
    temperature: 0.3,
  });
  return validate(extractJson(content), {
    quantity: "volume",
    metrics: req.models.map((m) => ({ model: m.model })),
    horizonDays: 1,
  });
}

/* ── Fleet mix: a forecast of shares (a composition), not of a quantity ───── */

export type FleetMixInsightRequest = {
  models: {
    model: string;
    rank?: number | null;
    accepted?: boolean | null;
    maePp?: number | null;
    mape?: number | null;
    heavyWmape?: number | null;
    heavyR2?: number | null;
    skill?: number | null;
    rejectedReason?: string | null;
    diagnosis?: string | null;
  }[];
  situation?: {
    champion?: string | null;
    heavyNowPct?: number | null;
    heavyNextPct?: number | null;
    windowDays: number;
    projectionDays?: number | null;
    projectionStart?: string | null;
    projectionEnd?: string | null;
    validatedDays: number;
    surgeDays: number;
    surgeDates?: string[];
    dataEnds?: string | null;
    staleDays?: number | null;
  };
};

const FLEET_SYSTEM = `You explain a vehicle fleet-mix forecast to a sustainability team and traffic operations staff who are not statisticians. Reply with JSON only.

OUTPUT SHAPE
{
  "summary": "2-4 sentences: what the forecast says about the share of heavy vehicles and how far to trust it",
  "perModel": [{"model": "<exact name as given>", "verdict": "one sentence"}],
  "caveat": "the single most important limitation, or null"
}

WHAT IS BEING FORECAST
The SHARE of each NLEX toll class in a day's traffic: Class 1 (cars), Class 2 (buses and small trucks), Class 3 (large trucks). The three shares always add up to 100%. "Heavy share" means Class 2 plus Class 3. Heavy vehicles matter because each of their kilometres emits several times a car's CO2.

HOW TO READ THE NUMBERS
- MAE (pp) is the average miss in percentage points of share: 0.5 pp means a class forecast at 9.0% typically turns out between 8.5% and 9.5%.
- MAPE and heavy WMAPE are percentage errors. MAPE punishes the small Class 3 share hardest, which is why the models are ranked by Aitchison distance instead (a measure made for shares that add up to 100%).
- Heavy R2 near 1 is good, near 0 means the model explains little of the day-to-day movement in the heavy share, negative is worse than predicting the average.
- SKILL compares each model with persistence: assuming tomorrow's mix is the same as the last one seen. Each model is labelled BEATS-PERSISTENCE, FAILS-PERSISTENCE or LEVEL-WITH-PERSISTENCE, and that label is authoritative. Do not reinterpret the raw number.

HOW A MODEL IS ACCEPTED (this decides the verdicts)
A candidate is accepted only if its Aitchison distance beats the BETTER of the two baselines, Climatology (the usual mix for that day of the week and month) and Persistence. Beating persistence alone is NOT enough. So a model can be labelled BEATS-PERSISTENCE and still be REJECTED, because Climatology is the harder bar: that is not a contradiction, say it plainly. Climatology and Persistence are baselines, not candidates; describe them as the yardsticks the candidates were measured against.

RULES
- Never state a number that was not given to you. Never estimate one.
- Every claim must be traceable to a fact above. You know NOTHING about how the models were built, what data they saw, or why the mix moves. Do not speculate about causes.
- perModel must contain exactly one entry for EVERY model listed, using its name exactly as given.
- Repeat each model's persistence label faithfully. If a model is marked rejected or as a baseline, say so and give the stated reason.
- If the heavy share is said to change by less than 1 percentage point, say there is no material change; do not describe it as a rise or a fall.
- If the facts say the projection covers dates that have already passed, say so plainly in the summary: it is a check against what happened, not a look ahead.
- Translate into consequences: what a heavy share at this level means for planning and for CO2.
- Do not recommend retraining, more data, or model changes. The reader operates this system, they do not build it.
- Plain English. No jargon that is not defined in the sentence that uses it.

THE CAVEAT FIELD
Use it ONLY for a limitation the supplied facts demonstrate: a projection longer than the horizon the models were validated at, a projection over dates already passed, a champion that barely beats persistence, a low heavy R2. If none applies, return null. Never invent one.`;

function buildFleetMessage(req: FleetMixInsightRequest): string {
  const lines: string[] = [];
  const f = (v: number | null | undefined, dp: number) => (v == null || !Number.isFinite(v) ? null : v.toFixed(dp));
  lines.push(
    "TASK: forecast the daily share of each toll class on the NLEX corridor.",
    "READER: a sustainability team and traffic control centre planning for heavy-vehicle traffic and its CO2.",
  );
  const s = req.situation;
  if (s) {
    lines.push("", "WHAT THE CARD SHOWS NOW");
    if (s.champion) lines.push(`- The forecast drawn is the champion model's: ${s.champion}.`);
    if (s.heavyNowPct != null && s.heavyNextPct != null) {
      const d = s.heavyNextPct - s.heavyNowPct;
      lines.push(
        `- Heavy share (Class 2 + Class 3): ${s.heavyNowPct.toFixed(2)}% over the last ${s.windowDays} observed days, ${s.heavyNextPct.toFixed(2)}% averaged over the projection.`,
        Math.abs(d) < 1
          ? `- That is a change of ${d.toFixed(2)} percentage points: NO MATERIAL CHANGE.`
          : `- That is a change of ${d > 0 ? "+" : ""}${d.toFixed(2)} percentage points.`,
      );
    }
    if (s.projectionDays) {
      lines.push(
        `- The projection runs ${s.projectionDays} days${s.projectionStart && s.projectionEnd ? `, ${s.projectionStart} to ${s.projectionEnd}` : ""}. The models were validated at ${s.validatedDays} days ahead.`,
      );
    }
    lines.push(
      s.surgeDays > 0
        ? `- Heavy-vehicle surge flagged on ${s.surgeDays} projected day(s)${s.surgeDates?.length ? `: ${s.surgeDates.join(", ")}` : ""} (heavy share more than 1.5 standard deviations above its training mean).`
        : "- No heavy-vehicle surge day is flagged in the projection.",
    );
    if (s.dataEnds && s.staleDays != null && s.staleDays > 45) {
      lines.push(`- The observed data ends ${s.dataEnds}, ${s.staleDays} days before today, so the projection covers dates that have ALREADY PASSED.`);
    }
  }
  lines.push("", "MODEL SCORES ON HELD-OUT DAYS");
  for (const m of req.models) {
    const parts: string[] = [];
    if (f(m.maePp, 2)) parts.push(`MAE ${f(m.maePp, 2)} pp`);
    if (f(m.mape, 2)) parts.push(`MAPE ${f(m.mape, 2)}%`);
    if (f(m.heavyWmape, 2)) parts.push(`heavy WMAPE ${f(m.heavyWmape, 2)}%`);
    if (f(m.heavyR2, 3)) parts.push(`heavy R2 ${f(m.heavyR2, 3)}`);
    // Decided here, not by the model: the same lesson as MASE on the forecast path.
    if (m.skill != null && Number.isFinite(m.skill)) {
      parts.push(`skill ${m.skill.toFixed(3)}`, m.skill < 0.995 ? "BEATS-PERSISTENCE" : m.skill > 1.005 ? "FAILS-PERSISTENCE" : "LEVEL-WITH-PERSISTENCE");
    }
    if (m.rank != null) parts.push(`rank ${m.rank}`);
    parts.push(m.accepted === false ? (m.rejectedReason ? "REJECTED" : "BASELINE (not a candidate)") : m.rank === 1 ? "accepted, CHAMPION" : "accepted");
    // The leaderboard carries "NaN" and repeats the reason as the diagnosis; neither tells the reader anything.
    const real = (v: string | null | undefined) => (v && v.trim() && !/^nan$/i.test(v.trim()) ? v.trim() : null);
    const reason = real(m.rejectedReason);
    const diagnosis = real(m.diagnosis);
    if (reason) parts.push(`reason: ${reason}`);
    if (diagnosis && diagnosis !== reason) parts.push(`diagnosis: ${diagnosis}`);
    lines.push(`- ${m.model}: ${parts.join(", ")}`);
  }
  lines.push("", `Write one verdict for each of the ${req.models.length} models above, using their exact names.`);
  return lines.join("\n");
}

export async function generateFleetMixInsight(req: FleetMixInsightRequest): Promise<Insight> {
  if (req.models.length === 0) {
    throw new GlmError("No model metrics were supplied.", "bad_model_output");
  }
  const content = await chat({
    system: FLEET_SYSTEM,
    user: buildFleetMessage(req),
    json: true,
    // Six models (four candidates and two baselines) take more reasoning than the other cards' rosters.
    maxTokens: 3200,
    temperature: 0.3,
  });
  return validate(extractJson(content), {
    quantity: "emissions",
    metrics: req.models.map((m) => ({ model: m.model })),
    horizonDays: 1,
  });
}

/* ── Ranking: a ranked list of corridor locations, not a forecast or classifier ── */

export type RankingRowInput = { label: string; value: number; sharePct?: number | null; n?: number | null };

export type RankingInsightRequest = {
  cardTitle: string;
  groupBy: "exit" | "segment";
  metricLabel: string;
  metricUnit: "count" | "percent";
  metricDescription: string;
  horizonDays?: number | null;
  totalLabel?: string | null;
  rows: RankingRowInput[];
};

const RANKING_SYSTEM = `You explain a ranked list of NLEX corridor locations to traffic operations staff who are not statisticians. Reply with JSON only.

OUTPUT SHAPE
{
  "summary": "2-4 sentences: where the numbers are concentrated and what that means for where to act",
  "perModel": [{"model": "<exact location label as given>", "verdict": "one sentence"}],
  "caveat": "the single most important limitation, or null"
}

RULES
- Never state a number that was not given to you. Never estimate one.
- Every claim must be traceable to a number above. You know NOTHING about why a location scores the way it does, what infrastructure is there, or what caused past incidents. Do not speculate about causes.
- perModel must contain exactly one entry for EVERY location listed, using its label exactly as given.
- A location's evidence count (n), when given, matters: a location built from very few observations is a small-sample result, not a confident finding -- say so if the ranking leans on a thin-evidence row.
- Translate into consequences a control room can act on: where to concentrate response resources, not why the numbers look the way they do.
- Do not recommend retraining, more data, or model changes. The reader operates this system, they do not build it.
- Plain English. No jargon that is not defined in the sentence that uses it.

THE CAVEAT FIELD
Use it ONLY for a limitation the supplied numbers themselves demonstrate -- a ranking that leans on one or two locations with very little evidence, a total dominated by a single location, a percent metric with a narrow spread across the whole list. If the numbers show no such problem, return null. Never invent a limitation about causes, infrastructure, or anything else you were not told.`;

function buildRankingMessage(req: RankingInsightRequest): string {
  const lines: string[] = [];
  lines.push(`TASK: rank NLEX corridor ${req.groupBy}s by ${req.metricLabel}.`);
  lines.push(`METRIC: ${req.metricDescription}`);
  if (req.horizonDays != null) lines.push(`HORIZON: ${req.horizonDays} days ahead.`);
  if (req.totalLabel) lines.push(`TOTAL: ${req.totalLabel}.`);

  lines.push("", `${req.groupBy.toUpperCase()} RANKING (${req.metricLabel}${req.metricUnit === "percent" ? ", %" : ""})`);
  for (const r of req.rows) {
    const parts: string[] = [
      `${req.metricLabel} ${
        req.metricUnit === "percent" ? `${r.value.toFixed(1)}%` : r.value.toLocaleString("en-US", { maximumFractionDigits: 0 })
      }`,
    ];
    if (r.sharePct != null) parts.push(`${r.sharePct.toFixed(1)}% of total`);
    if (r.n != null) parts.push(`n=${r.n.toLocaleString("en-US")}`);
    lines.push(`- ${r.label}: ${parts.join(", ")}`);
  }

  lines.push("", `Write one verdict for each of the ${req.rows.length} locations above, using their exact labels.`);
  return lines.join("\n");
}

export async function generateRankingInsight(req: RankingInsightRequest): Promise<Insight> {
  if (req.rows.length === 0) {
    throw new GlmError("No ranking rows were supplied.", "bad_model_output");
  }

  const content = await chat({
    system: RANKING_SYSTEM,
    user: buildRankingMessage(req),
    json: true,
    maxTokens: 1800,
    temperature: 0.3,
  });

  // Reuses the shared forecast-shaped validator: "model" doubles as the
  // location label here, and validate() only checks it against the supplied
  // set (guarding hallucinated rows), it never assumes the value is an
  // algorithm name.
  return validate(extractJson(content), {
    quantity: "volume",
    metrics: req.rows.map((r) => ({ model: r.label })),
    horizonDays: req.horizonDays ?? 1,
  });
}

export async function generateInsight(req: InsightRequest): Promise<Insight> {
  if (req.metrics.length === 0) {
    throw new GlmError("No model metrics were supplied.", "bad_model_output");
  }

  const content = await chat({
    system: SYSTEM,
    user: buildUserMessage(req),
    json: true,
    // Room for a summary plus one line per model, with headroom for the larger
    // rosters (the incident module scores seven).
    maxTokens: 1800,
    // A touch above zero: this is explanatory prose, and at exactly 0 the
    // per-model verdicts came out near-identical to each other.
    temperature: 0.3,
  });

  return validate(extractJson(content), req);
}
