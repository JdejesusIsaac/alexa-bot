/**
 * The service date — the school day a roster row belongs to (AD-31).
 *
 * Local date, not UTC: a campus's service day turns over at local
 * midnight, and the roster grain follows the school, not the server
 * clock. The sync scheduler's school-hours window already reasons in
 * local time.
 *
 * Repository read methods take `serviceDate` as an explicit required
 * parameter — the data layer does not decide what "today" means. This
 * helper is where production callers derive the default; tests pass
 * fixed dates for determinism.
 */

export function todayServiceDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
