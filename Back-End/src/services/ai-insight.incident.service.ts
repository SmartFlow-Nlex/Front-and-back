import { chat, extractJson, GlmError } from "../lib/glm.client.js";
import { validate, type Insight } from "./ai-insight.service.js";

/* ══════════════════════════════════════════════════════════════════════════════
   AI INSIGHT — THE INCIDENT MODULE'S NON-FORECAST MODELS

   The incident FORECAST (how many incidents tomorrow) goes through
   ai-insight.service.ts alongside volume and emissions, because it is the same
   kind of thing: a daily count with a percentage error, a MASE against last
   week, an R2. The rest of the incident module is not, and that is why this
   file exists rather than three more branches in there.

   Three scales, none of which the forecast prompt can read:

     severity        accuracy + ordinal MAE   a classifier over three ranks
     clearance       concordance index        an ORDERING, not an error
     secondary risk  AUC against a base rate  meaningless without the base rate

   Handed to a prompt that reasons in WMAPE, a concordance index of 0.71 reads
   as "71% error" and an AUC of 0.68 reads as "68% accurate". Both are wrong,
   both sound authoritative, and an operator would act on them. A separate
   prompt per scale is cheap next to that.

   As with the rest of this feature: everything sent is already on the
   operator's screen. No corridor rows, no credentials, nothing stored.
══════════════════════════════════════════════════════════════════════════════ */

const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? null : `${(v * 100).toFixed(1)}%`;
const pct0 = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? null : `${(v * 100).toFixed(0)}%`;
const num = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? null : v.toFixed(dp);
const int = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v).toLocaleString();

/* ── 1. Severity, clearance and secondary risk, together ──────────────────────
 *
 * One endpoint rather than three, because the panel shows them together and the
 * useful read-out is about their interaction: a clearance model that orders
 * incidents well is worth more when the severity classifier is under-calling
 * the class that takes longest to clear. Split apart, no prompt could say that.
 */

export type IncidentModelsInsightRequest = {
  severity: {
    champion?: string | null;
    models?: {
      model: string;
      accuracy?: number | null;
      maeOrdinal?: number | null;
      n?: number | null;
    }[];
    breakdown?: { label: string; actualCount: number; predictedCount: number }[];
  };
  clearance?: {
    concordanceIndex?: number | null;
    maeMinutes?: number | null;
    n?: number | null;
    medianMin?: number | null;
    meanMin?: number | null;
  };
  secondaryRisk?: {
    auc?: number | null;
    baseRate?: number | null;
    n?: number | null;
    kmRadius?: number | null;
    avgRisk?: number | null;
  };
  hotspots?: {
    name: string;
    km?: number | null;
    n?: number | null;
    avgRisk?: number | null;
    actualSecondaryCount?: number | null;
  }[];
};

/** Fixed display names for the two single-model families, which have no metrics
 *  table to draw a name from. The reply may only name these plus the severity
 *  candidates; anything else is dropped by validate(). */
const CLEARANCE_MODEL_NAME = "Clearance time (Cox PH)";
const SECONDARY_MODEL_NAME = "Secondary incident risk";

