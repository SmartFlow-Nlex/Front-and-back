/**
 * Events Extractor — Routes Philippine Arena / event data through the ETL pipeline
 * Source Layer: External Scraper → Ticketing Websites
 *
 * Event data is used by the Predictive Analytics Engine for surge forecasting.
 * Events at Philippine Arena directly impact NLEX CDV exit traffic volumes.
 */
import type { RawRow } from "../parser.js";
import type { ExtractionResult } from "./types.js";

/**
 * Extract event data from scraped ticketing/event sources
 */
export function extractFromEvents(events: any[]): ExtractionResult {
  const errors: string[] = [];
  const rows: RawRow[] = [];

  try {
    for (const event of events) {
      const row: RawRow = {
        event_name: event.event_name ?? event.name ?? null,
        event_date: event.event_date ?? event.date ?? null,
        venue: event.venue ?? "Philippine Arena",
        expected_attendance: typeof event.expected_attendance === "number"
          ? event.expected_attendance
          : Number(event.expected_attendance) || null,
        event_type: event.event_type ?? event.type ?? null,
        start_time: event.start_time ?? null,
        end_time: event.end_time ?? null,
        impact_plaza: event.impact_plaza ?? "Cdv/Ph Arena",
        impact_direction: event.impact_direction ?? "BOTH",
      };
      rows.push(row);
    }
  } catch (err: any) {
    errors.push(`Events extraction error: ${err.message}`);
  }

  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    source: "api_events",
    sourceName: "Philippine Arena Events (Ticketing Scraper)",
    rows,
    headers,
    extractionErrors: errors,
    metadata: {
      dataProvider: "Ticketing Websites / Philippine Arena",
      impactArea: "NLEX CDV/PH Arena Exit",
      totalRows: rows.length,
    },
  };
}
