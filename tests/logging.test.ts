import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging/logger.js';
import type { Config } from '../src/config.js';

/**
 * PL-010 tests — structured logging with redaction.
 *
 * T-09: No student PII in logs. Capture all log output across multiple
 * log calls including forced error paths. Scan for fixture student names
 * and refs. Pass: zero matches; tenant_id present on every line.
 *
 * Synthetic data only.
 */

function makeConfig(level: Config['logLevel'] = 'debug'): Pick<Config, 'logLevel'> {
  return { logLevel: level };
}

function captureStream(): { stream: NodeJS.WritableStream; lines: string[] } {
  const lines: string[] = [];
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, lines };
}

function parseLines(lines: string[]): Record<string, unknown>[] {
  return lines
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l.trim()));
}

const STUDENT_NAMES = [
  'Jordan Smith',
  'Maria Gonzalez',
  'Tyler Nguyen',
  'Aisha Mohammed',
  'Devon Walker',
  'Samuel Park',
  'Emma Wilson',
  'Liam Brown',
];

const STUDENT_REFS = [
  'A001', 'A002', 'A003', 'A004', 'A007', 'A008',
  'B001', 'B002', 'B003', 'B004', 'B007',
];

// ── T-09: No student PII in logs ───────────────────────────────────

describe('T-09 · Redacts PII keys; string-scan covers fixture data only', () => {
  it('redacts student_name and student_ref in log payloads', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger(makeConfig(), stream);

    logger.info({
      msg: 'scholar status lookup',
      tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      request_id: 'req-1',
      student_name: 'Jordan Smith',
      student_ref: 'A001',
      outcome: 'success',
    });

    const parsed = parseLines(lines);
    expect(parsed).toHaveLength(1);

    const logStr = lines[0]!;
    for (const name of STUDENT_NAMES) {
      expect(logStr).not.toContain(name);
    }
    for (const ref of STUDENT_REFS) {
      expect(logStr).not.toContain(ref);
    }

    expect(parsed[0]!.student_name).toBe('[REDACTED]');
    expect(parsed[0]!.student_ref).toBe('[REDACTED]');
    expect(parsed[0]!.tenant_id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('redacts student PII nested inside objects and arrays', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger(makeConfig(), stream);

    logger.info({
      msg: 'batch lookup',
      tenant_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      request_id: 'req-2',
      students: [
        { student_name: 'Maria Gonzalez', student_ref: 'A003' },
        { student_name: 'Tyler Nguyen', student_ref: 'A004' },
      ],
      outcome: 'success',
    });

    const logStr = lines[0]!;
    expect(logStr).not.toContain('Maria Gonzalez');
    expect(logStr).not.toContain('Tyler Nguyen');
    expect(logStr).not.toContain('A003');
    expect(logStr).not.toContain('A004');

    const parsed = parseLines(lines);
    const students = parsed[0]!.students as Record<string, unknown>[];
    expect(students[0]!.student_name).toBe('[REDACTED]');
    expect(students[0]!.student_ref).toBe('[REDACTED]');
    expect(students[1]!.student_name).toBe('[REDACTED]');
  });

  it('redacts student names and refs interpolated in message strings', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger(makeConfig(), stream);

    logger.warn({
      msg: 'scholar Jordan Smith (A001) not found in roster',
      tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      request_id: 'req-3',
      outcome: 'refusal:not_found',
    });

    const logStr = lines[0]!;
    expect(logStr).not.toContain('Jordan Smith');
    expect(logStr).not.toContain('A001');
    expect(logStr).toContain('[REDACTED]');
  });

  it('redacts student PII in error stack traces', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger(makeConfig(), stream);

    const err = new Error('Failed to process row for Maria Gonzalez ref A003');
    logger.error({
      msg: 'row processing failed',
      tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      request_id: 'req-4',
      error: err,
      student_name: 'Maria Gonzalez',
      student_ref: 'A003',
      outcome: 'error',
    });

    const logStr = lines[0]!;
    expect(logStr).not.toContain('Maria Gonzalez');
    expect(logStr).not.toContain('A003');
  });

  it('includes tenant_id on every log line', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger(makeConfig(), stream);

    logger.info({ msg: 'lookup', tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', request_id: 'r1' });
    logger.warn({ msg: 'stale', tenant_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', request_id: 'r2' });
    logger.error({ msg: 'fail', tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', request_id: 'r3' });
    logger.debug({ msg: 'trace', tenant_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', request_id: 'r4' });

    const parsed = parseLines(lines);
    expect(parsed).toHaveLength(4);
    for (const entry of parsed) {
      expect(entry.tenant_id).toBeDefined();
      expect(typeof entry.tenant_id).toBe('string');
      expect(entry.time).toBeDefined();
      expect(entry.level).toBeDefined();
    }
  });

  it('respects log level filtering', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger(makeConfig('warn'), stream);

    logger.debug({ msg: 'debug', tenant_id: 't1' });
    logger.info({ msg: 'info', tenant_id: 't1' });
    logger.warn({ msg: 'warn', tenant_id: 't1' });
    logger.error({ msg: 'error', tenant_id: 't1' });

    const parsed = parseLines(lines);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.level).toBe('warn');
    expect(parsed[1]!.level).toBe('error');
  });

  it('includes duration_ms and outcome when provided', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger(makeConfig(), stream);

    logger.info({
      msg: 'getScholarStatus',
      tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      request_id: 'req-5',
      duration_ms: 42,
      outcome: 'success',
    });

    const parsed = parseLines(lines);
    expect(parsed[0]!.duration_ms).toBe(42);
    expect(parsed[0]!.outcome).toBe('success');
  });

  it('redacts advisor_notes key', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger(makeConfig(), stream);

    logger.info({
      msg: 'row mapped',
      tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      advisor_notes: 'Mom called re custody',
    });

    const parsed = parseLines(lines);
    expect(parsed[0]!.advisor_notes).toBe('[REDACTED]');
    expect(lines[0]).not.toContain('Mom called re custody');
  });

  it('simulates T-09: 50 lookups + error paths, zero PII matches', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger(makeConfig(), stream);

    const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    // Simulate 50 lookups with student data in payloads
    for (let i = 0; i < 50; i++) {
      const ref = STUDENT_REFS[i % STUDENT_REFS.length]!;
      const name = STUDENT_NAMES[i % STUDENT_NAMES.length]!;

      logger.info({
        msg: `lookup #${i}`,
        tenant_id: tenantId,
        request_id: `req-${i}`,
        student_name: name,
        student_ref: ref,
        duration_ms: Math.floor(Math.random() * 100),
        outcome: i % 10 === 0 ? 'refusal:stale' : 'success',
      });
    }

    // Force error paths with PII in messages and errors
    for (const name of STUDENT_NAMES) {
      logger.error({
        msg: `processing failed for ${name}`,
        tenant_id: tenantId,
        request_id: 'err',
        error: new Error(`Row for ${name} failed validation`),
        outcome: 'error',
      });
    }

    // Scan every line for every student name and ref
    for (const line of lines) {
      for (const name of STUDENT_NAMES) {
        expect(line).not.toContain(name);
      }
      for (const ref of STUDENT_REFS) {
        expect(line).not.toContain(ref);
      }
    }

    // Verify tenant_id present on every line
    const parsed = parseLines(lines);
    expect(parsed.length).toBe(50 + STUDENT_NAMES.length);
    for (const entry of parsed) {
      expect(entry.tenant_id).toBe(tenantId);
    }
  });
});
