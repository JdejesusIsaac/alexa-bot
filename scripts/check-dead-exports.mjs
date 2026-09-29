#!/usr/bin/env node
/**
 * Dead-export check (PL-278 · T-88) — compiler-based (PL-297, B-15).
 *
 * A `src/` export with no caller fails the build. This is the mechanical
 * version of the Failed Approaches lesson that recurred three times
 * (PL-005 → PL-206/PL-207 → B-5): code marked ✅ while nothing called
 * it. `sendPickupNotifications` shipped with seven green sentinel tests
 * and no caller in src/; this check would have failed that commit.
 *
 * **What this check proves** (Sprint 6 closeout — hard-fail 6 restated to
 * match): a NAMED `src/` export whose only callers are in `tests/` — or
 * that has no caller at all — fails the build. References resolve through
 * the compiler to their declared symbols; a same-file reference counts
 * only when its enclosing top-level statement is alive.
 *
 * **Stated limits — known gaps, accepted at the Sprint 6 close and filed
 * as Sprint 7 harness work (program-wide liveness), not silently broken:**
 *   - `export default` declarations are not checked (B-17). No src/ file
 *     has one today; the entry points that would need it are whole-file
 *     JUSTIFIED anyway.
 *   - A dead cycle spread ACROSS files keeps itself alive (B-18):
 *     liveness is a per-file fixpoint, so a cross-file reference counts
 *     unconditionally. The fix is one program-wide fixpoint — roots are
 *     JUSTIFIED declarations, TEST_SURFACE exports with test callers, and
 *     non-declaration statements — not another local patch.
 *   - A JUSTIFIED declaration is a liveness root, so its callees are
 *     exempt transitively (F-14). `runSync` carries its own written
 *     entry; the remaining satellites are the deferrals' own types.
 *
 * **Why the compiler, not a regex (B-15).** The reference matcher was a
 * text heuristic, and it lost three times to the same class — a name
 * that collides with something that is not this export:
 *   - F-6  — member access: `client.release()` kept an export `release`
 *            alive (a property on an unrelated object).
 *   - B-13 — string literals: `case 'release':`, `z.enum(['release'])`
 *            kept it alive (a wire/state value, not this binding).
 *   - B-15 — interface members and optional keys: `interface X { release:
 *            T }` and `{ release?: T }` kept it alive (the property-key
 *            exclusion only suppressed `{`/`,`-prefixed keys, so a
 *            `;`/newline-separated member and a `name?:` optional key
 *            were counted as callers).
 * Each fix patched one collision and surfaced the next. A text matcher
 * approximating a type system keeps losing. This check now uses the
 * TypeScript compiler's own program and type checker: every candidate
 * reference is resolved to its declared SYMBOL (following import/export
 * aliases). A member access, a string literal, an interface member, and
 * an optional key resolve to a DIFFERENT symbol (or none) than the
 * exported binding, so they are distinguished by construction, not by
 * pattern. `typescript` is already a dependency (tsc is `npm run
 * typecheck`), so this adds no package and no supply-chain surface.
 *
 * Caller classes, deliberately unequal (unchanged from PL-285):
 *   - FEATURE LAYERS (services, mcp tools, slack, sync, db, and — since
 *     PL-285 — REPOSITORIES) must be referenced in `src/`: a function
 *     whose only caller is a test is the B-4 hallway, not wiring.
 *   - TEST-SURFACE INFRASTRUCTURE (below) may instead be referenced by
 *     `tests/` — connectors that are configured rather than called, and
 *     canonical schema pinned by the suite.
 *   - JUSTIFIED entries are exceptions kept with a written reason — each
 *     one is a decision someone made, visible here, not a silence.
 * A same-file reference is NOT automatically a caller (B-16). The
 * resolver resolves references correctly; the old liveness rule asked
 * the wrong question — "is there a reference from src/?" instead of
 * "is there a reference from REACHABLE code in src/?". A reference
 * inside the export's own declaration (a recursive call, its own
 * declaration name, a self-referential initializer) is not a caller,
 * and a reference from a dead in-file declaration — e.g. an unused
 * `type X = ReturnType<typeof fn>` — counts only if that declaration
 * is itself alive. Aliveness is a monotone fixpoint over the file's
 * top-level statements: non-declaration statements (and `export
 * default` declarations, reachable via the default import) execute or
 * are reachable unconditionally; every other declaration is alive iff
 * a symbol it binds is alive. A dead recursion cycle therefore keeps
 * nothing alive WITHIN ONE FILE — the cross-file shape is a stated
 * limit (B-18), not a claim this check makes.
 *
 * A reference is a genuine USE: an identifier that resolves (through
 * alias chains) to the exported symbol, in expression or type position.
 * The export's own declaration name and the binding names of import/
 * export specifiers do NOT count — an `import { foo }` with no call is
 * not a caller, and a re-export `export { foo } from './x'` keeps `foo`
 * alive only if something downstream actually uses it.
 *
 * Usage: node scripts/check-dead-exports.mjs [--root <dir>] [--tests-root <dir>]
 *   (defaults: src, tests). The --root/--tests-root forms exist so T-88
 *   can plant exports in a temp tree and prove this check fails on them —
 *   including the test-only-caller shape the repository exemption used to
 *   let through, and the collision shapes above.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

/**
 * Test-surface infrastructure: references from tests/ count as callers.
 * Each entry carries its reason. Feature layers are NOT here — that is
 * the point of the check. src/repositories/ was here until PL-285; the
 * nine exports that legitimately serve only the suite now carry
 * per-export JUSTIFIED entries instead, so a NEW repository export with
 * only test callers fails the build.
 */
