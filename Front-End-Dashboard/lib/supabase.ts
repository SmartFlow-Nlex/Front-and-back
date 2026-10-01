import { createClient } from "@supabase/supabase-js";

/*
 * The browser Supabase client -- the only place a session is created or read.
 *
 * The project URL and anon key were hardcoded here as `|| "..."` fallbacks. The
 * anon key is public by Supabase's design, so the exposure itself was not the
 * problem; the problem was that the project in use became invisible in
 * configuration, so a build that set neither variable still worked and
 * authenticated against the development project with no sign that it had. Both
 * are now declared in .env (committed, since NEXT_PUBLIC_* values ship in the
 * bundle regardless) and read from there alone.
 *
 * Throwing on absence is deliberate. A static export bakes these at build time,
 * so the alternative is a bundle that cannot sign anyone in and says nothing
 * about why -- a failure that surfaces to users instead of to whoever built it.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set. " +
      "They are read at build time because this app is a static export, so set " +
      "them before running `next build`.",
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Keep the session across reloads and renew it before it lapses. Both are
    // library defaults; they are stated explicitly because the whole of the
    // silent-refresh behaviour documented in Chapter4_Auth_Session_Management.md
    // rests on them, and a later edit that flipped either one would break the
    // refresh path without touching any code that mentions refreshing.
    persistSession: true,
    autoRefreshToken: true,
  },
});
