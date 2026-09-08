---
trigger: always_on
---
# Student Data Protection (FERPA) — ALWAYS ON

This project handles student education records. These rules are enforced by hooks.

- **Never write real student data** to any file: names, student IDs, guardian names, exports
- Fixtures are **synthetic only**. Two tenants, deliberately colliding names.
- **Never commit** `.csv`, `.xlsx`, or anything under `fixtures/real/`
- The **advisor-notes** column is excluded at the connector. It never enters a canonical row, a tool response, or a log line.
- **`tenant_id` is derived from the authenticated session**, never accepted as an argument
- Logs carry `tenant_id`, never student identifiers
- If you are unsure whether something is student data, it is. Ask.
