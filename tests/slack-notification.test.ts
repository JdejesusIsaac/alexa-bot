import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb, seedTenants } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { upsertStudent } from '../src/repositories/students.js';
import {
  createPickupRequest,
  transitionPickupRequest,
} from '../src/repositories/pickup-requests.js';
import { insertStaffIdentity } from '../src/repositories/staff-identities.js';
import { CaptureSlackClient } from '../src/slack/capture-client.js';
import {
  sendPickupNotifications,
  type NotificationResult,
} from '../src/services/pickup-notification.js';
import { createLogger } from '../src/logging/logger.js';
import { TENANT_A, TENANT_B } from '../src/fixtures/synthetic-data.js';

/**
 * PL-206 — the outbound Slack surface, graded by T-68 (GATE).
 *
 * Adversarial sentinel pass: a request whose `reason_detail` carries a
 * unique marker is notified through every path this surface has — the
 * approver DM, the visibility thread, every log line, and every error
 * path including a client that fails and a client that throws. The
 * sentinel (and the reason category — the P3 decision sends no reason
 * at all) must appear nowhere outside the database and the audited
 * in-app read.
 *
 * The capture client records what WOULD have gone on the wire; the
 * capture logger records what WOULD have gone to stdout. Those two
 * recordings are the entire leak surface of this task.
 *
 * Uses a real Postgres database (provisioned per run) with RLS enforced.
 * Synthetic data only.
 */

const SENTINEL = 'SENTINEL-custody-therapy-detail-8f3a';
const REASON_CATEGORY = 'appointment';
const STUDENT_NAME = 'Notification Test Scholar';
const APPROVER_SLACK_ID = 'USYNTH_NOTIFY';
const VISIBILITY_CHANNEL = 'C-EASTLEADERS';
const LINK = 'https://parentline.example/requests/pending';

const SERVICE_DATE = '2030-03-15';
const PICKUP_AT = new Date('2030-03-15T18:30:00Z');

let db: TestDb;
let approverIdentityId: string;
let bApproverIdentityId: string;

beforeAll(async () => {
  db = await provisionTestDb();

  // FORCE RLS binds the owner too — each tenant row enters under its
  // own context (B-12).
  await seedTenants(db.ownerPool, [
    [TENANT_A, 'Campus Alpha'],
    [TENANT_B, 'Campus Bravo'],
  ]);

  await withTenant(db.appPool, TENANT_A, async (client) => {
    const approver = await insertStaffIdentity(client, {
      slackUserId: APPROVER_SLACK_ID,
      subject: 'lead-notify@synthetic.test',
      role: 'staff',
    });
    approverIdentityId = approver.id;
  });
  await withTenant(db.appPool, TENANT_B, async (client) => {
    const approver = await insertStaffIdentity(client, {
      slackUserId: 'USYNTH_NOTIFY_B',
      subject: 'lead-notify-b@synthetic.test',
      role: 'staff',
    });
    bApproverIdentityId = approver.id;
  });
});

afterAll(async () => {
  await db.cleanup();
});

/** A request with the sentinel planted in reason_detail, routed to the mapped approver. */
async function makeNotifiableRequest(
  options: { assignApprover?: boolean; tenantId?: string } = {},
): Promise<string> {
  const tenantId = options.tenantId ?? TENANT_A;
  return withTenant(db.appPool, tenantId, async (client) => {
    const student = await upsertStudent(client, {
      studentRef: tenantId === TENANT_A ? 'N-001' : 'N-101',
      studentName: STUDENT_NAME,
      section: '101',
    });
    const request = await createPickupRequest(client, {
      serviceDate: SERVICE_DATE,
      studentId: student.id,
      pickupAt: PICKUP_AT,
      reasonCategory: REASON_CATEGORY,
      reasonDetail: SENTINEL,
      intakeChannel: 'coordinator',
    });
    const routed = await transitionPickupRequest(client, {
      requestId: request.id,
      action: 'route',
      actor: 'intake-coordinator',
      escalateAt: new Date('2030-03-15T20:00:00Z'),
      ...(options.assignApprover === false
        ? {}
        : {
            assignedApproverId:
              tenantId === TENANT_A ? approverIdentityId : bApproverIdentityId,
          }),
    });
    expect(routed.ok).toBe(true);
    return request.id;
  });
}

/** Capture logger factory — the log side of T-68's leak surface. */
function makeCaptureLogger(): {
  lines: string[];
  logger: ReturnType<typeof createLogger>;
} {
  const lines: string[] = [];
  const logger = createLogger({ logLevel: 'info' }, {
    write: (line: string) => {
      lines.push(line);
    },
  } as unknown as NodeJS.WritableStream);
  return { lines, logger };
}

