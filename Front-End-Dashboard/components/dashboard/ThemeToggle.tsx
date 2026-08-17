"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemeChoice } from "../../lib/theme";

/**
 * Three-way theme control: Light / Dark / System.
 *
 * A segmented control rather than a single toggle button, because a two-state
 * toggle cannot express "follow my operating system" — which is the setting that
 * actually serves eye comfort, since it picks up an OS night schedule.
 */

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

export default function ThemeToggle() {
  const { choice, resolved, setChoice } = useTheme();

  return (
    <div
      className="ds-theme-toggle"
      role="radiogroup"
      aria-label={`Colour theme — currently ${choice}${choice === "system" ? ` (${resolved})` : ""}`}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = choice === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            className={`ds-theme-option ${active ? "active" : ""}`}
            onClick={() => setChoice(value)}
            title={value === "system" ? `Follow system (${resolved})` : label}
          >
            <Icon size={15} strokeWidth={2.2} aria-hidden="true" />
            <span className="ds-theme-option-label">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
