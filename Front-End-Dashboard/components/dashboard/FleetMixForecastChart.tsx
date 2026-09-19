"use client";

/**
 * Forecasted fleet composition — the modelling diagram's second Emission
 * Forecasting box.
 *
 * Every number comes from GET /api/emissions/fleet-mix, which serves
 * gold.ml_predictive_fleet_mix, written by
 * smartflow_scripts/3_training_testing/fleet_mix/train_fleet_mix.py.
 *
 * WHY A STACKED AREA AND NOT THREE LINES
 *
 *   The three class shares are a composition: they sum to 100% by definition,
 *   so they are not three independent series that happen to share an axis. Drawn
 *   as separate lines, a reader has to add them up mentally to see that Class 1
 *   giving up a point is Class 2 or 3 taking it. Stacked to 100%, that trade is
 *   the shape of the chart.
 *
 * WHY THE FORECAST IS A SEPARATE, PALER BAND
 *
 *   Actuals and predictions on one continuous surface read as one measured
 *   series, which is exactly the claim the panel must not make. The projection
 *   is drawn in the same colours at reduced opacity with a marked boundary, so
 *   where the evidence stops is visible without reading a legend.
 */

import type { EChartsOption } from "echarts";
import { useEffect, useMemo, useState } from "react";
import DashboardChart from "./DashboardChart";
import InfoTooltip from "./InfoTooltip";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

/** Must match HORIZON in train_fleet_mix.py — the stretch that was validated. */
const VALIDATED_HORIZON = 7;

type Row = {
  d: string;
  actual_c1: number | null; actual_c2: number | null; actual_c3: number | null;
  pred_c1: number | null; pred_c2: number | null; pred_c3: number | null;
  heavy_pred: number | null; heavy_surge: boolean;
  champion_model: string | null;
  is_holdout: boolean; is_future: boolean;
};

type ModelRow = {
  model_name: string; rank: number | null; accepted: boolean;
  mae: number | null; rmse: number | null; wmape: number | null;
  r2: number | null; mase: number | null; mape: number | null;
  rejected_reason: string | null; diagnosis: string | null; split_label: string | null;
};

type Payload = {
  champion: string | null;
  series: Row[];
  split: {
    context_days: number; holdout_days: number; future_days: number;
    surge_days: number; future_start: string | null; future_end: string | null;
    updated_at: string | null;
  } | null;
  models: ModelRow[];
};

/* Class colours match the simulation canvas and the Fleet Mix vs Pollution Load
 * card, so a reader moving between tabs does not have to relearn which colour
 * is a truck. Red is avoided throughout — it marks a hazard elsewhere. */
const CLASS_META = [
  { key: "c1", label: "Class 1 · light", color: "#3e67ef" },
  { key: "c2", label: "Class 2 · medium", color: "#1f9d57" },
  { key: "c3", label: "Class 3 · heavy", color: "#9b5de5" },
] as const;

const pct = (v: number | null | undefined) =>
  v == null ? "—" : `${(v * 100).toFixed(2)}%`;

