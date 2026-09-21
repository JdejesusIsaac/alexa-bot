import { type PoolClient } from 'pg';

/**
 * Students repository (PL-201).
 *
 * `students` is the cross-day registry a roster row links to. The sheet
 * is the daily source; the registry is what routing by section/grade and
 * the leader's pattern context read against. A `student_ref` absent at
 * ingest is inserted here — never skipped (T-51).
 *
 * tenant_id is set by RLS from `app.tenant_id` — never passed as a value
 * in the INSERT (Rule 7).
 */

export interface Student {
  id: string;
  tenant_id: string;
  student_ref: string;
  student_name: string;
  section: string | null;
  /** Routing-scope attribute (PL-203). Not yet sheet-populated — set per campus or by provisioning. */
  grade: string | null;
  do_not_call: boolean;
}

/**
 * Resolve a roster row's `student_ref` against `students`, inserting the
 * student when absent. The unique (tenant_id, student_ref) constraint
 * makes a re-sync an update, not a duplicate (T-51).
 *
 * Name and section refresh from the sheet — they are roster-sourced
 * identity attributes. `do_not_call` is deliberately untouched: it is a
 * staff-managed contact-permission flag (F-4), not sheet data.
 */
export async function upsertStudent(
  client: PoolClient,
  params: {
    studentRef: string;
    studentName: string;
    section: string | null;
  },
): Promise<Student> {
  const res = await client.query<Student>(
    `insert into students (tenant_id, student_ref, student_name, section)
     values (current_setting('app.tenant_id')::uuid, $1, $2, $3)
     on conflict (tenant_id, student_ref) do update
       set student_name = excluded.student_name,
           section = excluded.section
     returning *`,
    [params.studentRef, params.studentName, params.section],
  );
  return res.rows[0]!;
}
