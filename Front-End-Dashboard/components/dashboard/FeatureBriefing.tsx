"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Plain-language read of whatever the page below it is showing.
 *
 * Served by POST /api/ai-insight/explain, which fetches its own rows rather
 * than taking them from here — so this panel and the tiles beside it cannot end
 * up describing different states of the corridor.
 *
 * It loads on mount and stays quiet about itself: no heading that announces
 * where the text came from, and no error box. If the request fails the panel
 * renders nothing, because everything it would have summarised is already on
 * screen in a form the reader can use.
 */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type Briefing = {
  headline: string;
  points: string[];
  watchOut: string | null;
  facts: string[];
};

export default function FeatureBriefing({
  feature,
  months,
  title,
  /** Live data goes stale; a schedule does not. Only the former offers a refresh. */
  refreshable = false,
}: {
  feature: "overview" | "traffic_analytics" | "emissions_analytics" | "corridor_status" | "maintenance";
  months?: "3" | "12" | "all";
  title: string;
  refreshable?: boolean;
}) {
  const [data, setData] = useState<Briefing | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showFacts, setShowFacts] = useState(false);
  const mounted = useRef(true);
  // Identifies the request whose answer is still wanted. Tying cancellation to
  // the request rather than to the effect's lifetime means a re-render cannot
  // orphan a call that is still running — which, on a request that takes the
  // better part of a minute, is the difference between the panel resolving and
  // it sitting on "Preparing the read-out…" indefinitely.
  const reqId = useRef(0);

  const load = useCallback(() => {
    const id = ++reqId.current;
    setBusy(true);
    setFailed(false);
    fetch(`${BACKEND}/api/ai-insight/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feature, months: months ?? "12" }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (!mounted.current || reqId.current !== id) return; // superseded or gone
        if (j?.success) setData(j.data as Briefing);
        else setFailed(true);
      })
      .catch(() => {
        if (mounted.current && reqId.current === id) setFailed(true);
      })
      .finally(() => {
        if (mounted.current && reqId.current === id) setBusy(false);
      });
  }, [feature, months]);

  // What has already been auto-loaded. Without this, React's development
  // double-invoke fires the request twice on every mount — two calls of ~48s
  // each, and twice the tokens, for one panel.
  const autoLoadedFor = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    const wanted = `${feature}|${months ?? "12"}`;
    if (autoLoadedFor.current !== wanted) {
      autoLoadedFor.current = wanted;
      load();
    }
    return () => {
      mounted.current = false;
    };
  }, [feature, months, load]);

  if (failed && !data) return null;

  return (
    <article
      style={{
        border: "1px solid var(--border-default, #e8edf5)",
        borderRadius: 12,
        background: "var(--bg-surface, #fff)",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h3
          style={{
            margin: 0,
            fontSize: "0.98rem",
            fontWeight: 700,
            color: "var(--text-primary)",
            flex: 1,
          }}
        >
          {title}
        </h3>
        {refreshable && !busy && (
          <button
            onClick={load}
            style={{
              padding: "5px 13px",
              borderRadius: 999,
              cursor: "pointer",
              fontSize: "0.74rem",
              fontWeight: 600,
              border: "1px solid var(--border-default, #cbd5e1)",
              background: "transparent",
              color: "var(--text-secondary)",
            }}
          >
            Refresh
          </button>
        )}
      </div>

      {busy && !data ? (
        <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--text-muted)", fontStyle: "italic" }}>
          Preparing the read-out…
        </p>
      ) : data ? (
        <>
          <p
            style={{
              margin: 0,
              fontSize: "0.88rem",
              lineHeight: 1.6,
              fontWeight: 600,
              color: "var(--text-primary)",
            }}
          >
            {data.headline}
          </p>

          {data.points.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5 }}>
              {data.points.map((p, i) => (
                <li key={i} style={{ fontSize: "0.83rem", lineHeight: 1.6, color: "var(--text-secondary)" }}>
                  {p}
                </li>
              ))}
            </ul>
          )}

          {data.watchOut && (
            <p
              style={{
                margin: 0,
                fontSize: "0.8rem",
                lineHeight: 1.55,
                color: "#b54708",
                background: "#fffaeb",
                borderLeft: "3px solid #f79009",
                borderRadius: 8,
                padding: "9px 11px",
              }}
            >
              {data.watchOut}
            </p>
          )}

          {/* The figures every sentence was built from. Collapsed, because the
              reader only needs them when checking a claim — but present, so
              that check is always possible without leaving the page. */}
          {data.facts.length > 0 && (
            <div>
              <button
                onClick={() => setShowFacts((v) => !v)}
                style={{
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  color: "var(--text-muted)",
                }}
              >
                {showFacts ? "Hide underlying figures" : "Show underlying figures"}
              </button>
              {showFacts && (
                <ul
                  style={{
                    margin: "8px 0 0",
                    paddingLeft: 18,
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  {data.facts.map((f, i) => (
                    <li key={i} style={{ fontSize: "0.76rem", lineHeight: 1.5, color: "var(--text-muted)" }}>
                      {f}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      ) : null}
    </article>
  );
}
