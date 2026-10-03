import type { NlexExit } from "../../../lib/nlex-exits";
import { displayExitName } from "../../../lib/nlex-exits";
import type { PlacedFuelStation } from "../../../lib/nlex-fuel-stations";
import { OSM_TOLL_PLAZAS, OSM_TOLL_PLAZAS_AWAY, type OsmTollPlaza } from "../../../lib/nlex-toll-plazas";
import type { RampSpec } from "./simulation";
import {
  PAY_BOOTH_VEH_PER_HOUR,
  SERVICE_DWELL_S,
  SERVICE_PUMPS,
  SERVICE_PUMPS_AT_M,
  SERVICE_STOP_SHARE,
  MAX_BARRIER_BOOTHS,
  MAX_RAMP_BOOTHS,
  boothDwellFor,
  boothLineAtM,
  footprintM,
  type FacilityKind,
  type FacilitySpec,
} from "./facilities";

/* ══════════════════════════════════════════════════════════════════════════════
   WHICH PLAZAS AND SERVICE AREAS ARE IN THIS STRETCH, AND HOW BIG

   Every number here comes from the warehouse or from the corridor's own
   reference lists, except two that it cannot supply and that are labelled as
   assumptions wherever they are shown:

     - Which movements exist: silver.nlex_exit_reference's per-direction entry
       and exit flags (via the exit list), and the service-area list.
     - How much uses each one: the per-plaza entries and exits for the
       direction and hour (Back-End getPlazaFlows). The record keeps each trip
       where it PAID — on entry between Balintawak and Bocaue, on exit beyond —
       so closed-system entries come from the same trips counted where their
       ticket was taken, and the open system's exits, which are free and never
       recorded, are ESTIMATED as the round trip and labelled so.
     - Where the plazas ARE, and how many booth lanes each has: OpenStreetMap
       (lib/nlex-toll-plazas.ts, (c) OpenStreetMap contributors), which maps
       every NLEX plaza road with its lane count at the booths. That decides
       which ramps have booths — including closed-system entries, which take a
       ticket and so are not in the payment record — where along the corridor
       the booth line stands, and how wide the plaza is drawn.
     - Where an interchange's plaza stands off on the road it connects to (the
       Harbor Link's Mindanao and Karuhatan plazas), the junction itself is a
       plain ramp: that is where its recorded traffic paid.
     - Where OpenStreetMap has no plaza but the record shows tolled
       traffic, the booths are ESTIMATED: enough that the busiest hour on record
       runs them at 85% of the operator's 350 vehicles an hour per booth.
       Labelled as an estimate wherever it is shown.
     - Barrier plazas: only where one is mapped. At Bocaue that is the
       southbound side, which also pays the closed-system fare in the record;
       northbound traffic passes without stopping.
     - ASSUMED: the share of passing traffic that stops at a service area and
       how long it stays (facilities.ts: SERVICE_STOP_SHARE, SERVICE_DWELL_S).
══════════════════════════════════════════════════════════════════════════════ */

/** Design utilisation of a booth in the busiest hour on record. */
const DESIGN_UTILISATION = 0.85;
/** Keep facilities clear of the entrance, where traffic is still being placed on the road. */
const MARGIN_START_M = 60;
const MARGIN_END_M = 20;
/** Room between two facilities so their ramps are not drawn into each other. */
const GAP_M = 15;
/** How far a facility may be slid from its true position to fit beside another. */
const MAX_SLIDE_M = 260;

export type FlowPair = {
  entries: number;
  exits: number;
  /** "paid": open-system entry fares. "ticket": closed-system tickets, counted where they were taken. Absent: paid. */
  entriesSource?: "paid" | "ticket" | "none";
  /** "paid": closed-system exit fares. "estimated": a free open-system exit, never recorded. Absent: paid. */
  exitsSource?: "paid" | "estimated" | "none";
};

export type PlanInput = {
  direction: "NB" | "SB";
  fromKm: number;
  toKm: number;
  segLengthM: number;
  laneCount: number;
  exits: readonly NlexExit[];
  stations: readonly PlacedFuelStation[];
  /** Plaza flow at this hour, veh/h. Null when the warehouse has no row for the plaza. */
  flowAt: (exitName: string, hour: number) => FlowPair | null;
  /** The busiest hour of each movement, veh/h — what a plaza is built for. */
  peakAt: (exitName: string) => FlowPair | null;
  /** Mainline flow at a km-post and hour, veh/h; null if it cannot be computed. */
  mainlineAt: (km: number, hour: number) => number | null;
  /** When there are no plaza flows at all, an hourly figure from total volume. */
  fallbackHourly: (exitName: string) => number | null;
  hour: number;
  inflow: number;
};

export type FacilityPlan = {
  facilities: FacilitySpec[];
  /** Movements that could not be laid out as places, kept as point ramps so
   *  their traffic still joins and leaves. */
  ramps: RampSpec[];
};

type Candidate = {
  spec: FacilitySpec;
  len: number;
  /** Where it wants to start along travel. */
  want: number;
  /** Higher keeps its place when two collide. */
  priority: number;
  /** Fall-back point ramp if it cannot be laid out. */
  ramp: RampSpec | null;
  /** Laid out just past this facility instead of at `want` (a barrier's own entry joins beyond its booths). */
  follows?: string;
  /** An interchange's exit and entry laid out as one block, exit first along travel; `len` and `want` are the block's. */
  parts?: { c: Candidate; offset: number }[];
};

