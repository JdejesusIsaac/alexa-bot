-- PL-208: decision notes on the event ledger.
--
-- decide_pickup_request accepts a note — the approver's reason for the
-- decision. A declared parameter must land somewhere real (AD-15), and
-- the append-only event ledger is where a decision's context belongs:
-- same discipline as reason_detail (P3) — written by a human, read
-- in-app under a tenant context with an audit entry, clearance `never`
-- (it is decision-adjacent free text), never in a tool response.

alter table pickup_request_events add column note text;
