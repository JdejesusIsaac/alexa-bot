# PL-101 AS probe

Automates the mechanics of the PL-101 observation protocol. **The protocol itself — acceptance criteria, outcomes, and the evidence that counts — lives in `sprint-2/research.md` §Spike Results. That file is the source of truth; this is a tool.**

```bash
# Auth0 (research.md §2 — the worked path):
node spike/pl-101-as-probe/probe.mjs \
  --tenant https://dev-xxxx.us.auth0.com \
  --client-id <your-client-id>                # Run A: RFC 8707 resource

# Run B (control) — same command with --mode audience

# Okta / Cognito / Keycloak — pass endpoints explicitly:
node spike/pl-101-as-probe/probe.mjs \
  --authorize-endpoint https://<org>.okta.com/oauth2/default/v1/authorize \
  --token-endpoint https://<org>.okta.com/oauth2/default/v1/token \
  --client-id <id>

node spike/pl-101-as-probe/probe.mjs --smoke    # self-check, no AS needed
```

What it does: PKCE pair → authorize URL with `resource` (or `audience`) → loopback listener captures the code (register `http://localhost:8425/callback` on the AS) → token exchange → decode → **verdict from the `aud` claim** → prints the filled evidence block for `research.md` §Spike Results.

What it never prints: the access token, the authorization code, the verifier, or an unredacted `client_id`.

Verified 2026-09-17: `--smoke` all green; full run exercised against a local fake AS (authorize 302 → listener capture → exchange with `resource` present → HONORED verdict → evidence block).
