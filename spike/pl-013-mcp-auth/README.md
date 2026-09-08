# PL-013 — MCP transport + auth spike

> ⏱️ **Timeboxed: 1 day. Throwaway. Delete or archive at sprint end.**
> **Not production code. No student data — synthetic or otherwise — touches this directory.**

Per `planning/plan.md` PL-013. Purpose is to answer three questions before Sprint 2 commits
to a transport and auth design:

1. Does **one 401 shape** serve both Alexa+ and Claude Desktop?
2. Which managed **authorization server** — Cognito, Auth0, or Okta? (open question 9)
3. Is there a **private / org-scoped distribution** path for an Alexa+ add-on? (open question 1)

A "no" on any of these is a **successful** outcome — it reshapes Sprint 2 before it is built.

## What runs here

| File | Purpose |
|---|---|
| `server.mjs` | Streamable HTTP MCP server, one trivial `whoami` tool, PRM document, configurable 401 shape |
| `test-401.mjs` | Drives the server and asserts the 401 shape for each client profile |

No database. No `tenant_id`. No Google Sheets. The point is transport and auth only.

## Run

```bash
npm install
npm run spike:serve     # terminal 1
npm run spike:test      # terminal 2
```

## Status

- [x] Step 1 — Streamable HTTP + `whoami` tool
- [x] Step 3 — PRM document (RFC 9728) + `/.well-known/oauth-authorization-server`
- [x] Step 4 — 401 divergence characterized locally
- [ ] Step 2 — wire a real managed AS with PKCE S256 — **BLOCKED: needs a cloud AS account**
- [ ] Step 5 — Alexa+ eligibility + private distribution — **BLOCKED: needs an Amazon developer account**

Findings are written up in `research/research.md` under "Spike Results".
