"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Bot,
  ChevronDown,
  Info,
  LayoutDashboard,
  Map as MapIcon,
  RotateCcw,
  Save,
  Smartphone,
  Users,
} from "lucide-react";
import PageHeader from "../../../components/dashboard/PageHeader";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

/* Mirrors Back-End/src/validators/mobile-config.validator.ts. The keys are the
   Expo route names in the mobile app's (tabs) group, which is what lets the app
   look a flag up by the route it is about to render. */
type FeatureKey = "dashboard" | "map" | "community" | "assistant" | "alerts";
type AdvisoryTone = "info" | "warning" | "critical";

type Sections = Record<FeatureKey, Record<string, boolean>>;

type MobileConfig = {
  features: Record<FeatureKey, boolean>;
  sections: Sections;
  advisory: { active: boolean; tone: AdvisoryTone; message: string };
};

type Meta = { source: "db" | "defaults"; updatedAt: string | null; updatedBy: string | null };

type SectionMeta = { key: string; label: string; blurb: string };

/* One entry per tab in frontend/app/(tabs)/_layout.tsx, and under each, the
   parts of that screen the app can render independently.

   `label` is the wording the traveller actually sees, so the preview can be
   trusted as a picture of the app rather than an approximation of it. Nothing
   is listed here that the screen does not genuinely gate — see the note in the
   validator about why that rule matters. */
