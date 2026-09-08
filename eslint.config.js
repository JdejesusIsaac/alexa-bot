// @ts-check
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

/**
 * Parent Line lint configuration.
 *
 * Beyond ordinary hygiene, this file makes two of the project's
 * non-negotiable rules build-blocking rather than conventions:
 *
 *   Rule 11 — no query outside the repository layer
 *   Rule 7  — tenant_id is never a caller-supplied argument
 *
 * A convention that is only written down is a convention that gets
 * violated during a rushed afternoon. These fail CI.
 */

/** Rule 11: raw `.query(...)` is illegal outside src/repositories/. */
const NO_RAW_QUERY = {
  selector: "CallExpression[callee.property.name='query']",
  message:
    'Rule 11: no query outside the repository layer. Move this into src/repositories/ and expose an intention-named method.',
};

/**
 * Rule 7: tenant_id must never arrive as an argument. It is derived
 * server-side from the authenticated session. An external model fills
 * tool arguments, so a tenant parameter is cross-campus disclosure one
 * inference away.
 */
const NO_TENANT_PARAM = [
  {
    selector:
      'ExportNamedDeclaration FunctionDeclaration > Identifier.params[name=/^(tenantId|tenant_id)$/]',
    message:
      'Rule 7: tenant_id is never a caller-supplied argument. Derive it from the session inside the auth layer.',
  },
  {
    selector:
      'ExportNamedDeclaration FunctionDeclaration > ObjectPattern > Property > Identifier.key[name=/^(tenantId|tenant_id)$/]',
    message:
      'Rule 7: tenant_id is never a caller-supplied argument, including as a destructured option.',
  },
];

export default [
  {
    ignores: ['node_modules/**', 'spike/**', 'dist/**', 'coverage/**'],
  },

  // Base: application and test code.
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always'],
      'no-restricted-syntax': ['error', NO_RAW_QUERY, ...NO_TENANT_PARAM],

      // Rule 10: degrade to human, never to a guess. A swallowed error
      // becomes a confident wrong answer about a child.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },

  // The repository layer is the ONLY place a query may be written.
  {
    files: ['src/repositories/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_TENANT_PARAM],
    },
  },

  // The auth layer is the ONLY place tenant_id may be named as a value
  // in a signature, because this is where it is derived from the session.
  {
    files: ['src/auth/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', NO_RAW_QUERY],
    },
  },

  // Schema tooling, NOT application code. A migration runner exists to
  // execute DDL; routing it through the repository layer would be nonsense.
  // Scoped to this single file on purpose — `src/db/**` would be a loophole
  // wide enough to park application queries in.
  {
    files: ['src/db/migrate.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_TENANT_PARAM],
    },
  },

  // Test harness needs raw SQL to assert database-level behavior
  // (RLS policies, FORCE ROW LEVEL SECURITY, grants). That is the point
  // of T-01..T-05 and T-10 — they must bypass the repository layer to be
  // meaningful. Rule 7 still applies.
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_TENANT_PARAM],
    },
  },
];
