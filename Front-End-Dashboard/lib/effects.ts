"use client";

import { useEffect, useState } from "react";

/**
 * The "background effects" preference: the drifting clouds and sun glow behind the dashboard, the editorial
 * grid lines, the sign-in page's moving light and glints, and the floating assistant bubble. On by default;
 * switched off the clouds and sun glow stay but freeze, and the rest goes. Charts, live indicators and loading
 * states are content, not effects.
 *
 * Kept in localStorage and mirrored on <html data-effects="off"> so CSS can
 * still or hide the decorative layers before first paint (the head script in
 * app/layout.tsx stamps it), and broadcast so every listener updates at once.
 */

export const EFFECTS_STORAGE_KEY = "smartflow-effects";
const EVENT = "smartflow-effects-change";

export function effectsOnNow(): boolean {
  try {
    return localStorage.getItem(EFFECTS_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setEffectsOn(on: boolean): void {
  try {
    localStorage.setItem(EFFECTS_STORAGE_KEY, on ? "on" : "off");
  } catch {
    /* storage blocked: the switch still works for this page view */
  }
  if (on) document.documentElement.removeAttribute("data-effects");
  else document.documentElement.setAttribute("data-effects", "off");
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
}

/** The current preference, kept in step across components and tabs. */
export function useEffectsOn(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const sync = () => setOn(document.documentElement.getAttribute("data-effects") !== "off" && effectsOnNow());
    sync();
    const onStorage = (e: StorageEvent) => {
      if (e.key !== EFFECTS_STORAGE_KEY) return;
      const next = e.newValue !== "off";
      if (next) document.documentElement.removeAttribute("data-effects");
      else document.documentElement.setAttribute("data-effects", "off");
      sync();
    };
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return [on, setEffectsOn];
}
