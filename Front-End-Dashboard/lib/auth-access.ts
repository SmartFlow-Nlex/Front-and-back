/* Who may see which page.
 *
 * These rules existed twice in dashboard/layout.tsx -- once to filter the
 * sidebar and once again, restated as pathname comparisons, to redirect anyone
 * who typed the URL directly. Two copies of the same list is one copy too many:
 * adding an admin page meant remembering both, and the sidebar hiding a link
 * that the guard still allowed would have looked like protection without being
 * any.
 *
 * The backend enforces the same divisions in middleware/auth.middleware.ts.
 * That is the boundary that matters -- this file only decides what the
 * interface offers, and a static export has no server to ask. See
 * Chapter4_Auth_Session_Management.md.
 */

/** Roles carried in Supabase user_metadata.role. */
export type Role = "data-analyst" | "tcc-operator" | "incident-operator";

/**
 * Least privilege, applied when a session exists but carries no role.
 *
 * Previously "data-analyst" -- the MOST privileged role -- which meant a user
 * whose metadata was missing silently received administrator navigation.
 */
export const FALLBACK_ROLE: Role = "incident-operator";

/** Routes each role may not reach. A role absent from this map may reach everything. */
const DENIED: Partial<Record<Role, readonly string[]>> = {
  "tcc-operator": [
    "/dashboard/sustainability",
    "/dashboard/data-management",
    "/dashboard/audit-log",
  ],
  "incident-operator": [
    "/dashboard/sustainability",
    "/dashboard/ai-sandbox",
    "/dashboard/data-management",
    "/dashboard/audit-log",
  ],
};

/** Where a user is sent when they reach a page their role does not permit. */
export const FALLBACK_ROUTE = "/dashboard";

/** Where a user is sent when there is no session at all. */
export const LOGIN_ROUTE = "/";

export function isRole(value: unknown): value is Role {
  return value === "data-analyst" || value === "tcc-operator" || value === "incident-operator";
}

/**
 * Whether `role` may open `pathname`.
 *
 * Matches on segment boundaries rather than equality, so that a future
 * /dashboard/audit-log/export is denied along with its parent instead of
 * slipping through as an unlisted path.
 */
export function canAccess(role: Role, pathname: string): boolean {
  const denied = DENIED[role];
  if (!denied) return true;
  return !denied.some((route) => pathname === route || pathname.startsWith(route + "/"));
}
