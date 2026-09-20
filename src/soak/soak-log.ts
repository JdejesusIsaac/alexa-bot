/**
 * Soak log persistence — one markdown table row per business day.
 *
 * Markdown rather than JSON because this artifact is read by humans and
 * quoted in evaluations. The table is parsed back on each run so the day
 * counter survives without a second source of truth.
 *
 * The log records `tenant_id`, counts, and timings only. No student refs,
 * no names — a soak artifact is exactly the kind of file that gets pasted
 * into a report, so it must be safe by construction.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOAK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'soak');
const LOG_PATH = path.join(SOAK_DIR, 'soak-log.md');

export interface SoakTenantSummary {
  readonly tenantId: string;
  readonly calls: number;
  readonly successes: number;
  readonly refusals: number;
}

export interface SoakDayRecord {
  readonly date: string;
  readonly dayNumber: number;
  readonly counts: boolean;
  readonly calls: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly auditCompleteness: number;
  readonly leakage: 'clean' | 'LEAKED';
  readonly tenants: readonly SoakTenantSummary[];
}

const HEADER = `# Soak log — Sprint 1 exit criterion 1

> \`npm run soak:day\`, once per business day. Ten counted days closes the soak.
> Synthetic fixture data only. This file records tenant ids, counts, and timings —
> never student refs or names.

| Date | Day | Counts | Calls | p50 ms | p95 ms | Audit | Leakage |
| ---- | --- | ------ | ----- | ------ | ------ | ----- | ------- |
`;

const ROW_RE =
  /^\| (\d{4}-\d{2}-\d{2}) \| (\d+) \| (yes|no) \| (\d+) \| ([\d.]+) \| ([\d.]+) \| ([\d.]+)% \| (clean|LEAKED) \|$/;

function formatRow(d: SoakDayRecord): string {
  const audit = (d.auditCompleteness * 100).toFixed(1);
  return `| ${d.date} | ${d.dayNumber} | ${d.counts ? 'yes' : 'no'} | ${d.calls} | ${d.p50Ms.toFixed(2)} | ${d.p95Ms.toFixed(2)} | ${audit}% | ${d.leakage} |`;
}

/** Parse the recorded days back out of the markdown table. */
export async function readSoakLog(): Promise<readonly SoakDayRecord[]> {
  let raw: string;
  try {
    raw = await readFile(LOG_PATH, 'utf8');
  } catch {
    return [];
  }

  const days: SoakDayRecord[] = [];
  for (const line of raw.split('\n')) {
    const m = ROW_RE.exec(line.trim());
    if (!m) continue;
    days.push({
      date: m[1]!,
      dayNumber: Number(m[2]),
      counts: m[3] === 'yes',
      calls: Number(m[4]),
      p50Ms: Number(m[5]),
      p95Ms: Number(m[6]),
      auditCompleteness: Number(m[7]) / 100,
      leakage: m[8] as 'clean' | 'LEAKED',
      tenants: [],
    });
  }
  return days;
}

/**
 * Append a day, or replace the row for a date already present. Rewrites
 * the whole file from parsed state so the table can never drift.
 */
export async function appendSoakDay(record: SoakDayRecord): Promise<void> {
  const existing = await readSoakLog();
  const kept = existing.filter((d) => d.date !== record.date);
  const all = [...kept, record].sort((a, b) => a.date.localeCompare(b.date));

  const counted = all.filter((d) => d.counts).length;
  const body = all.map(formatRow).join('\n');
  const footer = `\n\n**Counted business days: ${counted} / 10.**${
    counted >= 10 ? ' Soak complete — Sprint 1 exit criterion 1 met.' : ''
  }\n`;

  await mkdir(SOAK_DIR, { recursive: true });
  await writeFile(LOG_PATH, `${HEADER}${body}${footer}`, 'utf8');
}