/* The incident logs name a plaza or interchange by its town, not always the
 * exit list's full name. Everything not listed here is spelt the same. */
const RECORD_ALIASES: Record<string, string[]> = {
  "bocaue interchange": ["Bocaue"],
  "paso de blas valenzuela": ["Valenzuela"],
  "cdv/ph arena": ["CDV"],
  "sta. rita guiguinto": ["Sta. Rita"],
  "tabang guiguinto": ["Tabang"],
  "nlex harbor link": ["Harbor Link"],
};
const recordNamesOf = (exitName: string) => [exitName, ...(RECORD_ALIASES[exitName.toLowerCase().trim()] ?? [])];

const boothsFor = (peakVehPerHour: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.ceil(peakVehPerHour / (PAY_BOOTH_VEH_PER_HOUR * DESIGN_UTILISATION))));

const OSM_CREDIT = "© OpenStreetMap contributors";

/* One movement of one interchange, as OpenStreetMap maps it for one carriageway. */
type Mapped = {
  /** Booth lanes across the plaza roads; null if none of them has a lane count. */
  lanes: number | null;
  /** Where the booth line projects onto the corridor. */
  km: number;
  /** One plaza serves both carriageways (a trumpet's stem). */
  shared: boolean;
  /** A second plaza mapped for the same movement that is not drawn (Bocaue's 8-lane Plaza B). */
  notDrawn: OsmTollPlaza[];
};

const sameExit = (a: string, b: string) => a.toLowerCase().trim() === b.toLowerCase().trim();

function mapped(exitName: string, movement: OsmTollPlaza["movement"], direction: "NB" | "SB"): Mapped | null {
  const all = OSM_TOLL_PLAZAS.filter((p) => sameExit(p.exit, exitName) && p.movement === movement && p.directions.includes(direction));
  if (all.length === 0) return null;
  // A barrier is drawn as its main plaza, the widest; ramp plazas for the same
  // movement are separate roads side by side, so their lanes add up.
  const widest = all.reduce((a, b) => ((b.lanes ?? 0) > (a.lanes ?? 0) ? b : a));
  const use = movement === "barrier" ? [widest] : all;
  const known = use.filter((p) => p.lanes != null);
  const total = known.reduce((sum, p) => sum + (p.lanes as number), 0);
  return {
    lanes: known.length > 0 ? total : null,
    km: total > 0 ? known.reduce((sum, p) => sum + p.km * (p.lanes as number), 0) / total : use.reduce((sum, p) => sum + p.km, 0) / use.length,
    shared: use.some((p) => p.directions.length > 1),
    notDrawn: all.filter((p) => !use.includes(p)),
  };
}

/**
 * Where a movement's traffic joins or leaves the corridor, for counting it: its
 * plaza's booth line where OpenStreetMap maps one, otherwise the interchange.
 * The mainline estimate and the layout both count it here, so a plaza drawn in
 * a stretch always carries its traffic, and the flow entering the stretch
 * never counts the same vehicles twice.
 */
export function movementKm(exitName: string, movement: "exit" | "entry", direction: "NB" | "SB", interchangeKm: number): number {
  return mapped(exitName, movement, direction)?.km ?? interchangeKm;
}

/**
 * Southbound flow on the expressway just past `km`, taken from the Bocaue
 * Barrier's count, or null where the barrier has no count for the hour.
 *
 * Every southbound car leaving the closed system pays at the barrier (its
 * exit fares) and drives on into the open system, so the barrier counts the
 * whole carriageway there. Summing paid figures from the north end instead
 * subtracted those fares as cars leaving, and came out negative at every
 * interchange; the sandbox then fell back to the nearest slip road's volume.
 *
 * South of the barrier (open system): its count, plus its own entries (cars
 * joining at Bocaue pay there), plus entries since, minus exits since (free,
 * so estimated). North of it (closed system): entries (tickets) minus paid
 * exits, summed from the north end, with the tickets scaled so the sum
 * arrives at the barrier with its count. The tickets alone fall short of it,
 * and one factor spreads that shortfall across every entry rather than
 * piling it onto the stretch nearest the barrier.
 */