const INCIDENT_MODELS_SYSTEM = `You explain three incident-response models to traffic operations staff who are not statisticians. Reply with JSON only.

OUTPUT SHAPE — every <...> below is a PLACEHOLDER. Replace each one with your own
words. Returning the placeholder text itself is a failed answer.
Write out every perModel entry in full. Never abbreviate the array with "...",
"etc" or a comment, and never return fewer entries than there are names listed.
{
  "summary": "<2-4 sentences on what these models can and cannot be relied on for, in operational terms>",
  "perModel": [{"model": "<exact model name, copied from the sections below>", "verdict": "<one sentence on that model>"}],
  "caveat": "<the single most important limitation>, or null"
}
Write one perModel entry for EVERY model named in the sections below, using its name exactly.

WHAT THE THREE MODELS DO
- SEVERITY: given an incident, predicts whether it is Property Damage Only, Injury or Fatal. A classifier over three ordered ranks.
- CLEARANCE (Cox proportional hazards): predicts how long an incident takes to clear.
- SECONDARY RISK: predicts whether a second incident follows near the first, within a stated km radius.

HOW TO READ EACH SCALE. THESE ARE NOT INTERCHANGEABLE.
- ACCURACY is the share of incidents whose severity was labelled correctly. Higher is better.
- ORDINAL MAE is how many severity STEPS out the model lands on average when wrong. 0.2 means most mistakes are one rank out, not two. Measured in ranks, NOT in incidents and NOT a percentage.
- CONCORDANCE INDEX is the share of incident PAIRS the clearance model puts in the right order: given two incidents, does it correctly say which clears first. 0.5 is a coin toss. It is NOT an accuracy, NOT an error, and NOT a percentage of incidents predicted correctly. Never call it an error rate.
- MAE MINUTES, where given, IS an error: the average number of minutes the clearance estimate is out by.
- AUC is only meaningful against the BASE RATE. If secondary incidents follow 4% of the time, a model that flags nothing is right 96% of the time and useless. AUC 0.5 is a coin toss; say how far above 0.5 this one sits.
- A PREDICTED vs ACTUAL count table shows whether the classifier over- or under-calls a class. A class it systematically under-predicts is one the control room will be under-resourced for.

RULES
- Never state a number that was not given to you. Never estimate one.
- Never convert between these scales. A concordance index is not an accuracy; an ordinal MAE is not a percentage.
- Every claim must be traceable to a number above. You know NOTHING about how these models were built or what data they saw. Do not speculate.
- Translate into consequences for a control room: what gets mis-resourced, which locations deserve a standing watch, how far to trust a clearance estimate when deciding whether to divert traffic.
- Do not recommend retraining, more data, or model changes. The reader operates this system, they do not build it.
- Plain English. No jargon that is not defined in the sentence that uses it.

THE CAVEAT FIELD
Use it ONLY for a limitation the supplied numbers demonstrate: an AUC barely above 0.5, a severity class rarely predicted, a small sample behind a hotspot, a concordance index near a coin toss. If the numbers show no such problem, return null. Never invent one.`;

function buildIncidentModelsMessage(req: IncidentModelsInsightRequest): string {
  const lines: string[] = [];

  lines.push(
    "SUBJECT: the models behind the NLEX corridor's severity, clearance and secondary-risk panel.",
    "READER: a traffic control centre deciding how to resource and position incident response.",
  );

  lines.push("", "MODEL 1 - SEVERITY CLASSIFIER (Property Damage Only / Injury / Fatal)");
  if (req.severity.champion) lines.push(`Champion in use: ${req.severity.champion}.`);
  for (const m of req.severity.models ?? []) {
    const parts = [
      pct(m.accuracy) ? `accuracy ${pct(m.accuracy)}` : null,
      num(m.maeOrdinal) ? `ordinal MAE ${num(m.maeOrdinal)} severity ranks` : null,
      m.n ? `scored on ${m.n.toLocaleString()} incidents` : null,
    ].filter(Boolean);
    lines.push(`- ${m.model}: ${parts.length ? parts.join(", ") : "no metrics supplied"}`);
  }
  if (req.severity.breakdown?.length) {
    lines.push("Predicted vs actual counts by class (held-out):");
    for (const b of req.severity.breakdown) {
      lines.push(
        `- ${b.label}: actual ${b.actualCount.toLocaleString()}, predicted ${b.predictedCount.toLocaleString()}`,
      );
    }
  }

  const c = req.clearance;
  if (c && (c.concordanceIndex != null || c.maeMinutes != null || c.medianMin != null)) {
    lines.push("", `MODEL 2 - ${CLEARANCE_MODEL_NAME}`);
    const parts = [
      num(c.concordanceIndex, 3)
        ? `concordance index ${num(c.concordanceIndex, 3)} (share of incident PAIRS ordered correctly; 0.5 is a coin toss)`
        : null,
      num(c.maeMinutes, 1) ? `average error ${num(c.maeMinutes, 1)} minutes` : null,
      c.n ? `fitted on ${c.n.toLocaleString()} incidents` : null,
    ].filter(Boolean);
    if (parts.length) lines.push(`- ${parts.join(", ")}`);
    if (num(c.medianMin, 1)) {
      lines.push(`- Predicted MEDIAN clearance across incidents: ${num(c.medianMin, 1)} minutes.`);
    }
    if (num(c.meanMin, 1)) {
      lines.push(
        `- Predicted MEAN clearance: ${num(c.meanMin, 1)} minutes. A mean well above the median means a long tail of slow incidents.`,
      );
    }
  }

  const r = req.secondaryRisk;
  if (r && (r.auc != null || r.baseRate != null)) {
    lines.push("", `MODEL 3 - ${SECONDARY_MODEL_NAME}`);
    if (r.kmRadius != null) {
      lines.push(`A "secondary" incident is one following the first within ${r.kmRadius} km.`);
    }
    const parts = [
      num(r.auc, 3) ? `AUC ${num(r.auc, 3)} (0.5 is a coin toss)` : null,
      pct(r.baseRate)
        ? `base rate ${pct(r.baseRate)} - the share of incidents actually followed by a second one`
        : null,
      r.n ? `scored on ${r.n.toLocaleString()} incidents` : null,
    ].filter(Boolean);
    if (parts.length) lines.push(`- ${parts.join(", ")}`);
    if (pct(r.avgRisk)) {
      lines.push(`- Average predicted risk across the corridor right now: ${pct(r.avgRisk)}.`);
    }
  }

  /* Spell the roster out.
   *
   * The names are already in the sections above, but the model paraphrased
   * them ("Severity model", "Clearance model") and validate() then dropped
   * every verdict as naming something that was not sent — the summary came
   * back excellent with an empty perModel list. Listing the exact strings once,
   * as the last instruction before the data, is what made it copy them. */
  const roster = [
    ...(req.severity.models ?? []).map((m) => m.model),
    ...(req.clearance ? [CLEARANCE_MODEL_NAME] : []),
    ...(req.secondaryRisk ? [SECONDARY_MODEL_NAME] : []),
  ];
  if (roster.length) {
    lines.push(
      "",
      "PER-MODEL ENTRIES REQUIRED. Use these names EXACTLY, one entry each:",
      ...roster.map((r) => `- ${r}`),
    );
  }

  if (req.hotspots?.length) {
    lines.push("", "HIGHEST-RISK LOCATIONS CURRENTLY SHOWN");
    for (const h of req.hotspots) {
      const parts = [
        pct(h.avgRisk) ? `predicted risk ${pct(h.avgRisk)}` : null,
        h.n ? `${h.n.toLocaleString()} incidents on record` : null,
        h.actualSecondaryCount != null
          ? `${h.actualSecondaryCount} actually had a follow-on`
          : null,
      ].filter(Boolean);
      lines.push(`- ${h.name}${h.km != null ? ` (Km ${h.km})` : ""}: ${parts.join(", ")}`);
    }
  }

  return lines.join("\n");
}

