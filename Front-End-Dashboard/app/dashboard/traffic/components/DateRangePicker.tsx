"use client";

import React, { useState, useRef, useEffect } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import styles from "./DateRangePicker.module.css";

interface DateRangePickerProps {
  startDate: string;
  endDate: string;
  onChange: (start: string, end: string) => void;
  /* The span the warehouse actually holds, as YYYY-MM-DD.
     Every caller already passed these from data.meta, and the component
     declared neither, so all three dashboards failed to typecheck and the
     bounds were dropped on the floor at runtime -- days with no data behind
     them were selectable. The stylesheet has carried a .dayBtn.disabled rule
     the whole time, so the state was designed and just never wired up. */
  minDate?: string;
  maxDate?: string;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

// YYYY-MM-DD
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export default function DateRangePicker({ startDate, endDate, onChange, minDate, maxDate }: DateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse initial or default to current month
  const initialDate = startDate ? new Date(startDate) : new Date();
  const [currentMonth, setCurrentMonth] = useState(initialDate.getMonth());
  const [currentYear, setCurrentYear] = useState(initialDate.getFullYear());

  // Local selection state (allows selecting start then end)
  const [selStart, setSelStart] = useState<string | null>(startDate || null);
  const [selEnd, setSelEnd] = useState<string | null>(endDate || null);
  const [hoverDate, setHoverDate] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<"days" | "months" | "years">("days");

  // Update local state if props change externally
  useEffect(() => {
    setSelStart(startDate);
    setSelEnd(endDate);
  }, [startDate, endDate]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  /* String compare is safe and exact here: every date in this component is
     zero-padded YYYY-MM-DD, which sorts lexicographically the same way it
     sorts chronologically. */
  const outOfRange = (day: string) =>
    (minDate != null && day < minDate) || (maxDate != null && day > maxDate);

  const handleDayClick = (dayStr: string) => {
    if (outOfRange(dayStr)) return;
    if (!selStart || (selStart && selEnd)) {
      // Start new selection
      setSelStart(dayStr);
      setSelEnd(null);
    } else {
      // Complete selection
      if (dayStr < selStart) {
        onChange(dayStr, selStart);
      } else {
        onChange(selStart, dayStr);
      }
      setIsOpen(false); // Auto-close on complete selection
    }
  };

  const nextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear((y) => y + 1);
    } else {
      setCurrentMonth((m) => m + 1);
    }
  };

