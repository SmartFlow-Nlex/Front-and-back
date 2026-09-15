throw new Error("ARCHIVED - do not run. Medallion rebuild and metrics-table setup from a Gemini session (Jul 27 - Aug 1 2026); already applied. Kept only as a record; see smartflow_scripts/README.md.");
const fs = require('fs');

const file = "C:\\Users\\Hans\\.gemini\\antigravity\\scratch\\Front-and-back-Ver1-Merged-BE-FE\\Front-and-back-Ver1-Merged-BE-FE\\Front-End-Dashboard\\components\\dashboard\\PredictiveVolumeChart.tsx";
let content = fs.readFileSync(file, 'utf8');

// 1. Add fields to ModelMeta type
content = content.replace(
  '  adjusted_r2?: string;\n  theils_u?: string;\n};',
  '  adjusted_r2?: string;\n  mse?: string;\n  train_r2?: string;\n  val_r2?: string;\n  gap?: string;\n  diagnosis?: string;\n};'
);

// 2. Update fetchData to populate the extra fields
const fetchDataReplacement = `                  r2: dbM.r2.toFixed(4),
                  mape: dbM.mape != null ? dbM.mape.toFixed(2) + "%" : "—",
                  smape: dbM.smape != null ? dbM.smape.toFixed(2) + "%" : "—",
                  mase: dbM.mase != null ? dbM.mase.toFixed(4) : "—",
                  rmsse: dbM.rmsse != null ? dbM.rmsse.toFixed(4) : "—",
                  adjusted_r2: dbM.adjusted_r2 != null ? dbM.adjusted_r2 : "—",
                  mse: dbM.mse != null ? Math.round(dbM.mse).toLocaleString("en-US") : "—",
                  train_r2: dbM.train_r2 != null ? dbM.train_r2.toFixed(4) : "—",
                  val_r2: dbM.val_r2 != null ? dbM.val_r2.toFixed(4) : "—",
                  gap: dbM.r2_gap != null ? dbM.r2_gap.toFixed(4) : "—",
                  diagnosis: dbM.diagnosis || "—",
                  note: dbM.accepted ? \`Rank #\${dbM.rank}\` : "Rejected",`;

content = content.replace(
  '                  r2: dbM.r2.toFixed(4),\n                  mape: dbM.mape ? dbM.mape.toFixed(2) + "%" : "—",\n                  smape: dbM.smape ? dbM.smape.toFixed(2) + "%" : "—",\n                  mase: dbM.mase ? dbM.mase.toFixed(4) : "—",\n                  rmsse: dbM.rmsse ? dbM.rmsse.toFixed(4) : "—",\n                  me: dbM.me != null ? Math.round(dbM.me).toLocaleString("en-US") : "—",\n                  mpe: dbM.mpe != null ? dbM.mpe.toFixed(2) + "%" : "—",\n                  adjusted_r2: dbM.adjusted_r2 ? dbM.adjusted_r2 : "—",\n                  theils_u: dbM.theils_u ? dbM.theils_u.toFixed(4) : "—",\n                  note: dbM.accepted ? `Rank #${dbM.rank}` : "Rejected",',
  fetchDataReplacement
);

// 3. Update the metricsTable UI to add the columns
const tableHeaderReplacement = `              <th style={{ padding: "6px 10px", fontWeight: 600 }}>Model</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>RMSE</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MAE</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>WMAPE</th>
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>R² Score</th>
              {showAllMetrics && (
                <>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MSE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MAPE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>sMAPE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MASE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>RMSSE</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Adj R²</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right", borderLeft: "1px solid #cbd5e1", paddingLeft: "16px" }}>Train R²</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Val R²</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Gap</th>
                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Diagnosis</th>
                </>
              )}`;

content = content.replace(
  /              <th style=\{\{ padding: "6px 10px", fontWeight: 600 \}\}>Model<\/th>[\s\S]*?              <\/}/,
  tableHeaderReplacement
);

const tableBodyReplacement = `                <td style={{ padding: "10px", fontWeight: 700, color: "#0f172a" }}>
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
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.mse ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.mape ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.smape ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.mase ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.rmsse ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.adjusted_r2 ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569", borderLeft: "1px solid #e2e8f0", paddingLeft: "16px" }}>{m.train_r2 ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.val_r2 ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.gap ?? "—"}</td>
                    <td style={{ padding: "10px", textAlign: "right", fontWeight: 600, color: m.diagnosis === "JUST RIGHT" ? "#15803d" : m.diagnosis?.includes("OVERFIT") ? "#b91c1c" : "#b45309" }}>{m.diagnosis ?? "—"}</td>
                  </>
                )}`;

content = content.replace(
  /                <td style=\{\{ padding: "10px", fontWeight: 700, color: "#0f172a" \}\}>[\s\S]*?                <\/}/,
  tableBodyReplacement
);

fs.writeFileSync(file, content);
console.log("Updated metrics table with MSE and Adviser Diagnostics in PredictiveVolumeChart.tsx");
