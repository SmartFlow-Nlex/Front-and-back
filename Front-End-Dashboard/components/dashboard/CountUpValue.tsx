"use client";

import { useEffect, useRef, useState } from "react";

/* One run of digits, with optional thousands separators and decimals. */
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/**
 * A KPI value that counts up to itself once.
 *
 * The tiles used to snap from a skeleton straight to their final number, which
 * is correct and completely inert — five headline figures arriving in the same
 * frame as the cards behind them. Running the digits up draws the eye to the
 * number rather than the box it sits in, and it matches the live strip on the
 * home page so the two read as one system.
 *
 * Deliberately conservative about what it will animate:
 *
 *   - It runs ONCE, on first arrival. A figure that re-animates whenever the
 *     range changes is a figure nobody can read, and these tiles re-render on
 *     every filter.
 *   - It only animates a value holding exactly ONE number. "10.7 min" and
 *     "188.2K t" are fine; "Km 15–19" and "1.5 / 5" are left alone, because
 *     counting the first half of a range up while the second half sits still
 *     reads as a bug, not as motion.
 *   - Prefix, suffix, separators and decimal places are taken from the final
 *     string, so the tile never changes width or shape as it climbs.
 */
export default function CountUpValue({ text, duration = 850 }: { text: string; duration?: number }) {
  const matches = text.match(NUMBER);
  const single = matches?.length === 1 ? matches[0] : null;
  const target = single ? Number(single.replace(/,/g, "")) : null;

  const [shown, setShown] = useState<number | null>(null);
  const played = useRef(false);

  useEffect(() => {
    if (target == null || !Number.isFinite(target)) return;
    if (played.current) {
      setShown(target);
      return;
    }
    played.current = true;
    if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      // Ease-out cubic: most of the distance early, so it reads as settling
      // into place rather than as a slot machine.
      setShown(target * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(tick);
      else setShown(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  if (single == null || target == null || shown == null) return <>{text}</>;

  // Match the destination's own formatting so nothing reflows mid-count.
  const decimals = single.includes(".") ? single.split(".")[1].length : 0;
  const grouped = single.includes(",");
  const rendered = shown.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouped,
  });

  return <>{text.replace(single, rendered)}</>;
}
