"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import StateNote from "../stage/StateNote";
import { Empty } from "./prescriptiveShell";
import { fetchJsonWithRetry } from "./prescriptiveTraffic.shared";
import { Term } from "./emissionsTerms";
import { useChartTheme, seriesRamp } from "../../lib/chart-theme";
import {
  AlertTriangle, CalendarRange, ChevronDown, Clock, Flag, Gauge, MapPin, ShieldCheck, Target, TrendingDown,
  type LucideIcon,
} from "lucide-react";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

/**
 * Projected CO2 reduction by strategy — computed, replacing the three literals
 * ("Strategy X/Y/Z" at 8/14/22) this card used to carry behind an
 * "Illustrative" chip. Reads /api/emissions/prescriptive; the derivations and
 * the one negative result are in docs/emissions-optimiser-spec.md.
 *
 * The one thing this component must get right visually: two of the three bars
 * are bounded by what the corridor has ALREADY achieved, and one is a policy
 * target nothing in the record supports. Drawing all three the same colour
 * would quietly equate them, so the unbounded one is drawn hollow and says so
 * in its own line. That distinction is the whole reason the old chip existed.
 */

type Strategy = {
  key: "fleet_mix" | "clearance" | "deployment";
  label: string;
  reductionPct: number;
  reductionTonnes: number;
  lever: string;
  /** Where on the corridor, and when in the day, the saving is (from the incidents it is made of). */
  where?: string;
  when?: string;
  /** What the saving is concentrated in, in one sentence. */
  focus?: string;
  evidenceBounded: boolean;
  /** For a scenario: what the record does show, in one sentence. */
  evidenceNote?: string;
  /** Monte Carlo 5th–95th percentile, where the saving depends on which incidents happen. */
  range?: { lowTonnes: number; highTonnes: number; lowPct: number; highPct: number; runs: number } | null;
  assumptions: string[];
};

/* The modelling diagram's prescriptive box for emissions: TOPSIS intervention ranking (KPI: CO2 per class-km)
   and the agent-based fleet-mix box (heavy-vehicle window restriction advisory, KPI: Class 3 peak share
   reduction), with the dynamic tolling recommendation as a system output. All computed by the service. */
type Ranking = {
  criteria: { key: string; label: string; weight: number; kind: "benefit" | "cost"; why: string }[];
  rows: { key: Strategy["key"]; label: string; closeness: number; rank: number; values: Record<string, number> }[];
  note: string;
};
type ClassKm = { cls: 1 | 2 | 3; label: string; gPerKm: number; vkmSharePct: number; co2SharePct: number };
type HeavyWindow = {
  peakHours: string;
  peakClass3SharePct: number;
  class3InPeakPct: number;
  allDayClass3SharePct?: number;
  shareReductionPp: number;
  receivingHours: string;
  fitsOffPeak: boolean;
  capacityNote: string;
  co2Note: string;
};
type Tolling = { hours: string; exits: { name: string; class3Tonnes: number; sharePct: number }[]; atStakeTonnes: number; note: string };

type Payload = {
  strategies: Strategy[];
  ranking?: Ranking | null;
  classKm?: ClassKm[];
  corridorGPerVkm?: number;
  heavyWindow?: HeavyWindow | null;
  tolling?: Tolling | null;
  /** Strategies the Range cannot support, and why: left out, not drawn at 0%. */
  unavailable?: { key: Strategy["key"]; label: string; reason: string }[];
  /** Set when the Range holds no emissions at all. */
  noData?: string | null;
  basis: {
    from: string;
    to: string;
    actualCo2Tonnes: number;
    incidentsFrom: string | null;
    incidentsTo: string | null;
    incidentsCounted: number;
    recordFrom?: string;
    recordTo?: string;
  };
};

const fmtT = (n: number) => Math.round(n).toLocaleString("en-US");

/* A failed request in words a reader can act on. fetchJsonWithRetry reports "<label> <status>"; a network
   failure arrives as the browser's own TypeError. The 429 is the API's per-network rate limit (200
   requests in 15 minutes, app.ts), which a tester on the shared LAN can reach in a session. */
function explainFailure(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const status = Number(/ (\d{3})$/.exec(msg)?.[1]);
  if (status === 429) return "The server is limiting requests from this network for a few minutes (too many in the last 15). Wait a moment, then try again.";
  if (status === 503) return "The database did not answer in time. It is shared, so this usually clears within a minute.";
  if (status >= 500) return "The server could not compute the strategies for this Range.";
  if (status >= 400) return `The request was refused (HTTP ${status}).`;
  if (e instanceof TypeError) return "Could not reach the backend. Check that it is running on port 4000, then try again.";
  return msg || "Request failed.";
}

