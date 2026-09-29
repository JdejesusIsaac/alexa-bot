import { type Pool, type PoolClient } from 'pg';
import '../db/pg-types.js';

/**
 * Pickup request repository (PL-202) — the request spine.
 *
 * The state machine is enforced in ONE place: `transitionPickupRequest`.
 * No handler writes `state` directly — the same chokepoint discipline as
 * `project()`. A single bypass is how the state machine stops being one
 * (T-55 guards this structurally).
 *
 * States: draft → routed → approved | flagged | denied → released →
 * completed, plus `expired` terminal off `routed`. Expiry never approves
 * (AD-26); release is reachable only from `approved`, so no scholar is
 * released without a recorded human decision (E3).
 *
 * `reason_detail` is clearance `never` (P3, AD-28). It is written at
 * intake and purged at terminal states when the tenant retention is 0 —
 * enforced HERE, at the chokepoint, not filtered downstream. The nightly
 * sweep (`purgeStaleReasonDetail`) is the end-of-service-date hard stop.
 *
 * tenant_id is set by RLS from `app.tenant_id` — never passed as a value
 * in any INSERT or UPDATE (Rule 7).
 */

export type PickupRequestState =
  | 'draft'
  | 'routed'
  | 'approved'
  | 'flagged'
  | 'denied'
  | 'released'
  | 'completed'
  | 'expired'
  /**
   * Terminal human handoff (PL-254): the attempt ceiling was reached
   * with no decision. `stalled` never behaves like `approved` — it is
   * unreachable by release/complete by construction (AD-26).
   */
  | 'stalled';

export type PickupRequestAction =
  | 'route'
  | 'approve'
  | 'flag'
  | 'deny'
  | 'release'
  | 'complete'
  | 'expire'
  | 'escalate'
  /** The worker's ceiling transition — routed → stalled only. */
  | 'stall';

/** Constrained reason vocabulary (F-5) — product default, widened by written decision (P3). */
export const REASON_CATEGORIES = [
  'appointment',
  'family',
  'illness',
  'administrative',
  'other',
] as const;

export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

export type IntakeChannel = 'coordinator' | 'aircall';

export interface PickupRequest {
  id: string;
  tenant_id: string;
  service_date: string;
  student_id: string;
  pickup_at: Date;
  reason_category: ReasonCategory;
  reason_detail: string | null;
  requested_by_contact_id: string | null;
  intake_channel: IntakeChannel;
  state: PickupRequestState;
  assigned_approver_id: string | null;
  escalation_level: number;
  /**
   * Skip/failure count against the worker's ceiling (PL-254). Bounded:
   * at `ESCALATION_MAX_ATTEMPTS` the row stalls to a human.
   */
  escalation_attempts: number;
  escalate_at: Date | null;
  decided_at: Date | null;
  decided_by: string | null;
  released_at: Date | null;
  completed_at: Date | null;
  expired_at: Date | null;
  created_at: Date;
}

export interface PickupRequestEvent {
  id: string;
  tenant_id: string;
  request_id: string;
  escalation_level: number | null;
  event_type:
    | 'routed'
    | 'escalated'
    | 'approved'
    | 'flagged'
    | 'denied'
    | 'released'
    | 'completed'
    | 'expired'
    | 'stalled'
    | 'refused';
  actor: string;
  /** How this transition arrived: Slack interaction, in-app tool, or the worker. */
  channel: 'slack' | 'app' | 'worker';
  /** The decider's note, when the transition carries one (PL-208). */
  note: string | null;
  created_at: Date;
}

interface TransitionDef {
  /** States the action is legal from. */
  readonly from: readonly PickupRequestState[];
  /** State the action produces. */
  readonly to: PickupRequestState;
  /** Terminal states purge reason_detail at retention 0 (P3). */
  readonly terminal: boolean;
  /** Actions that arm the escalation clock need the next deadline. */
  readonly requiresEscalateAt?: boolean;
}

