"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { Clock, KeyRound, LogOut, MonitorSmartphone, Palette, Settings as SettingsIcon, ShieldCheck, User } from "lucide-react";
import PageHeader from "../../../components/dashboard/PageHeader";
import ThemeToggle from "../../../components/dashboard/ThemeToggle";
import EffectsToggle from "../../../components/dashboard/EffectsToggle";
import { supabase } from "../../../lib/supabase";
import { logActivity, notifyPasswordChanged } from "../../../lib/backend-auth";
import { useToast } from "../../../lib/toast";
import { passedCode, secondStepProblem, submitCode, verifiedFactorId } from "../../../lib/mfa";
import {
  IDLE_CHOICES,
  deviceTrust,
  displayNameOf,
  forgetDeviceTrust,
  idleMinutesOf,
  passwordCooldownUntil,
  passwordStamps,
  PASSWORD_COOLDOWN_DAYS,
  rememberedEmail,
  setRememberedEmail,
  type DeviceTrust,
} from "../../../lib/account-device";

/* Settings (19 Oct 2026, user request): the reader's own account and this browser.
 *
 *   - Profile: the name the dashboard shows. Email and role are shown, not edited: the email is the
 *     sign-in, and roles are set by an administrator.
 *   - Sign-out after inactivity: 5 to 60 minutes, 15 by default (components/dashboard/IdleGuard.tsx).
 *   - Password: a new one, behind the authenticator code when this session skipped it on a remembered
 *     device, since Supabase will not change the password of an account with an authenticator without it.
 *   - This device: the remembered email and the 7-day device pass, each forgettable.
 *   - Sign out of all devices, and the appearance switches from the top bar.
 *
 * Name and idle time are kept on the account (Supabase user metadata), so they follow the person to any
 * browser. Every change is entered in the audit log.
 */

const ROLE_NAME: Record<string, string> = {
  "tcc-operator": "TCC Operator",
  "incident-operator": "Incident Operator",
  "data-analyst": "Data Analyst",
};

function passwordProblem(error: unknown): string {
  const e = (error ?? {}) as { code?: string; message?: string };
  if (e.code === "same_password") return "Choose a password different from your current one.";
  if (e.code === "weak_password") return e.message || "That password is too weak. Use at least 8 characters with letters and numbers.";
  if (e.code === "insufficient_aal") return "Enter your authenticator code first.";
  if (e.code === "reauthentication_needed") return "For security, sign out and sign in again before changing your password.";
  return e.message || "The password could not be changed. Try again.";
}

