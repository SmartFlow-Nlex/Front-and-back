"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NlexExit } from "../../../lib/nlex-exits";
import { TrafficSim, type Interventions, type Metrics } from "./simulation";
import {
  NO_OWNERS,
  addEventToBucket,
  applyAtBoundary,
  createEngineBinding,
  describeActiveEvents,
  describeBoundary,
  effectiveState,
  nextBoundaryAfter,
  ownershipKey,
  removeEvent,
  roadOf,
  scenarioLockedLanes,
  scenarioTimeS,
  stepToScenarioTime,
  type Direction,
  type Incident,
  type ManualControls,
  type NewEventSpec,
  type Ownership,
  type Road,
  type RoadFrame,
  type ScenarioEvent,
} from "./scenarios/adapter";
import type { SkipView } from "./components/ScenarioPanel";
import { shapeForecastMix, type ClassShares } from "./forecastMix";
import { corridorPlaces, movementKm, planFacilities, southboundFromBarrier, type FacilityPlan } from "./facilityLayout";
import type { InflowFrom } from "./recommendation";
import { borrowedLanes, crossoverM, type ZipperState } from "./zipper";
import { placeFuelStations } from "../../../lib/nlex-fuel-stations";

/**
 * One carriageway's worth of simulation: its own TrafficSim, its own scenario
 * events and their engine binding, its own manual interventions, demand
 * anchoring and metrics/baseline. Called exactly twice — once per Direction —
 * regardless of which view (NB / SB / Both) is selected; the inactive
 * direction's sim simply is not stepped or rendered (see the rAF loop in
 * page.tsx), which is what keeps NB-only and SB-only behaviourally identical
 * to the single-sim page this replaces.
 *
 * What is per-direction here (sim, bindings, events, metrics, baseline, lane
 * count, inflow, demand/plaza data, every manual-intervention field) versus
 * what the caller keeps shared (the km window, sim speed, running/paused,
 * warm-up, hour of day) follows the split agreed in Phase D1/D2: see that
 * report for the reasoning. Two independent EngineBindings — one per call —
 * because createEngineBinding() closes over private ownership state; reusing
 * one binding for two sims would let each direction's "who owns the closure
 * right now" answer stomp on the other's (see verify.ts's binding-isolation
 * checks).
 */

const WARMUP_S = 60;

export type DemandHour = { hour: number; vehPerHour: number; mix: Record<1 | 2 | 3, number> };
export type DemandProfile = {
  exit: string;
  hours: DemandHour[];
  peakHour: number;
  peakVehPerHour: number;
  meanVehPerHour: number;
  peakingFactor: number;
  days: number;
};
export type PlazaFlow = {
  exit: string;
  entriesByHour: number[];
  exitsByHour: number[];
  /** Where each figure comes from (Back-End getPlazaFlows): paid transactions, closed-system tickets
   *  counted where they were taken, or — for the free open-system exits — an estimate. Absent: paid. */
  entriesSource?: "paid" | "ticket" | "none";
  exitsSource?: "paid" | "estimated" | "none";
};

export type Baseline = {
  avgSpeedKmh: number;
  throughputPerMin: number;
  longestQueueM: number;
  co2RatePerMin: number;
  avgTravelTimeS: number;
  takenWith: string;
};

/** What every direction shares, computed once by the page and handed to each hook call. */
export type SharedRoadInputs = {
  readonly BACKEND: string;
  readonly fromKm: number;
  readonly toKm: number;
  readonly segLengthM: number;
  readonly EXITS: readonly NlexExit[];
  readonly nearestExit: NlexExit | null;
  /** Each carriageway's lane count over the km window, from the corridor's lane table (lib/nlex-lanes.ts,
   *  OpenStreetMap), or null where the table has nothing. Per direction: the two carriageways are mapped apart. */
  readonly segmentLanes: Readonly<Record<Direction, number | null>>;
  readonly hourOfDay: number | null;
  /** The hook calls this once, only if hourOfDay is still null, with its OWN demand profile's peak hour — whichever direction's fetch resolves first wins. See the D2 report for why this is a stated interim behaviour, not a bug. */
  readonly proposeHourOfDay: (hour: number) => void;
  /** Warehouse CO2 factors (not fleet-mix share — that comes from each direction's OWN demand profile at the shared hour, see activeHour below). Direction-independent: a vehicle class's g/m factor is not a property of which carriageway it is on. */
  readonly classProfile: Partial<Record<1 | 2 | 3, { co2PerM?: number; share?: number }>> | undefined;
  /**
   * Zero the shared fixed-step accumulator the rAF loop uses (see page.tsx). Called when a skip
   * finishes on THIS direction — the accumulator is shared across both directions (they advance sim
   * time in lockstep from the same real dtReal), so a skip on either one leaving it non-zero would
   * make the very next frame think it owes a burst of catch-up steps to BOTH sims, not just the one
   * that was skipping.
   */
  readonly resetSimAccumulator: () => void;
  /**
   * The arrival rate (veh/h at the segment) the forecast gives for the chosen day and hour, once the operator has
   * loaded a forecast. Null before that, and the observed hourly profile drives the inflow as it always did. Both
   * carriageways get the same number: the forecast is one segment-level prediction, not one per direction.
   */
  readonly forecastInflow: number | null;
  /**
   * Whole incidents the forecast expects at the chosen hour (the Incident tab's hourly figure), and the one
   * carriageway they are shown on — the forecast is corridor-wide and names no direction, so it is the road in focus.
   */
  readonly forecastIncidents: { readonly count: number; readonly on: Direction | null };
  /**
   * The fleet-mix forecast's Class 1 / 2 / 3 shares for the loaded day. Null when none is loaded or the day is
   * outside that model's horizon, and the observed hourly mix runs as before. It is shaped to the hour here, per
   * direction, from that direction's own demand profile (see forecastMix.ts).
   */
  readonly forecastMix: ClassShares | null;
  /** The lane reallocation in force (Both mode), or null: the carriageway it lends lanes to runs them as its own innermost lanes. */
  readonly reallocation: ZipperState | null;
};