export async function generateIncidentModelsInsight(
  req: IncidentModelsInsightRequest,
): Promise<Insight> {
  const roster = [
    ...(req.severity.models ?? []).map((m) => ({ model: m.model })),
    { model: CLEARANCE_MODEL_NAME },
    { model: SECONDARY_MODEL_NAME },
  ];
  if ((req.severity.models ?? []).length === 0 && !req.clearance && !req.secondaryRisk) {
    throw new GlmError("No incident model metrics were supplied.", "bad_model_output");
  }
  const content = await chat({
    system: INCIDENT_MODELS_SYSTEM,
    user: buildIncidentModelsMessage(req),
    json: true,
    maxTokens: 1600,
    temperature: 0.3,
  });
  return validate(extractJson(content), {
    quantity: "incidents",
    metrics: roster,
    horizonDays: 1,
  });
}

/* ── 2. Clearance curves: a distribution, not a forecast ────────────────────── */

export type ClearanceInsightRequest = {
  dimension: string;
  groups: {
    group: string;
    n?: number | null;
    medianMin?: number | null;
    stillOpen60?: number | null;
    stillOpen120?: number | null;
    isBaseline?: boolean;
  }[];
  trainedAt?: string | null;
};

const CLEARANCE_SYSTEM = `You explain incident clearance-time curves to traffic operations staff who are not statisticians. Reply with JSON only.

OUTPUT SHAPE — every <...> below is a PLACEHOLDER. Replace each one with your own
words. Returning the placeholder text itself is a failed answer.
Write out every perModel entry in full. Never abbreviate the array with "...",
"etc" or a comment, and never return fewer entries than there are names listed.
{
  "summary": "<2-4 sentences on how long each kind of incident blocks the road, and what that means for response planning>",
  "perModel": [{"model": "<exact group name, copied from the list below>", "verdict": "<one sentence on that group>"}],
  "caveat": "<the single most important limitation>, or null"
}
Write one perModel entry for EVERY group in the list below, using its name exactly.

WHAT THE CURVES SHOW
For each kind of incident, the share still NOT cleared as time passes. The median is where half are cleared and half are still blocking the road. This is a measured distribution of what has already happened on this corridor. It is NOT a forecast of any particular future incident.

HOW TO READ THE NUMBERS
- MEDIAN MINUTES: half of this kind clear faster than this, half slower. Not an average, not a guarantee.
- STILL OPEN AT 60 / 120 MINUTES: the share of that kind still blocking the road at that mark. This is what decides whether a closure outlasts a peak period.
- A BASELINE group, where present, is the average incident across all kinds. The useful statement is how much longer or shorter a kind runs than a typical incident.
- n is how many real incidents sit behind each curve. A curve built on very few incidents is a weak basis for a claim, and you should say so rather than treat it as equal to the others.

RULES
- Never state a number that was not given to you. Never estimate one.
- Never describe these as predictions of a specific future incident. They describe the spread of what has already happened.
- Every claim must be traceable to a number above. Do not speculate about causes, road conditions, responder availability or anything else you were not told.
- Translate into consequences: which kinds need a standing plan because they routinely outlast an hour, and which clear fast enough to absorb.
- Do not recommend retraining, more data, or model changes. The reader operates this system, they do not build it.
- Plain English. No jargon that is not defined in the sentence that uses it.

THE CAVEAT FIELD
Use it ONLY for a limitation the supplied numbers demonstrate: a group with very few incidents behind it, a median close enough to the baseline that the difference is not worth acting on, a long tail still open at two hours. If the numbers show no such problem, return null. Never invent one.`;