/**
 * The transition table. This map IS the state machine — the function
 * below only executes what it declares. `expire` is legal only from
 * `routed` (AD-26); `release` only from `approved` (E3); `escalate`
 * keeps the state and advances the level (the worker's action, PL-204).
 */
const TRANSITIONS: Readonly<Record<PickupRequestAction, TransitionDef>> = {
  route: { from: ['draft'], to: 'routed', terminal: false, requiresEscalateAt: true },
  approve: { from: ['routed', 'flagged'], to: 'approved', terminal: false },
  flag: { from: ['routed'], to: 'flagged', terminal: false },
  deny: { from: ['routed', 'flagged'], to: 'denied', terminal: true },
  release: { from: ['approved'], to: 'released', terminal: false },
  complete: { from: ['released'], to: 'completed', terminal: true },
  expire: { from: ['routed'], to: 'expired', terminal: true },
  escalate: { from: ['routed'], to: 'routed', terminal: false, requiresEscalateAt: true },
  // AD-26's twin: the attempt ceiling is a terminal HUMAN handoff,
  // never a path to approved/released/completed.
  stall: { from: ['routed'], to: 'stalled', terminal: true },
};

/** Ladder actions are the only events that carry an escalation level. */
const ACTION_EVENT_TYPES: Readonly<
  Record<PickupRequestAction, PickupRequestEvent['event_type']>
> = {
  route: 'routed',
  escalate: 'escalated',
  approve: 'approved',
  flag: 'flagged',
  deny: 'denied',
  release: 'released',
  complete: 'completed',
  expire: 'expired',
  stall: 'stalled',
};

export interface TransitionRequest {
  readonly requestId: string;
  readonly action: PickupRequestAction;
  /**
   * The audit subject driving the action — the resolved
   * `staff_identities.subject` on staff channels. Decisions record it as
   * `decided_by`; the system drives `expire` and `escalate`.
   */
  readonly actor: string;
  /**
   * The decider's `staff_identities.id`, resolved by the caller.
   * REQUIRED for decision actions (approve/flag/deny): the chokepoint
   * compares it to the request's `assigned_approver_id` — AD-27's one
   * named approver, enforced where enforcement cannot be skipped
   * (PL-251). Non-decision actions leave it unset.
   */
  readonly actorIdentityId?: string;
  /** Next escalation deadline — required by route and escalate. */
  readonly escalateAt?: Date;
  /** Ladder reassignment (PL-204). Unchanged when omitted. */
  readonly assignedApproverId?: string;
  /** How the transition arrived — recorded on the event row (T-67). */
  readonly channel?: 'slack' | 'app' | 'worker';
  /** The decider's note, recorded on the event row (PL-208). */
  readonly note?: string;
}

export type TransitionResult =
  | { ok: true; request: PickupRequest; idempotent: boolean }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'illegal_transition'
        | 'missing_field'
        | 'not_assigned_approver'
        | 'self_approval';
      from: PickupRequestState | null;
      action: PickupRequestAction;
      /** The absent required field, for `missing_field`. */
      field?: string;
    };

/** The actions that decide a request — and only they need an assignee. */
const DECISION_ACTIONS: readonly PickupRequestAction[] = ['approve', 'flag', 'deny'];

/**
 * Create a pickup request in `draft` — intake captured, nothing routed.
 * `state` is never a parameter: drafts are the only insertable state.
 */
export async function createPickupRequest(
  client: PoolClient,
  params: {
    serviceDate: string;
    studentId: string;
    pickupAt: Date;
    reasonCategory: ReasonCategory;
    reasonDetail?: string | null;
    requestedByContactId?: string | null;
    intakeChannel: IntakeChannel;
  },
): Promise<PickupRequest> {
  const res = await client.query<PickupRequest>(
    `insert into pickup_requests
       (tenant_id, service_date, student_id, pickup_at, reason_category,
        reason_detail, requested_by_contact_id, intake_channel)
     values (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7)
     returning *`,
    [
      params.serviceDate,
      params.studentId,
      params.pickupAt,
      params.reasonCategory,
      params.reasonDetail ?? null,
      params.requestedByContactId ?? null,
      params.intakeChannel,
    ],
  );
  return res.rows[0]!;
}

