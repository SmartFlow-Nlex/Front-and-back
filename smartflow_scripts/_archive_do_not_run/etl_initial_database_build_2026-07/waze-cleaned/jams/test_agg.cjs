throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
const fs = require('fs'); 
const infile = 'C:\\\\Users\\\\Hans\\\\.gemini\\\\antigravity\\\\scratch\\\\cleaned\\\\waze-cleaned\\\\jams\\\\nlex_jams_cleaned_SAMPLE_FIXED.csv'; 
const outfile = 'C:\\\\Users\\\\Hans\\\\.gemini\\\\antigravity\\\\scratch\\\\cleaned\\\\waze-cleaned\\\\jams\\\\AGGREGATED_JAMS_PREVIEW.csv'; 
const lines = fs.readFileSync(infile, 'utf8').split('\n'); 
const agg = new Map(); 
let headers = lines[0].split(','); 
let hMap = {}; 
headers.forEach((h, i) => hMap[h.trim()] = i); 
for (let i = 1; i < lines.length; i++) { 
  if (!lines[i].trim()) continue; 
  const fields = lines[i].split(','); 
  const tsMatch = fields[hMap['ts']] ? fields[hMap['ts']].match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):/) : null; 
  if (!tsMatch) continue; 
  const key = tsMatch[1] + '_' + tsMatch[2] + '_' + fields[hMap['nearest_exit_name']]; 
  if (!agg.has(key)) agg.set(key, { date: tsMatch[1], hour: tsMatch[2], exit: fields[hMap['nearest_exit_name']], count: 0, speed: 0, delay: 0 }); 
  let obj = agg.get(key); 
  obj.count++; 
  obj.speed += parseFloat(fields[hMap['speedkmh']] || 0); 
  let d = parseInt(fields[hMap['delay']] || 0); 
  if (d > obj.delay) obj.delay = d; 
} 
let outCSV = 'Date,Hour,NLEX_Exit,Total_Jams,Average_Speed_KMH,Max_Delay_Seconds\n'; 
for (const v of agg.values()) { 
  outCSV += `${v.date},${v.hour},${v.exit},${v.count},${(v.speed / v.count).toFixed(2)},${v.delay}\n`; 
} 
fs.writeFileSync(outfile, outCSV); 
console.log('Done');
