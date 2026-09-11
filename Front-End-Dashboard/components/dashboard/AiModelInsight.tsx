"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The interpretive opening of the Narrative Explanation panel: what the metrics
 * below it mean for someone planning around the forecast.
 *
 * It is deliberately NOT a separate section. The panel reads as one piece —
 * this paragraph, then the per-model breakdown, then the out-of-sample note —
 * because splitting it invited the reader to treat the two halves as making
 * different kinds of claim.
 *
 * Generation starts as soon as the panel opens rather than behind a button, so
 * there is nothing extra to click. The metrics render immediately either way;
 * this fills in underneath when it arrives, and simply does not appear if the
 * request fails, leaving the deterministic narrative intact and complete.
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
  const [failed, setFailed] = useState(false);

  // Which selection produced the text on screen. Re-running on every render
  // would spend a request per keystroke of the model toolbar; keying on the
  // selection means it regenerates when, and only when, the reader changes what
  // the panel is describing.
  const key = JSON.stringify([quantity, weatherMode, metrics.map((m) => m.model)]);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!metrics.length || lastKey.current === key) return;
    lastKey.current = key;

    let cancelled = false;
    setBusy(true);
    setFailed(false);

    fetch(`${BACKEND}/api/ai-insight/model-narrative`, {
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
    })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success) setInsight(j.data as Insight);
        else setFailed(true);
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setBusy(false));

    return () => {
      cancelled = true;
    };
  }, [key, quantity, metrics, horizonDays, scoredDays, windowStart, windowEnd, weatherMode]);

  // A failure leaves no trace: the metrics narrative above is complete on its
  // own, so an error box here would report a problem the reader cannot act on
  // and does not need to know about.
  if (failed && !insight) return null;

  if (busy && !insight) {
    return (
      <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-muted)", fontStyle: "italic" }}>
        Preparing the read-out…
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
            <li
              key={m.model}
              style={{ fontSize: "0.82rem", lineHeight: 1.55, color: "var(--text-secondary)" }}
            >
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
            fontSize: "0.8rem",
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
    </div>
  );
}