/**
 * Find a request by id within the current tenant context. A request id
 * from another tenant — or a nonexistent one — is simply not found.
 */
export async function findPickupRequestById(
  client: PoolClient,
  requestId: string,
): Promise<PickupRequest | null> {
  const res = await client.query<PickupRequest>(
    `select * from pickup_requests where id = $1`,
    [requestId],
  );
  return res.rows.length > 0 ? res.rows[0]! : null;
}

/**
 * Resolve which tenant a request id belongs to, with no tenant context
 * (PL-207). The Slack endpoint verifies a Slack signature, not a
 * tenant token — the tenant must be derived from the request itself.
 *
 * Backed by a read-only SECURITY DEFINER *membership* function
 * (migration 0010): `pickup_request_belongs_to_tenant` returns a
 * boolean and nothing else — it confirms, it does not disclose. The
 * endpoint probes each configured tenant; the wire answers not-found
 * identically whether the id resolves to another tenant or to nothing
 * (T-66), and leak vector 30's oracle is closed.
 */
export async function pickupRequestBelongsToTenant(
  pool: Pool,
  requestId: string,
  // eslint-disable-next-line no-restricted-syntax -- Rule 7 scoped to this one parameter, deliberately (B-5): this tenant arrives from SLACK_TENANT_IDS configuration at the Slack endpoint (PL-257), never from a caller or tool argument; the SQL surface stays boolean membership only, per leak vector 30 (T-82).
  tenantId: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ belongs: boolean }>(
      `select pickup_request_belongs_to_tenant($1, $2) as belongs`,
      [requestId, tenantId],
    );
    return res.rows[0]?.belongs === true;
  } finally {
    client.release();
  }
}

/**
 * Insert a ladder event. The unique (request_id, escalation_level)
 * constraint is the double-fire backstop: a rung cannot notify twice
 * no matter how many workers, retries, or redeploys race it (T-57).
 * Non-ladder events carry a NULL level, which the constraint treats as
 * distinct — refusal and decision events never collide with the ladder.
 */
export async function insertPickupRequestEvent(
  client: PoolClient,
  params: {
    requestId: string;
    escalationLevel: number | null;
    eventType: PickupRequestEvent['event_type'];
    actor: string;
    channel?: 'slack' | 'app' | 'worker';
    note?: string;
  },
): Promise<PickupRequestEvent> {
  const res = await client.query<PickupRequestEvent>(
    `insert into pickup_request_events
       (tenant_id, request_id, escalation_level, event_type, actor, channel, note)
     values (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6)
     returning *`,
    [
      params.requestId,
      params.escalationLevel,
      params.eventType,
      params.actor,
      params.channel ?? 'app',
      params.note ?? null,
    ],
  );
  return res.rows[0]!;
}

/**
 * The tenant's reason_detail retention in days (P3). No `tenant_settings`
 * row means the default: 0 — purge at terminal state, sweep at end of
 * service_date. RLS scopes the read to the active tenant.
 */
export async function getReasonDetailRetentionDays(client: PoolClient): Promise<number> {
  const res = await client.query<{ reason_detail_retention_days: number }>(
    `select reason_detail_retention_days from tenant_settings`,
  );
  return res.rows.length > 0 ? res.rows[0]!.reason_detail_retention_days : 0;
}

