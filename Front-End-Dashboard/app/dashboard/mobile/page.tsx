"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  Radio,
  RotateCcw,
  Route,
  Save,
  Signal,
  Siren,
  Smartphone,
  Sparkles,
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

type MobileConfig = {
  features: Record<TabKey, boolean>;
  sections: Sections;
  advisory: { active: boolean; tone: AdvisoryTone; message: string };
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
  advisory: { active: false, tone: "info", message: "" },
};

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins)) return "never";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

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
          JSON.stringify(saved.advisory) !== JSON.stringify(draft.advisory)
        : false,
    [saved, draft]
  );

  const anythingOn = useMemo(() => TABS.some((t) => tabShown(draft.sections, t.key)), [draft]);

  // The API refuses these, so the button that would trigger the refusal is
  // disabled and says why, rather than letting the operator find out from a red
  // banner after pressing Save.
  const blockedReason = useMemo(() => {
    if (draft.advisory.active && draft.advisory.message.trim().length < 8) {
      return "A published advisory needs at least 8 characters.";
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
        body: JSON.stringify({ sections: draft.sections, advisory: draft.advisory }),
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

  const shownCount = TABS.filter((t) => tabShown(draft.sections, t.key)).length;
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

      {error && (
        <div className="ds-mc-banner is-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>{error}</div>
        </div>
      )}

      {flash && (
        <div className="ds-mc-banner is-ok" role="status">
          <Info size={16} aria-hidden="true" />
          <div>{flash}</div>
        </div>
      )}

      <div className="ds-mc-grid">
        <div className="ds-mc-col">
          {/* The advisory is a broadcast, not a per-screen switch, so it does
              not belong in the list of sections. It sits above as a one-line
              readout of whether anything is live, and opens in a dialog — which
              also keeps this page to a single screen with no scrolling. */}
          <div className={`ds-mc-advisory-strip${draft.advisory.active ? " is-live" : ""}`}>
            <span className="ds-mc-advisory-icon" aria-hidden="true">
              <Megaphone size={16} />
            </span>
            <span className="ds-mc-advisory-text">
              <b>Published advisory</b>
              {draft.advisory.active && draft.advisory.message.trim().length > 0 ? (
                <span className="is-live-text" title={draft.advisory.message}>
                  <span className={`ds-mc-dot is-${draft.advisory.tone}`} aria-hidden="true" />
                  Live · {draft.advisory.message}
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
              {draft.advisory.active ? "Edit" : "Publish"}
            </button>
          </div>

          <article className="panel ds-mc-panel">
            <header className="ds-mc-panel-head">
              <div>
                <h2>What travellers get</h2>
                <p>
                  A tab appears whenever anything inside it is on, so emptying one retires it.{" "}
                  <b>{shownCount} of {TABS.length}</b> tabs visible.
                </p>
              </div>
            </header>

            <ul className="ds-mc-features">
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
                        onClick={() => {
                          setOpen(expanded ? null : key);
                          setPreviewTab(key);
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
                        {/* The advisory rides on the Alerts screen, so it only
                            appears when that is the screen being previewed. */}
                        {previewTab === "alerts" &&
                          draft.advisory.active &&
                          draft.advisory.message.trim().length > 0 && (
                            <div className={`ds-phone-advisory is-${draft.advisory.tone}`}>
                              <b>
                                {draft.advisory.tone === "critical"
                                  ? "Critical"
                                  : draft.advisory.tone === "warning"
                                    ? "Advisory"
                                    : "Notice"}
                              </b>
                              <span>{draft.advisory.message}</span>
                            </div>
                          )}

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
            className="ds-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="advisory-title"
          >
            <header className="ds-modal-head">
              <div>
                <h2 id="advisory-title">Published advisory</h2>
                <p>
                  One message, broadcast to the Alerts tab of every phone. It is pinned above the
                  app&apos;s own notices and shows whichever category a traveller is looking at.
                </p>
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
              <label className="ds-mc-publish-row">
                <span>
                  <b>Publish to every phone</b>
                  <span>Off keeps the draft here without sending it.</span>
                </span>
                <span className="ds-switch">
                  <input
                    type="checkbox"
                    checked={draft.advisory.active}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        advisory: { ...d.advisory, active: e.target.checked },
                      }))
                    }
                  />
                  <span className="ds-switch-track" aria-hidden="true">
                    <span className="ds-switch-thumb" />
                  </span>
                </span>
              </label>

              <div className="ds-mc-tones" role="group" aria-label="Advisory tone">
                {TONES.map((tone) => (
                  <button
                    key={tone.key}
                    type="button"
                    className={`ds-mc-tone is-${tone.key}${draft.advisory.tone === tone.key ? " is-active" : ""}`}
                    aria-pressed={draft.advisory.tone === tone.key}
                    onClick={() =>
                      setDraft((d) => ({ ...d, advisory: { ...d.advisory, tone: tone.key } }))
                    }
                  >
                    <b>{tone.label}</b>
                    <span>{tone.hint}</span>
                  </button>
                ))}
              </div>

              <label className="ds-mc-field">
                <span>Message</span>
                <textarea
                  rows={3}
                  autoFocus
                  maxLength={MAX_MESSAGE}
                  value={draft.advisory.message}
                  placeholder="e.g. Lane closure at Km 15.2 southbound until 06:00. Expect delays."
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, advisory: { ...d.advisory, message: e.target.value } }))
                  }
                />
                <small className={draft.advisory.message.length > MAX_MESSAGE - 30 ? "is-near" : ""}>
                  {draft.advisory.message.length} / {MAX_MESSAGE}
                </small>
              </label>

              {/* Says what pressing Done will and will not do. The dialog edits
                  the same draft as everything else, so nothing reaches a phone
                  until Save & publish. */}
              <p className="ds-modal-note">
                {draft.advisory.active && draft.advisory.message.trim().length < 8
                  ? "A published advisory needs at least 8 characters."
                  : "Closing keeps your changes here. Nothing reaches a phone until you press Save & publish."}
              </p>
            </div>

            <footer className="ds-modal-foot">
              <button
                type="button"
                className="btn-muted"
                onClick={() => {
                  // Revert only the advisory, leaving section edits alone.
                  if (saved) setDraft((d) => ({ ...d, advisory: saved.advisory }));
                  setAdvisoryOpen(false);
                }}
              >
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={() => setAdvisoryOpen(false)}>
                Done
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* Save bar. Sticks to the bottom while there is something to save, so a
          change made at the top of a long page cannot be forgotten on the way
          down it. */}
      <div className={`ds-mc-savebar${dirty ? " is-open" : ""}`} aria-hidden={!dirty}>
        <div className="ds-mc-savebar-text">
          {blockedReason ? (
            <span className="is-blocked">
              <AlertTriangle size={14} aria-hidden="true" /> {blockedReason}
            </span>
          ) : (
            <span>
              Unsaved changes.{" "}
              <small>
                Last saved {relativeTime(meta?.updatedAt ?? null)}
                {meta?.updatedBy ? ` by ${meta.updatedBy}` : ""}.
              </small>
            </span>
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
