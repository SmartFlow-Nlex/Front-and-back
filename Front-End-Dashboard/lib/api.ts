/* Authenticated calls to the Express backend.
 *
 * The dashboard never sent an Authorization header. Every protected endpoint --
 * /api/emissions/index, /api/data-management, /api/audit-log/export,
 * /api/ai-sandbox/simulate and the rest -- would therefore have answered 401 to
 * any call the interface made. Nothing appeared broken only because each page
 * happened to read the public routes mounted ahead of the auth middleware, so
 * the protected half of the API was unreachable from the product rather than
 * merely unused.
 *
 * This module is the one place a token is attached, and the one place an expired
 * one is renewed. Call sites use apiFetch/authedJson and stay unaware of either.
 */
import { supabase } from "./supabase";

export const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

/** Reasons the backend reports, from middleware/auth.middleware.ts. */
type AuthCode =
  | "token_missing"
  | "token_expired"
  | "token_invalid"
  | "role_missing"
  | "role_denied"
  | "auth_unconfigured"
  | "auth_error";

/**
 * Raised when a call cannot be authorized and retrying would not help: the role
 * is wrong, or the session is gone and could not be renewed.
 */
export class AuthError extends Error {
  readonly status: number;
  readonly code: AuthCode | undefined;

  constructor(status: number, code: AuthCode | undefined, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }

  /** True when the user is signed out, as opposed to signed in with the wrong role. */
  get isSignedOut(): boolean {
    return this.status === 401;
  }
}

/** Fired when the session is unrecoverable, so the shell can send the user to login. */
export const SESSION_LOST_EVENT = "smartflow:session-lost";

function announceSessionLost(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SESSION_LOST_EVENT));
  }
}

/**
 * A body that fetch can serialize more than once.
 *
 * A ReadableStream body is consumed by the first attempt, so a retry would send
 * an empty request. Strings, FormData, Blobs and URLSearchParams are re-read
 * from the original object and are safe. Nothing in the dashboard streams a
 * request body today; this is here so that the first thing that does fails
 * loudly on the retry path instead of silently uploading nothing.
 */
function isReplayable(body: BodyInit | null | undefined): boolean {
  if (body == null) return true;
  return !(body instanceof ReadableStream);
}

async function currentToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * fetch with the current access token attached.
 *
 * On 401 the session is refreshed once and the request replayed. 403 is not
 * retried: the token was accepted and the role was refused, so a new token
 * carries the same answer.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const send = async (token: string | null) => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };

  let res = await send(await currentToken());

  if (res.status === 401 && isReplayable(init.body)) {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data.session) {
      res = await send(data.session.access_token);
    } else {
      // The refresh token is spent or revoked. This is a real sign-out, which
      // the shell needs to know about -- otherwise the user sits on a dashboard
      // whose panels quietly stop filling.
      announceSessionLost();
    }
  }

  return res;
}

/** Parse a JSON body, turning 401/403 into an AuthError rather than malformed data. */
export async function authedJson<T = unknown>(input: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(input, init);

  if (res.status === 401 || res.status === 403 || res.status === 503) {
    let code: AuthCode | undefined;
    let message = res.statusText;
    try {
      const body = await res.json();
      code = body?.code;
      message = body?.message ?? message;
    } catch {
      // A proxy or gateway refused before reaching the API and answered HTML.
    }
    if (res.status === 401) announceSessionLost();
    throw new AuthError(res.status, code, message);
  }

  return res.json() as Promise<T>;
}