/**
 * THE state machine. Every transition of every pickup request goes
 * through this function (T-55) — there is no other writer of `state`.
 *
 * Semantics:
 *  - `not_found` — the id is invisible in this tenant or nonexistent.
 *    Indistinguishable by design.
 *  - `illegal_transition` — a typed refusal naming the attempted
 *    transition; no state change; a `refused` event row records the
 *    attempt (T-53).
 *  - decision authorization FIRST (PL-274, B-1) — for approve/flag/deny,
 *    the assignee and self-approval checks run before ANY success
 *    shape, including the idempotent replay. A non-assignee or the
 *    creator re-deciding an already-decided request gets the typed
 *    refusal and a `refused` ledger event; the audit trail never
 *    records a successful decision by someone with no right to make
 *    it. The state never changed — the audit row was the corruption.
 *  - idempotent — re-applying the action that produced the current
 *    state is a no-op returning the current state, never an error the
 *    caller cannot distinguish from real failure (T-54, the Slack
 *    at-least-once case) — and reachable only by the actor the
 *    authorization checks above allowed. `escalate` is excluded: its
 *    from and to states are identical, and its double-fire guard is
 *    the event unique constraint, not state idempotency.
 *
 * Terminal transitions purge `reason_detail` when the tenant retention
 * is 0 (P3) — the enforcement lives here, at the chokepoint, not in a
 * downstream filter.
 */
export async function transitionPickupRequest(
  client: PoolClient,
  request: TransitionRequest,
): Promise<TransitionResult> {
  const def = TRANSITIONS[request.action];
  // Normalized once: the event row's channel, defaulting to the app path
  // (exactOptionalPropertyTypes forbids passing an explicit undefined
  // into the optional insert parameter).
  const channel = request.channel ?? 'app';

  // 1. Lock the row. Concurrent transitions on one request serialize
  //    here; the second caller then observes the first's outcome.
  const selectRes = await client.query<PickupRequest>(
    `select * from pickup_requests where id = $1 for update`,
    [request.requestId],
  );
  const current = selectRes.rows[0];
  if (current === undefined) {
    return { ok: false, code: 'not_found', from: null, action: request.action };
  }

  // 2. Decision authorization (PL-251, AD-27 — and PL-274, B-1): a
  //     decision is legal only from the request's currently assigned
  //     approver, resolved to a staff identity by the caller — and
  //     never from the request's own creator, even when routing
  //     assigned them. The check lives here, at the chokepoint, because
  //     a rule held by memory in two handlers fails in the third
  //     (Sprint 2 F-1).
  //
  //     It runs BEFORE the idempotent-replay short-circuit and before
  //     the illegal-transition classification (PL-274). The Sprint 3.1
  //     evaluation put a door in front of the lock: the replay branch
  //     returned a success shape before these checks ran, so a
  //     non-assignee or the creator re-deciding an already-decided
  //     request got "Decision recorded" and a success:idempotent audit
  //     row. The state never changed — but the audit recorded a
  //     successful decision by someone with no right to make it, and
  //     the audit trail was the thing corrupted. Authorization first;
  //     idempotency is a courtesy for the actor entitled to it.
  if (DECISION_ACTIONS.includes(request.action)) {
    if (request.actorIdentityId === undefined) {
      return {
        ok: false,
        code: 'missing_field',
        from: current.state,
        action: request.action,
        field: 'actorIdentityId',
      };
    }
    if (request.actorIdentityId !== current.assigned_approver_id) {
      await insertPickupRequestEvent(client, {
        requestId: current.id,
        escalationLevel: null,
        eventType: 'refused',
        actor: request.actor,
        channel,
      });
      return {
        ok: false,
        code: 'not_assigned_approver',
        from: current.state,
        action: request.action,
      };
    }
    // The creator is the `routed` event's actor — the subject that
    // routed the request. A decider equal to it is self-approval even
    // when they are the assignee; the request escalates instead.
    const creator = await requestCreatorSubject(client, current.id);
    if (creator !== null && creator === request.actor) {
      await insertPickupRequestEvent(client, {
        requestId: current.id,
        escalationLevel: null,
        eventType: 'refused',
        actor: request.actor,
        channel,
      });
      return {
        ok: false,
        code: 'self_approval',
        from: current.state,
        action: request.action,
      };
    }
  }

  // 3. Idempotent replay of the settled outcome — a no-op success,
  //     reachable now only by the actor the checks above authorized
  //     (PL-274). The Slack at-least-once case and a double-click in
  //     the app both return the current state for the ASSIGNEE; anyone
  //     else replaying was already refused above.
  if (request.action !== 'escalate' && current.state === def.to) {
    return { ok: true, request: current, idempotent: true };
  }

  // 4. Illegal transition — typed refusal, no state change, and the
  //    attempt is recorded in the event ledger (T-53).
  if (!def.from.includes(current.state)) {
    await insertPickupRequestEvent(client, {
      requestId: current.id,
      escalationLevel: null,
      eventType: 'refused',
      actor: request.actor,
      channel,
    });
    return {
      ok: false,
      code: 'illegal_transition',
      from: current.state,
      action: request.action,
    };
  }

  // 5. Required per-action fields — a caller error, not a machine event.
  if (def.requiresEscalateAt === true && request.escalateAt === undefined) {
    return {
      ok: false,
      code: 'missing_field',
      from: current.state,
      action: request.action,
      field: 'escalateAt',
    };
  }

  // 5. Retention (P3): terminal states purge reason_detail at retention 0.
  const retentionDays = def.terminal ? await getReasonDetailRetentionDays(client) : 0;
  const purgeDetail = def.terminal && retentionDays === 0;

  // 6. Apply. The state guard in the WHERE is the backstop to the lock —
  //    and for decisions, so is the ASSIGNEE guard (PL-275, B-2): the
  //    UPDATE matches only the row the authorization check saw.
  const updated = await applyTransition(client, request, current, purgeDetail);
  if (updated === null) {
    // The row changed under us — re-read and classify.
    const reRead = await findPickupRequestById(client, request.requestId);
    if (reRead === null) {
      return { ok: false, code: 'not_found', from: null, action: request.action };
    }
    // A decision whose UPDATE missed while the state is still legal
    // means the assignee changed between the check and the update —
    // the decider is no longer the assigned approver (B-2's race,
    // caught by the predicate). Refuse, ledger, audit: a stale
    // approver's decision never lands.
    if (
      DECISION_ACTIONS.includes(request.action) &&
      def.from.includes(reRead.state) &&
      reRead.assigned_approver_id !== current.assigned_approver_id
    ) {
      await insertPickupRequestEvent(client, {
        requestId: reRead.id,
        escalationLevel: null,
        eventType: 'refused',
        actor: request.actor,
        channel,
      });
      return {
        ok: false,
        code: 'not_assigned_approver',
        from: reRead.state,
        action: request.action,
      };
    }
    return {
      ok: false,
      code: 'illegal_transition',
      from: reRead.state,
      action: request.action,
    };
  }

  // 7. Ledger the transition. Ladder events carry their level — the
  //    unique constraint rejects a double-fire here, in the database.
  //    A decision's note rides on its event (PL-208).
  const isLadderEvent = request.action === 'route' || request.action === 'escalate';
  await insertPickupRequestEvent(client, {
    requestId: updated.id,
    escalationLevel: isLadderEvent ? updated.escalation_level : null,
    eventType: ACTION_EVENT_TYPES[request.action],
    actor: request.actor,
    channel,
    ...(request.note !== undefined ? { note: request.note } : {}),
  });

  return { ok: true, request: updated, idempotent: false };
}

