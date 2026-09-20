#!/usr/bin/env node
/**
 * PL-101 AS probe — automates the mechanics of the observation protocol.
 *
 * Canonical procedure: sprint-2/research.md §Spike Results, "PL-101 —
 * Observation protocol". This script implements §1 (the AS-agnostic test)
 * and prints the §7 evidence block, filled, ready to paste.
 *
 * What it does NOT do: create the tenant, the application, or the user —
 * those are console steps only you can perform (research.md §2 for Auth0).
 *
 * Usage:
 *   node spike/pl-101-as-probe/probe.mjs \
 *     --tenant https://dev-xxxx.us.auth0.com \   # Auth0-style derivation
 *     --client-id <your-client-id> \
 *     [--mode resource|audience] \                 # default: resource (the probe)
 *     [--resource http://127.0.0.1:8420] \         # the aud we require
 *     [--port 8425]                               # loopback listener
 *
 *   Non-Auth0 endpoints (Okta / Cognito / Keycloak) — pass explicitly:
 *     --authorize-endpoint https://<org>.okta.com/oauth2/default/v1/authorize
 *     --token-endpoint       https://<org>.okta.com/oauth2/default/v1/token
 *
 *   Decode a token you already hold (manual browser flow):
 *     node spike/pl-101-as-probe/probe.mjs --decode <access-token>
 *
 *   Self-check the mechanics:
 *     node spike/pl-101-as-probe/probe.mjs --smoke
 *
 * Never prints: the access token, the authorization code, or the verifier.
 * The evidence block redacts client_id. No student data is involved.
 */

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { URL } from 'node:url';

const DEFAULT_RESOURCE = 'http://127.0.0.1:8420';
const PROTOCOL_VERSION = 'PL-101 observation protocol (research.md §Spike Results)';

// ── arg parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    mode: 'resource',
    resource: DEFAULT_RESOURCE,
    port: 8425,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--tenant': args.tenant = argv[++i]; break;
      case '--client-id': args.clientId = argv[++i]; break;
      case '--mode': args.mode = argv[++i]; break;
      case '--resource': args.resource = argv[++i]; break;
      case '--port': args.port = Number(argv[++i]); break;
      case '--authorize-endpoint': args.authorizeEndpoint = argv[++i]; break;
      case '--token-endpoint': args.tokenEndpoint = argv[++i]; break;
      case '--decode': args.decode = argv[++i]; break;
      case '--smoke': args.smoke = true; break;
      case '--e2e':
        args.e2e = argv[i + 1] !== undefined && argv[i + 1].startsWith('http') ? argv[++i] : 'http://127.0.0.1:8420/mcp';
        break;
      default:
        console.error(`unknown argument: ${a}`);
        process.exit(2);
    }
  }
  if (args.tenant !== undefined) {
    if (!/^https?:\/\//.test(args.tenant)) args.tenant = `https://${args.tenant}`;
    args.tenant = args.tenant.replace(/\/$/, '');
    if (args.authorizeEndpoint === undefined) args.authorizeEndpoint = `${args.tenant}/authorize`;
    if (args.tokenEndpoint === undefined) args.tokenEndpoint = `${args.tenant}/oauth/token`;
  }
  for (const key of ['authorizeEndpoint', 'tokenEndpoint']) {
    if (args[key] !== undefined && !/^https?:\/\//.test(args[key])) {
      args[key] = `https://${args[key]}`;
    }
  }
  return args;
}

function usage() {
  console.log(`PL-101 AS probe — ${PROTOCOL_VERSION}

  node spike/pl-101-as-probe/probe.mjs --tenant <https://dev-xxxx.auth0.com> --client-id <id> [--mode resource|audience]
  node spike/pl-101-as-probe/probe.mjs --authorize-endpoint <url> --token-endpoint <url> --client-id <id>
  node spike/pl-101-as-probe/probe.mjs --decode <access-token>
  node spike/pl-101-as-probe/probe.mjs --smoke

Prerequisites (console steps only you can do — research.md §2 for Auth0):
  1. a public/native client with PKCE (no secret)
  2. callback URL registered as http://localhost:8425/callback
  3. for Auth0 Run B: an API with identifier = the resource URL below

The probe marker URL is ${DEFAULT_RESOURCE} — this server's real RESOURCE_URL.
Each run's evidence block is appended to spike/pl-101-as-probe/evidence.md.`);
}

