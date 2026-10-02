import type { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";

// Initialize Supabase client for token validation
const supabaseUrl = process.env.SUPABASE_URL || "https://qjbnilmopummgivymdiq.supabase.co";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFqYm5pbG1vcHVtbWdpdnltZGlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNzAxNjYsImV4cCI6MjA5Nzk0NjE2Nn0.ue6leXwdj-dIFi5_TDWX7aCd4saywNOHG-UARLVOcvQ";

const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface AuthenticatedRequest extends Request {
  user?: any;
  userRole?: string;
}

// Middleware to authenticate user and extract role from Supabase JWT
export async function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ success: false, message: "Access token is required" });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(403).json({ success: false, message: "Invalid or expired access token" });
    }

    req.user = user;
    req.userRole = user.user_metadata?.role || "data-analyst"; // Fallback to "data-analyst" if not specified
    next();
  } catch (err) {
    return res.status(500).json({ success: false, message: "Internal server authentication error" });
  }
}

/**
 * The user a bearer token belongs to, checked with Supabase, or null when the
 * token is missing, invalid or Supabase does not answer in time. For the audit
 * log, which must name who did something without ever slowing the action down:
 * answers are cached for five minutes per token, and a lookup gives up after
 * four seconds.
 */
const verified = new Map<string, { at: number; user: { email: string; role: string } | null }>();
export async function verifiedUser(token: string | undefined): Promise<{ email: string; role: string } | null> {
  if (!token) return null;
  const hit = verified.get(token);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.user;
  const lookup = supabase.auth.getUser(token).then(({ data, error }) =>
    error || !data.user ? null : { email: data.user.email ?? data.user.id, role: data.user.user_metadata?.role || "data-analyst" });
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000));
  const user = await Promise.race([lookup.catch(() => null), timeout]);
  if (verified.size > 500) verified.clear();
  verified.set(token, { at: Date.now(), user });
  return user;
}

// Middleware to authorize specific roles
export function authorizeRoles(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.userRole) {
      return res.status(403).json({ success: false, message: "Access denied: User role not defined" });
    }

    if (!allowedRoles.includes(req.userRole)) {
      return res.status(403).json({ success: false, message: "Access denied: Unauthorized role" });
    }

    next();
  };
}
