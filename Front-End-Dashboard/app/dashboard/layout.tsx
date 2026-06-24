"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Brain, Calendar, Car, ChevronDown, ClipboardList, Home, Leaf, LogOut, Map, Menu, TrendingUp, User, Wrench, X } from "lucide-react";
import DateFilter from "./components/DateFilter";

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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // Detect mobile breakpoint
  useEffect(() => {
    function handleResize() {
      const mobile = window.innerWidth <= MOBILE_BREAKPOINT;
      setIsMobile(mobile);
      if (!mobile) {
        // Auto-open sidebar when returning to desktop
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

  const dateText = useMemo(
    () =>
      new Date().toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    []
  );

  const timeText = useMemo(
    () =>
      new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    []
  );

  // Build shell class: on desktop use collapsed class, on mobile use mobile-open class
  let shellClass = "ds-shell";
  if (isMobile) {
    if (sidebarOpen) shellClass += " ds-mobile-open";
  } else {
    if (!sidebarOpen) shellClass += " ds-shell-collapsed";
  }

  return (
    <div className={shellClass}>
      {/* Mobile backdrop */}
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
          {tabs.map((tab) => (
            <Link key={tab.href} href={tab.href} prefetch={true} className={`ds-sidebar-tab ${pathname === tab.href ? "active" : ""}`}>
              <tab.icon size={18} strokeWidth={2} />
              {tab.label}
            </Link>
          ))}
        </nav>

        <div className="ds-sidebar-footer">
          <div className="ds-user-profile">
            <span className="ds-avatar-circle">A</span>
            <div className="ds-user-details">
              <span className="ds-user-email">admin@campus.edu</span>
              <span className="ds-user-role">Administrator</span>
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
              <img src="/SMARTFLOW_LOGO_WHITE.png" alt="SmartFlow Logo" />
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
              <button className="ds-button ds-button-danger">
                Log Out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
