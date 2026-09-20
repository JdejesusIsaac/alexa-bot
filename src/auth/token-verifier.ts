/**
 * Access-token verification chain (PL-103).
 *
 * Every bearer token is validated against all four required checks, in
 * order of increasing specificity: JWKS signature → issuer → expiry →
 * audience. Audience is the one that blocks token passthrough — a token
 * the user legitimately holds for a different resource must not open
 * ours (T-28), so it is checked last and reported distinctly.
 *
 * Tokens are accepted from the `Authorization` header ONLY (T-29) —
 * the query string is rejected upstream in the HTTP layer.
 *
 * Every rejection reason is distinct and logged by code only — token
 * contents never appear in a rejection, error, or log line.
 *
 * JWKS is fetched once and cached (jose `createRemoteJWKSet`); the cold
 * path — first request after deploy or key rotation — is a network
 * fetch and is the realistic worst case for the latency budget (T-48).
 * The host warms the cache at startup and on a refresh timer so the
 * cold fetch happens off the request path (E3).
 */

import { createRemoteJWKSet, jwtVerify, errors } from 'jose';
import {
  resolveIdentity,
  type AuthedIdentity,
  type IdentityRejectionCode,
} from './identity.js';

export type RejectionCode =
  | 'missing_token'
  | 'malformed_authorization_header'
  | 'invalid_signature'
  | 'wrong_issuer'
  | 'token_expired'
  | 'wrong_audience'
  | IdentityRejectionCode;

export type VerifyResult =
  { ok: true; identity: AuthedIdentity } | { ok: false; code: RejectionCode };

export interface TokenVerifierOptions {
  /** Expected issuer — a token from any other issuer is rejected (T-26). */
  readonly issuer: string;
  /** JWKS endpoint of the authorization server. Fetched and cached. */
  readonly jwksUrl: string;
  /** Audience this resource requires — blocks token passthrough (T-28). */
  readonly expectedAudience: string;
  /** Explicit, small clock-skew tolerance for expiry (T-27). */
  readonly clockSkewSeconds: number;
  /** Token claim carrying the caller's tenant (rule 7). */
  readonly tenantClaim: string;
  /** Token claim carrying the caller's role. */
  readonly roleClaim: string;
}

export class TokenVerifier {
  private readonly options: TokenVerifierOptions;
  private jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: TokenVerifierOptions) {
    this.options = options;
    this.jwks = createRemoteJWKSet(new URL(options.jwksUrl));
  }

  /**
   * Drop the cached JWKS and re-arm against the configured endpoint.
   * Used by tests to exercise the cold path (T-48) — first request after
   * deploy or key rotation fetches keys over the network.
   */
  resetJwksCache(): void {
    this.jwks = createRemoteJWKSet(new URL(this.options.jwksUrl));
  }

  /**
   * Fetch the JWKS document now, off the request path (E3). jose's
   * `reload()` bypasses the cooldown and refreshes the cache in place —
   * used at startup and by the refresh timer so a request never pays
   * the cold fetch after deploy or key rotation. Errors propagate to
   * the caller, which logs; a failed warm only means the next request
   * pays the fetch itself.
   */
  async warmJwksCache(): Promise<void> {
    await this.jwks.reload();
  }

  async verify(authorizationHeader: string | undefined): Promise<VerifyResult> {
    if (authorizationHeader === undefined || authorizationHeader.length === 0) {
      return { ok: false, code: 'missing_token' };
    }

    const match = /^Bearer (.+)$/.exec(authorizationHeader);
    if (match === null) {
      return { ok: false, code: 'malformed_authorization_header' };
    }
    const token = match[1]!;

    // Signature + issuer + expiry, via jose. Audience is checked manually
    // below so a wrong audience is a distinct, deterministic code.
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.options.issuer,
        clockTolerance: this.options.clockSkewSeconds,
        requiredClaims: ['exp'],
      });

      const aud = payload.aud;
      const audienceMatches =
        aud === this.options.expectedAudience ||
        (Array.isArray(aud) && aud.includes(this.options.expectedAudience));
      if (!audienceMatches) {
        return { ok: false, code: 'wrong_audience' };
      }

      const identityResult = resolveIdentity(payload as Record<string, unknown>, {
        tenantClaim: this.options.tenantClaim,
        roleClaim: this.options.roleClaim,
      });
      if (!identityResult.ok) {
        return { ok: false, code: identityResult.code };
      }
      return { ok: true, identity: identityResult.identity };
    } catch (err) {
      if (err instanceof errors.JWTExpired) {
        return { ok: false, code: 'token_expired' };
      }
      if (
        err instanceof errors.JWKSNoMatchingKey ||
        err instanceof errors.JWSSignatureVerificationFailed ||
        err instanceof errors.JWSInvalid
      ) {
        // Signed with a key not in the JWKS, or a tampered signature (T-25).
        return { ok: false, code: 'invalid_signature' };
      }
      if (err instanceof errors.JWTClaimValidationFailed) {
        // jose validates `iss` here; audience is manual above.
        return { ok: false, code: 'wrong_issuer' };
      }
      // Malformed JWTs and anything unexpected fail closed.
      return { ok: false, code: 'invalid_signature' };
    }
  }
}