function buildClearanceMessage(req: ClearanceInsightRequest): string {
  const lines: string[] = [];

  lines.push(
    `SUBJECT: how long NLEX corridor incidents take to clear, split by ${req.dimension}.`,
    "READER: a traffic control centre planning incident response and lane-closure duration.",
  );
  if (req.trainedAt) lines.push(`Model last fitted: ${req.trainedAt}.`);

  lines.push("", "CLEARANCE BY GROUP");
  for (const g of req.groups) {
    const parts = [
      num(g.medianMin, 0) ? `median ${num(g.medianMin, 0)} min` : null,
      pct0(g.stillOpen60) ? `${pct0(g.stillOpen60)} still open at 60 min` : null,
      pct0(g.stillOpen120) ? `${pct0(g.stillOpen120)} still open at 120 min` : null,
      g.n ? `${g.n.toLocaleString()} incidents` : null,
    ].filter(Boolean);
    lines.push(
      `- ${g.group}${g.isBaseline ? " (BASELINE - the average incident)" : ""}: ${
        parts.length ? parts.join(", ") : "no figures supplied"
      }`,
    );
  }

  return lines.join("\n");
}

export async function generateClearanceInsight(req: ClearanceInsightRequest): Promise<Insight> {
  if (req.groups.length === 0) {
    throw new GlmError("No clearance groups were supplied.", "bad_model_output");
  }
  const content = await chat({
    system: CLEARANCE_SYSTEM,
    user: buildClearanceMessage(req),
    json: true,
    maxTokens: 1400,
    temperature: 0.3,
  });
  return validate(extractJson(content), {
    quantity: "incidents",
    metrics: req.groups.map((g) => ({ model: g.group })),
    horizonDays: 1,
  });
}

/* ── 3. Type priority: measured clearance crossed with a forecast ───────────── */

export type IncidentPriorityInsightRequest = {
  horizonDays: number;
  totalPredicted?: number | null;
  forecastModel?: string | null;
  types: {
    label: string;
    medianClearanceMin?: number | null;
    predictedCount?: number | null;
    expectedLaneMinutes?: number | null;
    sharePct?: number | null;
    dispatch?: string | null;
  }[];
};

const PRIORITY_SYSTEM = `You explain an incident-response priority ranking to traffic operations staff who are not statisticians. Reply with JSON only.

OUTPUT SHAPE — every <...> below is a PLACEHOLDER. Replace each one with your own
words. Returning the placeholder text itself is a failed answer.
Write out every perModel entry in full. Never abbreviate the array with "...",
"etc" or a comment, and never return fewer entries than there are names listed.
{
  "summary": "<2-4 sentences on which incident types deserve resourcing first over this horizon, and why>",
  "perModel": [{"model": "<exact type label, copied from the list below>", "verdict": "<one sentence on that type>"}],
  "caveat": "<the single most important limitation>, or null"
}
Write one perModel entry for EVERY type in the list below, using its label exactly.

HOW THE RANKING IS BUILT
Two numbers are crossed per incident type:
- its MEASURED median clearance time on this corridor, and
- a PREDICTED count over the horizon, apportioned from the corridor's total incident forecast by that type's historical share.
Multiplying them gives EXPECTED LANE-MINUTES LOST: roughly how much blocked-road time that type is expected to cause. A type that is common but clears fast can matter less than a rare type that blocks the road for hours. That trade-off is the whole point of the ranking.

WHAT IS AND IS NOT A MODEL OUTPUT
- The clearance times are measured from real incidents.
- The total incident forecast comes from the named forecasting model.
- The per-type split is apportioned by historical share, NOT separately forecast. Say so if you lean on it.
- The DISPATCH PACKAGE per type is standard operational doctrine, not something any model predicted. Never present it as a model recommendation.

RULES
- Never state a number that was not given to you. Never estimate one.
- Every claim must be traceable to a number above. Do not speculate about responder availability, budgets, staffing or anything else you were not told.
- Rank by expected lane-minutes where given, and say plainly when a type ranks high for frequency rather than duration, or the reverse.
- Do not recommend retraining, more data, or model changes. The reader operates this system, they do not build it.
- Plain English. No jargon that is not defined in the sentence that uses it.

THE CAVEAT FIELD
Use it ONLY for a limitation the supplied numbers demonstrate: a per-type count resting on an apportioned share rather than its own forecast, a median resting on few incidents, two types close enough that the order between them is arbitrary. If the numbers show no such problem, return null. Never invent one.`;

