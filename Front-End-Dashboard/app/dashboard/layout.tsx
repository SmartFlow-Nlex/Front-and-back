"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Brain, Calendar, Car, ChevronDown, ClipboardList, Home, Leaf, LogOut, Map, Menu, TrendingUp, User, Wrench, X } from "lucide-react";
import { supabase } from "../../lib/supabase";
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

  { label: "Scenario Sandbox", href: "/dashboard/ai-sandbox", icon: Car, group: "Planning" },

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

  // User States
  const [userRole, setUserRole] = useState<string>("data-analyst");
  const [userEmail, setUserEmail] = useState<string>("admin@campus.edu");
  const [userFullName, setUserFullName] = useState<string>("Administrator");

  // Fetch logged-in user details from Supabase
  useEffect(() => {
    async function getUserData() {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        setUserEmail(session.user.email || "admin@campus.edu");
        const metadata = session.user.user_metadata;
        if (metadata) {
          if (metadata.role) setUserRole(metadata.role);
          if (metadata.full_name) setUserFullName(metadata.full_name);
        }
      }
    }
    getUserData();

    // Listen to changes in auth session state
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUserEmail(session.user.email || "admin@campus.edu");
        const metadata = session.user.user_metadata;
        if (metadata) {
          if (metadata.role) setUserRole(metadata.role);
          if (metadata.full_name) setUserFullName(metadata.full_name);
        }
      } else {
        // Reset to default on sign-out
        setUserRole("data-analyst");
        setUserEmail("admin@campus.edu");
        setUserFullName("Administrator");
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // Filter tabs dynamically based on user role
  const visibleTabs = useMemo(() => {
    return tabs.filter((tab) => {
      if (userRole === "tcc-operator") {
        // TCC Operator cannot see: Emissions, Data Management, Audit Log
        if (
          tab.href === "/dashboard/sustainability" ||
          tab.href === "/dashboard/data-management" ||
          tab.href === "/dashboard/audit-log"
        ) {
          return false;
        }
      } else if (userRole === "incident-operator") {
        // Incident Operator cannot see: Emissions, AI Sandbox, Data Management, Audit Log
        if (
          tab.href === "/dashboard/sustainability" ||
          tab.href === "/dashboard/ai-sandbox" ||
          tab.href === "/dashboard/data-management" ||
          tab.href === "/dashboard/audit-log"
        ) {
          return false;
        }
      }
      return true;
    });
  }, [userRole]);

  // Secure client-side routing check
  useEffect(() => {
    if (userRole === "tcc-operator") {
      if (
        pathname === "/dashboard/sustainability" ||
        pathname === "/dashboard/data-management" ||
        pathname === "/dashboard/audit-log"
      ) {
        router.push("/dashboard");
      }
    } else if (userRole === "incident-operator") {
      if (
        pathname === "/dashboard/sustainability" ||
        pathname === "/dashboard/ai-sandbox" ||
        pathname === "/dashboard/data-management" ||
        pathname === "/dashboard/audit-log"
      ) {
        router.push("/dashboard");
      }
    }
  }, [pathname, userRole, router]);

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
        <header className="ds-topbar">
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
