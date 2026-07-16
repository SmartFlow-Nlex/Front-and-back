"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Brain, Calendar, Car, ChevronDown, ClipboardList, Home, Leaf, LogOut, Map, Menu, TrendingUp, User, Wrench, X } from "lucide-react";
import DateFilter from "./components/DateFilter";
import { supabase } from "../../lib/supabase";

const tabs = [
  { label: "Home", href: "/dashboard", icon: Home },
  { label: "Traffic", href: "/dashboard/traffic", icon: TrendingUp },
  { label: "Incident", href: "/dashboard/incident", icon: AlertTriangle },
  { label: "Emissions", href: "/dashboard/sustainability", icon: Leaf },
  { label: "AI Sandbox", href: "/dashboard/ai-sandbox", icon: Car },
  { label: "Maintenance", href: "/dashboard/maintenance", icon: Wrench },
  { label: "Map Comparison", href: "/dashboard/map-comparison", icon: Map },
  { label: "Data Management", href: "/dashboard/data-management", icon: Brain },
  { label: "Audit Log", href: "/dashboard/audit-log", icon: ClipboardList },
];

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

  const [dateText, setDateText] = useState("");
  const [timeText, setTimeText] = useState("");

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setDateText(
        now.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      );
      setTimeText(
        now.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        })
      );
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

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
        <div className="ds-sidebar-brand">
          <div className="ds-sidebar-logo-container">
            <div className="ds-sidebar-brand-text">
              <span className="ds-sidebar-title"><span className="ds-brand-highlight">SmartFlow</span> NLEX</span>
              <span className="ds-sidebar-subtitle">Where Traffic Meets Intelligence</span>
            </div>
          </div>
          <button
            type="button"
            className="ds-sidebar-close"
            aria-label="Close sidebar"
            onClick={closeSidebar}
          >
            <X size={20} strokeWidth={2.5} />
          </button>
        </div>

        <nav className="ds-sidebar-nav">
          {visibleTabs.map((tab) => (
            <Link key={tab.href} href={tab.href} prefetch={true} className={`ds-sidebar-tab ${pathname === tab.href ? "active" : ""}`}>
              <tab.icon size={18} strokeWidth={2} />
              {tab.label}
            </Link>
          ))}
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
              <Image
                src="/SMARTFLOW_LOGO_WHITE.png"
                alt="SmartFlow Logo"
                width={224}
                height={64}
                className="w-auto max-h-12 object-contain"
                priority
              />
              SmartFlow NLEX
            </div>
          </div>

          <div className="ds-topbar-right">
            <div className="ds-datetime-block">
              <span>{dateText}</span>
              <strong>{timeText}</strong>
            </div>
            <DateFilter />
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
