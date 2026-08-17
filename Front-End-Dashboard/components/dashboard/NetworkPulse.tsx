"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Gauge, Leaf, Timer } from "lucide-react";
import { KpiSkeleton } from "./ChartSkeleton";

/**
 * The corridor's headline numbers, on the tab people land on.
 *
 * The Home tab previously opened with 500px of logo and no data at all, so the
 * first screen of a decision-intelligence dashboard answered nothing. These five
 * tiles come from /api/dashboard/overview, which composes the same services the
 * Traffic, Incidents and Sustainability tabs use — so a number here always
 * matches the tab a reader clicks into next.
 *
 * Every tile links to the tab that explains it. A summary figure with no route to
 * its detail is a dead end.
 */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type Overview = {
  range: { from: string; to: string };
  coverage: { minDate: string; maxDate: string };
  volume: { value: number; deltaPct: number | null };
  congestion: { value: number | null; deltaPoints: number | null };
  incidents: {
    value: number; deltaPct: number | null; injuries: number;
    fatalities: number; avgResponseMin: number | null;
  };
  emissions: { totalCo2T: number; deltaPct: number | null; avgAqi: number | null; avgPm25: number | null };
  highlights: {
    busiestPlaza: { name: string; sharePct: number | null } | null;
    peakWindow: { dow: number; hour: number; volume: number } | null;
    worstSegmentKm: number | null;
    plazaCount: number;
  };
};

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const fmtHour = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtCompact = (n: number) =>
  Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
const fmtDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });

/**
 * Whether a rise in this metric is good news.
 *
 * Direction is not the same as sentiment: more traffic is throughput, more
 * crashes is harm. Colouring every increase green would tell the reader the wrong
 * story twice over.
 */
type Sentiment = "neutral" | "goodWhenDown";

function DeltaChip({ pct, points, sentiment }: { pct?: number | null; points?: number | null; sentiment: Sentiment }) {
  const raw = pct ?? points;
  if (raw == null) return <span className="ds-pulse-delta muted">no prior period</span>;

  const flat = Math.abs(raw) < (points != null ? 0.05 : 0.5);
  if (flat) return <span className="ds-pulse-delta muted">▬ steady</span>;

  const up = raw > 0;
  const bad = sentiment === "goodWhenDown" ? up : false;
  const tone = sentiment === "neutral" ? "neutral" : bad ? "bad" : "good";
  const shown = points != null ? `${Math.abs(raw).toFixed(2)} pts` : `${Math.abs(raw).toFixed(1)}%`;

  return (
    <span className={`ds-pulse-delta ${tone}`}>
      {up ? "▲" : "▼"} {shown}
    </span>
  );
}

function Tile({
  icon, label, value, unit, delta, note, href, loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  unit?: string;
  delta?: React.ReactNode;
  note?: string;
  href: string;
  loading: boolean;
}) {
  return (
    <a className="ds-pulse-tile" href={href}>
      <span className="ds-pulse-icon">{icon}</span>
      <span className="ds-pulse-label">{label}</span>
      <span className="ds-pulse-value">
        {loading ? <KpiSkeleton /> : (
          <>
            {value ?? "—"}
            {unit && value && <em>{unit}</em>}
          </>
        )}
      </span>
      {!loading && <span className="ds-pulse-foot">{delta}</span>}
      {!loading && note && <span className="ds-pulse-note">{note}</span>}
    </a>
  );
}

export default function NetworkPulse() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND}/api/dashboard/overview`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setData(json.data);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <section className="ds-pulse">
        <p className="ds-pulse-error">
          Live figures unavailable — is the backend running on port 4000?
        </p>
      </section>
    );
  }

  const h = data?.highlights;

  return (
    <section className="ds-pulse" aria-label="Corridor summary">
      <header className="ds-pulse-head">
        <h2>Corridor at a glance</h2>
        {/* The window is stated because these are warehouse aggregates, not a
            live feed. Calling them "live" would be a claim the data cannot back. */}
        <p>
          {data
            ? `Analysis window ${fmtDate(data.range.from)} – ${fmtDate(data.range.to)} · warehouse holds ${fmtDate(data.coverage.minDate)} to ${fmtDate(data.coverage.maxDate)}`
            : "Loading corridor summary…"}
        </p>
      </header>

      <div className="ds-pulse-grid">
        <Tile
          loading={loading}
          href="/dashboard/traffic"
          icon={<Activity size={17} />}
          label="Average daily volume"
          value={data ? fmtCompact(data.volume.value) : null}
          unit="vehicles"
          delta={<DeltaChip pct={data?.volume.deltaPct} sentiment="neutral" />}
          note={h?.busiestPlaza ? `Heaviest at ${h.busiestPlaza.name}` : undefined}
        />
        <Tile
          loading={loading}
          href="/dashboard/traffic"
          icon={<Gauge size={17} />}
          label="Congestion index"
          value={data?.congestion.value != null ? data.congestion.value.toFixed(2) : null}
          delta={<DeltaChip points={data?.congestion.deltaPoints} sentiment="goodWhenDown" />}
          note={
            h?.peakWindow
              ? `Peaks ${DOW[h.peakWindow.dow]} at ${fmtHour(h.peakWindow.hour)}`
              : undefined
          }
        />
        <Tile
          loading={loading}
          href="/dashboard/incident"
          icon={<AlertTriangle size={17} />}
          label="Incidents logged"
          value={data ? fmtInt(data.incidents.value) : null}
          delta={<DeltaChip pct={data?.incidents.deltaPct} sentiment="goodWhenDown" />}
          note={
            data
              ? `${fmtInt(data.incidents.injuries)} injuries · ${fmtInt(data.incidents.fatalities)} fatalities`
              : undefined
          }
        />
        <Tile
          loading={loading}
          href="/dashboard/incident"
          icon={<Timer size={17} />}
          label="Average response"
          value={data?.incidents.avgResponseMin != null ? data.incidents.avgResponseMin.toFixed(1) : null}
          unit="min"
          delta={
            h?.worstSegmentKm != null
              ? <span className="ds-pulse-delta muted">Worst stretch Km {h.worstSegmentKm}</span>
              : undefined
          }
        />
        <Tile
          loading={loading}
          href="/dashboard/sustainability"
          icon={<Leaf size={17} />}
          label="Modelled CO₂"
          value={data ? fmtCompact(data.emissions.totalCo2T) : null}
          unit="tonnes"
          delta={<DeltaChip pct={data?.emissions.deltaPct} sentiment="goodWhenDown" />}
          note={
            data?.emissions.avgPm25 != null
              ? `PM2.5 averaging ${data.emissions.avgPm25.toFixed(1)} µg/m³`
              : undefined
          }
        />
      </div>
    </section>
  );
}
