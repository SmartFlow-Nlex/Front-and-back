"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Bot,
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

type MobileConfig = {
  features: Record<FeatureKey, boolean>;
  advisory: { active: boolean; tone: AdvisoryTone; message: string };
};

type Meta = { source: "db" | "defaults"; updatedAt: string | null; updatedBy: string | null };

/* One entry per tab in frontend/app/(tabs)/_layout.tsx. `label` is the word the
   traveller sees on the tab bar, so the preview below can be trusted as a
   picture of the app rather than an approximation of it. */
const FEATURES: { key: FeatureKey; label: string; icon: typeof MapIcon; blurb: string }[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    blurb: "Corridor conditions at a glance — the screen the app opens on.",
  },
  {
    key: "map",
    label: "Corridor",
    icon: MapIcon,
    blurb: "The live map. Reads the same real-time feed as the Live Map page here.",
  },
  {
    key: "community",
    label: "Community",
    icon: Users,
    blurb: "Traveller-submitted reports. Turn off to suspend posting during moderation.",
  },
  {
    key: "assistant",
    label: "Assistant",
    icon: Bot,
    blurb: "Conversational lookup of corridor conditions.",
  },
  {
    key: "alerts",
    label: "Alerts",
    icon: Bell,
    blurb: "Traffic and maintenance notices, plus any advisory published below.",
  },
];

const TONES: { key: AdvisoryTone; label: string; hint: string }[] = [
  { key: "info", label: "Info", hint: "General notice" },
  { key: "warning", label: "Warning", hint: "Plan around it" },
  { key: "critical", label: "Critical", hint: "Act now" },
];

const MAX_MESSAGE = 280;

const FALLBACK: MobileConfig = {
  features: { dashboard: true, map: true, community: true, assistant: true, alerts: true },
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

  // The API refuses to publish a blank advisory, so the button that would
  // trigger that refusal is disabled and says why, rather than letting the
  // operator find out from a red banner after pressing Save.
  const blockedReason = useMemo(() => {
    if (draft.advisory.active && draft.advisory.message.trim().length < 8) {
      return "A published advisory needs at least 8 characters.";
    }
    if (!Object.values(draft.features).some(Boolean)) {
      return "At least one tab must stay on, or the app opens to nothing.";
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

  const onCount = Object.values(draft.features).filter(Boolean).length;

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
                <h2>Features</h2>
                <p>
                  Each switch hides or shows a tab for every user of the app. {onCount} of{" "}
                  {FEATURES.length} on.
                </p>
              </div>
            </header>

            <ul className="ds-mc-features">
              {FEATURES.map(({ key, label, icon: Icon, blurb }) => {
                const on = draft.features[key];
                return (
                  <li key={key} className={on ? "is-on" : "is-off"}>
                    <span className="ds-mc-feature-icon" aria-hidden="true">
                      <Icon size={17} />
                    </span>
                    <div className="ds-mc-feature-text">
                      <b>{label}</b>
                      <span>{blurb}</span>
                    </div>
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
                <p>The app as these settings would leave it. Unsaved changes included.</p>
              </div>
            </header>

            <div className="ds-phone" aria-label="Mobile app preview">
              <div className="ds-phone-screen">
                <div className="ds-phone-status">
                  <span>SmartFlow</span>
                  <span className="ds-phone-dot" aria-hidden="true" />
                </div>

                {draft.advisory.active && draft.advisory.message.trim().length > 0 ? (
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
                )}

                <div className="ds-phone-body" aria-hidden="true">
                  <span className="ds-phone-line w70" />
                  <span className="ds-phone-line w45" />
                  <span className="ds-phone-card" />
                  <span className="ds-phone-line w60" />
                  <span className="ds-phone-line w35" />
                </div>

                <nav className="ds-phone-tabs">
                  {FEATURES.map(({ key, label, icon: Icon }) => (
                    <span
                      key={key}
                      className={`ds-phone-tab${draft.features[key] ? "" : " is-hidden"}`}
                      title={draft.features[key] ? label : `${label} — hidden`}
                    >
                      <Icon size={15} aria-hidden="true" />
                      <small>{label}</small>
                    </span>
                  ))}
                </nav>
              </div>
            </div>

            <p className="ds-mc-note">
              Tabs switched off are dropped from the bar entirely rather than greyed out, so the
              remaining ones spread to fill it.
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