const TEST_SURFACE = {
  // Connectors are configured, not called: the fixture connector feeds
  // the test harness; the Google connector is integration-gated (PL-005)
  // and exercised by its own tests.
  'src/connector/': 'connectors are config-wired; the suite is the caller',
  // Canonical schema is pinned by the suite (validation, mapper tests).
  'src/schema/': 'canonical schema pinned by the suite',
  // The version registry's drift guard — its consumer is the CI test
  // that fails a schema change without a version bump.
  'src/mcp/schema-version.ts': 'schema drift guard consumed by CI tests',
  // Synthetic fixture modules are consumed by tests/, not by src/.
  'src/fixtures/': 'synthetic fixtures consumed by the test suite',
};

/**
 * Kept despite having no caller anywhere — each with its written reason.
 * A file whose entry ends in '/' is a prefix; otherwise it is exact.
 * The eight repository entries are the honest residue of PL-285: the
 * suite is their caller, and each says so here rather than in a silent
 * directory exemption.
 */
const JUSTIFIED = {
  // Scheduled-sync runner, unwired: the Sheets connector is dormant
  // without GOOGLE_SERVICE_ACCOUNT_FILE (.env.example), and a cron
  // pointed at a dormant connector would fail every run loudly. Wiring
  // lands with PL-005's credentials — deferred, recorded, not hidden.
  'src/sync/scheduler.ts:SyncScheduler':
    'scheduled-sync runner; wiring deferred until the connector is live',
  // The deferred scheduler's payload (F-14): its only `src/` caller is
  // the unwired SyncScheduler above — a real dead production path (the
  // PL-206 shape), kept because the deferral is real and recorded.
  // Named here rather than surviving on a transitive exemption.
  'src/sync/scheduler.ts:runSync':
    'deferred scheduler payload; only src/ caller is the unwired SyncScheduler — the suite is the caller',
  // PL-211's metrics emitter, exercised by T-73. A production schedule
  // is deferred with P1: E2 needs the pre-sprint baseline first, and a
  // scheduled emitter with no baseline reports numbers with no meaning.
  'src/services/decision-metrics.ts:emitDecisionMetrics':
    'metrics emitter (T-73); production schedule deferred with P1/E2',
  // Test capture client — the sentinel discipline (T-68/T-76) injects
  // it as the Slack client to assert payloads; no production caller by
  // design.
  'src/slack/capture-client.ts:CaptureSlackClient':
    'test capture client for the sentinel discipline; not a production path',
  // Entry points and job runners — executed by npm scripts, not imported.
  'src/main.ts': 'process entry point (npm run serve)',
  'src/sync/escalation-worker.ts': 'worker entry point (npm run worker)',
  'src/db/migrate.ts': 'migration runner (npm run migrate)',
  'src/db/seed.ts': 'seeder (npm run seed)',
  'src/soak/': 'soak harness (npm run soak:day)',
  // ── the repository residue (PL-285): the suite is the caller ──────
  // Test-world seeding through the repository API; production writes
  // arrive via sync and tools, not these inserts.
  'src/repositories/approver-routing.ts:insertApproverRoutingRule':
    'test-world seeding; production routing arrives by migration/seed',
  'src/repositories/column-mappings.ts:insertMapping':
    'test-world seeding; production mappings arrive by sync',
  'src/repositories/derivation-rules.ts:insertRule':
    'test-world seeding; production rules arrive by sync',
  'src/repositories/staff-identities.ts:insertStaffIdentity':
    'test-world seeding; production identities arrive by seed',
  // The staff diagnostic read surface for the audit ledgers — pinned by
  // the suite (AD-42's discipline); no staff-facing door ships it yet.
  // Wiring it to a tool is a feature decision, recorded here, not made
  // silently by deleting the reader.
  'src/repositories/mcp-audit.ts:findMcpAuditEntries':
    'staff diagnostic reader; no door ships it yet (deliberate)',
  // Suite pinning: the quarantined-row surface and the roster count are
  // asserted through the repository API, one layer up from raw SQL.
  'src/repositories/quarantined-rows.ts:findBySync':
    'suite pinning of the quarantined-row surface',
  'src/repositories/roster-entries.ts:countEntries':
    'suite pinning of the dated-count surface',
  // The P3 nightly sweep, unwired by decision: no production schedule
  // exists yet (deferred like SyncScheduler and emitDecisionMetrics —
  // a scheduled sweep against a schedule that does not exist is noise).
  // The terminal-state purge at the chokepoint IS wired; this is the
  // end-of-service-date hard stop. When a schedule lands, this entry
  // goes and a caller appears.
  'src/repositories/pickup-requests.ts:purgeStaleReasonDetail':
    'P3 nightly sweep; production schedule deferred — terminal-state purge is the wired half',
};

