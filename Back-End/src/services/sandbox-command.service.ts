import { chat, extractJson, GlmError, isGlmConfigured } from "../lib/glm.client.js";

/* ══════════════════════════════════════════════════════════════════════════════
   AI SANDBOX — NATURAL-LANGUAGE COMMAND PARSER

   Turns an operator sentence ("close two lanes at Bocaue northbound") into the
   intervention actions the browser-side simulation already understands.

   The model does one job: extraction. It never decides traffic policy, never
   sees live corridor data, and never applies anything — it returns a proposed
   action list which the dashboard shows for confirmation before touching the
   simulation.

   Everything the model returns is treated as untrusted. parsePlan() below
   re-validates and clamps every field against the real bounds (lane indices
   against laneCount, positions against the segment length, exits against the
   corridor list) so a hallucinated lane 9 becomes a rejected action rather than
   an out-of-range write into sim.interventions.
══════════════════════════════════════════════════════════════════════════════ */

/** One exit as the parser needs to see it — id and name are enough to match on. */
export type ExitRef = { exit_id: number; exit_name: string };

/** The simulation's current shape, so the model can resolve "the far lane". */
export type SandboxContext = {
  laneCount: number;
  segmentLengthM: number;
  exits: ExitRef[];
  /** Lanes currently closed, 1-indexed for the model's benefit. */
  closedLanes: number[];
  speedLimitKmh: number | null;
  incidentCount: number;
};

export type Action =
  | { type: "close_lane"; lanes: number[] }
  | { type: "open_lane"; lanes: number[] }
  | { type: "set_speed_limit"; kmh: number | null }
  | { type: "add_incident"; lane: number; positionPct: number }
  | { type: "clear_incidents" }
  | { type: "set_inflow"; vehPerHour: number }
  | { type: "set_lane_count"; lanes: number }
  | { type: "set_route"; originExitId: number; destinationExitId: number };

export type CommandPlan = {
  /** Actions to propose. Empty when the command could not be mapped. */
  actions: Action[];
  /** One short sentence for the operator, in the language they wrote in. */
  reply: string;
  /** Set when part or all of the command could not be expressed as actions. */
  unsupported: string | null;
  /** Fields the validator had to drop or clamp — surfaced for transparency. */
  warnings: string[];
};

/**
 * Kept as an alias so the controller's existing catch reads unchanged. The GLM
 * client owns error classification now — see lib/glm.client.ts.
 */
export { GlmError as CommandParseError, isGlmConfigured };

/* ─────────────────────────────────────────────────────────────────────────────
   PROMPT
   The exit list goes in the system prompt because it is small (20 rows) and
   stable for the life of the process. Sending names lets the model match
   "Bocaue" to the two Bocaue rows and pick by the qualifier the operator used.
───────────────────────────────────────────────────────────────────────────── */

