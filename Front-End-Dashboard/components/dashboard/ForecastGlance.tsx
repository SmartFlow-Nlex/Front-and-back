"use client";

/* The Predictive tab's answers, before its evidence.
 *
 * The analytics diagram gives each predictive row four boxes -- Models, KPI,
 * Visualization, System Output -- and the tab below this strip renders the
 * first three in depth. The fourth, the System Output, was the one thing a
 * reader could not find: the next-day forecast lived behind a click on a chart
 * point, the seasonal peak was not stated anywhere, and the congestion and
 * event conclusions sat mid-card under their own KPI tiles.
 *
 * This strip states the four outputs as plain sentences with one number each,
 * labelled with the diagram's own words. It computes from the same payload the
 * charts draw, so it cannot say something the charts do not.
 */

import { useEffect, useMemo, useState } from "react";
import { loadForecast, championValue, manilaDate, type ForecastPayload } from "./prescriptiveTraffic.shared";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);
const monthName = (ym: string) =>
  new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });

type HourlyDay = {
  date: string;
  weekday: string;
  dayPredicted: number | null;
  profileSource: string | null;
  hours: { hour: number; predicted: number | null }[];
};

type Accuracy = { model: string; hLo: number; hHi: number; wmape: number | null; usable: boolean } | null;
type CongestionModel = { model: string; accuracy: number | null; baseline?: { model: string; accuracy: number | null } | null } | null;

/* Two fields the shared loader does not keep; read once here rather than
   widening the shared type for a single consumer. */
function useForecastExtras() {
  const [extra, setExtra] = useState<{ accuracy: Accuracy; congestion: CongestionModel }>({ accuracy: null, congestion: null });
  useEffect(() => {
    let alive = true;
    fetch(`${BACKEND}/api/traffic/forecast?months=all`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        const d = j?.data ?? {};
        const acc = Array.isArray(d.horizonAccuracy)
          ? (d.horizonAccuracy as Accuracy[]).find((a) => a && a.hLo === 1) ?? null
          : null;
        setExtra({ accuracy: acc, congestion: d.congestionModel ?? null });
      })
      .catch(() => alive && setExtra({ accuracy: null, congestion: null }));
    return () => { alive = false; };
  }, []);
  return extra;
}

