-- PL-007: Sync scheduler needs DELETE on roster_entries and
-- quarantined_rows to clear old data before re-ingesting (idempotency).
-- RLS still enforces tenant scoping on DELETE — only the active
-- tenant's rows are affected.

grant delete on roster_entries to parentline_app;
grant delete on quarantined_rows to parentline_app;