function buildPriorityMessage(req: IncidentPriorityInsightRequest): string {
  const lines: string[] = [];
  lines.push(
    "SUBJECT: which kinds of NLEX corridor incident to resource first.",
    "READER: a traffic control centre allocating response units for the period ahead.",
    `HORIZON: the next ${req.horizonDays} days.`,
  );
  if (int(req.totalPredicted)) {
    lines.push(
      `TOTAL INCIDENTS FORECAST over that horizon: ${int(req.totalPredicted)}${
        req.forecastModel ? `, from the ${req.forecastModel} model` : ""
      }.`,
      "Each type's count below is that total apportioned by the type's historical share, not a separate forecast per type.",
    );
  }

  lines.push("", "BY INCIDENT TYPE");
  for (const t of req.types) {
    const parts = [
      num(t.medianClearanceMin, 0) ? `median clearance ${num(t.medianClearanceMin, 0)} min (measured)` : null,
      int(t.predictedCount) ? `about ${int(t.predictedCount)} expected` : null,
      num(t.sharePct, 0) ? `${num(t.sharePct, 0)}% of incidents historically` : null,
      int(t.expectedLaneMinutes) ? `expected lane-minutes lost ${int(t.expectedLaneMinutes)}` : null,
    ].filter(Boolean);
    lines.push(`- ${t.label}: ${parts.length ? parts.join(", ") : "no figures supplied"}`);
    if (t.dispatch) {
      lines.push(`    standard dispatch package (doctrine, not a model output): ${t.dispatch}`);
    }
  }

  return lines.join("\n");
}

export async function generateIncidentPriorityInsight(
  req: IncidentPriorityInsightRequest,
): Promise<Insight> {
  if (req.types.length === 0) {
    throw new GlmError("No incident types were supplied.", "bad_model_output");
  }
  const content = await chat({
    system: PRIORITY_SYSTEM,
    user: buildPriorityMessage(req),
    json: true,
    maxTokens: 1500,
    temperature: 0.3,
  });
  return validate(extractJson(content), {
    quantity: "incidents",
    metrics: req.types.map((t) => ({ model: t.label })),
    horizonDays: req.horizonDays,
  });
}

/* ── 4. The two per-exit spatial models ───────────────────────────────────────
 *
 * The panel deliberately shows a forecast and a non-forecast side by side, and
 * the whole reason it exists is the contrast between them. So the one thing
 * this prompt must never do is let them blur together.
 *
 *   GWR           explanatory, fit IN-SAMPLE over the 20 exits. It describes
 *                 where risk concentrates and what drives it locally. It does
 *                 NOT predict. Its honest error figure is the LOOCV MAE, not
 *                 the in-sample MAE, and the prompt is told to prefer it.
 *   Spatial LSTM  a genuine next-24h per-exit ranking, temporally held out.
 *
 * Stated as a rule rather than left to inference, because "MAE 0.31" on the
 * GWR line reads exactly like "MAE 0.34" on the LSTM line, and an operator who
 * treats the first as a forecast is being misled by the layout, not the model.
 */

export type CorridorRiskInsightRequest = {
  gwr?: {
    bandwidth?: number | null;
    mae?: number | null;
    loocvMae?: number | null;
    loocvN?: number | null;
    poissonDeviance?: number | null;
    n?: number | null;
    /** Already mapped to the panel's human labels, not raw column names. */
    variables?: string[];
    /** The strongest local coefficients the panel is showing. */
    coefficients?: {
      exitName: string;
      km?: number | null;
      variable: string;
      coefficient: number;
      tValue?: number | null;
      significant?: boolean | null;
    }[];
  } | null;
  spatialLstm?: {
    mae?: number | null;
    poissonDeviance?: number | null;
    n?: number | null;
    epochs?: number | null;
    seqLen?: number | null;
    nNeighbors?: number | null;
    forecastDate?: string | null;
    /** Top-ranked exits for the next 24 hours. */
    topExits?: {
      exitName: string;
      km?: number | null;
      rank: number;
      predictedIncidents: number;
      lastObservedCount?: number | null;
    }[];
  } | null;
  trainedAt?: string | null;
};

