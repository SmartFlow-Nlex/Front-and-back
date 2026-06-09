"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { AlertTriangle, Brain, Car, ClipboardList, Home, Leaf, Map, TrendingUp, Wrench } from "lucide-react";

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

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

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

  return (
    <div className={`ds-shell ${sidebarOpen ? "" : "ds-shell-collapsed"}`}>
      <aside className="ds-sidebar">
        <div className="ds-sidebar-brand">
          <div>
            <h1>SmartFlow</h1>
            <p>NLEX Traffic Intelligence</p>
          </div>
          <button
            type="button"
            className="ds-sidebar-close"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            x
          </button>
        </div>

        <nav className="ds-sidebar-nav">
          {tabs.map((tab) => (
            <Link key={tab.href} href={tab.href} className={`ds-sidebar-tab ${pathname === tab.href ? "active" : ""}`}>
              <tab.icon size={18} strokeWidth={2} />
              {tab.label}
            </Link>
          ))}
        </nav>

        <div className="ds-sidebar-footer">
          <button type="button" className="ds-logout-button" onClick={() => setShowLogoutConfirm(true)}>
            Logout
          </button>
        </div>
      </aside>

      <main className="ds-main">
        <header className="ds-topbar">
          <div className="ds-topbar-left">
            <button type="button" className="ds-menu-button" aria-label="Menu" onClick={() => setSidebarOpen((v) => !v)}>
              <span />
              <span />
              <span />
            </button>
            <div className="ds-top-brand">
              <Image src="/SMARTFLOW_LOGO.png" alt="SmartFlow logo" width={72} height={72} unoptimized />
              SmartFlow NLEX
            </div>
          </div>

          <div className="ds-topbar-right">
            <div className="ds-datetime-block">
              <span>{dateText}</span>
              <strong>{timeText}</strong>
            </div>
            <button type="button" className="ds-user-chip">
              <span className="ds-avatar">SA</span>
              SA
            </button>
            <button type="button" className="ds-date-filter">
              All
            </button>
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
              <button type="button" className="ds-btn-secondary" onClick={() => setShowLogoutConfirm(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="ds-btn-primary"
                onClick={() => {
                  window.location.assign("/");
                }}
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
