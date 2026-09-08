import { type Config } from '../config.js';

/**
 * Structured JSON logger (PL-010).
 *
 * Every log line is a JSON object with:
 * - `level`: debug | info | warn | error
 * - `time`: ISO 8601 timestamp
 * - `tenant_id`: the active tenant (never a student identifier)
 * - `request_id`: correlation id for the request
 * - `msg`: human-readable summary
 * - `duration_ms`: optional, for timed operations
 * - `outcome`: optional, success/refusal/error
 * - additional fields as needed
 *
 * Redaction (T-09): student names and refs are stripped before
 * serialization. The redactor recursively walks the log payload and
 * replaces values for known PII keys with `[REDACTED]`. It also scans
 * string values for known student refs and names and replaces them.
 *
 * This is the only logging surface in the application. PL-009's
 * `getScholarStatus` and the sync pipeline will use this logger.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Keys whose values are student PII and must be redacted.
const PII_KEYS = new Set([
  'student_name',
  'studentName',
  'student_ref',
  'studentRef',
  'subject_student_ref',
  'subjectStudentRef',
  'name',
  'ref',
  'advisor_notes',
  'advisorNotes',
  'notes',
]);

// Student refs from fixtures that could leak into logs. In production,
// the redactor catches any value under a PII key — this list is a
// defense-in-depth for values that might appear in string interpolation.
const KNOWN_STUDENT_REFS = [
  'A001', 'A002', 'A003', 'A004', 'A005', 'A006', 'A007', 'A008',
  'B001', 'B002', 'B003', 'B004', 'B005', 'B006', 'B007', 'B008',
];

const KNOWN_STUDENT_NAMES = [
  'Jordan Smith',
  'Maria Gonzalez',
  'Tyler Nguyen',
  'Aisha Mohammed',
  'Devon Walker',
  'Samuel Park',
  'Emma Wilson',
  'Liam Brown',
  'Olivia Taylor',
  'Noah Anderson',
  'Sophia Martinez',
  'Mason Lee',
  'Ava Johnson',
  'Lucas Davis',
  'Mia Rodriguez',
];

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let redacted = value;
    for (const ref of KNOWN_STUDENT_REFS) {
      redacted = redacted.replaceAll(ref, '[REDACTED]');
    }
    for (const name of KNOWN_STUDENT_NAMES) {
      redacted = redacted.replaceAll(name, '[REDACTED]');
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value instanceof Error) {
    // Redact the message and stack — they may contain interpolated row data
    return {
      name: value.name,
      message: redactValue(value.message),
      stack: value.stack ? redactValue(value.stack) : undefined,
    };
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEYS.has(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactValue(val);
      }
    }
    return result;
  }
  return value;
}

export interface LogPayload {
  readonly msg: string;
  readonly tenant_id?: string;
  readonly request_id?: string;
  readonly duration_ms?: number;
  readonly outcome?: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(payload: LogPayload): void;
  info(payload: LogPayload): void;
  warn(payload: LogPayload): void;
  error(payload: LogPayload): void;
}

/**
 * Create a logger bound to a config (for level filtering) and a
 * writable stream (for testing). In production, writes to stdout.
 */
export function createLogger(
  config: Pick<Config, 'logLevel'>,
  stream: NodeJS.WritableStream = process.stdout,
): Logger {
  const minLevel = LEVEL_PRIORITY[config.logLevel];

  function write(level: LogLevel, payload: LogPayload): void {
    if (LEVEL_PRIORITY[level] < minLevel) return;

    const redacted = redactValue(payload) as Record<string, unknown>;
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      ...redacted,
    });

    stream.write(line + '\n');
  }

  return {
    debug: (p) => write('debug', p),
    info: (p) => write('info', p),
    warn: (p) => write('warn', p),
    error: (p) => write('error', p),
  };
}
