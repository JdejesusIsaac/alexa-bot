/**
 * Fixture sheet connector (PL-005).
 *
 * Implements `SheetConnector` using the synthetic fixture data from
 * `src/fixtures/synthetic-data.ts`. Used in tests and seeding — no network
 * access, no credentials.
 *
 * The sheet ID maps to a tenant fixture. Unknown sheet IDs throw
 * `ConnectorNotFoundError`. Auth failure can be simulated by constructing
 * with `simulateAuthFailure: true`.
 */

import {
  type SheetConnector,
  type SheetData,
  ConnectorAuthError,
  ConnectorNotFoundError,
} from './sheet-connector.js';
import { FIXTURES, type SheetRow } from '../fixtures/synthetic-data.js';

export class FixtureSheetConnector implements SheetConnector {
  private readonly sheets: ReadonlyMap<string, SheetRow>;
  private readonly simulateAuthFailure: boolean;

  constructor(opts?: { simulateAuthFailure?: boolean }) {
    this.simulateAuthFailure = opts?.simulateAuthFailure ?? false;
    const map = new Map<string, SheetRow>();
    for (const f of FIXTURES) {
      map.set(f.tenantId, f.sheet);
    }
    this.sheets = map;
  }

  async fetchSheet(sheetId: string, _range: string): Promise<SheetData> {
    if (this.simulateAuthFailure) {
      throw new ConnectorAuthError('simulated auth failure');
    }

    const sheet = this.sheets.get(sheetId);
    if (!sheet) {
      throw new ConnectorNotFoundError(`unknown sheet ID: ${sheetId}`);
    }

    return {
      headers: sheet.headers,
      rows: sheet.rows,
    };
  }
}
