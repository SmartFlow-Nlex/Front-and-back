/* The second sign-in step: a code from an authenticator app.
 *
 * A password used to be the whole of sign-in. It now only starts it. Supabase
 * records how far a session has got in its token's `aal` claim: "aal1" once the
 * password is accepted, "aal2" once a six-digit code from the operator's
 * authenticator app (TOTP) has been accepted as well. Only "aal2" counts as
 * signed in, here and on the server.
 *
 * Three places apply that rule, and they are not equals:
 *
 *   - the sign-in page asks for the code (or, the first time, has the operator
 *     add the app) before it opens the dashboard;
 *   - the dashboard shell refuses a session that is still at "aal1";
 *   - the backend refuses a token that is still at "aal1"
 *     (Back-End/src/middleware/auth.middleware.ts).
 *
 * The first two run in the operator's browser and are there so the interface
 * behaves. The third is the control. See Chapter4_Auth_Session_Management.md.
 */
import type { Session } from "@supabase/supabase-js";
import { renderSVG } from "uqr";
import { supabase } from "./supabase";
import { deviceTrustFor } from "./account-device";

/** How the authenticator app labels the account. */
const ISSUER = "SmartFlow NLEX";

/** One claim from an access token's payload, or undefined when it cannot be read. */
function claimOf(accessToken: string, name: string): unknown {
  try {
    const part = accessToken.split(".")[1] ?? "";
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")))[name];
  } catch {
    return undefined;
  }
}

/**
 * Whether a session has passed both steps.
 *
 * Read from the token rather than asked of the client library, because the
 * shell calls this from inside the auth listener, where calling back into the
 * library can deadlock it.
 */
export function isFullySignedIn(session: Session | null): boolean {
  return passedCode(session) || (!!session && !!deviceTrustFor(session.user.id));
}

/**
 * Whether this session passed the authenticator code itself, as opposed to signing in on a remembered
 * device (19 Oct 2026). Changing the password needs this: Supabase requires the code for it.
 * In the browser a remembered device is only a hint for the interface; the API checks the pass's
 * signature (Back-End/src/lib/device-trust.ts).
 */
export function passedCode(session: Session | null): boolean {
  return !!session && claimOf(session.access_token, "aal") === "aal2";
}

/** The account's verified authenticator, if it has one (for asking for a code outside sign-in). */
export async function verifiedFactorId(): Promise<string | null> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return data.totp[0]?.id ?? null;
}

/**
 * End a session that only ever passed the password step.
 *
 * Such a session is not resumed unless "Remember me" was ticked for it
 * (app/page.tsx, 3 Nov 2026: it reopens at the code step, which still asks for
 * the code). Otherwise the code step follows a password typed in the same
 * visit, so a half-finished sign-in left on a shared PC cannot be picked up by
 * the next person. "local" ends this browser's session
 * only; the operator's other devices stay signed in.
 *
 * Deferred a tick, for the same listener reason as above.
 */
export function dropPasswordOnlySession(): void {
  setTimeout(() => {
    void supabase.auth.signOut({ scope: "local" }).catch(() => {});
  }, 0);
}

const asDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/**
 * Supabase's own QR picture as an image source: the fallback.
 *
 * It arrives as raw SVG markup behind a `data:` prefix, with a fixed width and
 * height but no viewBox. A viewBox is added so it scales to the card instead of
 * depending on each browser's handling of an SVG that has none, and the markup
 * is encoded so no character in it can cut the address short.
 */
function supabaseQr(qr: string): string {
  let svg = qr.replace(/^data:image\/svg\+xml;utf-8,/, "");
  const tag = svg.match(/<svg\b[^>]*>/)?.[0];
  if (tag && !/\bviewBox=/.test(tag)) {
    const width = tag.match(/\bwidth="(\d+(?:\.\d+)?)"/)?.[1];
    const height = tag.match(/\bheight="(\d+(?:\.\d+)?)"/)?.[1];
    if (width && height) svg = svg.replace(tag, tag.replace(/^<svg\b/, `<svg viewBox="0 0 ${width} ${height}"`));
  }
  return asDataUrl(svg);
}

