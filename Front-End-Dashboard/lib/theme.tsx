"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * Theme handling for the dashboard.
 *
 * Three settings, not two. "system" is the default and follows the operating
 * system, which matters for eye comfort: a user who has scheduled their OS to go
 * dark at night gets the same behaviour here without touching a setting.
 * Choosing Light or Dark explicitly overrides the OS in either direction.
 *
 * The choice is written to <html data-theme> and to localStorage. It is applied
 * before paint by the inline script in layout.tsx, so the page never flashes the
 * wrong theme on load.
 */

export type ThemeChoice = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "smartflow-theme";

type ThemeContextValue = {
  /** What the user picked. */
  choice: ThemeChoice;
  /** What is actually on screen once "system" is resolved. */
  resolved: "light" | "dark";
  setChoice: (c: ThemeChoice) => void;
  /** Cycles light -> dark -> system. */
  cycle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Writes the attribute the CSS keys off. "system" removes it so the media query wins. */
function applyChoice(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  // Lets the browser theme form controls and scrollbars to match.
  root.style.colorScheme =
    choice === "system" ? "light dark" : choice;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Starts as "system" and is corrected in the effect below. The inline script
  // has already set the attribute, so this initial value never causes a flash.
  const [choice, setChoiceState] = useState<ThemeChoice>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");

  // Read the stored choice once mounted.
  useEffect(() => {
    let stored: ThemeChoice = "system";
    try {
      const raw = localStorage.getItem(THEME_STORAGE_KEY);
      if (raw === "light" || raw === "dark" || raw === "system") stored = raw;
    } catch {
      /* private mode: fall back to system */
    }
    setChoiceState(stored);
    applyChoice(stored);
    setResolved(stored === "system" ? (systemPrefersDark() ? "dark" : "light") : stored);
  }, []);

  // Follow the OS while the choice is "system".
  useEffect(() => {
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceState(c);
    applyChoice(c);
    setResolved(c === "system" ? (systemPrefersDark() ? "dark" : "light") : c);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, c);
    } catch {
      /* ignore */
    }
    // Charts read their colours from CSS variables at build time, so they need
    // to be told to rebuild after a theme change.
    window.dispatchEvent(new CustomEvent("smartflow:themechange"));
  }, []);

  const cycle = useCallback(() => {
    setChoice(choice === "light" ? "dark" : choice === "dark" ? "system" : "light");
  }, [choice, setChoice]);

  return (
    <ThemeContext.Provider value={{ choice, resolved, setChoice, cycle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Keeps a stray consumer from crashing the page outside the provider.
    return { choice: "system", resolved: "light", setChoice: () => {}, cycle: () => {} };
  }
  return ctx;
}

/**
 * Runs before first paint to stamp the stored theme, preventing the light
 * palette from flashing for a frame on a dark-theme reload. Kept deliberately
 * small and dependency-free because it is inlined into the document head.
 */
export const THEME_INIT_SCRIPT = `(function(){try{
var c=localStorage.getItem('${THEME_STORAGE_KEY}');
var d=document.documentElement;
if(c==='light'||c==='dark'){d.setAttribute('data-theme',c);d.style.colorScheme=c;}
else{d.style.colorScheme='light dark';}
}catch(e){}})();`;