const GWR_MODEL_NAME = "Local risk map (GWR)";
const SPATIAL_LSTM_MODEL_NAME = "Per-exit 24h forecast (Spatial LSTM)";

const CORRIDOR_RISK_SYSTEM = `You explain two per-exit incident models to traffic operations staff who are not statisticians. Reply with JSON only.

OUTPUT SHAPE - every <...> below is a PLACEHOLDER. Replace each one with your own
words. Returning the placeholder text itself is a failed answer.
Write out every perModel entry in full. Never abbreviate the array with "...",
"etc" or a comment, and never return fewer entries than there are names listed.
{
  "summary": "<2-4 sentences on where along the corridor incident risk concentrates, and which of these two models is entitled to say what>",
  "perModel": [{"model": "<exact model name, copied from the list below>", "verdict": "<one sentence on what that model is telling you and how far to trust it>"}],
  "caveat": "<the single most important limitation>, or null"
}

THE DISTINCTION THIS PANEL EXISTS TO MAKE - GET IT RIGHT
- "Local risk map (GWR)" is EXPLANATORY, not predictive. It is fitted in-sample across the corridor's exits and describes where risk sits and what is associated with it LOCALLY. It forecasts nothing. Never write that it predicts, expects or forecasts anything.
- "Per-exit 24h forecast (Spatial LSTM)" IS a forecast. It is held out in time and ranks exits by expected incidents over the next 24 hours.
- If you describe both in one sentence, make the difference explicit in that sentence.

READING THE ERROR FIGURES
- For the GWR, an in-sample MAE flatters the model because it was scored on the same exits it was fitted on. If a LOOCV (leave-one-out) MAE is supplied, treat THAT as the honest figure and say so. If the two differ noticeably, that gap is worth reporting.
- Both MAEs are in incidents per exit. A Poisson deviance is a goodness-of-fit number for count data; it is not a percentage and not an accuracy.
- A GWR coefficient is a LOCAL association at one exit, not a cause and not a corridor-wide effect. Only call one meaningful if it is marked significant.

RULES
- Never state a number that was not given to you. Never estimate one.
- Every claim must be traceable to a number above. Do not speculate about road works, enforcement, weather or anything else you were not told.
- Never rank an exit as "dangerous" on a coefficient alone; a coefficient is about association, a count is about exposure.
- Do not recommend retraining, more data, or model changes. The reader operates this system, they do not build it.
- Plain English. No jargon that is not defined in the sentence that uses it.

THE CAVEAT FIELD
Use it ONLY for a limitation the supplied numbers demonstrate: an in-sample fit standing in for a forecast, a wide in-sample-to-LOOCV gap, coefficients that are not significant, a handful of exits carrying the whole pattern, or a model fitted over very few exits. If the numbers show no such problem, return null. Never invent one.`;

