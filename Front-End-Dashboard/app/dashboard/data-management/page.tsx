"use client";

import { ChangeEvent, useState } from "react";

type BatchRow = {
  time_reported: string;
  time_cleared: string;
  daily_volume: number;
};

type BatchResult = BatchRow & {
  row_index: number;
  delay_minutes: number;
  trapped_vehicles: number;
  idling_penalty_co2_kg: number;
};

type DatasetClassification = {
  kind: "emissions-compatible" | "unsupported";
  message: string;
  missingFields: string[];
};

function parseCsv(text: string) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    throw new Error("CSV file must include a header row and at least one data row");
  }

  const headers = lines[0].split(",").map((value) => value.trim());
  const expectedHeaders = ["time_reported", "time_cleared", "daily_volume"];

  for (const header of expectedHeaders) {
    if (!headers.includes(header)) {
      throw new Error(`Missing required CSV column: ${header}`);
    }
  }

  return lines.slice(1).map((line) => {
    const values = line.split(",").map((value) => value.trim().replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};

    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });

    return {
      time_reported: row.time_reported,
      time_cleared: row.time_cleared,
      daily_volume: Number(row.daily_volume),
    } satisfies BatchRow;
  });
}

function classifyBatchRows(rows: BatchRow[]): DatasetClassification {
  const missingFields: string[] = [];

  if (!rows.length) {
    return {
      kind: "unsupported",
      message: "No usable data was found in the file.",
      missingFields: ["time_reported", "time_cleared", "daily_volume"],
    };
  }

  for (const field of ["time_reported", "time_cleared", "daily_volume"] as const) {
    const invalidRow = rows.find((row) => {
      if (field === "daily_volume") {
        return Number.isNaN(row.daily_volume);
      }

      return typeof row[field] !== "string" || row[field].trim().length === 0;
    });

    if (invalidRow) {
      missingFields.push(field);
    }
  }

  if (missingFields.length > 0) {
    return {
      kind: "unsupported",
      message: "This file does not look ready for processing yet.",
      missingFields,
    };
  }

  return {
    kind: "emissions-compatible",
    message: "This file is ready and will be processed automatically.",
    missingFields: [],
  };
}

export default function DataManagementPage() {
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [classification, setClassification] = useState<DatasetClassification | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function runBatchCalculation(targetRows: BatchRow[]) {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000"}/api/emissions/calculate/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ rows: targetRows }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: BatchResult[];
        message?: string;
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.message ?? "Unable to calculate batch emissions");
      }

      setResults(payload.data);
    } catch (error) {
      setResults([]);
      setError(error instanceof Error ? error.message : "Unable to calculate batch emissions");
    } finally {
      setLoading(false);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setFileName(file.name);
    setError("");

    try {
      const text = await file.text();
      let parsedRows: BatchRow[] = [];

      if (file.name.toLowerCase().endsWith(".json")) {
        const parsed = JSON.parse(text) as BatchRow[];
        parsedRows = parsed.map((row) => ({
          time_reported: row.time_reported,
          time_cleared: row.time_cleared,
          daily_volume: Number(row.daily_volume),
        }));
      } else {
        parsedRows = parseCsv(text);
      }

      if (!parsedRows.length) {
        throw new Error("No rows found in file");
      }

      setRows(parsedRows);

      const nextClassification = classifyBatchRows(parsedRows);
      setClassification(nextClassification);

      if (nextClassification.kind === "emissions-compatible") {
        await runBatchCalculation(parsedRows);
      } else {
        setResults([]);
      }
    } catch (error) {
      setRows([]);
      setResults([]);
      setClassification(null);
      setError(error instanceof Error ? error.message : "Unable to read the uploaded file");
    }
  }

  async function handleCalculate() {
    await runBatchCalculation(rows);
  }

  return (
    <section className="ds-content ds-long">
      <div className="dm-head">
        <div>
          <h1 className="tab-title">Data Management</h1>
          <p>Upload your data here and the system will check it before processing.</p>
        </div>
        <span className="pill blue">Batch Processing Ready</span>
      </div>

      <article className="upload-zone">
        <div className="upload-icon">?</div>
        <h2>Upload Batch Dataset</h2>
        <p>Choose a file and the system will review it, then process it if it matches the current workflow.</p>
        <label className="btn-primary" style={{ display: "inline-block", cursor: "pointer" }}>
          Select File
          <input
            type="file"
            accept=".csv,.json"
            onChange={handleFileChange}
            style={{ display: "none" }}
          />
        </label>
        <small>{fileName || "No file selected yet"}</small>
        {loading && <small>Processing...</small>}
      </article>

      {classification && (
        <section className="panel">
          <h2>Dataset Classification</h2>
          <p className={classification.kind === "emissions-compatible" ? "ok" : "bad"}>{classification.message}</p>
          {classification.missingFields.length > 0 && <p className="muted">Please check the file and try again.</p>}
        </section>
      )}

      {error && <p className="bad" style={{ marginTop: 12 }}>{error}</p>}

      {rows.length > 0 && (
        <div className="table-card">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>TIME REPORTED</th>
                  <th>TIME CLEARED</th>
                  <th>DAILY VOLUME</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.time_reported}-${row.time_cleared}-${index}`}>
                    <td>{row.time_reported}</td>
                    <td>{row.time_cleared}</td>
                    <td>{row.daily_volume}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="table-card" style={{ marginTop: 16 }}>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>ROW</th>
                  <th>DELAY (MIN)</th>
                  <th>TRAPPED VEHICLES</th>
                  <th>CO₂ PENALTY (KG)</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row) => (
                  <tr key={row.row_index}>
                    <td>{row.row_index}</td>
                    <td>{row.delay_minutes}</td>
                    <td>{row.trapped_vehicles}</td>
                    <td>{row.idling_penalty_co2_kg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mini-stats-grid three">
        <article className="mini-stat"><h3>Batch Validation</h3><p>The uploaded file is checked for the required carbon calculation columns before submission.</p></article>
        <article className="mini-stat"><h3>Backend Processing</h3><p>Rows are sent to the Express emissions endpoint in one batch request.</p></article>
        <article className="mini-stat"><h3>Result Output</h3><p>The returned table shows delay, trapped vehicles, and CO2 penalty per uploaded row.</p></article>
      </div>
    </section>
  );
}
