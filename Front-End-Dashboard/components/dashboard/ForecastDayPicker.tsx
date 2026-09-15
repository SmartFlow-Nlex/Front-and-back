"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import styles from "./ForecastDayPicker.module.css";

/**
 * Single-day picker for the sandbox's forecast day.
 *
 * Replaces a <select> that listed all ~90 forecast days in one scrolling list.
 * Only days the forecasts actually cover can be clicked, and month navigation
 * stops at the first and last covered month, so the reader cannot land on an
 * empty month.
 *
 * Days that also carry an incident forecast get a dot — the incident horizon
 * is shorter than the traffic/CO₂ one, and this is the one place the reader
 * chooses a day, so it is where that difference has to be visible.
 *
 * The popover is position: fixed, placed from the trigger's rectangle. The
 * sandbox page sizes its grid to the viewport, and an absolutely positioned
 * popover inside that layout could be clipped by an ancestor's overflow.
 */

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const POPOVER_W = 284;

type Parts = { y: number; m: number; d: number }; // m is 1-12

// Dates arrive as YYYY-MM-DD. Parsed by hand: new Date("YYYY-MM-DD") is read as
// UTC and can land on the previous day in the browser's local time.
const parse = (iso: string): Parts => {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
};
const pad = (n: number) => String(n).padStart(2, "0");
const toIso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const monthKey = (iso: string) => iso.slice(0, 7); // YYYY-MM

const longLabel = (iso: string) => {
  const { y, m, d } = parse(iso);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};
const shortLabel = (iso: string) => {
  const { y, m, d } = parse(iso);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const monthTitle = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
};

export default function ForecastDayPicker({
  value,
  dates,
  coverageEnd,
  onChange,
  disabled,
}: {
  /** Selected day, YYYY-MM-DD. */
  value: string | null;
  /** Every selectable day, YYYY-MM-DD. */
  dates: string[];
  /** Last day with an incident forecast; days up to it get a dot. */
  coverageEnd: string | null;
  onChange: (day: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => [...dates].sort(), [dates]);
  const available = useMemo(() => new Set(sorted), [sorted]);
  const months = useMemo(() => [...new Set(sorted.map(monthKey))], [sorted]);

  const [view, setView] = useState<string | null>(null);
  const viewKey = view ?? (value ? monthKey(value) : months[0] ?? null);
  const viewIdx = viewKey ? months.indexOf(viewKey) : -1;

  // Open on the selected day's month each time.
  useEffect(() => {
    if (open) setView(value ? monthKey(value) : months[0] ?? null);
  }, [open, value, months]);

  // Place the popover under the trigger, kept inside the viewport.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const place = () => {
      const r = triggerRef.current!.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.right - POPOVER_W, window.innerWidth - POPOVER_W - 8));
      setPos({ top: r.bottom + 6, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const cells: (string | null)[] = [];
  if (viewKey) {
    const [y, m] = viewKey.split("-").map(Number);
    const lead = new Date(y, m - 1, 1).getDay();
    const count = new Date(y, m, 0).getDate();
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= count; d++) cells.push(toIso(y, m, d));
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const hasPartial = coverageEnd != null && last != null && last > coverageEnd;

  return (
    <div className={styles.wrap}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ""}`}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || sorted.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Forecast day"
      >
        <Calendar size={14} aria-hidden />
        <span>{value ? longLabel(value) : "Pick a day"}</span>
        <ChevronDown size={14} aria-hidden className={styles.chev} />
      </button>

      {open && pos && viewKey && (
        <div
          ref={popRef}
          className={styles.popover}
          style={{ top: pos.top, left: pos.left, width: POPOVER_W }}
          role="dialog"
          aria-label="Choose a forecast day"
        >
          <div className={styles.header}>
            <button
              type="button"
              className={styles.nav}
              onClick={() => setView(months[viewIdx - 1])}
              disabled={viewIdx <= 0}
              aria-label="Previous month"
            >
              <ChevronLeft size={16} />
            </button>
            <span className={styles.title}>{monthTitle(viewKey)}</span>
            <button
              type="button"
              className={styles.nav}
              onClick={() => setView(months[viewIdx + 1])}
              disabled={viewIdx < 0 || viewIdx >= months.length - 1}
              aria-label="Next month"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <div className={styles.grid}>
            {WEEKDAYS.map((w) => (
              <div key={w} className={styles.weekday}>
                {w}
              </div>
            ))}
            {cells.map((iso, i) => {
              if (!iso) return <div key={`blank-${i}`} />;
              const enabled = available.has(iso);
              const selected = iso === value;
              const withIncidents = enabled && coverageEnd != null && iso <= coverageEnd;
              return (
                <button
                  key={iso}
                  type="button"
                  className={`${styles.day} ${selected ? styles.selected : ""}`}
                  disabled={!enabled}
                  aria-pressed={selected}
                  title={
                    enabled
                      ? `${longLabel(iso)} · ${withIncidents ? "traffic, incidents & CO₂" : "traffic & CO₂ only"}`
                      : "Not in the forecast"
                  }
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                >
                  {parse(iso).d}
                  {withIncidents && <span className={styles.dot} aria-hidden />}
                </button>
              );
            })}
          </div>

          <div className={styles.foot}>
            {hasPartial ? (
              <div className={styles.legend}>
                <span>
                  <span className={styles.dotInline} aria-hidden /> incidents, traffic &amp; CO₂ (to{" "}
                  {shortLabel(coverageEnd!)})
                </span>
                <span>no dot: traffic &amp; CO₂ only</span>
              </div>
            ) : null}
            {first && last && (
              <div className={styles.range}>
                Forecast days: {shortLabel(first)} – {longLabel(last).replace(/^\w+, /, "")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