function buildCorridorRiskMessage(req: CorridorRiskInsightRequest): string {
  const lines: string[] = [];
  lines.push(
    "SUBJECT: where incident risk sits along the NLEX corridor, exit by exit.",
    "READER: a traffic control centre deciding where to position resources.",
  );
  if (req.trainedAt) lines.push(`Both models were last trained ${req.trainedAt}.`);

  if (req.gwr) {
    const g = req.gwr;
    lines.push("", `MODEL 1 - ${GWR_MODEL_NAME}`);
    lines.push(
      "Geographically weighted regression. EXPLANATORY ONLY, fitted in-sample across the corridor's exits. It forecasts nothing.",
    );
    const fit = [
      int(g.n) ? `fitted over ${int(g.n)} exits` : null,
      num(g.bandwidth, 1) ? `bandwidth ${num(g.bandwidth, 1)}` : null,
      num(g.mae, 3) ? `in-sample MAE ${num(g.mae, 3)} incidents per exit (flattered - same exits it was fitted on)` : null,
      num(g.loocvMae, 3)
        ? `leave-one-out MAE ${num(g.loocvMae, 3)} incidents per exit${int(g.loocvN) ? ` over ${int(g.loocvN)} exits` : ""} - THE HONEST FIGURE`
        : null,
      num(g.poissonDeviance, 2) ? `Poisson deviance ${num(g.poissonDeviance, 2)}` : null,
    ].filter(Boolean);
    if (fit.length) lines.push(fit.join("; ") + ".");
    if (g.variables?.length) lines.push(`Variables it fits locally: ${g.variables.join(", ")}.`);
    if (g.coefficients?.length) {
      lines.push("Strongest local coefficients on screen:");
      for (const c of g.coefficients) {
        const bits = [
          `coefficient ${num(c.coefficient, 3)}`,
          num(c.tValue, 2) ? `t ${num(c.tValue, 2)}` : null,
          c.significant == null ? null : c.significant ? "statistically significant" : "NOT significant",
        ].filter(Boolean);
        lines.push(
          `- ${c.exitName}${c.km != null ? ` (Km ${num(c.km, 1)})` : ""}, ${c.variable}: ${bits.join(", ")}`,
        );
      }
    }
  }

  if (req.spatialLstm) {
    const l = req.spatialLstm;
    lines.push("", `MODEL 2 - ${SPATIAL_LSTM_MODEL_NAME}`);
    lines.push(
      "A genuine forecast, held out in time: it ranks exits by expected incidents over the next 24 hours.",
    );
    const fit = [
      num(l.mae, 3) ? `held-out MAE ${num(l.mae, 3)} incidents per exit` : null,
      num(l.poissonDeviance, 2) ? `Poisson deviance ${num(l.poissonDeviance, 2)}` : null,
      int(l.n) ? `scored on ${int(l.n)} observations` : null,
      int(l.seqLen) ? `${int(l.seqLen)}-step input window` : null,
      int(l.nNeighbors) ? `${int(l.nNeighbors)} neighbouring exits per prediction` : null,
    ].filter(Boolean);
    if (fit.length) lines.push(fit.join("; ") + ".");
    if (l.forecastDate) lines.push(`Forecast date on screen: ${l.forecastDate}.`);
    if (l.topExits?.length) {
      lines.push("Highest-ranked exits for the next 24 hours:");
      for (const e of l.topExits) {
        const bits = [
          `${num(e.predictedIncidents, 2)} incidents expected`,
          e.lastObservedCount != null ? `${int(e.lastObservedCount)} observed in the last comparable period` : null,
        ].filter(Boolean);
        lines.push(`- #${e.rank} ${e.exitName}${e.km != null ? ` (Km ${num(e.km, 1)})` : ""}: ${bits.join(", ")}`);
      }
    }
  }

  return lines.join("\n");
}

export async function generateCorridorRiskInsight(req: CorridorRiskInsightRequest): Promise<Insight> {
  if (!req.gwr && !req.spatialLstm) {
    throw new GlmError("Neither spatial model supplied any figures.", "bad_model_output");
  }
  const names = [
    ...(req.gwr ? [{ model: GWR_MODEL_NAME }] : []),
    ...(req.spatialLstm ? [{ model: SPATIAL_LSTM_MODEL_NAME }] : []),
  ];
  const content = await chat({
    system: CORRIDOR_RISK_SYSTEM,
    user: buildCorridorRiskMessage(req),
    json: true,
    maxTokens: 2000,
    temperature: 0.3,
  });
  // Both spatial models look one day ahead: the LSTM forecasts the next 24
  // hours, and the GWR is not a forecast at all.
  return validate(extractJson(content), { quantity: "incidents", metrics: names, horizonDays: 1 });
}

/* ── 5. Probability of an unusually high-incident day ─────────────────────────
 *
 * One logistic regression, scored on held-out DAYS. The failure mode here is
 * specific and it is the reason this is not folded into section 1: an AUC
 * without its base rate is unreadable. 0.68 sounds like "68% accurate" and is
 * not; against a base rate of 12% it is a genuinely useful model, against 48%
 * it is nearly worthless. The prompt is given both and told never to state one
 * without the other.
 */

export type HighIncidentDayInsightRequest = {
  auc?: number | null;
  baseRate?: number | null;
  n?: number | null;
  rainSignificant?: boolean | null;
  rainPValue?: number | null;
  topDriver?: { feature: string; effectSize: number } | null;
  /** Probability at each rainfall level the panel plots. */
  rainScenarios?: { rainMm: number; probability: number }[];
  /** Probability at each traffic-volume level the panel plots. */
  volumeScenarios?: { volume: number; probability: number }[];
  trainedAt?: string | null;
};

const HIGH_DAY_MODEL_NAME = "High-incident-day risk (logistic regression)";

