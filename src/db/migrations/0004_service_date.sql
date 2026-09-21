-- PL-201: roster grain — service_date + student_id linkage.
--
-- The roster is a dated set. Before this migration a sync wiped every
-- prior row (a table holding only "now"), and roster_entries.student_id
-- was never populated — routing by section/grade and the leader's
-- pattern context both need history and identity (AD-31).
--
-- service_date is the school day a row belongs to. Sync writes a dated
-- set; reads scope to a date, defaulting to today. Two consecutive days
-- coexist (T-50).
--
-- student_id is resolved at ingest against `students`, inserting the
-- student row when absent (T-51). That linkage lives in application
-- code (src/repositories/students.ts), not here — this migration only
-- carries the column and its grain.

-- ── Add the column (nullable first, backfill, then constrain) ─────────

alter table roster_syncs   add column service_date date;
alter table roster_entries add column service_date date;

-- ── Backfill ──────────────────────────────────────────────────────────
--
-- Existing rows take the service date of the sync that wrote them.
-- RLS is disabled for each backfill and restored immediately after:
-- migrations run as the table owner, FORCE ROW LEVEL SECURITY subjects
-- the owner to the tenant policy, and there is no app.tenant_id set in
-- a maintenance context. Fresh databases have no rows — these updates
-- are no-ops there.

alter table roster_syncs disable row level security;
update roster_syncs set service_date = started_at::date where service_date is null;
alter table roster_syncs enable row level security;
alter table roster_syncs force row level security;

alter table roster_entries disable row level security;
update roster_entries re
  set service_date = rs.started_at::date
  from roster_syncs rs
  where re.sync_id = rs.id and re.service_date is null;
alter table roster_entries enable row level security;
alter table roster_entries force row level security;

-- ── Constrain ─────────────────────────────────────────────────────────

alter table roster_syncs   alter column service_date set not null;
alter table roster_entries alter column service_date set not null;

-- ── Indexes for the dated read path ───────────────────────────────────
--
-- Every read is tenant × date. The composite serves both the date-
-- scoped lookups and the tenant-prefix scans the old single-column
-- indexes served.

create index idx_roster_syncs_service_date   on roster_syncs (tenant_id, service_date);
create index idx_roster_entries_service_date on roster_entries (tenant_id, service_date);