function systemPrompt(ctx: SandboxContext): string {
  const exitLines = ctx.exits
    .map((e) => `  ${e.exit_id}: ${e.exit_name}`)
    .join("\n");

  return `You convert traffic-operator commands into simulation actions for the NLEX corridor AI Sandbox. Reply with JSON only — no prose, no code fences.

CURRENT SIMULATION STATE
  lanes: ${ctx.laneCount} (numbered 1..${ctx.laneCount}, lane 1 is the leftmost/innermost)
  segment length: ${ctx.segmentLengthM} m
  lanes currently closed: ${ctx.closedLanes.length ? ctx.closedLanes.join(", ") : "none"}
  speed limit: ${ctx.speedLimitKmh == null ? "none" : ctx.speedLimitKmh + " km/h"}
  incidents placed: ${ctx.incidentCount}

CORRIDOR EXITS (exit_id: name)
${exitLines}

OUTPUT SHAPE
{
  "actions": [ ...zero or more actions... ],
  "reply": "one short sentence confirming what you understood",
  "unsupported": null or "what you could not map"
}

ACTION TYPES
  {"type":"close_lane","lanes":[2,3]}                  lane numbers, 1-indexed
  {"type":"open_lane","lanes":[2]}                     reopen closed lanes
  {"type":"set_speed_limit","kmh":60}                  or "kmh":null to remove
  {"type":"add_incident","lane":2,"positionPct":55}    positionPct 0-100 along segment
  {"type":"clear_incidents"}
  {"type":"set_inflow","vehPerHour":4500}              500-12000
  {"type":"set_lane_count","lanes":4}                  1-6
  {"type":"set_route","originExitId":8,"destinationExitId":12}

RULES
- Only emit actions the command actually asks for. Never invent an action to be helpful.
- Lane numbers must be between 1 and ${ctx.laneCount}. If the operator names more lanes than exist, emit no close_lane action and explain in "unsupported".
- "two lanes" with no position means the rightmost lanes (highest numbers), which is where a closure normally goes.
- An exit name must match the list above. If it is ambiguous ("Bocaue" matches Barrier and Interchange), pick the interchange and say which you chose in "reply".
- Direction words (northbound/southbound/NB/SB) do not map to any action — the simulation models one direction. Acknowledge the direction in "reply" but do not treat it as unsupported.
- If the command is not about traffic at all, return empty actions and say so in "unsupported".
- Write "reply" in the same language the operator used. Filipino, Taglish and English are all expected.`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   VALIDATION
   The model's output is parsed defensively: unknown action types are dropped,
   numbers are coerced and clamped, and anything out of range is recorded as a
   warning rather than silently corrected.
───────────────────────────────────────────────────────────────────────────── */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function validateActions(raw: unknown, ctx: SandboxContext, warnings: string[]): Action[] {
  if (!Array.isArray(raw)) return [];
  const out: Action[] = [];
  const validExitIds = new Set(ctx.exits.map((e) => e.exit_id));

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;

    switch (a.type) {
      case "close_lane":
      case "open_lane": {
        const lanes = Array.isArray(a.lanes) ? a.lanes : [];
        const kept = lanes
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= ctx.laneCount);
        const dropped = lanes.length - kept.length;
        if (dropped > 0) {
          warnings.push(
            `Ignored ${dropped} lane number outside 1-${ctx.laneCount}.`,
          );
        }
        if (kept.length > 0) out.push({ type: a.type, lanes: [...new Set(kept)] });
        break;
      }

      case "set_speed_limit": {
        if (a.kmh === null) {
          out.push({ type: "set_speed_limit", kmh: null });
          break;
        }
        const kmh = Number(a.kmh);
        if (!Number.isFinite(kmh)) break;
        const c = clamp(Math.round(kmh), 20, 120);
        if (c !== Math.round(kmh)) warnings.push(`Speed limit clamped to ${c} km/h.`);
        out.push({ type: "set_speed_limit", kmh: c });
        break;
      }

      case "add_incident": {
        const lane = Number(a.lane);
        if (!Number.isInteger(lane) || lane < 1 || lane > ctx.laneCount) {
          warnings.push(`Incident lane ${a.lane} is outside 1-${ctx.laneCount}; skipped.`);
          break;
        }
        const pctRaw = Number(a.positionPct);
        const pct = Number.isFinite(pctRaw) ? clamp(pctRaw, 0, 100) : 55;
        out.push({ type: "add_incident", lane, positionPct: pct });
        break;
      }

      case "clear_incidents":
        out.push({ type: "clear_incidents" });
        break;

      case "set_inflow": {
        const v = Number(a.vehPerHour);
        if (!Number.isFinite(v)) break;
        const c = clamp(Math.round(v), 500, 12000);
        if (c !== Math.round(v)) warnings.push(`Inflow clamped to ${c} veh/h.`);
        out.push({ type: "set_inflow", vehPerHour: c });
        break;
      }

      case "set_lane_count": {
        const v = Number(a.lanes);
        if (!Number.isInteger(v)) break;
        const c = clamp(v, 1, 6);
        if (c !== v) warnings.push(`Lane count clamped to ${c}.`);
        out.push({ type: "set_lane_count", lanes: c });
        break;
      }

      case "set_route": {
        const o = Number(a.originExitId);
        const d = Number(a.destinationExitId);
        if (!validExitIds.has(o) || !validExitIds.has(d)) {
          warnings.push("Route referred to an exit that is not on the corridor; skipped.");
          break;
        }
        if (o === d) {
          warnings.push("Origin and destination were the same; route skipped.");
          break;
        }
        out.push({ type: "set_route", originExitId: o, destinationExitId: d });
        break;
      }

      default:
        break; // unknown action type — drop silently, the reply still stands
    }
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────
   THE CALL
───────────────────────────────────────────────────────────────────────────── */

export async function parseCommand(
  command: string,
  ctx: SandboxContext,
): Promise<CommandPlan> {
  const content = await chat({
    system: systemPrompt(ctx),
    user: command,
    json: true,
    maxTokens: 1200,
    // Extraction, not creativity: the same sentence must map to the same
    // actions every time.
    temperature: 0,
  });

  const parsed = extractJson(content) as Record<string, unknown>;
  const warnings: string[] = [];
  const actions = validateActions(parsed.actions, ctx, warnings);

  const reply =
    typeof parsed.reply === "string" && parsed.reply.trim().length > 0
      ? parsed.reply.trim()
      : "Command understood.";

  const unsupported =
    typeof parsed.unsupported === "string" && parsed.unsupported.trim().length > 0
      ? parsed.unsupported.trim()
      : null;

  return { actions, reply, unsupported, warnings };
}
