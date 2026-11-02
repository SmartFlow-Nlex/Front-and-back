"use client";

// Shared chrome for the Incident tab's Prescriptive cards — Shell/Banner/Foot/
// Empty, mirroring the Traffic tab's Booth Staffing Plan shell
// (PrescriptiveTrafficPanels.tsx). Extracted here once a second Prescriptive
// card needed the same pieces, rather than duplicated a second time.
//
// Night Corridor: Prescriptive reads as action cards. ActionCard states the
// action, then where / when / expected effect / confidence as labelled facts,
// with the basis and full reasoning behind "Details" on the same card.

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import InfoTooltip from "./InfoTooltip";
import StateNote from "../stage/StateNote";

export const CARD: React.CSSProperties = { padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 };

export function Shell({
  title,
  hint,
  children,
  right,
  updating,
}: {
  title: string;
  hint: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  /** A fetch is in flight while already-loaded data is still on screen -- flags it so stale data is never mistaken for current. */
  updating?: boolean;
}) {
  return (
    <article className="chart-card wide inc-card nct-card">
      {/* The same frame as the Traffic tab's prescriptive panels (16 Oct 2026). */}
      <div className="nct-card-head-split">
        <div className="nct-head-text">
          <h3 className="nct-title">
            {title}<InfoTooltip text={hint} />
            {updating && (
              <span className="inc-updating-badge" role="status" aria-live="polite">
                Updating…
              </span>
            )}
          </h3>
        </div>
        {right}
      </div>
      {children}
    </article>
  );
}

export const Banner = ({ children }: { children: React.ReactNode }) => <div className="nct-banner">{children}</div>;

export const Foot = ({ children }: { children: React.ReactNode }) => <p className="nct-foot">{children}</p>;

/** Loading (no `kind`) or an unavailable state (`kind`), which keeps its own words beside the mascot.
    `note` explains a slow load; `onRetry` puts a Try again button under an error (17 Oct 2026, testers IN-15). */
export const Empty = ({ msg, kind, note, onRetry }: { msg: string; kind?: "nodata" | "error"; note?: string; onRetry?: () => void }) => (
  <article className="chart-card wide inc-card" style={{ minHeight: 220, justifyContent: "center" }}>
    {kind ? (
      <StateNote kind={kind} role={kind === "error" ? "alert" : undefined}>
        {msg}
        {onRetry && kind === "error" && (
          <button type="button" className="btn-muted inc-retry" onClick={onRetry}>Try again</button>
        )}
      </StateNote>
    ) : (
      <div className="inc-loading" role="status">
        <span>
          {msg}
          {note && <span className="inc-loading-note">{note}</span>}
        </span>
      </div>
    )}
  </article>
);

export type ActionFact = { label: string; value: ReactNode };

export function ActionCard({
  icon: Icon,
  title,
  lede,
  facts,
  details,
  lead,
  tag,
  children,
}: {
  icon: LucideIcon;
  /** The action itself. */
  title: ReactNode;
  /** One short line of context (about 25 words at most). */
  lede?: ReactNode;
  /** Where, when, expected effect, confidence: whichever the data supports. */
  facts: ActionFact[];
  /** The basis and full reasoning, behind "Details". */
  details?: ReactNode;
  /** The card's primary recommendation, drawn with the page accent. */
  lead?: boolean;
  /** A short computed verdict pill beside the title. */
  tag?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={`inc-action${lead ? " is-lead" : ""}`}>
      <div className="inc-action-head">
        <span className="inc-action-icon">
          <Icon size={16} strokeWidth={2} aria-hidden="true" />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h4 className="inc-action-title">{title}</h4>
          {lede ? (
            <p className="inc-action-lede" style={{ marginTop: 6 }}>
              {lede}
            </p>
          ) : null}
        </div>
        {tag ? <div className="inc-action-tag">{tag}</div> : null}
      </div>
      {facts.length > 0 && (
        <dl className="inc-facts">
          {facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
      {details ? (
        <details className="nc-details">
          <summary>Details</summary>
          <div>{details}</div>
        </details>
      ) : null}
    </section>
  );
}

/* ── Where a recommendation comes from (2 Nov 2026) ──────────────────────────
   Every prescriptive card names its source in one glance, so "is this from the
   forecast?" never needs a paragraph to answer:
     forecast  built on a predictive model's output
     history   built on measured history in the selected Range
     whatif    decided by assumptions the data does not supply (labelled as such)
   `detail` is the one-line why, shown on hover and to screen readers. */
export type SourceKind = "forecast" | "history" | "whatif";
const SOURCE_LABEL: Record<SourceKind, string> = { forecast: "From forecast", history: "From history", whatif: "What-if" };

export function SourceBadge({ kind, detail }: { kind: SourceKind; detail?: string }) {
  return (
    <span className={`rx-source is-${kind}`} title={detail} aria-label={detail ? `${SOURCE_LABEL[kind]}: ${detail}` : SOURCE_LABEL[kind]}>
      <i aria-hidden="true" />
      {SOURCE_LABEL[kind]}
    </span>
  );
}

/* The assumptions a card rests on, as chips under its headline instead of a
   paragraph. A chip with `onEdit` is a setting the reader can change (it moves
   focus to the control); `note` is the hover text saying where the value comes
   from. */
export type Assumption = { label: string; value: ReactNode; note?: string; onEdit?: () => void };

export function AssumptionChips({ items, lead = "Assumes" }: { items: Assumption[]; lead?: string }) {
  if (items.length === 0) return null;
  return (
    <div className="rx-assume" role="list" aria-label={lead}>
      <span className="rx-assume-lead">{lead}</span>
      {items.map((a) =>
        a.onEdit ? (
          <button key={a.label} type="button" role="listitem" className="rx-chip is-edit" title={a.note ? `${a.note} (click to change)` : "Click to change"} onClick={a.onEdit}>
            <span>{a.label}</span> <b>{a.value}</b> <em aria-hidden="true">✎</em>
          </button>
        ) : (
          <span key={a.label} role="listitem" className="rx-chip" title={a.note}>
            <span>{a.label}</span> <b>{a.value}</b>
          </span>
        ),
      )}
    </div>
  );
}

/* When the forecast behind a card was made, and whether it has gone stale.
   `at` is the forecast's own time as text the card already has. */
export function ForecastAge({ at, stale }: { at: string; stale?: boolean }) {
  return (
    <span className={`rx-age${stale ? " is-stale" : ""}`} role={stale ? "status" : undefined}>
      {stale ? "Stale forecast: " : "Forecast: "}
      {at}
    </span>
  );
}