export default function FleetMixForecastChart() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${BACKEND}/api/emissions/fleet-mix?days=180`);
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok || !j.success) throw new Error(j.message ?? `HTTP ${r.status}`);
        setData(j.data as Payload);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the fleet-mix forecast");
      }
    })();
    return () => { cancelled = true; };
  }, [attempt]);

  const model = useMemo(() => {
    if (!data || data.series.length === 0) return null;
    const rows = data.series;

    const dates = rows.map((r) => r.d);
    const firstFuture = rows.findIndex((r) => r.is_future);

    /* Observed and projected are built as separate series over the same axis,
     * each padded with nulls outside its own span, rather than one series that
     * switches meaning partway along. ECharts then cannot join them into a
     * single surface, which is the visual claim being avoided. */
    const observed = CLASS_META.map((c) =>
      rows.map((r) => {
        const v = r[`actual_${c.key}` as "actual_c1"];
        return v == null ? null : v * 100;
      }),
    );
    const projected = CLASS_META.map((c) =>
      rows.map((r) => {
        if (!r.is_future) return null;
        const v = r[`pred_${c.key}` as "pred_c1"];
        return v == null ? null : v * 100;
      }),
    );

    const champ = data.models.find((m) => m.accepted && m.rank === 1) ?? null;
    const surges = rows.filter((r) => r.heavy_surge && r.is_future);

    return { rows, dates, firstFuture, observed, projected, champ, surges };
  }, [data]);

  if (error) {
    return (
      <article className="chart-card wide" style={{ padding: 24, display: "grid", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700 }}>Forecasted Fleet Composition</h3>
        <p style={{ color: "var(--color-danger, #ef4444)", fontSize: "0.88rem", margin: 0 }}>{error}</p>
        <div>
          <button
            onClick={() => { setError(null); setAttempt((a) => a + 1); }}
            style={{ padding: "6px 16px", borderRadius: 999, cursor: "pointer", border: "1px solid transparent",
                     background: "linear-gradient(135deg, #6366f1, #4f46e5)", color: "#fff", fontSize: "0.78rem", fontWeight: 600 }}
          >Try again</button>
        </div>
      </article>
    );
  }

  if (!data) {
    return (
      <article className="chart-card wide" style={{ padding: 24 }}>
        <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700 }}>Forecasted Fleet Composition</h3>
        <p style={{ color: "#64748b", fontSize: "0.85rem" }}>Loading…</p>
      </article>
    );
  }

  /* The forecast has never been published. Distinct from an error, and worth
   * saying plainly: an empty chart with no explanation is the thing that sends
   * someone hunting for a bug that is not there. */
  if (!model) {
    return (
      <article className="chart-card wide" style={{ padding: 24, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700 }}>Forecasted Fleet Composition</h3>
        <p style={{ color: "#64748b", fontSize: "0.85rem", margin: 0 }}>
          No fleet-mix forecast has been published yet. Run{" "}
          <code>smartflow_scripts/3_training_testing/fleet_mix/train_fleet_mix.py</code> to generate one.
        </p>
      </article>
    );
  }

  const { rows, dates, firstFuture, observed, projected, champ, surges } = model;

  const option: EChartsOption = {
    grid: { left: 52, right: 18, top: 28, bottom: 58 },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: "rgba(255,255,255,0.97)",
      borderColor: "#e2e8f0",
      borderWidth: 1,
      textStyle: { color: "#334155" },
      extraCssText: "box-shadow: 0 6px 16px rgba(15,23,42,0.12); border-radius: 8px; max-width: 320px;",
      formatter: (params: unknown) => {
        const ps = params as { dataIndex: number }[];
        if (!ps.length) return "";
        const i = ps[0].dataIndex;
        const r = rows[i];
        const src = r.is_future ? "projected" : "observed";
        const vals = CLASS_META.map((c, k) => {
          const v = r.is_future ? r[`pred_${c.key}` as "pred_c1"] : r[`actual_${c.key}` as "actual_c1"];
          return `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c.color};margin-right:6px;"></span>${c.label}<span style="float:right;font-weight:700;margin-left:16px;">${pct(v)}</span>`;
        }).join("<br/>");
        const heavy = r.is_future && r.heavy_pred != null
          ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e2e8f0;">Heavy (C2+C3) <b>${pct(r.heavy_pred)}</b>${r.heavy_surge ? ' <span style="color:#b45309;font-weight:700;">· surge</span>' : ""}</div>`
          : "";
        return `<div style="padding:2px 4px;min-width:220px;">
                  <b style="color:#0f172a;">${r.d}</b>
                  <span style="color:#94a3b8;font-size:0.85em;"> · ${src}</span>
                  <div style="margin-top:8px;font-size:0.9em;">${vals}</div>${heavy}
                </div>`;
      },
    },
    legend: {
      bottom: 0,
      itemWidth: 11,
      itemHeight: 11,
      textStyle: { fontSize: 11, color: "#64748b" },
      data: CLASS_META.map((c) => c.label),
    },
    xAxis: {
      type: "category",
      data: dates,
      boundaryGap: false,
      axisLabel: { fontSize: 10, color: "#94a3b8", hideOverlap: true },
      axisLine: { lineStyle: { color: "#e2e8f0" } },
    },
    yAxis: {
      type: "value",
      max: 100,
      min: 0,
      axisLabel: { formatter: "{value}%", fontSize: 10, color: "#94a3b8" },
      splitLine: { lineStyle: { color: "#eef2f7" } },
    },
    series: [
      ...CLASS_META.map((c, k) => ({
        name: c.label,
        type: "line" as const,
        stack: "observed",
        areaStyle: { color: c.color, opacity: 0.85 },
        lineStyle: { width: 0 },
        showSymbol: false,
        data: observed[k],
        // The boundary between measured and projected, drawn once on the first
        // series so it is not stamped three times.
        ...(k === 0 && firstFuture >= 0
          ? {
              markLine: {
                silent: true,
                symbol: "none" as const,
                label: { formatter: "forecast →", fontSize: 10, color: "#64748b", position: "insideEndTop" as const },
                lineStyle: { color: "#94a3b8", type: "dashed" as const, width: 1 },
                data: [{ xAxis: firstFuture }],
              },
            }
          : {}),
      })),
      ...CLASS_META.map((c, k) => ({
        name: c.label,
        type: "line" as const,
        stack: "projected",
        areaStyle: { color: c.color, opacity: 0.38 },
        lineStyle: { width: 0 },
        showSymbol: false,
        // Suppressed from the legend: these carry the same three names as the
        // observed series, and a six-entry legend listing each class twice
        // implies six things are plotted.
        legendHoverLink: false,
        tooltip: { show: false },
        data: projected[k],
      })),
    ],
  };

  const heavyNow = rows.filter((r) => !r.is_future && r.actual_c2 != null).slice(-1)[0];
  const heavyEnd = rows.filter((r) => r.is_future && r.heavy_pred != null).slice(-1)[0];

  return (
    <article className="chart-card wide" style={{ padding: 20, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
            Forecasted Fleet Composition
            <InfoTooltip text="Share of corridor traffic by toll class, stacked to 100%. Solid is observed; the paler band past the dashed line is projected. Shares are a composition — a point gained by one class is lost by another — so they are modelled jointly rather than as three separate forecasts." />
          </h3>
          <p style={{ margin: "4px 0 0", fontSize: "0.82rem", color: "#64748b" }}>
            {champ ? <>Champion <b style={{ color: "#334155" }}>{champ.model_name}</b></> : "No model accepted"}
            {data.split?.future_days ? <> · {data.split.future_days}-day projection</> : null}
            {" "}· validated at {VALIDATED_HORIZON} days
            {data.split?.updated_at ? <> · updated {data.split.updated_at.slice(0, 10)}</> : null}
          </p>
        </div>
        {heavyNow && heavyEnd && (
          <div style={{ textAlign: "right", fontSize: "0.82rem", color: "#64748b" }}>
            Heavy share (C2+C3)
            <div style={{ fontSize: "1rem", fontWeight: 800, color: "#334155" }}>
              {pct((heavyNow.actual_c2 ?? 0) + (heavyNow.actual_c3 ?? 0))} → {pct(heavyEnd.heavy_pred)}
            </div>
          </div>
        )}
      </div>

      <DashboardChart option={option} height={320} />

      {surges.length > 0 && (
        <div style={{ padding: "10px 12px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, fontSize: "0.84rem", color: "#92400e" }}>
          <b>Heavy-vehicle surge predicted</b> on {surges.length} day{surges.length === 1 ? "" : "s"} —{" "}
          {surges.slice(0, 4).map((s) => s.d).join(", ")}{surges.length > 4 ? ` and ${surges.length - 4} more` : ""}.
          A day is flagged when the projected Class 2+3 share runs more than 1.5 standard deviations above its training mean.
        </div>
      )}

      {/* The leaderboard travels with the chart for the same reason it does on
          the CO2 panel: a forecast without the evidence that it beat a trivial
          baseline is a line on a chart, not a result. Rejected models are shown
          WITH their reason rather than omitted. */}
      {data.models.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>
                <th style={{ padding: "6px 8px", fontWeight: 600 }}>MODEL</th>
                <th style={{ padding: "6px 8px", fontWeight: 600, textAlign: "right" }}>MAE (pp)</th>
                <th style={{ padding: "6px 8px", fontWeight: 600, textAlign: "right" }}>MAPE</th>
                <th style={{ padding: "6px 8px", fontWeight: 600, textAlign: "right" }}>HEAVY WMAPE</th>
                <th style={{ padding: "6px 8px", fontWeight: 600, textAlign: "right" }}>HEAVY R²</th>
                <th style={{ padding: "6px 8px", fontWeight: 600, textAlign: "right" }}>SKILL</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((m) => (
                <tr key={m.model_name} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "6px 8px", fontWeight: 700, color: "#0f172a" }}>
                    {m.model_name}{" "}
                    {m.accepted
                      ? <span style={{ color: "#16a34a", fontWeight: 600, fontSize: "0.92em" }}>accepted{m.rank === 1 ? " · champion" : ""}</span>
                      : <span style={{ color: "#94a3b8", fontWeight: 500, fontSize: "0.92em" }} title={m.rejected_reason ?? m.diagnosis ?? undefined}>
                          {m.rejected_reason ? "rejected" : "baseline"}
                        </span>}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{m.mae?.toFixed(2) ?? "—"}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{m.mape != null ? `${m.mape.toFixed(2)}%` : "—"}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{m.wmape != null ? `${m.wmape.toFixed(2)}%` : "—"}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{m.r2?.toFixed(3) ?? "—"}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, color: (m.mase ?? 1) < 1 ? "#16a34a" : "#b45309" }}>
                    {m.mase?.toFixed(3) ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ margin: "8px 0 0", fontSize: "0.74rem", color: "#94a3b8", lineHeight: 1.5 }}>
            Ranked by Aitchison distance, the standard metric for compositional data — MAPE divides by the actual
            value, so on a fleet that is ~79% Class 1 and ~9% Class 3 it scores the same absolute miss ten times
            harder on the rarest class. <b>SKILL</b> is the ratio against a persistence baseline; below 1 means the
            model beats assuming the mix does not change. {champ?.split_label ? `Protocol: ${champ.split_label}.` : ""}
          </p>
        </div>
      )}
    </article>
  );
}
