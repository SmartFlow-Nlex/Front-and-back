"use client";

import { useEffect, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import StateNote from "../stage/StateNote";
import { Empty, ForecastAge, SourceBadge } from "./prescriptiveShell";
import { fetchJsonWithRetry } from "./prescriptiveTraffic.shared";
import { Term } from "./emissionsTerms";
import { Clock, Flag, MapPin } from "lucide-react";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

/**
 * Projected CO2 reduction — computed, replacing the three literals ("Strategy X/Y/Z" at 8/14/22) this card
 * used to carry behind an "Illustrative" chip. Reads /api/emissions/prescriptive; the derivations are in
 * docs/emissions-optimiser-spec.md.
 *
 * Measured recommendations only (2 Nov 2026): shorter lane blockages, bounded by blockage times comparable
 * ones on NLEX already achieved, looked back over the Range and carried over the incident forecast's
 * validated days; the Class 3 window advisory from the congestion forecast; and where a Class 3 surcharge
 * would apply. The Class 3 share shift, busiest-hours deployment and the TOPSIS ranking were removed as not
 * data-backed.
 */

type Strategy = {
  key: "clearance";
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
  /** Bootstrap 5th–95th percentile over resamples of the Range's incidents. */
  range?: { lowTonnes: number; highTonnes: number; lowPct: number; highPct: number; runs: number } | null;
  assumptions: string[];
  /** How the blockage floors were set and how many incidents stand behind them. */
  floorNote?: string;
  /** The saving carried forward over the incident forecast's validated days; null with a reason otherwise. */
  projection?: { tonnes: number; from: string; to: string; days: number; forecastIncidents: number; basis: string } | null;
  projectionNote?: string;
};

/* The modelling diagram's prescriptive box for emissions (KPI: CO2 per class-km) and the fleet-mix box
   (Class 3 window advisory, KPI: Class 3 peak share), with the dynamic tolling recommendation as a system
   output. All computed by the service. */
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
  action?: string;
  source?: "forecast" | "history";
  basis?: string;
  /** Set, with no action, when the window would be over half the day. */
  noWindow?: string;
};
type Tolling = {
  hours: string;
  exits: { name: string; class3Tonnes: number; sharePct: number }[];
  atStakeTonnes: number;
  note: string;
  action?: string;
  coveredPct?: number;
};