function saveEvidence(block) {
  const file = new URL('./evidence.md', import.meta.url);
  appendFileSync(file, `\n\n---\n\n${block}\n`);
  console.log(`\n(Evidence appended to ${file.pathname})`);
}

// ── PKCE (RFC 7636, S256) ─────────────────────────────────────────────

function makePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ── the AS-agnostic test (research.md §1) ─────────────────────────────

function buildAuthorizeUrl({ authorizeEndpoint, clientId, redirectUri, mode, resource, challenge, state }) {
  const url = new URL(authorizeEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'openid');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // The whole point: Run A sends RFC 8707 `resource`, Run B sends the
  // vendor-native `audience`. Same everything else.
  url.searchParams.set(mode === 'audience' ? 'audience' : 'resource', resource);
  return url.toString();
}

function listenForRedirect(port, state) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h2>Code captured — return to the terminal.</h2></body></html>');
      const params = url.searchParams;
      if (params.get('state') !== state) {
        server.close();
        reject(new Error(`state mismatch — expected ${state}, got ${params.get('state')}`));
        return;
      }
      server.close();
      resolve(params);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
  });
}

async function exchangeCode({ tokenEndpoint, clientId, code, verifier, redirectUri, mode, resource }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  body.set(mode === 'audience' ? 'audience' : 'resource', resource);
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: text };
  }
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, status: res.status, error: `non-JSON response: ${text.slice(0, 400)}` };
  }
}

// ── §6.3 end-to-end: initialize through the real audience check ──────

async function endToEndCheck(token, url) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'pl-101-probe', version: '1.0.0' },
        },
      }),
    });
    const sessionId = res.headers.get('mcp-session-id');
    const body = (await res.text()).slice(0, 300);
    console.log(`\nEnd-to-end initialize (${url}): HTTP ${res.status}${sessionId ? ' · mcp-session-id: present' : ' · mcp-session-id: ABSENT'}`);
    console.log(`Body: ${body}`);
    if (res.status === 200) {
      console.log('→ §6.3 FULL PASS: the real token cleared signature, issuer, expiry, and audience.');
    } else {
      console.log('→ Not a full pass yet. A rejection reason about tenant/role claims means the validation chain itself passed — only identity wiring (Auth0 Action) remains. A reason about token/audience means the chain failed — investigate.');
    }
  } catch (err) {
    console.log(`\nEnd-to-end check failed to connect (${url}): ${err.message}`);
    console.log('→ Is the server running? npm run serve');
  }
}

// ── decode + verdict (research.md §1 step 6–7, §7 template) ───────────

function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return { jwt: false };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return { jwt: true, payload };
  } catch {
    return { jwt: false };
  }
}

function audContains(aud, resource) {
  if (aud === undefined) return false;
  const list = Array.isArray(aud) ? aud : [aud];
  return list.includes(resource);
}

function verdictOf(token, resource) {
  const { jwt, payload } = decodeJwt(token);
  if (!jwt) {
    return {
      verdict: 'SILENTLY DROPPED (opaque token)',
      detail: 'Not a JWT — no `aud` to inspect. Per protocol §1 trap 2, this is a recorded outcome, and for this resource server (JWT + aud required) it is a fail.',
    };
  }
  const audOk = audContains(payload.aud, resource) || audContains(payload.resource, resource);
  if (audOk) {
    return { verdict: 'HONORED', detail: `aud = ${JSON.stringify(payload.aud)}` };
  }
  if (payload.aud === undefined && payload.resource === undefined) {
    return { verdict: 'SILENTLY DROPPED (aud ABSENT)', detail: 'Valid JWT, no aud claim.' };
  }
  return {
    verdict: 'SILENTLY DROPPED (wrong aud)',
    detail: `aud = ${JSON.stringify(payload.aud)}${payload.resource !== undefined ? ` · resource = ${JSON.stringify(payload.resource)}` : ''}`,
  };
}

