"use client";

import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import TrafficMapPanel from "./TrafficMapPanel";
import MapLegend from "./MapLegend";
import ForecastHorizonPicker, { clockFor, type HorizonRangeKey } from "./ForecastHorizonPicker";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type Segment = {
  segment_id: string;
  corridor_segment: string;
  congestion_state: "Low" | "Med" | "High" | string;
  probability: number;
};

const STATE_ORDER: Record<string, number> = { High: 0, Med: 1, Low: 2 };

const STATE_LABEL: Record<string, string> = {
  High: "Heavy",
  Med: "Building",
  Low: "Clear",
};

/**
 * The Forecasted Traffic panel, full screen.
 *
 * It takes the page's own horizon state rather than keeping its own. That is
 * the whole point: expanding a map should show the same forecast at the same
 * hour, and changing the hour in either place should move both. Two copies of
 * the state would have been two maps that agreed only until someone touched
 * one of them.
 */
export default function ForecastExpandModal({
  open,
  onClose,
  horizon,
  setHorizon,
  range,
  setRange,
  maxHorizon,
  model,
}: {
  open: boolean;
  onClose: () => void;
  horizon: number;
  setHorizon: (h: number) => void;
  range: HorizonRangeKey;
  setRange: (r: HorizonRangeKey) => void;
  maxHorizon: number | null;
  model: { name: string | null; accuracy: number | null } | null;
}) {
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Same URL the map is drawing from, so the list beside it cannot disagree
  // with the colours on it.
  const endpoint = `${BACKEND}/api/map-comparison/forecast?hours=${horizon}`;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetch(endpoint, { cache: "no-store" })
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        const feats = Array.isArray(body?.features) ? body.features : [];
        setSegments(feats.map((f: { properties: Segment }) => f.properties));
      })
      .catch(() => {
        if (!cancelled) setSegments(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const ranked = [...(segments ?? [])].sort(
    (a, b) =>
      (STATE_ORDER[a.congestion_state] ?? 9) - (STATE_ORDER[b.congestion_state] ?? 9) ||
      b.probability - a.probability,
  );
  const counts = ranked.reduce<Record<string, number>>((acc, s) => {
    acc[s.congestion_state] = (acc[s.congestion_state] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div
      className="wz-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Forecasted traffic"
      onClick={onClose}
    >
      <div className="wz-shell fc-shell" onClick={(e) => e.stopPropagation()}>
        <header className="wz-head fc-head">
          <div className="wz-brand">
            <span className="fc-badge">Predicted</span>
            <div>
              <h2>Forecasted Traffic</h2>
              <p>
                {`+${horizon} h · around ${clockFor(horizon)}`}
                {model?.name ? ` · ${model.name}` : ""}
                {model?.accuracy != null ? ` · ${Math.round(model.accuracy * 100)}% accurate` : ""}
              </p>
            </div>
          </div>
          <div className="wz-head-right">
            <ForecastHorizonPicker
              horizon={horizon}
              setHorizon={setHorizon}
              range={range}
              setRange={setRange}
              maxHorizon={maxHorizon}
              compact
            />
            <button type="button" className="wz-btn wz-close" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="wz-body">
          <div className="wz-map">
            <TrafficMapPanel
              title="Forecasted Traffic"
              subtitle="Predictive analysis"
              chromeless
              endpoint={endpoint}
              layerColor="#a855f7"
              tone="purple"
            >
              <div className="wz-legend">
                <MapLegend variant="forecast" />
              </div>
            </TrafficMapPanel>
          </div>

          <aside className="wz-side">
            <h3 className="wz-side-title">
              Corridor at {clockFor(horizon)}
              {loading && <RefreshCw size={13} className="fc-spin" aria-hidden="true" />}
            </h3>

            {segments === null ? (
              <p className="wz-empty">
                Forecast unavailable — is the backend running on port 4000?
              </p>
            ) : ranked.length === 0 ? (
              <p className="wz-empty">
                Nothing forecast at +{horizon} h. The pipeline has not written this far ahead yet.
              </p>
            ) : (
              <>
                <div className="fc-tally">
                  {(["High", "Med", "Low"] as const).map((k) => (
                    <span key={k} className={`fc-tally-item is-${k.toLowerCase()}`}>
                      <b>{counts[k] ?? 0}</b>
                      {STATE_LABEL[k]}
                    </span>
                  ))}
                </div>

                {/* Ordered worst first: with twenty segments the question is
                    which ones need attention, not what the corridor is called
                    from south to north. */}
                <ul className="fc-list">
                  {ranked.map((s) => (
                    <li key={s.segment_id} className={`is-${s.congestion_state.toLowerCase()}`}>
                      <span className="fc-dot" aria-hidden="true" />
                      <span className="fc-name" title={s.corridor_segment}>
                        {s.segment_id}
                      </span>
                      <span className="fc-state">{STATE_LABEL[s.congestion_state] ?? s.congestion_state}</span>
                      <span className="fc-prob">{Math.round(s.probability * 100)}%</span>
                    </li>
                  ))}
                </ul>

                <p className="fc-note">
                  The percentage is the model&apos;s confidence in that state for that hour, not a
                  share of traffic.
                </p>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
