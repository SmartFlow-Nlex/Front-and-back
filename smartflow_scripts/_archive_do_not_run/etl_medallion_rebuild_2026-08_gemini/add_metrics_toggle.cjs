throw new Error("ARCHIVED - do not run. Medallion rebuild and metrics-table setup from a Gemini session (Jul 27 - Aug 1 2026); already applied. Kept only as a record; see smartflow_scripts/README.md.");
const fs = require('fs');

const file = "C:\\Users\\Hans\\.gemini\\antigravity\\scratch\\Front-and-back-Ver1-Merged-BE-FE\\Front-and-back-Ver1-Merged-BE-FE\\Front-End-Dashboard\\components\\dashboard\\PredictiveVolumeChart.tsx";
let content = fs.readFileSync(file, 'utf8');

// 1. Add showAllMetrics state
content = content.replace(
  'const [metricsMeta, setMetricsMeta] = useState<Record<ModelType, ModelMeta>>(META);',
  'const [metricsMeta, setMetricsMeta] = useState<Record<ModelType, ModelMeta>>(META);\n  const [showAllMetrics, setShowAllMetrics] = useState(false);'
);

// 2. Add extra fields to ModelMeta type
content = content.replace(
  '  r2: string;\n};',
  '  r2: string;\n  mape?: string;\n  smape?: string;\n  mase?: string;\n  rmsse?: string;\n  me?: string;\n  mpe?: string;\n  adjusted_r2?: string;\n  theils_u?: string;\n};'
);

// 3. Update fetchData to populate the extra fields
const fetchDataReplacement = `                  wmape: dbM.wmape.toFixed(2) + "%",
                  r2: dbM.r2.toFixed(4),
                  mape: dbM.mape ? dbM.mape.toFixed(2) + "%" : "—",
                  smape: dbM.smape ? dbM.smape.toFixed(2) + "%" : "—",
                  mase: dbM.mase ? dbM.mase.toFixed(4) : "—",
                  rmsse: dbM.rmsse ? dbM.rmsse.toFixed(4) : "—",
                  me: dbM.me != null ? Math.round(dbM.me).toLocaleString("en-US") : "—",
                  mpe: dbM.mpe != null ? dbM.mpe.toFixed(2) + "%" : "—",
                  adjusted_r2: dbM.adjusted_r2 ? dbM.adjusted_r2 : "—",
                  theils_u: dbM.theils_u ? dbM.theils_u.toFixed(4) : "—",
                  note: dbM.accepted ? \`Rank #\${dbM.rank}\` : "Rejected",`;

content = content.replace(
  '                  wmape: dbM.wmape.toFixed(2) + "%",\n                  r2: dbM.r2.toFixed(4),\n                  note: dbM.accepted ? `Rank #${dbM.rank}` : "Rejected",',
  fetchDataReplacement
);

// 4. Update the metricsTable UI to add a toggle and the extra columns
const metricsTableReplacement = `    <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "16px", border: "1px solid #e2e8f0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <h4 style={{ margin: "0", fontSize: "0.95rem", color: "#334155", fontWeight: 600 }}>
          Real-World ML Validation Metrics
        </h4>
        <button
          onClick={() => setShowAllMetrics(!showAllMetrics)}
          style={{
            display: "inline-flex", alignItems: "center", gap: "6px", padding: "4px 10px", borderRadius: "6px",
            background: showAllMetrics ? "#e2e8f0" : "#fff", border: "1px solid #cbd5e1",
            color: "#475569", fontSize: "0.75rem", fontWeight: 600, cursor: "pointer", transition: "all 0.15s"
          }}
        >
          {showAllMetrics ? "Show Less" : "Show All Metrics"}
        </button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", minWidth: showAllMetrics ? "1000px" : "520px" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#64748b", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              <th style={{ padding: "6px 10px", fontWeight: 600 }}>Model</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>RMSE (veh)</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MAE (veh)</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>WMAPE</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>R² Score</th>
              {showAllMetrics && (
                <>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MAPE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>sMAPE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MASE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>RMSSE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>ME</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MPE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Adj R²</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Theil's U</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {MODELS.map(baseM => metricsMeta[baseM.key]).filter((m) => selected.includes(m.key)).map((m) => (
              <tr key={m.key} style={{ background: "#fff", borderTop: "1px solid #e2e8f0" }}>
                <td style={{ padding: "10px", fontWeight: 700, color: "#0f172a" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: m.color }} />
                    {m.label}
                    <span style={{ fontSize: "0.72rem", fontWeight: 500, color: m.accepted ? "#15803d" : "#b91c1c" }}>{m.note}</span>
                  </span>
                </td>
                <td style={{ padding: "10px", textAlign: "right", color: "#0f172a" }}>{m.rmse}</td>
                <td style={{ padding: "10px", textAlign: "right", color: "#0f172a" }}>{m.mae}</td>
                <td style={{ padding: "10px", textAlign: "right", fontWeight: 700, color: m.color }}>{m.wmape}</td>
                <td style={{ padding: "10px", textAlign: "right", fontWeight: 700, color: m.color }}>{m.r2}</td>
                {showAllMetrics && (
                  <>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.mape ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.smape ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.mase ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.rmsse ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.me ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.mpe ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.adjusted_r2 ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.theils_u ?? "—"}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>`;

content = content.replace(
  /    <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "16px", border: "1px solid #e2e8f0" }}>[\s\S]*?          <\/tbody>/m,
  metricsTableReplacement
);

fs.writeFileSync(file, content);
console.log("Updated metrics toggle in PredictiveVolumeChart.tsx");