function evidenceBlock({ as, mode, authorizeUrl, authorizeOutcome, codeExchanged, token, resource, verdict, detail }) {
  const { jwt, payload } = decodeJwt(token ?? '');
  const claims = jwt
    ? JSON.stringify(
        Object.fromEntries(
          Object.entries(payload).filter(([k]) => !['access_token', 'code', 'code_verifier'].includes(k)),
        ),
        null,
        2,
      )
    : '(opaque token — no claims to show)';
  const redactedUrl = (authorizeUrl ?? '').replace(/client_id=[^&]+/, 'client_id=<redacted>');
  return `### ${as} — observed ${new Date().toISOString().slice(0, 10)} (mode: ${mode})

| Field | Value |
|---|---|
| tenant | ${as} |
| authorize request | ${redactedUrl} |
| outcome at authorize | ${authorizeOutcome} |
| code exchanged | ${codeExchanged ? 'y' : 'n'} |
| access token iss | ${jwt ? String(payload.iss) : '(opaque)'} |
| access token aud | ${jwt ? JSON.stringify(payload.aud) : '(opaque)'} |
| tenant_id / role claims | ${jwt ? `tenant_id: ${JSON.stringify(payload.tenant_id)} · role: ${JSON.stringify(payload.role)}` : '(opaque)'} |
| verdict | **${verdict}** |

Detail: ${detail}
Probe marker (must equal EXPECTED_AUDIENCE): ${resource}

Decoded token (secrets and signatures redacted):
\`\`\`json
${claims}
\`\`\``;
}

// ── main ──────────────────────────────────────────────────────────────

async function runProbe(args) {
  if (args.authorizeEndpoint === undefined || args.tokenEndpoint === undefined || args.clientId === undefined) {
    usage();
    process.exit(2);
  }
  const redirectUri = `http://localhost:${args.port}/callback`;
  const state = randomBytes(16).toString('hex');
  const { verifier, challenge } = makePkce();
  const authorizeUrl = buildAuthorizeUrl({
    authorizeEndpoint: args.authorizeEndpoint,
    clientId: args.clientId,
    redirectUri,
    mode: args.mode,
    resource: args.resource,
    challenge,
    state,
  });

  console.log(`PL-101 probe — mode: ${args.mode} · marker: ${args.resource}`);
  console.log(`\n1. Open this URL and log in:\n\n   ${authorizeUrl}\n`);
  console.log(`2. The script is listening on ${redirectUri} — the browser will land there automatically.`);

  let params;
  try {
    params = await listenForRedirect(args.port, state);
  } catch (err) {
    console.error(`\nlistener failed: ${err.message}`);
    process.exit(1);
  }

  if (params.get('error') !== null) {
    const outcome = `ERROR at authorize: ${params.get('error')} — ${params.get('error_description') ?? '(no description)'}`;
    console.log(`\n${outcome}`);
    console.log(`\nVerdict: **REJECTED** (loud failure — record the exact text above).`);
    const block = evidenceBlock({
      as: args.tenant ?? args.authorizeEndpoint,
      mode: args.mode,
      authorizeUrl,
      authorizeOutcome: outcome,
      codeExchanged: false,
      token: '',
      resource: args.resource,
      verdict: 'REJECTED',
      detail: outcome,
    });
    console.log(`\nEvidence block:\n\n${block}`);
    saveEvidence(block);
    return;
  }

  const code = params.get('code');
  console.log('\n3. Code captured (never printed). Exchanging…');

  const exchange = await exchangeCode({
    tokenEndpoint: args.tokenEndpoint,
    clientId: args.clientId,
    code,
    verifier,
    redirectUri,
    mode: args.mode,
    resource: args.resource,
  });

  if (!exchange.ok) {
    const outcome = `ERROR at token endpoint: HTTP ${exchange.status} — ${exchange.error}`;
    console.log(`\n${outcome}`);
    console.log(`\nVerdict: **REJECTED** (loud failure at the token endpoint).`);
    const block = evidenceBlock({
      as: args.tenant ?? args.authorizeEndpoint,
      mode: args.mode,
      authorizeUrl,
      authorizeOutcome: 'login OK',
      codeExchanged: false,
      token: '',
      resource: args.resource,
      verdict: 'REJECTED (token endpoint)',
      detail: outcome,
    });
    console.log(`\nEvidence block:\n\n${block}`);
    saveEvidence(block);
    return;
  }

  const token = exchange.json.access_token;
  if (typeof token !== 'string' || token.length === 0) {
    console.log('\nNo access_token in the response:', JSON.stringify(exchange.json, null, 2));
    process.exit(1);
  }

  const { verdict, detail } = verdictOf(token, args.resource);
  console.log(`\nVerdict: **${verdict}**`);
  console.log(`Detail: ${detail}`);
  console.log(`\nEvidence block — paste into research.md §Spike Results:\n`);
  const block = evidenceBlock({
    as: args.tenant ?? args.authorizeEndpoint,
    mode: args.mode,
    authorizeUrl,
    authorizeOutcome: 'login OK',
    codeExchanged: true,
    token,
    resource: args.resource,
    verdict,
    detail,
  });
  console.log(block);
  saveEvidence(block);
  if (verdict === 'HONORED') {
    console.log('\n→ Per protocol §2/§6: record this, stop the bake-off, wire .env, close PL-101.');
  } else if (args.mode === 'resource') {
    console.log('\n→ Run B (control) next: same command with --mode audience. If Run B is HONORED, the AS fails the Alexa+ path specifically.');
  }
  if (args.e2e !== undefined) {
    await endToEndCheck(token, args.e2e);
  }
}