export function southboundFromBarrier(
  km: number,
  hour: number,
  exits: readonly NlexExit[],
  flowAt: (exitName: string, hour: number) => FlowPair | null,
): number | null {
  const bar = exits.find((e) => e.node_type === "toll-barrier");
  const counted = bar ? flowAt(bar.exit_name, hour) : null;
  if (!bar || !counted || counted.exits <= 0) return null;
  const barKm = movementKm(bar.exit_name, "exit", "SB", bar.km);
  const moves = exits
    .filter((e) => e !== bar)
    .map((e) => {
      const f = flowAt(e.exit_name, hour);
      return {
        inKm: movementKm(e.exit_name, "entry", "SB", e.km),
        outKm: movementKm(e.exit_name, "exit", "SB", e.km),
        entries: f?.entries ?? 0,
        exits: f?.exits ?? 0,
      };
    });
  // A movement at km or north of it has happened by the time traffic is past km.
  if (km <= barKm) {
    let flow = counted.exits + counted.entries;
    for (const m of moves) {
      if (m.inKm >= km && m.inKm < barKm) flow += m.entries;
      if (m.outKm >= km && m.outKm < barKm) flow -= m.exits;
    }
    return Math.max(0, Math.round(flow));
  }
  let tickets = 0;
  let paidOut = 0;
  for (const m of moves) {
    if (m.inKm > barKm) tickets += m.entries;
    if (m.outKm > barKm) paidOut += m.exits;
  }
  const scale = tickets > 0 ? (counted.exits + paidOut) / tickets : 1;
  let flow = 0;
  for (const m of moves) {
    if (m.inKm >= km && m.inKm > barKm) flow += scale * m.entries;
    if (m.outKm >= km && m.outKm > barKm) flow -= m.exits;
  }
  return Math.max(0, Math.round(flow));
}

/** The stretch of road a facility takes, laid out as planFacilities lays it out: its booths (or pumps) at `km`. */
function spanKm(kind: FacilityKind, booths: number, km: number, direction: "NB" | "SB"): { low: number; high: number } {
  const before = boothLineAtM(kind, booths) / 1000;
  const after = footprintM(kind, booths) / 1000 - before;
  return direction === "NB" ? { low: km - before, high: km + after } : { low: km - after, high: km + before };
}

/** This interchange's plazas for a movement that stand off on the road it connects to. */
function plazasAway(exitName: string, movement: "exit" | "entry", direction: "NB" | "SB"): OsmTollPlaza[] {
  return OSM_TOLL_PLAZAS_AWAY.filter((p) => sameExit(p.exit, exitName) && p.movement === movement && p.directions.includes(direction));
}

function awayText(away: OsmTollPlaza[]): string {
  const names = [...new Set(away.map((p) => p.name))].join(" and ");
  const kms = away.map((p) => p.offsetM / 1000);
  const lo = Math.min(...kms);
  const hi = Math.max(...kms);
  const span = hi - lo < 0.05 ? lo.toFixed(1) : `${lo.toFixed(1)}–${hi.toFixed(1)}`;
  const many = new Set(away.map((p) => p.name)).size > 1;
  return `Its toll ${many ? "plazas" : "plaza"} (${names}, OpenStreetMap, ${OSM_CREDIT}) ${many ? "stand" : "stands"} ${span} km off the expressway on the road it connects to, so the junction itself has no booths.`;
}

/** How the booth count was arrived at, in a sentence. */
function boothSource(m: Mapped | null, booths: number, estimated: boolean): string {
  if (m && m.lanes != null) {
    const drawn = booths < m.lanes ? ` (${booths} drawn)` : "";
    const shared = m.shared ? " One plaza serves both carriageways here; it is drawn beside each." : "";
    const extra = m.notDrawn.length > 0
      ? ` A second plaza of ${m.notDrawn.map((p) => p.lanes ?? "?").join(" + ")} lanes is mapped ${Math.round(Math.abs(m.notDrawn[0].km - m.km) * 1000)} m away and not drawn.`
      : "";
    return `${m.lanes} booth lanes, as mapped in OpenStreetMap (${OSM_CREDIT})${drawn}.${shared}${extra}`;
  }
  if (m) return `OpenStreetMap maps a plaza here (${OSM_CREDIT}) but not its lanes; ${booths} booths drawn.`;
  return estimated ? `${booths} booths ESTIMATED from traffic — OpenStreetMap has no plaza mapped here.` : "";
}

