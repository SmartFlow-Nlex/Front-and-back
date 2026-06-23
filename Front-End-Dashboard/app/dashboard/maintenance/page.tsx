"use client";

import { useState, useEffect } from "react";
import { Calendar, Clock, MapPin, Plus, Trash2, ArrowRight } from "lucide-react";

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

  const segmentLength = Math.abs(Number(endKm) - Number(startKm)).toFixed(1);

  const handleDelete = async (id: string) => {
    try {
      await fetch(`http://localhost:3001/api/maintenance/${id}`, { method: "DELETE" });
    } catch (e) {}
    setSchedules(prev => prev.filter(s => s.id !== id));
  };

  const handleSchedule = async () => {
    const payload = {
      segmentId: `${startKm}_${endKm}`,
      description: description || "Scheduled Maintenance",
      startDate: startDate ? new Date(`${startDate}T${startTime || "00:00"}`).toISOString() : new Date().toISOString(),
      endDate: endDate ? new Date(`${endDate}T${endTime || "00:00"}`).toISOString() : new Date().toISOString(),
    };

    try {
      await fetch("http://localhost:3001/api/maintenance/schedule", {
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

      {/* Main Container */}
      <div className="ms-card">
        <div className="ms-card-header">
          <h2>Scheduled Maintenance</h2>
        </div>

        <div className="ms-list">
          {schedules.map((item) => (
            <div className="ms-list-item" key={item.id}>
              <div className="ms-item-top">
                <span className={`ms-badge ${item.status === 'SCHEDULED' ? 'blue' : 'yellow'}`}>
                  {item.status}
                </span>
                <span className="ms-location">
                  <MapPin size={14} /> {Math.abs(Number(item.endKm) - Number(item.startKm)).toFixed(1)} KM
                </span>
              </div>
              
              <button className="ms-delete-btn" onClick={() => handleDelete(item.id)}>
                <Trash2 size={18} />
              </button>

              <div className="ms-km-boxes">
                <span className="ms-km-box">KM {item.startKm}</span>
                <ArrowRight size={14} className="ms-arrow" />
                <span className="ms-km-box">KM {item.endKm}</span>
              </div>

              <p className="ms-ref">Reference: {item.reference}</p>
              <p className="ms-desc">{item.description}</p>

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
            <div className="ms-form-header">
              <h2>New Maintenance Schedule</h2>
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
                  <input type="date" className="ms-input" value={startDate} onChange={e => setStartDate(e.target.value)} />
                </div>
                <div className="ms-input-group">
                  <label>Start Time</label>
                  <input type="time" className="ms-input" value={startTime} onChange={e => setStartTime(e.target.value)} />
                </div>
              </div>

              <div className="ms-form-row">
                <div className="ms-input-group">
                  <label>End Date</label>
                  <input type="date" className="ms-input" value={endDate} onChange={e => setEndDate(e.target.value)} />
                </div>
                <div className="ms-input-group">
                  <label>End Time</label>
                  <input type="time" className="ms-input" value={endTime} onChange={e => setEndTime(e.target.value)} />
                </div>
              </div>

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
    </section>
  );
}
