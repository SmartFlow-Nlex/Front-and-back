"use client";

import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";
import { useChartTheme } from "../../lib/chart-theme";

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
  evidenceBounded: boolean;
  /** For a scenario: what the record does show, in one sentence. */
  evidenceNote?: string;
  /** Monte Carlo 5th–95th percentile, where the saving depends on which incidents happen. */
  range?: { lowTonnes: number; highTonnes: number; lowPct: number; highPct: number; runs: number } | null;
  assumptions: string[];
};

type Payload = {
  strategies: Strategy[];
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams();
    if (from && to) {
      qs.set("from", from);
      qs.set("to", to);
    } else {
      qs.set("months", months);
    }
    fetch(`${BACKEND}/api/emissions/prescriptive?${qs}`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setData(json.data as Payload);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Request failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [months, from, to]);

  if (loading) return <div style={{ color: "var(--text-muted)", padding: "24px 0" }}>Computing strategies…</div>;
  if (error || !data) {
    return (
      <div style={{ padding: "16px 0" }}>
        <div style={{ fontWeight: 700, color: "var(--text-secondary)", marginBottom: 6 }}>
          Strategies unavailable
        </div>
        <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>{error ?? "No data returned."}</div>
      </div>
    );
  }
  // A Range with no emissions in it: say so, rather than draw three bars at
  // zero that would read as "nothing saves anything".
  if (data.noData) {
    return (
      <div style={{ padding: "16px 0" }}>
        <div style={{ fontWeight: 700, color: "var(--text-secondary)", marginBottom: 6 }}>
          No emissions data in this Range
        </div>
        <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", maxWidth: "78ch" }}>{data.noData}</div>
      </div>
    );
  }
  const unavailable = data.unavailable ?? [];

  // Largest first: the ranking is the finding, so it should not depend on the
  // order the service happens to return.
  const rows = [...data.strategies].sort((a, b) => b.reductionPct - a.reductionPct);

  const option: EChartsOption = {
    grid: { left: 54, right: 24, top: 24, bottom: 64 },
    xAxis: {
      type: "category",
      data: rows.map((s) => s.label),
      axisLabel: { color: T.text, fontSize: 11, interval: 0, width: 130, overflow: "break" },
    },
    yAxis: {
      type: "value",
      name: "% of corridor CO₂",
      nameLocation: "middle",
      nameGap: 40,
      nameTextStyle: { color: T.text, fontSize: 11 },
      axisLabel: { color: T.text, formatter: (v: number) => `${v}%` },
    },
    tooltip: {
      trigger: "axis",
      confine: true,
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
            : `<b>Policy target — not demonstrated by any observed change.</b>`)
        );
      },
    },
    series: [
      {
        type: "bar",
        data: rows.map((s) => ({
          value: s.reductionPct,
          itemStyle: s.evidenceBounded
            ? { color: "#4bb782", borderRadius: [8, 8, 0, 0] }
            : // Hollow, so a scenario cannot be mistaken for a measured result.
              {
                color: "transparent",
                borderColor: "#4bb782",
                borderWidth: 2,
                borderType: "dashed",
                borderRadius: [8, 8, 0, 0],
              },
        })),
        label: {
          show: true,
          position: "top",
          color: T.text,
          fontSize: 11,
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

  const Line = ({ tone, head, children }: { tone: string; head: string; children: React.ReactNode }) => (
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 10, alignItems: "baseline" }}>
      <span style={{
        fontSize: "0.62rem", fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase",
        color: tone, whiteSpace: "nowrap", paddingTop: 2,
      }}>{head}</span>
      {/* Capped measure. On a wide monitor this card is ~1,500px, which puts
          well over 150 characters on a line — past the point where the eye
          reliably finds the start of the next one. */}
      <div style={{ fontSize: "0.82rem", lineHeight: 1.55, color: "var(--text-primary)", maxWidth: "78ch" }}>{children}</div>
    </div>
  );

  const period = over(data.basis.from, data.basis.to);

  return (
    <>
      {(lead || scenario) && (
        <div style={{
          border: "1px solid var(--border-default)",
          borderLeft: `3px solid ${lead ? "var(--color-success)" : "var(--color-warning)"}`,
          borderRadius: 10, padding: "14px 16px", marginBottom: 16,
          display: "grid", gap: 12, background: "var(--bg-surface-hover)",
        }}>
          {lead ? (
            <Line tone="var(--color-success)" head="Do this">
              <b>{lead.label}.</b> {lead.lever}.{" "}
              Worth <b>{fmtT(lead.reductionTonnes)} t</b> of CO₂ {period}
              {lead.range && <> (likely {fmtT(lead.range.lowTonnes)}–{fmtT(lead.range.highTonnes)} t)</>}:{" "}
              {lead.reductionPct.toFixed(2)}% of what the corridor emitted. Bounded by response times this corridor has{" "}
              <b>already delivered</b>, so it asks for no capability it does not have.
            </Line>
          ) : (
            <Line tone="var(--color-warning)" head="Nothing to do yet">
              No evidence-bounded strategy can be computed for this Range. {unavailable[0]?.reason}
            </Line>
          )}

          {second && (
            <Line tone="var(--text-secondary)" head="Then">
              <b>{second.label}</b> — {second.lever} — worth {fmtT(second.reductionTonnes)} t.{" "}
              <b>Do not add these two together.</b> This one applies the same clearance floor to fewer hours, so it
              is a subset of the first, not an addition to it.
            </Line>
          )}

          {scenario && (
            <Line tone="var(--color-warning)" head="Not on this evidence">
              <b>{scenario.label}</b> would be worth {fmtT(scenario.reductionTonnes)} t — far the largest figure
              here — but it is a policy question for MPTC, not an operational one. {scenario.evidenceNote}
            </Line>
          )}
        </div>
      )}

      <DashboardChart option={option} height={280} />
      <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: 10, lineHeight: 1.55, maxWidth: "92ch" }}>
        Against {fmtT(data.basis.actualCo2Tonnes)} t actually emitted over {data.basis.from} to {data.basis.to}.
        {unavailable.length > 0 ? (
          <>
            {" "}<b>Not computed for this Range:</b> {unavailable.map((u) => u.label).join(" and ")}. {unavailable[0].reason}
          </>
        ) : (
          <>
            {" "}Incident-based strategies use {data.basis.incidentsCounted.toLocaleString()} cleared incidents in the
            same window.
          </>
        )}
        {scenario && (
          <>
            {" "}
            <b>{scenario.label}</b> is drawn hollow because it is a policy target, not a demonstrated change. The
            other two are bounded by response times already delivered on this corridor, and their ranges come from a
            Monte Carlo resampling of the incidents.
          </>
        )}
      </div>
    </>
  );
}
