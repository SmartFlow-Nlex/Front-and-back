throw new Error("ARCHIVED - do not run. Medallion rebuild and metrics-table setup from a Gemini session (Jul 27 - Aug 1 2026); already applied. Kept only as a record; see smartflow_scripts/README.md.");
const fs = require('fs');
const path = require('path');

const file = "C:\\Users\\Hans\\.gemini\\antigravity\\scratch\\Front-and-back-Ver1-Merged-BE-FE\\Front-and-back-Ver1-Merged-BE-FE\\Front-End-Dashboard\\components\\dashboard\\PredictiveVolumeChart.tsx";
let content = fs.readFileSync(file, 'utf8');

// 1. Add state variable
content = content.replace(
  'const [chartData, setChartData] = useState<ChartData | null>(null);',
  'const [chartData, setChartData] = useState<ChartData | null>(null);\n  const [metricsMeta, setMetricsMeta] = useState<Record<ModelType, ModelMeta>>(META);'
);

// 2. Update fetchData to populate metricsMeta from json.data.metrics
const fetchDataReplacement = `        const futureStart = rows.findIndex((v) => v.is_future);

        if (json.data.metrics) {
          setMetricsMeta(prev => {
            const next = { ...prev };
            json.data.metrics.forEach((dbM: any) => {
              const key = dbM.model_name === 'Holt-Winters' ? 'HoltWinters' :
                          dbM.model_name === 'Holts_Linear' ? 'HoltsLinear' :
                          dbM.model_name;
              if (next[key as ModelType]) {
                next[key as ModelType] = {
                  ...next[key as ModelType],
                  rmse: Math.round(dbM.rmse).toLocaleString("en-US"),
                  mae: Math.round(dbM.mae).toLocaleString("en-US"),
                  wmape: dbM.wmape.toFixed(2) + "%",
                  r2: dbM.r2.toFixed(4),
                  note: dbM.accepted ? \`Rank #\${dbM.rank}\` : "Rejected",
                  accepted: dbM.accepted
                };
              }
            });
            return next;
          });
        }`;

content = content.replace(
  'const futureStart = rows.findIndex((v) => v.is_future);',
  fetchDataReplacement
);

// 3. Replace MODELS.map in toolbar
content = content.replace(
  '{MODELS.map((m) => {\n          const on = selected.includes(m.key);',
  '{MODELS.map((baseM) => {\n          const m = metricsMeta[baseM.key];\n          const on = selected.includes(m.key);'
);

// 4. Replace MODELS.filter in metrics table
content = content.replace(
  '{MODELS.filter((m) => selected.includes(m.key)).map((m) => (',
  '{MODELS.map(baseM => metricsMeta[baseM.key]).filter((m) => selected.includes(m.key)).map((m) => ('
);

// 5. Replace all other META[ instances with metricsMeta[
content = content.replace(/META\[/g, 'metricsMeta[');

// Fix the original const META declaration which was also replaced
content = content.replace(
  'const metricsMeta = Object.fromEntries',
  'const META = Object.fromEntries'
);

fs.writeFileSync(file, content);
console.log("Updated PredictiveVolumeChart.tsx");
