"use client";

import React, { useState, useRef, useEffect } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import styles from "./DateRangePicker.module.css";

interface DateRangePickerProps {
  startDate: string;
  endDate: string;
  onChange: (start: string, end: string) => void;
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

export default function DateRangePicker({ startDate, endDate, onChange }: DateRangePickerProps) {
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
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  /**
   * A range needs two different days. Picking the same day twice used to submit
   * from === to, which every chart on the page then reads as a one-day window —
   * the trend collapses to a single point and the comparison against the
   * previous period has nothing to compare. The start day is disabled while the
   * end is being chosen, so it cannot be picked rather than being picked and
   * rejected.
   */
  const handleDayClick = (dayStr: string) => {
    if (!selStart || (selStart && selEnd)) {
      // Start a fresh selection.
      setSelStart(dayStr);
      setSelEnd(null);
      return;
    }
    if (dayStr === selStart) return; // guarded in the UI too; belt and braces
    if (dayStr < selStart) {
      onChange(dayStr, selStart);
    } else {
      onChange(selStart, dayStr);
    }
    setIsOpen(false);
  };

  /** True while the picker is waiting for the second click. */
  const awaitingEnd = Boolean(selStart && !selEnd);

  const todayStr = formatDate(new Date());

  const applyPreset = (days: number) => {
    const e = new Date();
    const s = new Date();
    s.setDate(e.getDate() - days);
    onChange(formatDate(s), formatDate(e));
    setIsOpen(false);
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
          <Calendar size={14} className={styles.triggerIcon} />
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

                let classes = styles.dayBtn;
                if (isStart) classes += ` ${styles.rangeStart}`;
                if (isEnd) classes += ` ${styles.rangeEnd}`;
                if (inRange) classes += ` ${styles.inRange}`;
                if (isSelected && !isStart && !isEnd) classes += ` ${styles.selected}`; // fallback

                const d = new Date(dayStr);
                // Same day as the start: not a range, so it is not selectable.
                const blocked = awaitingEnd && dayStr === selStart;
                if (dayStr === todayStr) classes += ` ${styles.today}`;
                return (
                  <button
                    key={dayStr}
                    className={classes}
                    disabled={blocked}
                    title={
                      blocked
                        ? "A range needs at least two days"
                        : awaitingEnd
                          ? "Set as end date"
                          : "Set as start date"
                    }
                    onClick={() => handleDayClick(dayStr)}
                    onMouseEnter={() => setHoverDate(dayStr)}
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

          {/* Which click this is. Without it the calendar gives no sign that the
              first click armed a selection, so a second click lands as a
              surprise. */}
          <p className={styles.hint}>
            {awaitingEnd
              ? `Start ${formatDisplay(selStart!)} — now pick the end date`
              : "Pick a start date"}
          </p>

          <div className={styles.presets}>
            <button className={styles.presetBtn} onClick={() => applyPreset(7)}>Last 7 days</button>
            <button className={styles.presetBtn} onClick={() => applyPreset(30)}>Last 30 days</button>
            <button className={styles.presetBtn} onClick={() => applyPreset(90)}>Last 90 days</button>
            <button className={styles.presetBtn} onClick={() => applyPreset(365)}>Last 12 months</button>
          </div>
        </div>
      )}
    </div>
  );
}
