import { env } from "../config/env.js";

/* ══════════════════════════════════════════════════════════════════════════════
   GLM CLIENT

   One place that knows how to talk to Z.ai, so the sandbox command parser and
   the narrative generator cannot drift apart on timeouts, error mapping or the
   thinking-mode workaround.

   The endpoint is OpenAI-compatible, which is why this is plain fetch and not
   an SDK: pointing GLM_BASE_URL at any other OpenAI-shaped server (Ollama's
   /v1, OpenRouter, a self-hosted vLLM) is then a config change rather than a
   rewrite.
══════════════════════════════════════════════════════════════════════════════ */

export type GlmErrorCode =
  | "not_configured"
  | "insufficient_balance"
  | "rate_limited"
  | "upstream_error"
  | "bad_model_output";

export class GlmError extends Error {
  constructor(message: string, readonly code: GlmErrorCode) {
    super(message);
    this.name = "GlmError";
  }
}

export function isGlmConfigured(): boolean {
  return Boolean(env.GLM_API_KEY && env.GLM_API_KEY.trim().length > 0);
}

/**
 * Whether we are routed through OpenRouter rather than talking to Z.ai
 * directly. Derived from the base URL rather than a second env var, so there is
 * only one thing to change when switching and no way to set the two
 * inconsistently.
 */
