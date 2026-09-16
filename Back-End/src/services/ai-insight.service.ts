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
};

export type Insight = {
  /** 2-4 sentences an operations reader can act on. */
  summary: string;
  /** One line per model, in the order supplied. */
  perModel: { model: string; verdict: string }[];
  /** The single most important caveat, or null when there is nothing to add. */
  caveat: string | null;
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
- WMAPE is percentage error. Lower is better. Under 10% is strong, 10-20% usable, over 20% weak.
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
    if (m.mase != null && Number.isFinite(m.mase)) {
      parts.push(
        m.mase < 0.995
          ? "BEATS-BENCHMARK"
          : m.mase > 1.005
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
function validate(raw: unknown, req: InsightRequest): Insight {
  const o = (raw ?? {}) as Record<string, unknown>;

  const summary =
    typeof o.summary === "string" && o.summary.trim().length > 0
      ? o.summary.trim()
      : "No summary was produced.";

  const supplied = new Set(req.metrics.map((m) => m.model));
  const perModel: { model: string; verdict: string }[] = [];

  if (Array.isArray(o.perModel)) {
    for (const item of o.perModel) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const model = typeof r.model === "string" ? r.model.trim() : "";
      const verdict = typeof r.verdict === "string" ? r.verdict.trim() : "";
      // A verdict for a model that was not sent is a hallucination — drop it
      // rather than showing the reader a row that is not on their chart.
      if (!model || !verdict || !supplied.has(model)) continue;
      perModel.push({ model, verdict });
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
  };
};

const CONGESTION_SYSTEM = `You explain a traffic congestion CLASSIFIER to traffic operations staff who are not statisticians. Reply with JSON only.

OUTPUT SHAPE
{
  "summary": "2-4 sentences: how far ahead this map can be trusted and what that means for acting on it",
  "perModel": [{"model": "<exact name as given>", "verdict": "one sentence"}],
  "caveat": "the single most important limitation, or null"
}

WHAT THE MODEL DOES
It labels every exit-hour on the corridor as Clear, Heavy or Severe from Waze jam reports: Severe means jams running under 30 km/h, Heavy means 30-60 km/h, Clear means no jam was reported. It is scored on held-out hours by ACCURACY: the share of exit-hours whose label it got right.

HOW TO READ THE NUMBERS
- Accuracy is a percentage of exit-hours classified correctly. It is NOT an error and NOT a probability of congestion.
- The benchmark is "nothing changes": assume each exit stays in the state it is in now. A forecaster that cannot beat that benchmark adds nothing, however high its raw accuracy looks.
- Accuracy is given PER HOUR AHEAD. Whether it holds up or decays across the horizon is the single most useful thing for a reader deciding how far ahead to plan.
- The benchmark itself decays with distance. A model whose accuracy holds flat while the benchmark falls is becoming MORE valuable further out, not less.

RULES
- Never state a number that was not given to you. Never estimate one.
- Every claim must be traceable to a number above. You know NOTHING about how the model was built, what data it saw, or how it will behave in future. Do not speculate.
- If a model is marked rejected, say so and give the stated reason.
- Translate into consequences a control room can act on: how far ahead the map is worth trusting, and what a wrong label would cost.
- Do not recommend retraining, more data, or model changes. The reader operates this system, they do not build it.
- Plain English. No jargon that is not defined in the sentence that uses it.

THE CAVEAT FIELD
Use it ONLY for a limitation the supplied numbers demonstrate — accuracy that decays sharply with distance, a model that barely clears the benchmark, a class the model never predicts. If the numbers show no such problem, return null. Never invent a limitation you were not told about.`;

function buildCongestionMessage(req: CongestionInsightRequest): string {
  const pct = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? null : `${(v * 100).toFixed(1)}%`;
  const lines: string[] = [];

  lines.push(
    "TASK: classify each exit-hour on the NLEX corridor as Clear, Heavy or Severe.",
    "READER: a traffic control centre deciding how far ahead to act on the congestion map.",
  );

  if (req.situation) {
    const s = req.situation;
    lines.push(
      `CURRENTLY SHOWN: the next ${s.hoursCovered} hours, ${s.exitsSevere} of ${s.exitsTotal} exits expected to be severe at some point.`,
    );
    if (s.neverPredictsHeavy) {
      lines.push(
        "NOTE: the model never outputs the Heavy class on this corridor — reported jams almost always run under 30 km/h, so in practice it decides between Clear and Severe.",
      );
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
      `BENCHMARK TO BEAT: ${req.baseline.model} at ${pct(req.baseline.accuracy)}. A model at or below this adds nothing.`,
    );
  }

  if (req.horizons?.length) {
    lines.push("", "ACCURACY BY HOUR AHEAD (model vs the \"nothing changes\" benchmark)");
    for (const h of req.horizons) {
      const a = pct(h.accuracy) ?? "n/a";
      const p = pct(h.persistence) ?? "n/a";
      lines.push(`- +${h.horizon}h: model ${a}, nothing-changes ${p}${h.n ? `, scored on ${h.n.toLocaleString()} exit-hours` : ""}`);
    }
  }

  return lines.join("\n");
}

export async function generateCongestionInsight(req: CongestionInsightRequest): Promise<Insight> {
  if (req.models.length === 0) {
    throw new GlmError("No model metrics were supplied.", "bad_model_output");
  }
  const content = await chat({
    system: CONGESTION_SYSTEM,
    user: buildCongestionMessage(req),
    json: true,
    maxTokens: 1400,
    temperature: 0.3,
  });
  const raw = extractJson(content);
  // Same shaping as the forecast path, with this endpoint's own roster.
  return validate(raw, { quantity: "volume", metrics: req.models.map((m) => ({ model: m.model })), horizonDays: 1 });
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
- WMAPE is percentage error on those held-out event days. Lower is better. Under 10% is strong for an event estimate, 10-20% usable, over 20% weak.
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
