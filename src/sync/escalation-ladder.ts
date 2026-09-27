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

  return { rungs, source };
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
 * The worker's boot path: ESCALATION_LADDER_FILE must point at the
 * written ladder. Unset is not a default — it is a refusal to start,
 * naming the variable and the file that was expected.
 */
export async function loadEscalationLadderFromEnv(): Promise<EscalationLadder> {
  const filePath = process.env.ESCALATION_LADDER_FILE;
  if (filePath === undefined || filePath.length === 0) {
    throw new Error(
      'ESCALATION_LADDER_FILE is not set — the escalation worker refuses to start. ' +
        'The ladder is a P2 decision recorded in writing; point ESCALATION_LADDER_FILE at it. ' +
        'Tests use src/fixtures/escalation-ladder.FIXTURE.json (obviously fake, by design).',
    );
  }
  return loadEscalationLadder(filePath);
}
