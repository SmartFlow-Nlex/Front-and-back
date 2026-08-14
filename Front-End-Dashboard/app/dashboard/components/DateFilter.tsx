"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */
type Preset = "all" | "7d" | "30d" | "3m" | "6m" | "1y" | "custom";

const PRESETS: { value: Preset; label: string }[] = [
  { value: "all", label: "All" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "3m", label: "Last 3 Months" },
  { value: "6m", label: "Last 6 Months" },
  { value: "1y", label: "Last Year" },
  { value: "custom", label: "Custom Range" },
];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const DAY_HEADERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const MIN_YEAR = 2017;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function firstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

function isSameDay(a: Date | null, b: Date | null) {
  if (!a || !b) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isBetween(d: Date, start: Date | null, end: Date | null) {
  if (!start || !end) return false;
  const t = d.getTime();
  return t > start.getTime() && t < end.getTime();
}

function formatLabel(preset: Preset, from: Date | null, to: Date | null): string {
  if (preset === "custom" && from && to) {
    const fmt = (d: Date) =>
      `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    return `${fmt(from)} – ${fmt(to)}`;
  }
  return PRESETS.find((p) => p.value === preset)?.label ?? "All";
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */
export default function DateFilter() {
  const [selected, setSelected] = useState<Preset>("all");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);

  // Custom range state
  const [fromDate, setFromDate] = useState<Date | null>(null);
  const [toDate, setToDate] = useState<Date | null>(null);

  // Calendar navigation – two independent panels
  const now = new Date();
  const maxYear = now.getFullYear();
  const [leftMonth, setLeftMonth] = useState(now.getMonth());
  const [leftYear, setLeftYear] = useState(now.getFullYear());

  // Right panel has its own independent state
  const nextM = now.getMonth() === 11 ? 0 : now.getMonth() + 1;
  const nextY = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const [rightMonth, setRightMonth] = useState(nextM);
  const [rightYear, setRightYear] = useState(nextY);

  // Picking state
  const [pickFrom, setPickFrom] = useState<Date | null>(null);
  const [pickTo, setPickTo] = useState<Date | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [dropdownOpen]);

  const handlePresetClick = useCallback(
    (preset: Preset) => {
      if (preset === "custom") {
        setDropdownOpen(false);
        setPickFrom(fromDate);
        setPickTo(toDate);
        // Reset calendar to current month
        setLeftMonth(now.getMonth());
        setLeftYear(now.getFullYear());
        const nm = now.getMonth() === 11 ? 0 : now.getMonth() + 1;
        const ny = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
        setRightMonth(nm);
        setRightYear(ny);
        setCalendarOpen(true);
      } else {
        setSelected(preset);
        setFromDate(null);
        setToDate(null);
        setDropdownOpen(false);
      }
    },
    [fromDate, toDate, now]
  );

  const toggleDropdown = useCallback(() => {
    setDropdownOpen((p) => !p);
  }, []);

  /* ---- Calendar navigation ---- */
  const goLeftPrev = useCallback(() => {
    setLeftMonth((m) => {
      if (m === 0) {
        setLeftYear((y) => Math.max(MIN_YEAR, y - 1));
        return 11;
      }
      return m - 1;
    });
  }, []);

  const goRightNext = useCallback(() => {
    setRightMonth((m) => {
      if (m === 11) {
        setRightYear((y) => Math.min(maxYear + 1, y + 1));
        return 0;
      }
      return m + 1;
    });
  }, [maxYear]);

  const handleLeftMonthChange = useCallback((val: number) => {
    setLeftMonth(val);
  }, []);

  const handleLeftYearChange = useCallback((val: number) => {
    setLeftYear(val);
  }, []);

  const handleRightMonthChange = useCallback((val: number) => {
    setRightMonth(val);
  }, []);

  const handleRightYearChange = useCallback((val: number) => {
    setRightYear(val);
  }, []);

  /* ---- Day picking logic ---- */
  const handleDayClick = useCallback(
    (day: Date) => {
      if (!pickFrom || (pickFrom && pickTo)) {
        // Start fresh selection
        setPickFrom(day);
        setPickTo(null);
      } else {
        // We have a from but no to
        if (day.getTime() < pickFrom.getTime()) {
          setPickTo(pickFrom);
          setPickFrom(day);
        } else {
          setPickTo(day);
        }
      }
    },
    [pickFrom, pickTo]
  );

  const applyRange = useCallback(() => {
    if (pickFrom && pickTo) {
      setFromDate(pickFrom);
      setToDate(pickTo);
      setSelected("custom");
      setCalendarOpen(false);
    }
  }, [pickFrom, pickTo]);

  const cancelCalendar = useCallback(() => {
    setCalendarOpen(false);
  }, []);

  /* ---- Year options ---- */
  const yearOptions = useMemo(() => {
    const years: number[] = [];
    for (let y = MIN_YEAR; y <= maxYear; y++) years.push(y);
    return years;
  }, [maxYear]);

  /* ---- Button label ---- */
  const label = formatLabel(selected, fromDate, toDate);

  /* ---- Render calendar grid ---- */
  const renderMonth = (year: number, month: number) => {
    const days = daysInMonth(year, month);
    const offset = firstDayOfMonth(year, month);
    const cells: React.ReactNode[] = [];

    // Empty leading cells
    for (let i = 0; i < offset; i++) {
      cells.push(<div key={`e${i}`} className="df-cal-cell df-cal-empty" />);
    }

    for (let d = 1; d <= days; d++) {
      const dt = new Date(year, month, d);
      const isFrom = isSameDay(dt, pickFrom);
      const isTo = isSameDay(dt, pickTo);
      const isInRange = isBetween(dt, pickFrom, pickTo);
      const isToday = isSameDay(dt, now);

      let cls = "df-cal-cell df-cal-day";
      if (isFrom || isTo) cls += " df-cal-selected";
      if (isInRange) cls += " df-cal-in-range";
      if (isToday && !isFrom && !isTo) cls += " df-cal-today";

      cells.push(
        <button
          key={d}
          type="button"
          className={cls}
          onClick={() => handleDayClick(dt)}
        >
          {d}
        </button>
      );
    }

    return cells;
  };

  const fromLabel = pickFrom
    ? `${MONTH_SHORT[pickFrom.getMonth()]} ${pickFrom.getDate()}, ${pickFrom.getFullYear()}`
    : "Select start date";
  const toLabel = pickTo
    ? `${MONTH_SHORT[pickTo.getMonth()]} ${pickTo.getDate()}, ${pickTo.getFullYear()}`
    : "Select end date";

  return (
    <>
      {/* ---- Trigger Button ---- */}
      <button
        ref={buttonRef}
        type="button"
        className="ds-date-filter"
        onClick={toggleDropdown}
        aria-haspopup="listbox"
        aria-expanded={dropdownOpen}
      >
        <Calendar size={14} strokeWidth={2.5} />
        <span>{label}</span>
        <ChevronDown size={14} strokeWidth={2.5} className={`df-chevron ${dropdownOpen ? "df-chevron-open" : ""}`} />
      </button>

      {/* ---- Dropdown Menu ---- */}
      {dropdownOpen && (
        <div ref={dropdownRef} className="df-dropdown">
          {PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              className={`df-dropdown-item ${selected === p.value ? "df-dropdown-active" : ""}`}
              onClick={() => handlePresetClick(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* ---- Calendar Modal ---- */}
      {calendarOpen && (
        <div className="df-cal-backdrop" onClick={cancelCalendar}>
          <div className="df-cal-modal" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="df-cal-header">
              <div className="df-cal-header-labels">
                <span>
                  From: <strong>{fromLabel}</strong>
                </span>
                <span>
                  To: <strong>{toLabel}</strong>
                </span>
              </div>
              <button
                type="button"
                className="df-cal-close"
                onClick={cancelCalendar}
                aria-label="Close calendar"
              >
                <X size={18} strokeWidth={2.5} />
              </button>
            </div>

            {/* Calendar Body */}
            <div className="df-cal-body">
              {/* Left Month */}
              <div className="df-cal-panel">
                <div className="df-cal-nav">
                  <button type="button" className="df-cal-arrow" onClick={goLeftPrev} aria-label="Previous month">
                    <ChevronLeft size={16} strokeWidth={2.5} />
                  </button>
                  <div className="df-cal-selectors">
                    <select
                      value={leftMonth}
                      onChange={(e) => handleLeftMonthChange(Number(e.target.value))}
                      className="df-cal-select"
                    >
                      {MONTH_SHORT.map((m, i) => (
                        <option key={i} value={i}>{m}</option>
                      ))}
                    </select>
                    <select
                      value={leftYear}
                      onChange={(e) => handleLeftYearChange(Number(e.target.value))}
                      className="df-cal-select"
                    >
                      {yearOptions.map((y) => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="df-cal-grid">
                  {DAY_HEADERS.map((d) => (
                    <div key={d} className="df-cal-cell df-cal-head">{d}</div>
                  ))}
                  {renderMonth(leftYear, leftMonth)}
                </div>
              </div>

              {/* Right Month */}
              <div className="df-cal-panel">
                <div className="df-cal-nav">
                  <div /> {/* spacer */}
                  <div className="df-cal-selectors">
                    <select
                      value={rightMonth}
                      onChange={(e) => handleRightMonthChange(Number(e.target.value))}
                      className="df-cal-select"
                    >
                      {MONTH_SHORT.map((m, i) => (
                        <option key={i} value={i}>{m}</option>
                      ))}
                    </select>
                    <select
                      value={rightYear}
                      onChange={(e) => handleRightYearChange(Number(e.target.value))}
                      className="df-cal-select"
                    >
                      {yearOptions.map((y) => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                  </div>
                  <button type="button" className="df-cal-arrow" onClick={goRightNext} aria-label="Next month">
                    <ChevronRight size={16} strokeWidth={2.5} />
                  </button>
                </div>

                <div className="df-cal-grid">
                  {DAY_HEADERS.map((d) => (
                    <div key={d} className="df-cal-cell df-cal-head">{d}</div>
                  ))}
                  {renderMonth(rightYear, rightMonth)}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="df-cal-footer">
              <button type="button" className="df-cal-btn df-cal-btn-cancel" onClick={cancelCalendar}>
                Cancel
              </button>
              <button
                type="button"
                className="df-cal-btn df-cal-btn-apply"
                disabled={!pickFrom || !pickTo}
                onClick={applyRange}
              >
                Apply Range
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
