"use client";

import { useState } from "react";

/**
 * LLM read-out of a forecast model roster, rendered inside the existing
 * Narrative Explanation panels.
 *
 * This is deliberately ADDITIVE. The prose above it in ModelNarrative and
 * IncidentNarrative is composed from the metrics deterministically and never
 * states anything the numbers do not support; that property is what makes it
 * trustworthy, and it is not one a language model can offer. So the template
 * stays as the record, and this adds the judgement it cannot reach — whether a
 * ranking is meaningful, and what the accuracy means for someone planning
 * around the forecast.
 *
 * Nothing is sent but the metric rows already on screen, and generation is
 * behind a button: on the free GLM tier a call takes 10-40s, which is not
 * something to spend on every render.
 */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

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

export default function AiModelInsight({
  quantity,
  metrics,
  horizonDays,
  scoredDays,
  windowStart,
  windowEnd,
  weatherMode,
  /** Maps a stored model_name back to the label the chart shows. */
  labelFor,
}: {
  quantity: "volume" | "incidents" | "emissions";
  metrics: InsightMetric[];
  horizonDays: number;
  scoredDays?: number | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  weatherMode?: "with" | "without" | null;
  labelFor?: (modelName: string) => string;
}) {
  const [insight, setInsight] = useState<Insight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!metrics || metrics.length === 0) return null;

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${BACKEND}/api/ai-insight/model-narrative`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantity,
          metrics,
          horizonDays,
          scoredDays: scoredDays ?? null,
          windowStart: windowStart ?? null,
          windowEnd: windowEnd ?? null,
          weatherMode: weatherMode ?? null,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json?.message ?? `Request failed (${res.status}).`);
        return;
      }
      setInsight(json.data as Insight);
    } catch {
      setError("Could not reach the backend. Is it running on port 4000?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      style={{
        borderTop: "1px solid #eef2f7",
        paddingTop: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h5 style={{ margin: 0, fontSize: "0.86rem", fontWeight: 700, color: "var(--text-primary)" }}>
            AI Summary
          </h5>
          <p style={{ margin: "2px 0 0", fontSize: "0.75rem", color: "var(--text-secondary)" }}>
            What these numbers mean in practice, written from the same metrics
          </p>
        </div>
        <button
          onClick={generate}
          disabled={busy}
          style={{
            padding: "6px 14px",
            borderRadius: 999,
            cursor: busy ? "default" : "pointer",
            fontSize: "0.75rem",
            fontWeight: 600,
            border: "1px solid transparent",
            background: busy ? "var(--bg-surface-hover)" : "linear-gradient(135deg, #7c3aed, #4f46e5)",
            color: busy ? "var(--text-secondary)" : "#fff",
            opacity: busy ? 0.8 : 1,
          }}
        >
          {busy ? "Writing…" : insight ? "Regenerate" : "Generate AI summary"}
        </button>
      </div>

      {busy && (
        <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--text-muted)" }}>
          This can take up to a minute on the free model tier.
        </p>
      )}

      {error && (
        <p
          style={{
            margin: 0,
            fontSize: "0.78rem",
            lineHeight: 1.5,
            color: "#b42318",
            background: "#fef3f2",
            borderLeft: "3px solid #b42318",
            borderRadius: 8,
            padding: "9px 11px",
          }}
        >
          {error}
        </p>
      )}

      {insight && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ margin: 0, fontSize: "0.84rem", lineHeight: 1.6, color: "var(--text-primary)" }}>
            {insight.summary}
          </p>

          {insight.perModel.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5 }}>
              {insight.perModel.map((m) => (
                <li key={m.model} style={{ fontSize: "0.8rem", lineHeight: 1.55, color: "var(--text-secondary)" }}>
                  <b style={{ color: "var(--text-primary)" }}>{labelFor ? labelFor(m.model) : m.model}</b>
                  {" — "}
                  {m.verdict}
                </li>
              ))}
            </ul>
          )}

          {insight.caveat && (
            <p
              style={{
                margin: 0,
                fontSize: "0.78rem",
                lineHeight: 1.55,
                color: "#b54708",
                background: "#fffaeb",
                borderLeft: "3px solid #f79009",
                borderRadius: 8,
                padding: "9px 11px",
              }}
            >
              {insight.caveat}
            </p>
          )}

          {/* The reader has to be able to tell which half of this panel is
              generated prose and which is composed from the metrics. */}
          <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
            Written by a language model from the metrics above. The narrative before it is composed
            directly from those same numbers — where the two disagree, trust that one.
          </p>
        </div>
      )}
    </section>
  );
}
