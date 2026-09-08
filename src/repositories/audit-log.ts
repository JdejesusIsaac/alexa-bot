import { type PoolClient } from 'pg';

/**
 * Audit log repository.
 *
 * Append-only at the database grant level — `UPDATE` and `DELETE` are
 * revoked from `parentline_app` (T-10). This repository only exposes
 * `insert` and `findByStudentRef`, making modification impossible from
 * application code.
 *
 * Every read of student data writes an audit entry (Rule, PL-008, T-16).
 * Both successes and refusals are audited.
 */

export interface AuditEntry {
  id: string;
  tenant_id: string;
  actor: string;
  action: string;
  subject_student_ref: string | null;
  fields_disclosed: string[];
  outcome: string;
  created_at: Date;
}

/**
 * Write an audit entry. The tenant_id is set by RLS from the
 * `app.tenant_id` session variable — it is never passed as a value
 * in the INSERT, ensuring it cannot be forged.
 */
export async function insertAuditEntry(
  client: PoolClient,
  params: {
    actor: string;
    action: string;
    subjectStudentRef: string | null;
    fieldsDisclosed: string[];
    outcome: string;
  },
): Promise<AuditEntry> {
  const res = await client.query<AuditEntry>(
    `insert into audit_log (tenant_id, actor, action, subject_student_ref, fields_disclosed, outcome)
     values (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5)
     returning *`,
    [
      params.actor,
      params.action,
      params.subjectStudentRef,
      params.fieldsDisclosed,
      params.outcome,
    ],
  );
  return res.rows[0]!;
}

/**
 * Find audit entries for a student within the current tenant context.
 * RLS ensures only the active tenant's audit entries are visible.
 */
export async function findByStudentRef(
  client: PoolClient,
  studentRef: string,
): Promise<AuditEntry[]> {
  const res = await client.query<AuditEntry>(
    `select * from audit_log where subject_student_ref = $1 order by created_at desc`,
    [studentRef],
  );
  return res.rows;
}
