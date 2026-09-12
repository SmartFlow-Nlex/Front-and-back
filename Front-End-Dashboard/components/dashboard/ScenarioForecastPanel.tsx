"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The seam between the three predictive modules and the sandbox.
 *
 * Picking a forecast day loads what the traffic, incident and emission models
 * each expect for it, and seeds the simulation's arrival rate from the volume
 * champion's prediction — so a scenario runs against a predicted Saturday rather
 * than against a flat annual average.
 *
 * Deliberately compact. It sits above a simulation grid that is sized to the
 * viewport, so every row of height taken here is taken from the road the
 * operator is actually watching. The long explanation of what is and is not
 * seeded is behind a disclosure for the same reason.
 *
 * What it does NOT do is compare the simulation to the forecasts. The sim
 * reports CO2 in kg/min across a 280 m stretch; the emission model predicts
 * tonnes/day across the whole corridor. A delta between those would read as a
 * validated result while being arithmetic nonsense. The forecast is the
 * CONDITION the scenario starts from; the meaningful before/after is the
 * sandbox's own baseline against its own intervention.
 */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type Scenario = {
  date: string;
  availableDates: string[];
  volume: {
    dailyVehicles: number | null;
    segmentSharePct: number | null;
    segmentName: string | null;
    peakHourInflow: number | null;
    clamped: boolean;
    model: string | null;
    wmape: number | null;
  };
  incidents: {
    predictedForDate: number | null;
    model: string | null;
    byExit: { exitName: string; km: number; perDay: number }[];
    horizonDays: number;
  };
  emissions: { predictedTonnes: number | null; model: string | null; wmape: number | null };
  notes: string[];
};

const fmt = (n: number | null | undefined, dp = 0) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

export default function ScenarioForecastPanel({
  onApplyInflow,
  onHotspot,
}: {
  /** Hands the derived arrival rate, and the day it came from, to the page. */
  onApplyInflow: (vehPerHour: number, forecastDate: string) => void;
  /**
   * The exit the incident model rates most likely to need attention on the
   * chosen day. The sandbox opens there, so the forecast chooses the day and
   * the incident model chooses the place — which is what makes this a
   * prescriptive tool rather than a generic simulator.
   */
  onHotspot?: (exitName: string, km: number) => void;
}) {
  const [data, setData] = useState<Scenario | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const mounted = useRef(true);
  const reqId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const id = ++reqId.current;
    setBusy(true);
    setFailed(false);
    fetch(`${BACKEND}/api/ai-sandbox/scenario${date ? `?date=${date}` : ""}`)
      .then((r) => r.json())
      .then((j) => {
        if (!mounted.current || reqId.current !== id) return;
        if (j?.success) {
          const d = j.data as Scenario;
          setData(d);
          if (!date) setDate(d.date);
          const top = d.incidents.byExit[0];
          if (top && onHotspot) onHotspot(top.exitName, top.km);
        } else setFailed(true);
      })
      .catch(() => {
        if (mounted.current && reqId.current === id) setFailed(true);
      })
      .finally(() => {
        if (mounted.current && reqId.current === id) setBusy(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  if (failed && !data) return null;

  const v = data?.volume;
  const isApplied = applied != null && applied === data?.date;
  const canApply = v?.peakHourInflow != null && !busy && !isApplied;

  // The forecast horizon starts where observed data ends, so the dates on offer
  // sit in the past whenever ingestion has fallen behind. Saying so turns a
  // number that looks broken into a limitation the reader can weigh.
  const lastDay = data?.availableDates[data.availableDates.length - 1];

  return (
    <article className="sandbox-forecast">
      <div className="sandbox-forecast-head">
        <div className="sandbox-forecast-title">
          <h3>Simulate a Forecast Day</h3>
          <p>Starts the scenario from what the traffic, incident and emission models predict</p>
        </div>

        <select
          value={date ?? ""}
          onChange={(e) => {
            setDate(e.target.value);
            setApplied(null);
          }}
          disabled={!data}
          aria-label="Forecast day"
        >
          {(data?.availableDates ?? []).map((d) => (
            <option key={d} value={d}>
              {dayLabel(d)}
            </option>
          ))}
        </select>

        <button
          className={`sandbox-forecast-apply${isApplied ? " is-applied" : ""}`}
          onClick={() => {
            if (!data || v?.peakHourInflow == null) return;
            onApplyInflow(v.peakHourInflow, data.date);
            setApplied(data.date);
          }}
          disabled={!canApply}
        >
          {busy ? "Loading…" : isApplied ? "✓ Applied" : "Load into simulation"}
        </button>
      </div>

      {data && (
        <>
          <div className="sandbox-forecast-tiles">
            <Tile
              k="Corridor volume"
              v={`${fmt(v?.dailyVehicles)} veh`}
              s={`${v?.model ?? "—"}${v?.wmape != null ? ` · ${v.wmape.toFixed(1)}% WMAPE` : ""}`}
            />
            <Tile
              k="Segment inflow"
              v={`${fmt(v?.peakHourInflow)} veh/h`}
              s={
                v?.segmentName
                  ? `${v.segmentName} · ${v.segmentSharePct?.toFixed(1)}% of corridor`
                  : "peak hour"
              }
              accent
            />
            <Tile
              k="Predicted incidents"
              v={fmt(data.incidents.predictedForDate, 1)}
              s={`corridor-wide · ${data.incidents.model ?? "—"}`}
            />
            <Tile
              k="Predicted CO₂"
              v={`${fmt(data.emissions.predictedTonnes, 1)} t`}
              s={`${data.emissions.model ?? "—"}${
                data.emissions.wmape != null ? ` · ${data.emissions.wmape.toFixed(1)}% WMAPE` : ""
              }`}
            />
          </div>

          <div className="sandbox-forecast-foot">
            {data.incidents.byExit.length > 0 && (
              <span>
                <b>Highest risk:</b>{" "}
                {data.incidents.byExit
                  .slice(0, 3)
                  .map((e) => `${e.exitName} (${e.perDay.toFixed(1)}/day)`)
                  .join(", ")}
              </span>
            )}
            <button className="sandbox-forecast-help" onClick={() => setShowHelp((x) => !x)}>
              {showHelp ? "Hide detail" : "What gets loaded?"}
            </button>
          </div>

          {showHelp && (
            <div className="sandbox-forecast-foot" style={{ display: "block" }}>
              Only the <b>segment inflow</b> is loaded into the simulation. The incident and CO₂
              figures are the conditions forecast for that day — place incidents yourself to test a
              response. The simulation&apos;s own CO₂ rate covers one 280 m stretch and is not
              comparable to the corridor-wide tonnage.
              {lastDay && (
                <>
                  {" "}
                  Forecasts run from the end of observed data, which is why the horizon ends{" "}
                  {dayLabel(lastDay)}.
                </>
              )}
            </div>
          )}

          {data.notes.map((n, i) => (
            <p className="sandbox-forecast-note" key={i}>
              {n}
            </p>
          ))}
        </>
      )}
    </article>
  );
}

function Tile({ k, v, s, accent }: { k: string; v: string; s?: string; accent?: boolean }) {
  return (
    <div className={`sandbox-forecast-tile${accent ? " accent" : ""}`}>
      <div className="k">{k}</div>
      <div className="v" title={v}>
        {v}
      </div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}