/**
 * The QR code the set-up step shows.
 *
 * Supabase's picture encodes the full address with every optional setting
 * spelled out at a high error-correction level, which makes a code 69 squares
 * across. On the sign-in card that is under two pixels a square, too fine for
 * a phone camera to be relied on (measured 7 Oct 2026: unreadable from the
 * card at either of its sizes). So the code is drawn here from the same
 * address with the settings that only restate the standard removed (SHA1, six
 * digits, 30 seconds: what every authenticator assumes), at the correction
 * level suited to a screen. The same key and account, in a code of about 41
 * squares. If anything about that fails, Supabase's own picture is used.
 */
function setupQr(uri: string, fallbackPicture: string): string {
  try {
    const address = new URL(uri);
    const standard: Record<string, string> = { algorithm: "SHA1", digits: "6", period: "30" };
    const kept = [...address.searchParams].filter(([name, value]) => standard[name] !== value);
    if (!kept.some(([name]) => name === "secret")) throw new Error("no secret in the address");
    const compact = `otpauth://${address.host}${address.pathname}?${kept.map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join("&")}`;
    return asDataUrl(renderSVG(compact, { ecc: "L", border: 4 }));
  } catch {
    return supabaseQr(fallbackPicture);
  }
}

/** What the operator must do after the password: enter a code, or first add the app. */
export type SecondStep =
  | { kind: "verify"; factorId: string }
  | { kind: "enroll"; factorId: string; qr: string; secret: string };

/**
 * Decide the second step for the session the password just opened.
 *
 * An account with an authenticator already added is asked for its code. One
 * without is enrolled now, and cannot reach the dashboard until the first code
 * from the new app is accepted, so no account is left on a password alone.
 */
export async function beginSecondStep(): Promise<SecondStep> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;

  const added = data.totp[0]; // `totp` lists verified factors only
  if (added) return { kind: "verify", factorId: added.id };

  // An enrolment that was started and abandoned leaves an unverified factor
  // behind. Clear those first so each attempt starts from one fresh secret.
  for (const factor of data.all) {
    if (factor.factor_type === "totp" && factor.status === "unverified") {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
  }

  const enrolled = await supabase.auth.mfa.enroll({ factorType: "totp", issuer: ISSUER });
  if (enrolled.error) throw enrolled.error;
  return {
    kind: "enroll",
    factorId: enrolled.data.id,
    qr: setupQr(enrolled.data.totp.uri, enrolled.data.totp.qr_code),
    secret: enrolled.data.totp.secret,
  };
}

/**
 * Check a six-digit code. On success the session is raised to "aal2" and its
 * new access token is returned; for an enrolment this is also what confirms the
 * authenticator and keeps it.
 */
export async function submitCode(factorId: string, code: string): Promise<string> {
  const { data, error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) throw error;
  return data.access_token;
}

/** True when the password-step session is gone, so the code step has nothing left to finish. */
export function signInTimedOut(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "session_not_found" || code === "session_expired";
}

/** Say what went wrong at the second step, and what to do about it. */
export function secondStepProblem(error: unknown): string {
  const e = (error ?? {}) as { code?: string; status?: number; message?: string };
  switch (e.code) {
    case "mfa_verification_failed":
      return "The code entered is incorrect. Please provide the code currently displayed in your authenticator app.";
    case "mfa_challenge_expired":
      return "That took too long. Enter the code your authenticator app is showing now.";
    case "over_request_rate_limit":
      return "Too many attempts. Wait a minute, then try again.";
    case "mfa_totp_enroll_not_enabled":
    case "mfa_totp_verify_not_enabled":
      return "Authenticator sign-in is switched off for this project. Ask an administrator to turn it on in Supabase.";
    case "session_not_found":
    case "session_expired":
      return "Your sign-in timed out. Enter your password again.";
  }
  if (e.status === 429) return "Too many attempts. Wait a minute, then try again.";
  return e.message || "The code could not be checked. Try again.";
}

/** A setup key as the operator will type it: groups of four. */
export function groupKey(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}