export function planFacilities(inp: PlanInput): FacilityPlan {
  const { direction, fromKm, toKm, segLengthM: L, laneCount, hour } = inp;
  if (!(toKm > fromKm) || L <= 0) return { facilities: [], ramps: [] };
  const nb = direction === "NB";
  const along = (km: number) => (nb ? (km - fromKm) * 1000 : (toKm - km) * 1000);
  const inside = (km: number) => km > fromKm + 0.02 && km < toKm - 0.02;
  const cands: Candidate[] = [];

  /* Each movement is counted where its plaza stands (movementKm), as the
   * mainline estimate counts it: what joins or leaves at a plaza outside the
   * stretch is already in, or not yet part of, the flow entering it. So a plaza
   * is in the stretch with its traffic, or not at all. Each is laid out with its
   * booth line (or, without booths, the end of its ramp) at that km. */
  for (const e of inp.exits) {
    const name = displayExitName(String(e.exit_name));
    const barrierNode = e.node_type === "toll-barrier";
    const mBarrier = barrierNode ? mapped(e.exit_name, "barrier", direction) : null;
    const mExit = mapped(e.exit_name, "exit", direction);
    const mEntry = mapped(e.exit_name, "entry", direction);
    const barrierKm = mBarrier?.km ?? e.km;
    const exitKm = mExit?.km ?? e.km;
    const entryKm = mEntry?.km ?? e.km;
    if (![barrierKm, exitKm, entryKm].some(inside)) continue;
    const f = inp.flowAt(e.exit_name, hour);
    const pk = inp.peakAt(e.exit_name);
    const hourly = f ? null : inp.fallbackHourly(e.exit_name);
    let barrierId: string | undefined;

    if (barrierNode) {
      /* A barrier only where one is mapped for this carriageway, or where the
         record shows fares paid on it. At Bocaue both point the same way: the
         southbound side pays (3,872 veh/h in its busiest hour) and has the
         plaza; northbound passes without stopping. */
      const recorded = !!pk && pk.exits > 0 && pk.exitsSource !== "estimated";
      if ((mBarrier || recorded) && inside(barrierKm)) {
        const est = recorded ? boothsFor(pk!.exits, laneCount + 1, MAX_BARRIER_BOOTHS) : laneCount + 2;
        const booths = mBarrier?.lanes != null ? Math.max(laneCount + 1, Math.min(MAX_BARRIER_BOOTHS, mBarrier.lanes)) : est;
        const len = footprintM("barrier", booths);
        const now = recorded ? f?.exits ?? 0 : null;
        barrierId = `barrier:${e.exit_id}:${direction}`;
        cands.push({
          spec: {
            id: barrierId, kind: "barrier", name: `${name} Toll Plaza`,
            x: 0, booths, serviceSec: boothDwellFor(PAY_BOOTH_VEH_PER_HOUR),
            tollMode: "pay", km: Math.round(barrierKm * 100) / 100, interchangeKm: e.km, recordNames: recordNamesOf(e.exit_name),
            basis:
              `${boothSource(mBarrier, booths, !mBarrier)} ` +
              (recorded
                ? `Closed-system fares paid here: ${Math.round(pk!.exits).toLocaleString()} veh/h in the busiest hour, ${Math.round(now ?? 0).toLocaleString()} veh/h now.`
                : `No fares recorded for this carriageway; every vehicle still passes the booths.`),
          },
          len, want: along(barrierKm) - boothLineAtM("barrier", booths), priority: 4, ramp: null,
        });
      }
    }

    // Ramps: the exit list's movements, plus any ramp plaza mapped at a barrier.
    // (A barrier's own "exits" in the record are its fares, not a ramp's.)
    const canLeave = barrierNode ? !!mExit : (nb ? e.nb_exit : e.sb_exit) || !!mExit;
    const canJoin = barrierNode ? !!mEntry : (nb ? e.nb_entry : e.sb_entry) || !!mEntry;

    let exitCand: Candidate | undefined;
    if (canLeave && inside(exitKm)) {
      const offNow = f ? (barrierNode ? 0 : f.exits) : hourly != null ? hourly / 2 : 0;
      const away = mExit ? [] : plazasAway(e.exit_name, "exit", direction);
      const estimated = pk?.exitsSource === "estimated";
      const recordedToll = !barrierNode && !!pk && pk.exits > 0 && !estimated;
      const tolled = !!mExit || (recordedToll && away.length === 0);
      const booths =
        mExit?.lanes != null ? Math.max(1, Math.min(MAX_RAMP_BOOTHS, mExit.lanes))
        : tolled && recordedToll ? boothsFor(pk!.exits, 2, MAX_RAMP_BOOTHS)
        : tolled ? 2 : 0;
      const len = footprintM("exit_ramp", booths);
      // The share of the traffic ARRIVING at the exit: the estimate just before
      // it. Where the record cannot give that (closed-system entries take a
      // ticket and are not in it), the flow entering the stretch.
      const arriving = inp.mainlineAt(nb ? exitKm - 0.001 : exitKm + 0.001, hour);
      const base = arriving != null && arriving > offNow ? arriving : Math.max(inp.inflow, offNow);
      const turn = Math.max(0, Math.min(0.35, offNow / Math.max(1, base)));
      const flow = recordedToll
        ? `${away.length > 0 ? "Exits recorded at its plaza" : "Exit fares recorded here"}: ${Math.round(pk!.exits).toLocaleString()} veh/h in the busiest hour, ${Math.round(offNow).toLocaleString()} veh/h now (${(turn * 100).toFixed(1)}% of the ${Math.round(base).toLocaleString()} veh/h arriving).`
        : offNow > 0
          ? estimated
            ? `Leaving here is free (open system) and so never recorded; ESTIMATED as the round trip — as many leave here in a day as join here heading the other way — at the hours exits happen elsewhere in this direction: ${Math.round(offNow).toLocaleString()} veh/h now (${(turn * 100).toFixed(1)}% of the ${Math.round(base).toLocaleString()} veh/h arriving).`
            : `${Math.round(offNow).toLocaleString()} veh/h leave here now.`
          : `Exits here are not in the record, so no traffic is sent this way.`;
      cands.push({
        spec: {
          id: `exit:${e.exit_id}:${direction}`, kind: "exit_ramp",
          name: tolled ? `${name} Toll Plaza (exit)` : `${name} exit`,
          x: 0, booths, serviceSec: boothDwellFor(PAY_BOOTH_VEH_PER_HOUR), turnFraction: turn,
          tollMode: tolled ? "pay" : null, km: Math.round(exitKm * 100) / 100, interchangeKm: e.km, recordNames: recordNamesOf(e.exit_name),
          basis: tolled ? `${boothSource(mExit, booths, recordedToll)} ${flow}` : `${away.length > 0 ? awayText(away) : "Untolled exit."} ${flow}`,
        },
        len,
        want: along(exitKm) - boothLineAtM("exit_ramp", booths),
        priority: (tolled ? 3 : 1) + (offNow > 0 ? (tolled ? 0.5 : 1) : 0),
        ramp: offNow > 0 ? { x: along(exitKm), onVehPerHour: 0, offFraction: turn, name } : null,
      });
      exitCand = cands[cands.length - 1];
    }
    if (canJoin && inside(entryKm)) {
      const onNow = f ? f.entries : hourly != null ? hourly / 2 : 0;
      const away = mEntry ? [] : plazasAway(e.exit_name, "entry", direction);
      const ticket = pk?.entriesSource === "ticket";
      const counted = !!pk && pk.entries > 0;
      const recordedToll = counted && !ticket;
      // A closed-system entry has ticket booths, so counted tickets mean booths too.
      const tolled = !!mEntry || (counted && away.length === 0);
      const booths =
        mEntry?.lanes != null ? Math.max(1, Math.min(MAX_RAMP_BOOTHS, mEntry.lanes))
        : tolled && counted ? boothsFor(pk!.entries, 2, MAX_RAMP_BOOTHS)
        : tolled ? 2 : 0;
      const len = footprintM("entry_ramp", booths);
      const want = along(entryKm) - boothLineAtM("entry_ramp", booths);
      const flow = recordedToll
        ? `${away.length > 0 ? "Entries recorded at its plaza" : "Entry fares recorded here"}: ${Math.round(pk!.entries).toLocaleString()} veh/h in the busiest hour, ${Math.round(onNow).toLocaleString()} veh/h now.`
        : ticket && counted
          ? `Closed-system tickets taken here — the trips that paid at their exit, counted where they started: ${Math.round(pk!.entries).toLocaleString()} veh/h in the busiest hour, ${Math.round(onNow).toLocaleString()} veh/h now.`
          : onNow > 0
            ? `${Math.round(onNow).toLocaleString()} veh/h join here now.`
            : `Entries here are not in the record, so the plaza is drawn but no traffic is sent this way.`;
      cands.push({
        spec: {
          id: `entry:${e.exit_id}:${direction}`, kind: "entry_ramp",
          name: tolled ? `${name} Toll Plaza (entry)` : `${name} entry`,
          x: 0, booths, serviceSec: boothDwellFor(PAY_BOOTH_VEH_PER_HOUR),
          arrivalsVehPerHour: Math.round(onNow), tollMode: tolled ? "pay" : null,
          km: Math.round(entryKm * 100) / 100, interchangeKm: e.km, recordNames: recordNamesOf(e.exit_name),
          basis: tolled ? `${boothSource(mEntry, booths, counted)} ${flow}` : `${away.length > 0 ? awayText(away) : "Untolled entry."} ${flow}`,
        },
        len,
        want,
        priority: (tolled ? 3 : 1) + (onNow > 0 ? (tolled ? 0.5 : 1) : 0),
        ramp: onNow > 0 ? { x: along(entryKm), onVehPerHour: Math.round(onNow), offFraction: 0, name } : null,
        // A barrier's own entry: its booths stand beside the barrier's, and it is laid out just past them.
        follows: barrierId,
      });
      const entryCand = cands[cands.length - 1];
      /* An interchange's exit and entry stand side by side on the real road;
         on this one they go one behind the other, exit first. Laid out apart,
         the toll plaza took the room and a busy free exit beside it — 773
         veh/h leaving Meycauayan northbound — had its traffic vanish off the
         road at a point. Laid out as one block, the more important of the two
         keeps its place and the other goes right beside it. */
      if (!barrierId && exitCand && want < exitCand.want + exitCand.len + GAP_M && exitCand.want < want + len + GAP_M) {
        const anchorEntry = entryCand.priority > exitCand.priority;
        cands.splice(cands.indexOf(exitCand), 1);
        cands.splice(cands.indexOf(entryCand), 1);
        cands.push({
          spec: exitCand.spec,
          len: exitCand.len + GAP_M + entryCand.len,
          want: anchorEntry ? entryCand.want - GAP_M - exitCand.len : exitCand.want,
          priority: Math.max(exitCand.priority, entryCand.priority),
          ramp: null,
          parts: [{ c: exitCand, offset: 0 }, { c: entryCand, offset: exitCand.len + GAP_M }],
        });
      }
    }
  }

  for (const st of inp.stations) {
    if (st.direction !== direction || !inside(st.km)) continue;
    const len = footprintM("service_area", SERVICE_PUMPS);
    // The pumps, not the slip road, sit at the station's km-post.
    const pumpsAt = SERVICE_PUMPS_AT_M;
    cands.push({
      spec: {
        id: `sa:${st.id}`, kind: "service_area", name: st.name,
        x: 0, booths: SERVICE_PUMPS, serviceSec: SERVICE_DWELL_S, turnFraction: SERVICE_STOP_SHARE,
        km: st.km, tollMode: null, recordNames: [st.recordName],
        basis: `${st.brand} service area, ${st.town} (signed Km ${st.officialKm}). ASSUMED: ${(SERVICE_STOP_SHARE * 100).toFixed(0)}% of passing traffic stops, ${Math.round(SERVICE_DWELL_S / 60 * 10) / 10} min at the pump — the record has no service-area visits.`,
      },
      len, want: along(st.km) - pumpsAt, priority: 2, ramp: null,
    });
  }

  /* Lay them out along the stretch, most important first, each as close to
   * where it really is as the others and the ends of the stretch allow. */
  const placed: { a: number; b: number }[] = [];
  const placedById = new Map<string, { a: number; b: number }>();
  const free = (a: number, b: number) => placed.every((p) => b + GAP_M <= p.a || a >= p.b + GAP_M);
  /* Where a facility may start. Laid out where they really are, plazas are
     cropped by the window rather than squeezed inside it: squeezed, a 0.6 km
     view of Meycauayan slid its southbound entry plaza 210 m north, to the
     wrong side of the interchange. What has to be on screen is the part that
     matters — the booths (or pumps); an exit's turn-off as well, since a
     driver bound for it is chosen as they come onto the stretch; a barrier
     whole. An entry's approach road and acceleration lane, and the road away
     from an exit, may run past either end. */
  const rangeOf = (kind: FacilityKind, booths: number, len: number): [number, number] => {
    const line = boothLineAtM(kind, booths);
    if (kind === "barrier") return [MARGIN_START_M, L - MARGIN_END_M - len];
    if (kind === "entry_ramp") return [MARGIN_START_M - line, L - MARGIN_END_M - line];
    return [MARGIN_START_M, L - MARGIN_END_M - line];
  };
  const facilities: FacilitySpec[] = [];
  const ramps: RampSpec[] = [];
  const order = [...cands].sort((p, q) => q.priority - p.priority || p.want - q.want);
  // Never drawn further from where it is than a slide allows: past that it is
  // somewhere else, and a plain ramp at the right place says more.
  const tryPlace = (len: number, want: number, [lo, hi]: [number, number]): number | null => {
    if (lo > hi) return null;
    for (let slide = 0; slide <= MAX_SLIDE_M; slide += 5) {
      for (const sgn of slide === 0 ? [0] : [1, -1]) {
        const a = Math.max(lo, Math.min(hi, want + sgn * slide));
        if (Math.abs(a - want) <= MAX_SLIDE_M && free(a, a + len)) return a;
      }
    }
    return null;
  };
  const rangeOfCand = (c: Candidate): [number, number] => {
    if (!c.parts) return rangeOf(c.spec.kind, c.spec.booths, c.len);
    // A pair: the first part's turn-off on screen, and the second part's booths.
    const [first, second] = c.parts;
    const r1 = rangeOf(first.c.spec.kind, first.c.spec.booths, first.c.len);
    const r2 = rangeOf(second.c.spec.kind, second.c.spec.booths, second.c.len);
    return [Math.max(r1[0], r2[0] - second.offset), Math.min(r1[1], r2[1] - second.offset)];
  };
  const commit = (c: Candidate, at: number, beside?: string) => {
    placed.push({ a: at, b: at + c.len });
    placedById.set(c.spec.id, { a: at, b: at + c.len });
    /* Labelled with the km it is DRAWN at, so it agrees with the km posts above
       it; where that is not where it really stands, the basis says so. */
    const drawnAt = at + boothLineAtM(c.spec.kind, c.spec.booths);
    const drawnKm = nb ? fromKm + drawnAt / 1000 : toKm - drawnAt / 1000;
    const realKm = c.spec.km ?? drawnKm;
    const off = drawnAt - along(realKm);
    let basis = c.spec.basis ?? "";
    if (Math.abs(off) > 25) {
      const where = c.spec.booths > 0 || c.spec.kind === "service_area"
        ? `Its ${c.spec.kind === "service_area" ? "pumps" : "booths"} stand at Km ${realKm.toFixed(2)}`
        : `Its ramp is at Km ${realKm.toFixed(2)}`;
      const how = `${Math.round(Math.abs(off))} m ${off > 0 ? "further on" : "back"}`;
      basis += beside
        ? ` ${where}, beside the ${beside}; it is drawn ${how}, ${off > 0 ? "past" : "before"} it.`
        : ` ${where}; it is drawn ${how} to fit beside the others.`;
    }
    facilities.push({ ...c.spec, x: at, km: Math.round(drawnKm * 100) / 100, basis });
  };
  for (const c of order) {
    if (c.parts) {
      const at = tryPlace(c.len, c.want, rangeOfCand(c));
      if (at != null) {
        for (const part of c.parts) commit(part.c, at + part.offset, c.parts.find((q) => q !== part)!.c.spec.name);
        continue;
      }
      // No room for both together: each on its own, the more important first.
      for (const part of [...c.parts].sort((x, y) => y.c.priority - x.c.priority)) {
        const a = tryPlace(part.c.len, part.c.want, rangeOfCand(part.c));
        if (a != null) commit(part.c, a);
        else if (part.c.ramp) ramps.push(part.c.ramp);
      }
      continue;
    }
    const lead = c.follows ? placedById.get(c.follows) : undefined;
    const at = tryPlace(c.len, lead ? lead.b + GAP_M : c.want, rangeOfCand(c));
    if (at == null) {
      // Traffic still joins or leaves; past a barrier's booths if it belongs to one.
      if (c.ramp) ramps.push(lead ? { ...c.ramp, x: Math.min(L - MARGIN_END_M, lead.b + GAP_M) } : c.ramp);
      continue;
    }
    commit(c, at, lead ? cands.find((q) => q.spec.id === c.follows)?.spec.name : undefined);
  }
  facilities.sort((p, q) => p.x - q.x);
  return { facilities, ramps };
}

