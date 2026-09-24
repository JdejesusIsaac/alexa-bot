import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { upsertStudent } from '../src/repositories/students.js';
import { createPickupRequest } from '../src/repositories/pickup-requests.js';
import {
  FIELD_CLEARANCE,
  TOOL_MINIMUM_FIELDS,
  project,
} from '../src/disclosure/policy.js';
import { TENANT_A } from '../src/fixtures/synthetic-data.js';

/**
 * PL-210 — the disclosure extension, graded by T-69.
 *
 * A new column on a Sprint 3 table — added by this test, with no
 * clearance entry anywhere — rides on every `select *` row the database
 * returns. Default-deny must not care: absent from every response,
 * for every tool, at every role. This extends T-36 to the tables that
 * carry the sensitive content, not just the ones the policy was
 * written for.
 *
 * Also pins the two demotions the plan calls for: `reason_detail` is
 * `never` (the P3 decision), and the roster's `reason_code` is `never`
 * (the Sprint 2 review finding — clearance alone no longer permits
 * what the minimum-set gate happened to hold back).
 *
 * Uses a real Postgres database (provisioned per run) with RLS enforced.
 * Synthetic data only.
 */

const DETAIL_SENTINEL = 'SENTINEL-medical-detail-t69';
const CANARY_SENTINEL = 'SENTINEL-t69-undeclared-column';

let db: TestDb;
let requestRow: Record<string, unknown>;

beforeAll(async () => {
  db = await provisionTestDb();

  const owner = await db.ownerPool.connect();
  try {
    await owner.query(`insert into tenants (id, name) values ($1, 'Campus Alpha')`, [
      TENANT_A,
    ]);

    // T-69's setup: a brand-new column on pickup_requests, undeclared to
    // the policy. Every `select *` row now carries it.
    await owner.query(`alter table pickup_requests add column t69_canary text`);
  } finally {
    owner.release();
  }

  let requestId = '';
  await withTenant(db.appPool, TENANT_A, async (client) => {
    const student = await upsertStudent(client, {
      studentRef: 'D-001',
      studentName: 'Disclosure Extension Scholar',
      section: '101',
    });
    const request = await createPickupRequest(client, {
      serviceDate: '2030-03-15',
      studentId: student.id,
      pickupAt: new Date('2030-03-15T18:30:00Z'),
      reasonCategory: 'appointment',
      reasonDetail: DETAIL_SENTINEL,
      intakeChannel: 'coordinator',
    });
    requestId = request.id;
    await client.query(`update pickup_requests set t69_canary = $1 where id = $2`, [
      CANARY_SENTINEL,
      requestId,
    ]);
  });

  // The FULL row as the database returns it — canary included.
  requestRow = await withTenant(db.appPool, TENANT_A, async (client) => {
    const res = await client.query(`select * from pickup_requests where id = $1`, [
      requestId,
    ]);
    return res.rows[0] as Record<string, unknown>;
  });
});

afterAll(async () => {
  await db.cleanup();
});

describe('PL-210 · T-69: a new column is absent without a clearance entry', () => {
  it('the canary rides on the raw row — and survives no projection, for any tool, at any role', () => {
    // Precondition: the undeclared column IS on the row the database
    // returns. If this fails, the test stopped testing anything.
    expect(requestRow.t69_canary).toBe(CANARY_SENTINEL);
    expect(requestRow.reason_detail).toBe(DETAIL_SENTINEL);

    for (const tool of Object.keys(TOOL_MINIMUM_FIELDS)) {
      for (const role of ['staff', 'admin'] as const) {
        const projected = project(requestRow, tool, role);
        expect(projected).not.toHaveProperty('t69_canary');
        expect(projected).not.toHaveProperty('reason_detail');
      }
    }
  });

  it('every field the new tools return is exactly the declared minimum set', () => {
    // PL-208's tools present the request's PK as `request_id` — the raw
    // column `id` is never-cleared (a generic PK is not a response
    // field). The shaped row is what the tool layer projects; everything
    // else it carries is the projection's job to drop.
    const shaped = {
      ...requestRow,
      request_id: requestRow.id,
      student_name: 'Disclosure Extension Scholar',
    };

    for (const tool of [
      'create_pickup_request',
      'list_pending_approvals',
      'decide_pickup_request',
    ] as const) {
      const projected = project(shaped, tool, 'staff');
      expect(Object.keys(projected).sort()).toEqual(
        [...(TOOL_MINIMUM_FIELDS[tool] ?? [])].sort(),
      );

      // The new sets contain only cleared fields — no contradiction ships.
      for (const field of TOOL_MINIMUM_FIELDS[tool] ?? []) {
        expect(FIELD_CLEARANCE[field] ?? 'never').not.toBe('never');
      }
    }
  });

  it('reason_detail is never — the P3 decision in the clearance map', () => {
    expect(FIELD_CLEARANCE.reason_detail).toBe('never');
  });

  it('the Sprint 2 review demotion: reason_code is never — clearance no longer permits it alone', () => {
    expect(FIELD_CLEARANCE.reason_code).toBe('never');

    const rosterRow = {
      student_ref: 'A001',
      student_name: 'Someone',
      reason_code: 'Excused W/O Notes',
    };
    expect(project(rosterRow, 'lookup_scholar_status', 'staff')).not.toHaveProperty(
      'reason_code',
    );
    expect(project(rosterRow, 'search_roster', 'admin')).not.toHaveProperty(
      'reason_code',
    );
  });

  it('the internal references on pickup_requests are never response fields', () => {
    for (const field of [
      'assigned_approver_id',
      'requested_by_contact_id',
      'intake_channel',
      'service_date',
      'created_at',
      'escalate_at',
    ] as const) {
      expect(FIELD_CLEARANCE[field]).toBe('never');
    }
  });
});
