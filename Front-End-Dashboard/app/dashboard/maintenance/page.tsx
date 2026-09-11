"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Calendar, ChevronDown, MapPin, Plus, Search, Wrench, X } from "lucide-react";
import PageHeader from "../../../components/dashboard/PageHeader";
import FeatureBriefing from "../../../components/dashboard/FeatureBriefing";
import styles from "../traffic/traffic.module.css";
import { supabase } from "../../../lib/supabase";

import { useToast } from "../../../lib/toast";
import { SortableTh, useTableSort } from "../../../lib/table-sort";
import { useNlexExits, exitNearestKm, displayExitName, CORRIDOR_KM, type NlexExit } from "../../../lib/nlex-exits";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";


const DIRECTIONS = ["Both", "NB", "SB"] as const;
const LANE_CLOSURES = ["None", "Shoulder only", "1 lane", "2 lanes", "Full closure"] as const;

type Status = "scheduled" | "in_progress" | "completed" | "cancelled";

type Schedule = {
  id: string;
  title: string;
  description: string | null;
  start_km: number;
  end_km: number;
  direction: "NB" | "SB" | "Both";
  lane_closure: string;
  starts_at: string;
  ends_at: string;
  status: Status;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
};

const STATUS_META: Record<Status, { label: string; badge: string }> = {
  scheduled: { label: "Scheduled", badge: "blue" },
  in_progress: { label: "In Progress", badge: "yellow" },
  completed: { label: "Completed", badge: "green" },
  cancelled: { label: "Cancelled", badge: "red" },
};

// What a row can transition to (mirrors the backend guard).
// Reverts let operators undo mistakes: reopen a completed job, restore a
// cancelled one, or send an in-progress job back to scheduled.
const NEXT_ACTIONS: Record<Status, { to: Status; label: string }[]> = {
  scheduled: [{ to: "in_progress", label: "Start work" }],
  in_progress: [
    { to: "completed", label: "Mark completed" },
    { to: "scheduled", label: "Revert to scheduled" },
  ],
  completed: [{ to: "in_progress", label: "Reopen work" }],
  cancelled: [{ to: "scheduled", label: "Restore schedule" }],
};

const fmtWindow = (startIso: string, endIso: string) => {
  const opt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return `${new Date(startIso).toLocaleString("en-US", opt)} → ${new Date(endIso).toLocaleString("en-US", opt)}`;
};

const kmRange = (s: Schedule) =>
  `Km ${s.start_km}${s.end_km !== s.start_km ? `–${s.end_km}` : ""}`;

// Nearest exit to a km-post, against the shared corridor list.
const nearestExitName = (exits: NlexExit[], km: number) => {
  const x = exitNearestKm(exits, km);
  return x ? displayExitName(x.exit_name) : "-";
};

