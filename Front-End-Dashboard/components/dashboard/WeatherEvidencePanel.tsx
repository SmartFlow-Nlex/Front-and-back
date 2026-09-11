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

export default function WeatherEvidencePanel({ plotted = "total_rain" }: { plotted?: string }) {
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
  const strongest = corr[0];
  const maxAbs = Math.max(...corr.map((c) => Math.abs(c.pearson ?? 0)), 0.001);

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

  // The headline: how much does adding weather change the forecast error?
  const helped = models.filter((m) => (m.deltaPts ?? 0) > 0.05).length;
  const best = models.reduce<ModelComparison | null>((acc, m) => (m.deltaPts != null && (acc == null || m.deltaPts > (acc.deltaPts ?? 0)) ? m : acc), null);
  const verdict =
    models.length === 0 ? "Weather inputs were not tested for these models."
    : helped === 0 ? "No. Adding weather data does not make the forecast more accurate."
    : helped === models.length ? `A little. Weather makes every tested model slightly more accurate — ${best!.model} gains the most, ${best!.deltaPts!.toFixed(2)} points of error.`
    : `Only for some. Weather helps ${helped} of ${models.length} models; ${best!.model} gains the most at ${best!.deltaPts!.toFixed(2)} points of error.`;
  const strongestLine = strongest
    ? `${strongest.label} is the weather signal most tied to daily traffic, and even that link is ${linkWord(strongest.pearson)}.`
    : "";

  const maxErr = Math.max(...models.flatMap((m) => [m.withWeather ?? 0, m.withoutWeather ?? 0]), 0.001);

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <EvidenceHeading icon={<CloudRain size={14} strokeWidth={2.4} />} tint="#0284c7" title="Does weather change the forecast?">
          <InfoTooltip text={`Two checks. Left: how closely each daily weather variable moves with daily corridor volume${days ? ` over ${days.toLocaleString()} days` : ""} (Pearson correlation, shown in words). Right: the same model trained with and without weather inputs, compared on held-out error; lower is better. Holt-Winters and Holts Linear take no external inputs, so they are not tested. Rainfall is the variable drawn on the chart because it is the easiest to read.`} />
        </EvidenceHeading>
      </div>

      {/* The answer, in one or two sentences. */}
      <p style={{ margin: 0, fontSize: "0.86rem", lineHeight: 1.55, color: "var(--text-primary)" }}>
        <b>{verdict}</b>{strongestLine ? <> {strongestLine}</> : null}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "10px 32px" }}>
        {/* Left: how closely each weather variable tracks traffic. */}
        <div style={{ display: "grid", gap: 7, alignContent: "start" }}>
          <div style={{ fontSize: "0.74rem", fontWeight: 700, color: "var(--text-secondary)" }}>
            How closely each weather variable tracks daily traffic
          </div>
          {corr.map((c) => {
            const pct = (Math.abs(c.pearson ?? 0) / maxAbs) * 100;
            const isPlotted = c.variable === plotted;
            return (
              <div key={c.variable} style={{ display: "grid", gridTemplateColumns: "104px 1fr 88px", alignItems: "center", gap: 8, fontSize: "0.78rem" }}>
                <span style={{ color: "var(--text-primary)", fontWeight: isPlotted ? 700 : 500, whiteSpace: "nowrap" }}>
                  {c.label}{isPlotted && <span style={{ marginLeft: 5, fontSize: "0.62rem", color: "var(--text-muted)", fontWeight: 500 }}>on chart</span>}
                </span>
                <span style={{ height: 7, background: "var(--bg-surface-hover)", borderRadius: 4, overflow: "hidden" }}>
                  <span style={{ display: "block", height: "100%", width: `${pct}%`, background: "#0284c7", borderRadius: 4, opacity: 0.85 }} />
                </span>
                <span style={{ fontSize: "0.74rem", fontWeight: 700, color: linkTone(c.pearson), whiteSpace: "nowrap" }} title={`r = ${c.pearson == null ? "—" : c.pearson.toFixed(3)}`}>
                  {linkWord(c.pearson)}
                </span>
              </div>
            );
          })}
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Longer bar = moves more closely with traffic. Hover a word for the exact figure.</div>
        </div>

        {/* Right: forecast error with vs without weather, as paired bars. */}
        {models.length > 0 && (
          <div style={{ display: "grid", gap: 7, alignContent: "start" }}>
            <div style={{ fontSize: "0.74rem", fontWeight: 700, color: "var(--text-secondary)" }}>
              Forecast error with weather vs without <span style={{ fontWeight: 500, color: "var(--text-muted)" }}>· lower is better</span>
            </div>
            {models.map((m) => {
              const d = m.deltaPts;
              const helps = d != null && d > 0.05;
              const hurts = d != null && d < -0.05;
              const tone = helps ? "var(--color-success)" : hurts ? "var(--color-danger)" : "var(--text-muted)";
              const bar = (v: number | null, color: string, label: string) => (
                <div style={{ display: "grid", gridTemplateColumns: "52px 1fr 48px", alignItems: "center", gap: 6, fontSize: "0.72rem" }}>
                  <span style={{ color: "var(--text-muted)" }}>{label}</span>
                  <span style={{ height: 6, background: "var(--bg-surface-hover)", borderRadius: 3, overflow: "hidden" }}>
                    <span style={{ display: "block", height: "100%", width: `${((v ?? 0) / maxErr) * 100}%`, background: color, borderRadius: 3 }} />
                  </span>
                  <span style={{ textAlign: "right", color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{v == null ? "—" : `${v.toFixed(2)}%`}</span>
                </div>
              );
              return (
                <div key={m.model} style={{ display: "grid", gap: 3 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: "0.78rem" }}>
                    <b style={{ color: "var(--text-primary)" }}>{m.model}</b>
                    <b style={{ color: tone, fontSize: "0.74rem" }}>
                      {d == null ? "—" : helps ? `${d.toFixed(2)} pts better with weather` : hurts ? `${Math.abs(d).toFixed(2)} pts worse with weather` : "no difference"}
                    </b>
                  </div>
                  {bar(m.withWeather, "#0284c7", "with")}
                  {bar(m.withoutWeather, "#94a3b8", "without")}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
