"use client";

import { useState } from "react";
import { Activity, Shield, AlertCircle, Filter } from "lucide-react";

export default function AuditLogPage() {
  const [searchText, setSearchText] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [selectedSeverity, setSelectedSeverity] = useState("All");
  const [selectedDateRange, setSelectedDateRange] = useState("All Time");

  const now = new Date();
  const auditLogs = [
    {
      id: 1,
      timestamp: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      user: "admin",
      category: "Navigation",
      action: "Page Navigation",
      details: "Navigated to Audit Log",
      severity: "Info",
    },
    {
      id: 2,
      timestamp: new Date(now.getTime() - 20 * 60 * 60 * 1000).toISOString(),
      user: "traffic.ops",
      category: "Traffic",
      action: "Traffic Status Update",
      details: "Updated Bocaue Barrier congestion alert",
      severity: "Warning",
    },
    {
      id: 3,
      timestamp: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      user: "system",
      category: "System",
      action: "Cache Refresh",
      details: "Refreshed dashboard cache after scheduled sync",
      severity: "Info",
    },
    {
      id: 4,
      timestamp: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString(),
      user: "audit.bot",
      category: "Data Operations",
      action: "Record Export",
      details: "Exported 86 audit log rows for review",
      severity: "Info",
    },
    {
      id: 5,
      timestamp: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      user: "security.admin",
      category: "Authentication",
      action: "Login Success",
      details: "Signed in from approved workstation",
      severity: "Info",
    },
    {
      id: 6,
      timestamp: new Date(now.getTime() - 11 * 24 * 60 * 60 * 1000).toISOString(),
      user: "ops.lead",
      category: "Authentication",
      action: "Permission Review",
      details: "Reviewed role access for incident dashboard",
      severity: "Warning",
    },
    {
      id: 7,
      timestamp: new Date(now.getTime() - 18 * 24 * 60 * 60 * 1000).toISOString(),
      user: "system",
      category: "System",
      action: "Alert Triggered",
      details: "High latency threshold exceeded for traffic feed",
      severity: "Critical",
    },
    {
      id: 8,
      timestamp: new Date(now.getTime() - 33 * 24 * 60 * 60 * 1000).toISOString(),
      user: "admin",
      category: "Navigation",
      action: "Route Change",
      details: "Opened sustainability analytics page",
      severity: "Info",
    },
  ];

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
      <h1 className="tab-title">Audit Log</h1>
      <p className="muted" style={{ marginBottom: 14 }}>Track all system activities and user actions</p>
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
            <h3>Auth Events</h3>
            <div className="value">5</div>
          </div>
          <div className="icon-box tone-green"><Shield size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Critical Events</h3>
            <div className="value">0</div>
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
            <option>Authentication</option>
            <option>Navigation</option>
            <option>Data Operations</option>
            <option>System</option>
            <option>Traffic</option>
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
