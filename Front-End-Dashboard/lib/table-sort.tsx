"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * Click-to-sort for the operational tables.
 *
 * The audit log and the maintenance list are both "find the one row I care
 * about" tables, and until now the only ordering was whatever the API returned.
 * Search narrows; sorting is what answers "which is oldest", "who acted most
 * recently", "what is closest to Km 0".
 *
 * Sorting is applied after filtering, over the rows already in the browser, so
 * it costs one comparison pass and needs no round trip.
 */

export type SortDir = "asc" | "desc";

/** Values a column can sort on. Nullish sorts last regardless of direction. */
export type SortValue = string | number | Date | null | undefined;

export type SortState<K extends string> = { key: K; dir: SortDir } | null;

function compare(a: SortValue, b: SortValue): number {
  // Missing data belongs at the bottom either way round — a column of blanks at
  // the top is never what someone wanted when they clicked a header.
  const aEmpty = a == null || a === "";
  const bEmpty = b == null || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  if (a instanceof Date || b instanceof Date) {
    return Number(a instanceof Date ? a : new Date(String(a))) -
      Number(b instanceof Date ? b : new Date(String(b)));
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  // Numeric-aware so "Km 9" precedes "Km 10" and "#002" precedes "#010".
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}

/**
 * @param rows      already-filtered rows
 * @param accessors value to sort by, per column key
 * @param initial   starting sort, or null for the API's own order
 */
export function useTableSort<T, K extends string>(
  rows: T[],
  accessors: Record<K, (row: T) => SortValue>,
  // NoInfer so the column union comes from `accessors` alone. Without it a single
  // initial key like { key: "window" } narrows K to just that one, and every
  // other column is then rejected as an invalid key.
  initial: SortState<NoInfer<K>> = null,
) {
  const [sort, setSort] = useState<SortState<K>>(initial);

  /** First click sorts ascending, second flips, third clears back to API order. */
  const toggle = useCallback((key: K) => {
    setSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: "asc" };
      if (cur.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }, []);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const get = accessors[sort.key];
    if (!get) return rows;
    const factor = sort.dir === "asc" ? 1 : -1;
    // Copy first: sorting the caller's array in place would mutate state.
    return [...rows].sort((a, b) => {
      const c = compare(get(a), get(b));
      // The empty-last rule must survive the direction flip, so a tie on
      // emptiness is not re-inverted.
      if (c === 0) return 0;
      const aEmpty = get(a) == null || get(a) === "";
      const bEmpty = get(b) == null || get(b) === "";
      if (aEmpty !== bEmpty) return c;
      return c * factor;
    });
  }, [rows, sort, accessors]);

  return { sorted, sort, toggle };
}

/** A `<th>` that sorts its column, with the state announced to screen readers. */
export function SortableTh<K extends string>({
  label,
  sortKey,
  sort,
  onToggle,
  align,
}: {
  label: string;
  sortKey: K;
  sort: SortState<K>;
  onToggle: (key: K) => void;
  align?: "left" | "right" | "center";
}) {
  const active = sort?.key === sortKey;
  const dir = active ? sort.dir : null;
  return (
    <th
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
      style={align ? { textAlign: align } : undefined}
    >
      <button
        type="button"
        className={`ds-th-sort${active ? " active" : ""}`}
        onClick={() => onToggle(sortKey)}
        title={
          active
            ? dir === "asc"
              ? `Sorted by ${label}, ascending — click for descending`
              : `Sorted by ${label}, descending — click to clear`
            : `Sort by ${label}`
        }
      >
        <span>{label}</span>
        <span className="ds-th-arrow" aria-hidden="true">
          {dir === "asc" ? "▲" : dir === "desc" ? "▼" : "⇅"}
        </span>
      </button>
    </th>
  );
}
