"use client";

import { useState } from "react";
import { Calendar, Clock, MapPin, Plus, Trash2, ArrowRight } from "lucide-react";

export default function MaintenancePage() {
  const [showForm, setShowForm] = useState(false);
  const [startKm, setStartKm] = useState("0");
  const [endKm, setEndKm] = useState("26");

  const segmentLength = Math.abs(Number(endKm) - Number(startKm)).toFixed(1);

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
          {/* Item 1 */}
          <div className="ms-list-item">
            <div className="ms-item-top">
              <span className="ms-badge blue">SCHEDULED</span>
              <span className="ms-location"><MapPin size={14} /> 15.0 KM</span>
            </div>
            
            <button className="ms-delete-btn"><Trash2 size={18} /></button>

            <div className="ms-km-boxes">
              <span className="ms-km-box">KM 60</span>
              <ArrowRight size={14} className="ms-arrow" />
              <span className="ms-km-box">KM 45</span>
            </div>

            <p className="ms-ref">Reference: San Fernando area → Pulilan area</p>
            <p className="ms-desc">Road resurfacing and lane marking</p>

            <div className="ms-meta">
              <span><Calendar size={14} /> May 10, 2026</span>
              <span><Clock size={14} /> 08:00</span>
            </div>
          </div>

          {/* Item 2 */}
          <div className="ms-list-item">
            <div className="ms-item-top">
              <span className="ms-badge yellow">IN PROGRESS</span>
              <span className="ms-location"><MapPin size={14} /> 4.0 KM</span>
            </div>
            
            <button className="ms-delete-btn"><Trash2 size={18} /></button>

            <div className="ms-km-boxes">
              <span className="ms-km-box">KM 26</span>
              <ArrowRight size={14} className="ms-arrow" />
              <span className="ms-km-box">KM 22</span>
            </div>

            <p className="ms-ref">Reference: Bocaue area → Marilao area</p>
            <p className="ms-desc">Toll booth maintenance and inspection</p>

            <div className="ms-meta">
              <span><Calendar size={14} /> May 8, 2026</span>
              <span><Clock size={14} /> 06:00</span>
            </div>
          </div>
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
                  <select className="ms-input"><option>Balintawak (KM 0)</option></select>
                </div>
                <div className="ms-input-group">
                  <label>End Exit Reference</label>
                  <select className="ms-input"><option>Bocaue (KM 26)</option></select>
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
                  <input type="date" className="ms-input" />
                </div>
                <div className="ms-input-group">
                  <label>Start Time</label>
                  <input type="time" className="ms-input" />
                </div>
              </div>

              <div className="ms-form-row">
                <div className="ms-input-group">
                  <label>End Date</label>
                  <input type="date" className="ms-input" />
                </div>
                <div className="ms-input-group">
                  <label>End Time</label>
                  <input type="time" className="ms-input" />
                </div>
              </div>

              <div className="ms-input-group">
                <label>Maintenance Description</label>
                <textarea className="ms-input ms-textarea" placeholder="Describe the maintenance work..." rows={3}></textarea>
              </div>
            </div>

            <div className="ms-form-actions">
              <button className="ms-btn-submit" onClick={() => setShowForm(false)}>Schedule Maintenance</button>
              <button className="ms-btn-cancel" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