const args = process.argv;
const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : 'src';
const testsRoot = args.includes('--tests-root')
  ? args[args.indexOf('--tests-root') + 1]
  : 'tests';

async function listTsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // a missing dir (e.g. no tests/ in a temp --root tree) is empty
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTsFiles(p)));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** A file's rel path is a member of `haystacks` (exact, or under a `/` prefix). */
function matches(haystacks, rel) {
  return Object.keys(haystacks).some(
    (k) => rel === k || (k.endsWith('/') && rel.startsWith(k)),
  );
}

const srcFiles = await listTsFiles(root);
// Tests are only a caller pool, and only when checking the real `src`
// tree (the temp --root legs pass a non-`src` basename and get no tests).
const testFiles = path.basename(root) === 'src' ? await listTsFiles(testsRoot) : [];

const rel = (file) => path.relative(process.cwd(), file).split(path.sep).join('/');
const srcRel = new Set(srcFiles.map(rel));
const testRel = new Set(testFiles.map(rel));

// Compiler options: the project's tsconfig if present (module resolution,
// lib, strictness all matter for symbol resolution), else generic ESM
// defaults for a standalone temp tree.
function compilerOptions() {
  const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
  if (configPath) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      read.config ?? {},
      ts.sys,
      path.dirname(configPath),
    );
    return { ...parsed.options, noEmit: true };
  }
  return {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
  };
}

const program = ts.createProgram([...srcFiles, ...testFiles], compilerOptions());
const checker = program.getTypeChecker();

// ── Collect the exports to check: every export DECLARED in a src file,
//    minus whole-file and per-export JUSTIFIED entries. ─────────────────
/** @type {Map<ts.Symbol, {name: string, fileRel: string, testSurface: boolean, callers: Set<string>}>} */
const targets = new Map();
/** @type {Map<string, {sym: ts.Symbol, t: object}[]>} targets per declaring file */
const targetsByFile = new Map();
/** Per-export JUSTIFIED symbols per file — their declarations are
    liveness roots: a recorded deferral covers its own machinery, so a
    reference from inside a JUSTIFIED export's declaration is a
    reference from reachable-by-decision code (B-16). */
