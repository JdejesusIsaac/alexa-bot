# research.md — Sprint 6 (repair; settled decisions only)

A repair sprint does no Phase-0 research. This file exists to record
decisions Sprint 6 *settled*, in the same style as sprint-3.1's
research record. Numbering continues the cross-sprint catalog —
sprint-5's draft ends at leak vector 32.

---

## Leak vector 33 — a definer-set tenant context surviving into the caller's transaction (settled, F-11)

`pickup_request_belongs_to_tenant` (migration 0011) set
`app.tenant_id` transaction-locally to the tenant it was *probing* and
never restored it. Harmless only because the sole caller — the Slack
endpoint's membership probe — runs it as a dedicated autocommit query.
That was a property of the call site, not of the function: any caller
inside `withTenantTransaction` (or any transaction with a tenant
already set) would continue under the probed tenant for the rest of
its transaction — a cross-tenant leak waiting for a caller, in the
function that exists to answer a cross-tenant question.

**Settled:** migration 0012 saves `current_setting('app.tenant_id',
true)` and restores it before returning, on the success path and the
error path (a caller catching the error inside its own plpgsql handler
would otherwise continue under the probed tenant). A previously-unset
context restores to `''` — the codebase's reset convention
(`withTenant` resets with `set_config('app.tenant_id', '', …)`), and
`''` still fails closed at the policy's `::uuid` cast. Verified by the
T-82 leg in `tests/migrations.test.ts`: inside a tenant-A transaction,
a probe for tenant B returns `false` and leaves the caller's context —
and its RLS view — on tenant A. Mutation: removing the restore turns
the leg red (`current_setting` reads B afterwards).
