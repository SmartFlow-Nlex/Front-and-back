"use client";

import Image from "next/image";
import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar,
  ChevronDown,
  LogOut,
  Menu,
  User,
  X,
  Settings as SettingsIcon,
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase";
import {
  canAccess,
  FALLBACK_ROLE,
  FALLBACK_ROUTE,
  isRole,
  LOGIN_ROUTE,
  type Role,
} from "../../lib/auth-access";
import { SESSION_LOST_EVENT } from "../../lib/api";
import { installBackendAuth, logActivity, logPageView } from "../../lib/backend-auth";
import { dropPasswordOnlySession, isFullySignedIn } from "../../lib/mfa";
import ThemeToggle from "../../components/dashboard/ThemeToggle";
import EffectsToggle from "../../components/dashboard/EffectsToggle";
import { NAV_TABS as tabs, NAV_GROUPS, navEntryFor, accentFor } from "../../lib/nav";
import EditorialGrid from "../../components/stage/EditorialGrid";
import SectionProgress from "../../components/stage/SectionProgress";
import Mascot from "../../components/stage/Mascot";
import LoadingGate from "../../components/dashboard/LoadingGate";
import IdleGuard from "../../components/dashboard/IdleGuard";
import { displayNameOf, idleMinutesOf, DEFAULT_IDLE_MINUTES, rememberedEmail } from "../../lib/account-device";
import NlexEnvironment from "../../components/environment/NlexEnvironment";

// The Night Corridor stage: one WebGL canvas behind the shell, client-only, and
// mounted here once so it survives every navigation inside the dashboard.
const NightCorridorStage = dynamic(() => import("../../components/stage/NightCorridorStage"), { ssr: false });

// Before any page fetches: every request to the backend carries the signed-in user, for the audit log.
if (typeof window !== "undefined") installBackendAuth();

// The sidebar's tabs and groups live in lib/nav.ts (moved unchanged), so the
// breadcrumb and the page headers read the same list.

const MOBILE_BREAKPOINT = 980;

/** How long a refused page's notice stays up before the redirect. Testers asked for 3-5 s, and one
 *  found 4 s still too short (UAT AC-4, 16 Oct 2026), so it takes the top of that range. */
