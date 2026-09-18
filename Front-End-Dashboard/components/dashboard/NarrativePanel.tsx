"use client";

import { useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import AiModelInsight, { type InsightMetric } from "./AiModelInsight";

/**
 * The shell every Narrative Explanation on the Predictive tab wears: indigo
 * wash, sparkle tile, a collapsed row that still carries the verdict as chips,
 * and one button that spends the model call.
 *
 * Collapsed by default everywhere. Generating costs a request to the language
 * model, so it is a deliberate action rather than something every page load
 * spends on a reader who may not scroll this far.
 *
 * The module-specific parts — which endpoint, what payload, what the chips say
 * — are props, because the three cards are scored in genuinely different ways:
 * error for the volume forecast, classification accuracy for the congestion
 * map, uplift error against doing nothing for the event surge. Sharing the
 * shell keeps them looking like one system; sharing a prompt would have made
 * one of them lie.
 */
export default function NarrativePanel({
  chips,
  contextLine,
  metrics,
  endpoint,
  subjectKey,
  buildBody,
  horizonDays = 1,
  labelFor,
}: {
  /** Kept for callers; the collapsed state is now a button with no room for it. */
  subtitle?: string;
  /** The headline verdict, visible before anyone opens the panel. */
  chips?: ReactNode;
  /** One muted line above the read-out saying what it was read from. */
  contextLine?: ReactNode;
  metrics: InsightMetric[];
  endpoint: string;
  subjectKey: string;
  buildBody: () => unknown;
  horizonDays?: number;
  labelFor?: (modelName: string) => string;
}) {
  const [open, setOpen] = useState(false);

  // Nothing but the button until it is pressed.
  if (!open) return <GenerateReportButton onClick={() => setOpen(true)} />;

  return (
    <section
      style={{
        border: "1px solid color-mix(in srgb, var(--page-accent, #4f46e5) 28%, transparent)",
        borderRadius: 12,
        background:
          "linear-gradient(135deg, color-mix(in srgb, var(--page-accent, #4f46e5) 11%, var(--bg-surface)), color-mix(in srgb, var(--page-accent, #4f46e5) 4%, var(--bg-surface)))",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.5)",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 190, display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 9, flex: "none",
              background: "linear-gradient(135deg, color-mix(in srgb, var(--page-accent, #4f46e5) 82%, white), var(--page-accent, #4f46e5))", color: "#fff",
              boxShadow: "0 1px 6px color-mix(in srgb, var(--page-accent, #4f46e5) 35%, transparent)",
            }}
          >
            <Sparkles size={15} strokeWidth={2.4} />
          </span>
          <div>
            <h4 style={{ margin: 0, fontSize: "0.98rem", fontWeight: 800, letterSpacing: "-0.01em", color: "var(--text-primary)" }}>
              Narrative Explanation
            </h4>
          </div>
        </div>

        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px",
            marginLeft: "auto", flexShrink: 0,
            borderRadius: 999, cursor: "pointer", fontSize: "0.76rem", fontWeight: 600,
            border: "1px solid var(--border-strong)",
            background: "var(--bg-surface)",
            color: "var(--text-secondary)",
          }}
        >
          Hide report
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {chips && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{chips}</div>}
        {contextLine && (
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>{contextLine}</p>
        )}
        <AiModelInsight
          quantity="volume"
          metrics={metrics}
          horizonDays={horizonDays}
          endpoint={endpoint}
          subjectKey={subjectKey}
          buildBody={buildBody}
          labelFor={labelFor}
        />
      </div>
    </section>
  );
}

/** Small pill for the collapsed row, so the cards' chips match each other. */
export function NarrativeChip({ tone = "neutral", children }: { tone?: "good" | "neutral"; children: ReactNode }) {
  const good = tone === "good";
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 7,
        padding: "5px 11px", borderRadius: 8, fontSize: "0.735rem",
        background: good ? "var(--color-success-bg)" : "var(--bg-surface-hover)",
        border: `1px solid ${good ? "var(--color-success-border)" : "var(--border-default)"}`,
        color: good ? "var(--color-success)" : "var(--text-secondary)",
      }}
    >
      {children}
    </span>
  );
}

/**
 * The one control a collapsed Narrative Explanation shows.
 *
 * Generating spends a language-model request, so it stays a deliberate press
 * rather than something every page load pays for on a reader who may never
 * scroll this far. Shared by all three cards so the offer looks identical
 * wherever it appears.
 */
export function GenerateReportButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "8px 16px",
        borderRadius: 999,
        cursor: "pointer",
        fontSize: "0.78rem",
        fontWeight: 600,
        border: "1px solid transparent",
        background:
          "linear-gradient(135deg, color-mix(in srgb, var(--page-accent, #4f46e5) 82%, white), var(--page-accent, #4f46e5))",
        color: "#fff",
        boxShadow: "0 1px 6px color-mix(in srgb, var(--page-accent, #4f46e5) 35%, transparent)",
      }}
    >
      <Sparkles size={14} strokeWidth={2.4} />
      Generate report
    </button>
  );
}
