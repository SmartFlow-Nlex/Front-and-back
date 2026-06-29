"use client";

import { ChangeEvent, useEffect, useState } from "react";
import { CheckCircle, Clock, AlertTriangle, UploadCloud, Database, XCircle } from "lucide-react";

type DatasetType = "traffic_volume" | "road_crash" | "motorcycle_crash" | "stalled_vehicle" | "apprehension";

type DatasetInfo = {
  type: DatasetType;
  label: string;
  table: string;
  description: string;
  requiredColumns: string[];
  currentRows: number;
};

type UploadHistory = {
  id: number;
  filename: string;
  dataset_type: string;
  status: "processing" | "completed" | "partial" | "failed";
  total_rows: number;
  processed_rows: number;
  failed_rows: number;
  error_message: string | null;
  uploaded_at: string;
  completed_at: string | null;
};

export default function DataManagementPage() {
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [history, setHistory] = useState<UploadHistory[]>([]);
  
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedDatasetType, setSelectedDatasetType] = useState<DatasetType | "auto">("auto");
  
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{
    success: boolean;
    message: string;
    details?: any;
  } | null>(null);

  const fetchDatasets = async () => {
    try {
      const res = await fetch("http://localhost:4000/api/upload/datasets");
      const data = await res.json();
      if (data.success) setDatasets(data.data);
    } catch (err) {
      console.error("Failed to fetch datasets", err);
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await fetch("http://localhost:4000/api/upload/history");
      const data = await res.json();
      if (data.success) setHistory(data.data);
    } catch (err) {
      console.error("Failed to fetch upload history", err);
    }
  };

  useEffect(() => {
    fetchDatasets();
    fetchHistory();
  }, []);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
      setUploadResult(null);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;

    setUploading(true);
    setUploadResult(null);

    const formData = new FormData();
    formData.append("file", selectedFile);
    if (selectedDatasetType !== "auto") {
      formData.append("dataset_type", selectedDatasetType);
    }

    try {
      const res = await fetch("http://localhost:4000/api/upload/file", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (data.success) {
        setUploadResult({
          success: true,
          message: `Successfully uploaded ${selectedFile.name}`,
          details: data.data,
        });
        setSelectedFile(null);
        // Refresh data
        fetchDatasets();
        fetchHistory();
      } else {
        setUploadResult({
          success: false,
          message: data.message || "Upload failed",
        });
      }
    } catch (err: any) {
      setUploadResult({
        success: false,
        message: err.message || "Network error during upload",
      });
    } finally {
      setUploading(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed": return <CheckCircle size={16} className="text-green-500" />;
      case "processing": return <Clock size={16} className="text-blue-500" />;
      case "partial": return <AlertTriangle size={16} className="text-yellow-500" />;
      case "failed": return <XCircle size={16} className="text-red-500" />;
      default: return <Clock size={16} />;
    }
  };

  return (
    <section className="ds-content ds-long">
      <div className="dm-head">
        <div>
          <h1 className="tab-title">Data Management</h1>
          <p>Upload and manage NLEX datasets. The system automatically routes data to AWS PostgreSQL.</p>
        </div>
        <span className="pill blue">AWS RDS Connected</span>
      </div>

      <div className="dm-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px", marginBottom: "24px" }}>
        
        {/* Upload Panel */}
        <section className="panel" style={{ margin: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
            <UploadCloud size={24} className="text-blue-500" />
            <h2 style={{ margin: 0 }}>Upload Dataset</h2>
          </div>
          <p className="muted" style={{ marginBottom: "16px" }}>Upload a CSV file. The system will automatically detect the format and ingest it.</p>
          
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", marginBottom: "8px", fontWeight: 500 }}>Dataset Type (Optional)</label>
            <select 
              value={selectedDatasetType}
              onChange={(e) => setSelectedDatasetType(e.target.value as any)}
              style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid var(--ds-border)" }}
            >
              <option value="auto">Auto-detect from columns</option>
              {datasets.map(d => (
                <option key={d.type} value={d.type}>{d.label}</option>
              ))}
            </select>
          </div>

          <div 
            style={{ 
              border: "2px dashed var(--ds-border)", 
              borderRadius: "8px", 
              padding: "32px", 
              textAlign: "center",
              marginBottom: "16px",
              background: "var(--ds-bg-subtle)"
            }}
          >
            <label className="btn-primary" style={{ display: "inline-block", cursor: "pointer", marginBottom: "12px" }}>
              Select CSV File
              <input type="file" accept=".csv" onChange={handleFileChange} style={{ display: "none" }} />
            </label>
            <p className="muted">{selectedFile ? selectedFile.name : "No file selected"}</p>
          </div>

          <button 
            className="btn-primary" 
            style={{ width: "100%", opacity: (!selectedFile || uploading) ? 0.5 : 1, cursor: (!selectedFile || uploading) ? "not-allowed" : "pointer" }}
            onClick={handleUpload}
            disabled={!selectedFile || uploading}
          >
            {uploading ? "Uploading & Ingesting..." : "Upload to AWS RDS"}
          </button>

          {uploadResult && (
            <div style={{ 
              marginTop: "16px", 
              padding: "12px", 
              borderRadius: "6px", 
              background: uploadResult.success ? "rgba(34, 197, 94, 0.1)" : "rgba(239, 68, 68, 0.1)",
              border: `1px solid ${uploadResult.success ? "rgba(34, 197, 94, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
              color: uploadResult.success ? "var(--ds-ok)" : "var(--ds-bad)"
            }}>
              <p style={{ fontWeight: 600, marginBottom: uploadResult.details ? "8px" : 0 }}>{uploadResult.message}</p>
              {uploadResult.details && (
                <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "0.9em" }}>
                  <li>Type: {uploadResult.details.datasetType}</li>
                  <li>Rows Processed: {uploadResult.details.processedRows} / {uploadResult.details.totalRows}</li>
                  {uploadResult.details.failedRows > 0 && <li>Failed Rows: {uploadResult.details.failedRows}</li>}
                  <li>Duration: {uploadResult.details.durationMs}ms</li>
                </ul>
              )}
            </div>
          )}
        </section>

        {/* Status Panel */}
        <section className="panel" style={{ margin: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
            <Database size={24} className="text-blue-500" />
            <h2 style={{ margin: 0 }}>AWS RDS Status</h2>
          </div>
          
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {datasets.map(d => (
              <div key={d.type} style={{ padding: "12px", border: "1px solid var(--ds-border)", borderRadius: "8px", background: "var(--ds-bg-card)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                  <h3 style={{ margin: 0, fontSize: "1rem" }}>{d.label}</h3>
                  <span className="pill" style={{ background: d.currentRows > 0 ? "rgba(34, 197, 94, 0.1)" : "rgba(148, 163, 184, 0.1)", color: d.currentRows > 0 ? "var(--ds-ok)" : "inherit" }}>
                    {d.currentRows.toLocaleString()} rows
                  </span>
                </div>
                <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>{d.description}</p>
              </div>
            ))}
          </div>
        </section>

      </div>

      {/* Upload History Table */}
      <section className="panel">
        <h2 style={{ marginBottom: "16px" }}>Upload History</h2>
        {history.length > 0 ? (
          <div className="table-card" style={{ margin: 0 }}>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>FILENAME</th>
                    <th>DATASET TYPE</th>
                    <th>STATUS</th>
                    <th>ROWS PROCESSED</th>
                    <th>UPLOADED AT</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>{h.filename}</td>
                      <td>{h.dataset_type}</td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          {getStatusIcon(h.status)}
                          <span style={{ textTransform: "capitalize" }}>{h.status}</span>
                        </div>
                      </td>
                      <td>{h.processed_rows} / {h.total_rows}</td>
                      <td>{new Date(h.uploaded_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="muted">No upload history found.</p>
        )}
      </section>
      
    </section>
  );
}
