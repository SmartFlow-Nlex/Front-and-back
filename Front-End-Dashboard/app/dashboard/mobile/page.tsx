"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BatteryFull,
  Bell,
  Bot,
  CalendarClock,
  CalendarRange,
  ChevronDown,
  EyeOff,
  Filter,
  Flame,
  Info,
  LayoutDashboard,
  ListChecks,
  Map as MapIcon,
  Megaphone,
  MessageSquarePlus,
  Plus,
  Radio,
  RotateCcw,
  Route,
  Save,
  Signal,
  Siren,
  Smartphone,
  Sparkles,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Users,
  Wifi,
  Wrench,
  X,
} from "lucide-react";
import PageHeader from "../../../components/dashboard/PageHeader";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

/* Mirrors Back-End/src/validators/mobile-config.validator.ts. The keys are the
   Expo route names in the mobile app's (tabs) group, which is what lets the app
   look a flag up by the route it is about to render. */
type TabKey = "dashboard" | "map" | "community" | "assistant" | "alerts";
type AdvisoryTone = "info" | "warning" | "critical";

type Sections = Record<TabKey, Record<string, boolean>>;

type Advisory = { id: string; active: boolean; tone: AdvisoryTone; message: string };

type MobileConfig = {
  features: Record<TabKey, boolean>;
  sections: Sections;
  /** Held in the order an operator arranged them. The API also returns a
   *  derived single `advisory` for older app builds; nothing here reads it. */
  advisories: Advisory[];
};

type Meta = { source: "db" | "defaults"; updatedAt: string | null; updatedBy: string | null };

type Icon = typeof MapIcon;
type SectionMeta = { key: string; label: string; blurb: string; icon: Icon };

/* One entry per tab in frontend/app/(tabs)/_layout.tsx, and under each, the
   parts of that screen the app can render independently.

   `label` is the wording the traveller actually sees, so the preview can be
   trusted as a picture of the app rather than an approximation of it. Nothing
   is listed here that the screen does not genuinely gate — see the note in the
   validator about why that rule matters. */
const TABS: { key: TabKey; label: string; icon: Icon; blurb: string; sections: SectionMeta[] }[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    blurb: "The screen the app opens on.",
    sections: [
      { key: "statusSummary", label: "Network status", icon: Activity, blurb: "The live corridor summary at the top of the screen." },
      { key: "segmentForecast", label: "Traffic forecast", icon: Route, blurb: "Pick a route and hour, get a predicted state." },
      { key: "corridorOutlook", label: "Corridor outlook", icon: CalendarRange, blurb: "The Today / This Week strip." },
      { key: "eventForecasts", label: "Event forecasts", icon: CalendarClock, blurb: "Upcoming events and the surge each is expected to bring." },
      { key: "mlHotspots", label: "ML hotspots", icon: Flame, blurb: "Model-ranked risk locations." },
    ],
  },
  {
    key: "map",
    label: "Corridor",
    icon: MapIcon,
    blurb: "The live map. Reads the same real-time feed as the Live Map page here.",
    sections: [
      { key: "liveStatus", label: "Live view", icon: Radio, blurb: "Current readings, straight from the feed." },
      { key: "forecastView", label: "Forecast view", icon: TrendingUp, blurb: "Modelled state ahead of now." },
    ],
  },
  {
    key: "community",
    label: "Community",
    icon: Users,
    blurb: "Traveller-submitted reports.",
    sections: [
      { key: "shareUpdate", label: "Share an update", icon: MessageSquarePlus, blurb: "Lets a traveller post a general update." },
      { key: "reportIncident", label: "Report an incident", icon: TriangleAlert, blurb: "The incident-reporting form." },
      { key: "filters", label: "Feed filters", icon: Filter, blurb: "The tabs that narrow the feed by type." },
    ],
  },
  {
    key: "assistant",
    label: "Assistant",
    icon: Bot,
    blurb: "Conversational lookup of corridor conditions.",
    sections: [
      { key: "quickQuestions", label: "Quick questions", icon: Sparkles, blurb: "Suggested prompts above the input." },
      { key: "capabilities", label: "What it can answer", icon: ListChecks, blurb: "The list shown before the first question." },
    ],
  },
  {
    key: "alerts",
    label: "Alerts",
    icon: Bell,
    blurb: "Notices, and any advisory you publish.",
    sections: [
      { key: "traffic", label: "Traffic alerts", icon: Siren, blurb: "Congestion, events and incidents." },
      { key: "maintenance", label: "Maintenance notices", icon: Wrench, blurb: "Scheduled roadworks and closures." },
    ],
  },
];

