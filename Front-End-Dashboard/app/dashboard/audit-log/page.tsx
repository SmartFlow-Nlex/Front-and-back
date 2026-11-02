"use client";

import { useEffect, useMemo, useState } from "react";
import { cachedJson } from "../../../lib/cached-json";
import { authedJson } from "../../../lib/api";
import { Activity, ClipboardList, Eye, Upload, Users } from "lucide-react";
import PageHeader from "../../../components/dashboard/PageHeader";
import StateNote from "../../../components/stage/StateNote";
import { SortableTh, useTableSort } from "../../../lib/table-sort";
import { logActivity } from "../../../lib/backend-auth";
import { fmtKmRange } from "../../../lib/km-post";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

/** An entry as the backend stores it (Back-End/src/services/audit.ts). */
type RawLog = {
  id: number;
  timestamp: string;
  user_id: string;
  action: string;
  target_resource: string;
  details: Record<string, unknown> | null;
  module?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  from_status?: string | null;
  to_status?: string | null;
  outcome?: string | null;
  duration_ms?: number | string | null;
  actor_role?: string | null;
};

type LogRow = {
  id: number;
  timestamp: string;
  user: string;
  role: string | null;
  category: string;
  action: string;
  details: string;
  severity: string;
};

/** The audit summary (Back-End/src/services/audit-insights.service.ts). */
type Insights = {
  days: number;
  totals: { actions: number; views: number; users: number; unidentified: number };
  daily: { day: string; actions: number; views: number }[];
  modules: { module: string; actions: number }[];
  pages: { path: string; views: number; users: number }[];
  users: { user: string; role: string | null; actions: number; last: string }[];
  uploads: {
    loaded: number; failed: number; undone: number; checked: number; undoRefused: number;
    avgLoadMs: number | null; waitingForRetrain: number; oldestWaiting: string | null; lastTrained: string | null; nextRetrain: string;
  };
  maintenance: {
    dwell: { status: string; changes: number; avgMs: number | null; maxMs: number | null }[];
    turnaround: { completed: number; avgMs: number | null };
    open: number; overrunning: number; lateToStart: number;
    items: { id: string; title: string; status: string; since: string; flag: string | null }[];
  };
  models: {
    groups: { group: string; title: string | null; outcome: string; at: string }[];
    lastBatch: { id: number; started_at: string; status: string; summary: string | null } | null;
    /** The hourly congestion refresh's own audit entries (model.live_refresh), last 24 hours. */
    hourly?: {
      hoursPublished: number;
      failed: number;
      last: { at: string; outcome: string; model: string | null; accuracy: string | null; reason: string | null; host: string | null } | null;
    };
  };
};

const MODULE_LABEL: Record<string, string> = {
  data_management: "Data Management",
  maintenance: "Maintenance",
  mobile_app: "Mobile App",
  model_training: "Model Training",
  navigation: "Navigation",
  session: "Sign-in",
  audit_log: "Audit Log",
  upload: "Data Management",
  mobile_config: "Mobile App",
};

const PAGE_LABEL: Record<string, string> = {
  "/dashboard": "Overview",
  "/dashboard/traffic": "Traffic",
  "/dashboard/incident": "Incidents",
  "/dashboard/sustainability": "Emissions",
  "/dashboard/map-comparison": "Live Map",
  "/dashboard/maintenance": "Maintenance",
  "/dashboard/mobile": "Mobile App",
  "/dashboard/scenario-sandbox": "Scenario Sandbox",
  "/dashboard/data-management": "Data Management",
  "/dashboard/audit-log": "Audit Log",
  "/dashboard/ai-sandbox": "AI Sandbox",
};

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const n = (v: number | null | undefined) => (v ?? 0).toLocaleString("en-US");

/** 42 s, 7 min, 5.3 h, 2.1 d. */
function span(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  // Non-breaking spaces: a number and its unit never wrap apart.
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}

const ago = (iso: string | null) => (iso ? span(Date.now() - new Date(iso).getTime()) : "—");
const when = (iso: string) => new Date(iso).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const status = (s: string) => s.replace(/_/g, " ");

