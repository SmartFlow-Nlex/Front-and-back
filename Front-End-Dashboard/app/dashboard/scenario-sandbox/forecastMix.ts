// The vehicle mix the road runs when a forecast day is loaded.
//
// The fleet-mix model forecasts one Class 1 / 2 / 3 split per DAY. A day is not one mix: trucks run at night and
// cars at the peaks, and that hourly pattern is the one thing the warehouse does record (the demand profile's
// per-hour mix). So the forecast sets the level and the observed pattern sets the shape: each class's forecast day
// share is scaled by how far that class's share at this hour sits from its own volume-weighted day average, then
// the three are renormalised into a composition. A forecast that says the day is truck-heavy stays truck-heavy at
// every hour, and the night-time rise in trucks is still there.
//
// Pure and dependency-free on purpose, so verify.ts can run it in Node.

export type ClassShares = Record<1 | 2 | 3, number>;
type HourOfDemand = { vehPerHour: number; mix: ClassShares };

const CLASSES = [1, 2, 3] as const;

/**
 * `day` shaped to the hour `at`, from the observed profile `hours` (all 24 of them). With no usable hourly shape
 * the day mix is returned as it is — flat, which is what the forecast literally says — rather than guessed at.
 */
export function shapeForecastMix(day: ClassShares, hours: readonly HourOfDemand[] | null, at: HourOfDemand | null): ClassShares {
  if (!hours || hours.length === 0 || !at) return day;

  let total = 0;
  const mean: ClassShares = { 1: 0, 2: 0, 3: 0 };
  for (const h of hours) {
    total += h.vehPerHour;
    for (const k of CLASSES) mean[k] += h.vehPerHour * h.mix[k];
  }
  if (!(total > 0)) return day;

  const shaped: ClassShares = { 1: 0, 2: 0, 3: 0 };
  let sum = 0;
  for (const k of CLASSES) {
    const avg = mean[k] / total;
    // A class the observed profile never carries has no pattern to borrow: it keeps its forecast share.
    const rel = avg > 0 ? at.mix[k] / avg : 1;
    shaped[k] = Math.max(0, day[k] * rel);
    sum += shaped[k];
  }
  if (!(sum > 0)) return day;
  for (const k of CLASSES) shaped[k] /= sum;
  return shaped;
}
