"use client";

import { ChangeEvent, useState } from "react";

type PipelineGateLog = {
  gate: string;
  passed: boolean;
  details: string;
};

type EtlResult = {
  upload_id: string | null;
  filename: string;
  file_format: string;
  source_type: string;
  dataset_type: string;
  classification: {
    type: string;
    confidence: number;
    reason: string;
  };
  stats: {
    total_rows_parsed: number;
    rows_accepted: number;
    rows_rejected: number;
    rows_inserted: number;
    rows_skipped_transform: number;
  };
  pipeline_gates: PipelineGateLog[];
  rejected_sample: unknown[];
  errors: string[];
  warnings: string[];
  duration_ms: number;
};

export default function DataManagementPage() {
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<EtlResult | null>(null);
  const [success, setSuccess] = useState<boolean | null>(null);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setFileName(file.name);
    setError("");
    setResult(null);
    setSuccess(null);
    setLoading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000"}/api/upload/file`, {
        method: "POST",
        body: formData, // fetch will automatically set the correct multipart boundary headers
      });

      const payload = await response.json();

      if (!response.ok && !payload.data) {
        throw new Error(payload.error || "An error occurred during upload.");
      }

      setSuccess(payload.success);
      if (payload.data) {
        setResult(payload.data as EtlResult);
      } else {
        setError(payload.error || "Upload failed without additional details.");
      }
    } catch (err) {
      setSuccess(false);
      setError(err instanceof Error ? err.message : "Unable to process the uploaded file.");
    } finally {
      setLoading(false);
      // Reset input so the same file can be uploaded again if needed
      event.target.value = "";
    }
  }

  return (
    <section className="ds-content ds-long">
      <div className="dm-head">
        <div>
          <h1 className="tab-title">Data Management</h1>
          <p>Upload your data here. The ETL pipeline will classify, validate, and load traffic volume and incident data into the AWS database.</p>
        </div>
        <span className="pill blue">ETL Pipeline Ready</span>
      </div>

      <article className="upload-zone">
        <div className="upload-icon">?</div>
        <h2>Upload Batch Dataset</h2>
        <p>Choose a CSV or JSON file. The system will automatically classify and process it if it matches the current workflow.</p>
        <label className="btn-primary" style={{ display: "inline-block", cursor: "pointer", opacity: loading ? 0.7 : 1 }}>
          {loading ? "Processing..." : "Select File"}
          <input
            type="file"
            accept=".csv,.json,.xlsx"
            onChange={handleFileChange}
            style={{ display: "none" }}
            disabled={loading}
          />
        </label>
        <small>{fileName || "No file selected yet"}</small>
        {loading && <small style={{ color: "#3b82f6", display: "block", marginTop: "10px" }}>Running ETL Pipeline... this may take a moment for large files.</small>}
      </article>

      {error && (
        <section className="panel" style={{ marginTop: 16 }}>
          <h2>Pipeline Error</h2>
          <p className="bad">{error}</p>
        </section>
      )}

      {result && (
        <>
          <section className="panel" style={{ marginTop: 16 }}>
            <h2>Dataset Classification</h2>
            <p className={success ? "ok" : "bad"}>{result.classification.reason}</p>
            {result.dataset_type === "unknown" && (
              <p className="muted">This file is not a supported traffic volume or incident dataset and was rejected by the pipeline.</p>
            )}
            {result.dataset_type !== "unknown" && (
              <p className="muted">Detected Type: <strong>{result.dataset_type}</strong> (Confidence: {result.classification.confidence}%)</p>
            )}
          </section>

          <div className="mini-stats-grid three" style={{ marginTop: 16 }}>
            <article className="mini-stat">
              <h3>Rows Parsed</h3>
              <p style={{ fontSize: '2em', fontWeight: 'bold' }}>{result.stats.total_rows_parsed}</p>
            </article>
            <article className="mini-stat">
              <h3>Rows Inserted (AWS)</h3>
              <p style={{ fontSize: '2em', fontWeight: 'bold', color: '#10b981' }}>{result.stats.rows_inserted}</p>
            </article>
            <article className="mini-stat">
              <h3>Rows Rejected</h3>
              <p style={{ fontSize: '2em', fontWeight: 'bold', color: result.stats.rows_rejected > 0 ? '#ef4444' : 'inherit' }}>{result.stats.rows_rejected}</p>
            </article>
          </div>

          <div className="table-card" style={{ marginTop: 16 }}>
            <h3 style={{ padding: '16px 20px', margin: 0, borderBottom: '1px solid #eee' }}>ETL Validation Gates</h3>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>GATE</th>
                    <th>STATUS</th>
                    <th>DETAILS</th>
                  </tr>
                </thead>
                <tbody>
                  {result.pipeline_gates.map((gate, index) => (
                    <tr key={index}>
                      <td style={{ fontWeight: 500 }}>{gate.gate}</td>
                      <td>
                        {gate.passed ? (
                          <span className="pill" style={{ backgroundColor: '#10b981', color: 'white' }}>PASSED</span>
                        ) : (
                          <span className="pill" style={{ backgroundColor: '#ef4444', color: 'white' }}>FAILED</span>
                        )}
                      </td>
                      <td>{gate.details}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {(result.errors.length > 0 || result.warnings.length > 0) && (
            <section className="panel" style={{ marginTop: 16 }}>
              {result.errors.length > 0 && (
                <>
                  <h3 style={{ color: '#ef4444' }}>Pipeline Errors</h3>
                  <ul style={{ color: '#ef4444', paddingLeft: 20 }}>
                    {result.errors.slice(0, 10).map((err, i) => <li key={i}>{err}</li>)}
                    {result.errors.length > 10 && <li>...and {result.errors.length - 10} more errors</li>}
                  </ul>
                </>
              )}
              {result.warnings.length > 0 && (
                <>
                  <h3 style={{ color: '#f59e0b', marginTop: result.errors.length > 0 ? 16 : 0 }}>Warnings</h3>
                  <ul style={{ color: '#f59e0b', paddingLeft: 20 }}>
                    {result.warnings.slice(0, 10).map((warn, i) => <li key={i}>{warn}</li>)}
                    {result.warnings.length > 10 && <li>...and {result.warnings.length - 10} more warnings</li>}
                  </ul>
                </>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
