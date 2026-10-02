/**
 * When the weekly batch runs. The Scheduled Task registered by
 * smartflow_scripts/3_training_testing/weekly_retrain/register_weekly_task.ps1
 * is the source of truth; change both together.
 */
export const RETRAIN_SCHEDULE = { day: "Sunday", time: "22:00", timezone: "Asia/Manila" } as const;

/** The next Sunday 22:00 in Manila (UTC+8, no daylight saving), as an ISO instant. */
export function nextRetrain(now = new Date()): string {
  const MANILA = 8 * 3600_000;
  const wall = new Date(now.getTime() + MANILA);            // Manila's wall clock, read through the UTC getters
  const tonight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), 22, 0);
  let days = (7 - wall.getUTCDay()) % 7;
  if (days === 0 && wall.getTime() >= tonight) days = 7;
  return new Date(tonight + days * 86_400_000 - MANILA).toISOString();
}
