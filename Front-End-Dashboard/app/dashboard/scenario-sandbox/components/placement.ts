"use client";

import { useEffect, useState } from "react";
import type { Direction, EventSite } from "../scenarios/adapter";
import type { FamilyKey } from "../scenarios/catalogue";
import type { FacilityKind } from "../facilities";

/* ══════════════════════════════════════════════════════════════════════════════
   WHERE AN EVENT GOES

   Four ways, because an operator asks four different questions:
     - "where it usually happens"  — the corridor's own incident logs say: the
       busiest 100 m stretch of this window and its usual lane, or the plaza or
       service area where this kind of event is most often recorded;
     - "here"                      — a click on the road, or on a booth;
     - "at that plaza"             — a toll plaza, service area or ramp, and which
       booths or pumps;
     - "at Km 20.15"               — typed.
   Everything here is pure or a fetch; ScenarioPanel keeps the state.
══════════════════════════════════════════════════════════════════════════════ */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

export type PlaceMode = "data" | "pick" | "site" | "km";

/** A plaza, ramp or service area an event can be put at. */
export type SiteOption = {
  id: string;
  name: string;
  kind: FacilityKind;
  km: number;
  /** Booths or pumps. 0 on an untolled ramp. */
  stations: number;
  /** How the incident logs name it. */
  recordNames: readonly string[];
};

/** What a click on the canvas resolved to. */
export type PickResult = { direction: Direction; km: number; lane: number | null; site: EventSite | null };

/** What a scenario chip carries while it is dragged onto the road (its family key). */
export const SCENARIO_DRAG_TYPE = "application/x-smartflow-scenario";

/** Where a scenario chip dropped on the road lands: the road calls this, the panel adds the event (null), or says why not. */
export type ScenarioDrop = (family: FamilyKey, at: PickResult) => string | null;

export type ResolvedPlace = {
  positionKm: number;
  /** A lane the placement itself chose (operator numbering), or null to use the Lane picker's. */
  lane: number | null;
  site: EventSite | null;
  /** Where this came from, in a sentence. */
  note: string | null;
  /** The operator still has to do something (click the road, choose a plaza). */
  incomplete: boolean;
};

/** Families that make sense at a booth or pump. Weather and flooding are the road's. */
export const SITE_FAMILIES: ReadonlySet<FamilyKey> = new Set<FamilyKey>([
  "breakdown_in_lane",
  "breakdown_shoulder",
  "minor_collision",
  "multi_vehicle_collision",
  "self_accident",
  "overturned_vehicle",
  "scheduled_roadworks",
]);

/** Families the logs can place: everything recorded as an incident. Roadworks are planned, not recorded. */
export const HOTSPOT_FAMILIES: ReadonlySet<FamilyKey> = new Set<FamilyKey>([
  "breakdown_in_lane",
  "breakdown_shoulder",
  "minor_collision",
  "multi_vehicle_collision",
  "self_accident",
  "overturned_vehicle",
]);

export type Hotspots = {
  inWindow: number;
  stretches: { fromKm: number; toKm: number; count: number; lane: number | null; laneShare: number | null }[];
  facilities: { place: "Toll Plaza" | "Interchange" | "TSF"; name: string; count: number }[];
  period: { from: string; to: string } | null;
  source: string;
  note: string | null;
};