const HIGH_DAY_SYSTEM = `You explain one incident-risk model to traffic operations staff who are not statisticians. Reply with JSON only.

OUTPUT SHAPE - every <...> below is a PLACEHOLDER. Replace each one with your own
words. Returning the placeholder text itself is a failed answer.
{
  "summary": "<2-4 sentences on what raises the chance of an unusually high-incident day on this corridor, and how much>",
  "perModel": [{"model": "High-incident-day risk (logistic regression)", "verdict": "<one sentence on how much weight to put on this model>"}],
  "caveat": "<the single most important limitation>, or null"
}
Write exactly one perModel entry, using that model name exactly.

WHAT THE MODEL PREDICTS
The probability that the WHOLE CORRIDOR has an unusually high-incident DAY. It is a day-level probability, not a count, not a per-exit figure, and not a prediction that any particular incident will happen.

HOW TO READ THE AUC - THIS IS THE EASIEST THING TO GET WRONG
- AUC is NOT accuracy and NOT a percentage of correct answers. It is the chance the model scores a real high-incident day above a normal one.
- 0.50 is a coin toss. An AUC is only interpretable against the BASE RATE, which is how often high-incident days actually occur.
- NEVER state the AUC without stating the base rate in the same breath. Never convert an AUC into a percentage accuracy.

SCENARIO CURVES
The rainfall and traffic-volume curves are the model's OWN probabilities at each level, holding other inputs at typical values. They show the shape of the relationship. They are not observed frequencies and not a forecast for any specific day.

SIGNIFICANCE
If rainfall is marked NOT statistically significant, say plainly that this data does not establish a rainfall effect, whatever the curve appears to show. Do not describe a non-significant effect as real but small.

RULES
- Never state a number that was not given to you. Never estimate one.
- Every claim must be traceable to a number above. Do not speculate about causes, enforcement or road conditions you were not told about.
- Do not recommend retraining, more data, or model changes. The reader operates this system, they do not build it.
- Plain English. No jargon that is not defined in the sentence that uses it.

THE CAVEAT FIELD
Use it ONLY for a limitation the supplied numbers demonstrate: an AUC close to 0.5, a base rate so low or so high that the probabilities are hard to act on, a non-significant driver, or few days scored. If the numbers show no such problem, return null. Never invent one.`;

function buildHighIncidentDayMessage(req: HighIncidentDayInsightRequest): string {
  const lines: string[] = [];
  lines.push(
    "SUBJECT: the chance that the NLEX corridor has an unusually high-incident day.",
    "READER: a traffic control centre planning a shift.",
    `MODEL: ${HIGH_DAY_MODEL_NAME}, scored on held-out days.`,
  );
  if (req.trainedAt) lines.push(`Last trained ${req.trainedAt}.`);

  const fit = [
    num(req.auc, 3) ? `AUC ${num(req.auc, 3)}` : null,
    pct(req.baseRate) ? `base rate ${pct(req.baseRate)} - how often high-incident days actually occur` : null,
    int(req.n) ? `scored on ${int(req.n)} held-out days` : null,
  ].filter(Boolean);
  if (fit.length) lines.push("", `FIT: ${fit.join("; ")}.`);

  if (req.topDriver) {
    lines.push(
      `STRONGEST DRIVER: ${req.topDriver.feature}, effect size ${num(req.topDriver.effectSize, 3)}.`,
    );
  }
  if (req.rainSignificant != null) {
    lines.push(
      `RAINFALL: ${req.rainSignificant ? "statistically significant" : "NOT statistically significant"}${
        num(req.rainPValue, 3) ? ` (p = ${num(req.rainPValue, 3)})` : ""
      }.`,
    );
  }

  if (req.rainScenarios?.length) {
    lines.push("", "MODEL PROBABILITY BY RAINFALL (the model's own curve, not observed frequencies):");
    for (const s of req.rainScenarios) {
      lines.push(`- ${num(s.rainMm, 1)} mm of rain: ${pct(s.probability)} chance of a high-incident day`);
    }
  }
  if (req.volumeScenarios?.length) {
    lines.push("", "MODEL PROBABILITY BY TRAFFIC VOLUME (the model's own curve, not observed frequencies):");
    for (const s of req.volumeScenarios) {
      lines.push(`- ${int(s.volume)} vehicles: ${pct(s.probability)} chance of a high-incident day`);
    }
  }

  return lines.join("\n");
}

export async function generateHighIncidentDayInsight(
  req: HighIncidentDayInsightRequest,
): Promise<Insight> {
  if (req.auc == null && req.baseRate == null && !req.rainScenarios?.length) {
    throw new GlmError("The high-incident-day model supplied no figures.", "bad_model_output");
  }
  const content = await chat({
    system: HIGH_DAY_SYSTEM,
    user: buildHighIncidentDayMessage(req),
    json: true,
    maxTokens: 1200,
    temperature: 0.3,
  });
  return validate(extractJson(content), {
    quantity: "incidents",
    metrics: [{ model: HIGH_DAY_MODEL_NAME }],
    horizonDays: 1,
  });
}