/** Where to look to see a facility whole: a km window around it, `km` being where its booths (or pumps) stand. */
export function frameFor(km: number, kind: FacilityKind, booths: number, direction: "NB" | "SB"): { fromKm: number; toKm: number } {
  const { low, high } = spanKm(kind, booths, km, direction);
  return frameSpan(low, high, direction);
}

/* Room around what is framed: more on the side traffic comes from, where the
 * layout keeps clear of the entrance (MARGIN_START_M). */
const FRAME_PAD_KM = 0.12;
const FRAME_LEAD_KM = 0.06;
function frameSpan(low: number, high: number, direction: "NB" | "SB"): { fromKm: number; toKm: number } {
  const lo = direction === "NB" ? low - FRAME_PAD_KM - FRAME_LEAD_KM : low - FRAME_PAD_KM;
  const hi = direction === "NB" ? high + FRAME_PAD_KM : high + FRAME_PAD_KM + FRAME_LEAD_KM;
  return { fromKm: Math.floor(lo * 100) / 100, toKm: Math.ceil(hi * 100) / 100 };
}

/* Plazas laid out closer than this (the layout's own gap, and a little) collide,
 * so they are framed together; the rest are kept out of each other's windows. */
const FRAME_JOIN_KM = GAP_M / 1000 + 0.015;
/* ...unless that makes a window longer than this, when cars become specks. */
const FRAME_MAX_KM = 2.2;

