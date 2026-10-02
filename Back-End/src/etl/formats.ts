/**
 * What the upload accepts, for the Data Management page to show before anyone
 * picks a file. Built from the classifier's own column signatures, so the
 * page cannot drift from what the pipeline actually recognises.
 */
import {
  ACCIDENT_DATA_SIGNALS, BREAKDOWN_DATA_SIGNALS, EMISSION_AQI_SIGNALS, EMISSION_SIGNALS, MOTORCYCLE_SIGNALS,
  ROAD_CRASH_SIGNALS, STALLED_SIGNALS, TOLL_HOURLY_REQUIRED, TRAFFIC_SIGNALS,
} from "./classifier.js";
import { RECORD_END } from "./toll-hourly.js";

/** The dashboard area a layout feeds, which is how the page groups them. */
export type UploadModule = "traffic" | "incidents" | "emissions" | "not_accepted";

export type UploadFormat = {
  type: string;
  label: string;
  module: UploadModule;
  /** Columns the classifier recognises it by (headers are lower-cased, punctuation to "_"). */
  columns: string[];
  /** How many of `columns` it needs: "all", or a minimum. */
  needs: "all" | number;
  /** Where the rows go, in order: the table written, then the ones published on to. */
  lands: string[];
  /** What the dashboards show it on. */
  shows: string;
  /** What uploading the same rows twice does. */
  reupload: string;
  /** Whether rows after the record's end are held back. */
  recordEnd: boolean;
  accepted: boolean;
};

export function uploadFormats(): { recordEnd: string; formats: UploadFormat[] } {
  return {
    recordEnd: RECORD_END,
    formats: [
      {
        type: "toll_hourly", label: "Hourly toll transactions", module: "traffic", columns: TOLL_HOURLY_REQUIRED, needs: "all",
        lands: ["gold.fact_traffic_hourly", "gold.fact_traffic_hourly_origin", "gold.daily_traffic_volume_corrected", "gold.fact_emissions_hourly"],
        shows: "Traffic pages, sandbox demand and CO2 actuals; the forecasts after the weekly retrain",
        reupload: "Each plaza-hour in the file replaces that plaza-hour; the rest are left alone", recordEnd: true, accepted: true,
      },
      {
        type: "accident_data", label: "Accident events (NLEX event log)", module: "incidents", columns: ACCIDENT_DATA_SIGNALS, needs: 2,
        lands: ["bronze.nlex_accident_data", "silver.nlex_accident_events_clean"],
        shows: "Incidents pages; the clearance and severity models",
        reupload: "Updates each event by its event number", recordEnd: true, accepted: true,
      },
      {
        type: "breakdown_data", label: "Breakdown events (NLEX event log)", module: "incidents", columns: BREAKDOWN_DATA_SIGNALS, needs: 2,
        lands: ["bronze.nlex_breakdown_data", "silver.nlex_breakdown_events_clean"],
        shows: "Incidents pages; the response-time model",
        reupload: "Updates each event by its event number", recordEnd: true, accepted: true,
      },
      {
        type: "road_crash", label: "Road crash log", module: "incidents", columns: ROAD_CRASH_SIGNALS, needs: 2,
        lands: ["bronze.nlex_incidents", "silver.nlex_incidents_clean"],
        shows: "Crash history, through the nlex_road_crashes view",
        reupload: "Skips crashes already loaded (same date, hour, location and type)", recordEnd: true, accepted: true,
      },
      {
        type: "motorcycle_crash", label: "Motorcycle crash log", module: "incidents", columns: [...MOTORCYCLE_SIGNALS], needs: 2,
        lands: ["bronze.nlex_incidents", "silver.nlex_incidents_clean"],
        shows: "Crash history, through the nlex_motorcycle_crashes view",
        reupload: "Skips crashes already loaded (same date, hour, location and type)", recordEnd: true, accepted: true,
      },
      {
        type: "stalled_vehicle", label: "Stalled vehicles", module: "incidents", columns: STALLED_SIGNALS, needs: 2,
        lands: ["public.nlex_stalled_vehicles"],
        shows: "Stalled-vehicle history, which reads this table directly",
        reupload: "Skips rows already loaded exactly", recordEnd: true, accepted: true,
      },
      {
        type: "emissions", label: "Modelled emissions (grams per class)", module: "emissions", columns: EMISSION_SIGNALS, needs: 2,
        lands: ["bronze.nlex_theoretical_emissions", "silver.nlex_theoretical_emissions_clean"],
        shows: "the modelled-emissions reference tables only: the Emissions pages compute CO2 from the hourly toll record, so upload hourly toll transactions to change them",
        reupload: "Skips hours already loaded (same exit, hour, direction and class)", recordEnd: true, accepted: true,
      },
      {
        type: "emissions", label: "Air quality readings (OpenWeather)", module: "emissions", columns: EMISSION_AQI_SIGNALS, needs: 4,
        lands: ["bronze.nlex_emissions", "silver.nlex_emissions_clean"],
        shows: "Air-quality panels",
        reupload: "Skips readings already loaded (same exit and observation time)", recordEnd: false, accepted: true,
      },
      {
        type: "traffic_volume", label: "Old wide traffic layout (a column per hour)", module: "not_accepted", columns: TRAFFIC_SIGNALS, needs: 2,
        lands: [], shows: "It only ever reached a table no dashboard reads. Upload hourly toll transactions instead.",
        reupload: "-", recordEnd: false, accepted: false,
      },
    ],
  };
}
