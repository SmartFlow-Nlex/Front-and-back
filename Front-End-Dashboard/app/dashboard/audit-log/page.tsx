"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Shield, AlertCircle, Filter, BarChart2, Users, TrendingUp, Clock } from "lucide-react";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

type LogRow = {
  id: number;
  timestamp: string;
  user: string;
  category: string;
  action: string;
  details: string;
  severity: string;
  module: string;
};

type StatsData = {
  eventsPerModule: { module: string; total: string; warnings: string }[];
  topUsers: { user_id: string; total: string }[];
  topActions: { action: string; total: string }[];
  recentWarnings: { id: number; timestamp: string; user_id: string; action: string; target_resource: string; severity: string; details: Record<string, unknown> }[];
  dailyTrend: { day: string; total: string }[];
};

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

// Raw rows are `domain.action_name` + a JSON details blob; render them readably.
function mapLog(r: {
  id: number;
  timestamp: string;
  user_id: string;
  action: string;
  target_resource: string;
  module?: string;
  severity?: string;
  previous_status?: string;
  new_status?: string;
  details: Record<string, unknown> | null;
}): LogRow {
  const [domain, ...rest] = String(r.action).split(".");
  const category = cap(domain);
  const action = rest.length ? rest.join(".").split("_").map(cap).join(" ") : r.action;
  const d = r.details ?? {};
  const bits: string[] = [];
  if (typeof d.title === "string") bits.push(d.title);
  if (d.startKm != null && d.endKm != null) bits.push(`Km ${d.startKm}–${d.endKm}`);
  if (r.new_status) bits.push(`status → ${r.new_status.replace("_", " ")}`);
  else if (typeof d.to === "string") bits.push(`status → ${d.to.replace("_", " ")}`);
  if (typeof d.reason === "string") bits.push(`reason: ${d.reason}`);
  if (typeof d.filename === "string") bits.push(d.filename as string);
  if (typeof d.simId === "string") bits.push(d.simId as string);
  if (typeof d.model_target === "string") bits.push(`model: ${d.model_target}`);

  const severity = r.severity ?? (
    d.to === "cancelled" || action.toLowerCase().includes("deleted") ? "warning" : "info"
  );

  return {
    id: r.id,
    timestamp: r.timestamp,
    user: r.user_id,
    category,
    action,
    details: bits.join(" · ") || r.target_resource,
    severity: cap(severity),
    module: r.module ?? domain,
  };
}

// Module colour palette
const MODULE_COLORS: Record<string, string> = {
  maintenance: "#3b82f6",
  upload:      "#8b5cf6",
  ai:          "#06b6d4",
  incident:    "#f59e0b",
  traffic:     "#10b981",
  emissions:   "#6366f1",
};

function moduleColor(mod: string) {
  return MODULE_COLORS[mod.toLowerCase()] ?? "#94a3b8";
}

// Minimal bar chart rendered with plain divs
function BarChart({ data, label }: { data: { label: string; value: number }[]; label: string }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{label}</p>
      {data.map((d) => (
        <div key={d.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 90, fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>{d.label}</span>
          <div style={{ flex: 1, background: "var(--surface-2, #1e2130)", borderRadius: 4, height: 18, overflow: "hidden" }}>
            <div
              style={{
                width: `${(d.value / max) * 100}%`,
                height: "100%",
                background: "linear-gradient(90deg, #3b82f6, #6366f1)",
                borderRadius: 4,
                transition: "width 0.5s ease",
              }}
            />
          </div>
          <span style={{ width: 30, fontSize: 12, color: "var(--text-body)", textAlign: "right", flexShrink: 0 }}>{d.value}</span>
        </div>
      ))}
    </div>
  );
}

// Sparkline-style trend chart
function TrendChart({ data }: { data: { day: string; total: string }[] }) {
  const values = data.map((d) => Number(d.total));
  const max = Math.max(...values, 1);
  const width = 300;
  const height = 60;
  const pts = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * width;
    const y = height - (v / max) * (height - 8);
    return `${x},${y}`;
  });
  const polyline = pts.join(" ");

  return (
    <div>
      <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Daily Activity (14 days)</p>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: 60, display: "block" }}>
        <defs>
          <linearGradient id="trendGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#6366f1" />
          </linearGradient>
        </defs>
        <polyline
          points={polyline}
          fill="none"
          stroke="url(#trendGrad)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {values.map((v, i) => {
          const x = (i / Math.max(values.length - 1, 1)) * width;
          const y = height - (v / max) * (height - 8);
          return <circle key={i} cx={x} cy={y} r="3" fill="#6366f1" />;
        })}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{data[0]?.day ?? ""}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{data[data.length - 1]?.day ?? ""}</span>
      </div>
    </div>
  );
}

