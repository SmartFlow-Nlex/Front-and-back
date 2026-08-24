"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../../app/dashboard/traffic/traffic.module.css";

/**
 * The dropdown used by the analytics hero filter rows.
 *
 * Lifted out of the Traffic page so Incidents and Emissions can carry the same
 * control rather than each growing a slightly different one. Styling comes from
 * the shared traffic module, which all three pages already import.
 */
export default function CustomSelect({ value, options, onChange }: { value: string; options: { label: string; value: string }[]; onChange: (val: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const clickOut = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", clickOut);
    return () => document.removeEventListener("mousedown", clickOut);
  }, [open]);

  const selectedLabel = options.find((o) => o.value === value)?.label || value;

  return (
    <div className={styles.customSelectWrap} ref={ref}>
      <button className={styles.customSelectBtn} onClick={() => setOpen(!open)} aria-expanded={open}>
        {selectedLabel}
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className={styles.customSelectMenu}>
          {options.map((o) => (
            <button
              key={o.value}
              className={`${styles.customSelectOption} ${value === o.value ? styles.customSelectOptionActive : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
              {value === o.value && (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ marginLeft: "auto", color: "var(--brand-primary)" }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
