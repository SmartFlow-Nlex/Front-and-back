"use client";

import { useState, useEffect } from "react";
import { Calendar, Clock, MapPin, Plus, X, ArrowRight, Search, SlidersHorizontal } from "lucide-react";

const NLEX_EXITS = [
  { name: "Balintawak", km: 0 },
  { name: "Skyway Exit", km: 2 },
  { name: "Libis Baesa", km: 4 },
  { name: "Smart Connect", km: 6 },
  { name: "Paso de Blas", km: 8 },
  { name: "Lawang Bato", km: 10 },
  { name: "Lingunan", km: 12 },
  { name: "Libtong", km: 14 },
  { name: "Meycauayan", km: 16 },
  { name: "Pandayan", km: 18 },
  { name: "F. Raymundo", km: 20 },
  { name: "Marilao", km: 22 },
  { name: "Ciudad de Victoria", km: 24 },
  { name: "Bocaue", km: 26 },
  { name: "Tambubong", km: 28 },
  { name: "Balagtas", km: 30 },
  { name: "Tabang", km: 35 },
  { name: "Sta. Rita", km: 40 },
  { name: "Pulilan", km: 45 },
  { name: "San Simon", km: 52 },
  { name: "San Fernando", km: 60 },
  { name: "Mexico", km: 68 },
  { name: "Angeles", km: 76 },
  { name: "Dau", km: 82 },
  { name: "Clark/SCTEX", km: 88 },
  { name: "Sta. Ines", km: 94 }
];

