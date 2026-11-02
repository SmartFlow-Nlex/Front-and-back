"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronDown, Construction } from "lucide-react";
import { useChartTheme } from "../../lib/chart-theme";
import { mapPalette } from "../../lib/map-palette";
import { FALLBACK_EXITS, displayExitName } from "../../lib/nlex-exits";
import { nearExitsText } from "../../lib/exit-lookup";
import { lookOf } from "../../lib/waze-report-look";
import { KM_POST_END, KM_POST_START, fmtKm, fmtKmRange, kmMeasured } from "../../lib/km-post";
import { corridorKm } from "./corridor-km";
import { hoursFromNow } from "./ForecastHorizonPicker";
import type { CorridorSnapshot } from "./livemap-graphics";
import { fmtDelayShort, fmtDistance, levelWord } from "./livemap-graphics";
import type { Closure } from "./useActiveClosures";

type Dir = "NB" | "SB";
export type StripHover = { km: number; dir: Dir | null } | null;

/**
 * The compact key: the three road states plus no data, and the two finishes
 * (live solid, forecast hatched with a dashed edge). Swatches are the map's
 * own palette, so the key cannot describe a different map.
 */
export function LegendKey() {
  const { isDark } = useChartTheme();
  const P = mapPalette(isDark);
  const states: [string, string][] = [
    ["Clear", P.status.clear],
    ["Slow", P.status.slow],
    ["Congested", P.status.congested],
    ["No data", P.noData],
  ];
  return (
    <div className="lm-key">
      {states.map(([label, colour]) => (
        <span key={label} className="lm-key-item">
          <i className="lm-key-swatch" style={{ background: colour }} aria-hidden="true" />
          {label}
        </span>
      ))}
      <span className="lm-key-sep" aria-hidden="true" />
      <span className="lm-key-item">
        <i className="lm-key-finish is-live" style={{ background: P.status.clear }} aria-hidden="true" />
        Live
      </span>
      <span className="lm-key-item">
        <i className="lm-key-finish is-forecast" style={{ background: P.status.clear }} aria-hidden="true" />
        Forecast
      </span>
    </div>
  );
}

/**
 * The whole corridor in one line: Km 12 Balintawak on the left to Km 87
 * Sta. Ines on the right, northbound above southbound, coloured by the same
 * states the map draws for the selected time (Live or the forecast hour).
 * Queues are bars of their real length, reports and closures are icons, and
 * hovering it marks the same spot on the maps (and the maps mark it back).
 *
 * It draws only what the map was handed (see buildSnapshot) and the active
 * closures; a stretch with nothing to say is drawn in its no-data or base
 * state, never filled in.
 */