// Modern dropdown — same look and behavior as the Traffic tab's custom select
function Select({
  value,
  placeholder,
  options,
  onChange,
}: {
  value: string;
  placeholder: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const clickOut = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", clickOut);
    return () => document.removeEventListener("mousedown", clickOut);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div className={styles.customSelectWrap} ref={ref} style={{ width: "100%" }}>
      <button
        type="button"
        className={styles.customSelectBtn}
        style={{ width: "100%", justifyContent: "space-between", padding: "10px 14px", fontSize: "0.95rem", fontWeight: 500, borderRadius: "var(--radius-sm)" }}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: selected ? undefined : "var(--text-muted)" }}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={16} style={{ flexShrink: 0, transition: "transform 0.15s", transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      {open && (
        <div className={styles.customSelectMenu} style={{ maxHeight: 240, overflowY: "auto", width: "100%" }}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`${styles.customSelectOption} ${value === o.value ? styles.customSelectOptionActive : ""}`}
              style={{ fontSize: "0.9rem", padding: "9px 12px" }}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
              {value === o.value && (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ marginLeft: "auto", color: "var(--brand-primary)" }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The status badge IS the control: click it to see the allowed transitions.
function StatusControl({
  schedule,
  disabled,
  onAdvance,
  onCancel,
}: {
  schedule: Schedule;
  disabled: boolean;
  onAdvance: (to: Status) => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const clickOut = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", clickOut);
    return () => document.removeEventListener("mousedown", clickOut);
  }, [open]);

  const meta = STATUS_META[schedule.status];
  const advances = NEXT_ACTIONS[schedule.status];
  const canCancel = schedule.status === "scheduled" || schedule.status === "in_progress";

  if (advances.length === 0 && !canCancel) {
    return <span className={`ms-badge ${meta.badge}`} style={{ whiteSpace: "nowrap" }}>{meta.label}</span>;
  }

  return (
    <div className={styles.customSelectWrap} ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`ms-badge ${meta.badge}`}
        style={{ whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", font: "inherit", fontSize: "0.7rem", fontWeight: 700 }}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title="Change status"
      >
        {meta.label}
        <ChevronDown size={12} style={{ transition: "transform 0.15s", transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      {open && (
        <div className={styles.customSelectMenu} style={{ minWidth: 180 }}>
          {advances.map((a) => (
            <button
              key={a.to}
              type="button"
              className={styles.customSelectOption}
              onClick={() => {
                setOpen(false);
                onAdvance(a.to);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ marginRight: 6, color: "var(--brand-primary)" }}><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              {a.label}
            </button>
          ))}
          {canCancel && (
            <button
              type="button"
              className={styles.customSelectOption}
              style={{ color: "var(--color-danger)" }}
              onClick={() => {
                setOpen(false);
                onCancel();
              }}
            >
              <X size={13} style={{ marginRight: 6 }} />
              Cancel schedule…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const SECTION_STYLE: React.CSSProperties = {
  margin: "0 0 -6px",
  fontSize: "0.72rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: "var(--text-muted)",
};

const emptyForm = {
  title: "",
  description: "",
  startKm: "",
  endKm: "",
  direction: "Both" as (typeof DIRECTIONS)[number],
  laneClosure: "Shoulder only" as (typeof LANE_CLOSURES)[number],
  startDate: "",
  startTime: "08:00",
  endDate: "",
  endTime: "17:00",
};

export default function MaintenancePage() {
  // Same corridor list as the map and the AI sandbox. See lib/nlex-exits.
  const { exits: NLEX_EXITS } = useNlexExits();
  const toast = useToast();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState<Schedule | null>(null);
  const [actor, setActor] = useState("dashboard");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.email) setActor(session.user.email);
    });
  }, []);
  const [cancelTarget, setCancelTarget] = useState<Schedule | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [mutating, setMutating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/api/maintenance/list`, { cache: "no-store" });
      const json = await r.json();
      if (!json.success) throw new Error(json.message ?? "Request failed");
      setSchedules(json.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ---------- Derived ----------
  const counts = useMemo(() => {
    const by = { scheduled: 0, in_progress: 0, completed: 0, cancelled: 0 };
    for (const s of schedules) by[s.status]++;
    return by;
  }, [schedules]);

  const nextWindow = useMemo(() => {
    const upcoming = schedules
      .filter((s) => s.status === "scheduled" && new Date(s.starts_at) > new Date())
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    return upcoming[0] ?? null;
  }, [schedules]);

  const kmUnderWork = useMemo(
    () =>
      schedules
        .filter((s) => s.status === "in_progress")
        .reduce((sum, s) => sum + Math.abs(s.end_km - s.start_km), 0),
    [schedules]
  );

  const filteredVisible = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return schedules.filter((s) => {
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q) ||
        kmRange(s).toLowerCase().includes(q) ||
        s.direction.toLowerCase().includes(q)
      );
    });
  }, [schedules, statusFilter, searchQuery]);

  // Status sorts along the lifecycle, not the alphabet: scheduled work is what
  // an operator acts on, cancelled work is what they ignore. A-Z would open with
  // "cancelled" and bury "scheduled" in the middle.
  const STATUS_RANK: Record<Status, number> = { scheduled: 0, in_progress: 1, completed: 2, cancelled: 3 };
  const { sorted: visible, sort, toggle } = useTableSort(
    filteredVisible,
    {
      status: (s) => STATUS_RANK[s.status],
      title: (s) => s.title,
      location: (s) => s.start_km,
      window: (s) => new Date(s.starts_at),
    },
    // Soonest first by default: the next window to happen is the useful default,
    // and it is what someone scanning this page is looking for.
    { key: "window", dir: "asc" },
  );

  // ---------- Mutations ----------
  const changeStatus = async (s: Schedule, to: Status, reason?: string) => {
    if (mutating) return; // ignore double-fires while a request is in flight
    setMutating(true);
    setActionError(null);
    try {
      const r = await fetch(`${BACKEND}/api/maintenance/${s.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-user": actor },
        body: JSON.stringify(reason ? { status: to, reason } : { status: to }),
      });
      const json = await r.json();
      if (!json.success) throw new Error(json.message ?? "Update failed");
      await refresh();
      setDetail(null);
      setCancelTarget(null);
      setCancelReason("");
      toast.success(`"${s.title}" is now ${STATUS_META[to].label.toLowerCase()}.`);
    } catch (e) {
      // Re-sync with the database so a stale row never sits next to the error
      await refresh();
      const msg = e instanceof Error ? e.message : "Update failed";
      setActionError(msg);
      setTimeout(() => setActionError(null), 5000);
      toast.error(`Could not update "${s.title}".`, msg);
    } finally {
      setMutating(false);
    }
  };

  const openEdit = (s: Schedule) => {
    const starts = new Date(s.starts_at);
    const ends = new Date(s.ends_at);
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    setForm({
      title: s.title,
      description: s.description ?? "",
      startKm: String(s.start_km),
      endKm: String(s.end_km),
      direction: s.direction,
      laneClosure: s.lane_closure as (typeof LANE_CLOSURES)[number],
      startDate: dateOf(starts),
      startTime: timeOf(starts),
      endDate: dateOf(ends),
      endTime: timeOf(ends),
    });
    setEditId(s.id);
    setFormError(null);
    setDetail(null);
    setFormOpen(true);
  };

  const submitForm = async () => {
    const startKm = Number(form.startKm);
    const endKm = Number(form.endKm);
    if (form.title.trim().length < 3) return setFormError("Give the work a short title (at least 3 characters).");
    if (form.startKm === "" || form.endKm === "" || Number.isNaN(startKm) || Number.isNaN(endKm))
      return setFormError("Both Km markers are required.");
    if (startKm < 0 || startKm > 100 || endKm < 0 || endKm > 100)
      return setFormError("Km markers must be between 0 and 100.");
    if (!form.startDate || !form.endDate) return setFormError("Start and end date are required.");
    const startsAt = new Date(`${form.startDate}T${form.startTime || "00:00"}`);
    const endsAt = new Date(`${form.endDate}T${form.endTime || "00:00"}`);
    if (endsAt <= startsAt) return setFormError("The window must end after it starts.");

    setSaving(true);
    setFormError(null);
    try {
      const r = await fetch(editId ? `${BACKEND}/api/maintenance/${editId}` : `${BACKEND}/api/maintenance/schedule`, {
        method: editId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", "x-user": actor },
        body: JSON.stringify({
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          startKm,
          endKm,
          direction: form.direction,
          laneClosure: form.laneClosure,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        }),
      });
      const json = await r.json();
      if (!json.success) throw new Error(json.message ?? "Save failed");
      const wasEdit = editId !== null;
      await refresh();
      setFormOpen(false);
      setForm(emptyForm);
      setEditId(null);
      toast.success(
        wasEdit ? `Updated "${form.title.trim()}".` : `Scheduled "${form.title.trim()}".`,
        `${form.direction} · Km ${startKm}–${endKm} · ${form.laneClosure}`,
      );
    } catch (e) {
      // Kept inline as well as in the toast: the form stays open on failure, so
      // the message belongs next to the fields that need fixing.
      const msg = e instanceof Error ? e.message : "Save failed — is the backend running?";
      setFormError(msg);
      toast.error(editId ? "Could not save your changes." : "Could not schedule the work.", msg);
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof typeof emptyForm>(k: K, v: (typeof emptyForm)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const segmentNote =
    form.startKm !== "" && form.endKm !== "" && !Number.isNaN(Number(form.startKm)) && !Number.isNaN(Number(form.endKm))
      ? `${Math.abs(Number(form.endKm) - Number(form.startKm)).toFixed(1)} km · near ${nearestExitName(NLEX_EXITS, Number(form.startKm))} → ${nearestExitName(NLEX_EXITS, Number(form.endKm))}`
      : null;

  const check = (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, marginBottom: -1 }}>
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  return (
    <section className={styles.page}>
      <PageHeader icon={Wrench} title="Maintenance Overview" subtitle="Scheduled roadworks, closures, and asset upkeep across NLEX" />

      {/* Row A — filters + primary action */}
      <div className={styles.filterRow} style={{ flexWrap: "wrap", rowGap: 8 }}>
        <div className={styles.filterGroup}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-muted)" }}><path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          <span className={styles.filterLabel}>Status</span>
          <div className={styles.segmented}>
            {(["all", "scheduled", "in_progress", "completed", "cancelled"] as const).map((s) => (
              <button key={s} className={statusFilter === s ? "active" : ""} onClick={() => setStatusFilter(s)}>
                {statusFilter === s && check}
                {s === "all" ? "All" : STATUS_META[s].label}
              </button>
            ))}
          </div>
        </div>

        <div className="ms-search-bar" style={{ width: 220, padding: "7px 14px", flexShrink: 1 }}>
          <Search size={15} />
          <input type="text" placeholder="Search schedules…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
        </div>
      </div>

      {/* Row B — KPI tiles */}
      <div className={styles.kpiRow}>
        <article className={styles.kpiTile}>
          <h3>In Progress</h3>
          <div className={styles.kpiValue}>{loading ? "…" : counts.in_progress}</div>
          <p className={styles.kpiHint}>{kmUnderWork > 0 ? `${kmUnderWork.toFixed(1)} km under work right now` : "no active roadwork"}</p>
        </article>
        <article className={styles.kpiTile}>
          <h3>Scheduled</h3>
          <div className={styles.kpiValue}>{loading ? "…" : counts.scheduled}</div>
          <p className={styles.kpiHint}>
            {nextWindow
              ? `next: ${new Date(nextWindow.starts_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${kmRange(nextWindow)}`
              : "nothing upcoming"}
          </p>
        </article>
        <article className={styles.kpiTile}>
          <h3>Completed</h3>
          <div className={styles.kpiValue}>{loading ? "…" : counts.completed}</div>
          <p className={styles.kpiHint}>all time</p>
        </article>
        <article className={styles.kpiTile}>
          <h3>Cancelled</h3>
          <div className={styles.kpiValue}>{loading ? "…" : counts.cancelled}</div>
          <p className={styles.kpiHint}>all time</p>
        </article>
      </div>

      {/* Sits between the tiles and the list: the tiles give the counts, this
          says what the plan as a whole looks like. */}
      <FeatureBriefing feature="maintenance" title="Schedule Read-out" />

      {/* Row C — schedule list */}
      <article className={`${styles.chartCard} ${styles.chart1}`}>
        <div className={styles.chartHead}>
          <div className={styles.headText}>
            <h3>Maintenance Schedules</h3>
            <p className={styles.subtitle}>
              {loading ? "Loading…" : `${visible.length} of ${schedules.length} shown`}
            </p>
          </div>
          <button className="ms-btn-primary" style={{ whiteSpace: "nowrap", flexShrink: 0, padding: "8px 16px" }} onClick={() => { setFormError(null); setEditId(null); setForm(emptyForm); setFormOpen(true); }}>
            <Plus size={16} /> Schedule Maintenance
          </button>
        </div>

        {error ? (
          <div className={styles.placeholder}>Live data unavailable — is the backend running on port 4000?</div>
        ) : !loading && schedules.length === 0 ? (
          <div className={styles.placeholder}>No maintenance scheduled yet — create the first one.</div>
        ) : !loading && visible.length === 0 ? (
          <div className={styles.placeholder}>Nothing matches the current filters.</div>
        ) : (
          <div className={styles.plazaTableWrap} style={{ maxHeight: "none", overflow: "visible" }}>
            <table className={styles.plazaTable}>
              <thead>
                <tr>
                  <SortableTh label="Status" sortKey="status" sort={sort} onToggle={toggle} />
                  <SortableTh label="Work" sortKey="title" sort={sort} onToggle={toggle} />
                  <SortableTh label="Location" sortKey="location" sort={sort} onToggle={toggle} />
                  <SortableTh label="Window" sortKey="window" sort={sort} onToggle={toggle} />
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.id} className={styles.clickableRow} onClick={() => { setActionError(null); setDetail(s); }}>
                    <td>
                      <StatusControl
                        schedule={s}
                        disabled={mutating}
                        onAdvance={(to) => changeStatus(s, to)}
                        onCancel={() => { setActionError(null); setCancelReason(""); setCancelTarget(s); }}
                      />
                    </td>
                    <td>
                      <strong>{s.title}</strong>
                      {s.description && (
                        <span style={{ display: "block", fontSize: "0.78rem", color: "var(--text-muted)", maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {s.description}
                        </span>
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {kmRange(s)} · {s.direction}
                      <span style={{ display: "block", fontSize: "0.78rem", color: "var(--text-muted)" }}>{s.lane_closure}</span>
                    </td>
                    <td>{fmtWindow(s.starts_at, s.ends_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {actionError && !detail && !cancelTarget && (
          <p style={{ color: "var(--color-danger)", fontSize: "0.8rem", padding: "8px 18px" }}>{actionError}</p>
        )}
      </article>

      {/* Detail modal */}
      {detail && (
        <div className={styles.detailBackdrop} role="dialog" aria-modal="true" aria-label={detail.title} onClick={() => setDetail(null)}>
          <div className={styles.detailModal} style={{ width: "min(94vw, 480px)" }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.detailAccent} />
            <div className={styles.detailHeader}>
              <div className={styles.detailIcon}>🛠️</div>
              <div className={styles.detailTitles}>
                <h3>{detail.title}</h3>
                <p><span className={`ms-badge ${STATUS_META[detail.status].badge}`}>{STATUS_META[detail.status].label}</span></p>
              </div>
              <button className={styles.detailClose} onClick={() => setDetail(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className={styles.detailBody}>
              {([
                ["Location", `${kmRange(detail)} · ${detail.direction}`],
                ["Near", `${nearestExitName(NLEX_EXITS, detail.start_km)} → ${nearestExitName(NLEX_EXITS, detail.end_km)}`],
                ["Lane closure", detail.lane_closure],
                ["Window", fmtWindow(detail.starts_at, detail.ends_at)],
                ["Description", detail.description || "—"],
                ...(detail.status_reason ? ([["Reason", detail.status_reason]] as [string, string][]) : []),
                ["Created", new Date(detail.created_at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })],
              ] as [string, string][]).map(([k, v], i) => (
                <div key={k} className={`${styles.detailRow} ${i % 2 === 0 ? styles.detailRowAlt : ""}`}>
                  <span className={styles.detailKey}>{k}</span>
                  <span className={styles.detailVal}>{v}</span>
                </div>
              ))}
            </div>
            {actionError && <p style={{ color: "var(--color-danger)", fontSize: "0.8rem", padding: "0 18px 8px" }}>{actionError}</p>}
            {(NEXT_ACTIONS[detail.status].length > 0 || detail.status === "scheduled" || detail.status === "in_progress") && (
              <div className="ms-form-actions" style={{ padding: "0 18px 16px", flexWrap: "wrap" }}>
                <button className="ms-btn-cancel" disabled={mutating} onClick={() => openEdit(detail)}>
                  Edit details
                </button>
                {NEXT_ACTIONS[detail.status].map((a) => (
                  <button key={a.to} className="ms-btn-submit" disabled={mutating} onClick={() => changeStatus(detail, a.to)}>
                    {mutating ? "Saving…" : a.label}
                  </button>
                ))}
                <button
                  className="ms-btn-cancel"
                  disabled={mutating}
                  onClick={() => { setCancelReason(""); setCancelTarget(detail); setDetail(null); }}
                >
                  Cancel schedule
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Cancel-with-reason modal */}
      {cancelTarget && (
        <div className={styles.detailBackdrop} role="dialog" aria-modal="true" aria-label="Cancel schedule" onClick={() => setCancelTarget(null)}>
          <div className={styles.detailModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.detailAccent} />
            <div className={styles.detailHeader}>
              <div className={styles.detailIcon}>⚠️</div>
              <div className={styles.detailTitles}>
                <h3>Cancel this schedule?</h3>
                <p>{cancelTarget.title} · {kmRange(cancelTarget)}</p>
              </div>
              <button className={styles.detailClose} onClick={() => setCancelTarget(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div style={{ padding: "4px 18px 0" }}>
              <div className="ms-input-group">
                <label>Cancellation reason <span className="ms-req">*</span></label>
                <textarea
                  className="ms-input ms-textarea"
                  rows={3}
                  placeholder="Why is this work being cancelled?"
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                />
              </div>
              {actionError && <p style={{ color: "var(--color-danger)", fontSize: "0.8rem", marginTop: 6 }}>{actionError}</p>}
            </div>
            <div className="ms-form-actions" style={{ padding: "12px 18px 16px" }}>
              <button
                className="ms-btn-submit ms-btn-danger-action"
                disabled={mutating || !cancelReason.trim()}
                onClick={() => changeStatus(cancelTarget, "cancelled", cancelReason.trim())}
              >
                {mutating ? "Cancelling…" : "Cancel schedule"}
              </button>
              <button className="ms-btn-cancel" disabled={mutating} onClick={() => setCancelTarget(null)}>
                Keep it
              </button>
            </div>
            <div className={styles.detailFooter}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" /><path d="M8 7v4M8 5.2v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
              <p>This cannot be undone.</p>
            </div>
          </div>
        </div>
      )}

      {/* Schedule form modal */}
      {formOpen && (
        <div className={styles.detailBackdrop} role="dialog" aria-modal="true" aria-label="Schedule maintenance" onClick={() => !saving && setFormOpen(false)}>
          <div className={styles.detailModal} style={{ width: "min(94vw, 780px)" }} onClick={(e) => e.stopPropagation()}>
            <div className={styles.detailAccent} />
            <div className={styles.detailHeader}>
              <div className={styles.detailIcon}>🛠️</div>
              <div className={styles.detailTitles}>
                <h3>{editId ? "Edit Maintenance" : "Schedule Maintenance"}</h3>
              </div>
              <button className={styles.detailClose} onClick={() => setFormOpen(false)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div style={{ padding: "6px 24px 4px", maxHeight: "calc(100vh - 180px)", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="ms-input-group">
                <label>Title <span className="ms-req">*</span></label>
                <input
                  type="text"
                  className="ms-input"
                  placeholder="e.g. Road resurfacing, toll booth repair…"
                  value={form.title}
                  onChange={(e) => set("title", e.target.value)}
                />
              </div>

              <p className="ms-section-label" style={{ ...SECTION_STYLE, marginTop: 8 }}>Location</p>
              <div style={{ display: "grid", gridTemplateColumns: "0.65fr 1.35fr 0.65fr 1.35fr", gap: 12 }}>
                <div className="ms-input-group">
                  <label>Start Km <span className="ms-req">*</span></label>
                  <input type="number" min={0} max={100} className="ms-input" placeholder={`0–${CORRIDOR_KM}`} value={form.startKm} onChange={(e) => set("startKm", e.target.value)} />
                </div>
                <div className="ms-input-group">
                  <label>Start exit</label>
                  <Select
                    value={form.startKm}
                    placeholder="Pick an exit…"
                    options={NLEX_EXITS.map((x) => ({ label: `${displayExitName(x.exit_name)} (Km ${x.km})`, value: String(x.km) }))}
                    onChange={(v) => set("startKm", v)}
                  />
                </div>
                <div className="ms-input-group">
                  <label>End Km <span className="ms-req">*</span></label>
                  <input type="number" min={0} max={100} className="ms-input" placeholder={`0–${CORRIDOR_KM}`} value={form.endKm} onChange={(e) => set("endKm", e.target.value)} />
                </div>
                <div className="ms-input-group">
                  <label>End exit</label>
                  <Select
                    value={form.endKm}
                    placeholder="Pick an exit…"
                    options={NLEX_EXITS.map((x) => ({ label: `${displayExitName(x.exit_name)} (Km ${x.km})`, value: String(x.km) }))}
                    onChange={(v) => set("endKm", v)}
                  />
                </div>
              </div>

              {segmentNote && (
                <p style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.8rem", color: "var(--text-secondary)", margin: "-4px 0 0" }}>
                  <MapPin size={13} /> {segmentNote}
                </p>
              )}

              <div className="ms-form-row">
                <div className="ms-input-group">
                  <label>Direction</label>
                  <div className={styles.segmentedSmall} style={{ width: "100%" }}>
                    {DIRECTIONS.map((d) => (
                      <button
                        key={d}
                        type="button"
                        className={form.direction === d ? "active" : ""}
                        style={{ flex: 1, padding: "9px 12px", fontSize: "0.88rem" }}
                        onClick={() => set("direction", d)}
                      >
                        {form.direction === d && check}
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ms-input-group">
                  <label>Lane closure</label>
                  <Select
                    value={form.laneClosure}
                    placeholder="Select lane closure"
                    options={LANE_CLOSURES.map((l) => ({ label: l, value: l }))}
                    onChange={(v) => set("laneClosure", v as (typeof LANE_CLOSURES)[number])}
                  />
                </div>
              </div>

              <p className="ms-section-label" style={{ ...SECTION_STYLE, marginTop: 8 }}>Window</p>
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1.2fr 1fr", gap: 12 }}>
                <div className="ms-input-group">
                  <label>Start date <span className="ms-req">*</span></label>
                  <input type="date" className="ms-input" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} />
                </div>
                <div className="ms-input-group">
                  <label>Start time</label>
                  <input type="time" className="ms-input" value={form.startTime} onChange={(e) => set("startTime", e.target.value)} />
                </div>
                <div className="ms-input-group">
                  <label>End date <span className="ms-req">*</span></label>
                  <input type="date" min={form.startDate || undefined} className="ms-input" value={form.endDate} onChange={(e) => set("endDate", e.target.value)} />
                </div>
                <div className="ms-input-group">
                  <label>End time</label>
                  <input type="time" className="ms-input" value={form.endTime} onChange={(e) => set("endTime", e.target.value)} />
                </div>
              </div>

              <div className="ms-input-group">
                <label>Description</label>
                <textarea
                  className="ms-input ms-textarea"
                  rows={2}
                  placeholder="Scope of work, crew, equipment, traffic advisory notes…"
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                />
              </div>

              {formError && <p style={{ color: "var(--color-danger)", fontSize: "0.8rem", marginTop: -4 }}>{formError}</p>}
            </div>

            <div className="ms-form-actions" style={{ padding: "12px 18px 16px" }}>
              <button className="ms-btn-submit" disabled={saving} onClick={submitForm}>
                <Calendar size={15} style={{ marginRight: 6, marginBottom: -2 }} />
                {saving ? "Saving…" : editId ? "Save changes" : "Schedule Maintenance"}
              </button>
              <button className="ms-btn-cancel" disabled={saving} onClick={() => setFormOpen(false)}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
