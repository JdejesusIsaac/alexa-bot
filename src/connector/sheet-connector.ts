/**
 * Sheet connector interface (PL-005).
 *
 * The connector fetches raw rows from a spreadsheet source. It returns
 * headers + data rows with no transformation — column mapping, validation,
 * and advisor-notes exclusion all happen downstream (PL-004 mapper, PL-006
 * validation).
 *
 * Two implementations:
 *  - `GoogleSheetsConnector` — production, uses googleapis SDK with a
 *    service account (read-only scope).
 *  - `FixtureSheetConnector` — test/seed, returns synthetic data from
 *    `src/fixtures/synthetic-data.ts`.
 *
 * No `tenant_id` in any signature (Rule 7). The connector fetches by sheet
 * ID; tenant association is the sync layer's job (PL-007).
 */

/**
 * Raw sheet data as returned by the connector.
 * `headers` is the first row; `rows` are the remaining data rows.
 * All values are strings — the Sheets API returns cell values as strings.
 */
export interface SheetData {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/**
 * Base error for all connector failures. Every error path returns a typed
 * error, never an unhandled crash (Rule 10 — degrade to human, never to a
 * guess).
 */
export class ConnectorError extends Error {
  public override readonly name: string = 'ConnectorError';
}

/**
 * Authentication or authorization failure (401/403). The credentials are
 * missing, expired, or lack the required scope.
 */
export class ConnectorAuthError extends ConnectorError {
  public override readonly name = 'ConnectorAuthError';
}

/**
 * The requested sheet or range was not found (404).
 */
export class ConnectorNotFoundError extends ConnectorError {
  public override readonly name = 'ConnectorNotFoundError';
}

/**
 * Network failure, timeout, or unexpected API error.
 */
export class ConnectorNetworkError extends ConnectorError {
  public override readonly name = 'ConnectorNetworkError';
}

/**
 * Read-only sheet connector. Implementations fetch raw rows from a
 * spreadsheet source and surface failures as typed errors.
 */
export interface SheetConnector {
  /**
   * Fetch a sheet by ID and range.
   *
   * @param sheetId - Spreadsheet ID (e.g. from the Google Sheets URL)
   * @param range - A1 notation range (e.g. "Sheet1!A1:Z1000")
   * @returns Raw sheet data: first row as headers, remaining rows as data
   * @throws {ConnectorAuthError} on auth failure
   * @throws {ConnectorNotFoundError} if the sheet or range doesn't exist
   * @throws {ConnectorNetworkError} on network/timeout/unexpected errors
   */
  fetchSheet(sheetId: string, range: string): Promise<SheetData>;
}