export default function MaintenancePage() {
  const [showForm, setShowForm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [scheduleError, setScheduleError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sortOrder, setSortOrder] = useState("Newest First");
  const [startKm, setStartKm] = useState("0");
  const [endKm, setEndKm] = useState("26");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [description, setDescription] = useState("");
  
  const [schedules, setSchedules] = useState<any[]>([
    {
      id: "mock1",
      status: "SCHEDULED",
      startKm: "60",
      endKm: "45",
      reference: "San Fernando area → Pulilan area",
      description: "Road resurfacing and lane marking",
      startDate: "2026-05-10",
      startTime: "08:00"
    },
    {
      id: "mock2",
      status: "IN PROGRESS",
      startKm: "26",
      endKm: "22",
      reference: "Bocaue area → Marilao area",
      description: "Toll booth maintenance and inspection",
      startDate: "2026-05-08",
      startTime: "06:00"
    }
  ]);

  const today = new Date();
  const todayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const segmentLength = Math.abs(Number(endKm) - Number(startKm)).toFixed(1);

  const confirmDelete = (id: string) => {
    setPendingDeleteId(id);
    setCancelReason("");
    setShowDeleteConfirm(true);
  };

  const executeDelete = async () => {
    if (!pendingDeleteId) return;
    if (!cancelReason.trim()) return;
    setSchedules(prev =>
      prev.map((item) =>
        item.id === pendingDeleteId
          ? {
              ...item,
              status: "CANCELLED",
              cancelReason: cancelReason.trim(),
              cancelledAt: new Date().toISOString(),
            }
          : item
      )
    );
    setPendingDeleteId(null);
    setCancelReason("");
    setShowDeleteConfirm(false);
  };

  const totalScheduled = schedules.filter((item) => item.status === "SCHEDULED").length;
  const inProgress = schedules.filter((item) => item.status === "IN PROGRESS").length;
  const cancelled = schedules.filter((item) => item.status === "CANCELLED").length;

  const filteredSchedules = schedules.filter((item) => {
    const searchValue = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !searchValue ||
      item.reference.toLowerCase().includes(searchValue) ||
      item.description.toLowerCase().includes(searchValue) ||
      item.startKm.toLowerCase().includes(searchValue) ||
      item.endKm.toLowerCase().includes(searchValue);

    const matchesStatus = statusFilter === "All" || item.status === statusFilter;

    return matchesSearch && matchesStatus;
  }).sort((left, right) => {
    const leftDate = new Date(left.startDate).getTime();
    const rightDate = new Date(right.startDate).getTime();

    if (sortOrder === "Oldest First") return leftDate - rightDate;
    if (sortOrder === "KM Asc") return Number(left.startKm) - Number(right.startKm);
    if (sortOrder === "KM Desc") return Number(right.startKm) - Number(left.startKm);
    return rightDate - leftDate;
  });

  const handleSchedule = async () => {
    if (startDate && startDate < todayDate) {
      setScheduleError("Start date cannot be before today.");
      return;
    }

    if (endDate && endDate < todayDate) {
      setScheduleError("End date cannot be before today.");
      return;
    }

    if (startDate && endDate && endDate < startDate) {
      setScheduleError("End date cannot be earlier than the start date.");
      return;
    }

    setScheduleError("");

    const payload = {
      segmentId: `${startKm}_${endKm}`,
      description: description || "Scheduled Maintenance",
      startDate: startDate ? new Date(`${startDate}T${startTime || "00:00"}`).toISOString() : new Date().toISOString(),
      endDate: endDate ? new Date(`${endDate}T${endTime || "00:00"}`).toISOString() : new Date().toISOString(),
    };

    try {
      await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000"}/api/maintenance/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      console.error("Failed to schedule to backend", error);
    }

    const newItem = {
      id: Date.now().toString(),
      status: "SCHEDULED",
      startKm,
      endKm,
      reference: "Balintawak area → Bocaue area",
      description: description || "Scheduled Maintenance",
      startDate: startDate || new Date().toISOString().split("T")[0],
      startTime: startTime || "00:00"
    };

    setSchedules(prev => [newItem, ...prev]);
    setShowForm(false);
    
    // Reset form
    setStartKm("0");
    setEndKm("26");
    setStartDate("");
    setStartTime("");
    setEndDate("");
    setEndTime("");
    setDescription("");
  };

  return (
    <section className="ds-content">
      {/* Header Row */}
      <div className="ms-header-row">
        <h1 className="tab-title">Maintenance Scheduler</h1>
        <button className="ms-btn-primary" onClick={() => setShowForm(true)}>
          <Plus size={16} /> Schedule Maintenance
        </button>
      </div>

      <div className="tab-stat-grid compact ms-maintenance-kpi-grid">
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Total Scheduled</h3>
            <div className="value text-blue-600">{totalScheduled}</div>
          </div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>In Progress</h3>
            <div className="value text-amber-600">{inProgress}</div>
          </div>
        </article>
        <article className="tab-stat-card">
          <div className="stat-content">
            <h3>Cancelled</h3>
            <div className="value text-red-600">{cancelled}</div>
          </div>
        </article>
      </div>

      <div className="ms-tools-row">
        <div className="ms-search-bar">
          <Search size={16} />
          <input
            type="text"
            placeholder="Search maintenance..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>

        <div className="ms-filter-group">
          <div className="ms-select-wrap">
            <SlidersHorizontal size={16} />
            <select value={sortOrder} onChange={(event) => setSortOrder(event.target.value)}>
              <option value="Newest First">Sort: Newest First</option>
              <option value="Oldest First">Sort: Oldest First</option>
              <option value="KM Asc">Sort: KM Asc</option>
              <option value="KM Desc">Sort: KM Desc</option>
            </select>
          </div>

          <div className="ms-select-wrap">
            <SlidersHorizontal size={16} />
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="All">Filter: All Statuses</option>
              <option value="SCHEDULED">Filter: Scheduled</option>
              <option value="IN PROGRESS">Filter: In Progress</option>
              <option value="CANCELLED">Filter: Cancelled</option>
            </select>
          </div>

          <button
            type="button"
            className="ms-filter-reset"
            onClick={() => {
              setSearchQuery("");
              setStatusFilter("All");
              setSortOrder("Newest First");
            }}
          >
            Reset
          </button>
        </div>
      </div>

      {/* Main Container */}
      <div className="ms-card">
        <div className="ms-card-header">
          <h2>Scheduled Maintenance ({filteredSchedules.length})</h2>
        </div>

        <div className="ms-list">
          {filteredSchedules.map((item) => (
            <div className="ms-list-item" key={item.id}>
              <div className="ms-item-top">
                <span className={`ms-badge ${item.status === 'SCHEDULED' ? 'blue' : item.status === 'CANCELLED' ? 'red' : 'yellow'}`}>
                  {item.status}
                </span>
                <span className="ms-location">
                  <MapPin size={14} /> {Math.abs(Number(item.endKm) - Number(item.startKm)).toFixed(1)} KM
                </span>
              </div>
              
              <button className="ms-cancel-pill" onClick={() => confirmDelete(item.id)}>
                Cancel
              </button>

              <div className="ms-km-boxes">
                <span className="ms-km-box">KM {item.startKm}</span>
                <ArrowRight size={14} className="ms-arrow" />
                <span className="ms-km-box">KM {item.endKm}</span>
              </div>

              <p className="ms-ref">Reference: {item.reference}</p>
              <p className="ms-desc">{item.description}</p>
              {item.status === "CANCELLED" && item.cancelReason && (
                <p className="ms-summary-ref" style={{ color: "var(--color-danger)", marginTop: 8 }}>
                  Cancel reason: {item.cancelReason}
                </p>
              )}

              <div className="ms-meta">
                <span><Calendar size={14} /> {new Date(item.startDate).toLocaleDateString("en-US", { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                <span><Clock size={14} /> {item.startTime}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Schedule Form Modal */}
      {showForm && (
        <div className="ms-modal-overlay">
          <div className="ms-form-card">
            <div className="ms-form-header ms-form-header-closeable">
              <h2>New Maintenance Schedule</h2>
              <button
                type="button"
                className="ms-modal-close"
                onClick={() => setShowForm(false)}
                aria-label="Close schedule form"
              >
                <X size={18} />
              </button>
            </div>
            
            <div className="ms-form-body">
              <p className="ms-section-label">Reference Exits (Optional)</p>
              <div className="ms-form-row">
                <div className="ms-input-group">
                  <label>Start Exit Reference</label>
                  <select className="ms-input" value={startKm} onChange={e => setStartKm(e.target.value)}>
                    <option value="" disabled>Select start reference</option>
                    {NLEX_EXITS.map(exit => (
                      <option key={exit.km} value={exit.km}>{exit.name} (KM {exit.km})</option>
                    ))}
                  </select>
                </div>
                <div className="ms-input-group">
                  <label>End Exit Reference</label>
                  <select className="ms-input" value={endKm} onChange={e => setEndKm(e.target.value)}>
                    <option value="" disabled>Select end reference</option>
                    {NLEX_EXITS.map(exit => (
                      <option key={exit.km} value={exit.km}>{exit.name} (KM {exit.km})</option>
                    ))}
                  </select>
                </div>
              </div>

              <p className="ms-section-label">Exact Location (KM Markers)</p>
              <div className="ms-form-row">
                <div className="ms-input-group">
                  <label>Start KM <span className="ms-req">*</span></label>
                  <input type="number" className="ms-input" value={startKm} onChange={e => setStartKm(e.target.value)} />
                  <span className="ms-help">Enter exact kilometer marker (0-94)</span>
                </div>
                <div className="ms-input-group">
                  <label>End KM <span className="ms-req">*</span></label>
                  <input type="number" className="ms-input" value={endKm} onChange={e => setEndKm(e.target.value)} />
                  <span className="ms-help">Enter exact kilometer marker (0-94)</span>
                </div>
              </div>

              <div className="ms-summary-box">
                <div className="ms-summary-title">
                  <MapPin size={18} /> Maintenance Segment: {segmentLength} KM
                </div>
                <div className="ms-summary-row">
                  <div className="ms-summary-val">From: <strong>KM {startKm}</strong></div>
                  <div className="ms-summary-val">To: <strong>KM {endKm}</strong></div>
                </div>
                <p className="ms-summary-ref">Reference: Balintawak area → Bocaue area</p>
              </div>

              <div className="ms-form-row">
                <div className="ms-input-group">
                  <label>Start Date</label>
                  <input type="date" min={todayDate} className="ms-input" value={startDate} onChange={e => setStartDate(e.target.value)} />
                </div>
                <div className="ms-input-group">
                  <label>Start Time</label>
                  <input type="time" className="ms-input" value={startTime} onChange={e => setStartTime(e.target.value)} />
                </div>
              </div>

              <div className="ms-form-row">
                <div className="ms-input-group">
                  <label>End Date</label>
                  <input type="date" min={startDate || todayDate} className="ms-input" value={endDate} onChange={e => setEndDate(e.target.value)} />
                </div>
                <div className="ms-input-group">
                  <label>End Time</label>
                  <input type="time" className="ms-input" value={endTime} onChange={e => setEndTime(e.target.value)} />
                </div>
              </div>

              {scheduleError && (
                <p className="ms-summary-ref" style={{ color: "var(--color-danger)", marginTop: -8 }}>
                  {scheduleError}
                </p>
              )}

              <div className="ms-input-group">
                <label>Maintenance Description</label>
                <textarea className="ms-input ms-textarea" placeholder="Describe the maintenance work..." rows={3} value={description} onChange={e => setDescription(e.target.value)}></textarea>
              </div>
            </div>

            <div className="ms-form-actions">
              <button className="ms-btn-submit" onClick={handleSchedule}>Schedule Maintenance</button>
              <button className="ms-btn-cancel" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="ms-modal-overlay">
          <div className="ms-form-card" style={{ maxWidth: 460 }}>
            <div className="ms-form-header ms-form-header-closeable">
              <h2>Cancel Maintenance Schedule?</h2>
              <button
                type="button"
                className="ms-modal-close"
                onClick={() => {
                  setPendingDeleteId(null);
                  setCancelReason("");
                  setShowDeleteConfirm(false);
                }}
                aria-label="Close cancel dialog"
              >
                <X size={18} />
              </button>
            </div>
            <div className="ms-form-body">
              <p className="ms-summary-ref" style={{ marginTop: 0 }}>
                This action cannot be undone. The selected maintenance schedule will be marked as canceled.
              </p>
              <div className="ms-input-group">
                <label>Cancellation Reason <span className="ms-req">*</span></label>
                <textarea
                  className="ms-input ms-textarea"
                  rows={3}
                  placeholder="Enter a reason for canceling this schedule..."
                  value={cancelReason}
                  onChange={(event) => setCancelReason(event.target.value)}
                />
              </div>
            </div>
            <div className="ms-form-actions">
              <button className="ms-btn-submit ms-btn-danger-action" onClick={executeDelete} disabled={!cancelReason.trim()}>Cancel Schedule</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
