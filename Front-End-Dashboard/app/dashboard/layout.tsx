"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Brain,
  Calendar,
  Car,
  ChevronDown,
  ClipboardList,
  Home,
  Leaf,
  LogOut,
  Map,
  Menu,
  Smartphone,
  TrendingUp,
  User,
  Wrench,
  X,
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
import ThemeToggle from "../../components/dashboard/ThemeToggle";

// The sidebar is the product's spine, so it is grouped by what the user is
// trying to do rather than listed flat. Admin utilities sit in their own group
// and are rendered pinned to the bottom, away from the daily-use links.
const tabs = [
  { label: "Overview", href: "/dashboard", icon: Home, group: "Analytics" },
  { label: "Traffic", href: "/dashboard/traffic", icon: TrendingUp, group: "Analytics" },
  { label: "Incidents", href: "/dashboard/incident", icon: AlertTriangle, group: "Analytics" },
  { label: "Emissions", href: "/dashboard/sustainability", icon: Leaf, group: "Analytics" },

  { label: "Live Map", href: "/dashboard/map-comparison", icon: Map, group: "Operations" },
  { label: "Maintenance", href: "/dashboard/maintenance", icon: Wrench, group: "Operations" },
  { label: "Mobile App", href: "/dashboard/mobile", icon: Smartphone, group: "Operations" },

  { label: "Scenario Sandbox", href: "/dashboard/scenario-sandbox", icon: Car, group: "Planning" },

  { label: "Data Management", href: "/dashboard/data-management", icon: Brain, group: "Admin" },
  { label: "Audit Log", href: "/dashboard/audit-log", icon: ClipboardList, group: "Admin" },
];

/** Daily-use groups, in order. "Admin" is deliberately excluded — it renders last. */
const NAV_GROUPS = ["Analytics", "Operations", "Planning"] as const;

const MOBILE_BREAKPOINT = 980;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

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

  // Fetch logged-in user details from Supabase
  useEffect(() => {
    function adopt(session: Session | null) {
      if (session?.user) {
        setUserEmail(session.user.email || "");
        const metadata = session.user.user_metadata;
        setUserRole(isRole(metadata?.role) ? metadata.role : FALLBACK_ROLE);
        setUserFullName(metadata?.full_name || session.user.email || "");
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
    if (authState === "anon") router.replace(LOGIN_ROUTE);
  }, [authState, router]);

  // Filter tabs by role. Both this and the guard below read one rule set in
  // lib/auth-access.ts, so a hidden link and an allowed route cannot disagree.
  const visibleTabs = useMemo(() => {
    if (!userRole) return [];
    return tabs.filter((tab) => canAccess(userRole, tab.href));
  }, [userRole]);

  // Route guard. Replaces push() with replace() so that the page the user was
  // refused does not sit in history for the back button to return them to.
  useEffect(() => {
    if (authState !== "authed" || !userRole) return;
    if (!canAccess(userRole, pathname)) router.replace(FALLBACK_ROUTE);
  }, [authState, pathname, userRole, router]);

  // Detect mobile breakpoint
  useEffect(() => {
    function handleResize() {
      const mobile = window.innerWidth <= MOBILE_BREAKPOINT;
      setIsMobile(mobile);
      if (!mobile) {
        setSidebarOpen(true);
      }
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
    const apply = () => main.style.setProperty("--ds-topbar-h", `${Math.round(bar.getBoundingClientRect().height)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

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
    const message =
      authState === "checking"
        ? "Checking your session…"
        : authState === "anon"
          ? "Redirecting to sign in…"
          : "You do not have access to that page. Returning to the overview…";
    return (
      <div className="ds-auth-gate" role="status" aria-live="polite">
        <span className="ds-auth-gate-spinner" aria-hidden="true" />
        <p>{message}</p>
      </div>
    );
  }

  return (
    <div className={shellClass}>
      {isMobile && sidebarOpen && (
        <div
          className="ds-sidebar-backdrop"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      <aside className="ds-sidebar">

        <nav className="ds-sidebar-nav">
          {NAV_GROUPS.map((group) => {
            const items = visibleTabs.filter((t) => t.group === group);
            if (items.length === 0) return null; // a role may see none of a group
            return (
              <div key={group} className="ds-nav-group">
                <span className="ds-nav-group-label">{group}</span>
                {items.map((tab) => (
                  <Link key={tab.href} href={tab.href} prefetch={true} className={`ds-sidebar-tab ${pathname === tab.href ? "active" : ""}`}>
                    <tab.icon size={18} strokeWidth={2} />
                    {tab.label}
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
                <Link key={tab.href} href={tab.href} prefetch={true} className={`ds-sidebar-tab ${pathname === tab.href ? "active" : ""}`}>
                  <tab.icon size={18} strokeWidth={2} />
                  {tab.label}
                </Link>
              ))}
            </div>
          )}
        </nav>

        <div className="ds-sidebar-footer">
          <div className="ds-user-profile">
            <span className="ds-avatar-circle">{avatarChar}</span>
            <div className="ds-user-details">
              <span className="ds-user-email">{userEmail}</span>
              <span className="ds-user-role">{displayRoleName}</span>
            </div>
          </div>
          <button type="button" className="ds-logout-button" onClick={() => setShowLogoutConfirm(true)}>
            <LogOut size={16} strokeWidth={2.5} /> Log out
          </button>
        </div>
      </aside>

      <main className="ds-main">
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
          </div>

          <div className="ds-topbar-right">
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
      </main>

      {showLogoutConfirm && (
        <div className="ds-modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm logout">
          <div className="ds-modal">
            <h3>Confirm Logout</h3>
            <p>Are you sure you want to log out?</p>
            <div className="ds-modal-actions">
              <button className="ds-button ds-button-ghost" onClick={() => setShowLogoutConfirm(false)}>
                Cancel
              </button>
              <button className="ds-button ds-button-danger" onClick={() => router.push("/")}>
                Log Out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
