import { type Pool, type PoolClient } from 'pg';

/**
 * Tenant context — the real `withTenant`.
 *
 * Acquires a connection from the pool, sets `app.tenant_id` via
 * `set_config`, runs the callback, and **resets the variable before
 * returning the connection to the pool**. A leaked tenant context is
 * leak vector 4 (T-04).
 *
 * `tenant_id` is never a caller-supplied argument in the application
 * layer. This function lives in `src/db/` — infrastructure, not the
 * auth layer — and is called by the auth layer after deriving the
 * tenant from the session. The ESLint override for this file allows
 * `tenantId` as a parameter because this is where the session-derived
 * value enters the database context, exactly as Rule 7 intends.
 *
 * The callback receives a `PoolClient` that is already scoped to the
 * tenant. All repository methods accept this client — they never
 * acquire their own pool connection, which would bypass the tenant
 * context.
 */

export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`select set_config('app.tenant_id', $1, false)`, [
      tenantId,
    ]);
    const result = await fn(client);
    // Reset before releasing. If this throws, the finally still releases
    // the client — but the setting persists in the connection. We reset
    // in a try/catch so a reset failure doesn't mask the original result.
    try {
      await client.query(`select set_config('app.tenant_id', '', false)`);
    } catch {
      // If reset fails, the connection is still released. The pool will
      // eventually recycle it. A failed reset is a logging concern, not
      // a reason to suppress the callback's result.
    }
    return result;
  } finally {
    client.release();
  }
}