/** The logs' hotspots for one kind of event on one carriageway's window. */
export function useHotspots(family: FamilyKey, direction: Direction, fromKm: number, toKm: number, enabled: boolean) {
  const [state, setState] = useState<{ key: string; data: Hotspots | null; error: string | null }>({ key: "", data: null, error: null });
  const key = `${family}|${direction}|${fromKm.toFixed(3)}|${toKm.toFixed(3)}`;
  useEffect(() => {
    if (!enabled || !HOTSPOT_FAMILIES.has(family) || !(toKm > fromKm)) return;
    let cancelled = false;
    const qs = new URLSearchParams({ family, direction, fromKm: String(fromKm), toKm: String(toKm) });
    fetch(`${BACKEND}/api/ai-sandbox/hotspots?${qs}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (cancelled) return;
        if (j?.success) setState({ key, data: j.data as Hotspots, error: null });
        else setState({ key, data: null, error: j?.message ?? `The incident record could not be read (${r.status}).` });
      })
      .catch(() => {
        if (!cancelled) setState({ key, data: null, error: "The incident record could not be reached." });
      });
    return () => {
      cancelled = true;
    };
  }, [key, family, direction, fromKm, toKm, enabled]);
  const current = state.key === key ? state : null;
  return { data: current?.data ?? null, error: current?.error ?? null, loading: enabled && HOTSPOT_FAMILIES.has(family) && current === null };
}

export type Candidate = {
  key: string;
  /** "Km 20.10–20.20 · Lane 1" or "Meycauayan Toll Plaza (entry)". */
  label: string;
  /** "51 recorded" and what that is out of. */
  detail: string;
  count: number;
  place: ResolvedPlace;
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const stationKindOf = (k: FacilityKind): EventSite["kind"] => (k === "service_area" ? "pump" : "booth");

/**
 * The places this kind of event is recorded most often, in this window and on
 * this carriageway, busiest first: 100 m stretches of the carriageway (each
 * with the lane most of its events were in), and the plazas, ramps and service
 * areas in the window, matched to the logs by name.
 */
export function candidatesFrom(hot: Hotspots | null, sites: readonly SiteOption[], fromKm: number, toKm: number): Candidate[] {
  if (!hot) return [];
  const out: Candidate[] = [];
  for (const s of hot.stretches) {
    const mid = Math.min(toKm, Math.max(fromKm, (s.fromKm + s.toKm) / 2));
    out.push({
      key: `km:${s.fromKm}`,
      label: `Km ${s.fromKm.toFixed(2)}–${s.toKm.toFixed(2)}${s.lane != null ? ` · Lane ${s.lane}` : ""}`,
      detail: `${s.count.toLocaleString()} recorded${s.lane != null && s.laneShare != null ? `, ${Math.round(s.laneShare * 100)}% of those in a lane were in Lane ${s.lane}` : ""}`,
      count: s.count,
      place: { positionKm: mid, lane: s.lane, site: null, note: `Busiest 100 m of this stretch for this kind of event in the incident log.`, incomplete: false },
    });
  }
  // Each logged place counted once, against the facility in this window it names.
  for (const f of hot.facilities) {
    const name = norm(f.name);
    const matches = sites.filter((s) => s.recordNames.some((r) => norm(r) === name));
    if (matches.length === 0) continue;
    // A plaza's events belong to the facility with booths; an interchange's to its ramps.
    const pick =
      f.place === "TSF"
        ? matches.find((s) => s.kind === "service_area")
        : f.place === "Toll Plaza"
          ? matches.find((s) => s.stations > 0 && s.kind !== "service_area") ?? matches[0]
          : matches.find((s) => s.stations === 0 && s.kind !== "service_area") ?? matches.find((s) => s.kind !== "service_area");
    if (!pick) continue;
    const atBooth = f.place !== "Interchange" && pick.stations > 0;
    // The log does not say which booth. On a ramp plaza the one nearest the
    // expressway; across a barrier, the middle of the plaza.
    const booth = pick.kind === "barrier" ? Math.floor(pick.stations / 2) : 0;
    const site: EventSite = {
      facilityId: pick.id,
      facilityName: pick.name,
      kind: atBooth ? stationKindOf(pick.kind) : "approach",
      stations: atBooth ? [booth] : [],
    };
    out.push({
      key: `site:${pick.id}:${f.place}`,
      label: `${pick.name}${atBooth ? ` · ${site.kind} ${booth + 1}` : pick.kind === "barrier" ? " · before the booths" : " · on the ramp"}`,
      detail: `${f.count.toLocaleString()} recorded at ${f.name} (${f.place === "TSF" ? "service area" : f.place.toLowerCase()})`,
      count: f.count,
      place: {
        positionKm: Math.min(toKm, Math.max(fromKm, pick.km)),
        lane: null,
        site,
        note: atBooth
          ? `Where the log records this kind of event most. It does not say which ${site.kind}, so ${pick.kind === "barrier" ? "the middle of the plaza" : "the one nearest the expressway"} is used — change it under "At a plaza".`
          : `Where the log records this kind of event most: ${pick.kind === "barrier" ? `on the approach to ${pick.name}` : `on ${pick.name}'s ramp`}.`,
        incomplete: false,
      },
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

export function resolvePlace(opts: {
  mode: PlaceMode;
  defaultKm: number;
  fromKm: number;
  toKm: number;
  posKm: number | null;
  candidates: readonly Candidate[];
  choice: string | null;
  pick: PickResult | null;
  sites: readonly SiteOption[];
  siteId: string | null;
  siteStations: readonly number[];
  siteApproach: boolean;
  hotLoading: boolean;
  hotError: string | null;
}): ResolvedPlace {
  const clampKm = (km: number) => Math.min(opts.toKm, Math.max(opts.fromKm, km));
  switch (opts.mode) {
    case "data": {
      const c = opts.candidates.find((x) => x.key === opts.choice) ?? opts.candidates[0];
      if (c) return c.place;
      if (opts.hotLoading) return { positionKm: opts.defaultKm, lane: null, site: null, note: "Reading the incident log…", incomplete: true };
      return {
        positionKm: opts.defaultKm,
        lane: null,
        site: null,
        note: opts.hotError ?? "Nothing of this kind is recorded on this stretch — pick a place yourself.",
        incomplete: true,
      };
    }
    case "pick":
      if (!opts.pick) return { positionKm: opts.defaultKm, lane: null, site: null, note: "Click a lane, a booth or a pump on the road.", incomplete: true };
      return {
        positionKm: clampKm(opts.pick.km),
        lane: opts.pick.lane,
        site: opts.pick.site,
        note: opts.pick.site
          ? `Picked: ${opts.pick.site.facilityName} · ${opts.pick.site.kind === "approach" ? "on the ramp" : `${opts.pick.site.kind} ${opts.pick.site.stations.map((i) => i + 1).join(", ")}`}`
          : `Picked: Km ${opts.pick.km.toFixed(2)}${opts.pick.lane != null ? `, Lane ${opts.pick.lane}` : ""}`,
        incomplete: false,
      };
    case "site": {
      const s = opts.sites.find((x) => x.id === opts.siteId) ?? opts.sites[0];
      if (!s) return { positionKm: opts.defaultKm, lane: null, site: null, note: "No toll plaza, ramp or service area on this stretch for this carriageway.", incomplete: true };
      const approach = opts.siteApproach || s.stations === 0;
      const stations = approach ? [] : [...new Set(opts.siteStations.filter((i) => i >= 0 && i < s.stations))].sort((a, b) => a - b);
      return {
        positionKm: clampKm(s.km),
        lane: null,
        site: {
          facilityId: s.id,
          facilityName: s.name,
          kind: approach ? "approach" : stationKindOf(s.kind),
          stations: stations.length > 0 || approach ? stations : [0],
        },
        note: null,
        incomplete: false,
      };
    }
    case "km":
    default:
      return { positionKm: opts.posKm ?? opts.defaultKm, lane: null, site: null, note: null, incomplete: false };
  }
}

/** "Booth 1 (nearest the expressway)" — or, at a barrier, which side of the plaza. */
export function stationLabel(kind: FacilityKind, i: number, of: number): string {
  const what = kind === "service_area" ? "Pump" : "Booth";
  if (kind === "barrier") return `${what} ${i + 1}${i === 0 ? " (median side)" : i === of - 1 ? " (outer side)" : ""}`;
  return `${what} ${i + 1}${i === 0 ? " (nearest the expressway)" : ""}`;
}
