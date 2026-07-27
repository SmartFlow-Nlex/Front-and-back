import { runPipeline } from './src/etl/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testUpload() {
  const filePath = "C:/Users/Hans/.gemini/antigravity/scratch/synthetic_data_varying/traffic_volume_2020_2026_synthetic.csv";
  console.log(`Testing ETL pipeline on ${filePath}...`);
  try {
    const result = await runPipeline(filePath, "traffic_volume_2020_2026_synthetic.csv");
    console.log("ETL Result:", JSON.stringify({
      success: result.success,
      datasetType: result.datasetType,
      rowsInserted: result.rowsInserted,
      parseErrors: result.parseErrors,
      loadErrors: result.loadErrors
    }, null, 2));
  } catch(e) {
    console.error("ETL Error:", e);
  }
}

testUpload();