const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Section({ icon: Icon, title, hint, children }: { icon: typeof User; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="st-card">
      <header className="st-card-head">
        <span className="st-card-icon" aria-hidden="true"><Icon size={17} strokeWidth={2.2} /></span>
        <div>
          <h2 className="st-card-title">{title}</h2>
          <p className="st-card-hint">{hint}</p>
        </div>
      </header>
      <div className="st-card-body">{children}</div>
    </section>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const toast = useToast();
  const [session, setSession] = useState<Session | null>(null);

  // Profile
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  // Inactivity
  const [idle, setIdle] = useState<number>(15);
  const [savingIdle, setSavingIdle] = useState<number | null>(null);
  // Password
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwCode, setPwCode] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [pwError, setPwError] = useState("");
  // This device
  const [trust, setTrust] = useState<DeviceTrust | null>(null);
  const [savedEmail, setSavedEmail] = useState("");
  // Everywhere
  const [confirmEverywhere, setConfirmEverywhere] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const adopt = (s: Session | null) => {
      setSession(s);
      if (!s) return;
      setIdle(idleMinutesOf(s.user.user_metadata));
    };
    void supabase.auth.getSession().then(({ data }) => {
      adopt(data.session);
      if (data.session) setName(displayNameOf(data.session.user.user_metadata, ""));
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => adopt(s));
    setTrust(deviceTrust());
    setSavedEmail(rememberedEmail());
    return () => subscription.unsubscribe();
  }, []);

  const user = session?.user;
  const currentName = displayNameOf(user?.user_metadata, "");
  const nameChanged = name.trim() !== currentName && name.trim().length > 0;
  const needsCode = !!session && !passedCode(session);
  const cooldownUntil = passwordCooldownUntil(user?.user_metadata);
  const lastChanged = typeof user?.user_metadata?.password_changed_at === "string" ? user.user_metadata.password_changed_at : null;

  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    if (!nameChanged || savingName) return;
    setSavingName(true);
    const { error } = await supabase.auth.updateUser({ data: { display_name: name.trim() } });
    setSavingName(false);
    if (error) return toast.error(error.message || "Your name could not be saved.");
    // The fresh session's token: updateUser can reissue it, and the log entry was recorded as "anonymous" (2 Nov 2026).
    void supabase.auth.getSession().then(({ data }) => logActivity({ type: "settings.updated", fields: ["display_name"] }, data.session?.access_token));
    toast.success("Name saved.");
  }

  async function saveIdle(minutes: number) {
    if (minutes === idle || savingIdle != null) return;
    setSavingIdle(minutes);
    const { error } = await supabase.auth.updateUser({ data: { idle_minutes: minutes } });
    setSavingIdle(null);
    if (error) return toast.error(error.message || "The setting could not be saved.");
    setIdle(minutes);
    void supabase.auth.getSession().then(({ data }) => logActivity({ type: "settings.updated", fields: ["idle_minutes"] }, data.session?.access_token));
    toast.success(`You'll be signed out after ${minutes} minutes without activity.`);
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    if (savingPw) return;
    setPwError("");
    if (cooldownUntil) return setPwError(`You can change your password again on ${fmtDay(cooldownUntil)}.`);
    if (pw.length < 8) return setPwError("Use at least 8 characters.");
    if (pw !== pw2) return setPwError("The two passwords do not match.");
    setSavingPw(true);
    try {
      if (needsCode) {
        if (!/^\d{6}$/.test(pwCode)) {
          setPwError("Enter the 6-digit code from your authenticator app.");
          setSavingPw(false);
          return;
        }
        const factorId = await verifiedFactorId();
        if (factorId) await submitCode(factorId, pwCode);
      }
    } catch (err: unknown) {
      setPwError(secondStepProblem(err));
      setPwCode("");
      setSavingPw(false);
      return;
    }
    // The new password, and the stamps that start the cool-down and revoke every remembered device.
    const { error } = await supabase.auth.updateUser({ password: pw, data: passwordStamps() });
    if (error) {
      setSavingPw(false);
      return setPwError(passwordProblem(error));
    }
    forgetDeviceTrust();
    setTrust(null);
    setPw("");
    setPw2("");
    setPwCode("");
    void logActivity({ type: "session.password_changed" });
    const emailed = await notifyPasswordChanged("settings");
    setSavingPw(false);
    toast.success(
      "Password changed.",
      `${emailed ? "We emailed you a confirmation. " : ""}Remembered devices will ask for your authenticator code again.`,
    );
  }

  function forgetThisDevice() {
    forgetDeviceTrust();
    setTrust(null);
    toast.info("This device is forgotten. The next sign-in here will ask for your authenticator code.");
  }

  function forgetEmail() {
    setRememberedEmail(null);
    setSavedEmail("");
    toast.info("Your email will no longer be filled in on this device.");
  }

  async function signOutEverywhere() {
    setLeaving(true);
    await Promise.race([logActivity({ type: "session.signed_out_everywhere" }), new Promise((r) => setTimeout(r, 1500))]);
    // Every remembered device of the account too, not just this one (Back-End/src/lib/device-trust.ts).
    await supabase.auth.updateUser({ data: { trust_revoked_at: Date.now() } }).catch(() => undefined);
    forgetDeviceTrust();
    try {
      await supabase.auth.signOut({ scope: "global" });
    } catch {
      /* this browser's tokens are cleared regardless */
    }
    router.replace("/");
  }

  return (
    <section className="ds-content st-page">
      <PageHeader icon={SettingsIcon} title="Settings" subtitle="Your account, your security, and this device" />

      <div className="st-grid">
        <Section icon={User} title="Profile" hint="How you appear in the dashboard and the audit log.">
          <form className="st-form" onSubmit={saveName}>
            <label className="st-field">
              <span className="st-label">Display name</span>
              <input className="ms-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Your name" autoComplete="name" />
            </label>
            <div className="st-readonly">
              <div><span className="st-label">Email</span><b>{user?.email ?? "—"}</b></div>
              <div><span className="st-label">Role</span><b>{ROLE_NAME[String(user?.user_metadata?.role)] ?? "—"}</b></div>
            </div>
            <p className="st-note">Your email is how you sign in, and roles are set by an administrator.</p>
            <div className="st-actions">
              <button type="submit" className="btn-primary" disabled={!nameChanged || savingName}>{savingName ? "Saving…" : "Save name"}</button>
            </div>
          </form>
        </Section>

        <Section icon={Clock} title="Sign out after inactivity" hint="For your security, the dashboard signs you out when nobody has used it for a while.">
          <div className="st-choices" role="radiogroup" aria-label="Minutes without activity before signing out">
            {IDLE_CHOICES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={idle === m}
                className={`st-choice${idle === m ? " is-on" : ""}`}
                disabled={savingIdle != null}
                onClick={() => void saveIdle(m)}
              >
                <b>{m}</b> min{m === 15 ? <span className="st-default">default</span> : null}
              </button>
            ))}
          </div>
          <p className="st-note">
            You get a minute&rsquo;s warning first. Activity in any open dashboard tab counts. This setting follows your
            account to every device.
          </p>
        </Section>

        <Section icon={KeyRound} title="Password" hint={`At least 8 characters. After a change, the next one is possible ${PASSWORD_COOLDOWN_DAYS} days later.`}>
          {cooldownUntil ? (
            <div className="st-cooldown" role="status">
              <b>You can change your password again on {fmtDay(cooldownUntil)}.</b>
              <span>
                It was last changed on {lastChanged ? fmtDay(new Date(lastChanged)) : "a recent date"}. For your security, a password can be changed
                once every {PASSWORD_COOLDOWN_DAYS} days, by reset too. If you forget it before then, contact your administrator.
              </span>
            </div>
          ) : (
          <form className="st-form" onSubmit={savePassword} noValidate>
            <label className="st-field">
              <span className="st-label">New password</span>
              <input className="ms-input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" />
            </label>
            <label className="st-field">
              <span className="st-label">Confirm new password</span>
              <input className="ms-input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Type it again" />
            </label>
            {needsCode && (
              <label className="st-field">
                <span className="st-label">Authenticator code</span>
                <input className="ms-input st-code" inputMode="numeric" autoComplete="one-time-code" value={pwCode} onChange={(e) => setPwCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6-digit code" />
                <span className="st-note">You signed in on a remembered device, so confirm it&rsquo;s you before changing the password.</span>
              </label>
            )}
            {pwError && <p className="st-error" role="alert">{pwError}</p>}
            <div className="st-actions">
              <button type="submit" className="btn-primary" disabled={savingPw || !pw || !pw2}>{savingPw ? "Saving…" : "Change password"}</button>
            </div>
          </form>
          )}
        </Section>

        <Section icon={MonitorSmartphone} title="This device" hint="What this browser remembers about you. Forgetting it here does not affect your other devices.">
          <div className="st-rows">
            <div className="st-row">
              <ShieldCheck size={18} aria-hidden="true" className={trust ? "st-ok" : "st-muted"} />
              <div className="st-row-text">
                <b>{trust ? "Remembered for sign-in" : "Not remembered"}</b>
                <span>
                  {trust
                    ? `Signing in here skips the authenticator code until ${fmtDate(trust.expiresAt)}. Your password is still needed.`
                    : "Tick “Remember this device for 7 days” at the code step to skip the code here for a week."}
                </span>
              </div>
              {trust && <button type="button" className="btn-muted" onClick={forgetThisDevice}>Forget this device</button>}
            </div>
            <div className="st-row">
              <User size={18} aria-hidden="true" className={savedEmail ? "st-ok" : "st-muted"} />
              <div className="st-row-text">
                <b>{savedEmail ? "Email remembered" : "Email not remembered"}</b>
                <span>{savedEmail ? `${savedEmail} is filled in on the sign-in page.` : "Tick “Remember me” when signing in to have your email filled in."}</span>
              </div>
              {savedEmail && <button type="button" className="btn-muted" onClick={forgetEmail}>Forget email</button>}
            </div>
          </div>
        </Section>

        <Section icon={LogOut} title="Sign out of all devices" hint="Ends your session on every browser and phone, including this one.">
          <p className="st-note">
            Use this if you signed in on a shared or lost device. Each device will need your password again, and every
            remembered device will ask for the authenticator code again.
          </p>
          <div className="st-actions">
            {confirmEverywhere ? (
              <>
                <button type="button" className="btn-muted" onClick={() => setConfirmEverywhere(false)} disabled={leaving}>Cancel</button>
                <button type="button" className="btn-danger" onClick={() => void signOutEverywhere()} disabled={leaving}>{leaving ? "Signing out…" : "Yes, sign out everywhere"}</button>
              </>
            ) : (
              <button type="button" className="btn-muted" onClick={() => setConfirmEverywhere(true)}>Sign out of all devices</button>
            )}
          </div>
        </Section>

        <Section icon={Palette} title="Appearance" hint="The same switches as the top bar, kept on this device.">
          <div className="st-rows">
            <div className="st-row">
              <div className="st-row-text"><b>Theme</b><span>Light, dark, or follow your system.</span></div>
              <ThemeToggle />
            </div>
            <div className="st-row">
              <div className="st-row-text"><b>Visual effects</b><span>The moving scenery and animations. Turn off for a calmer screen.</span></div>
              <EffectsToggle />
            </div>
          </div>
        </Section>
      </div>
    </section>
  );
}
