"use client";

import { useEffect, useRef } from "react";
import CloudLayer, { type Cloud } from "./CloudLayer";
import { useEffectsOn } from "../../lib/effects";

/**
 * The NLEX environment behind the whole app (7 Oct 2026, the user's brief).
 *
 * The scene is the user's own artwork: public/light_bg.png by day and
 * public/dark_bg.png at night (served as the WebP copies beside them), an
 * expressway curving in from the bottom right under an elevated road and a
 * skyline. Over it drift three depths of clouds at their own speeds, with a
 * soft light that slowly moves, and a veil that keeps text readable.
 *
 *   sky colour -> background art -> sun haze -> far clouds -> mid clouds ->
 *   near clouds -> readability veil
 *
 * Only the clouds (and the soft light) move, as CSS transform and opacity; the
 * art itself stays put and does not follow the pointer (user request). The
 * same scene, at the same strength, sits behind every page, tab and sub-tab,
 * the Live Map included; `scene` marks the Overview ("hero") for styling
 * hooks. Reduced motion and the Effects switch hold everything still.
 * Decorative only: aria-hidden, no pointer events.
 * The sign-in page has its own stage: components/login/LoginStage.tsx.
 */

type Scene = "hero" | "page";

/* Cloud placements per depth, as screen percentages (x + w <= 100 so the loop is seamless). */
const FAR: Cloud[] = [
  { src: "e", x: 4, y: 30, w: 13, opacity: 0.75 },
  { src: "c", x: 30, y: 26, w: 15, opacity: 0.7 },
  { src: "e", x: 58, y: 22, w: 12, opacity: 0.7, flip: true },
  { src: "b", x: 78, y: 27, w: 16, opacity: 0.6 },
];
const MID: Cloud[] = [
  { src: "b", x: 2, y: 9, w: 24, opacity: 0.9 },
  { src: "c", x: 38, y: 4, w: 19, opacity: 0.85, flip: true },
  { src: "a", x: 66, y: 12, w: 30, opacity: 0.92 },
];
const NEAR: Cloud[] = [
  { src: "d", x: 0, y: -8, w: 38, opacity: 0.95 },
  { src: "a", x: 66, y: 0, sink: 52, w: 34, opacity: 0.95, flip: true },
  { src: "b", x: 6, y: 0, sink: 45, w: 30, opacity: 0.9 },
];

export default function NlexEnvironment({ scene }: { scene: Scene }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [effects] = useEffectsOn();

  // Motion on or off: reduced motion and the Effects switch both hold it still.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      root.dataset.motion = effects && !mq.matches ? "on" : "off";
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [effects]);

  return (
    <div ref={rootRef} className="nlex-env" data-scene={scene} data-motion="on" aria-hidden="true">
      <div className="env-layer env-bg" />
      <div className="env-layer env-sun" />
      <CloudLayer clouds={FAR} depth="far" />
      <CloudLayer clouds={MID} depth="mid" />
      <CloudLayer clouds={NEAR} depth="near" />
      <div className="env-layer env-veil" />
    </div>
  );
}