// One readable row per entry: the module, what was done, the record's move from one status to
// the next, the outcome and how long it took. Older entries kept these in `details` only.
function mapLog(r: RawLog): LogRow {
  const [domain, ...rest] = String(r.action).split(".");
  const category = MODULE_LABEL[r.module ?? domain] ?? cap(domain);
  const action = rest.length ? rest.join(".").split("_").map(cap).join(" ") : r.action;
  const d = r.details ?? {};
  const bits: string[] = [];
  if (typeof d.title === "string") bits.push(d.title);
  if (typeof d.filename === "string") bits.push(d.filename);
  // Maintenance logs carry the stored (measured) km; show the official posts.
  if (d.startKm != null && d.endKm != null) bits.push(fmtKmRange(Number(d.startKm), Number(d.endKm), 2));
  const from = r.from_status ?? null;
  const to = r.to_status ?? (typeof d.to === "string" ? d.to : null);
  if (from && to && from !== to) bits.push(`${status(from)} → ${status(to)}`);
  else if (to && !from) bits.push(`→ ${status(to)}`);
  if (r.duration_ms != null && r.duration_ms !== "") {
    bits.push(r.action === "maintenance.status_changed" ? `after ${span(Number(r.duration_ms))} ${from ? status(from) : ""}`.trim() : span(Number(r.duration_ms)));
  }
  if (typeof d.rows_written === "number") bits.push(`${n(d.rows_written)} rows`);
  if (typeof d.reason === "string" && d.reason) bits.push(`reason: ${d.reason}`);
  if (r.action === "page.viewed") bits.push(PAGE_LABEL[r.entity_id ?? ""] ?? r.entity_id ?? "");
  const outcome = (r.outcome ?? "").toLowerCase();
  const severity =
    outcome === "restore failed" || r.action === "model.restore_failed"
      ? "Critical"
      : ["failed", "refused", "kept previous", "cannot run here", "cancelled"].includes(outcome) ||
          to === "cancelled" || action.toLowerCase().includes("deleted")
        ? "Warning"
        : "Info";
  return {
    id: r.id,
    timestamp: r.timestamp,
    user: r.user_id,
    role: r.actor_role ?? null,
    category,
    action: r.outcome && !["success", "passed"].includes(r.outcome) ? `${action} (${r.outcome})` : action,
    details: bits.filter(Boolean).join(" · ") || r.target_resource,
    severity,
  };
}