function isOpenRouter(): boolean {
  try {
    const host = new URL(env.GLM_BASE_URL).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/** What the caller is talking to, and whether retention is being enforced. */
export function providerInfo(): {
  provider: "openrouter" | "z.ai";
  model: string;
  zdrEnforced: boolean;
} {
  const via = isOpenRouter();
  return {
    provider: via ? "openrouter" : "z.ai",
    model: env.GLM_MODEL,
    // Z.ai publishes no ZDR tier, so the flag is only honest when it can
    // actually be enforced at the routing layer.
    zdrEnforced: via && env.GLM_ZDR === "on",
  };
}

export type ChatOptions = {
  system: string;
  user: string;
  /** Ask the model to emit a JSON object. Off for prose. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
};

/**
 * One completion. Returns the assistant's message content, or throws GlmError
 * with a code the caller can turn into an HTTP status.
 */
/* NO REASONING HEADROOM. Deliberate, and measured.
 *
 * Adding 1,600 tokens of headroom to every caller looked free — billing is on
 * tokens actually spent — and it was not. GLM-5.x expands its reasoning to
 * fill whatever allowance it is given: the same narrative call went from
 * 14-30 s to 79-147 s, past the client's 100 s abort, so the fix for
 * "did not return JSON" started producing "took too long" instead.
 *
 * The budget is therefore left exactly as the caller sized it, and truncation
 * is handled by the one retry below rather than by pre-emptive headroom. A
 * retry costs a second call only on the minority that need it, where headroom
 * taxed every call. */

export async function chat(opts: ChatOptions): Promise<string> {
  if (!isGlmConfigured()) {
    throw new GlmError("GLM_API_KEY is not set — add it to Back-End/.env.", "not_configured");
  }

  const body: Record<string, unknown> = {
    model: env.GLM_MODEL,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 1200,
  };

  if (opts.json) body.response_format = { type: "json_object" };

  const viaOpenRouter = isOpenRouter();

  if (viaOpenRouter) {
    // Retention is enforced here, in the request, rather than left to a setting
    // in someone's OpenRouter account — a reviewer can see the guarantee in the
    // code, and it cannot be silently switched off by whoever owns the console.
    //
    // OpenRouter treats these as an OR against account and guardrail settings:
    // asking for ZDR here can only tighten routing, never loosen it.
    if (env.GLM_ZDR === "on") {
      body.provider = {
        zdr: true,
        // Distinct from zdr: this refuses providers that store or train on
        // inputs even where they would otherwise qualify.
        data_collection: "deny",
        // A fallback that is not itself ZDR would defeat the point, but
        // OpenRouter only ever falls back within the filtered set, so leaving
        // fallbacks on buys availability without weakening the guarantee.
        allow_fallbacks: true,
      };
    }

    /* Only route to providers that actually implement what we asked for.
     *
     * This is the fix for the narrative panels failing perhaps a third of the
     * time, and the failure was never really about token budgets. Some
     * providers in the pool silently IGNORE response_format: json_object. On
     * those, GLM-5.x writes its chain of thought into `content` as plain prose
     * — "Let me work through this carefully. Quantity: daily road incident
     * counts..." — reports reasoning_tokens as 0 because none of it went
     * through a reasoning field, exhausts max_tokens before reaching the JSON,
     * and the caller gets truncated prose. That surfaced as "did not return
     * JSON", and every attempt to fix it by widening the budget just bought
     * more prose: at 3,000 tokens it produced 11,708 characters and still had
     * not started the JSON.
     *
     * require_parameters drops those providers from the routing. Measured on
     * the 7-model roster that was failing: 4/4 clean at 14-22 s, against
     * 19-147 s and frequent truncation without it.
     *
     * It narrows the pool, so it trades some availability for correctness.
     * That is the right trade here: a provider that ignores json_object cannot
     * serve this feature at all. */
    body.provider = { ...(body.provider as object), require_parameters: true };


  } else {
    // Z.ai-specific. The 4.x Flash models reason before answering, spending
    // hundreds of tokens deliberating over a fixed task, so it is switched off.
    // OpenRouter rejects unknown top-level fields, so this is not sent there.
    //
    // GLM-5.x refuses the parameter outright — "This model always engages in
    // thinking and cannot be disabled" (code 1210) — so sending it to a 5.x
    // model fails every request. Rather than maintain a model allowlist that
    // goes stale on the next release, the call below retries once without it.
    if (env.GLM_THINKING === "disabled") body.thinking = { type: "disabled" };
  }

  /** Set once the budget has been widened, so a stubborn provider cannot put
   *  this into an endless retry loop. */
  let widenedForLength = false;
  /** Set once a re-ask has been spent on unparseable JSON. */
  let retriedForJson = false;

  /**
   * One attempt. Separated so the 1210 path can drop `thinking` and re-send
   * without rebuilding the request or re-running provider detection.
   */
  async function send(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.GLM_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${env.GLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GLM_API_KEY}`,
          "Content-Type": "application/json",
          // Attribution on the OpenRouter dashboard. Harmless elsewhere, but only
          // sent where it means something.
          ...(viaOpenRouter
            ? {
                "HTTP-Referer": env.GLM_SITE_URL,
                "X-OpenRouter-Title": env.GLM_SITE_NAME,
              }
            : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new GlmError(
        aborted
          ? "The model took too long to respond. The free tier queues under load — try again."
          : "Could not reach the GLM API.",
        "upstream_error",
      );
    } finally {
      clearTimeout(timer);
    }

    const payload = (await res.json().catch(() => null)) as any;

    if (!res.ok || payload?.error) {
      const code = String(payload?.error?.code ?? "");
      const message = String(payload?.error?.message ?? `HTTP ${res.status}`);

      if (viaOpenRouter) {
        // OpenRouter signals through HTTP status rather than a vendor code.
        if (res.status === 402) {
          throw new GlmError(
            "The OpenRouter account is out of credit. Top up at openrouter.ai/credits.",
            "insufficient_balance",
          );
        }
        if (res.status === 429) {
          throw new GlmError("OpenRouter is rate-limiting this key. Try again shortly.", "rate_limited");
        }
        // With ZDR on, a model whose providers all retain prompts has nowhere
        // left to route. That reads as a generic 404 unless it is named, and it
        // is a configuration decision rather than a fault — so say which of the
        // two knobs to turn.
        if (res.status === 404 && env.GLM_ZDR === "on") {
          throw new GlmError(
            `No zero-retention provider is available for "${env.GLM_MODEL}". ` +
              "Choose a model with a ZDR endpoint, or set GLM_ZDR=off to allow retaining providers.",
            "upstream_error",
          );
        }
        throw new GlmError(`OpenRouter error: ${message}`, "upstream_error");
      }

      // 1210: this model cannot have reasoning switched off. Drop the parameter
      // and try once more, so moving GLM_MODEL to a 5.x model does not break
      // every call and does not require anyone to know to flip GLM_THINKING.
    if (code === "1210" && body.thinking !== undefined) {
      delete body.thinking;
      return send();
    }

    // Z.ai's own codes. 1113 (no credit) and 1305 (overloaded) are the two an
    // operator can act on, so they get their own messages.
    if (code === "1113") {
      throw new GlmError(
        "The GLM account has no remaining balance. Switch GLM_MODEL to a free model (glm-4.5-flash) or top up at z.ai.",
        "insufficient_balance",
      );
    }
    if (code === "1305") {
      throw new GlmError(
        "The model is temporarily overloaded. Try again in a moment.",
        "rate_limited",
      );
    }
    throw new GlmError(`GLM API error: ${message}`, "upstream_error");
  }

  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;

  /* Out of budget, whichever way it shows.
   *
   * finish_reason "length" means reasoning spent the allowance before the
   * answer was finished. That surfaces two different ways and they have the
   * same cause: nothing at all ("Model returned an empty response"), or a JSON
   * object cut off mid-string, which extractJson reports as "Model did not
   * return JSON" because there is no closing brace to find. The retry used to
   * cover only the first, so the truncated half still reached the operator as
   * a hard error — which is what it did, on the Predictive tab.
   *
   * Retrying on the finish_reason rather than on the shape of the damage
   * catches both. */
  if (choice?.finish_reason === "length" && !widenedForLength) {
    widenedForLength = true;
    const had = typeof body.max_tokens === "number" ? body.max_tokens : 1200;
    body.max_tokens = Math.min(had * 3, 8000);
    return send();
  }

  /* Asked for JSON and given something that will not parse.
   *
   * Distinct from the truncation above: the braces are there and the budget
   * was not exhausted, the model simply emitted broken JSON — an unescaped
   * quote inside a verdict is the usual culprit. finish_reason is "stop", so
   * widening the budget is not the answer and the retry above rightly does not
   * fire. One clean re-ask is, and it is bounded to a single attempt so a model
   * having a genuinely bad day still surfaces as an error rather than looping.
   *
   * Checked here rather than left to extractJson in the service because this is
   * the only place that can re-send the request. */
  if (opts.json && typeof content === "string" && content.trim() && !retriedForJson) {
    const looksParseable = (() => {
      const t = content.trim();
      const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
      const c = fenced ? fenced[1] : t;
      const a = c.indexOf("{");
      const b = c.lastIndexOf("}");
      if (a === -1 || b <= a) return false;
      try { JSON.parse(c.slice(a, b + 1)); return true; } catch { return false; }
    })();
    if (!looksParseable) {
      retriedForJson = true;
      return send();
    }
  }

  if (typeof content !== "string" || content.trim().length === 0) {
    /* Empty because reasoning spent the whole budget.
     *
     * GLM-5.x always reasons, and OpenRouter bills those tokens against
     * max_tokens. Some providers in the fallback set keep reasoning to a
     * handful of tokens; others run it to the cap and leave nothing for the
     * answer. Measured on one prompt, same account, minutes apart: the same
     * request returned finish=stop with 1 reasoning token and a full answer,
     * and finish=length with 1,400 of 1,400 spent reasoning and empty content.
     * Roughly one call in three failed, which surfaced to the operator as
     * "Model returned an empty response" on a button that had just worked.
     *
     * finish_reason "length" with no content is exactly that case and nothing
     * else, so it is the one condition worth retrying. The retry buys headroom
     * rather than changing the request, and OpenRouter may also route it to a
     * different provider, which is the other half of the cure.
     *
     * Capping reasoning with OpenRouter's own `reasoning: {effort}` was tried
     * first and made it WORSE: the provider that already over-reasoned ignored
     * the field and then hit the cap every time. Left out deliberately. */
    throw new GlmError(
      choice?.finish_reason === "length"
        ? "The model spent its entire token budget reasoning and returned no answer. Try again."
        : "Model returned an empty response.",
      "bad_model_output",
    );
  }
  return content;
  }

  return send();
}

/** Pull a JSON object out of a reply, tolerating code fences or stray prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first === -1 || last <= first) {
      throw new GlmError("Model did not return JSON.", "bad_model_output");
    }
    try {
      return JSON.parse(candidate.slice(first, last + 1));
    } catch {
      throw new GlmError("Model returned malformed JSON.", "bad_model_output");
    }
  }
}
