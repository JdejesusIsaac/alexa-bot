import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  startTestMcpServer,
  SYNTHETIC_SLACK_SIGNING_SECRET,
  type TestMcpServer,
} from './helpers/mcp-server.js';
import { withTenant } from '../src/db/tenant-context.js';
import {
  createPickupRequest,
  transitionPickupRequest,
} from '../src/repositories/pickup-requests.js';
import { findStaffIdentityBySlackUserId } from '../src/repositories/staff-identities.js';
import { upsertStudent } from '../src/repositories/students.js';
import { TENANT_A, TENANT_B } from '../src/fixtures/synthetic-data.js';
import { todayServiceDate } from '../src/util/service-date.js';

/**
 * T-89 (B-14) — the Slack SECURITY DEFINER path, end to end, as the role
 * that owns the database.
 *
 * `pickup_request_belongs_to_tenant` (migration 0010, fixed in 0011) is
 * SECURITY DEFINER, so it runs as its OWNER. FORCE ROW LEVEL SECURITY
 * binds the owner too, and the Slack endpoint probes it with NO tenant
 * context (it is resolving WHICH tenant a request belongs to). As the
 * README's non-superuser owner, the pre-0011 body raised `unrecognized
 * configuration parameter "app.tenant_id"` — a 500 on every Slack
 * interaction — while a superuser owner bypassed RLS and hid it.
 *
 * **This file is the door, not the function.** It drives a signed POST to
 * `/slack/interactions` (reaching the definer through the real endpoint)
 * and asserts the interaction resolves — never the 500. Its name matches
 * the `tests/isolation` filter, so `npm run test:isolation` runs it, and
 * T-89 spawns that command under a probe role holding exactly the
 * README's grants (a non-superuser owner). In the main suite it runs as
 * the local superuser owner — a positive control; the gate is the nested
 * probe run, where the owner is bound by FORCE RLS as a fresh clone's is.
 *
 * Mutation (recorded with T-89): revert migration 0011 (the definer back
 * to the plain-SQL body) and BOTH legs go red under the probe — the
 * definer's missing tenant-context error surfaces as a 500
 * `internal_error` on the wire — while staying green in the superuser
 * main suite, which is exactly why B-14 was invisible to CI.
 */

const ENDPOINT = '/slack/interactions';

let server: TestMcpServer;
let requestA: string;

beforeAll(async () => {
  server = await startTestMcpServer();
  // A routed request in tenant A, assigned to a Slack-mapped approver so
  // a signed approve from that user is a legitimate decision (not a
  // self-approval, not an unmapped actor).
  requestA = await withTenant(server.db.appPool, TENANT_A, async (client) => {
    const student = await upsertStudent(client, {
      studentRef: 'DEFINER-001',
      studentName: 'Definer Path Scholar',
      section: '101',
    });
    const approver = await findStaffIdentityBySlackUserId(client, 'USYNTH_A_SECTION');
    expect(approver).not.toBeNull();
    const request = await createPickupRequest(client, {
      serviceDate: todayServiceDate(),
      studentId: student.id,
      pickupAt: new Date('2030-03-15T18:30:00Z'),
      reasonCategory: 'appointment',
      intakeChannel: 'coordinator',
    });
    const routed = await transitionPickupRequest(client, {
      requestId: request.id,
      action: 'route',
      actor: 'intake-coordinator',
      escalateAt: new Date('2030-03-15T18:30:00Z'),
      assignedApproverId: approver!.id,
    });
    expect(routed.ok).toBe(true);
    return request.id;
  });
});

afterAll(async () => {
  await server.close();
});

function postSigned(requestId: string, slackUserId: string): Promise<Response> {
  const payload = JSON.stringify({
    type: 'block_actions',
    user: { id: slackUserId },
    actions: [{ action_id: 'approve', value: requestId }],
  });
  const body = new URLSearchParams({ payload }).toString();
  const timestamp = Math.floor(Date.now() / 1000);
  const hex = createHmac('sha256', SYNTHETIC_SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex');
  return fetch(`${server.url}${ENDPOINT}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': `v0=${hex}`,
    },
    body,
  });
}

describe('T-89 · B-14: the Slack membership definer resolves under FORCE RLS as the DB owner', () => {
  it('a signed approve reaches the definer, resolves the tenant, and decides — never a 500', async () => {
    const res = await postSigned(requestA, 'USYNTH_A_SECTION');
    const json = (await res.json()) as { ok?: boolean; error?: string };
    // The definer probe ran as the owner under FORCE RLS. Pre-0011 it
    // raised and the endpoint returned 500 error:internal_error; the fix
    // makes it resolve and the assigned approver's approval land.
    expect(res.status, JSON.stringify(json)).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.ok).toBe(true);
  });

  it('a request outside the actor\'s reach resolves as uniform not-found — after the definer evaluates a real row (F-12)', async () => {
    // F-12: a truly nonexistent id CANNOT discriminate under the B-14
    // mutation — `pickup_request_belongs_to_tenant` probes
    // `exists(… where id = $1 …)`, the PK index yields zero rows, and
    // the RLS qual (the current_setting that raised pre-0011) never
    // evaluates. The old leg asserted the not-found shape while staying
    // green with the fix removed — a leg that could not fail. The
    // discriminating fixture is a request that EXISTS in another
    // tenant, seeded under TENANT_B's own context (the B-12 lesson):
    // probing tenant B evaluates the policy qual on the real row, so
    // removing the fix raises the definer's missing-context error →
    // 500 `internal_error` here. Under the fix the request resolves to
    // tenant B, this A-only-mapped actor is unmapped there, and the
    // wire is T-66's uniform not-found — indistinguishable from a
    // request that does not exist at all.
    const requestB = await withTenant(server.db.appPool, TENANT_B, async (client) => {
      const student = await upsertStudent(client, {
        studentRef: 'DEFINER-002',
        studentName: 'Definer Path Scholar Bravo',
        section: '102',
      });
      const approver = await findStaffIdentityBySlackUserId(client, 'USYNTH_B_SECTION');
      expect(approver).not.toBeNull();
      const request = await createPickupRequest(client, {
        serviceDate: todayServiceDate(),
        studentId: student.id,
        pickupAt: new Date('2030-03-15T18:30:00Z'),
        reasonCategory: 'appointment',
        intakeChannel: 'coordinator',
      });
      const routed = await transitionPickupRequest(client, {
        requestId: request.id,
        action: 'route',
        actor: 'intake-coordinator',
        escalateAt: new Date('2030-03-15T18:30:00Z'),
        assignedApproverId: approver!.id,
      });
      expect(routed.ok).toBe(true);
      return request.id;
    });

    const res = await postSigned(requestB, 'USYNTH_A_SECTION');
    const json = (await res.json()) as { ok?: boolean; error?: string };
    expect(res.status, JSON.stringify(json)).toBe(200);
    expect(json.ok).toBe(false);
    expect(json.error).toBe('request_not_found');

    // The wire-shape half: a truly nonexistent id is byte-identical.
    // Kept, and honestly labeled — it asserts the T-66 shape but cannot
    // exercise the definer's qual (no candidate row), so it is NOT the
    // discriminating part of this leg.
    const missing = await postSigned('99999999-9999-9999-9999-999999999999', 'USYNTH_A_SECTION');
    const missingJson = (await missing.json()) as { ok?: boolean; error?: string };
    expect(missing.status, JSON.stringify(missingJson)).toBe(200);
    expect(missingJson.ok).toBe(false);
    expect(missingJson.error).toBe('request_not_found');
  });
});
