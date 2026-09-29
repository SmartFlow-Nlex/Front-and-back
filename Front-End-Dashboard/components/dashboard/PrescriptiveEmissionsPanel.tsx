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
  assumptions: string[];
};

type Payload = {
  strategies: Strategy[];
  basis: {
    from: string;
    to: string;
    actualCo2Tonnes: number;
    incidentsFrom: string | null;
    incidentsTo: string | null;
    incidentsCounted: number;
  };
};

const fmtT = (n: number) => Math.round(n).toLocaleString("en-US");

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

  return (
    <>
      <DashboardChart option={option} height={280} />
      <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
        Against {fmtT(data.basis.actualCo2Tonnes)} t actually emitted over {data.basis.from} to {data.basis.to}.
        Incident-based strategies use {data.basis.incidentsCounted.toLocaleString()} cleared incidents in the
        same window.
        {scenario && (
          <>
            {" "}
            <b>{scenario.label}</b> is drawn hollow because it is a policy target: Class-3 share moved only
            0.037 pp across 54 months, so nothing observed shows a shift that size is achievable. The other two
            are bounded by response times already delivered on this corridor.
          </>
        )}
      </div>
    </>
  );
}