/**
 * The subject that routed the request — its creator. Read from the
 * `routed` ledger event (the transition table guarantees exactly one:
 * `route` is legal only from `draft`, and the event is written on
 * success). Used by the self-approval check in the chokepoint.
 */
async function requestCreatorSubject(
  client: PoolClient,
  requestId: string,
): Promise<string | null> {
  const res = await client.query<{ actor: string }>(
    `select actor from pickup_request_events
     where request_id = $1 and event_type = 'routed'
     order by created_at asc, id asc
     limit 1`,
    [requestId],
  );
  return res.rows[0]?.actor ?? null;
}

/** Apply one action's UPDATE. Returns null when the state guard rejects. */
async function applyTransition(
  client: PoolClient,
  request: TransitionRequest,
  current: PickupRequest,
  purgeDetail: boolean,
): Promise<PickupRequest | null> {
  // Each action's SET clause, in the order (setSql, params) built below.
  // Decisions carry a THIRD guard (PL-275, B-2): the UPDATE matches only
  // the assignee the authorization check authorized — so a reassignment
  // that somehow lands between check and update makes the UPDATE miss
  // rather than record a stale approver's decision.
  const isDecision = DECISION_ACTIONS.includes(request.action);
  let setSql: string;
  const params: unknown[] = [request.requestId, current.state];
  if (isDecision) params.push(current.assigned_approver_id);

  const param = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  switch (request.action) {
    case 'route':
      setSql = `state = 'routed', escalate_at = ${param(request.escalateAt)},
                assigned_approver_id = coalesce(${param(request.assignedApproverId ?? null)}, assigned_approver_id)`;
      break;
    case 'approve':
      setSql = `state = 'approved', decided_at = now(), decided_by = ${param(request.actor)}`;
      break;
    case 'flag':
      setSql = `state = 'flagged'`;
      break;
    case 'deny':
      setSql = `state = 'denied', decided_at = now(), decided_by = ${param(request.actor)},
                reason_detail = ${purgeDetail ? 'null' : 'reason_detail'}`;
      break;
    case 'release':
      setSql = `state = 'released', released_at = now()`;
      break;
    case 'complete':
      setSql = `state = 'completed', completed_at = now(),
                reason_detail = ${purgeDetail ? 'null' : 'reason_detail'}`;
      break;
    case 'expire':
      setSql = `state = 'expired', expired_at = now(),
                reason_detail = ${purgeDetail ? 'null' : 'reason_detail'}`;
      break;
    case 'stall':
      // Terminal human handoff — purged like every terminal state;
      // decided_by stays null because no decision happened (E3).
      setSql = `state = 'stalled',
                reason_detail = ${purgeDetail ? 'null' : 'reason_detail'}`;
      break;
    case 'escalate':
      setSql = `escalation_level = escalation_level + 1,
                escalate_at = ${param(request.escalateAt)},
                assigned_approver_id = coalesce(${param(request.assignedApproverId ?? null)}, assigned_approver_id)`;
      break;
  }

  const assigneeGuard = isDecision ? ` and assigned_approver_id = $3` : '';
  const res = await client.query<PickupRequest>(
    `update pickup_requests set ${setSql}
     where id = $1 and state = $2${assigneeGuard}
     returning *`,
    params,
  );
  return res.rows.length > 0 ? res.rows[0]! : null;
}