const justifiedByFile = new Map();

function isDeclaredIn(symbol, sourceFile) {
  return (symbol.declarations ?? []).some((d) => d.getSourceFile() === sourceFile);
}

for (const file of srcFiles) {
  const fileRel = rel(file);
  if (matches(JUSTIFIED, fileRel)) continue; // whole-file exception
  const sf = program.getSourceFile(file);
  if (sf === undefined) continue;
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (moduleSymbol === undefined) continue; // not a module (no exports)
  const testSurface = matches(TEST_SURFACE, fileRel);

  for (const exp of checker.getExportsOfModule(moduleSymbol)) {
    const name = exp.getName();
    // Stated limit (B-17): default exports are unchecked. No src/ file
    // has one today; the program-wide liveness pass (Sprint 7 harness
    // work) checks them like named exports.
    if (name === 'default') continue;
    // The binding this name resolves to, unwrapping re-export aliases so
    // we attribute it to the file that DECLARES it, not a barrel.
    const local =
      exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    if (!isDeclaredIn(local, sf)) continue; // declared elsewhere (re-export) — checked there
    if (JUSTIFIED[`${fileRel}:${name}`] !== undefined) {
      (justifiedByFile.get(fileRel) ??
        justifiedByFile.set(fileRel, new Set()).get(fileRel)).add(local);
      continue;
    }

    const t = { name, fileRel, testSurface, callers: new Set() };
    targets.set(local, t);
    (targetsByFile.get(fileRel) ?? targetsByFile.set(fileRel, []).get(fileRel)).push({
      sym: local,
      t,
    });
  }
}

// ── Walk every identifier in src + tests; resolve to a symbol. A
//    cross-file use records the caller file unconditionally (unchanged
//    rule). A same-file use is gated (B-16): it records {symbol,
//    enclosing top-level statement} and counts only if that statement
//    is alive, per the fixpoint below. ─────────────────────────────────
function resolve(symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function isSpecifierBinding(node) {
  const p = node.parent;
  return (
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isNamespaceExport(p)
  );
}

/** True if `node` sits inside one of `symbol`'s own declarations — its
    declaration name, a recursive call, a self-referential initializer.
    Self-references are never callers (B-16). */
function insideOwnDeclaration(node, symbol) {
  for (const d of symbol.declarations ?? []) {
    for (let cur = node; cur !== undefined && !ts.isSourceFile(cur); cur = cur.parent) {
      if (cur === d) return true;
    }
  }
  return false;
}

/** The module-scope statement containing `node`, or undefined. */
function topLevelStatement(node) {
  let cur = node;
  while (cur.parent !== undefined && !ts.isSourceFile(cur.parent)) cur = cur.parent;
  return cur.parent === undefined ? undefined : cur;
}

/** Symbols bound by a top-level statement — whose liveness gates the
    references inside it (B-16). */
function declaredSymbolsOf(stmt) {
  const syms = [];
  const push = (nameNode) => {
    const s = checker.getSymbolAtLocation(nameNode);
    if (s !== undefined) syms.push(resolve(s));
  };
  const walkBinding = (name) => {
    if (ts.isIdentifier(name)) push(name);
    else name.elements.forEach((el) => ts.isBindingElement(el) && walkBinding(el.name));
  };
  if (ts.isVariableStatement(stmt)) {
    stmt.declarationList.declarations.forEach((d) => walkBinding(d.name));
  } else if (
    (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) ||
     ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) ||
     ts.isEnumDeclaration(stmt) || ts.isModuleDeclaration(stmt)) &&
    stmt.name !== undefined
  ) {
    push(stmt.name);
  }
  return syms;
}

/** `export default …` is reachable through the default import — its
    declaration is a root regardless of whether it binds a name. */