function buildInterventions(lanes: number, len: number): Partial<Interventions> {
  return {
    closedLanes: Array(lanes).fill(false),
    closurePoint: len * 0.55,
    closureEnd: len,
    incidents: [],
    speedLimitKmh: null,
    speedZone: [len * 0.3, len * 0.8],
  };
}

/** Seeds spaced widely, same reasoning and gap as replicate() (simulation.ts): adjacent seeds in mulberry32 can correlate, and NB/SB usually differ in config anyway so a shared seed buys nothing. */
const SEED_BY_DIRECTION: Readonly<Record<Direction, number>> = { NB: 12345, SB: 12345 + 7919 };

export function useDirectionSim(direction: Direction, shared: SharedRoadInputs) {
  const { BACKEND, fromKm, toKm, segLengthM, EXITS, nearestExit, segmentLanes, hourOfDay, proposeHourOfDay, classProfile, resetSimAccumulator, forecastInflow, forecastIncidents, forecastMix, reallocation } = shared;
  const lentLanes = borrowedLanes(reallocation, direction);

  const simRef = useRef<TrafficSim | null>(null);
  const [scenarioBinding] = useState(createEngineBinding);

  const [laneCount, setLaneCount] = useState(4);
  const [inflow, setInflow] = useState(4500);
  const [closedLanes, setClosedLanes] = useState<boolean[]>(Array(4).fill(false));
  const [speedLimit, setSpeedLimit] = useState<number | null>(null);
  const [incidentCount, setIncidentCount] = useState(0);
  const [scenarioEvents, setScenarioEvents] = useState<readonly ScenarioEvent[]>([]);
  const [owners, setOwners] = useState<Ownership>(NO_OWNERS);
  const ownersKeyRef = useRef(ownershipKey(NO_OWNERS));
  const publishOwners = useCallback((next: Ownership) => {
    const key = ownershipKey(next);
    if (key === ownersKeyRef.current) return;
    ownersKeyRef.current = key;
    setOwners(next);
  }, []);
  const [skip, setSkip] = useState<SkipView | null>(null);
  const scenarioDueRef = useRef(-Infinity);
  const scenarioSeqRef = useRef(0);
  const scenarioEventsRef = useRef<readonly ScenarioEvent[]>([]);
  const skipRef = useRef<{ cancel: boolean } | null>(null);
  const scenarioCtxRef = useRef<{ controls: ManualControls; events: readonly ScenarioEvent[]; frame: RoadFrame } | null>(null);

  const [closureKm, setClosureKm] = useState<number | null>(null);
  const [closureEndKm, setClosureEndKm] = useState<number | null>(null);
  const [zoneFromKm, setZoneFromKm] = useState<number | null>(null);
  const [zoneToKm, setZoneToKm] = useState<number | null>(null);
  const [placingIncident, setPlacingIncident] = useState(false);
  const [placingClosure, setPlacingClosure] = useState(false);
  const [closureDraftKm, setClosureDraftKm] = useState<number | null>(null);

  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);

  /* ── Demand, plaza flows, mainline volume: all per direction (see D1 §2 / D2 correction #3).
     Fetched in parallel with the OTHER direction's identical fetches (each hook instance issues
     its own three requests; the browser runs them concurrently regardless, but the page no longer
     waits on one direction before starting the other's — there is no sequencing between hook
     instances at all, which is the strongest form of "parallel" available here). */
  const [demand, setDemand] = useState<DemandProfile | null>(null);
  useEffect(() => {
    if (!nearestExit) return;
    const name = encodeURIComponent(String(nearestExit.exit_name));
    let cancelled = false;
    fetch(`${BACKEND}/api/ai-sandbox/demand-profile?exit=${name}&direction=${direction}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        if (j?.success && j.data?.hours?.length) {
          setDemand(j.data);
          proposeHourOfDay(j.data.peakHour);
        } else setDemand(null);
      })
      .catch(() => { if (!cancelled) setDemand(null); });
    return () => { cancelled = true; };
    // proposeHourOfDay is a stable setter-wrapping callback from the page; omitted deliberately,
    // matching the original single-direction effect's own dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nearestExit, direction, BACKEND]);

  const activeHour = useMemo(
    () => (demand && hourOfDay != null ? demand.hours.find((h) => h.hour === hourOfDay) ?? null : null),
    [demand, hourOfDay],
  );

  const [plazaFlows, setPlazaFlows] = useState<PlazaFlow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND}/api/ai-sandbox/plaza-flows?direction=${direction}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setPlazaFlows(j?.success ? j.data.plazas : null); })
      .catch(() => { if (!cancelled) setPlazaFlows(null); });
    return () => { cancelled = true; };
  }, [direction, BACKEND]);

  const flowAt = useCallback(
    (exitName: string, hour: number) => {
      if (!plazaFlows) return null;
      const key = String(exitName).toLowerCase().trim();
      const f =
        plazaFlows.find((x) => x.exit.toLowerCase().trim() === key) ??
        plazaFlows.find((x) => {
          const k = x.exit.toLowerCase().trim();
          return k.includes(key) || key.includes(k);
        });
      if (!f) return null;
      const h = Math.max(0, Math.min(23, hour));
      return { entries: f.entriesByHour[h] ?? 0, exits: f.exitsByHour[h] ?? 0, entriesSource: f.entriesSource, exitsSource: f.exitsSource };
    },
    [plazaFlows],
  );

  const mainlineAtKm = useCallback(
    (km: number, hour: number): number | null => {
      if (!plazaFlows || EXITS.length === 0) return null;
      // Southbound runs off the Bocaue Barrier's count (facilityLayout.southboundFromBarrier):
      // the paid-only sum below is negative at every southbound interchange.
      if (direction === "SB") {
        const counted = southboundFromBarrier(km, hour, EXITS, flowAt);
        if (counted != null) return counted;
      }
      let flow = 0;
      let sawAny = false;
      const upstream = (at: number) => (direction === "NB" ? at <= km + 1e-6 : at >= km - 1e-6);
      for (const e of EXITS) {
        // Each movement where its plaza stands, as the layout draws it (facilityLayout.movementKm).
        const entersUp = upstream(movementKm(e.exit_name, "entry", direction, e.km));
        const leavesUp = upstream(movementKm(e.exit_name, "exit", direction, e.km));
        if (!entersUp && !leavesUp) continue;
        const f = flowAt(e.exit_name, hour);
        if (!f) continue;
        sawAny = true;
        /* Paid transactions only, as this estimate has always been made. The
           ticketed closed-system entries and the estimated open-system exits
           send traffic through the plazas, but summed along the corridor they
           do not yet agree with the counts that pin it down — southbound they
           put 1,740 veh/h past Bocaue where its barrier records 3,872 paying —
           because trips to SCTEX are never counted on NLEX and trips with no
           recorded direction are split half and half. Until they do, the flow
           entering a stretch stays what it was. */
        if (entersUp && f.entriesSource !== "ticket") flow += f.entries;
        if (leavesUp && f.exitsSource !== "estimated") flow -= f.exits;
      }
      return sawAny ? Math.max(0, Math.round(flow)) : null;
    },
    [plazaFlows, EXITS, direction, flowAt],
  );

  const [plazaVol, setPlazaVol] = useState<Record<string, number> | null>(null);
  const [volDays, setVolDays] = useState(365);
  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND}/api/traffic/analytics?months=12&direction=${direction}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || !j.success) return;
        const map: Record<string, number> = {};
        for (const row of j.data.byPlaza ?? []) map[String(row.plaza).toLowerCase()] = Number(row.v) || 0;
        setPlazaVol(map);
        setVolDays(Math.max(1, j.data.kpis?.days ?? 365));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [direction, BACKEND]);

  const dataAnchor = useMemo(() => {
    const hr = hourOfDay ?? demand?.peakHour ?? 8;
    const ceiling = laneCount * 2200;
    // A loaded forecast decides the inflow outright: the road shows what the forecast day and hour say, not the
    // observed profile for that hour. The floor is lower than the observed one because a forecast quiet hour is quiet.
    if (forecastInflow != null) return Math.max(100, Math.min(ceiling, forecastInflow));
    const entryKm = direction === "NB" ? fromKm : toKm;
    const mainline = mainlineAtKm(entryKm, hr);
    if (mainline != null && mainline > 0) return Math.max(300, Math.min(ceiling, mainline));
    if (activeHour) return Math.max(300, Math.min(ceiling, activeHour.vehPerHour));
    if (!plazaVol || !nearestExit) return null;
    const key = String(nearestExit.exit_name).toLowerCase();
    const total = plazaVol[key] ?? Object.entries(plazaVol).find(([k]) => k.includes(key) || key.includes(k))?.[1];
    if (!total) return null;
    const peakHourly = Math.round((total / volDays / 24) * 1.6);
    return Math.max(600, Math.min(ceiling, peakHourly));
  }, [hourOfDay, demand, laneCount, direction, fromKm, toKm, mainlineAtKm, activeHour, plazaVol, nearestExit, volDays, forecastInflow]);

  const inflowBasis = useMemo(() => {
    if (forecastInflow != null) {
      return "Inflow from the forecast for the chosen day and hour: the Traffic tab's hourly volume forecast at this segment's share of corridor volume — a prediction, not observed flow.";
    }
    const hr = hourOfDay ?? demand?.peakHour ?? 8;
    const entryKm = direction === "NB" ? fromKm : toKm;
    const mainline = mainlineAtKm(entryKm, hr);
    if (mainline == null || mainline <= 0) {
      return activeHour
        ? `Inflow from the volume recorded at ${String(nearestExit?.exit_name ?? "")} — an interchange figure, not a through-flow.`
        : null;
    }
    const barrier = EXITS.find((e) => e.node_type === "toll-barrier");
    if (direction === "SB" && barrier && southboundFromBarrier(entryKm, hr, EXITS, flowAt) != null) {
      const south = entryKm <= movementKm(barrier.exit_name, "exit", "SB", barrier.km);
      return south
        ? `Mainline flow at Km ${entryKm.toFixed(2)}: ${mainline.toLocaleString()} veh/h — the southbound cars counted paying at ${barrier.exit_name}, plus those joining and minus those leaving between it and here.`
        : `Mainline flow at Km ${entryKm.toFixed(2)}: ${mainline.toLocaleString()} veh/h — entries minus exits north of here, balanced to the southbound count at ${barrier.exit_name}.`;
    }
    const feeders = EXITS.filter((e) => (direction === "NB" ? e.km <= entryKm + 1e-6 : e.km >= entryKm - 1e-6)).filter((e) => {
      const f = flowAt(e.exit_name, hr);
      return f && (f.entries > 0 || f.exits > 0);
    });
    const names = feeders.slice(0, 3).map((e) => String(e.exit_name)).join(" + ");
    const more = feeders.length > 3 ? ` +${feeders.length - 3} more` : "";
    return `Mainline flow at Km ${entryKm.toFixed(2)}: ${mainline.toLocaleString()} veh/h — entries minus exits upstream (${names}${more}).`;
  }, [hourOfDay, demand, direction, fromKm, toKm, mainlineAtKm, EXITS, flowAt, activeHour, nearestExit, forecastInflow]);

  useEffect(() => {
    if (dataAnchor != null) setInflow(dataAnchor);
  }, [dataAnchor]);

  /* Where the inflow now driving this carriageway came from, for the
     recommendation (recommendation.ts), which has to say how far to trust it.
     dataAnchor tries the forecast, then the flow along the expressway, then the
     volume at the nearest interchange; "interchange" is that last resort, a
     slip-road figure standing in for the mainline. "assumed" is a stretch none
     of them covers: the slider still holds its starting default, or the
     operator's own figure. */
  const anchorKind = useMemo((): "forecast" | "mainline" | "interchange" | null => {
    if (dataAnchor == null) return null;
    if (forecastInflow != null) return "forecast";
    const hr = hourOfDay ?? demand?.peakHour ?? 8;
    const mainline = mainlineAtKm(direction === "NB" ? fromKm : toKm, hr);
    return mainline != null && mainline > 0 ? "mainline" : "interchange";
  }, [dataAnchor, forecastInflow, hourOfDay, demand, mainlineAtKm, direction, fromKm, toKm]);
  const inflowFrom: InflowFrom =
    anchorKind == null ? "assumed"
      : inflow !== dataAnchor ? "operator"
        : anchorKind === "forecast" ? "forecast"
          : anchorKind === "mainline" ? "record"
            : "interchange";

  // Following the road: this carriageway's lane count is the corridor's own for the km window whenever
  // that changes (a primitive, so a fresh object from the page does not re-fire it); the operator can
  // still override it, and the override stands until the road under the window has a different width.
  const roadLanes = segmentLanes[direction];
  useEffect(() => {
    if (roadLanes != null) setLaneCount(roadLanes);
  }, [roadLanes]);

  // The mix the road runs. With a forecast day loaded that is the fleet-mix forecast (shaped to the hour); without
  // one, the observed mix for the hour. Keyed on the three shares, not the object: this feeds rebuild(), and a new
  // object every render would rebuild the whole simulation every render.
  const fm1 = forecastMix?.[1];
  const fm2 = forecastMix?.[2];
  const fm3 = forecastMix?.[3];
  const forecastShares = useMemo(
    () => (fm1 != null && fm2 != null && fm3 != null ? shapeForecastMix({ 1: fm1, 2: fm2, 3: fm3 }, demand?.hours ?? null, activeHour) : null),
    [fm1, fm2, fm3, demand, activeHour],
  );
  const effectiveClassProfile = useMemo(() => {
    if (!classProfile && !activeHour && !forecastShares) return undefined;
    const out: Partial<Record<1 | 2 | 3, { co2PerM?: number; share?: number }>> = {};
    for (const k of [1, 2, 3] as const) {
      const co2PerM = classProfile?.[k]?.co2PerM;
      const share = forecastShares ? forecastShares[k] : activeHour ? activeHour.mix[k] : classProfile?.[k]?.share;
      if (co2PerM != null || share != null) out[k] = { co2PerM, share };
    }
    return Object.keys(out).length ? out : undefined;
  }, [classProfile, activeHour, forecastShares]);

  /* The busiest hour of each plaza movement, veh/h — what its booths are sized for. */
  const peakAt = useCallback(
    (exitName: string) => {
      if (!plazaFlows) return null;
      const key = String(exitName).toLowerCase().trim();
      const f =
        plazaFlows.find((x) => x.exit.toLowerCase().trim() === key) ??
        plazaFlows.find((x) => {
          const k = x.exit.toLowerCase().trim();
          return k.includes(key) || key.includes(k);
        });
      if (!f) return null;
      return { entries: Math.max(0, ...f.entriesByHour), exits: Math.max(0, ...f.exitsByHour), entriesSource: f.entriesSource, exitsSource: f.exitsSource };
    },
    [plazaFlows],
  );

  // Service areas on this corridor, placed on its km scale from their coordinates.
  const stations = useMemo(() => placeFuelStations([...EXITS]), [EXITS]);

  /* Interchanges, barrier plazas and service areas in the window, as PLACES:
   * the plazas vehicles queue at, sized from the record — see facilityLayout.ts.
   * What could not be laid out (two interchanges closer together than their
   * ramps are long, in a short window) stays a point ramp so its traffic still
   * joins and leaves. */
  const plan: FacilityPlan = useMemo(() => {
    if (fromKm >= toKm) return { facilities: [], ramps: [] };
    const hr = hourOfDay ?? demand?.peakHour ?? 8;
    const shape = activeHour && demand && demand.meanVehPerHour > 0 ? activeHour.vehPerHour / demand.meanVehPerHour : 1;
    return planFacilities({
      direction,
      fromKm,
      toKm,
      segLengthM,
      laneCount,
      exits: EXITS,
      stations,
      flowAt,
      peakAt,
      mainlineAt: mainlineAtKm,
      fallbackHourly: (exitName) => {
        const key = String(exitName).toLowerCase();
        const total = plazaVol?.[key] ?? Object.entries(plazaVol ?? {}).find(([k]) => k.includes(key) || key.includes(k))?.[1];
        return total ? (total / volDays / 24) * shape : null;
      },
      hour: hr,
      inflow,
    });
  }, [EXITS, stations, plazaVol, volDays, activeHour, demand, inflow, direction, fromKm, toKm, segLengthM, laneCount, hourOfDay, flowAt, peakAt, mainlineAtKm]);
  const ramps = plan.ramps;
  const facilities = plan.facilities;
  // Every plaza and service area on this carriageway, for jumping the window to one.
  const places = useMemo(() => corridorPlaces(direction, EXITS, stations, peakAt, laneCount), [direction, EXITS, stations, peakAt, laneCount]);

  const rebuild = useCallback(() => {
    const sim = new TrafficSim(
      {
        length: segLengthM,
        laneCount,
        inflowVehPerHour: inflow,
        seed: SEED_BY_DIRECTION[direction],
        classProfile: effectiveClassProfile,
        ramps,
        facilities,
        warmupS: WARMUP_S,
        /* A queue behind a blocked lane is where NLEX's own data says the next
           crash happens: 11.5% of incidents are followed by another within
           2 km (gold.ml_incident_severity_metadata, n = 4,361). Leaving it out
           made every scenario optimistic in the same direction — the sandbox
           could only ever show one incident at a time, so a long closure never
           compounded the way a real one does.

           It stays reproducible: the draw comes from the simulation's seeded
           RNG, so the same seed gives the same run and a baseline capture is
           still comparable. */
        secondaryIncidents: true,
        // Lanes lent by the other carriageway: entered and left only at the crossovers (zipper.ts).
        borrowed: lentLanes > 0 ? { lanes: lentLanes, crossM: crossoverM(segLengthM) } : undefined,
      },
      buildInterventions(laneCount, segLengthM),
    );
    simRef.current = sim;
    setClosedLanes(Array(laneCount).fill(false));
    setSpeedLimit(null);
    setIncidentCount(0);
    setBaseline(null);
    scenarioBinding.reset();
    scenarioDueRef.current = -Infinity;
    if (skipRef.current) skipRef.current.cancel = true;
    /* The render loop only polls metrics while `running`, so a rebuild while paused (Reset, or any
     * control that rebuilds mid-pause) would otherwise leave the OLD sim's last metrics on screen —
     * stale elapsed time, stale warm-up countdown, and now a live clock (page.tsx) that reads
     * elapsedS to show the time of day, which would keep showing wherever the old run left off
     * instead of snapping back to the start of the picked forecast hour. Snapshotting the fresh
     * sim's own (zeroed) metrics here makes a rebuild correct immediately, whether or not the loop
     * is currently ticking. */
    setMetrics(sim.metrics());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneCount, segLengthM, effectiveClassProfile, ramps, facilities, scenarioBinding, direction, lentLanes]);

  useEffect(() => {
    rebuild();
  }, [rebuild]);

  /* The incidents the forecast expects this hour, shown on the carriageway the operator is looking at.
   *
   * rebuild() makes a fresh engine, and the hour is one of the things that rebuilds it (the ramp flows follow it),
   * so these are placed after EVERY rebuild rather than once. This effect is declared after the one above and so
   * runs after it in the same commit, onto the new engine. What was placed last time is lifted out by identity
   * before the new set goes in, so changing the hour swaps them instead of stacking them.
   * They are ordinary incidents: they count in "Clear (n)" and the operator can remove them. The first sits in the
   * outer lane (where a breakdown pulls over), any more stagger inwards and upstream. */
  const forecastPlacedRef = useRef<Incident[]>([]);
  const forecastIncidentCount = forecastIncidents.on === direction ? forecastIncidents.count : 0;
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const prev = forecastPlacedRef.current;
    if (prev.length) sim.interventions.incidents = sim.interventions.incidents.filter((i) => !prev.includes(i));
    const placed: Incident[] = [];
    for (let i = 0; i < Math.min(forecastIncidentCount, laneCount); i++) {
      sim.addIncident(laneCount - 1 - i, segLengthM * (0.6 - 0.08 * i));
      placed.push(sim.interventions.incidents[sim.interventions.incidents.length - 1]);
    }
    forecastPlacedRef.current = placed;
    setIncidentCount(scenarioBinding.operatorIncidents(sim).length);
  }, [rebuild, forecastIncidentCount, laneCount, segLengthM, scenarioBinding]);

  useEffect(() => {
    if (simRef.current) simRef.current.cfg.inflowVehPerHour = inflow;
  }, [inflow]);

  const clampKm = useCallback((km: number) => Math.min(Math.max(km, fromKm), toKm), [fromKm, toKm]);
  const kmAt = useCallback((m: number) => (direction === "NB" ? fromKm + m / 1000 : toKm - m / 1000), [direction, fromKm, toKm]);
  const mAt = useCallback((km: number) => (direction === "NB" ? (km - fromKm) * 1000 : (toKm - km) * 1000), [direction, fromKm, toKm]);
  const spanM = (toKm - fromKm) * 1000;
  const closureAtKm = clampKm(closureKm ?? kmAt(spanM * 0.55));
  const zoneA = clampKm(zoneFromKm ?? kmAt(spanM * 0.3));
  const zoneB = clampKm(zoneToKm ?? kmAt(spanM * 0.8));
  const closureEndAtKm = clampKm(Math.max(closureEndKm ?? toKm, closureAtKm + 0.01));
  const closureM = Math.min(mAt(closureAtKm), mAt(closureEndAtKm));
  const closureEndM = Math.max(mAt(closureAtKm), mAt(closureEndAtKm));
  const shownSpeedLimit = owners.speedZone ? owners.speedZone.limitKmh : speedLimit;
  const shownZoneFromKm = owners.speedZone ? Math.min(kmAt(owners.speedZone.zone[0]), kmAt(owners.speedZone.zone[1])) : zoneA;
  const shownZoneToKm = owners.speedZone ? Math.max(kmAt(owners.speedZone.zone[0]), kmAt(owners.speedZone.zone[1])) : zoneB;
  const shownClosureFromKm = owners.closure ? Math.min(kmAt(owners.closure.closurePointM), kmAt(owners.closure.closureEndM)) : closureAtKm;
  const shownClosureToKm = owners.closure ? Math.max(kmAt(owners.closure.closurePointM), kmAt(owners.closure.closureEndM)) : closureEndAtKm;

  const commitClosureStart = useCallback(
    (km: number) => {
      const a = clampKm(km);
      setClosureKm(a);
      if (a >= closureEndAtKm) setClosureEndKm(clampKm(a + 0.1));
    },
    [clampKm, closureEndAtKm],
  );
  const commitClosureEnd = useCallback(
    (km: number) => {
      const b = clampKm(km);
      if (b <= closureAtKm) setClosureKm(clampKm(b - 0.1));
      setClosureEndKm(b);
    },
    [clampKm, closureAtKm],
  );
  const zoneM: [number, number] = [Math.min(mAt(zoneA), mAt(zoneB)), Math.max(mAt(zoneA), mAt(zoneB))];

  const lockedLanes = scenarioLockedLanes(owners, laneCount);
  const toggleLane = useCallback(
    (i: number) => {
      if (lockedLanes[i]) return;
      setClosedLanes((prev) => prev.map((c, idx) => (idx === i ? !c : c)));
    },
    [lockedLanes],
  );

  const manualControls: ManualControls = {
    closedLanes,
    closurePoint: closureM,
    closureEnd: closureEndM,
    showClosurePreview: closureKm != null || closureEndKm != null || placingClosure,
    speedLimitKmh: speedLimit,
    speedZone: zoneM,
  };
  // Memoized: addScenarioEvent/skipToNextPhase depend on it, and a fresh object here every render
  // would defeat their own useCallback memoization for no reason — mAt is itself already stable.
  const scenarioFrame: RoadFrame = useMemo(() => ({ warmupS: WARMUP_S, metresAt: mAt }), [mAt]);
  const scenarioRoad: Road = { laneCount, segmentLengthM: segLengthM, ...scenarioFrame };
  const scenarioNowS = scenarioTimeS(metrics?.elapsedS ?? 0, scenarioFrame);
  const eff = effectiveState({ closedLanes, speedLimitKmh: speedLimit }, owners, scenarioEvents, scenarioNowS, laneCount);
  const effIncidentCount = incidentCount + eff.scenarioIncidents;
  const activeScenarioText = describeActiveEvents(eff.active);
  const anyIntervention = eff.closedLanes.some(Boolean) || eff.speedLimitKmh != null || effIncidentCount > 0;
  const closedLaneList = eff.closedLanes.map((c, i) => (c ? `L${i + 1}` : null)).filter(Boolean).join(", ");
  const interventionSummary =
    [
      closedLaneList ? `${closedLaneList} closed` : null,
      closedLaneList ? `Km ${shownClosureFromKm.toFixed(2)}–${shownClosureToKm.toFixed(2)}` : null,
      effIncidentCount > 0 ? `${effIncidentCount} incident${effIncidentCount === 1 ? "" : "s"}` : null,
      eff.speedLimitKmh != null ? `${eff.speedLimitKmh} km/h zone` : null,
      ...activeScenarioText,
    ]
      .filter(Boolean)
      .join(" · ") || "none applied";

  // Live-apply interventions (same discipline as the single-direction page: composeInterventions
  // via the binding is the ONLY writer of this direction's engine state).
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    scenarioCtxRef.current = { controls: manualControls, events: scenarioEvents, frame: scenarioFrame };
    const { owners: next } = scenarioBinding.apply(sim, manualControls, scenarioEvents, scenarioFrame);
    const now = scenarioTimeS(sim.time, scenarioFrame);
    const due = nextBoundaryAfter(scenarioEvents, roadOf(sim, scenarioFrame), now);
    scenarioDueRef.current = due === null ? Infinity : due;
    publishOwners(next);
    // manualControls/scenarioFrame are rebuilt from the values listed on every render, same as the original.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedLanes, speedLimit, closureM, closureEndM, zoneM[0], zoneM[1], closureKm, closureEndKm, placingClosure, scenarioEvents, direction, fromKm, toKm, scenarioBinding, publishOwners]);

  const addScenarioEvent = useCallback(
    (spec: NewEventSpec): { ok: true; event: ScenarioEvent } | { ok: false; reason: string } => {
      const sim = simRef.current;
      if (!sim) return { ok: false, reason: "The simulation has not started yet." };
      const seq = scenarioSeqRef.current + 1;
      // Through addEventToBucket, not addEvent: this list is `direction`'s, and an event naming the other carriageway (or a list
      // already holding one) is refused with a reason instead of being stored.
      const r = addEventToBucket(direction, scenarioEventsRef.current, spec, roadOf(sim, scenarioFrame), seq, { closedLanes, closurePoint: closureM, closureEnd: closureEndM });
      if (!r.ok) return r;
      scenarioSeqRef.current = seq;
      scenarioEventsRef.current = r.events;
      setScenarioEvents(r.events);
      return { ok: true, event: r.event };
    },
    [direction, scenarioFrame, closedLanes, closureM, closureEndM],
  );
  const removeScenarioEvent = useCallback((id: string) => {
    scenarioEventsRef.current = removeEvent(scenarioEventsRef.current, id);
    setScenarioEvents(scenarioEventsRef.current);
  }, []);

  /**
   * Reset pressed: this carriageway back to a clean start, scenarios included. Every event is removed and the
   * numbering restarts, the operator's closure / speed-zone stretch positions and any armed placing tool are
   * put away, and the run is rebuilt (rebuild(): a new engine; hand-set closed lanes, speed limit, incidents and
   * the baseline cleared; a skip in progress cancelled). The route, lane count and inflow are the setup, not the
   * run, and stay as they are.
   */
  const resetAll = useCallback(() => {
    scenarioEventsRef.current = [];
    setScenarioEvents([]);
    scenarioSeqRef.current = 0;
    setClosureKm(null);
    setClosureEndKm(null);
    setZoneFromKm(null);
    setZoneToKm(null);
    setPlacingIncident(false);
    setPlacingClosure(false);
    setClosureDraftKm(null);
    rebuild();
  }, [rebuild]);

  const cancelSkip = useCallback(() => {
    if (skipRef.current) skipRef.current.cancel = true;
  }, []);
  const skipToNextPhase = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    if (skipRef.current) return;
    const road = roadOf(sim, scenarioFrame);
    const from = scenarioTimeS(sim.time, road);
    const target = nextBoundaryAfter(scenarioEventsRef.current, road, from);
    if (target === null) return;
    const token = { cancel: false };
    skipRef.current = token;
    const what = describeBoundary(scenarioEventsRef.current, road, target, from);
    setSkip({ label: what ? what.label : "the next phase", intervalStartS: what ? what.intervalStartS : from, targetS: target, nowS: from });
    const finish = () => {
      skipRef.current = null;
      setSkip(null);
      resetSimAccumulator();
    };
    const pump = () => {
      if (token.cancel || simRef.current !== sim) {
        finish();
        return;
      }
      const r = stepToScenarioTime(sim, scenarioFrame, target, 0.05, 25, () => performance.now());
      if (!r.reached) {
        const now = scenarioTimeS(sim.time, scenarioFrame);
        setSkip((cur) => (cur ? { ...cur, nowS: now } : cur));
        setTimeout(pump, 0);
        return;
      }
      const ctx = scenarioCtxRef.current;
      if (ctx) {
        const applied = applyAtBoundary(scenarioBinding, sim, ctx.controls, ctx.events, ctx.frame, -Infinity);
        scenarioDueRef.current = applied.dueS;
        publishOwners(applied.composition ? applied.composition.owners : NO_OWNERS);
      }
      setMetrics(sim.metrics());
      finish();
    };
    setTimeout(pump, 0);
  }, [scenarioFrame, scenarioBinding, publishOwners, resetSimAccumulator]);

  const clearIncidents = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    scenarioBinding.clearOperatorIncidents(sim);
    setIncidentCount(0);
  }, [scenarioBinding]);

  /** Drop an operator incident at (lane, x metres) on THIS direction's sim, and keep incidentCount in step. The page's click handler maps a canvas click to (lane, x) — see roadLayout — but placing the incident and counting it is this direction's own business. */
  const placeIncident = useCallback(
    (lane: number, x: number) => {
      const sim = simRef.current;
      if (!sim) return;
      sim.addIncident(lane, x);
      setIncidentCount(scenarioBinding.operatorIncidents(sim).length);
    },
    [scenarioBinding],
  );

  const captureBaseline = useCallback(() => {
    if (!metrics) return;
    const closed = eff.closedLanes.map((c, i) => (c ? `L${i + 1}` : null)).filter(Boolean).join(", ");
    setBaseline({
      avgSpeedKmh: metrics.avgSpeedKmh,
      throughputPerMin: metrics.throughputPerMin,
      longestQueueM: metrics.longestQueueM,
      co2RatePerMin: metrics.co2RatePerMin,
      avgTravelTimeS: metrics.avgTravelTimeS,
      takenWith:
        [
          closed ? `${closed} closed` : null,
          eff.speedLimitKmh != null ? `${eff.speedLimitKmh} km/h zone` : null,
          effIncidentCount > 0 ? `${effIncidentCount} incident${effIncidentCount === 1 ? "" : "s"}` : null,
          ...activeScenarioText,
        ]
          .filter(Boolean)
          .join(" · ") || "a clear road",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metrics, eff.closedLanes, eff.speedLimitKmh, effIncidentCount, activeScenarioText]);

  return {
    direction,
    simRef,
    scenarioBinding,
    laneCount, setLaneCount,
    inflow, setInflow, dataAnchor, inflowBasis, inflowFrom,
    demand, hourOfDay, activeHour,
    closedLanes, setClosedLanes, toggleLane, lockedLanes,
    speedLimit, setSpeedLimit, shownSpeedLimit,
    incidentCount, clearIncidents, placeIncident,
    closureKm, setClosureKm, closureEndKm, setClosureEndKm, zoneFromKm, setZoneFromKm, zoneToKm, setZoneToKm,
    closureAtKm, closureEndAtKm, shownClosureFromKm, shownClosureToKm, shownZoneFromKm, shownZoneToKm,
    commitClosureStart, commitClosureEnd,
    placingIncident, setPlacingIncident, placingClosure, setPlacingClosure, closureDraftKm, setClosureDraftKm,
    scenarioEvents, owners, skip, cancelSkip, skipToNextPhase,
    addScenarioEvent, removeScenarioEvent,
    metrics, setMetrics, baseline, setBaseline, captureBaseline,
    eff, effIncidentCount, activeScenarioText, anyIntervention, interventionSummary,
    manualControls, scenarioFrame, scenarioRoad, scenarioNowS,
    kmAt, mAt, clampKm, spanM,
    ramps,
    facilities,
    places,
    rebuild,
    resetAll,
    publishOwners,
    scenarioCtxRef, scenarioDueRef, scenarioSeqRef, skipRef,
  };
}

export type DirectionApi = ReturnType<typeof useDirectionSim>;