/**
 * The nightly retention sweep (P3): purge `reason_detail` still present
 * once its service date has passed, plus `retention_days` when a tenant
 * has widened the setting. The anchor is the service date — the school
 * day the detail belongs to. Terminal states at retention 0 were already
 * purged by the transition function; this is the hard stop that catches
 * everything else. Returns the number of rows purged.
 */
export async function purgeStaleReasonDetail(client: PoolClient): Promise<number> {
  const retentionDays = await getReasonDetailRetentionDays(client);
  const res = await client.query(
    `update pickup_requests set reason_detail = null
     where reason_detail is not null
       and service_date < current_date - $1::integer`,
    [retentionDays],
  );
  return res.rowCount ?? 0;
}

/** An approver's queue entry (PL-208): the fields the response needs. */
export interface PendingApproval {
  readonly id: string;
  readonly state: PickupRequestState;
  readonly pickup_at: Date;
  readonly reason_category: ReasonCategory;
  readonly escalation_level: number;
  readonly student_name: string;
}

/**
 * The approver's queue for a service date: requests in `routed`, assigned
 * to the named approver (AD-27 — one named approver, so the queue is
 * theirs), ordered by pickup time. The students join is tenant-safe by
 * the composite FK. A read — `state` is never written here (T-55).
 */
