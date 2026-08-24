/**
 * Philippine holiday calendar.
 *
 * Two sources, in priority order:
 *
 *  1. `date-holidays` — encodes the standing rules from the Administrative Code
 *     as amended by RA 9492: fixed dates, the Easter-derived days (Maundy
 *     Thursday, Good Friday, Black Saturday) and National Heroes Day on the
 *     last Monday of August. Verified correct for 2020-2026.
 *
 *  2. PROCLAIMED_OVERRIDES — the dates Malacanang actually proclaimed, which
 *     win over the library. This exists because Eid'l Fitr and Eid'l Adha are
 *     set in the Philippines by moon sighting rather than calculation, so the
 *     library's astronomical date is often one day early. Measured against the
 *     official proclamations, 4 of 14 Islamic dates in 2020-2026 were wrong.
 *
 * The library also reports observances that are NOT non-working holidays
 * (Lantern Festival, Lapu-Lapu Day, Iglesia ni Cristo Day, ...) and marks
 * Easter Sunday as `public` even though it is not a Philippine holiday. Both
 * are filtered out below.
 *
 * ── Adding a year-specific proclamation ─────────────────────────────────
 * Each year the President also declares extra special non-working days (an
 * election day, a "holiday economics" bridge day, a local fiesta). Those are
 * NOT in the library. Add them to PROCLAIMED_OVERRIDES with the proclamation
 * number in the note, then re-run `npm run seed-holidays`.
 * Source: https://www.officialgazette.gov.ph/
 */
import Holidays from "date-holidays";

export type HolidayType = "Regular" | "Special";

export interface PhHoliday {
  /** YYYY-MM-DD */
  date: string;
  name: string;
  type: HolidayType;
  /** Where the date came from, so the table stays auditable. */
  source: "date-holidays" | "proclamation" | "observed-moved";
  note?: string;
}

/**
 * "Holiday economics" — RA 9492 lets the President move most holidays to the
 * nearest Monday or Friday to create a long weekend. The library only knows the
 * nominal date, but the moved date is the one that actually empties Metro
 * Manila and floods NLEX, so it is the one that matters here.
 *
 * Rather than hardcode every proclamation, reconcileWithObserved() takes the
 * dates the toll operator actually recorded as non-working and re-dates the
 * matching holiday onto them. Confirmed cases in this dataset:
 *   2023-02-24 (EDSA, from Sat 02-25)   2023-04-10 (Araw ng Kagitingan, from Sun)
 *   2023-11-27 (Bonifacio, from Thu 30) 2024-08-23 (Ninoy Aquino, from Wed 21)
 */
const MOVE_WINDOW_DAYS = 4;

function daysApart(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000);
}

/**
 * Dates as actually proclaimed. Anything listed here replaces the library's
 * entry for the same date OR the same holiday name in that year.
 */
const PROCLAIMED_OVERRIDES: PhHoliday[] = [
  // ── Eid'l Fitr (Wakas ng Ramadan) — Regular holiday, RA 9849 ──
  { date: "2020-05-25", name: "Eid'l Fitr", type: "Regular", source: "proclamation", note: "Proc. 944 s.2020" },
  { date: "2021-05-13", name: "Eid'l Fitr", type: "Regular", source: "proclamation", note: "Proc. 1142 s.2021" },
  { date: "2022-05-03", name: "Eid'l Fitr", type: "Regular", source: "proclamation", note: "Proc. 1369 s.2022" },
  { date: "2023-04-21", name: "Eid'l Fitr", type: "Regular", source: "proclamation", note: "Proc. 201 s.2023" },
  { date: "2024-04-10", name: "Eid'l Fitr", type: "Regular", source: "proclamation", note: "Proc. 555 s.2024" },
  { date: "2025-03-31", name: "Eid'l Fitr", type: "Regular", source: "proclamation", note: "Proc. 838 s.2025" },
  { date: "2026-03-20", name: "Eid'l Fitr", type: "Regular", source: "proclamation", note: "provisional — confirm on proclamation" },

  // ── Eid'l Adha (Feast of Sacrifice) — Regular holiday, RA 9849 ──
  { date: "2020-07-31", name: "Eid'l Adha", type: "Regular", source: "proclamation", note: "Proc. 985 s.2020" },
  { date: "2021-07-20", name: "Eid'l Adha", type: "Regular", source: "proclamation", note: "Proc. 1190 s.2021" },
  { date: "2022-07-09", name: "Eid'l Adha", type: "Regular", source: "proclamation", note: "Proc. 1421 s.2022" },
  { date: "2023-06-28", name: "Eid'l Adha", type: "Regular", source: "proclamation", note: "Proc. 244 s.2023" },
  { date: "2024-06-17", name: "Eid'l Adha", type: "Regular", source: "proclamation", note: "Proc. 610 s.2024" },
  { date: "2025-06-06", name: "Eid'l Adha", type: "Regular", source: "proclamation", note: "Proc. 874 s.2025" },
  { date: "2026-05-27", name: "Eid'l Adha", type: "Regular", source: "proclamation", note: "provisional — confirm on proclamation" },

  // ── EDSA People Power Anniversary ──
  // The library stops treating this as a non-working day after 2023, but the
  // toll operator's own records show 25 February was non-working in 2025 and
  // 2026. Added on that evidence; confirm the proclamation number before citing.
  { date: "2025-02-25", name: "EDSA People Power Anniversary", type: "Special", source: "proclamation", note: "observed non-working in source data — confirm proclamation" },
  { date: "2026-02-25", name: "EDSA People Power Anniversary", type: "Special", source: "proclamation", note: "observed non-working in source data — confirm proclamation" },
];