export type CorridorPlace = {
  id: string;
  name: string;
  kind: FacilityKind;
  /** Where its booths (or pumps) stand. */
  km: number;
  booths: number;
  /** The window that shows it whole, and any plaza beside it, where the layout really puts them. */
  frame: { fromKm: number; toKm: number };
};

/**
 * Every toll plaza, barrier and service area on one carriageway, corridor-wide:
 * what an operator can jump to. A plaza is listed where OpenStreetMap maps one
 * (with its lanes) or where the record shows tolled traffic paid at the
 * junction (booths estimated), at the km its booths stand, sized as the layout
 * sizes it — so the window framed for it fits it and its neighbours.
 */
export function corridorPlaces(
  direction: "NB" | "SB",
  exits: readonly NlexExit[],
  stations: readonly PlacedFuelStation[],
  peakAt: (exitName: string) => FlowPair | null,
  laneCount: number,
): CorridorPlace[] {
  const nb = direction === "NB";
  // `hidden`: not a place to jump to (a free exit), but it takes room a window has to hold.
  type Raw = Omit<CorridorPlace, "frame"> & { low: number; high: number; hidden?: boolean };
  const out: Raw[] = [];
  const add = (p: Omit<Raw, "low" | "high">, span = spanKm(p.kind, p.booths, p.km, direction)) => out.push({ ...p, ...span });
  for (const e of exits) {
    const name = displayExitName(String(e.exit_name));
    const pk = peakAt(e.exit_name);
    const barrierNode = e.node_type === "toll-barrier";
    let barrier: Raw | null = null;
    if (barrierNode) {
      const m = mapped(e.exit_name, "barrier", direction);
      const recorded = !!pk && pk.exits > 0;
      if (m || recorded) {
        const booths = m?.lanes != null ? Math.max(laneCount + 1, Math.min(MAX_BARRIER_BOOTHS, m.lanes)) : recorded ? boothsFor(pk!.exits, laneCount + 1, MAX_BARRIER_BOOTHS) : laneCount + 2;
        add({ id: `barrier:${e.exit_id}:${direction}`, name: `${name} Toll Plaza`, kind: "barrier", km: m?.km ?? e.km, booths });
        barrier = out[out.length - 1];
      }
    }
    const mExit = mapped(e.exit_name, "exit", direction);
    const mEntry = mapped(e.exit_name, "entry", direction);
    // An interchange whose plaza stands up the road it connects to has none on NLEX to jump to.
    const exitToll = !barrierNode && (nb ? e.nb_exit : e.sb_exit) && !!pk && pk.exits > 0 && pk.exitsSource !== "estimated" && plazasAway(e.exit_name, "exit", direction).length === 0;
    const entryToll = (barrierNode ? !!mEntry : nb ? e.nb_entry : e.sb_entry) && !!pk && pk.entries > 0 && plazasAway(e.exit_name, "entry", direction).length === 0;
    // Its exit: a toll plaza to jump to, or a free exit with traffic that only takes room.
    let exitPlace: Raw | null = null;
    let exitRank = 0;
    if (mExit || exitToll) {
      const booths = mExit?.lanes != null ? Math.max(1, Math.min(MAX_RAMP_BOOTHS, mExit.lanes)) : exitToll ? boothsFor(pk!.exits, 2, MAX_RAMP_BOOTHS) : 2;
      add({ id: `exit:${e.exit_id}:${direction}`, name: `${name} Toll Plaza (exit)`, kind: "exit_ramp", km: mExit?.km ?? e.km, booths });
      exitPlace = out[out.length - 1];
      exitRank = 3 + (pk && pk.exits > 0 ? 0.5 : 0);
    } else if (!barrierNode && (nb ? e.nb_exit : e.sb_exit) && !!pk && pk.exits > 0) {
      add({ id: `exit:${e.exit_id}:${direction}`, name: `${name} exit`, kind: "exit_ramp", km: e.km, booths: 0, hidden: true });
      exitPlace = out[out.length - 1];
      exitRank = 2;
    }
    if (mEntry || entryToll) {
      const booths = mEntry?.lanes != null ? Math.max(1, Math.min(MAX_RAMP_BOOTHS, mEntry.lanes)) : entryToll ? boothsFor(pk!.entries, 2, MAX_RAMP_BOOTHS) : 2;
      const km = mEntry?.km ?? e.km;
      const lenKm = footprintM("entry_ramp", booths) / 1000;
      const gap = GAP_M / 1000;
      const own = spanKm("entry_ramp", booths, km, direction);
      // Travel order: northbound runs up the km, southbound down them.
      const after = (lead: { low: number; high: number }, len: number) =>
        nb ? { low: lead.high + gap, high: lead.high + gap + len } : { low: lead.low - gap - len, high: lead.low - gap };
      const before = (next: { low: number; high: number }, len: number) =>
        nb ? { low: next.low - gap - len, high: next.low - gap } : { low: next.high + gap, high: next.high + gap + len };
      let span = own;
      if (barrier) {
        // A barrier's own entry is laid out joining just past the barrier.
        span = after(barrier, lenKm);
      } else if (exitPlace && own.low < exitPlace.high + gap && exitPlace.low < own.high + gap) {
        // Beside its exit, laid out as planFacilities lays the pair out: the more important keeps its place.
        const entryRank = 3 + (pk && pk.entries > 0 ? 0.5 : 0);
        if (entryRank > exitRank) Object.assign(exitPlace, before(own, exitPlace.high - exitPlace.low));
        else span = after(exitPlace, lenKm);
      }
      add({ id: `entry:${e.exit_id}:${direction}`, name: `${name} Toll Plaza (entry)`, kind: "entry_ramp", km, booths }, span);
    }
  }
  for (const st of stations) {
    if (st.direction !== direction) continue;
    add({ id: `sa:${st.id}`, name: st.name, kind: "service_area", km: st.km, booths: SERVICE_PUMPS });
  }

  // Only what the corridor can draw: the stretch starts at its first km-post and ends at its last.
  const kms = exits.map((e) => e.km);
  const lo = Math.min(...kms) + 0.02;
  const hi = Math.max(...kms) - 0.02;
  const listed = out.filter((p) => p.km > lo && p.km < hi).sort((a, b) => a.low - b.low);

  /* Each framed with the plazas it collides with, and the window trimmed so the
   * next plazas' booths fall just outside it: a plaza is drawn when its booths
   * are in view (planFacilities), and one caught at the edge would be pulled in
   * and pushed into the place of the one being looked at. The trim stops short
   * of the room the layout keeps clear at each end. */
  const groups: Raw[][] = [];
  for (const p of listed) {
    const g = groups[groups.length - 1];
    if (g && p.low <= Math.max(...g.map((q) => q.high)) + FRAME_JOIN_KM) g.push(p);
    else groups.push([p]);
  }
  const lowRoom = (nb ? MARGIN_START_M : MARGIN_END_M) / 1000 + 0.01;
  const highRoom = (nb ? MARGIN_END_M : MARGIN_START_M) / 1000 + 0.01;
  const placed: CorridorPlace[] = [];
  for (const g of groups) {
    for (const p of g) {
      if (p.hidden) continue;
      const together = Math.max(...g.map((q) => q.high)) - Math.min(...g.map((q) => q.low)) <= FRAME_MAX_KM;
      const mine = together ? g : [p];
      const gLow = Math.min(...mine.map((q) => q.low));
      const gHigh = Math.max(...mine.map((q) => q.high));
      let { fromKm, toKm } = frameSpan(gLow, gHigh, direction);
      for (const q of out) {
        if (mine.includes(q)) continue;
        // In view when its km is more than 0.02 inside an end (planFacilities' `inside`).
        if (q.km <= gLow && q.km > fromKm + 0.02) fromKm = Math.min(gLow - lowRoom, q.km - 0.015);
        if (q.km >= gHigh && q.km < toKm - 0.02) toKm = Math.max(gHigh + highRoom, q.km + 0.015);
      }
      placed.push({
        id: p.id, name: p.name, kind: p.kind, km: p.km, booths: p.booths,
        frame: {
          fromKm: Math.round(Math.max(lo - 0.02, fromKm) * 1000) / 1000,
          toKm: Math.round(Math.min(hi + 0.02, toKm) * 1000) / 1000,
        },
      });
    }
  }
  return placed.sort((a, b) => a.km - b.km);
}
