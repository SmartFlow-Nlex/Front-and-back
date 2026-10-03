"use client";

import { useEffect, useMemo, useRef } from "react";
import type { FacilityKind } from "../facilities";
import { displayExitName, type NlexExit } from "../../../../lib/nlex-exits";

type Place = { id: string; name: string; kind: FacilityKind; km: number };
type Junction = Pick<NlexExit, "exit_id" | "exit_name" | "km">;
type Span = { fromKm: number; toKm: number };

const KIND_LABEL: Record<FacilityKind, string> = {
  entry_ramp: "Entry",
  exit_ramp: "Exit",
  service_area: "Fuel",
  barrier: "Barrier",
};

const KIND_ORDER: Record<FacilityKind, number> = { barrier: 0, exit_ramp: 1, entry_ramp: 2, service_area: 3 };

/** "exit:4:NB" -> 4: a plaza's id names the junction it stands at (facilityLayout.corridorPlaces). */
const junctionOf = (id: string) => {
  const m = /^(?:exit|entry|barrier):(\d+):/.exec(id);
  return m ? Number(m[1]) : null;
};

/**
 * The road as one list, in km order: every junction with its toll plazas on
 * the same row, and the service areas between them.
 *
 * This used to be two lists, "Exits on route" (junction names) and "Toll
 * plazas & service areas" (the plazas AT those junctions), so Meycauayan
 * appeared in both and the difference was invisible. A junction is the place;
 * Entry / Exit / Barrier are the plazas there.
 *
 * Only the chosen route is listed: its junctions, origin to destination, and
 * the plazas and service areas the road between them actually draws. The
 * route is the operator's choice, so nothing here changes it.
 *
 * Clicking a junction frames it, and a second junction spans the road between
 * the two. A plaza or service area frames that facility.
 */
export default function PlacesList<J extends Junction, P extends Place>({
  junctions,
  places,
  placesInView,
  view,
  route,
  anchorKm,
  directionName,
  onJunction,
  onPlace,
}: {
  junctions: readonly J[];
  places: readonly P[];
  /** Facility ids drawn in the current window. */
  placesInView: ReadonlySet<string>;
  /** The drawn window. */
  view: Span;
  /** The chosen origin -> destination: all that is listed. */
  route: Span;
  /** The first junction of a span being picked, if any. */
  anchorKm: number | null;
  directionName: string;
  onJunction: (junction: J) => void;
  onPlace: (place: P) => void;
}) {
  const rows = useMemo(() => {
    // A facility is drawn only when it stands more than 0.02 km inside the
    // window (planFacilities), so one at the very origin or destination never
    // is: offering it would frame an empty road.
    const drawn = (km: number) => km > route.fromKm + 0.02 && km < route.toKm - 0.02;
    const onRoute = junctions.filter((j) => j.km >= route.fromKm - 1e-6 && j.km <= route.toKm + 1e-6);
    const plazas = new Map<number, P[]>();
    const stops: P[] = [];
    for (const p of places) {
      if (!drawn(p.km)) continue;
      if (p.kind === "service_area") { stops.push(p); continue; }
      const id = junctionOf(p.id);
      if (id == null) continue;
      plazas.set(id, [...(plazas.get(id) ?? []), p]);
    }
    // One order on every row, whichever plaza's booths stand a few metres first.
    for (const list of plazas.values()) list.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    return [
      ...onRoute.map((j) => ({ key: `j:${j.exit_id}`, km: j.km, junction: j, items: plazas.get(j.exit_id) ?? [] })),
      ...stops.map((p) => ({ key: p.id, km: p.km, junction: null, items: [p] })),
    ].sort((a, b) => a.km - b.km || (a.junction ? -1 : 1));
  }, [junctions, places, route.fromKm, route.toKm]);

  const within = (km: number, s: Span) => km >= s.fromKm - 1e-6 && km <= s.toKm + 1e-6;

  // Open on the stretch being looked at, not on Balintawak thirty rows above it.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(".sb-place.is-on");
    if (list && row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - 48;
  }, []);

  return (
    <>
      <p className="sb-places-key">
        <span>
          Toll plaza
          <span className="sb-place-kind k-entry_ramp">Entry</span>
          <span className="sb-place-kind k-exit_ramp">Exit</span>
          <span className="sb-place-kind k-barrier">Barrier</span>
        </span>
        <span>
          Service area
          <span className="sb-place-kind k-service_area">Fuel</span>
        </span>
      </p>
      <div ref={listRef} className="sb-places" role="list" aria-label={`Junctions and service areas, ${directionName}`}>
        {rows.map((r) => {
          const j = r.junction;
          const name = j ? displayExitName(j.exit_name) : r.items[0].name;
          const onScreen = (j != null && within(j.km, view)) || r.items.some((p) => placesInView.has(p.id));
          const anchored = j != null && anchorKm === j.km;
          const nameTitle = !j
            ? `Frame the window on ${name} (Km ${r.km.toFixed(2)}, ${directionName})`
            : anchorKm == null
              ? `Frame the window on ${name} (Km ${j.km}). Then click a second junction to show the road between them.`
              : anchored
                ? "Click again to cancel"
                : `Show the road from Km ${anchorKm} to Km ${j.km}`;
          return (
            <div
              key={r.key}
              role="listitem"
              className={`sb-place${j ? "" : " is-stop"}${onScreen ? " is-on" : ""}${anchored ? " is-anchor" : ""}`}
            >
              <span className="sb-place-km">{r.km.toFixed(1)}</span>
              <button
                type="button"
                className="sb-place-name"
                onClick={() => (j ? onJunction(j) : onPlace(r.items[0]))}
                title={nameTitle}
              >
                {name}
              </button>
              <span className="sb-place-kinds">
                {r.items.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    data-place={p.id}
                    className={`sb-place-kind k-${p.kind}${placesInView.has(p.id) ? " is-on" : ""}`}
                    onClick={() => onPlace(p)}
                    title={`Frame the window on ${p.name} (Km ${p.km.toFixed(2)}, ${directionName})`}
                  >
                    {KIND_LABEL[p.kind]}
                  </button>
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