function isDefaultExport(stmt) {
  return (
    ts.canHaveModifiers(stmt) &&
    (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  );
}

/** @type {Map<string, {roots: Set<ts.Node>, decls: Map<ts.Node, ts.Symbol[]>, symToStmt: Map<ts.Symbol, ts.Node>, refs: {sym: ts.Symbol, stmt: ts.Node}[], aliveSym?: Set<ts.Symbol>}>} */
const fileGraphs = new Map();

for (const file of [...srcFiles, ...testFiles]) {
  const sf = program.getSourceFile(file);
  if (sf === undefined) continue;
  const fileRel = rel(file);

  // Build the file's top-level liveness graph (src files only — a test
  // file's references to targets are unconditional cross-file callers).
  let graph;
  if (srcRel.has(fileRel)) {
    graph = { roots: new Set(), decls: new Map(), symToStmt: new Map(), refs: [] };
    for (const stmt of sf.statements) {
      const syms = isDefaultExport(stmt) ? [] : declaredSymbolsOf(stmt);
      // Roots: statements that execute at import, declarations that
      // bind nothing trackable, and declarations of JUSTIFIED exports
      // (a recorded deferral is reachable by decision — the exception
      // covers its own machinery).
      if (syms.length === 0 || syms.some((s) => justifiedByFile.get(fileRel)?.has(s))) {
        graph.roots.add(stmt);
      } else {
        graph.decls.set(stmt, syms);
        for (const s of syms) graph.symToStmt.set(s, stmt);
      }
    }
    fileGraphs.set(fileRel, graph);
  }

  const visit = (node) => {
    if (ts.isIdentifier(node) && !isSpecifierBinding(node)) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym !== undefined) {
        const resolved = resolve(sym);
        const target = targets.get(resolved);
        if (target !== undefined && fileRel !== target.fileRel) {
          target.callers.add(fileRel); // cross-file use: unchanged rule
        } else if (
          graph !== undefined &&
          (graph.symToStmt.has(resolved) ||
            (target !== undefined && fileRel === target.fileRel)) &&
          !insideOwnDeclaration(node, resolved)
        ) {
          // Same-file use (of a target declared here, or of any other
          // top-level binding): gated on the enclosing statement.
          const stmt = topLevelStatement(node);
          if (stmt !== undefined) graph.refs.push({ sym: resolved, stmt });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ── Aliveness fixpoint (B-16). A target is alive iff it has an
//    out-of-file caller that satisfies its caller class, or a same-file
//    reference from an alive top-level statement. Roots are alive at
//    seed; each iteration marks symbols referenced from alive
//    statements, then declarations whose bound symbols are alive.
//    Monotone — a dead cycle (mutual recursion, dead-code webs) never
//    seeds, so it converges with both still dead. ──────────────────────
for (const [fileRel, graph] of fileGraphs) {
  const aliveStmt = new Set(graph.roots);
  const aliveSym = new Set();
  for (const { sym, t } of targetsByFile.get(fileRel) ?? []) {
    const externalAlive = [...t.callers].some(
      (caller) => srcRel.has(caller) || (t.testSurface && testRel.has(caller)),
    );
    if (externalAlive) aliveSym.add(sym);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const { sym, stmt } of graph.refs) {
      if (aliveStmt.has(stmt) && !aliveSym.has(sym)) {
        aliveSym.add(sym);
        changed = true;
      }
    }
    for (const [stmt, syms] of graph.decls) {
      if (!aliveStmt.has(stmt) && syms.some((s) => aliveSym.has(s))) {
        aliveStmt.add(stmt);
        changed = true;
      }
    }
  }
  graph.aliveSym = aliveSym;
}

const dead = [];
for (const [sym, t] of targets) {
  if (!(fileGraphs.get(t.fileRel)?.aliveSym.has(sym) ?? false)) {
    dead.push(`${t.fileRel}: ${t.name}`);
  }
}
dead.sort();

if (dead.length > 0) {
  console.error('DEAD EXPORTS — a src/ export with no caller:');
  for (const d of dead) console.error(`  ${d}`);
  console.error(
    'Code that nothing calls is code-complete at best (PL-206). ' +
      'Wire a caller or remove the export. If the exception is a real, ' +
      'argued decision, add it to JUSTIFIED in scripts/check-dead-exports.mjs ' +
      'with the reason — never silently.',
  );
  process.exit(1);
}

console.log(
  `dead-export check: clean (${srcFiles.length} src files, ` +
    `${Object.keys(JUSTIFIED).length} justified exceptions)`,
);