const Tile = ({ eyebrow, headline, sentence, foot, children }: {
  eyebrow: string; headline: string; sentence: React.ReactNode; foot: string; children?: React.ReactNode;
}) => (
  <article className="chart-card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
    <span style={{ fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)" }}>
      {eyebrow}
    </span>
    <span style={{ fontSize: "1.35rem", fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
      {headline}
    </span>
    <span style={{ fontSize: "0.78rem", lineHeight: 1.4, color: "var(--text-secondary)" }}>{sentence}</span>
    {children}
    <span style={{ marginTop: "auto", paddingTop: 6, fontSize: "0.68rem", color: "var(--text-muted)" }}>{foot}</span>
  </article>
);

export default function ForecastGlance() {
  const [data, setData] = useState<ForecastPayload | null>(null);
  const [hourly, setHourly] = useState<HourlyDay | null>(null);
  const extra = useForecastExtras();

  useEffect(() => {
    let alive = true;
    loadForecast().then((d) => alive && setData(d)).catch(() => {});
    return () => { alive = false; };
  }, []);

  /* Future rows keyed to the Manila day they are for. */
  const future = useMemo(() => {
    if (!data) return [];
    return data.volumes
      .filter((v) => v.is_future)
      .map((v) => ({ date: manilaDate(v.date), forecast: championValue(v, data.championModel) ?? 0 }))
      .filter((d) => d.forecast > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [data]);

  // 24-hour forecast for the first future day, from the endpoint the chart
  // already uses for its click-through.
  useEffect(() => {
    if (!data || future.length === 0) return;
    let alive = true;
    const model = data.championModel ?? "Prophet";
    fetch(`${BACKEND}/api/traffic/forecast/hourly?date=${future[0].date}&model=${encodeURIComponent(model)}&weather=all`)
      .then((r) => r.json())
      .then((j) => alive && j?.data?.hours && setHourly(j.data as HourlyDay))
      .catch(() => {});
    return () => { alive = false; };
  }, [data, future]);

  /* Monthly seasonal peak: the busiest month in the forecast, by average day.
     Averaged rather than summed so a month only partly inside the horizon is
     not penalised for having fewer days. */
  const seasonal = useMemo(() => {
    if (future.length === 0) return null;
    const byMonth = new Map<string, { sum: number; n: number }>();
    for (const d of future) {
      const ym = d.date.slice(0, 7);
      const cur = byMonth.get(ym) ?? { sum: 0, n: 0 };
      byMonth.set(ym, { sum: cur.sum + d.forecast, n: cur.n + 1 });
    }
    const months = [...byMonth.entries()].map(([ym, v]) => ({ ym, avg: v.sum / v.n, n: v.n })).filter((m) => m.n >= 7);
    if (months.length === 0) return null;
    const peak = months.reduce((a, b) => (b.avg > a.avg ? b : a));
    const low = months.reduce((a, b) => (b.avg < a.avg ? b : a));
    return { peak, low, months: months.length };
  }, [future]);

  /* Congestion state forecast: how many exits are High at each hour ahead. */
  const congestion = useMemo(() => {
    if (!data || data.congestion.length === 0) return null;
    const exits = new Set(data.congestion.map((c) => c.segment)).size;
    const byHour = new Map<number, number>();
    for (const c of data.congestion) {
      if (String(c.state).toLowerCase() === "high") byHour.set(c.hours, (byHour.get(c.hours) ?? 0) + 1);
    }
    const at1 = byHour.get(1) ?? 0;
    let peakHour = 1;
    let peakCount = 0;
    for (const [h, n] of byHour) if (n > peakCount) { peakCount = n; peakHour = h; }
    return { exits, at1, peakHour, peakCount };
  }, [data]);

  /* Event surge per exit: where the extra vehicles land.
     Same arithmetic as the Event Surge card below, on purpose: keep exits whose
     `material` flag is not false, take surge minus baseline without clamping,
     and total over every kept row. A first draft clamped at zero and dropped
     non-positive rows, which put this tile at 27% against the card's 28% for
     the same exit. */
  const surge = useMemo(() => {
    if (!data || data.events.length === 0) return null;
    const rows = data.events
      .filter((e) => e.surge != null && e.material !== false)
      .map((e) => ({ exit: e.exit, extra: Number(e.surge) - Number(e.baseline), n: e.nEvents, event: e.event }))
      .sort((a, b) => b.extra - a.extra);
    if (rows.length === 0) return null;
    const total = rows.reduce((s, r) => s + r.extra, 0);
    if (total <= 0 || rows[0].extra <= 0) return null;
    return { top: rows[0], share: rows[0].extra / total, total, exits: rows.length };
  }, [data]);

  if (!data) return null;

  const champion = data.championModel ?? "champion model";
  const acc = extra.accuracy;
  const volumeFoot = acc && acc.wmape != null
    ? `${champion} · ${acc.wmape.toFixed(1)}% typical error at ${acc.hLo}–${acc.hHi} days ahead`
    : `${champion} forecast`;

  const peakHour = hourly?.hours.reduce<{ hour: number; predicted: number } | null>((a, h) => {
    if (h.predicted == null) return a;
    return !a || h.predicted > a.predicted ? { hour: h.hour, predicted: h.predicted } : a;
  }, null);
  const hourMax = hourly ? Math.max(...hourly.hours.map((h) => h.predicted ?? 0)) : 0;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 14 }}>
      {/* Row 1 output a: 24-hour next-day volume forecast */}
      <Tile
        eyebrow="Next 24 hours · volume"
        headline={hourly?.dayPredicted != null ? `${fmtInt(hourly.dayPredicted)} veh` : future[0] ? `${fmtInt(future[0].forecast)} veh` : "—"}
        sentence={
          hourly ? (
            <>
              <b>{hourly.weekday}, {new Date(`${hourly.date}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</b>
              {peakHour && <> — busiest hour <b>{fmtHour(peakHour.hour)}</b> at {fmtInt(peakHour.predicted)}</>}
            </>
          ) : "Loading the hourly profile…"
        }
        foot={hourly?.profileSource === "weekday-profile" ? `${volumeFoot} · hourly shape from the weekday profile` : volumeFoot}
      >
        {hourly && (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 34, marginTop: 4 }} aria-hidden="true">
            {hourly.hours.map((h) => (
              <span key={h.hour} title={`${fmtHour(h.hour)}: ${fmtInt(h.predicted ?? 0)}`} style={{
                flex: 1, borderRadius: 2,
                height: `${hourMax ? Math.max(6, ((h.predicted ?? 0) / hourMax) * 100) : 6}%`,
                background: peakHour && h.hour === peakHour.hour ? "var(--brand-accent)" : "color-mix(in srgb, var(--brand-primary) 55%, transparent)",
              }} />
            ))}
          </div>
        )}
      </Tile>

      {/* Row 1 output b: monthly seasonal peak prediction */}
      <Tile
        eyebrow="Seasonal peak · month"
        headline={seasonal ? monthName(seasonal.peak.ym) : "—"}
        sentence={
          seasonal ? (
            <>
              <b>{fmtInt(seasonal.peak.avg)}</b> vehicles/day on average
              {seasonal.months > 1 && seasonal.low.ym !== seasonal.peak.ym && (
                <>, {(((seasonal.peak.avg - seasonal.low.avg) / seasonal.low.avg) * 100).toFixed(1)}% above {monthName(seasonal.low.ym).split(" ")[0]}</>
              )}
            </>
          ) : "Not enough forecast days to compare months."
        }
        foot={`Busiest of the ${seasonal?.months ?? 0} month${seasonal?.months === 1 ? "" : "s"} in the ${future.length}-day ${champion} forecast`}
      />

      {/* Row 2 output: congestion state forecast */}
      <Tile
        eyebrow="Congestion · next 12 hours"
        headline={congestion ? `${congestion.at1} of ${congestion.exits} exits` : "—"}
        sentence={
          congestion ? (
            congestion.peakCount > congestion.at1
              ? <>High congestion in <b>1 hour</b>, rising to <b>{congestion.peakCount} of {congestion.exits}</b> by +{congestion.peakHour}h</>
              : <>High congestion in <b>1 hour</b>; the count does not rise later in the horizon</>
          ) : "No congestion forecast."
        }
        foot={
          extra.congestion?.accuracy != null
            ? `${extra.congestion.model} · ${(extra.congestion.accuracy * 100).toFixed(0)}% state accuracy` +
              (extra.congestion.baseline?.accuracy != null ? ` vs ${(extra.congestion.baseline.accuracy * 100).toFixed(0)}% ${extra.congestion.baseline.model.toLowerCase()}` : "")
            : "Congestion state model"
        }
      />

      {/* Row 3 output: event surge forecast per exit */}
      <Tile
        eyebrow="Event surge · per exit"
        headline={surge ? surge.top.exit : "—"}
        sentence={
          surge ? (
            <>takes <b>{(surge.share * 100).toFixed(0)}%</b> of the surge — <b>+{fmtInt(surge.top.extra)}</b> vehicles on a {surge.top.event.replace(/ event$/i, "")} day</>
          ) : "No event surge forecast."
        }
        foot={surge ? `${fmtInt(surge.total)} extra vehicles across ${surge.exits} exits · ${surge.top.n} events observed` : "Event surge model"}
      />
    </div>
  );
}