const FEATURES: {
  key: FeatureKey;
  label: string;
  icon: typeof MapIcon;
  blurb: string;
  /** False when an empty tab is still a usable tab, so it needs no floor. */
  needsOne: boolean;
  sections: SectionMeta[];
}[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    blurb: "The screen the app opens on.",
    needsOne: true,
    sections: [
      { key: "statusSummary", label: "Network status", blurb: "The live corridor summary at the top of the screen." },
      { key: "segmentForecast", label: "Traffic forecast", blurb: "Pick a route and hour, get a predicted state." },
      { key: "corridorOutlook", label: "Corridor outlook", blurb: "The Today / This Week strip." },
      { key: "eventForecasts", label: "Event forecasts", blurb: "Upcoming events and the surge each is expected to bring." },
      { key: "mlHotspots", label: "ML hotspots", blurb: "Model-ranked risk locations." },
    ],
  },
  {
    key: "map",
    label: "Corridor",
    icon: MapIcon,
    blurb: "The live map. Reads the same real-time feed as the Live Map page here.",
    needsOne: true,
    sections: [
      { key: "liveStatus", label: "Live view", blurb: "Current readings, straight from the feed." },
      { key: "forecastView", label: "Forecast view", blurb: "Modelled state ahead of now." },
    ],
  },
  {
    key: "community",
    label: "Community",
    icon: Users,
    blurb: "Traveller-submitted reports.",
    needsOne: false,
    sections: [
      { key: "shareUpdate", label: "Share an update", blurb: "Lets a traveller post a general update." },
      { key: "reportIncident", label: "Report an incident", blurb: "The incident-reporting form." },
      { key: "filters", label: "Feed filters", blurb: "The tabs that narrow the feed by type." },
    ],
  },
  {
    key: "assistant",
    label: "Assistant",
    icon: Bot,
    blurb: "Conversational lookup of corridor conditions.",
    needsOne: false,
    sections: [
      { key: "quickQuestions", label: "Quick questions", blurb: "Suggested prompts above the input. The chat box stays either way." },
    ],
  },
  {
    key: "alerts",
    label: "Alerts",
    icon: Bell,
    blurb: "Notices, plus any advisory published below.",
    needsOne: true,
    sections: [
      { key: "traffic", label: "Traffic alerts", blurb: "Congestion, events and incidents." },
      { key: "maintenance", label: "Maintenance notices", blurb: "Scheduled roadworks and closures." },
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
  return FEATURES.reduce((acc, f) => {
    acc[f.key] = f.sections.reduce<Record<string, boolean>>((g, s) => ({ ...g, [s.key]: true }), {});
    return acc;
  }, {} as Sections);
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
 */
export default function MobileControlPage() {
  const [saved, setSaved] = useState<MobileConfig | null>(null);
  const [draft, setDraft] = useState<MobileConfig>(FALLBACK);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [open, setOpen] = useState<FeatureKey | null>("dashboard");
  const [previewTab, setPreviewTab] = useState<FeatureKey>("dashboard");

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

  const dirty = useMemo(
    () => (saved ? JSON.stringify(saved) !== JSON.stringify(draft) : false),
    [saved, draft]
  );

  // The API refuses these, so the button that would trigger the refusal is
  // disabled and says why, rather than letting the operator find out from a red
  // banner after pressing Save.
  const blockedReason = useMemo(() => {
    if (draft.advisory.active && draft.advisory.message.trim().length < 8) {
      return "A published advisory needs at least 8 characters.";
    }
    if (!Object.values(draft.features).some(Boolean)) {
      return "At least one tab must stay on, or the app opens to nothing.";
    }
    for (const f of FEATURES) {
      if (!f.needsOne || !draft.features[f.key]) continue;
      const group = draft.sections[f.key] ?? {};
      if (!f.sections.some((s) => group[s.key])) {
        return `${f.label} has every section switched off. Switch the whole tab off instead.`;
      }
    }
    return null;
  }, [draft]);

  const save = async () => {
    if (blockedReason) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${BACKEND}/api/mobile-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
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

  const setFeature = (key: FeatureKey, on: boolean) =>
    setDraft((d) => ({ ...d, features: { ...d.features, [key]: on } }));

  const setSection = (tab: FeatureKey, key: string, on: boolean) =>
    setDraft((d) => ({
      ...d,
      sections: { ...d.sections, [tab]: { ...(d.sections[tab] ?? {}), [key]: on } },
    }));

  const onCount = Object.values(draft.features).filter(Boolean).length;
  const previewMeta = FEATURES.find((f) => f.key === previewTab) ?? FEATURES[0];
  const previewSections = previewMeta.sections.filter((s) => draft.sections[previewMeta.key]?.[s.key]);

  return (
    <section className="ds-content ds-long">
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
          <article className="panel ds-mc-panel">
            <header className="ds-mc-panel-head">
              <div>
                <h2>Tabs &amp; what is inside them</h2>
                <p>
                  The switch on a tab decides whether it exists at all. Open a tab to choose which
                  parts of that screen travellers get. {onCount} of {FEATURES.length} tabs on.
                </p>
              </div>
            </header>

            <ul className="ds-mc-features">
              {FEATURES.map((f) => {
                const { key, label, icon: Icon, blurb } = f;
                const on = draft.features[key];
                const group = draft.sections[key] ?? {};
                const sectionsOn = f.sections.filter((s) => group[s.key]).length;
                const expanded = open === key;
                const emptied = f.needsOne && on && sectionsOn === 0;

                return (
                  <li key={key} className={`${on ? "is-on" : "is-off"}${expanded ? " is-open" : ""}`}>
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
                        <span className={`ds-mc-count${emptied ? " is-bad" : ""}`}>
                          {sectionsOn}/{f.sections.length}
                          <ChevronDown size={15} aria-hidden="true" />
                        </span>
                      </button>

                      <label className="ds-switch">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={loading}
                          onChange={(e) => setFeature(key, e.target.checked)}
                        />
                        <span className="ds-switch-track" aria-hidden="true">
                          <span className="ds-switch-thumb" />
                        </span>
                        <span className="sr-only">{`${label} tab`}</span>
                      </label>
                    </div>

                    {expanded && (
                      <div className="ds-mc-sections" id={`sections-${key}`}>
                        {!on && (
                          <p className="ds-mc-sections-note">
                            This tab is switched off, so none of these are reachable. They are kept
                            as they are and take effect again if the tab comes back.
                          </p>
                        )}
                        {emptied && (
                          <p className="ds-mc-sections-note is-bad">
                            Every section is off while the tab is on, which would open an empty
                            screen. Turn one back on, or switch the whole tab off.
                          </p>
                        )}
                        <ul>
                          {f.sections.map((s) => (
                            <li key={s.key}>
                              <span className="ds-mc-section-text">
                                <b>{s.label}</b>
                                <span>{s.blurb}</span>
                              </span>
                              <label className="ds-switch is-small">
                                <input
                                  type="checkbox"
                                  checked={Boolean(group[s.key])}
                                  disabled={loading || !on}
                                  onChange={(e) => setSection(key, s.key, e.target.checked)}
                                />
                                <span className="ds-switch-track" aria-hidden="true">
                                  <span className="ds-switch-thumb" />
                                </span>
                                <span className="sr-only">{`${label}: ${s.label}`}</span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </article>

          <article className="panel ds-mc-panel">
            <header className="ds-mc-panel-head">
              <div>
                <h2>Published advisory</h2>
                <p>
                  One message, broadcast to the Alerts tab of every phone. It appears above the
                  app&apos;s own traffic and maintenance notices.
                </p>
              </div>
              <label className="ds-switch">
                <input
                  type="checkbox"
                  checked={draft.advisory.active}
                  disabled={loading}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, advisory: { ...d.advisory, active: e.target.checked } }))
                  }
                />
                <span className="ds-switch-track" aria-hidden="true">
                  <span className="ds-switch-thumb" />
                </span>
                <span className="sr-only">Publish advisory</span>
              </label>
            </header>

            <div className="ds-mc-tones" role="group" aria-label="Advisory tone">
              {TONES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`ds-mc-tone is-${t.key}${draft.advisory.tone === t.key ? " is-active" : ""}`}
                  aria-pressed={draft.advisory.tone === t.key}
                  onClick={() => setDraft((d) => ({ ...d, advisory: { ...d.advisory, tone: t.key } }))}
                >
                  <b>{t.label}</b>
                  <span>{t.hint}</span>
                </button>
              ))}
            </div>

            <label className="ds-mc-field">
              <span>Message</span>
              <textarea
                rows={3}
                maxLength={MAX_MESSAGE}
                value={draft.advisory.message}
                disabled={loading}
                placeholder="e.g. Lane closure at Km 15.2 southbound until 06:00. Expect delays."
                onChange={(e) =>
                  setDraft((d) => ({ ...d, advisory: { ...d.advisory, message: e.target.value } }))
                }
              />
              <small className={draft.advisory.message.length > MAX_MESSAGE - 30 ? "is-near" : ""}>
                {draft.advisory.message.length} / {MAX_MESSAGE}
              </small>
            </label>
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
                <p>
                  {previewMeta.label} as these settings would leave it. Unsaved changes included.
                </p>
              </div>
            </header>

            <div className="ds-phone" aria-label="Mobile app preview">
              <div className="ds-phone-screen">
                <div className="ds-phone-status">
                  <span>{previewMeta.label}</span>
                  <span className="ds-phone-dot" aria-hidden="true" />
                </div>

                {/* The advisory rides on the Alerts screen, so it only appears
                    in the preview when that is the screen being previewed. */}
                {previewTab === "alerts" &&
                  (draft.advisory.active && draft.advisory.message.trim().length > 0 ? (
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
                  ) : (
                    <div className="ds-phone-empty">No advisory published</div>
                  ))}

                <div className="ds-phone-body">
                  {!draft.features[previewTab] ? (
                    <div className="ds-phone-empty">
                      Tab switched off — travellers never reach this screen.
                    </div>
                  ) : previewSections.length === 0 ? (
                    <div className="ds-phone-empty is-bad">
                      Nothing left to show on this screen.
                    </div>
                  ) : (
                    previewSections.map((s) => (
                      <span key={s.key} className="ds-phone-section">
                        {s.label}
                      </span>
                    ))
                  )}
                </div>

                <nav className="ds-phone-tabs">
                  {FEATURES.map(({ key, label, icon: Icon }) => (
                    <button
                      key={key}
                      type="button"
                      className={`ds-phone-tab${draft.features[key] ? "" : " is-hidden"}${
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

            <p className="ds-mc-note">
              Tap a tab to preview it. Tabs switched off are dropped from the bar entirely rather
              than greyed out, so the remaining ones spread to fill it.
            </p>
          </article>
        </aside>
      </div>

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
