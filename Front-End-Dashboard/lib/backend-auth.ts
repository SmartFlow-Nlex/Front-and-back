/**
 * Who is using the dashboard, told to the backend.
 *
 * installBackendAuth() makes every request to the backend carry the signed-in
 * user's Supabase token, so the audit log can name who did what and with what
 * role (the backend checks the token with Supabase; it does not take a name the
 * page claims). It is installed once, by the dashboard layout, and only touches
 * requests addressed to the backend.
 *
 * logActivity() reports what only the page knows: a page was opened, the user
 * signed in or out, the log was exported.
 */
import { supabase } from "./supabase";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

let token: string | null = null;
let ready: Promise<void> | null = null;

function track(): Promise<void> {
  ready ??= supabase.auth
    .getSession()
    .then(({ data }) => {
      token = data.session?.access_token ?? null;
      supabase.auth.onAuthStateChange((_event, session) => {
        token = session?.access_token ?? null;
      });
    })
    .catch(() => {});
  return ready;
}

let installed = false;

export function installBackendAuth(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  void track();
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!token || !url.startsWith(BACKEND)) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    return original(input, { ...init, headers });
  };
}

export type Activity =
  | { type: "page.viewed"; path: string }
  | { type: "session.login" }
  | { type: "session.logout" }
  | { type: "audit.exported"; rows: number; format: "json" | "csv" };

/**
 * Report an activity to the audit log. Never throws and never holds the page up for
 * long. `accessToken` is for the sign-in page, which has a token before this module does.
 */
export async function logActivity(activity: Activity, accessToken?: string): Promise<void> {
  try {
    await track();
    const bearer = accessToken ?? token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    await fetch(`${BACKEND}/api/audit-log/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(activity),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  } catch {
    // The audit log records the work; it must never stand in its way.
  }
}

/** A page view, at most once per page per ten minutes per tab: a refresh or a quick back-and-forth is not a new visit. */
export function logPageView(path: string): void {
  const key = `audit:viewed:${path}`;
  try {
    const last = Number(sessionStorage.getItem(key) ?? 0);
    if (Date.now() - last < 10 * 60_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    // No sessionStorage (private mode, blocked storage): log every view instead.
  }
  void logActivity({ type: "page.viewed", path });
}
