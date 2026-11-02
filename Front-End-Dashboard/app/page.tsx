"use client";

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Mail, Lock, Eye, EyeOff, Pause, Play, ArrowRight, ArrowLeft, ShieldCheck, RotateCw } from "lucide-react";
import { supabase } from '../lib/supabase';
import { deviceTrustHeader, logActivity, notifyPasswordChanged } from "../lib/backend-auth";
import {
  beginSecondStep,
  dropPasswordOnlySession,
  groupKey,
  isFullySignedIn,
  secondStepProblem,
  signInTimedOut,
  submitCode,
  verifiedFactorId,
  type SecondStep,
} from "../lib/mfa";
import {
  deviceTrustFor,
  forgetDeviceTrust,
  cooldownMessage,
  markActivity,
  passwordStamps,
  rememberedEmail,
  saveDeviceTrust,
  setRememberedEmail,
} from "../lib/account-device";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";
import TitleReveal from '../components/stage/TitleReveal';
import EffectsToggle from '../components/dashboard/EffectsToggle';
import ThemeToggle from '../components/dashboard/ThemeToggle';
import NlexEnvironment from '../components/environment/NlexEnvironment';

/* Sign-in (redesigned 7 Oct 2026 after the user's reference): the user's own artwork of the mascot
   driving toward the reader (public/light_login.png and dark_login.png), the story on the left above
   the mascot, and a frosted glass sign-in card on the right. Styles: app/styles/nlex-signin.css. */

/* The four sign-in stories. Copy is taken from PRODUCT.md, verbatim from the
   redesign brief; it makes no claim the product does not. A "\n" sets the line
   break, and `accent` is the word set in NLEX blue. */
const STORIES = [
  {
    label: "Forecast",
    title: "Forecast,\nNot Just Live",
    accent: "Live",
    body: "Congestion, incidents, volume and emissions per exit and per hour, up to seven days ahead, with the action to take next.",
  },
  {
    label: "Validation",
    title: "Honest\nValidation",
    accent: "Honest",
    body: "Every model states how it was tested, how it scores against simple baselines, and how its served forecasts compared with what actually happened.",
  },
  {
    label: "Corridor",
    title: "One Corridor,\nOne View",
    accent: "View",
    body: "Live Waze jams, Waze history since 2022, toll volumes, incident logs, weather and events, joined in one warehouse from Balintawak to Sta. Ines.",
  },
  {
    label: "Drivers",
    title: "Connected\nto Drivers",
    accent: "Drivers",
    body: "Operators publish advisories and decide what the companion mobile app shows commuters.",
  },
] as const;

const STORY_MS = 7000;

type Lights = "" | "flash" | "error";

/* Sign-in has two steps (lib/mfa.ts): the password, then a code from the operator's authenticator
   app. An account that has no authenticator yet adds one at the second step instead.

   A forgotten password (19 Oct 2026, user request) is reset here too: the email address, then the code
   Supabase emails to it, then -- for an account with an authenticator, because Supabase will not change
   such an account's password without it -- the authenticator code, then the new password. */
type Step =
  | { kind: "password" }
  | SecondStep
  | { kind: "forgot-email" }
  | { kind: "forgot-code"; email: string }
  | { kind: "forgot-mfa"; factorId: string }
  | { kind: "forgot-new" };

const isForgot = (k: Step["kind"]) => k.startsWith("forgot-");
const RESEND_AFTER_S = 60;

/** Say what went wrong while resetting a password, and what to do about it. */
function resetProblem(error: unknown): string {
  const e = (error ?? {}) as { code?: string; status?: number; message?: string };
  if (e.code === "otp_expired" || /expired|invalid/i.test(e.message ?? ""))
    return "That code is wrong or has expired. Use the code in the newest email, or send a new one.";
  if (e.code === "same_password") return "Choose a password different from your old one.";
  if (e.code === "weak_password") return e.message || "That password is too weak. Use at least 8 characters with letters and numbers.";
  if (e.code === "over_email_send_rate_limit" || e.code === "over_request_rate_limit" || e.status === 429)
    return "Too many emails were requested. Wait a minute, then try again.";
  if (e.code === "insufficient_aal") return "Enter your authenticator code before choosing a new password.";
  return e.message || "Something went wrong. Try again.";
}