/** A row of labelled bars, longest first; values relative to the largest. */
function Bars({ rows }: { rows: { label: string; value: number; text?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="audit-empty">Nothing recorded yet.</p>;
  return (
    <ul className="audit-bars">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="audit-bar-label" title={r.label}>{r.label}</span>
          <span className="audit-bar-track"><span className="audit-bar-fill" style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="audit-bar-value">{r.text ?? n(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Every day of the period, oldest first, with the quiet ones as zeros: a gap is information too. */
function everyDay(data: Insights): { day: string; actions: number; views: number }[] {
  const byDay = new Map(data.daily.map((d) => [d.day, d]));
  const manilaToday = Date.parse(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10));
  return Array.from({ length: data.days }, (_, i) => {
    const day = new Date(manilaToday - (data.days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, actions: 0, views: 0 };
  });
}

/** "Sep 9" for a yyyy-mm-dd day. */
function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The congestion model the hourly refresh trains, as /api/map-comparison/forecast reports it. */
type HourlyModel = { name: string | null; trainedAt: string | null; maxHorizon: number | null };

function InsightsSection({ data, hourly }: { data: Insights; hourly: HourlyModel | null }) {
  const days = everyDay(data);
  const peak = Math.max(1, ...days.map((d) => d.actions + d.views));
  const m = data.maintenance;
  const u = data.uploads;
  return (
    <div className="audit-insights">
      <article className="audit-card">
        <h3 className="audit-card-head">
          Activity per day
          <span className="audit-legend"><span className="audit-key actions" /> actions <span className="audit-key views" /> page views</span>
        </h3>
        {data.daily.length === 0 ? (
          <p className="audit-empty">Nothing recorded yet.</p>
        ) : (
          <div className="audit-days" role="img" aria-label="Actions and page views per day">
            {days.map((d) => (
              <span key={d.day} className="audit-day" title={`${d.day}: ${d.actions} actions, ${d.views} page views`}>
                <span className="audit-day-views" style={{ height: `${(d.views / peak) * 100}%` }} />
                <span className="audit-day-actions" style={{ height: `${(d.actions / peak) * 100}%` }} />
              </span>
            ))}
          </div>
        )}
        {data.daily.length > 0 && (
          <p className="audit-axis"><span>{dayLabel(days[0].day)}</span><span>{dayLabel(days[days.length - 1].day)}</span></p>
        )}
      </article>

      <article className="audit-card">
        <h3>Activity by module</h3>
        <Bars rows={data.modules.map((x) => ({ label: MODULE_LABEL[x.module] ?? cap(x.module), value: x.actions }))} />
      </article>

      <article className="audit-card">
        <h3>Most-used pages</h3>
        <Bars rows={data.pages.map((p) => ({ label: PAGE_LABEL[p.path] ?? p.path, value: p.views, text: `${n(p.views)} · ${p.users} ${p.users === 1 ? "user" : "users"}` }))} />
      </article>

      <article className="audit-card">
        <h3>Where maintenance waits</h3>
        <Bars rows={m.dwell.map((d) => ({ label: cap(status(d.status)), value: d.avgMs ?? 0, text: `${span(d.avgMs)} avg` }))} />
        <p className="audit-note">
          {m.turnaround.completed > 0 && <>Scheduled to completed: <b>{span(m.turnaround.avgMs)}</b> ({m.turnaround.completed}) · </>}{m.open} open
          {m.overrunning > 0 && <> · <b className="audit-warn">{m.overrunning} past planned end</b></>}
          {m.lateToStart > 0 && <> · <b className="audit-warn">{m.lateToStart} late to start</b></>}
        </p>
        {m.items.filter((i) => i.flag).slice(0, 3).map((i) => (
          <p key={i.id} className="audit-note audit-warn">{i.title}: {i.flag}, {status(i.status)} for {ago(i.since)}</p>
        ))}
      </article>

      <article className="audit-card">
        <h3>Uploads &amp; retraining</h3>
        <p className="audit-line"><b>{n(u.loaded)}</b> loaded · {n(u.failed)} failed · {n(u.undone)} undone · {n(u.checked)} checked</p>
        {u.avgLoadMs != null && <p className="audit-line">Average load: <b>{span(u.avgLoadMs)}</b></p>}
        <p className="audit-line">
          Waiting for the weekly retrain: <b>{n(u.waitingForRetrain)}</b>
          {u.oldestWaiting && <> (oldest {ago(u.oldestWaiting)})</>} · next {when(u.nextRetrain)}
        </p>
        {data.models.lastBatch ? (
          <p className="audit-line">Last batch {when(data.models.lastBatch.started_at)}: <b>{data.models.lastBatch.status}</b></p>
        ) : (
          <p className="audit-line audit-muted">No weekly batch has run yet.</p>
        )}
        {data.models.hourly?.last ? (
          /* From the refresh's own audit entries: how many of the last 24 clock hours have a published
             run, and the newest entry. A refresh that never started leaves no entry, so it shows as a gap. */
          <p className={`audit-line${data.models.hourly.hoursPublished < 20 || data.models.hourly.failed > 0 ? " audit-warn" : ""}`}>
            Hourly congestion refresh: <b>{data.models.hourly.hoursPublished} of the last 24 hours</b> trained, tested and published
            {data.models.hourly.failed > 0 && <> · {data.models.hourly.failed} failed</>}
            {" "}· last {when(data.models.hourly.last.at)}: {data.models.hourly.last.outcome}
            {data.models.hourly.last.model && <>, {data.models.hourly.last.model}</>}
            {data.models.hourly.last.accuracy && <> {(Number(data.models.hourly.last.accuracy) * 100).toFixed(1)}%</>}
          </p>
        ) : hourly?.trainedAt ? (
          <p className="audit-line">
            Hourly traffic model: <b>{hourly.name ?? "model"}</b> trained {when(hourly.trainedAt)}
            {hourly.maxHorizon != null && <>, forecasting {hourly.maxHorizon} h ahead</>}
            <span className="audit-muted"> (its runs are not in the audit log yet)</span>
          </p>
        ) : null}
        {data.models.groups.slice(0, 4).map((g) => (
          <p key={g.group} className="audit-line audit-muted">{g.title ?? g.group}: {g.outcome}, {when(g.at)}</p>
        ))}
      </article>

      <article className="audit-card">
        <h3>Most active users</h3>
        {data.users.length === 0 ? (
          <p className="audit-empty">No signed-in activity yet.</p>
        ) : (
          <Bars rows={data.users.map((x) => ({ label: `${x.user}${x.role ? ` (${x.role})` : ""}`, value: x.actions }))} />
        )}
        {data.totals.unidentified > 0 && (
          <p className="audit-note audit-muted">{n(data.totals.unidentified)} older actions have no user: they were logged before sign-in was recorded.</p>
        )}
      </article>
    </div>
  );
}

export default function AuditLogPage() {
  const [searchText, setSearchText] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [selectedSeverity, setSelectedSeverity] = useState("All");
  const [selectedDateRange, setSelectedDateRange] = useState("All Time");

  const [auditLogs, setAuditLogs] = useState<LogRow[]>([]);
  // The hourly congestion refresh writes 24 entries a day; like page views they stay out of the list unless asked for.
  const [showHourly, setShowHourly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [days, setDays] = useState(30);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);

  useEffect(() => {
    authedJson<{ success: boolean; message?: string; data: RawLog[] }>(
      `${BACKEND}/api/audit-log/list?limit=500${showHourly ? "&include_hourly=1" : ""}`)
      .then((json) => {
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setAuditLogs(json.data.map(mapLog));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [showHourly]);

  useEffect(() => {
    setInsightsError(null);
    authedJson<{ success: boolean; message?: string; data: Insights }>(`${BACKEND}/api/audit-log/summary?days=${days}`)
      .then((json) => {
        if (!json.success) throw new Error(json.message ?? "Request failed");
        setInsights(json.data);
      })
      .catch((e) => setInsightsError(e instanceof Error ? e.message : "Failed to load"));
  }, [days]);

  // Fallback for the retraining card until the hourly refresh writes its own audit entries (a trainer older
  // than 2026-10-25 does not): its latest run, as it rides on the forecast the Live Map reads.
  const [hourly, setHourly] = useState<HourlyModel | null>(null);
  useEffect(() => {
    cachedJson<{ model?: HourlyModel | null }>(`${BACKEND}/api/map-comparison/forecast?hours=1`, 60_000)
      .then((json) => setHourly(json.model ?? null))
      .catch(() => setHourly(null));
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

  // Severity sorts by rank, not alphabetically — "Critical" before "Info"
  // matters, and A-Z would put Critical, Info, Warning in a meaningless order.
  const SEVERITY_RANK: Record<string, number> = { Critical: 0, Warning: 1, Info: 2 };
  const { sorted: visibleLogs, sort, toggle } = useTableSort(filteredLogs, {
    id: (l) => l.id,
    timestamp: (l) => new Date(l.timestamp),
    user: (l) => l.user,
    category: (l) => l.category,
    action: (l) => l.action,
    details: (l) => l.details,
    severity: (l) => SEVERITY_RANK[l.severity] ?? 99,
  });

  const exportJSON = () => {
    // Exports what is on screen, in the order it is on screen.
    const dataStr = JSON.stringify(visibleLogs, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const date = new Date().toISOString().split('T')[0];
    a.download = `audit_logs_${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
    void logActivity({ type: "audit.exported", rows: visibleLogs.length, format: "json" });
  };

  const t = insights?.totals;
  const u = insights?.uploads;

  return (
    <section className="ds-content ds-long audit-page">
      <PageHeader
        icon={ClipboardList}
        title="Audit Log"
        subtitle="Who did what, when, and how the work moves through the system"
        actions={
          <select aria-label="Insights period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        }
      />
      <div className="tab-stat-grid compact audit-kpis">
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Actions</h3>
            <div className="value">{t ? n(t.actions) : "—"}</div>
          </div>
          <div className="icon-box tone-blue"><Activity size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Active users</h3>
            <div className="value">{t ? n(t.users) : "—"}</div>
          </div>
          <div className="icon-box tone-green"><Users size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Page views</h3>
            <div className="value">{t ? n(t.views) : "—"}</div>
          </div>
          <div className="icon-box tone-purple"><Eye size={20} /></div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Uploads loaded</h3>
            <div className="value">{u ? n(u.loaded) : "—"}</div>
          </div>
          <div className="icon-box tone-red"><Upload size={20} /></div>
        </article>
      </div>

      {insightsError && (
        <div className="audit-insights-error">
          <StateNote kind="error" size={44}>
            <span className="audit-warn">Insights unavailable: {insightsError}</span>
          </StateNote>
        </div>
      )}
      {insights && <InsightsSection data={insights} hourly={hourly} />}

      <section className="table-card audit-log-table" style={{ marginTop: 16 }}>
        <div className="table-toolbar">
          <input
            aria-label="Search logs"
            placeholder="Search logs..."
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
          <select aria-label="Category" value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)}>
            <option value="All">All Categories</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select aria-label="Severity" value={selectedSeverity} onChange={(event) => setSelectedSeverity(event.target.value)}>
            <option value="All">All Severities</option>
            <option value="Info">Info</option>
            <option value="Warning">Warning</option>
            <option value="Critical">Critical</option>
          </select>
          <select aria-label="Date range" value={selectedDateRange} onChange={(event) => setSelectedDateRange(event.target.value)}>
            <option value="All Time">All Time</option>
            <option value="Today">Today</option>
            <option value="Last 7 Days">Last 7 Days</option>
            <option value="Last 30 Days">Last 30 Days</option>
          </select>

          <label className="audit-toggle" style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={showHourly} onChange={(e) => setShowHourly(e.target.checked)} />
            Show hourly model refreshes
          </label>
          <button className="nc-pill audit-export" onClick={exportJSON}>Export JSON</button>
          <button
            className="btn-danger"
            onClick={() => {
              setSearchText("");
              setSelectedCategory("All");
              setSelectedSeverity("All");
              setSelectedDateRange("All Time");
              setShowHourly(false);
            }}
          >
            Clear
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                  <SortableTh label="ID" sortKey="id" sort={sort} onToggle={toggle} />
                  <SortableTh label="TIMESTAMP" sortKey="timestamp" sort={sort} onToggle={toggle} />
                  <SortableTh label="USER" sortKey="user" sort={sort} onToggle={toggle} />
                  <SortableTh label="CATEGORY" sortKey="category" sort={sort} onToggle={toggle} />
                  <SortableTh label="ACTION" sortKey="action" sort={sort} onToggle={toggle} />
                  <SortableTh label="DETAILS" sortKey="details" sort={sort} onToggle={toggle} />
                  <SortableTh label="SEVERITY" sortKey="severity" sort={sort} onToggle={toggle} />
                </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>Loading…</td></tr>
              )}
              {error && !loading && (
                <tr><td colSpan={7} className="audit-state-cell"><StateNote kind="error" size={44}>Live data unavailable — is the backend running on port 4000?</StateNote></td></tr>
              )}
              {!loading && !error && visibleLogs.length === 0 && (
                <tr><td colSpan={7} className="audit-state-cell"><StateNote kind="nodata" size={44}>No audit events yet — actions like scheduling maintenance will appear here.</StateNote></td></tr>
              )}
              {visibleLogs.map((log) => (
                <tr key={log.id}>
                  <td className="audit-id">{`#${String(log.id).padStart(3, '0')}`}</td>
                  <td className="audit-time">{new Date(log.timestamp).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium" })}</td>
                  <td>
                    {log.user}
                    {log.role && <div className="audit-muted audit-role">{log.role}</div>}
                  </td>
                  <td>
                    {/* A neutral hairline pill: colour on this row is kept for Severity, so a
                        category never reads as a status (Maintenance used to be danger red). */}
                    <span className="badge audit-cat">
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
