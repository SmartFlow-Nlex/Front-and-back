"use client";

import { AlertCircle, AlertTriangle, Ban, CarFront, Cone, ShieldAlert } from "lucide-react";

/**
 * How each Waze report type looks, in one place.
 *
 * There were three copies of this: the maximised sidebar's ALERT_LOOK, a
 * hand-rolled if/else chain building marker SVG in TrafficMapPanel, and a set
 * of literal rows in the map page's legend. They had drifted apart, and the
 * drift was visible:
 *
 *   ROAD_CLOSED existed in none of them except the sidebar. It is 7 of the 16
 *   live reports on the corridor, and every one of them drew with the generic
 *   hazard pin and was named "Hazard" in the collapsed legend.
 *
 *   The collapsed legend still advertised Traffic Jam, which stopped being a
 *   report when density and reports were separated, and omitted Road closed
 *   entirely — so the key named a category the map never draws and hid one it
 *   draws constantly.
 *
 * `icon` is for React contexts; `svg` is the same mark as markup, for the
 * Mapbox markers, which are built as DOM strings and cannot take a component.
 * Both are here so the two can never diverge again.
 */

const S = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export type ReportLook = {
  icon: typeof CarFront;
  /** CSS tone class, shared by .wz-chip and .mc-icon-bg. */
  tone: string;
  colour: string;
  label: string;
  svg: string;
};

export const ALERT_LOOK: Record<string, ReportLook> = {
  ACCIDENT: {
    icon: AlertTriangle, tone: "darkred", colour: "#991b1b", label: "Accident",
    svg: S('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  },
  HAZARD: {
    icon: AlertCircle, tone: "yellow", colour: "#eab308", label: "Hazard on road",
    svg: S('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
  },
  WEATHERHAZARD: {
    icon: AlertCircle, tone: "yellow", colour: "#eab308", label: "Weather hazard",
    svg: S('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
  },
  CONSTRUCTION: {
    icon: Cone, tone: "orange", colour: "#ea580c", label: "Road construction",
    svg: S('<path d="m6 21 6-18 6 18"/><path d="M4.5 21h15"/><path d="M8 15h8"/><path d="M9 11h6"/>'),
  },
  /* Its own mark, not the construction cone it used to borrow. A closure and
     roadworks are different things to a driver, and they are the two most
     common reports here, so they must not share a pin. */
  ROAD_CLOSED: {
    icon: Ban, tone: "red", colour: "#dc2626", label: "Road closed",
    svg: S('<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>'),
  },
  POLICE: {
    icon: ShieldAlert, tone: "blue", colour: "#2563eb", label: "Police activity",
    svg: S('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  },
  /* Not a report type any more — density is the coloured ribbon — but kept so
     a stray JAM record still renders with a sensible mark rather than nothing. */
  JAM: {
    icon: CarFront, tone: "red", colour: "#dc2626", label: "Traffic jam",
    svg: S('<path d="M19 17h2v-5l-2-5H5L3 12v5h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>'),
  },
};

const FALLBACK: ReportLook = ALERT_LOOK.HAZARD;

/** Look for a type, falling back to the hazard mark with the raw name. */
export function lookOf(type: string | null | undefined): ReportLook {
  const key = String(type ?? "").toUpperCase();
  return ALERT_LOOK[key] ?? { ...FALLBACK, label: key.replace(/_/g, " ").toLowerCase() || "Report" };
}
