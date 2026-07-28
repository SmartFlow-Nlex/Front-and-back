"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Shield, AlertCircle, ClipboardList, Filter } from "lucide-react";
import PageHeader from "../../../components/dashboard/PageHeader";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type LogRow = {
  id: number;
  timestamp: string;
  user: string;
  category: string;
  action: string;
  details: string;
  severity: string;
};

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

// Raw rows are `domain.action_name` + a JSON details blob; render them readably.
function mapLog(r: {
  id: number;
  timestamp: string;
  user_id: string;
  action: string;
  target_resource: string;
  details: Record<string, unknown> | null;
}): LogRow {
  const [domain, ...rest] = String(r.action).split(".");
  const category = cap(domain);
  const action = rest.length ? rest.join(".").split("_").map(cap).join(" ") : r.action;
  const d = r.details ?? {};
  const bits: string[] = [];
  if (typeof d.title === "string") bits.push(d.title);
  if (d.startKm != null && d.endKm != null) bits.push(`Km ${d.startKm}–${d.endKm}`);
  if (typeof d.to === "string") bits.push(`status → ${d.to.replace("_", " ")}`);
  if (typeof d.reason === "string") bits.push(`reason: ${d.reason}`);
  const severity =
    d.to === "cancelled" || action.toLowerCase().includes("deleted") ? "Warning" : "Info";
  return {
    id: r.id,
    timestamp: r.timestamp,
    user: r.user_id,
    category,
    action,
    details: bits.join(" · ") || r.target_resource,
    severity,
  };
}

export default function AuditLogPage() {
  const [searchText, setSearchText] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [selectedSeverity, setSelectedSeverity] = useState("All");
  const [selectedDateRange, setSelectedDateRange] = useState("All Time");

  const [auditLogs, setAuditLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BACKEND}/api/audit-log/list`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setAuditLogs(json.data.map(mapLog));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  const categories = useMemo(
    () => [...new Set(auditLogs.map((l) => l.category))].sort(),
    [auditLogs]
  );

  const now = new Date();

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfLast7Days = new Date(startOfToday);
  startOfLast7Days.setDate(startOfLast7Days.getDate() - 6);
  const startOfLast30Days = new Date(startOfToday);
  startOfLast30Days.setDate(startOfLast30Days.getDate() - 29);

  const filteredLogs = auditLogs.filter((log) => {
    const searchMatch = searchText.trim().toLowerCase();
    const matchesSearch =
      !searchMatch ||
      log.user.toLowerCase().includes(searchMatch) ||
      log.details.toLowerCase().includes(searchMatch) ||
      log.action.toLowerCase().includes(searchMatch);

    const matchesCategory = selectedCategory === "All" || log.category === selectedCategory;
    const matchesSeverity = selectedSeverity === "All" || log.severity === selectedSeverity;

    const timestamp = new Date(log.timestamp);
    const matchesDateRange =
      selectedDateRange === "All Time" ||
      (selectedDateRange === "Today" && timestamp >= startOfToday) ||
      (selectedDateRange === "Last 7 Days" && timestamp >= startOfLast7Days) ||
      (selectedDateRange === "Last 30 Days" && timestamp >= startOfLast30Days);

    return matchesSearch && matchesCategory && matchesSeverity && matchesDateRange;
  });

  const exportJSON = () => {
    const dataStr = JSON.stringify(filteredLogs, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const date = new Date().toISOString().split('T')[0];
    a.download = `audit_logs_${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="ds-content ds-long">
      <PageHeader icon={ClipboardList} title="Audit Log" subtitle="Track all system activities and user actions" />
      <div className="tab-stat-grid compact">
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Total Events</h3>
            <div className="value">{auditLogs.length}</div>
          </div>
          <div className="icon-box tone-blue"><Activity size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Maintenance Events</h3>
            <div className="value">{auditLogs.filter((l) => l.category === "Maintenance").length}</div>
          </div>
          <div className="icon-box tone-green"><Shield size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Warnings</h3>
            <div className="value">{auditLogs.filter((l) => l.severity !== "Info").length}</div>
          </div>
          <div className="icon-box tone-red"><AlertCircle size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Filtered Results</h3>
            <div className="value">{filteredLogs.length}</div>
          </div>
          <div className="icon-box tone-purple"><Filter size={20} /></div>
        </article>
      </div>
      <section className="table-card">
        <div className="table-toolbar">
          <input
            placeholder="Search logs..."
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
          <select value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)}>
            <option value="All">All Categories</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select value={selectedSeverity} onChange={(event) => setSelectedSeverity(event.target.value)}>
            <option value="All">All Severities</option>
            <option value="Info">Info</option>
            <option value="Warning">Warning</option>
            <option value="Critical">Critical</option>
          </select>
          <select value={selectedDateRange} onChange={(event) => setSelectedDateRange(event.target.value)}>
            <option value="All Time">All Time</option>
            <option value="Today">Today</option>
            <option value="Last 7 Days">Last 7 Days</option>
            <option value="Last 30 Days">Last 30 Days</option>
          </select>
          
          <button className="btn-primary" onClick={exportJSON}>Export JSON</button>
          <button
            className="btn-danger"
            onClick={() => {
              setSearchText("");
              setSelectedCategory("All");
              setSelectedSeverity("All");
              setSelectedDateRange("All Time");
            }}
          >
            Clear
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                  <th>ID</th>
                  <th>TIMESTAMP</th>
                  <th>USER</th>
                  <th>CATEGORY</th>
                  <th>ACTION</th>
                  <th>DETAILS</th>
                  <th>SEVERITY</th>
                </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>Loading…</td></tr>
              )}
              {error && !loading && (
                <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>Live data unavailable — is the backend running on port 4000?</td></tr>
              )}
              {!loading && !error && filteredLogs.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>No audit events yet — actions like scheduling maintenance will appear here.</td></tr>
              )}
              {filteredLogs.map((log) => (
                <tr key={log.id}>
                  <td className="font-mono text-xs text-gray-500">{`#${String(log.id).padStart(3, '0')}`}</td>
                  <td>{new Date(log.timestamp).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium" })}</td>
                  <td>{log.user}</td>
                  <td>
                    <span
                      className="badge"
                      style={
                        log.category === "Authentication"
                          ? { background: "#d9e7ff", color: "var(--color-info)" }
                          : log.category === "Navigation"
                            ? { background: "var(--color-purple-bg)", color: "var(--color-purple)" }
                            : log.category === "Data Operations"
                              ? { background: "#d8f2dd", color: "#15803d" }
                              : log.category === "System"
                                ? { background: "#f8ebc6", color: "#b45309" }
                                : { background: "#ffe0e0", color: "var(--color-danger)" }
                      }
                    >
                      {log.category.toLowerCase()}
                    </span>
                  </td>
                  <td>{log.action}</td>
                  <td>{log.details}</td>
                  <td><span className={`pill ${log.severity === "Critical" ? "red" : log.severity === "Warning" ? "amber" : "blue"}`}>{log.severity}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
