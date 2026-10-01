import type { Request, Response, NextFunction } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

/*
 * Session verification and role authorization.
 *
 * Three things changed here, each for a reason worth keeping written down.
 *
 * 1. The project URL and anon key were hardcoded as fallbacks. A deployment
 *    that set neither variable therefore started cleanly and verified operator
 *    tokens against the development project -- the failure a reader would least
 *    expect, because nothing looks broken. The client is now built from env
 *    only, and a protected route with no configuration refuses to serve rather
 *    than guessing (see requireConfigured below).
 *
 * 2. An expired token returned 403. HTTP reserves 401 for "your credential did
 *    not authenticate you, try again" and 403 for "it authenticated you and the
 *    answer is still no". Returning 403 for both made the two indistinguishable
 *    to a client, which is why the dashboard could not implement a silent
 *    refresh: it had no way to tell a stale token from a forbidden role, and
 *    retrying the second is pointless. 401 now means refresh and retry; 403
 *    means stop.
 *
 * 3. The role fell back to "data-analyst", the most privileged role, whenever
 *    user_metadata carried none. Least privilege now applies instead.
 */

/** Mirrors Front-End-Dashboard/lib/auth-access.ts. Keep the two in step. */
const FALLBACK_ROLE = "incident-operator";

let client: SupabaseClient | null = null;

/** Built once, and only when both variables are present. */
function getSupabase(): SupabaseClient | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  if (!client) client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  return client;
}

export interface AuthenticatedRequest extends Request {
  user?: any;
  userRole?: string;
}

/**
 * Verify the bearer token and attach the caller's identity and role.
 *
 * `code` is machine-readable so the dashboard can act on the reason rather than
 * parsing prose: "token_expired" and "token_invalid" are worth a refresh
 * attempt, the others are not.
 */
export async function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const supabase = getSupabase();
  if (!supabase) {
    // Fail closed. An endpoint that cannot verify a token must not serve the
    // data it was protecting.
    return res.status(503).json({
      success: false,
      code: "auth_unconfigured",
      message: "Authentication is not configured on this server",
    });
  }

  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      code: "token_missing",
      message: "Access token is required",
    });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      const expired = /expire/i.test(error?.message ?? "");
      return res.status(401).json({
        success: false,
        code: expired ? "token_expired" : "token_invalid",
        message: expired ? "Access token has expired" : "Access token is invalid",
      });
    }

    req.user = user;
    req.userRole = user.user_metadata?.role || FALLBACK_ROLE;
    next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      code: "auth_error",
      message: "Internal server authentication error",
    });
  }
}

/**
 * Restrict a route to the listed roles.
 *
 * Always 403: the caller authenticated successfully and the token is current,
 * so there is nothing for them to retry.
 */
export function authorizeRoles(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.userRole) {
      return res.status(403).json({
        success: false,
        code: "role_missing",
        message: "Access denied: user role not defined",
      });
    }

    if (!allowedRoles.includes(req.userRole)) {
      return res.status(403).json({
        success: false,
        code: "role_denied",
        message: "Access denied: unauthorized role",
      });
    }

    next();
  };
}
