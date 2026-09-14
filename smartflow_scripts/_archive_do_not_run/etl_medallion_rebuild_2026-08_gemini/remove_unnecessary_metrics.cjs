throw new Error("ARCHIVED - do not run. Medallion rebuild and metrics-table setup from a Gemini session (Jul 27 - Aug 1 2026); already applied. Kept only as a record; see smartflow_scripts/README.md.");
const fs = require('fs');

const file = "C:\\Users\\Hans\\.gemini\\antigravity\\scratch\\Front-and-back-Ver1-Merged-BE-FE\\Front-and-back-Ver1-Merged-BE-FE\\Front-End-Dashboard\\components\\dashboard\\PredictiveVolumeChart.tsx";
let content = fs.readFileSync(file, 'utf8');

// Remove from table headers
content = content.replace('<th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>ME</th>\n                  <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>MPE</th>\n', '');
content = content.replace('<th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Theil\'s U</th>\n', '');

// Remove from table body cells
content = content.replace('<td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.me ?? "—"}</td>\n                    <td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.mpe ?? "—"}</td>\n', '');
content = content.replace('<td style={{ padding: "10px", textAlign: "right", color: "#475569" }}>{m.theils_u ?? "—"}</td>\n', '');

fs.writeFileSync(file, content);
console.log("Removed ME, MPE, and Theil's U from UI.");