  const prevMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear((y) => y - 1);
    } else {
      setCurrentMonth((m) => m - 1);
    }
  };

  // Build calendar days
  const firstDayOfMonth = new Date(currentYear, currentMonth, 1).getDay();
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

  const days = [];
  // Empty slots for previous month
  for (let i = 0; i < firstDayOfMonth; i++) {
    days.push(null);
  }
  // Days of current month
  for (let i = 1; i <= daysInMonth; i++) {
    const d = new Date(currentYear, currentMonth, i);
    days.push(formatDate(d));
  }

  const formatDisplay = (ds: string) => {
    if (!ds) return "mm/dd/yyyy";
    const [y, m, d] = ds.split("-");
    return `${m}/${d}/${y}`;
  };

  return (
    <div className={styles.pickerContainer} ref={containerRef}>
      <button
        className={`${styles.triggerBtn} ${isOpen ? styles.active : ""}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className={styles.dateBlock}>
          <Calendar size={14} color="#64748b" />
          <span>{formatDisplay(startDate)}</span>
        </div>
        <span className={styles.dash}>—</span>
        <div className={styles.dateBlock}>
          <span>{formatDisplay(endDate)}</span>
        </div>
      </button>

      {isOpen && (
        <div className={styles.popover}>
          <div className={styles.header}>
            <button className={styles.navBtn} onClick={viewMode === "years" ? () => setCurrentYear(y => y - 10) : prevMonth}>
              <ChevronLeft size={16} />
            </button>
            <div className={styles.headerMiddle}>
              <button
                className={styles.monthYearBtn}
                onClick={() => setViewMode(viewMode === "months" ? "days" : "months")}
              >
                {MONTHS[currentMonth]}
              </button>
              <button
                className={styles.monthYearBtn}
                onClick={() => setViewMode(viewMode === "years" ? "days" : "years")}
              >
                {currentYear}
              </button>
            </div>
            <button className={styles.navBtn} onClick={viewMode === "years" ? () => setCurrentYear(y => y + 10) : nextMonth}>
              <ChevronRight size={16} />
            </button>
          </div>

          {viewMode === "days" && (
            <div className={styles.daysGrid}>
              {WEEKDAYS.map((wd) => (
                <div key={wd} className={styles.weekday}>{wd}</div>
              ))}
              {days.map((dayStr, i) => {
                if (!dayStr) return <div key={`empty-${i}`} />;

                const isStart = dayStr === selStart;
                const isEnd = dayStr === selEnd;
                const isSelected = isStart || isEnd;

                let inRange = false;
                if (selStart && selEnd && dayStr > selStart && dayStr < selEnd) {
                  inRange = true;
                } else if (selStart && !selEnd && hoverDate && dayStr > selStart && dayStr <= hoverDate) {
                  inRange = true; // Preview range
                } else if (selStart && !selEnd && hoverDate && dayStr < selStart && dayStr >= hoverDate) {
                  inRange = true; // Preview range (backwards)
                }

                const disabled = outOfRange(dayStr);

                let classes = styles.dayBtn;
                if (disabled) classes += ` ${styles.disabled}`;
                if (isStart) classes += ` ${styles.rangeStart}`;
                if (isEnd) classes += ` ${styles.rangeEnd}`;
                if (inRange) classes += ` ${styles.inRange}`;
                if (isSelected && !isStart && !isEnd) classes += ` ${styles.selected}`; // fallback

                const d = new Date(dayStr);
                return (
                  <button
                    key={dayStr}
                    className={classes}
                    disabled={disabled}
                    aria-disabled={disabled}
                    onClick={() => handleDayClick(dayStr)}
                    // A disabled day must not drive the hover preview either,
                    // or dragging across it paints a range that cannot be
                    // selected.
                    onMouseEnter={() => !disabled && setHoverDate(dayStr)}
                    onMouseLeave={() => setHoverDate(null)}
                  >
                    {d.getDate()}
                  </button>
                );
              })}
            </div>
          )}

          {viewMode === "months" && (
            <div className={styles.monthsGrid}>
              {MONTHS.map((m, i) => (
                <button
                  key={m}
                  className={`${styles.gridItemBtn} ${currentMonth === i ? styles.selected : ""}`}
                  onClick={() => { setCurrentMonth(i); setViewMode("days"); }}
                >
                  {m.substring(0, 3)}
                </button>
              ))}
            </div>
          )}

          {viewMode === "years" && (
            <div className={styles.yearsGrid}>
              {Array.from({ length: 12 }).map((_, i) => {
                const y = Math.floor(currentYear / 10) * 10 - 1 + i;
                return (
                  <button
                    key={y}
                    className={`${styles.gridItemBtn} ${currentYear === y ? styles.selected : ""}`}
                    onClick={() => { setCurrentYear(y); setViewMode("days"); }}
                  >
                    {y}
                  </button>
                );
              })}
            </div>
          )}

          {/* Counted back from the newest day the data holds, not from today.
              The warehouse currently ends 2025-12-31 while the clock reads
              2026, so both presets were selecting a window that is entirely
              in the future of the data and returning an empty chart. They
              fall back to today only when no bound was supplied. */}
          <div className={styles.presets}>
            {[7, 30].map((n) => (
              <button
                key={n}
                className={styles.presetBtn}
                onClick={() => {
                  const end = maxDate ? new Date(maxDate) : new Date();
                  const start = new Date(end);
                  start.setDate(end.getDate() - (n - 1));
                  const lo = formatDate(start);
                  onChange(minDate && lo < minDate ? minDate : lo, formatDate(end));
                  setIsOpen(false);
                }}
              >
                Last {n} days
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