export default function AuditLogPage() {
  const [searchText, setSearchText] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [selectedSeverity, setSelectedSeverity] = useState("All");
  const [selectedDateRange, setSelectedDateRange] = useState("All Time");

  const [auditLogs, setAuditLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [stats, setStats] = useState<StatsData | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND}/api/audit-log/list`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setAuditLogs(json.data.map(mapLog));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));

    fetch(`${BACKEND}/api/audit-log/stats`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => { if (json.success) setStats(json.data); })
      .catch(() => {/* stats are best-effort */})
      .finally(() => setStatsLoading(false));
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
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().split("T")[0];
    a.download = `audit_logs_${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const warningCount = auditLogs.filter((l) => l.severity !== "Info").length;
  const totalTrend = stats?.dailyTrend.reduce((s, d) => s + Number(d.total), 0) ?? 0;

  return (
    <section className="ds-content ds-long">
      <h1 className="tab-title">Audit Log</h1>
      <p className="muted" style={{ marginBottom: 14 }}>Track all system activities, user actions, and workflow events</p>

      {/* ── Top stat cards ── */}
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
            <h3>Modules Tracked</h3>
            <div className="value">{stats ? stats.eventsPerModule.length : "—"}</div>
          </div>
          <div className="icon-box tone-green"><BarChart2 size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Warnings / Critical</h3>
            <div className="value" style={{ color: warningCount > 0 ? "var(--color-danger)" : undefined }}>{warningCount}</div>
          </div>
          <div className="icon-box tone-red"><AlertCircle size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Last 14 Days</h3>
            <div className="value">{statsLoading ? "—" : totalTrend}</div>
          </div>
          <div className="icon-box tone-purple"><TrendingUp size={20} /></div>
        </article>
      </div>

      {/* ── Analytics panels ── */}
      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginBottom: 20 }}>
          {/* Module breakdown */}
          <section className="table-card" style={{ padding: 20 }}>
            <BarChart
              label="Events by module"
              data={stats.eventsPerModule.map((m) => ({ label: cap(m.module), value: Number(m.total) }))}
            />
            {/* Module colour legend */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 12px", marginTop: 12 }}>
              {stats.eventsPerModule.map((m) => (
                <span key={m.module} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-muted)" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: moduleColor(m.module), display: "inline-block" }} />
                  {cap(m.module)}
                  {Number(m.warnings) > 0 && (
                    <span style={{ color: "#f59e0b", fontSize: 10 }}>⚠ {m.warnings}</span>
                  )}
                </span>
              ))}
            </div>
          </section>

          {/* Top users */}
          <section className="table-card" style={{ padding: 20 }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>
              <Users size={12} style={{ display: "inline", marginRight: 5 }} />Most Active Users
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {stats.topUsers.map((u, i) => (
                <div key={u.user_id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{
                    width: 24, height: 24, borderRadius: "50%",
                    background: i === 0 ? "#3b82f6" : i === 1 ? "#6366f1" : "var(--surface-2, #1e2130)",
                    color: "#fff", fontSize: 11, fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0
                  }}>{i + 1}</span>
                  <span style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.user_id}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-body)" }}>{u.total}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Top actions */}
          <section className="table-card" style={{ padding: 20 }}>
            <BarChart
              label="Most frequent actions"
              data={stats.topActions.slice(0, 6).map((a) => ({
                label: a.action.split(".").pop()?.replace(/_/g, " ") ?? a.action,
                value: Number(a.total),
              }))}
            />
          </section>

          {/* Daily trend */}
          <section className="table-card" style={{ padding: 20 }}>
            <TrendChart data={stats.dailyTrend} />
            {stats.recentWarnings.length > 0 && (
              <>
                <p style={{ fontSize: 11, fontWeight: 600, color: "#f59e0b", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 16, marginBottom: 8 }}>
                  <Clock size={12} style={{ display: "inline", marginRight: 5 }} />Recent Warnings (7d)
                </p>
                {stats.recentWarnings.slice(0, 3).map((w) => (
                  <div key={w.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 10, color: "#f59e0b", flexShrink: 0, marginTop: 2 }}>⚠</span>
                    <div>
                      <p style={{ fontSize: 12, fontWeight: 500, margin: 0 }}>{w.action.split("_").map(cap).join(" ")}</p>
                      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>{w.user_id} · {new Date(w.timestamp).toLocaleDateString()}</p>
                    </div>
                  </div>
                ))}
              </>
            )}
          </section>
        </div>
      )}

      {/* ── Log table ── */}
      <section className="table-card">
        <div className="table-toolbar">
          <input
            id="audit-search"
            placeholder="Search logs…"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
          <select id="audit-filter-category" value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)}>
            <option value="All">All Categories</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select id="audit-filter-severity" value={selectedSeverity} onChange={(event) => setSelectedSeverity(event.target.value)}>
            <option value="All">All Severities</option>
            <option value="Info">Info</option>
            <option value="Warning">Warning</option>
            <option value="Critical">Critical</option>
          </select>
          <select id="audit-filter-date" value={selectedDateRange} onChange={(event) => setSelectedDateRange(event.target.value)}>
            <option value="All Time">All Time</option>
            <option value="Today">Today</option>
            <option value="Last 7 Days">Last 7 Days</option>
            <option value="Last 30 Days">Last 30 Days</option>
          </select>
          <span style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
            <Filter size={13} /> {filteredLogs.length} results
          </span>
          <button id="audit-export-btn" className="btn-primary" onClick={exportJSON}>Export JSON</button>
          <button
            id="audit-clear-btn"
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
                <th>MODULE</th>
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
                <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>No audit events match the current filters.</td></tr>
              )}
              {filteredLogs.map((log) => (
                <tr key={log.id}>
                  <td className="font-mono text-xs text-gray-500">{`#${String(log.id).padStart(3, "0")}`}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(log.timestamp).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium" })}</td>
                  <td>{log.user}</td>
                  <td>
                    <span
                      className="badge"
                      style={{ background: `${moduleColor(log.module)}22`, color: moduleColor(log.module), borderColor: `${moduleColor(log.module)}44` }}
                    >
                      {log.module.toLowerCase()}
                    </span>
                  </td>
                  <td>{log.action}</td>
                  <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={log.details}>{log.details}</td>
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
