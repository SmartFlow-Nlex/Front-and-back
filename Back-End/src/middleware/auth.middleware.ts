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
