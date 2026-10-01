"use client";

import { ChangeEvent, useEffect, useState } from "react";
import { Brain, CheckCircle2, Database, ScanSearch, UploadCloud } from "lucide-react";
import PageHeader from "../../../components/dashboard/PageHeader";
import { apiFetch, BACKEND } from "../../../lib/api";

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

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export default function DataManagementPage() {
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<EtlResult | null>(null);
  const [success, setSuccess] = useState<boolean | null>(null);
  // A picked file waits here, unsent, until the operator confirms. Loading writes to the warehouse and this
  // page has no undo, so choosing a file must not be the same act as sending it.
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  useEffect(() => {
    if (!pendingFile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPendingFile(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingFile]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setPendingFile(file);
    // Reset the input so the same file can be picked again after cancelling; the File itself is kept in state.
    event.target.value = "";
  }

  async function uploadFile(file: File) {
    setFileName(file.name);
    setError("");
    setResult(null);
    setSuccess(null);
    setLoading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      // apiFetch attaches the session token and, if it has expired, renews it
      // and replays the upload once. The endpoint now requires the data-analyst
      // role (see Back-End/src/routes/upload.routes.ts), so an unauthenticated
      // post would otherwise be refused here.
      const response = await apiFetch(`${BACKEND}/api/upload/file`, {
        method: "POST",
        body: formData, // fetch will automatically set the correct multipart boundary headers
      });

      const payload = await response.json();

      if (response.status === 401 || response.status === 403) {
        throw new Error(
          payload.message ||
            "Your session is no longer valid for uploading. Sign in again as a Data Analyst.",
        );
      }

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
    }
  }

  function confirmUpload() {
    if (!pendingFile) return;
    const file = pendingFile;
    setPendingFile(null);
    void uploadFile(file);
  }

  return (
    <section className="ds-content ds-long">
      <PageHeader
        icon={Brain}
        title="Data Management"
        subtitle="Upload datasets — the ETL pipeline classifies, validates, and loads them into the AWS database"
        actions={<span className="pill blue">ETL Pipeline Ready</span>}
      />

      <article className="upload-zone">
        {/* Was a literal "?" - a placeholder glyph that shipped. The drop
            target's only picture said "I do not know what this is". */}
        <div className="upload-icon"><UploadCloud size={30} strokeWidth={2} aria-hidden="true" /></div>
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
        {loading && <small style={{ color: "var(--page-accent, #3b82f6)", display: "block", marginTop: "10px" }}>Running ETL Pipeline... this may take a moment for large files.</small>}
      </article>

      {pendingFile && (
        <div
          className="ds-modal-backdrop"
          role="presentation"
          onClick={(e) => {
            // Only a click on the backdrop itself cancels; one that started inside the dialog does not.
            if (e.target === e.currentTarget) setPendingFile(null);
          }}
        >
          <div className="ds-modal" role="dialog" aria-modal="true" aria-labelledby="upload-confirm-title" style={{ width: "min(460px, 100%)" }}>
            <header className="ds-modal-head">
              <h2 id="upload-confirm-title">Upload this file?</h2>
            </header>
            <div className="ds-modal-body">
              <p className="ds-modal-note" style={{ fontSize: "0.86rem", color: "var(--text-primary)" }}>
                <strong style={{ wordBreak: "break-all" }}>{pendingFile.name}</strong>
                <br />
                {formatSize(pendingFile.size)}
              </p>
              <p className="ds-modal-note">
                The pipeline will classify and validate it, then write every row that passes into the AWS warehouse. This page cannot undo a
                load, so check that this is the right file.
              </p>
            </div>
            <footer className="ds-modal-foot">
              <button type="button" className="btn-muted" onClick={() => setPendingFile(null)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" autoFocus onClick={confirmUpload}>
                Upload &amp; load
              </button>
            </footer>
          </div>
        </div>
      )}

      {!result && !error && (
        <ol className="ds-steps" aria-label="What happens after you upload">
          <li>
            <span className="ds-step-icon"><ScanSearch size={18} aria-hidden="true" /></span>
            <b>Classify</b>
            <span>The file is matched against the known dataset shapes and reported with a confidence score. An unrecognised file is rejected here rather than half-loaded.</span>
          </li>
          <li>
            <span className="ds-step-icon"><CheckCircle2 size={18} aria-hidden="true" /></span>
            <b>Validate</b>
            <span>Each quality gate runs in turn and every one is listed with its result, so a rejection names the gate that stopped it.</span>
          </li>
          <li>
            <span className="ds-step-icon"><Database size={18} aria-hidden="true" /></span>
            <b>Load</b>
            <span>Rows that clear every gate are written to the warehouse, and the counts accepted and skipped are shown back to you.</span>
          </li>
        </ol>
      )}

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