export async function listPendingApprovalsForApprover(
  client: PoolClient,
  approverIdentityId: string,
  serviceDate: string,
): Promise<readonly PendingApproval[]> {
  const res = await client.query<PendingApproval>(
    `select pr.id, pr.state, pr.pickup_at, pr.reason_category,
            pr.escalation_level, s.student_name
     from pickup_requests pr
     join students s on s.id = pr.student_id
     where pr.state = 'routed'
       and pr.assigned_approver_id = $1
       and pr.service_date = $2
     order by pr.pickup_at asc, pr.id asc`,
    [approverIdentityId, serviceDate],
  );
  return res.rows;
}

/** A due escalation row, as claimed by the worker (PL-204). */
export interface DueEscalationRow {
  readonly id: string;
  readonly escalation_level: number;
  /** Skip/failure count toward the worker's attempt ceiling (PL-254). */
  readonly escalation_attempts: number;
}

export interface DueEscalationStats {
  readonly claimed: number;
  readonly escalated: number;
  readonly expired: number;
  readonly skipped: number;
  readonly stalled: number;
  readonly failed: number;
}

/**
 * The escalation worker's due queue and transaction mechanics (PL-204).
 *
 * Claims due rows with `FOR UPDATE SKIP LOCKED` inside one transaction,
 * with a SAVEPOINT per row, and processes each through the caller's
 * callback — the worker owns ladder policy; this owns concurrency:
 * two workers racing the same due row means one escalates and the other
 * never sees it (T-61), and a row that throws mid-batch rolls back to
 * its savepoint without sinking the others. `state` is written only by
 * `transitionPickupRequest` through the callback (T-55) — this is the
 * queue, not a state writer.
 *
 * `onRowError` runs after the savepoint rollback, inside the still-open
 * transaction: the worker uses it to write the AD-42 failure audit. It
 * must not throw (the worker's audit catches its own errors).
 *
 * Queue fairness (PL-254): a row that skips or fails does not keep its
 * head-of-line slot. `escalate_at` is deferred `deferralSeconds` and
 * `escalation_attempts` increments — in this transaction, after the
 * savepoint release/rollback, so the deferral is atomic with the batch
 * and a poisoned row can no longer starve the healthy ones behind it
 * (the due query is oldest-first). At the ceiling the worker stalls
 * the row through `transitionPickupRequest` — the queue only counts.
 */
export async function processDueEscalations(
  client: PoolClient,
  batchSize: number,
  deferralSeconds: number,
  processRow: (
    client: PoolClient,
    row: DueEscalationRow,
  ) => Promise<'escalated' | 'expired' | 'skipped' | 'stalled'>,
  onRowError: (client: PoolClient, row: DueEscalationRow, err: unknown) => Promise<void>,
): Promise<DueEscalationStats> {
  const stats = {
    claimed: 0,
    escalated: 0,
    expired: 0,
    skipped: 0,
    stalled: 0,
    failed: 0,
  };

  const deferRow = async (rowId: string): Promise<void> => {
    await client.query(
      `update pickup_requests
       set escalation_attempts = escalation_attempts + 1,
           escalate_at = now() + ($2 || ' seconds')::interval
       where id = $1 and state = 'routed'`,
      [rowId, deferralSeconds],
    );
  };

  await client.query('begin');
  try {
    const due = await client.query<DueEscalationRow>(
      `select id, escalation_level, escalation_attempts from pickup_requests
       where state = 'routed' and escalate_at < now()
       order by escalate_at asc
       limit $1
       for update skip locked`,
      [batchSize],
    );
    stats.claimed = due.rows.length;

    for (const row of due.rows) {
      await client.query('savepoint escalation_row');
      try {
        const outcome = await processRow(client, row);
        if (outcome === 'escalated') stats.escalated += 1;
        else if (outcome === 'expired') stats.expired += 1;
        else if (outcome === 'stalled') stats.stalled += 1;
        else stats.skipped += 1;
        await client.query('release savepoint escalation_row');
        if (outcome === 'skipped') await deferRow(row.id);
      } catch (err) {
        await client.query('rollback to savepoint escalation_row');
        stats.failed += 1;
        await deferRow(row.id);
        await onRowError(client, row, err);
      }
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  }

  return stats;
}
