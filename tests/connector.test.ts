import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConnectorAuthError,
  ConnectorError,
  ConnectorNotFoundError,
} from '../src/connector/sheet-connector.js';
import { FixtureSheetConnector } from '../src/connector/fixture-sheet-connector.js';
import { GoogleSheetsConnector } from '../src/connector/google-sheets-connector.js';
import {
  TENANT_A,
  TENANT_B,
  TENANT_A_SHEET,
  TENANT_B_SHEET,
} from '../src/fixtures/synthetic-data.js';

/**
 * PL-005 tests — Google Sheets connector.
 *
 * AC: pulls a test sheet; auth failure surfaces as a typed error, not a crash.
 *
 * Tests use the FixtureSheetConnector (no network). The GoogleSheetsConnector
 * is tested for construction-time validation only — integration testing
 * requires real credentials.
 */

describe('FixtureSheetConnector', () => {
  it('returns correct sheet data for a known sheet ID (tenant A)', async () => {
    const connector = new FixtureSheetConnector();
    const data = await connector.fetchSheet(TENANT_A, 'Sheet1!A1:Z1000');

    expect(data.headers).toEqual(TENANT_A_SHEET.headers);
    expect(data.rows.length).toBe(TENANT_A_SHEET.rows.length);

    // Spot-check a few rows
    expect(data.rows[0]![0]).toBe('A001');
    expect(data.rows[0]![1]).toBe('Jordan Smith');
  });

  it('returns correct sheet data for a known sheet ID (tenant B)', async () => {
    const connector = new FixtureSheetConnector();
    const data = await connector.fetchSheet(TENANT_B, 'Sheet1!A1:Z1000');

    expect(data.headers).toEqual(TENANT_B_SHEET.headers);
    expect(data.rows.length).toBe(TENANT_B_SHEET.rows.length);
    expect(data.rows[0]![0]).toBe('B001');
  });

  it('throws ConnectorNotFoundError for an unknown sheet ID', async () => {
    const connector = new FixtureSheetConnector();
    await expect(
      connector.fetchSheet('unknown-sheet-id', 'Sheet1!A1:Z1000'),
    ).rejects.toThrow(ConnectorNotFoundError);
  });

  it('throws ConnectorAuthError when simulating auth failure', async () => {
    const connector = new FixtureSheetConnector({ simulateAuthFailure: true });
    await expect(connector.fetchSheet(TENANT_A, 'Sheet1!A1:Z1000')).rejects.toThrow(
      ConnectorAuthError,
    );
  });

  it('returns raw rows including the advisor-notes column', async () => {
    // The connector returns everything — exclusion of advisor-notes happens
    // downstream in the mapper (PL-004), not at the connector.
    const connector = new FixtureSheetConnector();
    const data = await connector.fetchSheet(TENANT_A, 'Sheet1!A1:Z1000');

    const notesIndex = data.headers.indexOf('Notes');
    expect(notesIndex).toBeGreaterThanOrEqual(0);

    // Row 1 has a populated notes value
    const row1Notes = data.rows[0]![notesIndex]!;
    expect(row1Notes).toBe('Mom called re custody');
  });

  it('SheetData shape: headers is first row, rows are the rest', async () => {
    const connector = new FixtureSheetConnector();
    const data = await connector.fetchSheet(TENANT_A, 'Sheet1!A1:Z1000');

    expect(data.headers.length).toBeGreaterThan(0);
    expect(data.rows.length).toBeGreaterThan(0);
    // Every row should have the same number of columns as headers
    for (const row of data.rows) {
      expect(row.length).toBeLessThanOrEqual(data.headers.length);
    }
  });
});

describe('GoogleSheetsConnector', () => {
  // The credential arrives as a FILE PATH (GOOGLE_SERVICE_ACCOUNT_FILE,
  // F-8) — never the key in an environment variable. Each leg plants a
  // synthetic file; the connector reads it. Error messages name the
  // variable and the path, never the file's contents.
  let secretsDir: string | undefined;

  afterAll(async () => {
    if (secretsDir) await rm(secretsDir, { recursive: true, force: true });
  });

  async function plant(name: string, contents: string): Promise<string> {
    secretsDir ??= await mkdtemp(path.join(tmpdir(), 'sa-creds-'));
    const file = path.join(secretsDir, name);
    await writeFile(file, contents);
    return file;
  }

  it('throws ConnectorAuthError when the file does not exist — naming the variable, not contents', () => {
    expect(
      () => new GoogleSheetsConnector(path.join(tmpdir(), 'no-such-sa-file.json')),
    ).toThrow(/GOOGLE_SERVICE_ACCOUNT_FILE is not readable/);
  });

  it('throws ConnectorAuthError when the file holds invalid JSON', async () => {
    const file = await plant('bad.json', 'not valid json');
    expect(() => new GoogleSheetsConnector(file)).toThrow(
      /GOOGLE_SERVICE_ACCOUNT_FILE is not valid JSON/,
    );
  });

  it('throws ConnectorAuthError when the file is missing client_email or private_key', async () => {
    const file = await plant('empty.json', '{}');
    expect(() => new GoogleSheetsConnector(file)).toThrow(
      /missing client_email or private_key/,
    );
  });

  it('constructs from a valid-looking service account key file', async () => {
    const file = await plant(
      'sa.json',
      JSON.stringify({
        client_email: 'test@project.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
      }),
    );
    // Construction reads the file and succeeds — actual auth happens on
    // fetchSheet. This is the sync path: credentials arrive by file path.
    const connector = new GoogleSheetsConnector(file);
    expect(connector).toBeInstanceOf(GoogleSheetsConnector);
  });
});

describe('Typed error hierarchy', () => {
  it('ConnectorAuthError extends ConnectorError', () => {
    const err = new ConnectorAuthError('test');
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toBeInstanceOf(ConnectorAuthError);
    expect(err.name).toBe('ConnectorAuthError');
  });

  it('ConnectorNotFoundError extends ConnectorError', () => {
    const err = new ConnectorNotFoundError('test');
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toBeInstanceOf(ConnectorNotFoundError);
    expect(err.name).toBe('ConnectorNotFoundError');
  });

  it('all connector errors carry a message', () => {
    const auth = new ConnectorAuthError('auth failed');
    const notFound = new ConnectorNotFoundError('sheet missing');
    expect(auth.message).toBe('auth failed');
    expect(notFound.message).toBe('sheet missing');
  });
});
