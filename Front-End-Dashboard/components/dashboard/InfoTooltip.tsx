"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

// The "i" icon beside a card title (or KPI tile) and its hover/focus popup —
// one shared implementation so every one of these looks and behaves
// identically, instead of five hand-copied native `title` attributes that
// inherit the browser's own (unstylable, plain) tooltip box.
//
// Portal + fixed-position tracking is ported from IncidentNarrative.tsx's
// MetricHint, for the same reason that component needed it: several of
// these cards sit inside a horizontally-scrollable container (`overflow-x:
// auto` also computes overflow-y as "auto", per the CSS spec — a same-
// element visible/non-visible mix isn't allowed), which clips a normally
// absolutely-positioned tooltip before it ever reaches the page. Rendering
// into document.body via a portal, positioned in viewport (`fixed`)
// coordinates measured from the trigger, escapes that entirely.
//
// The popup is centred on the icon, but an icon close to a screen edge (a label
// at the left of a narrow, stacked layout) would push half of it off-screen. So
// the centre is clamped to keep the box inside the viewport, and `arrow` records
// how far that moved it so the pointer still lands on the icon.
const TIP_MAX_W = 300;
const TIP_EDGE = 8;

export default function InfoTooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; arrow: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  const measure = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const center = rect.left + rect.width / 2;
    const half = Math.min(TIP_MAX_W, window.innerWidth - TIP_EDGE * 2) / 2;
    const left = Math.min(Math.max(center, half + TIP_EDGE), window.innerWidth - half - TIP_EDGE);
    setPos({ top: rect.top, left, arrow: center - left });
  };
  const open = () => {
    measure();
    setShow(true);
  };
  const close = () => setShow(false);

  useEffect(() => {
    if (!show) return;
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  return (
    <span
      ref={ref}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
      tabIndex={0}
      role="button"
      aria-label={text}
      style={{
        display: "inline-flex", verticalAlign: "middle", marginLeft: "5px",
        color: show ? "#4f46e5" : "#94a3b8", cursor: "help", outline: "none",
        transition: "color 120ms ease",
      }}
    >
      <Info size={13} strokeWidth={2.25} aria-hidden="true" />
      {show &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            role="tooltip"
            style={{
              position: "fixed",
              top: pos.top - 9,
              left: pos.left,
              transform: "translate(-50%, -100%)",
              background: "linear-gradient(160deg, #312e81, #0f172a)",
              color: "#e5e7eb",
              padding: "10px 13px",
              borderRadius: 10,
              fontSize: "0.76rem",
              fontWeight: 400,
              lineHeight: 1.5,
              width: "max-content",
              maxWidth: `min(${TIP_MAX_W}px, calc(100vw - ${TIP_EDGE * 2}px))`,
              zIndex: 2147483647,
              boxShadow: "0 12px 30px rgba(15,23,42,0.4), 0 0 0 1px rgba(255,255,255,0.08)",
              textAlign: "left",
              pointerEvents: "none",
            }}
          >
            {text}
            <span
              style={{
                position: "absolute",
                top: "100%",
                left: `calc(50% + ${pos.arrow}px)`,
                transform: "translateX(-50%)",
                width: 0,
                height: 0,
                borderLeft: "6px solid transparent",
                borderRight: "6px solid transparent",
                borderTop: "6px solid #0f172a",
              }}
            />
          </span>,
          document.body
        )}
    </span>
  );
}
