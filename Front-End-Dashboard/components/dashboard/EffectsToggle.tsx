"use client";

import { Sparkles } from "lucide-react";
import { useEffectsOn } from "../../lib/effects";

/**
 * Turns the background effects on or off: the drifting clouds and sun glow behind every page, the grid lines,
 * the sign-in page's moving light and glints, and the floating assistant bubble. Off freezes the clouds and sun
 * glow and removes the rest; nothing that carries information (charts, live indicators, loading states) is affected.
 * One switch, in the same pill as the theme control. Not shown on the Live Map, which has no background.
 */
export default function EffectsToggle() {
  const [on, setOn] = useEffectsOn();
  return (
    <div className="ds-theme-toggle ds-effects-toggle">
      <button
        type="button"
        className={`ds-theme-option${on ? " active" : ""}`}
        aria-pressed={on}
        onClick={() => setOn(!on)}
        title={on ? "Background effects on (moving clouds, light and grid): click to freeze the background" : "Background effects off: click to bring back the moving clouds, light and grid"}
      >
        <Sparkles size={15} strokeWidth={2.2} aria-hidden="true" />
        <span className="ds-theme-option-label">Effects</span>
        <span className="ds-effects-state" aria-hidden="true">{on ? "On" : "Off"}</span>
      </button>
    </div>
  );
}
