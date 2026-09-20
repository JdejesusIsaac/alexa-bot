/**
 * Local test authorization server (PL-101 posture: AS-agnostic).
 *
 * Sprint 2's token tests run against a locally generated RSA keypair
 * with a locally served JWKS and self-minted RS256 tokens — a real AS
 * is not provisioned yet (see research.md "Spike Results"), and the
 * validation chain is standard OAuth 2.1 resource-server behavior that
 * does not vary by vendor.
 *
 * Minting helpers produce the distinct bad-token shapes the tests
 * need: wrong signing key (T-25), wrong issuer (T-26), expired (T-27),
 * wrong audience (T-28), and claim variations for identity resolution.
 */

import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';

export interface LocalAs {
  readonly issuer: string;
  readonly jwksUrl: string;
  /** Mint a token for a caller of the given tenant and role. */
  mintToken(params: {
    readonly sub?: string;
    readonly tenantId: string;
    readonly role?: 'staff' | 'admin';
    readonly audience?: string;
    readonly issuer?: string;
    readonly expiresIn?: string;
    readonly expiresAt?: number;
    /** Sign with a different (attacker) key — T-25. */
    readonly foreignKey?: boolean;
    /** Omit the tenant claim entirely. */
    readonly omitTenantClaim?: boolean;
    /** Omit the role claim entirely. */
    readonly omitRoleClaim?: boolean;
    readonly omitSubject?: boolean;
  }): Promise<string>;
  close(): Promise<void>;
}

export async function startLocalAs(): Promise<LocalAs> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  // A second key the server never publishes — for bad-signature tests.
  const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const kid = randomUUID();
  const publicJwk = await exportJWK(publicKey);

  const server: Server = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      if (req.url === '/jwks.json') {
        const body = JSON.stringify({
          keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }],
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }
      res.writeHead(404).end();
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('local AS failed to bind');
  }
  const base = `http://127.0.0.1:${address.port}`;
  const issuer = `${base}/as`;

  async function mintToken(params: {
    sub?: string;
    tenantId: string;
    role?: 'staff' | 'admin';
    audience?: string;
    issuer?: string;
    expiresIn?: string;
    expiresAt?: number;
    foreignKey?: boolean;
    omitTenantClaim?: boolean;
    omitRoleClaim?: boolean;
    omitSubject?: boolean;
  }): Promise<string> {
    const key = params.foreignKey === true ? foreign.privateKey : privateKey;
    const signKid = params.foreignKey === true ? randomUUID() : kid;

    const builder = new SignJWT({
      ...(params.omitTenantClaim === true ? {} : { tenant_id: params.tenantId }),
      ...(params.omitRoleClaim === true ? {} : { role: params.role ?? 'staff' }),
    });

    if (params.omitSubject !== true) {
      builder.setSubject(params.sub ?? `test-user-${randomUUID().slice(0, 8)}`);
    }
    builder
      .setProtectedHeader({ alg: 'RS256', kid: signKid })
      .setIssuedAt()
      .setIssuer(params.issuer ?? issuer)
      .setAudience(params.audience ?? issuer);

    if (params.expiresAt !== undefined) {
      builder.setExpirationTime(params.expiresAt);
    } else {
      builder.setExpirationTime(params.expiresIn ?? '30m');
    }

    return builder.sign(key);
  }

  return {
    issuer,
    jwksUrl: `${base}/jwks.json`,
    mintToken,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err !== undefined ? reject(err) : resolve()));
      }),
  };
}
