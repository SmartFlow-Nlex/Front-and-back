"use client";

import { useEffect, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import { CloudRain } from "lucide-react";

/**
 * Weather as a predictor, as one flat block inside the Validation evidence
 * disclosure.
 *
 * The chart overlays rainfall alone; this shows all four weather variables'
 * correlation with daily volume and the with/without-weather test for each
 * model that can take external inputs, so the choice of rainfall reads as a
 * display decision. Both halves come from the warehouse at request time.
 *
 * It used to be a card with its own Show/Hide button and three explanatory
 * paragraphs nested inside an already-collapsed section. Now: a label, one
 * headline line, four bars, one line per model. The explanations live in the
 * info icon.
 */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type Correlation = { variable: string; label: string; pearson: number | null; spearman: number | null; days: number };
type ModelComparison = { model: string; withWeather: number | null; withoutWeather: number | null; deltaPts: number | null };


/** Section heading inside the evidence area: a tinted icon tile and a bold
    title, so each block is identifiable at a glance rather than a line of
    small caps that reads as a footnote. */
export function EvidenceHeading({ icon, tint, title, children }: {
  icon: React.ReactNode; tint: string; title: string; children?: React.ReactNode;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
      <span style={{
        display: "grid", placeItems: "center", width: 24, height: 24, borderRadius: 7,
        background: `color-mix(in srgb, ${tint} 14%, transparent)`, color: tint, flex: "none",
      }}>
        {icon}
      </span>
      <span style={{ fontSize: "0.9rem", fontWeight: 800, letterSpacing: "-0.01em", color: "var(--text-primary)", display: "inline-flex", alignItems: "center" }}>
        {title}
        {children}
      </span>
    </span>
  );
}

export default function WeatherEvidencePanel({ plotted = "total_rain", selectedModels }: {
  plotted?: string;
  /** Labels of the models currently drawn on the chart. Only their with/without
      pairs are shown, so the block answers for what the reader is looking at. */
  selectedModels?: string[];
}) {
  const [corr, setCorr] = useState<Correlation[]>([]);
  const [models, setModels] = useState<ModelComparison[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND}/api/traffic/weather-evidence`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j?.success) return setState("error");
        setCorr(j.data.correlations ?? []);
        setModels(j.data.modelComparison ?? []);
        setState("ready");
      })
      .catch(() => !cancelled && setState("error"));
    return () => { cancelled = true; };
  }, []);

  if (state !== "ready") return null;

  const days = corr[0]?.days ?? null;

  // Plain words for a correlation, the way a stakeholder would say it.
  const linkWord = (r: number | null) => {
    const a = Math.abs(r ?? 0);
    if (r == null) return "no data";
    if (a < 0.1) return "almost none";
    if (a < 0.3) return "weak";
    if (a < 0.5) return "moderate";
    return "strong";
  };
  const linkTone = (r: number | null) => {
    const a = Math.abs(r ?? 0);
    return a < 0.1 ? "var(--text-muted)" : a < 0.5 ? "var(--color-warning)" : "var(--color-success)";
  };

  // The models on the chart, if any of them were tested; otherwise all tested.
  const shown = (() => {
    const pick = selectedModels?.length ? models.filter((m) => selectedModels.includes(m.model)) : [];
    return pick.length ? pick : models;
  })();
  const helped = shown.filter((m) => (m.deltaPts ?? 0) > 0.05).length;
  const best = shown.reduce<ModelComparison | null>((acc, m) => (m.deltaPts != null && (acc == null || m.deltaPts > (acc.deltaPts ?? 0)) ? m : acc), null);
  const verdict =
    shown.length === 0 ? "Weather inputs were not tested for the models on the chart."
    : helped === 0 ? "No. Adding weather data does not make this forecast more accurate."
    : shown.length === 1 ? `A little. With weather data, ${best!.model}'s error drops from ${best!.withoutWeather?.toFixed(2)}% to ${best!.withWeather?.toFixed(2)}%.`
    : helped === shown.length ? `A little. Weather data makes every model on the chart slightly more accurate; ${best!.model} gains the most.`
    : `Only for some. Weather data helps ${helped} of ${shown.length} models on the chart; ${best!.model} gains the most.`;

  const maxErr = Math.max(...shown.flatMap((m) => [m.withWeather ?? 0, m.withoutWeather ?? 0]), 0.001);

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <EvidenceHeading icon={<CloudRain size={14} strokeWidth={2.4} />} tint="#0284c7" title="Does weather change the forecast?">
        <InfoTooltip text={`The same model trained with and without weather inputs, compared on held-out error; lower is better. The chips grade how closely each daily weather variable moves with daily corridor volume${days ? ` over ${days.toLocaleString()} days` : ""}; hover one for the correlation. Holt-Winters and Holts Linear take no external inputs, so they are not tested. Rainfall is the variable drawn on the chart because it is the easiest to read.`} />
      </EvidenceHeading>

      <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.5, color: "var(--text-primary)", fontWeight: 600 }}>
        {verdict}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "12px 32px", alignItems: "start" }}>
      {shown.length > 0 && (
        <div style={{ display: "grid", gap: 10 }}>
          {shown.map((m) => {
            const d = m.deltaPts;
            const helps = d != null && d > 0.05;
            const hurts = d != null && d < -0.05;
            const tone = helps ? "var(--color-success)" : hurts ? "var(--color-danger)" : "var(--text-muted)";
            const bar = (v: number | null, color: string, label: string) => (
              <div style={{ display: "grid", gridTemplateColumns: "132px 1fr 56px", alignItems: "center", gap: 8, fontSize: "0.78rem" }}>
                <span style={{ color: "var(--text-secondary)" }}>{label}</span>
                <span style={{ height: 8, background: "var(--border-default)", borderRadius: 4, overflow: "hidden" }}>
                  <span style={{ display: "block", height: "100%", width: `${((v ?? 0) / maxErr) * 100}%`, background: color, borderRadius: 4 }} />
                </span>
                <span style={{ textAlign: "right", color: "var(--text-primary)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{v == null ? "—" : `${v.toFixed(2)}%`}</span>
              </div>
            );
            return (
              <div key={m.model} style={{ display: "grid", gap: 4 }}>
                {shown.length > 1 && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: "0.8rem" }}>
                    <b style={{ color: "var(--text-primary)" }}>{m.model}</b>
                    <b style={{ color: tone, fontSize: "0.76rem" }}>
                      {d == null ? "—" : helps ? `${d.toFixed(2)} pts better with weather` : hurts ? `${Math.abs(d).toFixed(2)} pts worse with weather` : "no difference"}
                    </b>
                  </div>
                )}
                {bar(m.withWeather, "#0284c7", "Error with weather")}
                {bar(m.withoutWeather, "#94a3b8", "Error without")}
              </div>
            );
          })}
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Shorter bar = more accurate.</div>
        </div>
      )}

      {/* The four weather signals, graded in words. */}
      <div style={{ display: "grid", gap: 8, fontSize: "0.76rem", alignContent: "start" }}>
        <span style={{ color: "var(--text-secondary)", fontWeight: 700 }}>How much each weather signal moves with traffic</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {corr.map((c) => (
          <span
            key={c.variable}
            title={`Correlation with daily volume r = ${c.pearson == null ? "—" : c.pearson.toFixed(3)}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 999,
              background: "var(--bg-surface)", border: "1px solid var(--border-default)",
            }}
          >
            <b style={{ color: "var(--text-primary)" }}>{c.label}</b>
            <span style={{ color: linkTone(c.pearson), fontWeight: 700 }}>{linkWord(c.pearson)}</span>
            {c.variable === plotted && <span style={{ fontSize: "0.62rem", color: "var(--text-muted)" }}>on chart</span>}
          </span>
        ))}
        </div>
      </div>
      </div>
    </section>
  );
}