const BLOCKED_NOTICE_S = 5;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // Collapsed to the icon rail by default (user request, 7 Oct 2026); the menu button opens it.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const logoutCancelRef = useRef<HTMLButtonElement | null>(null);

  /*
   * Whether a session exists. "checking" is a distinct state rather than an
   * assumption, because the whole shell depends on not guessing.
   *
   * Before this, userRole initialised to "data-analyst" -- the most privileged
   * role -- and nothing tested for a session at all. Two consequences followed.
   * Anyone who opened /dashboard without signing in was served the full
   * administrator sidebar, Data Management and Audit Log included. And a signed-in
   * operator who deep-linked to a page their role forbids rendered that page on
   * first paint, because the guard below could not run until getSession()
   * resolved a tick later. The redirect worked; it just arrived after the content.
   */
  const [authState, setAuthState] = useState<"checking" | "authed" | "anon">("checking");

  // User States. Null until a session is read -- no placeholder identity.
  const [userRole, setUserRole] = useState<Role | null>(null);
  const [userEmail, setUserEmail] = useState<string>("");
  const [userFullName, setUserFullName] = useState<string>("");
  // Sign-out after inactivity, in minutes: the account's own choice from Settings, else 15 (19 Oct 2026).
  const [idleMinutes, setIdleMinutes] = useState<number>(DEFAULT_IDLE_MINUTES);
  const idleOut = useRef(false);

  // Fetch logged-in user details from Supabase
  useEffect(() => {
    function adopt(session: Session | null) {
      // A session that passed the password but not the authenticator code is
      // not a sign-in (lib/mfa.ts). It is ended and treated as no session, so
      // the shell goes back to the login screen rather than opening on half a
      // credential. The backend refuses such a token as well; this only keeps
      // the interface from showing a dashboard whose panels would never fill.
      // A sign-in with "Remember me" ticked is kept, though: the sign-in page carries it on at the
      // code step (app/page.tsx, 3 Nov 2026).
      if (session?.user && !isFullySignedIn(session)) {
        const email = (session.user.email ?? "").trim().toLowerCase();
        if (!email || rememberedEmail() !== email) dropPasswordOnlySession();
        session = null;
      }
      if (session?.user) {
        setUserEmail(session.user.email || "");
        const metadata = session.user.user_metadata;
        setUserRole(isRole(metadata?.role) ? metadata.role : FALLBACK_ROLE);
        setUserFullName(displayNameOf(metadata, session.user.email));
        setIdleMinutes(idleMinutesOf(metadata));
        setAuthState("authed");
      } else {
        setUserRole(null);
        setUserEmail("");
        setUserFullName("");
        setAuthState("anon");
      }
    }

    supabase.auth.getSession().then(({ data: { session } }) => adopt(session));

    // Covers sign-out in this tab, sign-out in another tab, and the token
    // refresh that the client performs on its own before a session lapses.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      adopt(session);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  /*
   * A refresh that failed on an API call means the session is unrecoverable.
   * Without this the panels simply stop filling and the user is left on a
   * dashboard that looks signed in.
   */
  useEffect(() => {
    function onSessionLost() {
      setAuthState("anon");
    }
    window.addEventListener(SESSION_LOST_EVENT, onSessionLost);
    return () => window.removeEventListener(SESSION_LOST_EVENT, onSessionLost);
  }, []);

  // No session: leave for the login screen.
  useEffect(() => {
    if (authState === "anon" && !idleOut.current) router.replace(LOGIN_ROUTE);
  }, [authState, router]);

  // Signed out after a spell without activity (components/dashboard/IdleGuard.tsx). The sign-in page says why.
  const handleIdleTimeout = useCallback(async () => {
    idleOut.current = true;
    await Promise.race([logActivity({ type: "session.idle_timeout", minutes: idleMinutes }), new Promise((r) => setTimeout(r, 1500))]);
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      /* local tokens are cleared regardless */
    }
    router.replace(`${LOGIN_ROUTE}?signedOut=idle&after=${idleMinutes}`);
  }, [idleMinutes, router]);

  /*
   * Log out means ending the session. The button used to only navigate to the
   * login page, which left the Supabase session alive: the next visit to
   * /dashboard walked straight back in, and on a shared operator PC that is
   * the one thing a log-out button exists to prevent. signOut clears the
   * stored tokens; the auth listener above then sees no session as well.
   * Navigation happens whether or not the network call succeeds, because the
   * local session is cleared either way and the user asked to leave.
   */
  const confirmLogout = useCallback(async () => {
    setLoggingOut(true);
    // The audit entry goes first: it needs the session to name the user.
    await logActivity({ type: "session.logout" });
    try {
      await supabase.auth.signOut();
    } catch {
      // Local tokens are cleared even when the revoke request fails.
    }
    router.replace(LOGIN_ROUTE);
  }, [router]);

  // Esc closes the dialog, and focus starts on Cancel: the safe choice is the
  // one a stray Enter should land on.
  useEffect(() => {
    if (!showLogoutConfirm) return;
    logoutCancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loggingOut) setShowLogoutConfirm(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showLogoutConfirm, loggingOut]);

  // Filter tabs by role. Both this and the guard below read one rule set in
  // lib/auth-access.ts, so a hidden link and an allowed route cannot disagree.
  const visibleTabs = useMemo(() => {
    if (!userRole) return [];
    return tabs.filter((tab) => canAccess(userRole, tab.href));
  }, [userRole]);

  // Route guard. Replaces push() with replace() so that the page the user was
  // refused does not sit in history for the back button to return them to.
  //
  // The notice stays up for a few seconds first, counting down (17 Oct 2026, all three testers: the
  // "not available to your role" screen was gone before it could be read, so a refused page looked like
  // a glitch that bounced them home). "Go now" skips the wait.
  const [blockedLeft, setBlockedLeft] = useState<number | null>(null);
  useEffect(() => {
    if (authState !== "authed" || !userRole || canAccess(userRole, pathname)) {
      setBlockedLeft(null);
      return;
    }
    setBlockedLeft(BLOCKED_NOTICE_S);
    const tick = window.setInterval(() => setBlockedLeft((n) => (n == null ? n : Math.max(1, n - 1))), 1000);
    const leave = window.setTimeout(() => router.replace(FALLBACK_ROUTE), BLOCKED_NOTICE_S * 1000);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(leave);
    };
  }, [authState, pathname, userRole, router]);

  // Which pages are actually used: the audit log's page views, once signed in and allowed there.
  useEffect(() => {
    if (authState === "authed" && userRole && pathname && canAccess(userRole, pathname)) logPageView(pathname);
  }, [authState, userRole, pathname]);

  // Detect mobile breakpoint
  useEffect(() => {
    function handleResize() {
      const mobile = window.innerWidth <= MOBILE_BREAKPOINT;
      setIsMobile(mobile);
    }

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Auto-close sidebar on mobile when navigating
  useEffect(() => {
    if (isMobile) {
      setSidebarOpen(false);
    }
  }, [pathname, isMobile]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const [now, setNow] = useState(new Date());

  // The pages pin their filter rows directly beneath the topbar. Its height is
  // 64px on desktop but wraps taller on narrow screens, so publish the measured
  // value as --ds-topbar-h on the scroll container rather than hard-coding it.
  const topbarRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const bar = topbarRef.current;
    const main = bar?.parentElement;
    if (!bar || !main || typeof ResizeObserver === "undefined") return;
    // The analytics pages' filter row too (--ds-shelf-h): the strip behind the page scrollbar grows
    // to cover it once it pins, so no sliver of background shows beside it.
    let shelf: Element | null = null;
    const apply = () => {
      main.style.setProperty("--ds-topbar-h", `${Math.round(bar.getBoundingClientRect().height)}px`);
      if (shelf) main.style.setProperty("--ds-shelf-h", `${Math.round(shelf.getBoundingClientRect().height)}px`);
      // The scroll area's full width, scrollbar included: the pinned bar's backing spans it in one piece.
      main.style.setProperty("--ds-main-w", `${Math.round(main.getBoundingClientRect().width)}px`);
      pin();
    };
    // Whether the filter row is pinned under the header right now, measured rather than assumed from
    // a scroll distance (pages pin at different depths): data-shelf-pinned on <main> colours the row
    // and its scrollbar-corner piece together (nlex-daylight.css).
    const pin = () => {
      const pinned =
        !!shelf &&
        getComputedStyle(shelf).position === "sticky" &&
        main.scrollTop > 0 &&
        shelf.getBoundingClientRect().top <= bar.getBoundingClientRect().bottom + 1;
      if (pinned) main.setAttribute("data-shelf-pinned", "");
      else main.removeAttribute("data-shelf-pinned");
    };
    let queued = 0;
    const onScroll = () => {
      if (!queued) queued = requestAnimationFrame(() => { queued = 0; pin(); });
    };
    main.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    ro.observe(main);
    // The page renders after this layout, so look for its filter row for a moment.
    const find = () => {
      const row = main.querySelector('[class*="filterRow"]');
      if (row && row !== shelf) {
        shelf = row;
        ro.observe(row);
      }
      apply();
    };
    find();
    const timers = [200, 800, 2000].map((ms) => window.setTimeout(find, ms));
    return () => {
      ro.disconnect();
      timers.forEach((t) => window.clearTimeout(t));
      main.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(queued);
      main.removeAttribute("data-shelf-pinned");
    };
    // Re-run once the shell is shown (the bar does not exist behind the session check) and per page.
  }, [authState, pathname]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const dateText = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const timeText = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  let shellClass = "ds-shell";
  if (isMobile) {
    if (sidebarOpen) shellClass += " ds-mobile-open";
  } else {
    if (!sidebarOpen) shellClass += " ds-shell-collapsed";
  }

  const avatarChar = userFullName ? userFullName.charAt(0).toUpperCase() : "A";
  const displayRoleName = useMemo(() => {
    if (userRole === "tcc-operator") return "TCC Operator";
    if (userRole === "incident-operator") return "Incident Operator";
    if (userRole === "data-analyst") return "Data Analyst";
    return "Administrator";
  }, [userRole]);

  // Presentation only: where the topbar breadcrumb says the reader is.
  const crumb = navEntryFor(pathname);
  const onLiveMap = pathname.startsWith("/dashboard/map-comparison");

  /*
   * Nothing of the shell renders until the session and role are known, and a
   * page the role may not see is never rendered even once.
   *
   * This is the part that actually prevents the flash. A redirect fired from an
   * effect runs after the children have painted, so guarding by redirect alone
   * still shows the forbidden page for a frame -- long enough to read, and long
   * enough to screenshot. Returning early means the component tree that would
   * render it is never constructed.
   */
  if (authState !== "authed" || !userRole || !canAccess(userRole, pathname)) {
    /* Only a refused page gets the notice card. The session check and the sign-in redirect show the bare
       scenery (19 Oct 2026, user request: the loading card was unnecessary). */
    const refused = authState === "authed" && userRole != null;
    return (
      <>
        <NlexEnvironment scene="page" />
        <NightCorridorStage variant="dashboard" />
        {refused && (
          <LoadingGate
            title="Not available for your role"
            detail={`Your account doesn't have access to ${crumb?.label ?? "this page"}. Ask an administrator if you need it.`}
            tone="warn"
            countdown={{ left: blockedLeft ?? BLOCKED_NOTICE_S, total: BLOCKED_NOTICE_S }}
            action={{ label: "Go to Overview now", onClick: () => router.replace(FALLBACK_ROUTE) }}
          />
        )}
      </>
    );
  }

  return (
    <>
    {/* Signs out after the account's idle limit, with a minute's warning. */}
    <IdleGuard minutes={idleMinutes} onTimeout={handleIdleTimeout} />
    {/* The NLEX environment behind every page, tab and sub-tab. */}
    <NlexEnvironment scene={pathname === "/dashboard" ? "hero" : "page"} />
    <NightCorridorStage variant="dashboard" />
    <div className={shellClass} data-accent={accentFor(pathname)}>
      {isMobile && sidebarOpen && (
        <div
          className="ds-sidebar-backdrop"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      <aside className="ds-sidebar">
        {/* Brand mark: the wordmark when expanded; nothing when the rail is
            collapsed to icons (the mascot face there was removed, user request). */}
        <div className="ds-sidebar-brand" aria-hidden="true">
          <span className="ds-sidebar-wordmark">SmartFlow <b>NLEX</b></span>
        </div>

        <nav className="ds-sidebar-nav">
          {NAV_GROUPS.map((group) => {
            const items = visibleTabs.filter((t) => t.group === group);
            if (items.length === 0) return null; // a role may see none of a group
            return (
              <div key={group} className="ds-nav-group">
                <span className="ds-nav-group-label">{group}</span>
                {items.map((tab) => (
                  <Link key={tab.href} href={tab.href} prefetch={true} className={`ds-sidebar-tab ${pathname === tab.href ? "active" : ""}`} data-label={tab.label}>
                    <tab.icon size={18} strokeWidth={2} />
                    <span className="ds-sidebar-tab-label">{tab.label}</span>
                  </Link>
                ))}
              </div>
            );
          })}

          {/* Admin sits after a spacer so it reads as separate from daily work. */}
          {visibleTabs.some((t) => t.group === "Admin") && (
            <div className="ds-nav-group ds-nav-group-admin">
              <span className="ds-nav-group-label">Admin</span>
              {visibleTabs.filter((t) => t.group === "Admin").map((tab) => (
                <Link key={tab.href} href={tab.href} prefetch={true} className={`ds-sidebar-tab ${pathname === tab.href ? "active" : ""}`} data-label={tab.label}>
                  <tab.icon size={18} strokeWidth={2} />
                  <span className="ds-sidebar-tab-label">{tab.label}</span>
                </Link>
              ))}
            </div>
          )}
        </nav>

        <div className="ds-sidebar-footer">
          <div className="ds-user-profile">
            <span className="ds-avatar-circle">{avatarChar}</span>
            <div className="ds-user-details">
              <span className="ds-user-email" title={userEmail}>{userFullName || userEmail}</span>
              <span className="ds-user-role">{displayRoleName}</span>
            </div>
          </div>
          <Link href="/dashboard/settings" prefetch={true} className={`ds-logout-button ds-settings-link${pathname === "/dashboard/settings" ? " active" : ""}`} data-label="Settings">
            <SettingsIcon size={16} strokeWidth={2.2} /> <span className="ds-sidebar-tab-label">Settings</span>
          </Link>
          <button type="button" className="ds-logout-button" onClick={() => setShowLogoutConfirm(true)} data-label="Log out">
            <LogOut size={16} strokeWidth={2.2} /> <span className="ds-sidebar-tab-label">Log out</span>
          </button>
        </div>
      </aside>

      <main className="ds-main">
        {/* Editorial grid hairlines; the Live Map has none (the map is the stage). */}
        {!onLiveMap && <EditorialGrid variant="dashboard" />}
        <header className="ds-topbar" ref={topbarRef}>
          <div className="ds-topbar-left">
            <button type="button" className="ds-menu-button" aria-label="Toggle menu" onClick={toggleSidebar}>
              <span />
              <span />
              <span />
            </button>
            <div className="ds-top-brand">
              {/* Two cuts of the mark, swapped in CSS for the same reason as the
                  hero: an explicit theme choice has to beat the OS setting in
                  both directions, and a JS swap would flash the wrong one on
                  load. Hidden with `display`, not `opacity` — unlike the hero
                  these sit in normal flow, so a transparent one would still take
                  up space and shove the wordmark sideways. */}
              <Image
                src="/SMARTFLOW_LOGO_WHITE.png"
                alt="SmartFlow NLEX"
                width={256}
                height={256}
                className="ds-brand-logo is-light"
                priority
              />
              <Image
                src="/logo-dark-bg.png"
                alt=""
                width={256}
                height={256}
                className="ds-brand-logo is-dark"
                priority
              />
              SmartFlow NLEX
            </div>
            {crumb && (
              <nav className="ds-crumbs" aria-label="Breadcrumb">
                <span>{crumb.group}</span>
                <span className="ds-crumbs-dot" aria-hidden="true">·</span>
                <span aria-current="page">{crumb.label}</span>
              </nav>
            )}
          </div>

          <div className="ds-topbar-right">
            {!onLiveMap && <EffectsToggle />}
            <ThemeToggle />
            {/* Live clock differs between server render and first client tick;
                suppress the expected hydration text mismatch on these nodes. */}
            <div className="ds-datetime-block">
              <span suppressHydrationWarning>{dateText}</span>
              <strong suppressHydrationWarning>{timeText}</strong>
            </div>
          </div>
        </header>

        {children}
        <SectionProgress />
      </main>

      {showLogoutConfirm && (
        <div
          className="ds-modal-backdrop"
          onClick={() => { if (!loggingOut) setShowLogoutConfirm(false); }}
        >
          <div
            className="ds-modal ds-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="logout-title"
            aria-describedby="logout-desc"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ds-confirm-body">
              <span className="ds-confirm-icon" aria-hidden="true">
                <Mascot size={78} mood={loggingOut ? "off" : "idle"} />
              </span>
              <div className="ds-confirm-text">
                <h3 id="logout-title">Log out of SmartFlow?</h3>
                <p id="logout-desc">You&apos;ll need to sign in again to open the dashboard.</p>
                {userEmail && (
                  <div className="ds-confirm-account">
                    <span className="ds-avatar-circle" aria-hidden="true">{avatarChar}</span>
                    <span className="ds-confirm-account-text">
                      <span className="ds-confirm-account-email" title={userEmail}>{userFullName || userEmail}</span>
                      <span className="ds-confirm-account-role">{displayRoleName}</span>
                    </span>
                  </div>
                )}
              </div>
            </div>
            <div className="ds-confirm-actions">
              <button
                ref={logoutCancelRef}
                type="button"
                className="ds-confirm-btn is-secondary"
                onClick={() => setShowLogoutConfirm(false)}
                disabled={loggingOut}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ds-confirm-btn is-danger"
                onClick={confirmLogout}
                disabled={loggingOut}
                aria-busy={loggingOut}
              >
                <LogOut size={15} strokeWidth={2.4} aria-hidden="true" />
                {loggingOut ? "Logging out…" : "Log out"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