/** Notify under tenant A, returning the typed result and the captured log lines. */
async function notify(
  requestId: string,
  slack: CaptureSlackClient,
): Promise<{ result: NotificationResult; lines: string[] }> {
  const { lines, logger } = makeCaptureLogger();
  const result = await withTenant(db.appPool, TENANT_A, async (client) =>
    sendPickupNotifications(
      client,
      slack,
      { requestId, visibilityChannel: VISIBILITY_CHANNEL, link: LINK },
      logger,
    ),
  );
  return { result, lines };
}

// ── T-68 (GATE): reason_detail never leaves Postgres ─────────────────

describe('PL-206 · T-68 (GATE): the sentinel appears nowhere outside Postgres', () => {
  it('the DM and the visibility thread carry name, time, and link — no reason of any kind', async () => {
    const requestId = await makeNotifiableRequest();
    const slack = new CaptureSlackClient();

    const { result } = await notify(requestId, slack);
    expect(result.ok).toBe(true);

    // Two messages: the DM to the named approver, the visibility thread.
    expect(slack.messages()).toHaveLength(2);
    expect(slack.messages()[0]!.channel).toBe(APPROVER_SLACK_ID);
    expect(slack.messages()[1]!.channel).toBe(VISIBILITY_CHANNEL);

    // The allowlist content is present…
    for (const text of slack.texts()) {
      expect(text).toContain(STUDENT_NAME);
      expect(text).toContain(PICKUP_AT.toISOString());
      expect(text).toContain(LINK);
    }

    // …and nothing else is: no detail, no category — the P3 decision
    // sends no reason at all. This is the critical fail condition.
    for (const text of slack.texts()) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(REASON_CATEGORY);
    }
  });

  it('every log line carries metadata only — no sentinel, no message text', async () => {
    const requestId = await makeNotifiableRequest();
    const slack = new CaptureSlackClient();

    const { result, lines } = await notify(requestId, slack);
    expect(result.ok).toBe(true);
    expect(lines.length).toBeGreaterThan(0);

    const sent = JSON.stringify(lines);
    expect(sent).toContain('notification_sent');
    expect(sent).not.toContain(SENTINEL);
    expect(sent).not.toContain(REASON_CATEGORY);
    // The payload text itself never reaches a log line either.
    expect(sent).not.toContain('You are the assigned approver');
    expect(sent).not.toContain(LINK);
  });

  it('a failing client is a typed refusal — attempted messages and logs stay clean', async () => {
    const requestId = await makeNotifiableRequest();
    const slack = new CaptureSlackClient({ fail: 'fail' });

    const { result, lines } = await notify(requestId, slack);
    expect(result).toEqual({
      ok: false,
      code: 'send_failed',
      detail: 'simulated_send_failure',
    });

    // What WOULD have gone on the wire is recorded — and clean.
    expect(slack.messages().length).toBeGreaterThanOrEqual(1);
    for (const text of slack.texts()) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(REASON_CATEGORY);
    }

    const sent = JSON.stringify(lines);
    expect(sent).toContain('notification_send_failed');
    expect(sent).not.toContain(SENTINEL);
  });

  it('a throwing client is contained — typed failure, no exception text propagated', async () => {
    const requestId = await makeNotifiableRequest();
    const slack = new CaptureSlackClient({ fail: 'throw' });

    // The throw is contained inside the service, not propagated to the
    // caller — and its message is never logged or returned.
    const { result, lines } = await notify(requestId, slack);
    expect(result).toEqual({
      ok: false,
      code: 'send_failed',
      detail: 'client_exception',
    });

    for (const text of slack.texts()) {
      expect(text).not.toContain(SENTINEL);
    }
    const sent = JSON.stringify(lines);
    expect(sent).not.toContain(SENTINEL);
    expect(sent).not.toContain('simulated Slack client exception');
  });

  it('an unassigned request refuses with nothing sent', async () => {
    const requestId = await makeNotifiableRequest({ assignApprover: false });
    const slack = new CaptureSlackClient();

    const { result } = await notify(requestId, slack);
    expect(result).toEqual({ ok: false, code: 'no_assigned_approver' });
    expect(slack.messages()).toHaveLength(0);
  });

  it('an invisible request is not_found — and never forbidden-but-real', async () => {
    const slack = new CaptureSlackClient();

    const { result } = await notify('99999999-9999-9999-9999-999999999999', slack);
    expect(result).toEqual({ ok: false, code: 'not_found' });
    expect(slack.messages()).toHaveLength(0);
  });

  it('another tenant’s request is equally not_found', async () => {
    const foreignRequest = await makeNotifiableRequest({ tenantId: TENANT_B });
    const slack = new CaptureSlackClient();

    // Notifiable in B (with B's own approver); invisible from A.
    const { result } = await notify(foreignRequest, slack);
    expect(result).toEqual({ ok: false, code: 'not_found' });
    expect(slack.messages()).toHaveLength(0);
  });
});
