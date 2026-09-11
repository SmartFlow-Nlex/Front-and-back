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