/** Library entries that are not Philippine non-working holidays. */
const EXCLUDED_NAMES = new Set(["Easter Sunday"]);

/** Library names -> the names Filipinos and the Official Gazette actually use. */
const NAME_MAP: Record<string, string> = {
  "Day of Valor": "Araw ng Kagitingan",
  "Labour Day": "Labor Day",
  "National Heroes' Day": "National Heroes Day",
  "Easter Saturday": "Black Saturday",
  "End of Ramadan (Eid al-Fitr)": "Eid'l Fitr",
  "Feast of the Sacrifice (Eid al-Adha)": "Eid'l Adha",
  "Feast of the Immaculate Conception of the Blessed Virgin Mary": "Immaculate Conception",
  "All Saints' Day": "All Saints' Day",
  "EDSA Revolution Anniversary": "EDSA People Power Anniversary",
};

/**
 * Build the calendar for an inclusive range of years.
 * Later entries never silently overwrite earlier ones — proclamations are
 * applied last and deliberately replace the computed date.
 */
export function buildPhHolidays(fromYear: number, toYear: number): PhHoliday[] {
  const hd = new Holidays("PH");
  const byDate = new Map<string, PhHoliday>();

  for (let year = fromYear; year <= toYear; year++) {
    for (const raw of hd.getHolidays(year)) {
      // `observance` entries are commemorations, not non-working days.
      if (raw.type !== "public" && raw.type !== "optional") continue;

      const name = NAME_MAP[raw.name] ?? raw.name;
      if (EXCLUDED_NAMES.has(raw.name) || EXCLUDED_NAMES.has(name)) continue;

      const date = raw.date.slice(0, 10);
      const type: HolidayType = raw.type === "public" ? "Regular" : "Special";

      // Two holidays can land on the same day — 9 April 2020 was both Araw ng
      // Kagitingan and Maundy Thursday. Keep both names rather than letting one
      // silently overwrite the other, and let Regular win the type, since a
      // Regular holiday carries the higher pay rules.
      const existing = byDate.get(date);
      if (existing) {
        if (existing.name !== name) {
          const names = existing.name.split(" / ");
          if (!names.includes(name)) existing.name = [...names, name].join(" / ");
        }
        if (type === "Regular") existing.type = "Regular";
        continue;
      }

      byDate.set(date, { date, name, type, source: "date-holidays" });
    }
  }

  // Proclamations win. Drop the library's computed date for the same holiday
  // in that year first, otherwise Eid would appear twice a day apart.
  for (const o of PROCLAIMED_OVERRIDES) {
    const year = o.date.slice(0, 4);
    for (const [date, h] of byDate) {
      if (h.name === o.name && date.startsWith(year) && date !== o.date) {
        byDate.delete(date);
      }
    }
    byDate.set(o.date, o);
  }

  return [...byDate.values()]
    .filter((h) => {
      const y = Number(h.date.slice(0, 4));
      return y >= fromYear && y <= toYear;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface ReconcileReport {
  holidays: PhHoliday[];
  moved: { from: string; to: string; name: string }[];
  /** Observed non-working days with no holiday within the move window. */
  unexplained: string[];
  /** Calendar entries never observed as non-working (and not explained by a move). */
  notObserved: { date: string; name: string }[];
}

/**
 * Re-date the rule-based calendar onto the days actually observed as
 * non-working, so "holiday economics" moves are reflected.
 *
 * `observed` is the set of dates the source data recorded as non-working. Only
 * dates inside its own range are judged — a calendar entry outside the observed
 * window is kept untouched rather than assumed absent.
 */
export function reconcileWithObserved(
  calendar: PhHoliday[],
  observed: string[]
): ReconcileReport {
  const observedSet = new Set(observed);
  if (observedSet.size === 0) {
    return { holidays: calendar, moved: [], unexplained: [], notObserved: [] };
  }

  const sorted = [...observedSet].sort();
  const obsLo = sorted[0];
  const obsHi = sorted[sorted.length - 1];
  const inWindow = (d: string) => d >= obsLo && d <= obsHi;

  const result = new Map<string, PhHoliday>();
  const moved: ReconcileReport["moved"] = [];
  const notObserved: ReconcileReport["notObserved"] = [];
  const claimed = new Set<string>();

  // Exact matches first, so a nearby move can never steal a date that already
  // lines up with its own holiday.
  for (const h of calendar) {
    if (observedSet.has(h.date) || !inWindow(h.date)) {
      result.set(h.date, h);
      claimed.add(h.date);
    }
  }

  // Then re-date the leftovers onto the nearest unclaimed observed day.
  for (const h of calendar) {
    if (result.has(h.date)) continue;

    let best: string | null = null;
    let bestGap = Infinity;
    for (const o of observedSet) {
      if (claimed.has(o) || result.has(o)) continue;
      const gap = daysApart(h.date, o);
      if (gap <= MOVE_WINDOW_DAYS && gap < bestGap) {
        best = o;
        bestGap = gap;
      }
    }

    if (best) {
      moved.push({ from: h.date, to: best, name: h.name });
      claimed.add(best);
      result.set(best, {
        ...h,
        date: best,
        source: "observed-moved",
        note: `moved from ${h.date}${h.note ? ` — ${h.note}` : ""}`,
      });
    } else {
      notObserved.push({ date: h.date, name: h.name });
    }
  }

  const unexplained = [...observedSet].filter((o) => !result.has(o)).sort();

  return {
    holidays: [...result.values()].sort((a, b) => a.date.localeCompare(b.date)),
    moved,
    unexplained,
    notObserved,
  };
}
