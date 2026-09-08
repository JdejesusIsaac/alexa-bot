// PL-013 spike — characterize the 401 divergence.
// THROWAWAY. Answers: can one 401 shape serve both Alexa+ and Claude Desktop?

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8420';

let pass = 0;
let fail = 0;

const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`);
    if (detail) console.log(`       ${detail}`);
  }
};

// Claude Desktop and other spec-conformant clients. Per RFC 9728 §5.1 and the
// MCP authorization spec, WWW-Authenticate MUST be present on a 401.
const CLAUDE_UA = 'Claude-Desktop/1.0 (mcp-client)';
// Alexa+ requires the header ABSENT (research §2d, from Amazon's QuickStart).
const ALEXA_UA = 'AlexaPlus/1.0 (mcp-client; +https://developer.amazon.com)';

const unauth = (ua) =>
  fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': ua },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });

const run = async () => {
  console.log('PL-013 · 401 divergence characterization\n');

  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  console.log(`server 401 strategy: ${health.strategy}\n`);

  // --- The divergence itself ---
  const claude = await unauth(CLAUDE_UA);
  const alexa = await unauth(ALEXA_UA);

  check('spec client gets 401', claude.status === 401, `got ${claude.status}`);
  check('alexa client gets 401', alexa.status === 401, `got ${alexa.status}`);

  const claudeHdr = claude.headers.get('www-authenticate');
  const alexaHdr = alexa.headers.get('www-authenticate');

  check(
    'spec client 401 CARRIES WWW-Authenticate (RFC 9728 MUST)',
    claudeHdr !== null,
    'header absent — spec-conformant clients cannot discover the PRM',
  );
  check(
    'spec client header points at the PRM document',
    claudeHdr?.includes('resource_metadata=') ?? false,
    `got: ${claudeHdr}`,
  );
  check(
    'alexa client 401 OMITS WWW-Authenticate (Alexa+ requirement)',
    alexaHdr === null,
    `header present: ${alexaHdr}`,
  );

  // The finding: these two assertions are mutually exclusive for a single
  // fixed response. Both pass only because the server varies by client.
  console.log('\n  --- the divergence ---');
  console.log(`  spec  client: WWW-Authenticate ${claudeHdr ? 'PRESENT' : 'ABSENT'}`);
  console.log(`  alexa client: WWW-Authenticate ${alexaHdr ? 'PRESENT' : 'ABSENT'}`);
  console.log(
    `  => one FIXED 401 shape cannot satisfy both. Varying by client is required.`,
  );

  // --- Discovery documents are reachable unauthenticated ---
  const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
  const prmBody = await prm.json();
  check('PRM document served unauthenticated', prm.status === 200, `got ${prm.status}`);
  check(
    'PRM advertises an authorization server',
    Array.isArray(prmBody.authorization_servers) && prmBody.authorization_servers.length > 0,
  );

  const asMeta = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  const asBody = await asMeta.json();
  check('AS metadata served', asMeta.status === 200, `got ${asMeta.status}`);
  check(
    'AS metadata offers S256 and NOT plain',
    asBody.code_challenge_methods_supported?.includes('S256') &&
      !asBody.code_challenge_methods_supported?.includes('plain'),
    `got: ${JSON.stringify(asBody.code_challenge_methods_supported)}`,
  );

  // --- PRM must not be influenced by client-supplied forwarded headers ---
  const forged = await fetch(`${BASE}/.well-known/oauth-protected-resource`, {
    headers: { 'x-forwarded-host': 'attacker.example.com', 'x-forwarded-proto': 'https' },
  }).then((r) => r.json());
  check(
    'PRM ignores X-Forwarded-* (client cannot steer advertised URLs)',
    !JSON.stringify(forged).includes('attacker.example.com'),
    `leaked forged host: ${JSON.stringify(forged)}`,
  );

  // --- The tool surface ---
  const ok = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer spike-token-abcdef',
      'user-agent': CLAUDE_UA,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  }).then((r) => r.json());

  check('authenticated tools/list succeeds', Array.isArray(ok.result?.tools));
  check(
    'whoami accepts NO arguments (no tenant parameter — rule 7)',
    Object.keys(ok.result?.tools?.[0]?.inputSchema?.properties ?? {}).length === 0 &&
      ok.result?.tools?.[0]?.inputSchema?.additionalProperties === false,
    `schema: ${JSON.stringify(ok.result?.tools?.[0]?.inputSchema)}`,
  );

  const called = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer spike-token-abcdef',
      'user-agent': CLAUDE_UA,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    }),
  }).then((r) => r.json());

  check(
    'whoami derives identity from the token, not arguments',
    called.result?.content?.[0]?.text?.includes('via=access_token'),
    `got: ${JSON.stringify(called.result)}`,
  );

  console.log(`\n  ---\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((err) => {
  console.error('spike test error:', err.message);
  console.error('is the server running?  npm run spike:serve');
  process.exit(1);
});
