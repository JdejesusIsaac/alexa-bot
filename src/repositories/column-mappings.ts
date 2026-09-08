import { type PoolClient } from 'pg';

/**
 * Column-mapping repository.
 *
 * Per-tenant header → canonical field mappings. Explicit config, no
 * inference (AD-6, PL-004). The mapper uses these to translate raw sheet
 * rows into canonical rows.
 *
 * tenant_id is set by RLS from `app.tenant_id` — never passed as a value
 * in the INSERT (Rule 7).
 */

export interface ColumnMapping {
  id: string;
  tenant_id: string;
  sheet_header: string;
  canonical_field: string;
}

/**
 * Retrieve all column mappings for the current tenant context.
 * RLS ensures only the active tenant's mappings are visible.
 */
export async function findByTenant(client: PoolClient): Promise<ColumnMapping[]> {
  const res = await client.query<ColumnMapping>(
    `select * from column_mappings order by sheet_header`,
  );
  return res.rows;
}

/**
 * Insert a column mapping. The tenant_id is set by RLS from the
 * `app.tenant_id` session variable — it is never passed as a value
 * in the INSERT, ensuring it cannot be forged.
 */
export async function insertMapping(
  client: PoolClient,
  params: {
    sheetHeader: string;
    canonicalField: string;
  },
): Promise<ColumnMapping> {
  const res = await client.query<ColumnMapping>(
    `insert into column_mappings (tenant_id, sheet_header, canonical_field)
     values (current_setting('app.tenant_id')::uuid, $1, $2)
     returning *`,
    [params.sheetHeader, params.canonicalField],
  );
  return res.rows[0]!;
}
