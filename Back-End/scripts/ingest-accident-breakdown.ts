/**
 * One-off backfill: POSTs the 10 accident_data/breakdown_data CSV exports
 * (2022-2026, ~182K rows total) to the existing ETL upload endpoint
 * (POST /api/upload/file), in year order, logging each file's
 * classification/row-counts/rejections.
 *
 * This is a ONE-TIME ingestion of files that live outside the repo
 * (D:\OneDrive_2026-09-08\shared files\); future exports of this same
 * format can go through the dashboard's own upload UI, which hits the same
 * endpoint — the ETL classifier auto-detects both formats (see
 * src/etl/classifier.ts's ACCIDENT_DATA_SIGNALS / BREAKDOWN_DATA_SIGNALS).
 *
 * Usage:
 *   npm run dev          (in one terminal — starts the backend on :4000)
 *   npx tsx scripts/ingest-accident-breakdown.ts   (in another)
 *
 * Override the source directory or backend URL via env vars if needed:
 *   SOURCE_DIR=... BACKEND_URL=http://localhost:4000 npx tsx scripts/ingest-accident-breakdown.ts
 */
import fs from "fs";
import path from "path";

const SOURCE_DIR = process.env.SOURCE_DIR ?? "D:/OneDrive_2026-09-08/shared files";
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:4000";

const FILES = [
  "accident_data_2022.csv", "accident_data_2023.csv", "accident_data_2024.csv",
  "accident_data_2025.csv", "accident_data_2026.csv",
  "breakdown_data_2022.csv", "breakdown_data_2023.csv", "breakdown_data_2024.csv",
  "breakdown_data_2025.csv", "breakdown_data_2026.csv",
];

type UploadStats = {
  total_rows_parsed: number;
  rows_accepted: number;
  rows_rejected: number;
  rows_inserted: number;
  rows_skipped_transform: number;
};

async function uploadFile(filename: string): Promise<{
  success: boolean;
  data?: { dataset_type: string; classification: unknown; stats: UploadStats; warnings: string[]; errors: string[] };
  error?: string;
}> {
  const filePath = path.join(SOURCE_DIR, filename);
  const buffer = fs.readFileSync(filePath);
  const blob = new Blob([buffer], { type: "text/csv" });
  const form = new FormData();
  form.append("file", blob, filename);

  const res = await fetch(`${BACKEND_URL}/api/upload/file`, { method: "POST", body: form });
  return res.json();
}

async function main() {
  const summary: Record<string, unknown>[] = [];

  for (const filename of FILES) {
    process.stdout.write(`Uploading ${filename}... `);
    try {
      const result = await uploadFile(filename);
      if (result.success && result.data) {
        const s = result.data.stats;
        console.log(
          `OK — classified '${result.data.dataset_type}': ${s.total_rows_parsed} parsed, ` +
            `${s.rows_accepted} accepted, ${s.rows_rejected} rejected, ${s.rows_inserted} inserted ` +
            `(${s.rows_skipped_transform} skipped in transform)`
        );
        if (result.data.warnings?.length) console.log(`   warnings: ${result.data.warnings.join("; ")}`);
        summary.push({ filename, dataset_type: result.data.dataset_type, ...s });
      } else {
        console.log(`FAILED — ${result.error ?? JSON.stringify(result)}`);
        summary.push({ filename, success: false, error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`ERROR — ${message}`);
      summary.push({ filename, success: false, error: message });
    }
  }

  console.log("\n=== Summary ===");
  console.table(summary);
}

main().catch((err) => {
  console.error("Ingestion script failed:", err);
  process.exit(1);
});