async function runDecode(token) {
  const { verdict, detail } = verdictOf(token, DEFAULT_RESOURCE);
  const { jwt, payload } = decodeJwt(token);
  console.log(jwt ? JSON.stringify(payload, null, 2) : '(opaque token — not a JWT)');
  console.log(`\nVerdict vs ${DEFAULT_RESOURCE}: **${verdict}** — ${detail}`);
}

// ── smoke: verify the mechanics without any AS ───────────────────────

async function runSmoke() {
  const checks = [];
  const check = (name, ok, extra = '') => {
    checks.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  };

  const { verifier, challenge } = makePkce();
  const recomputed = createHash('sha256').update(verifier).digest('base64url');
  check('PKCE S256 derivation', recomputed === challenge);

  const url = buildAuthorizeUrl({
    authorizeEndpoint: 'https://example.as/authorize',
    clientId: 'cid-123',
    redirectUri: 'http://localhost:8425/callback',
    mode: 'resource',
    resource: DEFAULT_RESOURCE,
    challenge,
    state: 'st',
  });
  const parsed = new URL(url);
  check(
    'authorize URL carries resource (Run A)',
    parsed.searchParams.get('resource') === DEFAULT_RESOURCE && parsed.searchParams.get('code_challenge_method') === 'S256',
  );
  const urlB = buildAuthorizeUrl({
    authorizeEndpoint: 'https://example.as/authorize',
    clientId: 'cid-123',
    redirectUri: 'http://localhost:8425/callback',
    mode: 'audience',
    resource: DEFAULT_RESOURCE,
    challenge,
    state: 'st',
  });
  check(
    'authorize URL carries audience (Run B)',
    new URL(urlB).searchParams.get('audience') === DEFAULT_RESOURCE,
  );

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const mk = (payload) => `h.${b64(payload)}.s`;
  check('verdict HONORED (aud match)', verdictOf(mk({ iss: 'x', aud: DEFAULT_RESOURCE }), DEFAULT_RESOURCE).verdict === 'HONORED');
  check('verdict HONORED (resource claim)', verdictOf(mk({ iss: 'x', resource: DEFAULT_RESOURCE }), DEFAULT_RESOURCE).verdict === 'HONORED');
  check('verdict DROPPED (wrong aud)', verdictOf(mk({ iss: 'x', aud: 'https://other.api' }), DEFAULT_RESOURCE).verdict.startsWith('SILENTLY DROPPED'));
  check('verdict DROPPED (aud absent)', verdictOf(mk({ iss: 'x' }), DEFAULT_RESOURCE).verdict.startsWith('SILENTLY DROPPED'));
  check('verdict DROPPED (opaque)', verdictOf('not-a-jwt', DEFAULT_RESOURCE).verdict.startsWith('SILENTLY DROPPED'));

  const state = 'smoke-state';
  const listenerPromise = listenForRedirect(8791, state);
  await fetch('http://127.0.0.1:8791/callback?code=smoke-code&state=smoke-state', { redirect: 'manual' }).catch(() => undefined);
  const params = await listenerPromise;
  check('listener captures code + validates state', params.get('code') === 'smoke-code');

  const failed = checks.filter((ok) => !ok).length;
  console.log(`\n${failed === 0 ? 'ALL SMOKE CHECKS PASS' : `${failed} CHECK(S) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

// ── entry ─────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
if (args.smoke) {
  await runSmoke();
} else if (args.decode !== undefined) {
  await runDecode(args.decode);
} else {
  await runProbe(args);
}
