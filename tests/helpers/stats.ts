/**
 * Shared timing statistics for the distribution-parity tests
 * (T-42, T-66, T-83). One copy — T-74 exists because the Slack
 * endpoint's local `percentile` computed `(p/100)·n` on a fraction
 * `p`, reading index 1 of 200 while reporting p90. A test asserting a
 * statistical property needs an instrument that can fail; asserting
 * the helper first is Sprint 2 F-2's discipline.
 */

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Nearest-rank percentile on a FRACTION `p` — p90 of 200 samples reads
 * the 180th element (index 180), the tail the parity claim is about.
 * Not index 1: `p` is already a fraction; dividing by 100 again is the
 * defect T-74 measures.
 */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}
