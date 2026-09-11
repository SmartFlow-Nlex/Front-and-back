"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The Narrative Explanation panel's body: a language model's read of the
 * metric table the reader is looking at. Served by
 * POST /api/ai-insight/model-narrative, which is told nothing but that table.
 *
 * Two things this must get right, both learned the hard way:
 *
 *   1. The request is keyed on WHAT is being described (quantity, weather
 *      variant, model roster), not on the props' identity. The metric array is
 *      rebuilt by the parent on every render, and an effect that depended on
 *      it re-ran its cleanup each time -- marking the in-flight request
 *      cancelled, so the answer that arrived 50 s later was thrown away and the
 *      panel said "Preparing" forever. The latest props live in a ref; only an
 *      unmount or a change of subject abandons a request.
 *
 *   2. Failure is visible. There is no template prose behind this any more, so
 *      a silent blank would leave the panel empty with no way to retry.
 */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

/* The free GLM tier queues under load and the backend allows it 90 s; give it
   the same before calling the attempt lost. */
const TIMEOUT_MS = 100_000;

export type InsightMetric = {
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

type Insight = {
  summary: string;
  perModel: { model: string; verdict: string }[];
  caveat: string | null;
};

type Props = {
  quantity: "volume" | "incidents" | "emissions";
  metrics: InsightMetric[];
  horizonDays: number;
  scoredDays?: number | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  weatherMode?: "with" | "without" | null;
  labelFor?: (modelName: string) => string;
};

export default function AiModelInsight(props: Props) {
  const { quantity, metrics, weatherMode, labelFor } = props;
  const [insight, setInsight] = useState<Insight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Always the latest props, read at request time -- so the effect below can
  // depend on the subject key alone without going stale.
  const latest = useRef(props);
  latest.current = props;

  const key = JSON.stringify([quantity, weatherMode, metrics.map((m) => m.model)]);
  const attempt = useRef(0);

  const run = useCallback(() => {
    const p = latest.current;
    if (!p.metrics.length) return;
    const mine = ++attempt.current;
    setBusy(true);
    setError(null);
    setElapsed(0);
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    fetch(`${BACKEND}/api/ai-insight/model-narrative`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        quantity: p.quantity,
        metrics: p.metrics,
        horizonDays: p.horizonDays,
        scoredDays: p.scoredDays ?? null,
        windowStart: p.windowStart ?? null,
        windowEnd: p.windowEnd ?? null,
        weatherMode: p.weatherMode ?? null,
      }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (mine !== attempt.current) return;
        if (j?.success) setInsight(j.data as Insight);
        else setError(typeof j?.message === "string" ? j.message : `The explanation service answered ${r.status}.`);
      })
      .catch((e: unknown) => {
        if (mine !== attempt.current) return;
        setError(
          e instanceof DOMException && e.name === "AbortError"
            ? "The model took too long to answer. The free tier queues under load -- try again."
            : "Could not reach the explanation service.",
        );
      })
      .finally(() => {
        clearTimeout(timer);
        clearInterval(tick);
        if (mine === attempt.current) setBusy(false);
      });
  }, []);

  // One request per subject. A new subject (different models, weather toggle)
  // starts over; a plain re-render does not touch the one in flight.
  useEffect(() => {
    setInsight(null);
    run();
    return () => { attempt.current++; };
  }, [key, run]);

  if (busy && !insight) {
    return (
      <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--text-muted)", fontStyle: "italic" }}>
        Asking the model to read the metrics{elapsed >= 8 ? ` (${elapsed}s -- the free tier can take up to a minute)` : "…"}
      </p>
    );
  }

  if (error && !insight) {
    return (
      <p style={{ margin: 0, fontSize: "0.82rem", lineHeight: 1.55, color: "#b54708", background: "#fffaeb", borderLeft: "3px solid #f79009", borderRadius: 8, padding: "9px 11px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ flex: "1 1 240px" }}>{error}</span>
        <button
          onClick={run}
          style={{ padding: "5px 13px", borderRadius: 999, cursor: "pointer", fontSize: "0.74rem", fontWeight: 600, border: "1px solid #f79009", background: "transparent", color: "#b54708" }}
        >
          Try again
        </button>
      </p>
    );
  }

  if (!insight) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <p style={{ margin: 0, fontSize: "0.86rem", lineHeight: 1.65, color: "var(--text-primary)" }}>
        {insight.summary}
      </p>

      {insight.perModel.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5 }}>
          {insight.perModel.map((m) => (
            <li key={m.model} style={{ fontSize: "0.82rem", lineHeight: 1.55, color: "var(--text-secondary)" }}>
              <b style={{ color: "var(--text-primary)" }}>{labelFor ? labelFor(m.model) : m.model}</b>
              {" — "}
              {m.verdict}
            </li>
          ))}
        </ul>
      )}

      {insight.caveat && (
        <p style={{ margin: 0, fontSize: "0.8rem", lineHeight: 1.55, color: "#b54708", background: "#fffaeb", borderLeft: "3px solid #f79009", borderRadius: 8, padding: "9px 11px" }}>
          {insight.caveat}
        </p>
      )}

      <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--text-muted)" }}>
        Written by the language model from the validation metrics shown on this card. Check any figure against the table before acting on it.
      </p>
    </div>
  );
}