/** The first `n` characters of `text`, cut at a word boundary. */
function shorten(text: string, n = 48): string {
  const t = text.trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 12)).replace(/[,;:·—–\s]+$/, "")}…`;
}

const MONTH = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/* What to do, as a headline per strategy; the service's full lever sits behind the Action box. Shared by
   the answer strip and the cards so the two never word the same action differently. */
const ACTION_HEAD: Record<Strategy["key"], string> = {
  clearance: "Clear blockages as fast as your best 10%",
  deployment: "Put response capacity on the 12 busiest hours",
  fleet_mix: "Shift Class 3 truck travel to Class 2 vehicles",
};

/* One field of an action card as a small box: its label and a one-line headline, the full text only when
   the box is opened. The card used to print every field in full, which made each one a wall of prose; the
   headline is enough to scan, and the detail is one click away. Opened boxes span the row so long text
   stays readable. */
function InfoTile({ label, summary, children, tone, icon: Icon, compact }: {
  label: string; summary: React.ReactNode; children?: React.ReactNode; tone?: "note"; icon: LucideIcon; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expandable = children != null;
  return (
    <div className={`nc-em-tile${compact ? " is-compact" : ""}${open ? " is-open" : ""}${tone === "note" ? " is-note" : ""}`}>
      <button
        type="button"
        className="nc-em-tile-head"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <span className="nc-em-tile-icon" aria-hidden="true"><Icon size={compact ? 14 : 16} strokeWidth={2} /></span>
        <span className="nc-em-tile-label">{label}</span>
        <span className="nc-em-tile-summary">{summary}</span>
        {expandable && <ChevronDown className="nc-em-tile-chev" size={16} strokeWidth={2} aria-hidden="true" />}
      </button>
      {open && expandable && <div className="nc-em-tile-body">{children}</div>}
    </div>
  );
}

/* The tonnes are over the Range, not per year. "A year" was printed whatever
 * the Range, which made a two-month figure read as an annual one. */
function over(from: string, to: string): string {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (!Number.isFinite(days) || days <= 0) return `over ${from} to ${to}`;
  if (days >= 360 && days <= 370) return "a year";
  if (days >= 28) return `over these ${Math.round(days / 30.44)} months`;
  return `over these ${days} days`;
}

export default function PrescriptiveEmissionsPanel({
  months,
  from,
  to,
}: {
  months: "3" | "12" | "all";
  from?: string;
  to?: string;
}) {
  const T = useChartTheme();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /* Shorter page (2026-10-15): #1 and #2 open side by side; the policy scenario (#3) folds to one line. */
  const [openCards, setOpenCards] = useState<Set<number>>(() => new Set([1, 2]));
  const toggleCard = (rank: number) =>
    setOpenCards((cur) => {
      const next = new Set(cur);
      if (next.has(rank)) next.delete(rank);
      else next.add(rank);
      return next;
    });
  /* The four analyses below the chart share one card, one tab at a time, instead of four stacked cards. */
  const [moreTab, setMoreTab] = useState<"ranking" | "classkm" | "window" | "tolling">("ranking");

  /* Load reliably (17 Oct 2026, testers EM-11.1: "failed to load" for one tester, stuck for another).
     The panel made one bare fetch: a single slow handshake or a 503 while the shared database woke left
     it on an error with no way back but a reload, and nothing on screen said a cold Range takes 3 to 11
     seconds (six queries plus a 400-run Monte Carlo). Now transient failures are retried (3 tries, 3 s
     then 8 s apart), a slow load says why, and an error carries Try again. */
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSlow(false);
    const slowTimer = window.setTimeout(() => !cancelled && setSlow(true), 5000);
    const qs = new URLSearchParams();
    if (from && to) {
      qs.set("from", from);
      qs.set("to", to);
    } else {
      qs.set("months", months);
    }
    fetchJsonWithRetry(`${BACKEND}/api/emissions/prescriptive?${qs}`, "prescriptive strategies")
      .then((json) => {
        if (cancelled) return;
        if (!json?.success) throw new Error(json?.message ?? "Request failed");
        setData(json.data as Payload);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(explainFailure(e));
      })
      .finally(() => {
        window.clearTimeout(slowTimer);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(slowTimer);
    };
  }, [months, from, to, attempt]);

  /* A Range change keeps the last answer on screen (19 Oct 2026, testers EM-11: the panel swapped to the
     full loading card on every Range click, so the page jumped and the old answer could not be compared
     with the new). As on the Incidents tab's Clearance Response Protocol: the previous result stays, faded
     under an "Updating…" badge until the new one lands; a slow read or a failed refresh says so in a line
     above it, with Try again. The loading card is now only for the first read, when there is nothing yet. */
  const updating = loading && data !== null;
  const retry = () => setAttempt((n) => n + 1);
  const slowNote =
    "A Range read for the first time takes up to about 20 seconds: every lane-blocking incident's queue is costed and resampled 400 times. Ranges already read come back at once.";
  const updatingBadge = updating ? (
    <span className="inc-updating-badge" role="status" aria-live="polite">
      Updating…
    </span>
  ) : null;
  const busy = { "aria-busy": updating, "data-rx-busy": updating ? "true" : undefined } as const;

  /* The evidence card's head: the title, ⓘ and intro that used to sit in
     page.tsx. Here so the no-data state keeps them; the first load and a first
     failure use the shared Empty card, which names the panel in its message. */
  const evidenceHead = (
    <div className="nc-em-card-head">
      <h3>
        Projected % Emission Reduction by Strategy
        <InfoTooltip text="Computed from our own records over the selected Range. Shorter lane blockages and busiest-hours response are limited to blockage times NLEX has already achieved. The Class 3 bar is a what-if (drawn hollow): our records have never shown NLEX lowering truck traffic. Moving trips to other hours is not offered, because in this model a vehicle gives off the same CO2 at any hour." />
        {updatingBadge}
      </h3>
      <p className="nc-em-context">
        <Term t="CO₂" /> avoided per strategy, as a share of what the corridor actually emitted over the Range.
      </p>
    </div>
  );

  if (!data) {
    return loading ? (
      <Empty msg="Computing emission-reduction strategies for this Range…" note={slow ? slowNote : undefined} />
    ) : (
      <Empty
        kind="error"
        msg={`Emission-reduction strategies unavailable. ${error ?? "No data returned."}`}
        onRetry={retry}
      />
    );
  }

  /* What the faded result is: the Range it was computed for, so stale figures are never read as current. */
  const shownRange = `${MONTH(data.basis.from)} – ${MONTH(data.basis.to)}`;
  const statusLine = (
    <>
      {updating && slow && (
        <p className="inc-status-line nc-em-span" role="status">
          Still updating. {slowNote} Until then the figures below are for {shownRange}.
        </p>
      )}
      {error && !loading && (
        <p className="inc-status-line is-warn nc-em-span" role="alert">
          Couldn&apos;t refresh for the new Range. {error} Showing the last result ({shownRange}), which does not match
          the Range above.
          <button type="button" className="btn-muted" onClick={retry}>Try again</button>
        </p>
      )}
    </>
  );

  // A Range with no emissions in it: say so, rather than draw three bars at
  // zero that would read as "nothing saves anything".
  if (data.noData) {
    return (
      <>
        {statusLine}
        <article className="chart-card nc-em-span nc-em-rx-evidence nc-em-rx-busy" {...busy}>
          {evidenceHead}
          <StateNote kind="nodata" title="No emissions data in this Range">
            <span style={{ display: "block", maxWidth: "78ch" }}>{data.noData}</span>
          </StateNote>
        </article>
      </>
    );
  }
  const unavailable = data.unavailable ?? [];

  // Largest first: the ranking is the finding, so it should not depend on the
  // order the service happens to return.
  const rows = [...data.strategies].sort((a, b) => b.reductionPct - a.reductionPct);

  /* Same teal step as before (the emissions ramp's middle step, per theme),
     read from the ramp rather than retyped. */
  const BAR = seriesRamp("emissions", T)[1];

  /* Ranked bars, drawn horizontally: the strategy names read on one line
     beside their bar instead of wrapping under it. Same bars, same order,
     same tooltip. */
  const option: EChartsOption = {
    grid: { left: 8, right: 56, top: 8, bottom: 34, containLabel: true },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((s) => s.label),
      axisTick: { show: false },
      axisLabel: { color: T.ink, fontSize: 12, interval: 0, width: 120, overflow: "break", lineHeight: 15 },
    },
    xAxis: {
      type: "value",
      name: "% of corridor CO₂",
      nameLocation: "middle",
      nameGap: 26,
      nameTextStyle: { color: T.text, fontSize: 12 },
      splitNumber: 4,
      axisLabel: { color: T.text, hideOverlap: true, formatter: (v: number) => `${v}%` },
      splitLine: { lineStyle: { color: T.split } },
    },
    tooltip: {
      trigger: "axis",
      confine: true,
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const p = (params as { dataIndex: number }[])[0];
        const s = rows[p.dataIndex];
        if (!s) return "";
        return (
          `<b>${s.label}</b><br/>` +
          `${s.reductionPct.toFixed(2)}% of corridor CO₂ &middot; ${fmtT(s.reductionTonnes)} t avoided<br/>` +
          (s.range
            ? `<span style="opacity:.8">Monte Carlo range (5th–95th of ${s.range.runs} runs): ${fmtT(s.range.lowTonnes)}–${fmtT(s.range.highTonnes)} t</span><br/>`
            : "") +
          `<span style="opacity:.8">${s.lever}</span><br/><br/>` +
          (s.evidenceBounded
            ? `<span style="opacity:.8">Bounded by what this corridor has already achieved.</span>`
            : `<b>What-if only: our records have never shown this happening on NLEX.</b>`)
        );
      },
    },
    series: [
      {
        type: "bar",
        barMaxWidth: 26,
        data: rows.map((s) => ({
          value: s.reductionPct,
          itemStyle: s.evidenceBounded
            ? { color: BAR, borderRadius: [0, 4, 4, 0] }
            : // Hollow, so a scenario cannot be mistaken for a measured result.
              {
                color: "transparent",
                borderColor: BAR,
                borderWidth: 2,
                borderType: "dashed",
                borderRadius: [0, 4, 4, 0],
              },
        })),
        label: {
          show: true,
          position: "right",
          color: T.ink,
          fontSize: 12,
          fontFamily: T.fontFamily,
          formatter: (p: { value?: unknown }) => `${Number(p.value ?? 0).toFixed(2)}%`,
        },
      },
    ],
  };

  const scenario = rows.find((s) => !s.evidenceBounded);
  /* THE RECOMMENDATION.
   *
   * Three bars and a percentage is analysis, not advice — the tab is called
   * Prescriptive and was not prescribing anything. What an operator needs is
   * one named action, what it is worth, and what NOT to do.
   *
   * The pick is the largest EVIDENCE-BOUNDED strategy, deliberately not the
   * largest bar: the heavy-vehicle scenario is far bigger, but nothing in the
   * record ties a lower heavy share to anything NLEX controls (its lowest
   * months are holiday months), so leading with it would be recommending a
   * number rather than an action. */
  const doable = rows.filter((s) => s.evidenceBounded);
  const lead = doable[0] ?? null;
  const second = doable[1] ?? null;

  const period = over(data.basis.from, data.basis.to);
  const maxPct = Math.max(...rows.map((s) => s.reductionPct), 0.0001);

  /* Ranked action cards. Each answers first (tonnes avoided), then reads as
     labelled rows: Action, Where, When, Effect, Basis, Confidence. The full
     sentence each card replaced, and the service's own assumptions, sit
     behind Details on the same card. The order is the recommendation's: the
     lead, then the second, then the policy scenario. */
  type Tone = "lead" | "then" | "scenario";
  /** One sentence an operator can act on, read off the card's own fields. */
  const takeaway = (s: Strategy): string => {
    if (!s.evidenceBounded) return "A lever for MPTC policy, not for operations: no change in the record shows it can be reached.";
    const place = (s.where ?? "").split(" · ")[0].split(" (")[0];
    const hit = /^(\d+)% of this saving comes from ([\d,]+) incident/.exec(s.focus ?? "");
    if (place && hit) return `Start at ${place}: ${hit[2]} long blockages hold ${hit[1]}% of this saving.`;
    return place ? `Start at ${place}.` : "";
  };
  const ActionCard = ({
    s, rank, tone, tag, note, noteSummary, details,
  }: {
    s: Strategy; rank: number; tone: Tone; tag: string; note?: React.ReactNode; noteSummary?: string; details: React.ReactNode;
  }) => openCards.has(rank) ? (
    <li className="chart-card nc-em-acard" data-tone={tone}>
      <div className="nc-em-acard-answer">
        <div className="nc-em-acard-top">
          <span className="nc-em-acard-rank" aria-hidden="true">{rank}</span>
          <span className="nc-em-action-tag">{tag}</span>
          {s.evidenceBounded
            ? <span className="pill green">Evidence-bounded</span>
            : <span className="pill nc-em-pill-hollow">What-if only</span>}
        </div>
        <h3>{s.label}</h3>
        <p className="nc-em-answer">
          <b>{fmtT(s.reductionTonnes)} t</b>
          <span>CO₂ avoided {period}</span>
        </p>
        {takeaway(s) && <p className="nc-em-takeaway">{takeaway(s)}</p>}
      </div>
      <div className="nc-em-acard-body">
        {(() => {
          /* Headlines for the boxes, from the same strings the full text is. */
          const longHit = /^(\d+)% of this saving comes from ([\d,]+) incident/.exec(s.focus ?? "");
          const startHead = longHit ? `${longHit[2]} long blockages hold ${longHit[1]}%` : shorten((s.focus ?? "").split(" — ")[0], 44);
          const places = (s.where ?? "Corridor-wide").split(" · ");
          const firstPlace = /\(\d+%/.test(places[0])
            ? places[0].replace(/^(.*?) \((\d+%).*$/, "$1 · $2")
            : places[0].split(":")[0];
          const whenText = s.when ?? "Any hour";
          const [whenHours, whenShare] = whenText.split(" — ");
          const windows = whenHours.split(", ").length;
          return (
            <>
              {/* What to do: the four boxes an operator acts on. */}
              <div className="nc-em-tiles">
                <InfoTile label="Action" icon={Target} summary={ACTION_HEAD[s.key] ?? shorten(s.lever)}>
                  <p className="nc-em-cap">{s.lever}.</p>
                </InfoTile>
                <InfoTile
                  label="Where"
                  icon={MapPin}
                  summary={<>{firstPlace}{places.length > 1 && <span className="nc-em-tile-more">+{places.length - 1} more</span>}</>}
                >
                  {places.length > 1 || places[0] !== firstPlace ? <ul>{places.map((p) => <li key={p}>{p}</li>)}</ul> : undefined}
                </InfoTile>
                <InfoTile
                  label="When"
                  icon={Clock}
                  summary={windows > 2 ? <>{windows} time windows{whenShare ? <span className="nc-em-tile-more">{whenShare.replace(" of the saving", "")} of it</span> : null}</> : whenText}
                >
                  {windows > 2 || whenShare ? <ul>{whenHours.split(", ").map((h) => <li key={h}>{h}</li>)}{whenShare && <li>{whenShare}</li>}</ul> : undefined}
                </InfoTile>
                {s.focus && (
                  <InfoTile label="Start with" icon={Flag} summary={startHead}>
                    <p>{s.focus}</p>
                  </InfoTile>
                )}
              </div>
              {/* The facts behind it: smaller, in one row. */}
              <div className="nc-em-tiles is-facts">
                <InfoTile
                  compact
                  label="Effect"
                  icon={TrendingDown}
                  summary={
                    <>
                      <span className="nc-em-inline-bar" aria-hidden="true">
                        <i
                          className={s.evidenceBounded ? "" : "is-hollow"}
                          style={{ width: `${Math.max(2, (s.reductionPct / maxPct) * 100)}%`, ["--bar-c" as string]: BAR }}
                        />
                      </span>
                      {s.reductionPct.toFixed(2)}% of CO₂
                    </>
                  }
                >
                  <p>{fmtT(s.reductionTonnes)} t avoided, {s.reductionPct.toFixed(2)}% of what the corridor emitted over the period.</p>
                </InfoTile>
                <InfoTile
                  compact
                  label="Confidence"
                  icon={Gauge}
                  summary={s.range ? `${fmtT(s.range.lowTonnes)}–${fmtT(s.range.highTonnes)} t likely` : "No range"}
                >
                  <p>
                    {s.range
                      ? <>The 5th to 95th percentile of {s.range.runs} Monte Carlo runs: likely {fmtT(s.range.lowTonnes)}–{fmtT(s.range.highTonnes)} t.</>
                      : "No Monte Carlo range: nothing in this figure is uncertain except the target chosen."}
                  </p>
                </InfoTile>
                <InfoTile compact label="Period" icon={CalendarRange} summary={`${MONTH(data.basis.from)} – ${MONTH(data.basis.to)}`}>
                  <p>Estimated over {data.basis.from} to {data.basis.to}.</p>
                </InfoTile>
                <InfoTile compact label="Basis" icon={ShieldCheck} summary={s.evidenceBounded ? "Achieved on NLEX" : "What-if only"}>
                  <p>
                    {s.evidenceBounded
                      ? "Bounded by lane-blockage times this corridor has already achieved."
                      : "A what-if: our records have never shown this happening on NLEX."}
                  </p>
                </InfoTile>
                {note && (
                  <InfoTile compact label="Note" tone="note" icon={AlertTriangle} summary={noteSummary ?? (typeof note === "string" ? shorten(note, 40) : "Read before acting")}>
                    <p>{note}</p>
                  </InfoTile>
                )}
              </div>
            </>
          );
        })()}
        <div className="nc-em-acard-foot">
          <details className="nc-details">
            <summary>Details</summary>
            {details}
            {s.assumptions?.length ? (
              <ul className="nc-em-action-assumptions">
                {s.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            ) : null}
          </details>
          {rank !== 1 && (
            <button type="button" className="nc-em-fold-btn" onClick={() => toggleCard(rank)} aria-expanded="true">
              Fold <ChevronDown size={14} strokeWidth={2} aria-hidden="true" style={{ transform: "rotate(180deg)" }} />
            </button>
          )}
        </div>
      </div>
    </li>
  ) : (
    /* Folded: one line, the answer and a way in. */
    <li className="chart-card nc-em-acard is-folded" data-tone={tone}>
      <button type="button" className="nc-em-fold-row" onClick={() => toggleCard(rank)} aria-expanded="false">
        <span className="nc-em-acard-rank" aria-hidden="true">{rank}</span>
        <span className="nc-em-action-tag">{tag}</span>
        <span className="nc-em-fold-title">{s.label}</span>
        <span className="nc-em-fold-value"><b>{fmtT(s.reductionTonnes)} t</b> CO₂</span>
        {s.evidenceBounded
          ? <span className="pill green">Evidence-bounded</span>
          : <span className="pill nc-em-pill-hollow">What-if only</span>}
        <span className="nc-em-fold-cta">Show details <ChevronDown size={15} strokeWidth={2} aria-hidden="true" /></span>
      </button>
    </li>
  );

  let rank = 0;

  return (
    <>
      {/* The answer in four rows (19 Oct 2026, testers EM-11: "check the output answers the test question").
          The cards held it, but spread over a headline and eight boxes; a tester asking "what should we do,
          and what does it save?" had to assemble it. Read off the same lead strategy as card #1. */}
      {statusLine}
      {lead && (
        <section className="chart-card nc-em-span nc-em-rx-answer nc-em-rx-busy" aria-label="Recommendation" {...busy}>
          <span className="nc-em-action-tag">Recommendation · {shownRange}{updatingBadge}</span>
          <dl className="nc-em-rows">
            <div>
              <dt>Do this</dt>
              <dd><b>{ACTION_HEAD[lead.key] ?? lead.label}.</b> {takeaway(lead)}</dd>
            </div>
            <div>
              <dt>Expected</dt>
              <dd>
                <b>{fmtT(lead.reductionTonnes)} t <Term t="CO₂" /></b> avoided {period}, {lead.reductionPct.toFixed(2)}% of the{" "}
                {fmtT(data.basis.actualCo2Tonnes)} t the corridor emitted
                {lead.range && <>; likely {fmtT(lead.range.lowTonnes)}–{fmtT(lead.range.highTonnes)} t</>}
              </dd>
            </div>
            <div>
              <dt>Basis</dt>
              <dd>
                {data.basis.incidentsCounted.toLocaleString()} lane-blocking incidents in the Range, each shortened only to
                a blockage time NLEX has already achieved
              </dd>
            </div>
            {scenario && (
              <div className="is-note">
                <dt>Not this</dt>
                <dd>
                  The Class 3 figure ({fmtT(scenario.reductionTonnes)} t) is larger but is a what-if needing a policy
                  decision, not an operations action
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {(lead || scenario) && (
        <ol className="nc-em-span nc-em-acards nc-em-rx-busy" aria-label="Recommended actions, ranked" {...busy}>
          {lead ? (
            <ActionCard
              s={lead}
              rank={++rank}
              tone="lead"
              tag="Do this"
              details={
                <p>
                  <b>{lead.label}.</b> {lead.lever}.{" "}
                  Worth <b>{fmtT(lead.reductionTonnes)} t</b> of CO₂ {period}
                  {lead.range && <> (likely {fmtT(lead.range.lowTonnes)}–{fmtT(lead.range.highTonnes)} t)</>}:{" "}
                  {lead.reductionPct.toFixed(2)}% of what the corridor emitted. Bounded by blockage times this corridor has{" "}
                  <b>already delivered</b>, so it asks for no capability it does not have.
                </p>
              }
            />
          ) : (
            <li className="chart-card nc-em-acard" data-tone="none">
              <div className="nc-em-acard-answer">
                <div className="nc-em-acard-top">
                  <span className="nc-em-acard-rank" aria-hidden="true">—</span>
                  <span className="nc-em-action-tag">Nothing to do yet</span>
                </div>
              </div>
              <div className="nc-em-acard-body">
                <p className="nc-em-action-text">
                  No evidence-bounded strategy can be computed for this Range. {unavailable[0]?.reason}
                </p>
              </div>
            </li>
          )}

          {second && (
            <ActionCard
              s={second}
              rank={++rank}
              tone="then"
              tag="Then"
              note={<><b>Do not add these two together.</b> It is a subset of #1, not an addition.</>}
              noteSummary="Part of #1, do not add them"
              details={
                <p>
                  <b>{second.label}</b> — {second.lever} — worth {fmtT(second.reductionTonnes)} t.{" "}
                  <b>Do not add these two together.</b> This one applies the same blockage floor to fewer hours, so it
                  is a subset of the first, not an addition to it.
                </p>
              }
            />
          )}

          {/* The policy scenario as one line, not a card (2026-10-15): its boxes said almost nothing
              ("Corridor-wide", "Every day", "No range"), and it already appears as the hollow bar in the chart and
              as rank 3 in the TOPSIS table. What a reader needs from it is one fact: the biggest number on the
              page is a policy target, not something operations can do. */}
          {scenario && (
            <li className="chart-card nc-em-acard nc-em-scenario-line" data-tone="scenario">
              <span className="nc-em-acard-rank" aria-hidden="true">{++rank}</span>
              <span className="pill nc-em-pill-hollow">What-if only</span>
              <span className="nc-em-scenario-text">
                <b>Fewer big trucks</b> on NLEX would cut <b>{fmtT(scenario.reductionTonnes)} t</b> of CO₂ — but that would take a
                company policy decision (MPTC, NLEX&rsquo;s parent company), such as truck tolls or rules, not something the control room can do.
              </span>
              <details className="nc-em-scenario-why">
                <summary>Why</summary>
                <ul>
                  <li>
                    A large truck (Class 3) gives off about 8 times the CO₂ of a car for every kilometre. If 1 out of every
                    100 kilometres driven on NLEX moved from large trucks to smaller vehicles, CO₂ would drop by
                    {" "}{fmtT(scenario.reductionTonnes)} t.
                  </li>
                  <li>
                    But our records have never shown NLEX lowering truck traffic. The months with the fewest trucks are
                    all Decembers, when holiday cars fill the road; the trucks did not actually go away.
                  </li>
                  <li>
                    So this is a <b>what-if</b> to show how much trucks matter, not a plan. That is why it is drawn hollow in
                    the chart and scores 0 in the ranking.
                  </li>
                </ul>
              </details>
            </li>
          )}
        </ol>
      )}

      {/* The chart and the analyses side by side on a wide screen, stacked on a narrow one (2026-10-15). */}
      <div className="nc-em-span nc-em-pair nc-em-rx-busy" {...busy}>
      <article className="chart-card nc-em-span nc-em-rx-evidence">
        {evidenceHead}
        <figure className="nc-em-rx-chart">
          <figcaption className="nc-em-rx-chart-head">
            <span>Ranked by size</span>
            <span className="nc-em-rx-key">
              <span><i className="is-solid" style={{ background: BAR }} />Evidence-bounded</span>
              <span><i className="is-hollow" style={{ borderColor: BAR }} />What-if only (hollow)</span>
            </span>
          </figcaption>
          <DashboardChart option={option} height={Math.max(180, rows.length * 62 + 50)} />
        </figure>

        {/* The basis, as labelled rows rather than a paragraph. */}
        <dl className="nc-em-rows nc-em-basis-rows">
          <div>
            <dt>Actually emitted</dt>
            <dd>{fmtT(data.basis.actualCo2Tonnes)} t over {data.basis.from} to {data.basis.to}</dd>
          </div>
          {unavailable.length > 0 ? (
            <div className="is-note">
              <dt>Not computed</dt>
              <dd>
                <b>Not computed for this Range:</b> {unavailable.map((u) => u.label).join(" and ")}. {unavailable[0].reason}
              </dd>
            </div>
          ) : (
            <div>
              <dt>Incidents</dt>
              <dd>{data.basis.incidentsCounted.toLocaleString()} lane-blocking incidents in the same window</dd>
            </div>
          )}
        </dl>
        <details className="nc-details">
          <summary>How this is measured</summary>
          <p>
            Against {fmtT(data.basis.actualCo2Tonnes)} t actually emitted over {data.basis.from} to {data.basis.to}.
            {unavailable.length === 0 && (
              <>
                {" "}Incident-based strategies use {data.basis.incidentsCounted.toLocaleString()} incidents that blocked
                a lane in the same window, each for as long as the lane stayed blocked.
              </>
            )}
          </p>
          {scenario && (
            <p>
              <b>{scenario.label}</b> is drawn hollow because it is a what-if, not something our records show NLEX can do. The
              other two are bounded by lane-blockage times already achieved on this corridor, and their ranges come from a
              Monte Carlo resampling of the incidents.
            </p>
          )}
        </details>
      </article>

      {(() => {
        const tabs = [
          { key: "ranking" as const, label: "Ranking (TOPSIS)", on: !!data.ranking && data.ranking.rows.length > 0 },
          { key: "classkm" as const, label: "CO₂ per class-km", on: !!data.classKm && data.classKm.length > 0 },
          { key: "window" as const, label: "Truck window", on: !!data.heavyWindow },
          { key: "tolling" as const, label: "Tolling", on: !!data.tolling },
        ].filter((t) => t.on);
        if (!tabs.length) return null;
        return (
          <article className="chart-card nc-em-span nc-em-more">
            <div className="nc-em-more-tabs" role="tablist" aria-label="More analysis">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={moreTab === t.key}
                  className={moreTab === t.key ? "is-on" : ""}
                  onClick={() => setMoreTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          {moreTab === "ranking" && data.ranking && data.ranking.rows.length > 0 && (
            <div className="nc-em-more-pane">
              <div className="nc-em-card-head">
                <h3>
                  Intervention ranking (TOPSIS)
                  <InfoTooltip text={data.ranking.note} />
                </h3>
                <p className="nc-em-context">
                  The strategies above, ranked on what the record can measure. The score runs from 0 (worst on every
                  criterion) to 1 (best on every criterion).
                </p>
              </div>
              <div className="nc-em-table-wrap">
                <table className="nc-em-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Intervention</th>
                      <th className="num">Score</th>
                      <th className="num">Expected</th>
                      <th className="num">Bad year</th>
                      <th>On NLEX</th>
                      <th className="num">Uncertainty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ranking.rows.map((r) => (
                      <tr key={r.key}>
                        <td className="nc-em-strong">{r.rank}</td>
                        <td className={r.rank === 1 ? "nc-em-strong" : undefined}>{r.label}</td>
                        <td className="num">{r.closeness.toFixed(2)}</td>
                        <td className="num">{r.values.evidence ? fmtT(r.values.expected) : <span className="is-muted">target only</span>}</td>
                        <td className="num">{fmtT(r.values.worst)}</td>
                        <td className={r.values.evidence ? "is-ok" : "is-muted"}>{r.values.evidence ? "Yes" : "No"}</td>
                        <td className="num">{r.values.evidence ? `±${Math.round((r.values.spread * 100) / 2)}%` : <span className="is-muted">not known</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details className="nc-details">
                <summary>Criteria and weights</summary>
                <ul className="nc-em-action-assumptions">
                  {data.ranking.criteria.map((c) => (
                    <li key={c.key}>
                      <b>{c.label}</b> — weight {c.weight.toFixed(2)}, {c.kind === "benefit" ? "higher is better" : "lower is better"}. {c.why}
                    </li>
                  ))}
                  <li>The weights are a stated choice and add up to 1. {data.ranking.note}</li>
                </ul>
              </details>
            </div>
          )}

          {moreTab === "classkm" && data.classKm && data.classKm.length > 0 && (
            <div className="nc-em-more-pane">
              <div className="nc-em-card-head">
                <h3>
                  <Term t="CO₂" /> per class-km
                  <InfoTooltip text="Grams of CO₂ per vehicle-kilometre for each toll class (the warehouse's emission factors), against each class's share of the distance driven and of the CO₂ over the Range." />
                </h3>
                <p className="nc-em-context">
                  The corridor averaged {data.corridorGPerVkm ?? 0} g of CO₂ per vehicle-km over the Range.
                </p>
              </div>
              <div className="nc-em-table-wrap">
                <table className="nc-em-table">
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th className="num">g CO₂ per km</th>
                      <th className="num">Share of distance</th>
                      <th className="num">Share of CO₂</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.classKm.map((c) => (
                      <tr key={c.cls}>
                        <td>{c.label}</td>
                        <td className="num">{c.gPerKm.toLocaleString("en-US")}</td>
                        <td className="num">{c.vkmSharePct.toFixed(1)}%</td>
                        <td className={`num${c.co2SharePct > c.vkmSharePct * 2 ? " nc-em-strong" : ""}`}>{c.co2SharePct.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(() => {
                const h = data.classKm.find((c) => c.cls === 3);
                return h ? (
                  <p className="nc-em-context">
                    Large trucks drive {h.vkmSharePct.toFixed(1)}% of the distance but emit {h.co2SharePct.toFixed(1)}% of
                    the CO₂: each of their kilometres emits {(h.gPerKm / (data.classKm.find((c) => c.cls === 1)?.gPerKm ?? h.gPerKm)).toFixed(1)} times a car&apos;s.
                  </p>
                ) : null;
              })()}
            </div>
          )}

          {moreTab === "window" && data.heavyWindow && (
            <div className="nc-em-more-pane">
              <div className="nc-em-card-head">
                <h3>
                  Class 3 window restriction advisory
                  <InfoTooltip text="From the modelling diagram's fleet-mix box. KPI: Class 3 peak share reduction. The peak hours are those within 10% of the busiest hour's vehicle-km over the Range." />
                </h3>
                <p className="nc-em-context">
                  Keep Class 3 out of <b>{data.heavyWindow.peakHours}</b>, and route it to {data.heavyWindow.receivingHours}.
                </p>
              </div>
              <dl className="nc-em-rows">
                <div>
                  <dt>Window</dt>
                  <dd>{data.heavyWindow.peakHours} (the corridor&apos;s busiest hours in this Range)</dd>
                </div>
                <div>
                  <dt>Now</dt>
                  <dd>
                    {data.heavyWindow.peakClass3SharePct.toFixed(1)}% of vehicle-km in those hours
                    {data.heavyWindow.allDayClass3SharePct != null && (
                      <> against {data.heavyWindow.allDayClass3SharePct.toFixed(1)}% over the whole day</>
                    )}
                    ; {data.heavyWindow.class3InPeakPct.toFixed(1)}% of all Class-3 vehicle-km falls in the window.
                  </dd>
                </div>
                <div>
                  <dt>KPI</dt>
                  <dd>
                    Class 3 peak share down <b>{data.heavyWindow.shareReductionPp.toFixed(1)} percentage points</b> if the
                    restriction is fully observed (half compliance, half that)
                  </dd>
                </div>
                <div>
                  <dt>Move to</dt>
                  <dd>{data.heavyWindow.receivingHours}</dd>
                </div>
                <div className={data.heavyWindow.fitsOffPeak ? undefined : "is-note"}>
                  <dt>Capacity</dt>
                  <dd>{data.heavyWindow.capacityNote}</dd>
                </div>
                <div className="is-note">
                  <dt>CO₂</dt>
                  <dd>{data.heavyWindow.co2Note}</dd>
                </div>
              </dl>
              {data.heavyWindow.allDayClass3SharePct != null &&
                data.heavyWindow.peakClass3SharePct < data.heavyWindow.allDayClass3SharePct / 2 && (
                  <p className="nc-em-context">
                    Trucks already avoid this window: their share there is under half their share over the day. A
                    restriction would formalise what drivers mostly do already, so expect a small effect on the peak.
                  </p>
                )}
            </div>
          )}

          {moreTab === "tolling" && data.tolling && (
            <div className="nc-em-more-pane">
              <div className="nc-em-card-head">
                <h3>
                  Dynamic tolling recommendation
                  <InfoTooltip text={data.tolling.note} />
                </h3>
                <p className="nc-em-context">
                  A Class-3 surcharge during <b>{data.tolling.hours}</b> at the exits below, which carry the most Class-3
                  CO₂ in those hours ({fmtT(data.tolling.atStakeTonnes)} t over the Range at all exits).
                </p>
              </div>
              <div className="nc-em-table-wrap">
                <table className="nc-em-table">
                  <thead>
                    <tr>
                      <th>Exit</th>
                      <th className="num">Class-3 CO₂ in the window (t)</th>
                      <th className="num">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tolling.exits.map((e) => (
                      <tr key={e.name}>
                        <td>{e.name}</td>
                        <td className="num">{fmtT(e.class3Tonnes)}</td>
                        <td className="num">{e.sharePct.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="nc-em-context">{data.tolling.note}</p>
            </div>
          )}
          </article>
        );
      })()}
      </div>
    </>
  );
}