type Payload = {
  strategies: Strategy[];
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

const MONTH = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/* What to do, as a headline per strategy; the service's full lever sits behind the Action box. Shared by
   the answer strip and the cards so the two never word the same action differently. */
const ACTION_HEAD: Record<Strategy["key"], string> = {
  clearance: "Clear blockages as fast as the fastest 10% of comparable ones",
};

/* "2026-07-08", "2026-07-14" -> "8–14 Jul 2026" (or "28 Jun – 4 Jul 2026" across a month). */
function dayRange(from: string, to: string): string {
  const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const a = d(from), b = d(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return `${from} to ${to}`;
  const fmt = (x: Date, o: Intl.DateTimeFormatOptions) => x.toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
  if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear())
    return `${a.getUTCDate()}–${fmt(b, { day: "numeric", month: "short", year: "numeric" })}`;
  return `${fmt(a, { day: "numeric", month: "short" })} – ${fmt(b, { day: "numeric", month: "short", year: "numeric" })}`;
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

/* "02 Nov 2026 19:00" out of the window advisory's basis, and whether that forecast is over a day old (the
   congestion forecast refreshes hourly; a day-old one no longer describes the week ahead). */
function forecastStamp(basis?: string): { at: string; stale: boolean } | null {
  const m = /forecast of (\d{2}) (\w{3}) (\d{4}) (\d{2}:\d{2})/.exec(basis ?? "");
  if (!m) return null;
  const t = Date.parse(`${m[2]} ${m[1]}, ${m[3]} ${m[4]} GMT+0800`);
  return { at: `${m[1]} ${m[2]} ${m[3]}, ${m[4]}`, stale: Number.isFinite(t) && Date.now() - t > 24 * 3_600_000 };
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
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /* Load reliably (17 Oct 2026, testers EM-11.1: "failed to load" for one tester, stuck for another).
     The panel made one bare fetch: a single slow handshake or a 503 while the shared database woke left
     it on an error with no way back but a reload, and nothing on screen said a cold Range takes 3 to 11
     seconds (six queries plus a 400-run bootstrap). Now transient failures are retried (3 tries, 3 s
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
        Projected Emission Reduction
        <InfoTooltip text="Computed from our own records over the selected Range. Each lane blockage is shortened only to a blockage time comparable ones on NLEX already achieved; idling uses the cited Argonne and EPA idle rates. Moving trips to other hours is not offered, because in this model a vehicle gives off the same CO2 at any hour." />
        {updatingBadge}
      </h3>
      <p className="nc-em-context">
        <Term t="CO₂" /> avoided by shorter lane blockages: looking back over the Range, and ahead over the incident
        forecast&apos;s validated days.
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

  /* THE RECOMMENDATION (2 Nov 2026: measured strategies only).
   *
   * One strategy is left, and it is evidence-bounded: shorter lane blockages, each cut only to a blockage time
   * comparable ones on NLEX already achieved. The Class 3 share shift (its size was a chosen target),
   * busiest-hours deployment (no responder data) and the TOPSIS ranking (chosen weights) were removed as not
   * data-backed.
   *
   * One card (2 Nov 2026, user: "look at the UI, improve and fix"). It used to be a strip ("Do this", "Saves")
   * over a card that said the same again in a headline, an Action box and three fact boxes, with the evidence
   * card repeating the two numbers a third time. Now: the action as the title, three numbers, then where, when
   * and what to start with, each read straight off the service's fields. */
  const lead = data.strategies.find((s) => s.evidenceBounded) ?? null;
  const period = over(data.basis.from, data.basis.to);

  const recommendation = (s: Strategy) => {
    /* "Southbound Km 50–60 near San Simon (21%, 10 blockages of an hour or more)" -> name, share, count. */
    const places = (s.where ?? "").split(" · ").filter(Boolean).map((p) => {
      const m = /^(.*?) \((\d+)%(?:, ([\d,]+) blockages?)?/.exec(p);
      return m ? { name: m[1], pct: Number(m[2]), long: m[3] ?? null, full: p } : { name: p, pct: null, long: null, full: p };
    });
    const [whenHours = "", whenShare] = (s.when ?? "").split(" — ");
    const windows = whenHours ? whenHours.split(", ") : [];
    const longHit = /^(\d+)% of this saving comes from ([\d,]+) incident/.exec(s.focus ?? "");
    return (
      <section className="chart-card nc-em-span nc-em-hero nc-em-rx-busy" aria-label="Recommendation" {...busy}>
        <div className="nc-em-acard-top">
          <span className="nc-em-action-tag">Recommendation · {shownRange}</span>
          <SourceBadge kind="history" detail="A look back over the Range's incidents, bounded by blockage times comparable ones achieved" />
          {s.projection && <SourceBadge kind="forecast" detail="Carried over the incident forecast's validated days" />}
          {updatingBadge}
          <InfoTooltip text={`${s.lever}. ${s.floorNote ?? ""}`} />
        </div>
        <h3 className="nc-em-hero-title">{ACTION_HEAD[s.key] ?? s.label}</h3>

        <div className="nc-em-hero-nums" role="group" aria-label="CO₂ avoided">
          <div className="nc-em-hero-num is-lead">
            <span className="nc-em-hero-num-label">Looking back</span>
            <b>{fmtT(s.reductionTonnes)} <small>tonnes <Term t="CO₂" /></small></b>
            <span>
              avoided {period}
              {s.range && <>, likely {fmtT(s.range.lowTonnes)}–{fmtT(s.range.highTonnes)}</>}
            </span>
          </div>
          <div className="nc-em-hero-num">
            <span className="nc-em-hero-num-label">Ahead</span>
            {s.projection ? (
              <>
                <b>~{fmtT(s.projection.tonnes)} <small>tonnes</small></b>
                <span title={s.projection.basis}>
                  {dayRange(s.projection.from, s.projection.to)} · {s.projection.forecastIncidents.toLocaleString()} incidents forecast
                </span>
              </>
            ) : (
              <>
                <b className="is-none">—</b>
                <span>{s.projectionNote ?? "No forward figure"}</span>
              </>
            )}
          </div>
          <div className="nc-em-hero-num">
            <span className="nc-em-hero-num-label">Share of corridor CO₂</span>
            <b>{s.reductionPct.toFixed(2)}<small>%</small></b>
            <span>of {fmtT(data.basis.actualCo2Tonnes)} tonnes emitted</span>
          </div>
        </div>

        <div className="nc-em-hero-grid">
          {places.length > 0 && (
            <div className="nc-em-hero-block">
              <span className="nc-em-hero-label"><MapPin size={14} strokeWidth={2} aria-hidden="true" /> Where</span>
              <ul className="nc-em-rcard-exits nc-em-hero-places">
                {places.map((p) => (
                  <li key={p.full} title={p.full}>
                    <span>{p.name}</span>
                    {p.pct != null && (
                      <>
                        <span className="nc-em-rcard-bar" aria-hidden="true">
                          <i style={{ width: `${Math.max(3, Math.min(100, p.pct))}%` }} />
                        </span>
                        <b>{p.pct}%</b>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <span className="nc-em-hero-foot">Share of the saving</span>
            </div>
          )}
          {windows.length > 0 && (
            <div className="nc-em-hero-block">
              <span className="nc-em-hero-label"><Clock size={14} strokeWidth={2} aria-hidden="true" /> When</span>
              <ul className="nc-em-hero-hours">
                {windows.map((h) => <li key={h}>{h}</li>)}
              </ul>
              {whenShare && <span className="nc-em-hero-foot">These hours hold {whenShare.replace(/ of the saving$/, "")} of the saving</span>}
            </div>
          )}
          {s.focus && (
            <div className="nc-em-hero-block">
              <span className="nc-em-hero-label"><Flag size={14} strokeWidth={2} aria-hidden="true" /> Start with</span>
              {longHit ? (
                <p className="nc-em-hero-start">
                  <b>{longHit[2]}</b> blockages of an hour or more hold <b>{longHit[1]}%</b> of the saving
                </p>
              ) : (
                <p className="nc-em-hero-start">{s.focus}</p>
              )}
            </div>
          )}
        </div>
        {/* The basis, folded under the action it supports (2 Nov 2026, user: "are these recommendations?"; they
            were their own card, which read as a finding on a tab meant for actions only). */}
        <details className="nc-details nc-em-hero-how">
          <summary>How it is measured</summary>
          <dl className="nc-em-rows nc-em-basis-rows">
            <div>
              <dt>Emitted</dt>
              <dd>{fmtT(data.basis.actualCo2Tonnes)} tonnes over the Range ({shownRange})</dd>
            </div>
            <div>
              <dt>Incidents</dt>
              <dd>{data.basis.incidentsCounted.toLocaleString()} that blocked a lane, each for as long as it stayed blocked</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd title={s.floorNote}>The fastest 10% of comparable blockages (same length, same hour) on this corridor</dd>
            </div>
            {s.range && (
              <div>
                <dt>Likely range</dt>
                <dd>5th to 95th percentile of {s.range.runs} resamples of those incidents</dd>
              </div>
            )}
            {s.projection && (
              <div>
                <dt>Ahead</dt>
                <dd title={s.projection.basis}>
                  Saving per incident × {s.projection.forecastIncidents.toLocaleString()} incidents forecast on the{" "}
                  {s.projection.days} days the forecast&apos;s accuracy study passes
                </dd>
              </div>
            )}
            <div>
              <dt>Idling</dt>
              <dd>Argonne idle fuel rates × EPA kg CO₂ per gallon (gasoline Class 1, diesel Classes 2–3)</dd>
            </div>
          </dl>
        </details>
      </section>
    );
  };

  return (
    <>
      {statusLine}
      {lead ? (
        recommendation(lead)
      ) : (
        <section className="chart-card nc-em-span nc-em-hero nc-em-rx-busy" aria-label="Recommendation" {...busy}>
          <div className="nc-em-acard-top">
            <span className="nc-em-action-tag is-none">Nothing to do yet · {shownRange}</span>
            {updatingBadge}
          </div>
          <p className="nc-em-context">No evidence-bounded strategy can be computed for this Range. {unavailable[0]?.reason}</p>
        </section>
      )}

      {/* The Class 3 window advisory and the tolling recommendation, as recommendation cards (2 Nov 2026). They were
          tabs inside "More analysis", where a reader had to go looking for the only two recommendations on this tab
          that follow the congestion forecast. Same anatomy as the cards above: do this, where, when, expected
          effect, basis, how sure. */}
      {(data.heavyWindow?.action || data.heavyWindow?.noWindow || data.tolling?.action) && (() => {
        const w = data.heavyWindow;
        const tl = data.tolling;
        const stamp = forecastStamp(w?.basis);
        const fromForecast = w?.source === "forecast";
        const concentrated = w?.allDayClass3SharePct != null && w.peakClass3SharePct > w.allDayClass3SharePct * 1.5;
        const avoided = w?.allDayClass3SharePct != null && w.peakClass3SharePct < w.allDayClass3SharePct / 2;
        return (
          <section className="nc-em-span nc-em-recs nc-em-rx-busy" aria-label="Class 3 recommendations" {...busy}>
            {/* Why Class 3 (the diagram's KPI, CO2 per class-km): the reason for both cards, not a card of its own. */}
            {(() => {
              const h = data.classKm?.find((c) => c.cls === 3);
              const car = data.classKm?.find((c) => c.cls === 1);
              if (!h || !car) return null;
              return (
                <details className="nc-details nc-em-span nc-em-recs-why">
                  <summary>
                    <b>Why Class 3:</b> large trucks drive {h.vkmSharePct.toFixed(1)}% of the distance but emit{" "}
                    {h.co2SharePct.toFixed(1)}% of the <Term t="CO₂" />, {(h.gPerKm / car.gPerKm).toFixed(1)}× a car per km
                  </summary>
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
                        {data.classKm!.map((c) => (
                          <tr key={c.cls}>
                            <td>{c.label}</td>
                            <td className="num">{c.gPerKm.toFixed(1)}</td>
                            <td className="num">{c.vkmSharePct.toFixed(1)}%</td>
                            <td className="num">{c.co2SharePct.toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              );
            })()}
            {w?.noWindow && !w.action && (
              <article className="chart-card nc-em-rcard nc-em-span">
                <div className="nc-em-acard-top">
                  <span className="nc-em-action-tag">Class 3 window advisory</span>
                  {stamp && <ForecastAge at={stamp.at} stale={stamp.stale} />}
                </div>
                <p className="nc-em-context">No advisory or surcharge this week. {w.noWindow}</p>
              </article>
            )}
            {w?.action && (
              <article className="chart-card nc-em-rcard">
                <div className="nc-em-acard-top">
                  <span className="nc-em-action-tag">Class 3 window advisory</span>
                  <SourceBadge
                    kind={fromForecast ? "forecast" : "history"}
                    detail={fromForecast ? "Window from the congestion forecast's High-congestion hours" : "No forecast available: the Range's busiest hours"}
                  />
                  {stamp && <ForecastAge at={stamp.at} stale={stamp.stale} />}
                  <InfoTooltip text={`${w.basis ?? ""} Effect measured on the diagram's KPI, Class 3's share of vehicle-km in the window; what the advisory would change on the road cannot be measured with this data. ${w.capacityNote} No CO2 change is claimed, and daytime truck restrictions are not in our data.`} />
                </div>
                <h3 className="nc-em-rcard-title" title={w.action}>Advise Class 3 to avoid {w.peakHours}</h3>
                <dl className="nc-em-rows">
                  <div>
                    <dt>Effect</dt>
                    <dd>
                      Class 3 share of the window <b>{w.peakClass3SharePct.toFixed(1)}% → 0%</b>
                      {w.allDayClass3SharePct != null && <> ({w.allDayClass3SharePct.toFixed(1)}% all day)</>}
                    </dd>
                  </div>
                  <div>
                    <dt>Move to</dt>
                    <dd title={w.capacityNote}>{w.receivingHours}{w.fitsOffPeak ? "" : " (not all of it fits)"}</dd>
                  </div>
                  {(concentrated || avoided) && (
                    <div className="is-note">
                      <dt>Check</dt>
                      <dd>
                        {concentrated
                          ? "Trucks concentrate here; check daytime truck restrictions first."
                          : "Trucks already avoid these hours."}
                      </dd>
                    </div>
                  )}
                </dl>
              </article>
            )}
            {tl?.action && (
              <article className="chart-card nc-em-rcard">
                <div className="nc-em-acard-top">
                  <span className="nc-em-action-tag">Tolling recommendation</span>
                  <SourceBadge
                    kind={fromForecast ? "forecast" : "history"}
                    detail={fromForecast ? "Uses the Class 3 window, which comes from the congestion forecast" : "Uses the Range's busiest hours"}
                  />
                  {stamp && <ForecastAge at={stamp.at} stale={stamp.stale} />}
                  <InfoTooltip text={tl.note} />
                </div>
                <h3 className="nc-em-rcard-title" title={tl.action}>Charge any Class 3 surcharge at these {tl.exits.length} exits, {tl.hours}</h3>
                <dl className="nc-em-rows">
                  <div>
                    <dt>Where</dt>
                    <dd>
                      <ul className="nc-em-rcard-exits">
                        {tl.exits.map((e) => (
                          <li key={e.name}>
                            <span>{e.name}</span>
                            <span className="nc-em-rcard-bar" aria-hidden="true">
                              <i style={{ width: `${Math.max(3, Math.min(100, e.sharePct))}%` }} />
                            </span>
                            <b>{e.sharePct.toFixed(1)}%</b>
                            <span className="is-muted">{fmtT(e.class3Tonnes)} tonnes</span>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                  <div>
                    <dt>Effect</dt>
                    <dd title={`${fmtT(tl.atStakeTonnes)} tonnes of Class 3 CO2 in the window over the Range, at all exits`}>
                      Together <b>{(tl.coveredPct ?? 0).toFixed(0)}%</b> of Class 3&apos;s CO₂ in those hours
                    </dd>
                  </div>
                </dl>
              </article>
            )}
          </section>
        );
      })()}

    </>
  );
}
