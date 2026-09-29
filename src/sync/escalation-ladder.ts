import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * The escalation ladder (PL-204) — required configuration, no default.
 *
 * The ladder is a P2 decision: which rungs, what intervals, what
 * happens at the top. We can propose one; we must not pick one
 * (plan, PL-204). This module makes that structural:
 *
 *  - The worker CANNOT start without a written ladder —
 *    `loadEscalationLadder` fails loudly at boot, naming the file.
 *    A worker that boots and declines each row looks alive on a
 *    dashboard, and someone will eventually "fix" it with a default;
 *    refusing to start cannot be fixed that way.
 *  - The fixture ladder (`src/fixtures/escalation-ladder.FIXTURE.json`)
 *    has an obviously-fake shape — 1- and 2-minute rungs, approvers
 *    named `FIXTURE_VP` — so a fixture can never be mistaken for a
 *    campus's real policy, because at some point someone will copy it.
 *
 * Shape: `rungs[i]` describes level i+1 — the approver who owns that
 * level and the clock granted on arrival. A row at level L, when due,
 * escalates to rungs[L] (level L+1); a row already at the top level
 * expires (AD-26: expiry never approves — it terminates to in-person
 * handling).
 */

export interface EscalationRung {
  /** 1-based ladder level this rung defines. */
  readonly level: number;
  /** Clock granted on arrival at this level, in minutes. */
  readonly afterMinutes: number;
  /** The audit subject of the approver who owns this level. */
  readonly approverSubject: string;
}

export interface EscalationLadder {
  readonly rungs: readonly EscalationRung[];
  /**
   * The level-0 clock (PL-253): the minutes the first named approver
   * gets before rung 1 fires. Route sets
   * `escalate_at = min(pickup_at, now + initial_minutes)` — escalation
   * begins before the parent is due, which is the point of the sprint.
   */
  readonly initialMinutes: number;
  /** Where this ladder was loaded from — named in every error. */
  readonly source: string;
}

const rungSchema = z.object({
  level: z.number().int().positive(),
  after_minutes: z.number().int().positive(),
  approver_subject: z.string().min(1),
});

const ladderFileSchema = z.object({
  note: z.string().optional(),
  /**
   * The level-0 deadline in minutes (PL-253). Required — the level-0
   * clock is policy, and policy lives in this file, not in a default.
   */
  initial_minutes: z.number().int().positive(),
  rungs: z.array(rungSchema),
});

/**
 * Load and validate the written ladder. Throws loudly — naming the
 * file — on a missing file, unparseable JSON, a schema violation, or
 * non-contiguous levels. The caller is the worker's boot path; the
 * throw IS the refusal to start.
 */
export function parseEscalationLadder(rawJson: string, source: string): EscalationLadder {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(
      `escalation ladder ${source} is not valid JSON — the worker refuses to start: ${err instanceof Error ? err.message : 'unknown parse error'}`,
    );
  }

  const result = ladderFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(
      `escalation ladder ${source} is invalid — the worker refuses to start: ${issues}`,
    );
  }

  const rungs: EscalationRung[] = result.data.rungs.map((r) => ({
    level: r.level,
    afterMinutes: r.after_minutes,
    approverSubject: r.approver_subject,
  }));

  // Levels must be contiguous from 1 — a gap or a duplicate is a
  // policy transcription error, not a valid ladder.
  for (let i = 0; i < rungs.length; i += 1) {
    if (rungs[i]!.level !== i + 1) {
      throw new Error(
        `escalation ladder ${source} is invalid — the worker refuses to start: rung levels must be contiguous from 1 (rung ${i} has level ${rungs[i]!.level})`,
      );
    }
  }

  return { rungs, initialMinutes: result.data.initial_minutes, source };
}

export async function loadEscalationLadder(filePath: string): Promise<EscalationLadder> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `escalation ladder file ${filePath} could not be read — the worker refuses to start: ${err instanceof Error ? err.message : 'unknown read error'}`,
    );
  }
  return parseEscalationLadder(raw, filePath);
}

/**
 * Per-tenant ladders (PL-254): `<dir>/<tenant_id>.json` for every
 * configured tenant. One shared file cannot carry per-tenant approver
 * subjects — a worker covering two tenants would skip every row of
 * the second. A tenant missing its file is a boot refusal naming the
 * tenant and the path it expected; a silently absent ladder is the
 * same invented-default failure the single-file refusal guards.
 */
export async function loadEscalationLaddersFromDir(
  dir: string,
  tenantIds: readonly string[],
): Promise<Map<string, EscalationLadder>> {
  const ladders = new Map<string, EscalationLadder>();
  for (const tenantId of tenantIds) {
    const filePath = `${dir}/${tenantId}.json`;
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      // Missing OR unreadable — both are the same boot refusal, naming
      // the tenant and the path it expected.
      throw new Error(
        `no escalation ladder for tenant ${tenantId} — expected ${filePath}. ` +
          'Every WORKER_TENANTS entry needs a written ladder; the worker refuses to start.',
      );
    }
    ladders.set(tenantId, parseEscalationLadder(raw, filePath));
  }
  return ladders;
}

/**
 * Every `*.json` in the directory, keyed by tenant id (the file's
 * basename) — the web process's level-0 clock map (PL-254): a tenant
 * with a written ladder gets its own `initial_minutes`; a tenant
 * without one falls back to `pickup_at` with the unconfigured warning.
 * Invalid files still refuse loudly, naming the file.
 */
export async function loadAllEscalationLaddersFromDir(
  dir: string,
): Promise<Record<string, EscalationLadder>> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  const ladders: Record<string, EscalationLadder> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const tenantId = entry.name.slice(0, -'.json'.length);
    ladders[tenantId] = await loadEscalationLadder(`${dir}/${entry.name}`);
  }
  return ladders;
}

/**
 * The worker's per-tenant boot path (PL-254): ESCALATION_LADDER_DIR +
 * WORKER_TENANTS. Both unset/missing is a refusal, named.
 */
export async function loadEscalationLaddersFromEnv(
  tenantIds: readonly string[],
): Promise<Map<string, EscalationLadder>> {
  const dir = process.env.ESCALATION_LADDER_DIR;
  if (dir === undefined || dir.length === 0) {
    throw new Error(
      'ESCALATION_LADDER_DIR is not set — the escalation worker refuses to start. ' +
        'Each tenant in WORKER_TENANTS needs <dir>/<tenant_id>.json; ' +
        'fixture ladders live at src/fixtures/escalation/ (obviously fake, by design).',
    );
  }
  return loadEscalationLaddersFromDir(dir, tenantIds);
}
