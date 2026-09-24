import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from './helpers/db.js';
import { provisionTestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant-context.js';
import { upsertStudent } from '../src/repositories/students.js';
import {
  createPickupRequest,
  transitionPickupRequest,
} from '../src/repositories/pickup-requests.js';
import {
  getDecisionMetrics,
  type DecisionMetrics,
} from '../src/repositories/decision-metrics.js';
import { emitDecisionMetrics } from '../src/services/decision-metrics.js';
import { createLogger } from '../src/logging/logger.js';
import { TENANT_A, TENANT_B } from '../src/fixtures/synthetic-data.js';

/**
 * PL-211 — time-to-decision instrumentation, graded by T-73.
 *
 * Median and p90 time-to-decision (routed → decided, the glossary's
 * governing SLO), escalation rate, expiry rate, and decision mix by
 * approver — emitted per tenant, with the counts that make a number a
 * result rather than a bare figure (E2: a measurement with no baseline
 * is not a result; a measurement with no conditions is not a number).
 *
 * The timings are constructed exactly: three decided requests at 10,
 * 20, and 30 minutes, one escalated-then-denied, one expired — so the
 * median (1200s) and p90 (1680s — percentile_cont interpolates: rank
 * 1.8 of [600, 1200, 1800]) are asserted, not approximated.
 *
 * The Alexa 500 ms budget does not govern this surface; these numbers
 * are in minutes by design.
 *
 * Uses a real Postgres database (provisioned per run) with RLS enforced.
 * Synthetic data only.
 */

const ROUTED_AT = new Date('2030-03-15T15:00:00Z');
const SERVICE_DATE = '2030-03-15';

let db: TestDb;
let studentA: string;

beforeAll(async () => {
  db = await provisionTestDb();

  const owner = await db.ownerPool.connect();
  try {
    await owner.query(
      `insert into tenants (id, name) values ($1, 'Campus Alpha'), ($2, 'Campus Bravo')`,
      [TENANT_A, TENANT_B],
    );
  } finally {
    owner.release();
  }

  studentA = await withTenant(db.appPool, TENANT_A, async (client) => {
    const s = await upsertStudent(client, {
      studentRef: 'M-001',
      studentName: 'Metrics Test Scholar',
      section: '101',
    });
    return s.id;
  });

  /** Create + route a request; returns its id. */
  const makeRouted = async (): Promise<string> => {
    return withTenant(db.appPool, TENANT_A, async (client) => {
      const request = await createPickupRequest(client, {
        serviceDate: SERVICE_DATE,
        studentId: studentA,
        pickupAt: new Date('2030-03-15T18:30:00Z'),
        reasonCategory: 'appointment',
        intakeChannel: 'coordinator',
      });
      const routed = await transitionPickupRequest(client, {
        requestId: request.id,
        action: 'route',
        actor: 'intake-coordinator',
        escalateAt: new Date('2030-03-15T18:30:00Z'),
      });
      expect(routed.ok).toBe(true);
      return request.id;
    });
  };

  const drive = async (
    requestId: string,
    action: 'approve' | 'deny' | 'escalate' | 'expire',
    actor: string,
  ) => {
    const result = await withTenant(db.appPool, TENANT_A, async (client) =>
      transitionPickupRequest(client, {
        requestId,
        action,
        actor,
        ...(action === 'escalate'
          ? { escalateAt: new Date('2030-03-15T18:40:00Z') }
          : {}),
      }),
    );
    expect(result.ok).toBe(true);
  };

  // R1: decided by leader-1 in 10 minutes.
  const r1 = await makeRouted();
  await drive(r1, 'approve', 'leader-1@synthetic.test');
  // R2: escalated once, then denied by leader-2 in 20 minutes.
  const r2 = await makeRouted();
  await drive(r2, 'escalate', 'worker');
  await drive(r2, 'deny', 'leader-2@synthetic.test');
  // R3: decided by leader-1 in 30 minutes.
  const r3 = await makeRouted();
  await drive(r3, 'approve', 'leader-1@synthetic.test');
  // R4: never decided — expired.
  const r4 = await makeRouted();
  await drive(r4, 'expire', 'worker');

  // Construct the exact timings: routed at ROUTED_AT, decided at
  // ROUTED_AT + delta. Owner-role backdating of the synthetic fixtures.
  const backdatingOwner = await db.ownerPool.connect();
  try {
    const backdate = async (requestId: string, decisionMinutes: number) => {
      await backdatingOwner.query(
        `update pickup_request_events set created_at = $1
         where request_id = $2 and event_type = 'routed'`,
        [ROUTED_AT, requestId],
      );
      await backdatingOwner.query(
        `update pickup_requests set decided_at = $1 where id = $2`,
        [new Date(ROUTED_AT.getTime() + decisionMinutes * 60_000), requestId],
      );
    };
    await backdate(r1, 10);
    await backdate(r2, 20);
    await backdate(r3, 30);
  } finally {
    backdatingOwner.release();
  }
});

afterAll(async () => {
  await db.cleanup();
});

async function metricsFor(tenantId: string): Promise<DecisionMetrics> {
  return withTenant(db.appPool, tenantId, async (client) => getDecisionMetrics(client));
}

describe('PL-211 · T-73: time-to-decision is recorded', () => {
  it('median and p90 time-to-decision, with the counts that make them a result', async () => {
    const metrics = await metricsFor(TENANT_A);

    expect(metrics.totalRequests).toBe(4);
    expect(metrics.decidedCount).toBe(3);
    // Median: 20 minutes exactly.
    expect(metrics.medianSeconds).toBe(1200);
    // p90: percentile_cont interpolates — rank 1.8 of [600, 1200, 1800]
    // is 1200 + 0.8 * 600 = 1680 seconds. Asserted, not approximated.
    expect(metrics.p90Seconds).toBe(1680);
  });

  it('escalation rate and expiry rate — the two signals the plan names', async () => {
    const metrics = await metricsFor(TENANT_A);
    // One of four requests climbed the ladder; one of four expired.
    expect(metrics.escalatedCount).toBe(1);
    expect(metrics.expiredCount).toBe(1);
    expect(metrics.escalationRate).toBe(0.25);
    expect(metrics.expiryRate).toBe(0.25);
  });

  it('decision mix by approver — the audit subject, never a raw id', async () => {
    const metrics = await metricsFor(TENANT_A);
    expect(metrics.decisionMix).toEqual([
      { approver: 'leader-1@synthetic.test', decision: 'approved', count: 2 },
      { approver: 'leader-2@synthetic.test', decision: 'denied', count: 1 },
    ]);
  });

  it('an empty tenant is well-formed — null percentiles, zero rates, no mix', async () => {
    const metrics = await metricsFor(TENANT_B);
    expect(metrics.totalRequests).toBe(0);
    expect(metrics.decidedCount).toBe(0);
    expect(metrics.medianSeconds).toBeNull();
    expect(metrics.p90Seconds).toBeNull();
    expect(metrics.escalationRate).toBe(0);
    expect(metrics.expiryRate).toBe(0);
    expect(metrics.decisionMix).toEqual([]);
  });

  it('the emitter writes one structured line per tenant — numbers, conditions, nothing else', async () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: 'info' }, {
      write: (line: string) => {
        lines.push(line);
      },
    } as unknown as NodeJS.WritableStream);

    const metrics = await emitDecisionMetrics(db.appPool, { tenantId: TENANT_A }, logger);
    expect(metrics.medianSeconds).toBe(1200);

    const emitted = lines.find((l) => l.includes('decision_metrics'));
    expect(emitted).toBeDefined();

    const parsed = JSON.parse(emitted!) as Record<string, unknown>;
    expect(parsed.tenant_id).toBe(TENANT_A);
    expect(parsed.median_minutes).toBe(20);
    expect(parsed.p90_minutes).toBe(28);
    expect(parsed.decided_count).toBe(3);
    // The line carries the numbers and their conditions — never a
    // scholar identifier (the redactor would catch it; the shape
    // should never offer it).
    expect(emitted).not.toContain('Metrics Test Scholar');
    expect(emitted).not.toContain('M-001');
  });
});
