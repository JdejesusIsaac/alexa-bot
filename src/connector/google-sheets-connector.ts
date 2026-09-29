/**
 * Google Sheets connector (PL-005).
 *
 * Read-only access to Google Sheets via the googleapis SDK using a service
 * account. The service account key is read from a FILE — the path arrives
 * via `GOOGLE_SERVICE_ACCOUNT_FILE` (e.g. `./secrets/sa.json`, gitignored).
 * The key itself never sits in an environment variable: a variable listing
 * is a private key printed to a terminal (F-8).
 *
 * Auth failures, not-found, and network errors surface as typed errors
 * (ConnectorAuthError, ConnectorNotFoundError, ConnectorNetworkError) —
 * never as unhandled crashes (Rule 10).
 *
 * The connector returns raw rows. Column mapping, validation, and
 * advisor-notes exclusion happen downstream.
 */

import { readFileSync } from 'node:fs';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import type { sheets_v4 } from 'googleapis';
import {
  type SheetConnector,
  type SheetData,
  ConnectorAuthError,
  ConnectorNotFoundError,
  ConnectorNetworkError,
} from './sheet-connector.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

export class GoogleSheetsConnector implements SheetConnector {
  private readonly sheets: sheets_v4.Sheets;

  /**
   * @param serviceAccountFile - Path to the Google service account key file
   *   (`GOOGLE_SERVICE_ACCOUNT_FILE`). Error messages name the variable and
   *   the path — never the file's contents, which carry a private key.
   */
  constructor(serviceAccountFile: string) {
    let raw: string;
    try {
      raw = readFileSync(serviceAccountFile, 'utf-8');
    } catch {
      throw new ConnectorAuthError(
        `GOOGLE_SERVICE_ACCOUNT_FILE is not readable: ${serviceAccountFile}`,
      );
    }

    let credentials: Record<string, string>;
    try {
      credentials = JSON.parse(raw) as Record<string, string>;
    } catch {
      throw new ConnectorAuthError(
        `GOOGLE_SERVICE_ACCOUNT_FILE is not valid JSON: ${serviceAccountFile}`,
      );
    }

    const email = credentials.client_email;
    const key = credentials.private_key;
    if (!email || !key) {
      throw new ConnectorAuthError(
        `GOOGLE_SERVICE_ACCOUNT_FILE is missing client_email or private_key: ${serviceAccountFile}`,
      );
    }

    const auth = new JWT(email, undefined, key, SCOPES);

    this.sheets = google.sheets({ version: 'v4', auth });
  }

  async fetchSheet(sheetId: string, range: string): Promise<SheetData> {
    try {
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range,
      });

      const values = res.data.values;
      if (!values || values.length === 0) {
        return { headers: [], rows: [] };
      }

      const headers = (values[0] ?? []).map((v) => String(v ?? ''));
      const rows = values.slice(1).map((row) => row.map((v) => String(v ?? '')));

      return { headers, rows };
    } catch (err: unknown) {
      throw mapError(err);
    }
  }
}

function mapError(err: unknown): never {
  const e = err as { code?: number; status?: string; message?: string };

  const code = e?.code;
  const status = e?.status;

  if (code === 401 || code === 403 || status === 'PERMISSION_DENIED') {
    throw new ConnectorAuthError(e?.message ?? 'Google Sheets auth failure');
  }
  if (code === 404 || status === 'NOT_FOUND') {
    throw new ConnectorNotFoundError(e?.message ?? 'Sheet not found');
  }

  throw new ConnectorNetworkError(e?.message ?? 'Unexpected Google Sheets API error');
}