const TONES: { key: AdvisoryTone; label: string; hint: string }[] = [
  { key: "info", label: "Info", hint: "General notice" },
  { key: "warning", label: "Warning", hint: "Plan around it" },
  { key: "critical", label: "Critical", hint: "Act now" },
];

const MAX_MESSAGE = 280;
/** Below this an advisory cannot be published. Mirrors the API. */
const MIN_MESSAGE = 8;
/** Every published advisory is pinned above the app's own notices, so a long
 *  list stops being a notice and starts being the Alerts screen. */
const MAX_ADVISORIES = 6;

const newAdvisoryId = () =>
  `adv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function allOn(): Sections {
  return TABS.reduce((acc, t) => {
    acc[t.key] = t.sections.reduce<Record<string, boolean>>((g, s) => ({ ...g, [s.key]: true }), {});
    return acc;
  }, {} as Sections);
}

/** The app shows a tab when anything inside it is on. Mirrors deriveFeatures()
 *  on the server, which is what actually gets written — this is only so the
 *  preview and the tab bar can move before a save. */
function tabShown(sections: Sections, key: TabKey): boolean {
  return Object.values(sections[key] ?? {}).some(Boolean);
}

const FALLBACK: MobileConfig = {
  features: { dashboard: true, map: true, community: true, assistant: true, alerts: true },
  sections: allOn(),
  advisories: [],
};

/**
 * Mobile Control Centre.
 *
 * Every switch on this page is one the mobile app actually reads. That is a
 * deliberate constraint rather than a limitation: a control panel whose toggles
 * do nothing is worse than no panel at all, because an operator watches the
 * switch move and believes the tab is gone. Before a control is added here it is
 * wired in the app first — see the note in the validator.
 *
 * There is one level of switch, not two. A tab has no on/off of its own: it is
 * shown when anything inside it is, so emptying a tab is how you retire it.
 * Two levels would allow a tab switched on with nothing inside it, which opens
 * to a blank screen and reads as a broken app.
 */
export default function MobileControlPage() {
  const [saved, setSaved] = useState<MobileConfig | null>(null);
  const [draft, setDraft] = useState<MobileConfig>(FALLBACK);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [open, setOpen] = useState<TabKey | null>("dashboard");
  const [previewTab, setPreviewTab] = useState<TabKey>("dashboard");

  /* Which ends of the tab list have content beyond them.
   *
   * The list fades at its edges so a row cut mid-height reads as "there is
   * more" rather than as clipping — but a fade that is always on eats the
   * first row's outline even when nothing is scrolled past, which is exactly
   * how it looked: the top card appeared to have no border. So each edge is
   * faded only when there is actually something behind it. */
  const listRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const measureEdges = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const top = el.scrollTop > 1;
    const bottom = Math.ceil(el.scrollTop + el.clientHeight) < el.scrollHeight - 1;
    setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);
  const [advisoryOpen, setAdvisoryOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${BACKEND}/api/mobile-config`, { cache: "no-store" });
      const body = await res.json();
      if (!body?.success) throw new Error(body?.message ?? "Could not read configuration");
      setSaved(body.data as MobileConfig);
      setDraft(body.data as MobileConfig);
      setMeta(body.meta as Meta);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the dashboard API");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-measure whenever the list's own size changes: expanding a tab, the
  // window resizing, or the save bar appearing all move where the edges are.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    measureEdges();
    const ro = new ResizeObserver(measureEdges);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [measureEdges, open, loading]);

  // Escape closes the advisory dialog. Bound on the document rather than the
  // panel because focus may be inside the textarea, and a dialog that traps a
  // reader with no keyboard way out is worse than no dialog.
  useEffect(() => {
    if (!advisoryOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAdvisoryOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [advisoryOpen]);

  const dirty = useMemo(
    () =>
      saved
        ? JSON.stringify(saved.sections) !== JSON.stringify(draft.sections) ||
          JSON.stringify(saved.advisories) !== JSON.stringify(draft.advisories)
        : false,
    [saved, draft]
  );

  /** The message is what makes an advisory publishable, so the two are kept in
   *  step here rather than validated after the fact. Below the minimum the
   *  broadcast is simply off: otherwise a row reads as a draft while the save
   *  bar refuses to save and names a rule with no visible cause. */
  const patchAdvisory = (id: string, patch: Partial<Advisory>) =>
    setDraft((d) => ({
      ...d,
      advisories: d.advisories.map((a) => {
        if (a.id !== id) return a;
        const next = { ...a, ...patch };
        if (next.message.trim().length < MIN_MESSAGE) next.active = false;
        return next;
      }),
    }));

  const addAdvisory = () =>
    setDraft((d) =>
      d.advisories.length >= MAX_ADVISORIES
        ? d
        : {
            ...d,
            advisories: [
              ...d.advisories,
              { id: newAdvisoryId(), active: false, tone: "info" as AdvisoryTone, message: "" },
            ],
          }
    );

  const removeAdvisory = (id: string) =>
    setDraft((d) => ({ ...d, advisories: d.advisories.filter((a) => a.id !== id) }));

  const livePublished = draft.advisories.filter(
    (a) => a.active && a.message.trim().length >= MIN_MESSAGE
  );

  /** What is actually published right now, as opposed to what the draft says.
   *  The switch records intent; only a save changes what travellers see. */
  const savedAdvisories = useMemo(
    () => new Map((saved?.advisories ?? []).map((a) => [a.id, a])),
    [saved]
  );

  /** How many advisories a save would actually change on a phone. This is the
   *  difference between the switch and the button, said as a number instead of
   *  as a paragraph. */
  const pendingCount = useMemo(() => {
    const prevIds = new Set(savedAdvisories.keys());
    let n = draft.advisories.filter((a) => {
      const prev = savedAdvisories.get(a.id);
      return !prev || prev.active !== a.active || prev.message !== a.message || prev.tone !== a.tone;
    }).length;
    for (const id of prevIds) if (!draft.advisories.some((a) => a.id === id)) n += 1;
    return n;
  }, [draft.advisories, savedAdvisories]);

  const pendingFor = (a: Advisory): { live: boolean; change: string | null } => {
    const prev = savedAdvisories.get(a.id);
    if (!prev) return { live: false, change: a.active ? "new, will publish" : "new draft" };
    if (prev.active !== a.active) {
      return { live: prev.active, change: a.active ? "will publish" : "will withdraw" };
    }
    if (prev.message !== a.message || prev.tone !== a.tone) {
      return { live: prev.active, change: "edited" };
    }
    return { live: prev.active, change: null };
  };

  const anythingOn = useMemo(() => TABS.some((t) => tabShown(draft.sections, t.key)), [draft]);

  // The API refuses these, so the button that would trigger the refusal is
  // disabled and says why, rather than letting the operator find out from a red
  // banner after pressing Save.
  const blockedReason = useMemo(() => {
    if (draft.advisories.some((a) => a.active && a.message.trim().length < MIN_MESSAGE)) {
      return `A published advisory needs at least ${MIN_MESSAGE} characters.`;
    }
    if (!anythingOn) return "Everything is switched off — the app would open to nothing.";
    return null;
  }, [draft, anythingOn]);

  const save = async () => {
    if (blockedReason) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${BACKEND}/api/mobile-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // `features` is derived from `sections` by the API, so it is not sent.
        body: JSON.stringify({ sections: draft.sections, advisories: draft.advisories }),
      });
      const body = await res.json();
      if (!res.ok || !body?.success) throw new Error(body?.message ?? `Save failed (${res.status})`);
      setSaved(body.data as MobileConfig);
      setDraft(body.data as MobileConfig);
      setMeta(body.meta as Meta);
      setFlash("Saved — the app picks this up on its next launch or refresh.");
      window.setTimeout(() => setFlash(null), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const setSection = (tab: TabKey, key: string, on: boolean) =>
    setDraft((d) => ({
      ...d,
      sections: { ...d.sections, [tab]: { ...(d.sections[tab] ?? {}), [key]: on } },
    }));

  const setWholeTab = (tab: TabKey, on: boolean) =>
    setDraft((d) => {
      const meta = TABS.find((t) => t.key === tab);
      if (!meta) return d;
      const next = meta.sections.reduce<Record<string, boolean>>((g, s) => ({ ...g, [s.key]: on }), {});
      return { ...d, sections: { ...d.sections, [tab]: next } };
    });

  const previewMeta = TABS.find((t) => t.key === previewTab) ?? TABS[0];
  const previewOn = previewMeta.sections.filter((s) => draft.sections[previewMeta.key]?.[s.key]);
  const previewHidden = previewOn.length === 0;

  return (
    <section className="ds-content ds-mc-page">
      <PageHeader
        icon={Smartphone}
        title="Mobile Control Centre"
        subtitle="What the SmartFlow mobile app shows to travellers"
        actions={
          <button className="btn-muted" onClick={() => void load()} disabled={loading || saving}>
            <RotateCcw size={14} aria-hidden="true" /> Reload
          </button>
        }
      />

      {/* Provenance, stated plainly. "Everything is on" means something very
          different depending on whether an operator chose it or the database
          was unreachable, so the page never leaves that ambiguous. */}
      {meta?.source === "defaults" && !loading && (
        <div className="ds-mc-banner is-warn" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            <b>Showing built-in defaults, not saved settings.</b> The configuration row could not be
            read, so the app is currently being served every feature switched on. Saving from here
            will create it. If this persists, run <code>Back-End/scripts/mobile-config.sql</code>.
          </div>
        </div>
      )}

      <div className="ds-toasts" aria-live="polite">
        {error && (
          <div className="ds-toast is-error" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <div>{error}</div>
            <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
        {flash && (
          <div className="ds-toast is-ok" role="status">
            <Info size={16} aria-hidden="true" />
            <div>{flash}</div>
          </div>
        )}
      </div>

        {/* The advisory is a broadcast, not a per-screen switch, so it does
            not belong in the list of sections. It sits above as a one-line
            readout of whether anything is live, and opens in a dialog — which
            also keeps this page to a single screen with no scrolling. */}
        <div className={`ds-mc-advisory-strip${livePublished.length > 0 ? " is-live" : ""}`}>
          <span className="ds-mc-advisory-icon" aria-hidden="true">
            <Megaphone size={16} />
          </span>
          <span className="ds-mc-advisory-text">
            <b>
              Advisories
              {draft.advisories.length > 0 && (
                <span className="ds-mc-advisory-counts">
                  {livePublished.length} published
                  {draft.advisories.length - livePublished.length > 0 &&
                    ` \u00b7 ${draft.advisories.length - livePublished.length} draft`}
                </span>
              )}
            </b>
            {livePublished.length > 0 ? (
              <span className="is-live-text">
                {livePublished.map((a) => (
                  <span key={a.id} className="ds-mc-advisory-chip" title={a.message}>
                    <span className={`ds-mc-dot is-${a.tone}`} aria-hidden="true" />
                    {a.message}
                  </span>
                ))}
              </span>
            ) : (
              <span>Nothing published. Travellers see only the app&apos;s own notices.</span>
            )}
          </span>
          <button
            type="button"
            className="btn-muted ds-mc-advisory-btn"
            disabled={loading}
            onClick={() => setAdvisoryOpen(true)}
          >
            Manage
          </button>
        </div>

      <div className="ds-mc-grid">
        <div className="ds-mc-col">
          <article className="panel ds-mc-panel">
            <header className="ds-mc-panel-head">
              <div>
                <h2>What travellers get</h2>
              </div>
            </header>

            <ul
              className="ds-mc-features"
              ref={listRef}
              onScroll={measureEdges}
              data-fade-top={edges.top ? "true" : undefined}
              data-fade-bottom={edges.bottom ? "true" : undefined}
            >
              {TABS.map((t) => {
                const { key, label, icon: Icon, blurb } = t;
                const group = draft.sections[key] ?? {};
                const onCount = t.sections.filter((s) => group[s.key]).length;
                const shown = onCount > 0;
                const expanded = open === key;

                return (
                  <li key={key} className={`${shown ? "is-on" : "is-off"}${expanded ? " is-open" : ""}`}>
                    <div className="ds-mc-feature-row">
                      <button
                        type="button"
                        className="ds-mc-disclosure"
                        aria-expanded={expanded}
                        aria-controls={`sections-${key}`}
                        onClick={(e) => {
                          const opening = !expanded;
                          setOpen(opening ? key : null);
                          setPreviewTab(key);
                          if (!opening) return;
                          // After the sections render, bring the row's own top
                          // into view. Without this the list keeps its previous
                          // offset and the tab just opened can be the one cut
                          // off at the top of the scroll.
                          const row = e.currentTarget.closest("li");
                          window.requestAnimationFrame(() =>
                            row?.scrollIntoView({ block: "nearest", behavior: "smooth" })
                          );
                        }}
                      >
                        <span className="ds-mc-feature-icon" aria-hidden="true">
                          <Icon size={17} />
                        </span>
                        <span className="ds-mc-feature-text">
                          <b>{label}</b>
                          <span>{blurb}</span>
                        </span>
                        <span className="ds-mc-state">
                          {/* The tab's visibility is a readout, not a control:
                              it follows the switches below rather than being
                              a sixth switch that could contradict them. */}
                          {shown ? (
                            <span className="ds-mc-pill is-shown">
                              {onCount}/{t.sections.length} on
                            </span>
                          ) : (
                            <span className="ds-mc-pill is-hidden">
                              <EyeOff size={12} aria-hidden="true" /> Hidden
                            </span>
                          )}
                          <ChevronDown size={15} aria-hidden="true" />
                        </span>
                      </button>
                    </div>

                    {expanded && (
                      <div className="ds-mc-sections" id={`sections-${key}`}>
                        <div className="ds-mc-sections-bulk">
                          <span>
                            {shown
                              ? `${label} is visible in the app.`
                              : `${label} is hidden — nothing inside it is on.`}
                          </span>
                          <button
                            type="button"
                            className="ds-mc-linkbtn"
                            disabled={loading}
                            onClick={() => setWholeTab(key, !shown)}
                          >
                            {shown ? "Turn all off" : "Turn all on"}
                          </button>
                        </div>
                        <ul>
                          {t.sections.map((s) => {
                            const SIcon = s.icon;
                            return (
                              <li key={s.key}>
                                <span className="ds-mc-section-icon" aria-hidden="true">
                                  <SIcon size={15} />
                                </span>
                                <span className="ds-mc-section-text">
                                  <b>{s.label}</b>
                                  <span>{s.blurb}</span>
                                </span>
                                <label className="ds-switch is-small">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(group[s.key])}
                                    disabled={loading}
                                    onChange={(e) => setSection(key, s.key, e.target.checked)}
                                  />
                                  <span className="ds-switch-track" aria-hidden="true">
                                    <span className="ds-switch-thumb" />
                                  </span>
                                  <span className="sr-only">{`${label}: ${s.label}`}</span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </article>

        </div>

        {/* Right: what the phone will look like. Rendered from `draft`, so it
            moves as the switches move and an operator can see the result before
            committing it to every device. */}
        <aside className="ds-mc-col">
          <article className="panel ds-mc-panel ds-mc-preview-panel">
            <header className="ds-mc-panel-head">
              <div>
                <h2>Preview</h2>
                <p>Tap a tab below to see inside it. Unsaved changes included.</p>
              </div>
            </header>

            <div className="ds-phone" aria-label="Mobile app preview">
              <div className="ds-phone-frame">
                <div className="ds-phone-notch" aria-hidden="true" />
                <div className="ds-phone-screen">
                  <div className="ds-phone-status" aria-hidden="true">
                    <span className="ds-phone-clock">9:41</span>
                    <span className="ds-phone-icons">
                      <Signal size={11} />
                      <Wifi size={11} />
                      <BatteryFull size={13} />
                    </span>
                  </div>

                  <div className="ds-phone-appbar">
                    <span>{previewMeta.label}</span>
                    <span className="ds-phone-dot" aria-hidden="true" />
                  </div>

                  <div className="ds-phone-body">
                    {previewHidden ? (
                      <div className="ds-phone-blank">
                        <EyeOff size={20} aria-hidden="true" />
                        <b>{previewMeta.label} is hidden</b>
                        <span>Nothing inside it is switched on, so the tab is not in the app.</span>
                      </div>
                    ) : (
                      <>
                        {/* Advisories ride on the Alerts screen, so they only
                            appear when that is the screen being previewed. */}
                        {previewTab === "alerts" &&
                          livePublished.map((a) => (
                            <div key={a.id} className={`ds-phone-advisory is-${a.tone}`}>
                              <b>
                                {a.tone === "critical"
                                  ? "Critical"
                                  : a.tone === "warning"
                                    ? "Advisory"
                                    : "Notice"}
                              </b>
                              <span>{a.message}</span>
                            </div>
                          ))}

                        {previewOn.map((s) => {
                          const SIcon = s.icon;
                          return (
                            <div key={s.key} className="ds-phone-card">
                              <span className="ds-phone-card-icon" aria-hidden="true">
                                <SIcon size={13} />
                              </span>
                              <span className="ds-phone-card-text">
                                <b>{s.label}</b>
                                {/* Bars, not invented figures: the preview is
                                    about layout, and plausible-looking numbers
                                    here would be a lie told for a nicer picture. */}
                                <span className="ds-phone-bar w80" />
                                <span className="ds-phone-bar w55" />
                              </span>
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>

                  <nav className="ds-phone-tabs" aria-label="Preview a tab">
                    {TABS.map(({ key, label, icon: Icon }) => (
                      <button
                        key={key}
                        type="button"
                        className={`ds-phone-tab${tabShown(draft.sections, key) ? "" : " is-gone"}${
                          previewTab === key ? " is-current" : ""
                        }`}
                        title={`Preview ${label}`}
                        onClick={() => {
                          setPreviewTab(key);
                          setOpen(key);
                        }}
                      >
                        <Icon size={15} aria-hidden="true" />
                        <small>{label}</small>
                      </button>
                    ))}
                  </nav>
                </div>
              </div>
            </div>

            {/* A hidden tab has no button left in the bar, so it needs another
                way back — otherwise emptying a tab makes it unreachable here. */}
            <div className="ds-phone-jump">
              {TABS.filter((t) => !tabShown(draft.sections, t.key)).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className="ds-mc-pill is-hidden is-clickable"
                  onClick={() => {
                    setPreviewTab(t.key);
                    setOpen(t.key);
                  }}
                >
                  <EyeOff size={12} aria-hidden="true" /> {t.label}
                </button>
              ))}
            </div>

            <p className="ds-mc-note">
              Hidden tabs are dropped from the bar entirely rather than greyed out, so the remaining
              ones spread to fill it — exactly as the app does it.
            </p>
          </article>
        </aside>
      </div>

      {advisoryOpen && (
        <div
          className="ds-modal-backdrop"
          role="presentation"
          onClick={(e) => {
            // Only a click on the backdrop itself closes it; one that started
            // inside the dialog and drifted out while selecting text does not.
            if (e.target === e.currentTarget) setAdvisoryOpen(false);
          }}
        >
          <div
            className="ds-modal is-wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="advisory-title"
          >
            <header className="ds-modal-head">
              <div className="ds-adv-title">
                <span className="ds-adv-title-icon" aria-hidden="true">
                  <Megaphone size={17} />
                </span>
                <h2 id="advisory-title">Advisories</h2>
                {draft.advisories.length > 0 && (
                  <span className="ds-mc-advisory-counts">
                    {livePublished.length} published
                    {draft.advisories.length - livePublished.length > 0 &&
                      ` \u00b7 ${draft.advisories.length - livePublished.length} draft`}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="ds-modal-close"
                aria-label="Close"
                onClick={() => setAdvisoryOpen(false)}
              >
                <X size={17} aria-hidden="true" />
              </button>
            </header>

            <div className="ds-modal-body">
              {draft.advisories.length === 0 ? (
                <div className="ds-adv-empty">
                  <Megaphone size={22} aria-hidden="true" />
                  <b>No advisories yet</b>
                  <span>
                    An advisory is a message you put on every phone: a closure, an event, a
                    warning. Add one and it stays a draft until you publish it.
                  </span>
                </div>
              ) : (
                <ul className="ds-adv-list">
                  {draft.advisories.map((a) => {
                    const ready = a.message.trim().length >= MIN_MESSAGE;
                    const short = MIN_MESSAGE - a.message.trim().length;
                    const { live, change } = pendingFor(a);
                    return (
                      <li key={a.id} className={`tone-${a.tone}${live ? " is-live" : ""}`}>
                        {/* Top: where this stands, and what a save would change. */}
                        <div className="ds-adv-head">
                          <span className={`ds-adv-state${live ? " is-live" : ""}`}>
                            <span
                              className={`ds-mc-dot ${live ? `is-${a.tone}` : "is-idle"}`}
                              aria-hidden="true"
                            />
                            {live ? "Published" : "Draft"}
                          </span>
                          {change && <span className="ds-adv-pending">{change}</span>}
                          <button
                            type="button"
                            className="ds-adv-delete"
                            aria-label="Delete advisory"
                            onClick={() => removeAdvisory(a.id)}
                          >
                            <Trash2 size={15} aria-hidden="true" />
                          </button>
                        </div>

                        {/* Middle: what it says. */}
                        <div className="ds-adv-field">
                          <textarea
                            rows={2}
                            maxLength={MAX_MESSAGE}
                            value={a.message}
                            placeholder="e.g. Lane closure at Km 15.2 southbound until 06:00."
                            onChange={(e) => patchAdvisory(a.id, { message: e.target.value })}
                          />
                          <span
                            className={`ds-adv-counter${a.message.length > MAX_MESSAGE - 30 ? " is-near" : ""}`}
                          >
                            {a.message.length}/{MAX_MESSAGE}
                          </span>
                        </div>

                        {/* Bottom: how it goes out. */}
                        <div className="ds-adv-foot">
                          <div className="ds-mc-tones is-inline" role="group" aria-label="Tone">
                            {TONES.map((tone) => (
                              <button
                                key={tone.key}
                                type="button"
                                className={`ds-mc-tone is-${tone.key}${a.tone === tone.key ? " is-active" : ""}`}
                                aria-pressed={a.tone === tone.key}
                                onClick={() => patchAdvisory(a.id, { tone: tone.key })}
                              >
                                <b>{tone.label}</b>
                              </button>
                            ))}
                          </div>

                          {!ready && a.message.length > 0 && (
                            <span className="ds-adv-hint">{short} more to publish</span>
                          )}

                          <label
                            className="ds-adv-publish"
                            title={ready ? "Mark this to go live on the next save" : "Write more first"}
                          >
                            <span>Publish</span>
                            <span className="ds-switch is-small">
                              <input
                                type="checkbox"
                                checked={a.active}
                                disabled={!ready}
                                onChange={(e) => patchAdvisory(a.id, { active: e.target.checked })}
                              />
                              <span className="ds-switch-track" aria-hidden="true">
                                <span className="ds-switch-thumb" />
                              </span>
                            </span>
                          </label>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <button
                type="button"
                className="btn-muted ds-adv-add"
                onClick={addAdvisory}
                disabled={draft.advisories.length >= MAX_ADVISORIES}
              >
                <Plus size={15} aria-hidden="true" />
                {draft.advisories.length >= MAX_ADVISORIES
                  ? "Limit reached"
                  : "Add advisory"}
              </button>
            </div>

            {/* Saving lives here as well as on the page, because publishing an
                advisory is a whole task on its own: an operator who came to post
                a closure should not have to find a bar behind the dialog to
                finish it. It saves the same draft the page does, sections
                included, so the two can never disagree about what was sent. */}
            <footer className="ds-modal-foot">
              <span className="ds-modal-foot-note">
                {blockedReason ??
                  (pendingCount > 0
                    ? `${pendingCount} change${pendingCount === 1 ? "" : "s"} to send`
                    : dirty
                      ? "Unsaved changes elsewhere on the page"
                      : "Nothing to send")}
              </span>
              <button
                type="button"
                className="btn-muted"
                onClick={() => {
                  // Revert only the advisories, leaving section edits alone.
                  if (saved) setDraft((d) => ({ ...d, advisories: saved.advisories }));
                  setAdvisoryOpen(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={saving || !dirty || Boolean(blockedReason)}
                onClick={() => void save().then(() => setAdvisoryOpen(false))}
              >
                <Save size={14} aria-hidden="true" /> {saving ? "Saving\u2026" : "Save & publish"}
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* Save bar. Sticks to the bottom while there is something to save, so a
          change made at the top of a long page cannot be forgotten on the way
          down it. */}
      <div
        className={`ds-mc-savebar${dirty && !advisoryOpen ? " is-open" : ""}`}
        aria-hidden={!dirty || advisoryOpen}
      >
        <div className="ds-mc-savebar-text">
          {blockedReason ? (
            <span className="is-blocked">
              <AlertTriangle size={14} aria-hidden="true" /> {blockedReason}
            </span>
          ) : (
            <span>Unsaved changes.</span>
          )}
        </div>
        <div className="ds-mc-savebar-actions">
          <button
            className="btn-muted"
            onClick={() => saved && setDraft(saved)}
            disabled={saving || !dirty}
          >
            Discard
          </button>
          <button
            className="btn-primary"
            onClick={() => void save()}
            disabled={saving || !dirty || Boolean(blockedReason)}
          >
            <Save size={14} aria-hidden="true" /> {saving ? "Saving…" : "Save & publish"}
          </button>
        </div>
      </div>
    </section>
  );
}