export default function CorridorStrip({
  snapshot,
  mode,
  setMode,
  horizon,
  closures,
  mapHover,
  onHover,
  open,
  setOpen,
  ageLabel,
  majorExits,
}: {
  snapshot: CorridorSnapshot | null;
  mode: "live" | "forecast";
  setMode: (m: "live" | "forecast") => void;
  horizon: number;
  closures: Closure[] | null;
  mapHover: StripHover;
  onHover: (h: { km: number; dir: Dir } | null) => void;
  open: boolean;
  setOpen: (o: boolean) => void;
  ageLabel: string | null;
  majorExits: Set<string>;
}) {
  const K = corridorKm();
  const span = K.kmEnd - K.kmStart;
  const pct = (km: number) => ((Math.max(K.kmStart, Math.min(K.kmEnd, km)) - K.kmStart) / span) * 100;
  const first = K.exits[0];
  const last = K.exits[K.exits.length - 1];

  /* Exit names that fit, major interchanges first, by the track's real width. */
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [trackW, setTrackW] = useState(900);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth || 900));
    ro.observe(el);
    setTrackW(el.clientWidth || 900);
    return () => ro.disconnect();
  }, [open]);
  const named = useMemo(() => {
    const items = K.exits.map((e, i) => ({
      i,
      name: displayExitName(e.name),
      x: (pct(e.km) / 100) * trackW,
      major: majorExits.has(e.name.toLowerCase().trim()),
    }));
    const order = [...items].sort((a, b) => Number(b.major) - Number(a.major) || a.i - b.i);
    const placed: { x0: number; x1: number }[] = [];
    const keep = new Set<number>();
    for (const it of order) {
      const w = it.name.length * 6.4 + 10;
      const x0 = Math.max(0, Math.min(trackW - w, it.x - w / 2));
      const box = { x0: x0 - 6, x1: x0 + w + 6 };
      if (placed.some((p) => p.x0 < box.x1 && box.x0 < p.x1)) continue;
      placed.push(box);
      keep.add(it.i);
    }
    return keep;
  }, [trackW, majorExits]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Keyboard: arrows walk the strip a kilometre at a time, Esc lets go. */
  const [kbd, setKbd] = useState<{ km: number; dir: Dir } | null>(null);
  const onKey = (dir: Dir) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Escape") return;
    e.preventDefault();
    if (e.key === "Escape") {
      setKbd(null);
      onHover(null);
      return;
    }
    const base = kbd && kbd.dir === dir ? kbd.km : K.kmStart;
    const km = Math.max(K.kmStart, Math.min(K.kmEnd, base + (e.key === "ArrowRight" ? 1 : -1)));
    setKbd({ km, dir });
    onHover({ km, dir });
  };

  const [own, setOwn] = useState<{ km: number; dir: Dir } | null>(null);
  const onMove = (dir: Dir) => (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const km = K.kmStart + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * span;
    setOwn({ km, dir });
    onHover({ km, dir });
  };

  const cursor = kbd ?? own ?? mapHover;
  const cursorExit = cursor
    ? K.exits.reduce((best, x) => (Math.abs(x.km - cursor.km) < Math.abs(best.km - cursor.km) ? x : best))
    : null;

  const live = mode === "live";
  const shown = snapshot && snapshot.kind === mode ? snapshot : null;

  const lane = (dir: Dir) => {
    const segs = shown?.segments.filter((s) => s.dir === dir) ?? [];
    const jams = shown?.jams.filter((j) => j.dir === dir) ?? [];
    const tails = shown?.tails.filter((t) => t.dir === dir) ?? [];
    const alerts = shown?.alerts.filter((a) => a.dir === dir || (a.dir == null && dir === "NB")) ?? [];
    const shut = (closures ?? []).filter((c) => c.direction === dir || c.direction === "Both");
    return (
      <div className="lm-lane" data-dir={dir}>
        <span className="lm-lane-tag" aria-hidden="true">
          {dir === "NB" ? "NB →" : "← SB"}
        </span>
        <div
          className="lm-lane-track"
          ref={dir === "NB" ? trackRef : undefined}
          tabIndex={0}
          role="group"
          aria-label={`${dir === "NB" ? "Northbound" : "Southbound"} lane. Left and right arrows move along the corridor.`}
          onMouseMove={onMove(dir)}
          onMouseLeave={() => {
            setOwn(null);
            onHover(null);
          }}
          onKeyDown={onKey(dir)}
          onBlur={() => {
            if (kbd) {
              setKbd(null);
              onHover(null);
            }
          }}
        >
          {!shown && <span className="lm-lane-empty">{snapshot ? "" : "Waiting for the map…"}</span>}
          {segs.map((s) => (
            <span
              key={`s${s.order}`}
              className={`lm-seg${s.order === 1 ? " is-first" : ""}${s.order === K.exits.length - 1 ? " is-last" : ""}`}
              data-level={live ? "clear" : levelWord(s.level)}
              style={{ left: `${pct(s.from)}%`, width: `${pct(s.to) - pct(s.from)}%` }}
              title={`${s.name}: ${live ? "no jam reported" : s.level < 0 ? "not forecast" : levelWord(s.level)}`}
            />
          ))}
          {tails.map((t, i) => (
            <span
              key={`t${i}`}
              className="lm-strip-tail"
              data-level={levelWord(t.level)}
              style={{ left: `${pct(t.from)}%`, width: `${pct(t.to) - pct(t.from)}%` }}
            />
          ))}
          {shut.map((c) => (
            <button
              key={c.id}
              type="button"
              className="lm-strip-closure"
              style={{
                left: `${pct(Math.min(c.start_km, c.end_km))}%`,
                width: `${pct(Math.max(c.start_km, c.end_km)) - pct(Math.min(c.start_km, c.end_km))}%`,
              }}
              title={`${c.title} · ${fmtKmRange(Math.min(c.start_km, c.end_km), Math.max(c.start_km, c.end_km))}, ${nearExitsText(FALLBACK_EXITS, Number(c.start_km), Number(c.end_km))} · ${c.lane_closure}`}
              aria-label={`Maintenance: ${c.title}, km ${fmtKm(Math.min(c.start_km, c.end_km))} to ${fmtKm(Math.max(c.start_km, c.end_km))}, ${nearExitsText(FALLBACK_EXITS, Number(c.start_km), Number(c.end_km))}. Show on the map.`}
              onClick={() => {
                const p = K.pointAtKm((Number(c.start_km) + Number(c.end_km)) / 2);
                window.dispatchEvent(new CustomEvent("nlex:flyto", { detail: { lng: p[0], lat: p[1], name: c.title } }));
              }}
            >
              <Construction size={11} aria-hidden="true" />
            </button>
          ))}
          {jams.map((j, i) => (
            <span
              key={`j${i}`}
              className="lm-strip-jam"
              data-level={levelWord(j.level)}
              style={{ left: `${pct(j.from)}%`, width: `${pct(j.to) - pct(j.from)}%` }}
              title={[
                j.predicted ? "Predicted" : null,
                levelWord(j.level),
                j.lengthM ? (j.predicted ? "~" : "") + fmtDistance(j.lengthM) : null,
                j.delayS && j.delayS > 0 ? (j.predicted ? "~" : "") + fmtDelayShort(j.delayS) : null,
                j.dir,
                j.where ? `near ${displayExitName(j.where)}` : null,
              ].filter(Boolean).join(" · ")}
            />
          ))}
          {alerts.map((a, i) => {
            const look = lookOf(a.type);
            const Icon = look.icon;
            return (
              <button
                key={`a${i}`}
                type="button"
                className={`lm-strip-alert${a.unconfirmed ? " is-unconfirmed" : ""}`}
                style={{ left: `${pct(a.km)}%`, ["--alert" as string]: look.colour }}
                title={`${look.label} · km ${fmtKm(a.km)}`}
                aria-label={`${look.label} at km ${fmtKm(a.km)}. Open the report.`}
                onClick={() => window.dispatchEvent(new CustomEvent("nlex:showreport", { detail: a.detail }))}
              >
                <Icon size={10} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <section className={`lm-strip${open ? "" : " is-collapsed"}`} aria-label="Corridor strip">
      <header className="lm-strip-head">
        <div className="lm-strip-title">
          <h2>Corridor</h2>
          <span className="lm-strip-span">
            Km {fmtKm(first.km)} {displayExitName(first.name)} → Km {fmtKm(last.km)} {displayExitName(last.name)}
          </span>
        </div>
        <div className="lm-strip-mode" role="group" aria-label="Strip shows">
          <button type="button" aria-pressed={live} className={live ? "is-on" : ""} onClick={() => setMode("live")}>
            Live
          </button>
          <button type="button" aria-pressed={!live} className={!live ? "is-on" : ""} onClick={() => setMode("forecast")}>
            Forecast +{horizon} h
          </button>
        </div>
        {ageLabel && <span className="lm-strip-age">{ageLabel}</span>}
        <div className="lm-strip-key">
          <LegendKey />
        </div>
        <button
          type="button"
          className="lm-strip-toggle"
          aria-expanded={open}
          aria-controls="lm-strip-body"
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide" : "Show"}
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </header>

      <div id="lm-strip-body" className="lm-strip-body" hidden={!open}>
        {/* The instrument: exit names over a single field (northbound lane,
            median, southbound lane) crossed by an exit grid, then a km ruler. */}
        <div className={`lm-instrument${live ? " is-live" : " is-forecast"}`}>
          <span className="lm-instrument-badge" aria-hidden="true">
            <i />
            {live ? "Live" : hoursFromNow(horizon) <= 0 ? "Now" : `+${hoursFromNow(horizon)} h`}
          </span>
          <div className="lm-strip-names" aria-hidden="true">
            {K.exits.map((e, i) =>
              named.has(i) ? (
                <span key={e.name} className="lm-strip-name" style={{ left: `${pct(e.km)}%` }}>
                  {displayExitName(e.name)}
                </span>
              ) : null,
            )}
          </div>
          <div className={`lm-strip-field lm-strip-lanes${live ? "" : " is-forecast"}`}>
            <div className="lm-strip-grid" aria-hidden="true">
              {K.exits.map((e, i) => (
                <span
                  key={e.name}
                  className={`lm-exit-tick${named.has(i) ? " is-named" : ""}`}
                  style={{ left: `${pct(e.km)}%` }}
                />
              ))}
            </div>
            {lane("NB")}
            <span className="lm-median" aria-hidden="true" />
            {lane("SB")}
            {cursor && (
              <span className="lm-strip-cursor" data-dir={cursor.dir ?? ""} style={{ left: `${pct(cursor.km)}%` }} aria-hidden="true">
                {cursorExit && (
                  <span className={`lm-strip-chip${pct(cursor.km) > 80 ? " is-flip" : ""}`}>
                    <b>Km {fmtKm(cursor.km)}</b>
                    {cursor.dir ?? ""} · near {displayExitName(cursorExit.name)}
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="lm-strip-ruler" aria-hidden="true">
            {/* Ticks sit on round official posts (every 5 from Km 15), drawn where
                that post really is on the measured track. */}
            {Array.from({ length: Math.floor((KM_POST_END - 15) / 5) + 1 }, (_, i) => 15 + i * 5).map((k) => (
              <span key={`m${k}`} className={`lm-ruler-tick${k % 10 === 0 ? " is-major" : ""}`} style={{ left: `${pct(kmMeasured(k))}%` }}>
                {k % 10 === 0 && k > KM_POST_START + 4 && k < KM_POST_END - 4 ? <em>{k}</em> : null}
              </span>
            ))}
            <span className="lm-ruler-end is-start">Km {fmtKm(first.km)}</span>
            <span className="lm-ruler-end is-end">Km {fmtKm(last.km)}</span>
          </div>
        </div>
        <p className="lm-strip-readout sr-only" aria-live="polite">
          {cursor && cursorExit
            ? `Km ${fmtKm(cursor.km)} · ${cursor.dir ?? ""} · near ${displayExitName(cursorExit.name)}`
            : " "}
        </p>
      </div>
    </section>
  );
}
