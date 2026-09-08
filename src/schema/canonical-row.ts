import { z } from 'zod';

/**
 * Canonical roster row — the logical schema for a validated attendance
 * tracker row, independent of any specific sheet's column layout.
 *
 * Column mappings (PL-004) translate per-tenant sheet headers into these
 * fields. The mapper produces a CanonicalRow; the sync process (PL-007)
 * inserts it as a roster_entries row.
 *
 * Advisor-notes content is excluded by design: the mapper only processes
 * columns with explicit mappings, and no tenant maps the notes column
 * (§2e F-3). Exclusion happens at ingestion, not by filtering downstream.
 */

/**
 * Fields that can be mapped from a sheet header. `hold_source` is set by
 * derivation logic (PL-012); `source_row_number` is sync metadata. Neither
 * is mappable from a sheet column.
 */
export const MAPPABLE_FIELDS = [
  'student_ref',
  'student_name',
  'section',
  'attendance_status',
  'reason_code',
  'hold_type',
  'release_time',
  'hold_location',
  'do_not_call',
  'missing_id',
] as const;

export type CanonicalFieldName = (typeof MAPPABLE_FIELDS)[number];

export const canonicalRowSchema = z.object({
  student_ref: z.string().min(1),
  student_name: z.string().min(1),
  section: z.string().nullable().default(null),
  attendance_status: z.string().nullable().default(null),
  reason_code: z.string().nullable().default(null),
  hold_type: z.string().nullable().default(null),
  hold_source: z.enum(['derived', 'authoritative']).default('authoritative'),
  release_time: z.string().nullable().default(null),
  hold_location: z.string().nullable().default(null),
  do_not_call: z.boolean().default(false),
  missing_id: z.boolean().default(false),
  source_row_number: z.number().int().nonnegative(),
});

export type CanonicalRow = z.infer<typeof canonicalRowSchema>;

/**
 * Error thrown when a raw row fails canonical validation. PL-006 catches
 * this to route the row to the quarantine queue with the source row number
 * and reason.
 */
export class MappingError extends Error {
  public override readonly name = 'MappingError';
  public readonly sourceRowNumber: number;
  public readonly issues: readonly z.ZodIssue[];

  constructor(sourceRowNumber: number, issues: readonly z.ZodIssue[]) {
    const summary = issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    super(`row ${sourceRowNumber}: ${summary}`);
    this.sourceRowNumber = sourceRowNumber;
    this.issues = issues;
  }
}