export default function Home() {
  const [showPassword, setShowPassword] = useState(false);
  // "Remember me" keeps the email address on this browser (lib/account-device.ts), filled in next time.
  const [rememberMe, setRememberMe] = useState(false);

  // Sign in form state. Email only: there are no usernames in this system (19 Oct 2026).
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");

  // "Remember this device for 7 days", offered at the code step.
  const [trustDevice, setTrustDevice] = useState(false);
  // Whether the server can remember devices (GET /api/auth/trusted-device/status); null until it answers.
  const [trustAvailable, setTrustAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND}/api/auth/trusted-device/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setTrustAvailable(Boolean(j?.data?.enabled)); })
      .catch(() => { if (!cancelled) setTrustAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  // Resetting a forgotten password.
  const [resetEmail, setResetEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resendIn, setResendIn] = useState(0);

  // Loading and Error States
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // The second step, and the code typed into it.
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [code, setCode] = useState("");
  const [keyCopied, setKeyCopied] = useState(false);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const passwordSent = useRef(false); // a password has been submitted in this visit
  const checking = useRef(false); // a code is being checked right now
  const [stepped, setStepped] = useState(false); // the card has shown a second step at least once

  function goToDashboard() {
    // Navie introduces itself on the first Overview visit after this sign-in (components/overview/NavieGreeting).
    try {
      sessionStorage.setItem("smartflow-just-signed-in", String(Date.now()));
    } catch {
      /* storage blocked: Navie greets as on a return visit */
    }
    window.location.assign('/dashboard');
  }

  // A session found when the page opens (a closed tab reopened, a reload, a bounce back from the dashboard):
  //   - signed in with "Remember me" ticked: carried on. Past both steps, the dashboard opens; past the
  //     password only, the card opens at the code step ("You're signed in, the code is still needed").
  //     The code is still asked for: only the password is not typed again (3 Nov 2026, user request).
  //   - without "Remember me", a session that stopped after the password is not resumed (lib/mfa.ts),
  //     so a half-finished sign-in on a shared PC cannot be picked up by the next person.
  // The link in a password-reset email is left alone: its session is meant only for a new password.
  const viaResetLink = useRef(false);
  const [resumedAs, setResumedAs] = useState(""); // the email of a sign-in carried on at the code step
  useEffect(() => {
    viaResetLink.current = /type=recovery/.test(window.location.hash);
    void supabase.auth.getSession().then(async ({ data }) => {
      const s = data.session;
      if (!s || passwordSent.current || viaResetLink.current) return;
      const email = (s.user.email ?? "").trim().toLowerCase();
      const remembered = !!email && rememberedEmail() === email;
      if (isFullySignedIn(s)) {
        if (remembered) window.location.assign("/dashboard");
        return;
      }
      if (!remembered) {
        dropPasswordOnlySession();
        return;
      }
      passwordSent.current = true;
      try {
        const next = await beginSecondStep();
        setStepped(true);
        setCode("");
        setResumedAs(s.user.email ?? email);
        setStep(next);
      } catch {
        passwordSent.current = false;
        dropPasswordOnlySession();
      }
    });
    const remembered = rememberedEmail();
    if (remembered) {
      setSignInEmail(remembered);
      setRememberMe(true);
    }
    // Back from the dashboard after a spell of inactivity (lib/idle.ts): say so, then tidy the address.
    const params = new URLSearchParams(window.location.search);
    if (params.get("signedOut") === "idle") {
      const minutes = Number(params.get("after"));
      setSuccessMessage(`You were signed out after ${Number.isFinite(minutes) && minutes > 0 ? `${minutes} minutes` : "a while"} without activity. Sign in again to continue.`);
      window.history.replaceState(null, "", window.location.pathname);
    }
    // The link in Navie's reset email: redeem its token here, then carry on to the new password.
    const resetHash = params.get("reset");
    if (resetHash) {
      passwordSent.current = true;
      window.history.replaceState(null, "", window.location.pathname);
      setStepped(true);
      setIsLoading(true);
      void supabase.auth.verifyOtp({ token_hash: resetHash, type: "recovery" }).then(async ({ error }) => {
        if (error) {
          setIsLoading(false);
          setStep({ kind: "forgot-email" });
          setErrorMessage("That reset link has expired or was already used. Send yourself a new one.");
          return;
        }
        await afterResetVerified();
        setIsLoading(false);
      });
    }
    // The reset link lands here with a recovery session: carry on from it.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "PASSWORD_RECOVERY") return;
      window.history.replaceState(null, "", window.location.pathname);
      setTimeout(() => void afterResetVerified(), 0);
    });
    return () => subscription.unsubscribe();
    // afterResetVerified only reads setters and Supabase; running this once is the point
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The resend countdown for the reset email.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = window.setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [resendIn]);

  async function handleSignInSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (isLoading) return;
    setErrorMessage("");
    setSuccessMessage("");
    setIsLoading(true);
    passwordSent.current = true;

    try {
      const email = signInEmail.trim();
      const { data: signedIn, error } = await supabase.auth.signInWithPassword({
        email,
        password: signInPassword,
      });

      if (error) {
        setErrorMessage(error.message);
        setIsLoading(false);
        return;
      }

      setRememberedEmail(rememberMe ? email : null);

      // A remembered device skips the code, if the backend still honours its pass for this account.
      const userId = signedIn.user?.id ?? null;
      const accessToken = signedIn.session?.access_token ?? null;
      if (accessToken && deviceTrustFor(userId)) {
        const honoured = await fetch(`${BACKEND}/api/auth/trusted-device/check`, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, ...deviceTrustHeader(userId) },
        }).then((r) => r.ok).catch(() => false);
        if (honoured) {
          markActivity();
          await Promise.race([logActivity({ type: "session.login" }, accessToken), new Promise((r) => setTimeout(r, 1500))]);
          goToDashboard();
          return;
        }
        forgetDeviceTrust(); // expired, revoked or for another server: ask for the code as usual
      }

      // The password was right. That opens nothing yet: the code does.
      setResumedAs("");
      try {
        const next = await beginSecondStep();
        setStepped(true);
        setCode("");
        setStep(next);
      } catch (err: unknown) {
        dropPasswordOnlySession();
        setErrorMessage(secondStepProblem(err));
      }
      setIsLoading(false);
    } catch (_err: unknown) {
      setErrorMessage("An unexpected error occurred. Please try again.");
      setIsLoading(false);
    }
  }

  /** Back to the password, ending the half-finished sign-in (or password reset). */
  function backToPassword() {
    dropPasswordOnlySession();
    setResumedAs("");
    setErrorMessage("");
    setCode("");
    setSignInPassword("");
    setKeyCopied(false);
    setNewPassword("");
    setConfirmPassword("");
    setStep({ kind: "password" });
  }

  /* ---- Forgotten password ---- */

  function startForgot() {
    setErrorMessage("");
    setSuccessMessage("");
    setResetEmail(signInEmail.trim());
    setStepped(true);
    setStep({ kind: "forgot-email" });
  }

  async function sendResetCode(email: string) {
    setErrorMessage("");
    setIsLoading(true);
    /* Navie sends the email when the backend is set up for it (19 Oct 2026): a 6-digit code and a link, from
       the Navie mailbox (Back-End/src/routes/auth.routes.ts). Otherwise Supabase sends its own email, which
       carries a link only, unless the project's template adds a code. */
    let via: "navie" | "supabase" = "supabase";
    try {
      const r = await fetch(`${BACKEND}/api/auth/password-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const j = await r.json().catch(() => null);
      // Navie sent either the reset link or, inside the 30-day wait, a notice saying when the next change is
      // allowed (Back-End/src/routes/auth.routes.ts). The page is not told which: the inbox is.
      if (r.ok) via = "navie";
      else if (r.status !== 503) {
        setIsLoading(false);
        setErrorMessage(resetProblem({ code: j?.code, status: r.status, message: j?.message }));
        return;
      }
    } catch {
      /* backend unreachable: Supabase sends it instead */
    }
    if (via === "supabase") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/` });
      if (error) {
        setIsLoading(false);
        setErrorMessage(resetProblem(error));
        return;
      }
    }
    setIsLoading(false);
    setResendIn(RESEND_AFTER_S);
    setStep({ kind: "forgot-code", email });
  }

  function handleResetEmailSubmit(event: React.FormEvent) {
    event.preventDefault();
    const email = resetEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setErrorMessage("Enter the email address you sign in with.");
      return;
    }
    void sendResetCode(email);
  }

  /** The emailed code (or link) was right: the session it opened may only change the password. */
  async function afterResetVerified() {
    // Within 30 days of the last change the reset ends here (19 Oct 2026, user request): say so, and close
    // the session the link opened so it cannot change anything.
    const { data: s } = await supabase.auth.getSession();
    const refused = cooldownMessage(s.session?.user.user_metadata);
    if (refused) {
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        /* local tokens are cleared regardless */
      }
      setStep({ kind: "password" });
      setSuccessMessage("");
      setErrorMessage(refused);
      return;
    }
    try {
      const factorId = await verifiedFactorId();
      setCode("");
      setErrorMessage("");
      setStepped(true);
      setStep(factorId ? { kind: "forgot-mfa", factorId } : { kind: "forgot-new" });
    } catch (err: unknown) {
      setErrorMessage(resetProblem(err));
    }
  }

  async function handleResetMfaSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (step.kind !== "forgot-mfa" || isLoading) return;
    if (!/^\d{6}$/.test(code)) {
      setErrorMessage("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setErrorMessage("");
    setIsLoading(true);
    try {
      await submitCode(step.factorId, code);
      setCode("");
      setStep({ kind: "forgot-new" });
    } catch (err: unknown) {
      setCode("");
      setErrorMessage(secondStepProblem(err));
    }
    setIsLoading(false);
  }

  async function handleNewPasswordSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (isLoading) return;
    if (newPassword.length < 8) {
      setErrorMessage("Use at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage("The two passwords do not match.");
      return;
    }
    setErrorMessage("");
    setIsLoading(true);
    // The stamps revoke every remembered device and start the 30-day cool-down (lib/account-device.ts).
    const { data, error } = await supabase.auth.updateUser({ password: newPassword, data: passwordStamps() });
    if (error) {
      setIsLoading(false);
      setErrorMessage(resetProblem(error));
      return;
    }
    forgetDeviceTrust();
    const { data: current } = await supabase.auth.getSession();
    const [emailed] = await Promise.all([
      notifyPasswordChanged("reset", current.session?.access_token),
      Promise.race([logActivity({ type: "session.password_reset" }, current.session?.access_token), new Promise((r) => setTimeout(r, 1500))]),
    ]);
    // Sign in afresh with the new password: the reset session is ended here.
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      /* local tokens are cleared regardless */
    }
    setIsLoading(false);
    setSignInEmail(data.user?.email ?? resetEmail);
    setSignInPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setStep({ kind: "password" });
    setSuccessMessage(`Your password has been changed${emailed ? " and we've emailed you a confirmation" : ""}. Sign in with your new password.`);
  }

  async function verifyCode(value: string) {
    if ((step.kind !== "verify" && step.kind !== "enroll") || checking.current) return;
    if (!/^\d{6}$/.test(value)) {
      setErrorMessage("Enter the 6-digit code from your authenticator app.");
      return;
    }
    checking.current = true;
    setErrorMessage("");
    setIsLoading(true);

    try {
      const accessToken = await submitCode(step.factorId, value);
      markActivity();
      // "Remember this device for 7 days": a pass from the backend, kept on this browser only.
      if (trustDevice) {
        try {
          const r = await fetch(`${BACKEND}/api/auth/trusted-device`, { method: "POST", headers: { authorization: `Bearer ${accessToken}` } });
          const j = await r.json().catch(() => null);
          const { data: s } = await supabase.auth.getSession();
          if (r.ok && j?.data?.token && s.session?.user) {
            saveDeviceTrust({ userId: s.session.user.id, email: s.session.user.email ?? "", token: j.data.token, expiresAt: j.data.expiresAt });
          } else {
            console.warn("Remember this device: not remembered", r.status, j?.code ?? "");
          }
        } catch {
          /* not remembered this time; the sign-in itself still goes ahead */
        }
      }
      // The audit log's entries, under the token the code just earned: a first-time setup, then
      // the sign-in itself. Not awaited past a moment: the dashboard opens either way.
      const firstTime = step.kind === "enroll";
      await Promise.race([
        (async () => {
          if (firstTime) await logActivity({ type: "session.authenticator_added" }, accessToken);
          await logActivity({ type: "session.login" }, accessToken);
        })(),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
      goToDashboard();
    } catch (err: unknown) {
      checking.current = false;
      setIsLoading(false);
      if (signInTimedOut(err)) backToPassword();
      else setCode("");
      setErrorMessage(secondStepProblem(err));
    }
  }

  function handleCodeSubmit(event: React.FormEvent) {
    event.preventDefault();
    void verifyCode(code);
  }

  // Digits only, six at most, and the sixth sends it: nobody should have to reach for a button
  // while a 30-second code is counting down.
  function handleCodeChange(event: React.ChangeEvent<HTMLInputElement>) {
    const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6) void verifyCode(digits);
  }

  async function copyKey() {
    if (step.kind !== "enroll") return;
    try {
      await navigator.clipboard.writeText(step.secret);
      setKeyCopied(true);
    } catch {
      // No clipboard access: the key is on screen and can be selected by hand.
    }
  }

  // Each step starts in its own first field, and a wrong code returns to the code field. Moving
  // focus by hand matters here: the form that held it has just been replaced.
  useEffect(() => {
    if (isLoading) return;
    if (step.kind === "verify" || step.kind === "enroll" || step.kind === "forgot-mfa") codeRef.current?.focus();
    else if (step.kind === "forgot-email" || step.kind === "forgot-new") firstFieldRef.current?.focus();
    else if (stepped) usernameRef.current?.focus();
  }, [step.kind, isLoading, stepped]);

  /* ---- Presentation only: the story timer and the mascot's headlights ---- */

  const [story, setStory] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [holdFocus, setHoldFocus] = useState(false);
  const [holdHover, setHoldHover] = useState(false);
  const [reduced, setReduced] = useState(false);
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const elapsedRef = useRef(0);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const goToStory = useCallback((i: number) => {
    elapsedRef.current = 0;
    setStory(((i % STORIES.length) + STORIES.length) % STORIES.length);
  }, []);

  // The stories advance on a 7 s timer, held while a field has focus, the
  // pointer is over the card, the reader paused it, or motion is reduced.
  const held = holdFocus || holdHover || userPaused || reduced;
  useEffect(() => {
    if (held) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      elapsedRef.current += now - last;
      last = now;
      const p = Math.min(1, elapsedRef.current / STORY_MS);
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${p})`;
      if (p >= 1) {
        elapsedRef.current = 0;
        setStory((s) => (s + 1) % STORIES.length);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [held, story]);

  /* The sign-in button drives the mascot's headlights: a flash when it is
     pointed at or focused, a steady pulse while the request is pending, a
     double blink when it fails. */
  const [lights, setLights] = useState<Lights>("");
  const lightsTimer = useRef<number | undefined>(undefined);
  const pulseLights = useCallback((kind: Exclude<Lights, "">) => {
    window.clearTimeout(lightsTimer.current);
    setLights("");
    // A frame apart, so the same pulse can play again straight after itself.
    requestAnimationFrame(() => setLights(kind));
    lightsTimer.current = window.setTimeout(() => setLights(""), kind === "error" ? 1400 : 950);
  }, []);
  useEffect(() => () => window.clearTimeout(lightsTimer.current), []);
  useEffect(() => {
    if (errorMessage) pulseLights("error");
  }, [errorMessage, pulseLights]);
  const flashLights = useCallback(() => pulseLights("flash"), [pulseLights]);

  const current = STORIES[story];

  return (
    <main className="si-shell" data-lights={isLoading ? "pending" : lights || undefined}>
      <NlexEnvironment scene="signin" />

      <header className="si-topbar">
        <section className="si-brand" aria-label="SmartFlow branding">
          <Image
            src="/SMARTFLOW_LOGO_WHITE.png"
            alt="SmartFlow NLEX"
            width={512}
            height={512}
            priority
            unoptimized
            className="brand-logo ds-brand-swap is-light"
          />
          <Image
            src="/logo-dark-bg.png"
            alt=""
            width={512}
            height={512}
            priority
            unoptimized
            className="brand-logo ds-brand-swap is-dark"
          />
          <h1 className="si-wordmark">SmartFlow NLEX</h1>
        </section>

        {/* The same theme control and effects switch as the dashboard's top bar. */}
        <div className="si-topbar-end">
          <EffectsToggle />
          <ThemeToggle />
        </div>
      </header>

      <section className="si-story" aria-label="About SmartFlow">
        <div className="si-story-text" key={story}>
          <TitleReveal as="h2" text={current.title} accent={current.accent} className="si-story-title" />
          <p className="si-story-body">{current.body}</p>
        </div>
        {/* The stories: one dash each, the current one filling over its 7 s, and a pause. */}
        <nav className="si-tabs" aria-label="Stories">
          {STORIES.map((s, i) => (
            <button
              key={s.label}
              type="button"
              className={`si-tab${i === story ? " is-current" : ""}${i < story ? " is-done" : ""}`}
              aria-label={`Story ${i + 1} of ${STORIES.length}: ${s.title.replace("\n", " ")}`}
              aria-current={i === story ? "true" : undefined}
              onClick={() => goToStory(i)}
            >
              <span className="si-tab-track" aria-hidden="true">
                <span ref={i === story ? fillRef : undefined} className="si-tab-fill" />
              </span>
            </button>
          ))}
          {!reduced && (
            <button
              type="button"
              className="si-story-pause"
              aria-label={userPaused ? "Play stories" : "Pause stories"}
              aria-pressed={userPaused}
              onClick={() => setUserPaused((p) => !p)}
            >
              {userPaused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
            </button>
          )}
        </nav>
      </section>

      <section
        className="login-panel"
        aria-labelledby="si-card-title"
        onPointerEnter={() => setHoldHover(true)}
        onPointerLeave={() => setHoldHover(false)}
      >
        <div className="login-card" data-stepped={stepped ? "" : undefined}>
          <div className="login-card-head">
            <span className="login-accent" aria-hidden="true" />
            {step.kind !== "password" && (
              <button type="button" className="si-back" onClick={backToPassword} disabled={isLoading}>
                <ArrowLeft size={15} strokeWidth={2.4} aria-hidden="true" />
                {isForgot(step.kind) ? "Back to sign in" : "Use a different account"}
              </button>
            )}
          </div>

          <h2 id="si-card-title">
            {{
              password: "Sign In to Dashboard",
              enroll: "Set Up Authenticator",
              verify: "Enter Your Code",
              "forgot-email": "Reset Your Password",
              "forgot-code": "Check Your Email",
              "forgot-mfa": "Confirm It\u2019s You",
              "forgot-new": "Choose a New Password",
            }[step.kind]}
          </h2>

          {step.kind === "password" ? (
          <form
            onSubmit={handleSignInSubmit}
            className="login-form"
            onFocus={() => setHoldFocus(true)}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoldFocus(false); }}
          >
            {errorMessage && <div className="login-alert danger" role="alert">{errorMessage}</div>}
            {successMessage && <div className="login-alert success" role="status">{successMessage}</div>}

            <label className="field-group">
              <span>Email</span>
              <div className="input-with-icon">
                <Mail className="input-icon-left" size={20} aria-hidden="true" />
                <input
                  ref={usernameRef}
                  type="email"
                  name="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="Enter your email"
                  value={signInEmail}
                  onChange={(e) => setSignInEmail(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>
            </label>

            <label className="field-group">
              <span>Password</span>
              <div className="input-with-icon">
                <Lock className="input-icon-left" size={20} aria-hidden="true" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={signInPassword}
                  onChange={(e) => setSignInPassword(e.target.value)}
                  required
                  disabled={isLoading}
                />
                <button
                  type="button"
                  className="icon-button-right"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((current) => !current)}
                  disabled={isLoading}
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </label>

            <div className="login-options">
              <label className="remember-row">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(event) => setRememberMe(event.target.checked)}
                  disabled={isLoading}
                />
                <span>Remember me</span>
              </label>

              <button type="button" className="forgot-link" disabled={isLoading} onClick={startForgot}>
                Forgot password?
              </button>
            </div>

            <button
              type="submit"
              className="submit-button"
              disabled={isLoading}
              onPointerEnter={flashLights}
              onFocus={flashLights}
            >
              <span>{isLoading ? 'Signing In...' : 'Sign In'}</span>
              {isLoading
                ? <i className="submit-spinner" aria-hidden="true" />
                : <ArrowRight className="submit-arrow" size={22} strokeWidth={2} aria-hidden="true" />}
            </button>
          </form>
          ) : step.kind === "forgot-email" ? (
          <form onSubmit={handleResetEmailSubmit} className="login-form" noValidate onFocus={() => setHoldFocus(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoldFocus(false); }}>
            <p className="mfa-lead">Enter the email address you sign in with. We&rsquo;ll email you a link to reset your password.</p>
            {errorMessage && <div className="login-alert danger" role="alert">{errorMessage}</div>}
            <label className="field-group">
              <span>Email</span>
              <div className="input-with-icon">
                <Mail className="input-icon-left" size={20} aria-hidden="true" />
                <input ref={firstFieldRef} type="email" name="email" autoComplete="email" inputMode="email" placeholder="Enter your email" value={resetEmail} onChange={(e) => setResetEmail(e.target.value)} required disabled={isLoading} />
              </div>
            </label>
            <button type="submit" className="submit-button" disabled={isLoading} onPointerEnter={flashLights} onFocus={flashLights}>
              <span>{isLoading ? "Sending..." : "Send reset link"}</span>
              {isLoading ? <i className="submit-spinner" aria-hidden="true" /> : <ArrowRight className="submit-arrow" size={22} strokeWidth={2} aria-hidden="true" />}
            </button>
          </form>
          ) : step.kind === "forgot-code" ? (
          <div className="login-form mfa-form">
            {/* A link only, no code (19 Oct 2026, user choice). The link opens this page, which carries on to the
                authenticator code (if the account has one) and the new password. */}
            {/* Short and in order (20 Oct 2026, user request: the paragraph was too wordy). "If an account uses"
                stays in the small print: the page never says whether the address has an account. */}
            <p className="mfa-lead">Navie sent an email to <b>{step.email}</b>.</p>
            <ol className="si-steps">
              <li><span>Open the email from <b>Navie (SmartFlow NLEX)</b>.</span></li>
              <li><span>Click <b>Reset password</b> in this browser.</span></li>
            </ol>
            <p className="si-hint">
              Changed your password in the last 30 days? The email tells you when you can change it again instead.
            </p>
            {errorMessage && <p className="mfa-error" role="alert">{errorMessage}</p>}
            <div className="si-resend-row">
              <span>No email? Check Spam, or</span>
              <button type="button" className="si-resend" disabled={isLoading || resendIn > 0} onClick={() => void sendResetCode(step.email)}>
                <RotateCw size={14} strokeWidth={2.4} aria-hidden="true" />
                {resendIn > 0 ? `Resend in ${resendIn} s` : "Resend"}
              </button>
            </div>
          </div>
          ) : step.kind === "forgot-mfa" ? (
          <form onSubmit={handleResetMfaSubmit} className="login-form mfa-form" noValidate onFocus={() => setHoldFocus(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoldFocus(false); }}>
            <p className="mfa-lead">Your account has an authenticator, so enter the code it shows for SmartFlow NLEX before choosing a new password.</p>
            <div className="mfa-field">
              <label className="field-group">
                <span>Authenticator code</span>
                <div className="input-with-icon">
                  <ShieldCheck className="input-icon-left" size={20} aria-hidden="true" />
                  <input ref={codeRef} className="mfa-code" type="text" name="one-time-code" inputMode="numeric" autoComplete="one-time-code" placeholder="Enter the 6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} required disabled={isLoading} aria-invalid={errorMessage ? true : undefined} aria-describedby={errorMessage ? "reset-mfa-error" : undefined} />
                </div>
              </label>
              {errorMessage && <p id="reset-mfa-error" className="mfa-error" role="alert">{errorMessage}</p>}
            </div>
            <button type="submit" className="submit-button" disabled={isLoading} onPointerEnter={flashLights} onFocus={flashLights}>
              <span>{isLoading ? "Verifying..." : "Verify"}</span>
              {isLoading ? <i className="submit-spinner" aria-hidden="true" /> : <ArrowRight className="submit-arrow" size={22} strokeWidth={2} aria-hidden="true" />}
            </button>
          </form>
          ) : step.kind === "forgot-new" ? (
          <form onSubmit={handleNewPasswordSubmit} className="login-form" noValidate onFocus={() => setHoldFocus(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoldFocus(false); }}>
            <p className="mfa-lead">Choose a new password of at least 8 characters. You&rsquo;ll sign in with it straight after.</p>
            {errorMessage && <div className="login-alert danger" role="alert">{errorMessage}</div>}
            <label className="field-group">
              <span>New password</span>
              <div className="input-with-icon">
                <Lock className="input-icon-left" size={20} aria-hidden="true" />
                <input ref={firstFieldRef} type={showPassword ? "text" : "password"} name="new-password" autoComplete="new-password" placeholder="At least 8 characters" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} disabled={isLoading} />
                <button type="button" className="icon-button-right" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((v) => !v)} disabled={isLoading}>
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </label>
            <label className="field-group">
              <span>Confirm new password</span>
              <div className="input-with-icon">
                <Lock className="input-icon-left" size={20} aria-hidden="true" />
                <input type={showPassword ? "text" : "password"} name="confirm-password" autoComplete="new-password" placeholder="Type it again" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required disabled={isLoading} />
              </div>
            </label>
            <button type="submit" className="submit-button" disabled={isLoading} onPointerEnter={flashLights} onFocus={flashLights}>
              <span>{isLoading ? "Saving..." : "Change password"}</span>
              {isLoading ? <i className="submit-spinner" aria-hidden="true" /> : <ArrowRight className="submit-arrow" size={22} strokeWidth={2} aria-hidden="true" />}
            </button>
          </form>
          ) : (
          <form
            onSubmit={handleCodeSubmit}
            className="login-form mfa-form"
            noValidate
            onFocus={() => setHoldFocus(true)}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoldFocus(false); }}
          >
            {resumedAs && (
              <div className="login-alert success mfa-resumed" role="status">
                You&rsquo;re signed in as <b>{resumedAs}</b>, but your code is still needed to open the dashboard.
              </div>
            )}
            {step.kind === "enroll" ? (
              <div className="mfa-setup">
                <div className="mfa-qr">
                  {/* eslint-disable-next-line @next/next/no-img-element -- an SVG data URL from Supabase; next/image has nothing to optimise */}
                  <img src={step.qr} alt="QR code that adds SmartFlow NLEX to your authenticator app" width={148} height={148} />
                </div>
                <p className="mfa-lead">
                  Sign-in now needs a code from your phone. Scan this with an authenticator app, such as
                  Google Authenticator or Microsoft Authenticator, then enter the code it shows.
                </p>
                <div className="mfa-key">
                  <span className="mfa-key-label">Can&rsquo;t scan? Type this key into the app:</span>
                  <button type="button" className="si-link" onClick={copyKey} disabled={isLoading}>
                    {keyCopied ? "Copied" : "Copy key"}
                  </button>
                  <code>{groupKey(step.secret)}</code>
                  <span className="sr-only" role="status">{keyCopied ? "Setup key copied" : ""}</span>
                </div>
              </div>
            ) : (
              <p className="mfa-lead">Open your authenticator app and enter the code it shows for SmartFlow NLEX.</p>
            )}


            {/* The message sits under the field it is about, not above the QR code a screen away. */}
            <div className="mfa-field">
              <label className="field-group">
                <span>Authenticator code</span>
                <div className="input-with-icon">
                  <ShieldCheck className="input-icon-left" size={20} aria-hidden="true" />
                  <input
                    ref={codeRef}
                    className="mfa-code"
                    type="text"
                    name="one-time-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    placeholder="Enter the 6-digit code"
                    value={code}
                    onChange={handleCodeChange}
                    required
                    disabled={isLoading}
                    aria-invalid={errorMessage ? true : undefined}
                    aria-describedby={errorMessage ? "mfa-code-error" : undefined}
                  />
                </div>
              </label>
              {errorMessage && <p id="mfa-code-error" className="mfa-error" role="alert">{errorMessage}</p>}
            </div>

            <div className="mfa-remember">
              <label className="remember-row">
                <input type="checkbox" checked={trustDevice && trustAvailable !== false} onChange={(e) => setTrustDevice(e.target.checked)}
                  disabled={isLoading || trustAvailable === false} />
                <span title={trustAvailable === false ? "This server is not set up to remember devices (DEVICE_TRUST_SECRET); the code is asked at every sign-in." : undefined}>
                  Remember this device for 7 days{trustAvailable === false ? " (not available on this server)" : ""}
                </span>
              </label>
            </div>

            <button
              type="submit"
              className="submit-button"
              disabled={isLoading}
              onPointerEnter={flashLights}
              onFocus={flashLights}
            >
              <span>{isLoading ? 'Verifying...' : 'Verify'}</span>
              {isLoading
                ? <i className="submit-spinner" aria-hidden="true" />
                : <ArrowRight className="submit-arrow" size={22} strokeWidth={2} aria-hidden="true" />}
            </button>
          </form>
          )}
        </div>

        <p className="copyright">{'©'} 2026 SmartFlow NLEX. All rights reserved.</p>
      </section>
    </main>
  );
}
