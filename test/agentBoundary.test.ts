import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function listProductionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listProductionSources(full));
    } else if (entry.isFile() && isProductionSource(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isProductionSource(name: string): boolean {
  if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) {
    return false;
  }
  return name.endsWith('.ts') || name.endsWith('.tsx');
}

function productionSources(): string[] {
  const roots = [
    join(repoRoot, 'api'),
    join(repoRoot, 'server'),
    join(repoRoot, 'scripts'),
    join(repoRoot, 'src'),
  ];
  return roots.flatMap((root) => listProductionSources(root));
}

function relPosix(abs: string): string {
  return relative(repoRoot, abs).replace(/\\/g, '/');
}

function withoutExtension(rel: string): string {
  return rel.replace(/\.(tsx?)$/, '');
}

function resolveModulePath(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('node:')) {
    return null;
  }
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return specifier;
  }
  const fromDir = dirname(fromFile);
  const raw = resolve(fromDir, specifier);
  const candidates = [
    raw,
    `${raw}.ts`,
    `${raw}.tsx`,
    join(raw, 'index.ts'),
    join(raw, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return withoutExtension(relPosix(candidate));
    }
  }
  return withoutExtension(relPosix(raw));
}

type ImportRef = {
  from: string;
  specifier: string;
  resolved: string | null;
  typeOnly: boolean;
  kind: 'import' | 'export-from' | 'dynamic';
};

function isImportDeclarationTypeOnly(node: ts.ImportDeclaration): boolean {
  if (node.importClause?.isTypeOnly) {
    return true;
  }
  const named = node.importClause?.namedBindings;
  if (named && ts.isNamedImports(named)) {
    if (named.elements.length === 0) {
      return false;
    }
    return named.elements.every((el) => el.isTypeOnly);
  }
  return false;
}

function collectImportRefs(sourceFile: ts.SourceFile, fromAbs: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const from = relPosix(fromAbs);

  function add(
    specifier: string,
    typeOnly: boolean,
    kind: ImportRef['kind'],
  ): void {
    refs.push({
      from,
      specifier,
      resolved: resolveModulePath(fromAbs, specifier),
      typeOnly,
      kind,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, isImportDeclarationTypeOnly(node), 'import');
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const typeOnly = node.isTypeOnly === true;
      add(node.moduleSpecifier.text, typeOnly, 'export-from');
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      add(node.arguments[0].text, false, 'dynamic');
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return refs;
}

function parseSource(abs: string): ts.SourceFile {
  const text = readFileSync(abs, 'utf8');
  return ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

const SANITY_PATHS = [
  'scripts/server.ts',
  'server/agent/index.ts',
  'src/agent/protocol.ts',
] as const;

function expectScanReady(files: string[]): string[] {
  expect(files.length).toBeGreaterThan(0);
  const rels = files.map(relPosix);
  for (const must of SANITY_PATHS) {
    expect(rels, `production scan missing ${must}`).toContain(must);
  }
  return rels;
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

describe('agent module boundaries', () => {
  const files = productionSources();
  const rels = expectScanReady(files);

  const allRefs = files.flatMap((abs) => collectImportRefs(parseSource(abs), abs));

  it('1: only server/agent/index.ts is imported from outside server/agent/', () => {
    const violations: string[] = [];
    for (const ref of allRefs) {
      if (ref.resolved === null || !isUnder(ref.resolved, 'server/agent')) {
        continue;
      }
      if (isUnder(ref.from, 'server/agent')) {
        continue;
      }
      if (ref.resolved !== 'server/agent/index') {
        violations.push(`${ref.from} -> ${ref.specifier} (${ref.resolved})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('2: harness imports are restricted and only google.ts uses @google/genai', () => {
    const violations: string[] = [];
    for (const ref of allRefs) {
      if (!isUnder(ref.from, 'server/agent/harness')) {
        continue;
      }
      const base = ref.from.split('/').pop() ?? '';
      if (ref.specifier === '@google/genai') {
        if (base !== 'google.ts') {
          violations.push(`${ref.from} imports @google/genai`);
        }
        continue;
      }
      if (ref.specifier.startsWith('node:')) {
        continue;
      }
      if (ref.resolved && isUnder(ref.resolved, 'server/agent/harness')) {
        continue;
      }
      if (ref.resolved === null && ref.specifier.startsWith('.')) {
        violations.push(`${ref.from} unresolved relative ${ref.specifier}`);
        continue;
      }
      if (ref.resolved && !ref.resolved.startsWith('server/agent/harness')) {
        violations.push(`${ref.from} -> ${ref.resolved}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('3: sous imports only harness, sous, and server/store.ts', () => {
    const violations: string[] = [];
    for (const ref of allRefs) {
      if (!isUnder(ref.from, 'server/agent/sous')) {
        continue;
      }
      if (ref.specifier === '@google/genai') {
        violations.push(`${ref.from} imports @google/genai`);
        continue;
      }
      if (ref.resolved === 'server/store') {
        continue;
      }
      if (ref.resolved && isUnder(ref.resolved, 'server/agent/harness')) {
        continue;
      }
      if (ref.resolved && isUnder(ref.resolved, 'server/agent/sous')) {
        continue;
      }
      if (ref.specifier.startsWith('node:')) {
        continue;
      }
      if (ref.resolved === null && ref.specifier.startsWith('.')) {
        continue;
      }
      violations.push(`${ref.from} -> ${ref.specifier} (${ref.resolved ?? 'external'})`);
    }
    expect(violations).toEqual([]);
  });

  it('4: only src/agent/index.ts is imported from outside src/agent/', () => {
    const violations: string[] = [];
    for (const ref of allRefs) {
      if (ref.resolved === null || !isUnder(ref.resolved, 'src/agent')) {
        continue;
      }
      if (isUnder(ref.from, 'src/agent')) {
        continue;
      }
      if (ref.resolved !== 'src/agent/index') {
        violations.push(`${ref.from} -> ${ref.specifier} (${ref.resolved})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('5: server imports from src/ are type-only', () => {
    const violations: string[] = [];
    for (const ref of allRefs) {
      if (!isUnder(ref.from, 'server')) {
        continue;
      }
      if (ref.resolved === null || !isUnder(ref.resolved, 'src')) {
        continue;
      }
      if (!ref.typeOnly) {
        violations.push(`${ref.from} runtime import from ${ref.resolved} (${ref.kind})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('6: protocol.ts is types-only; parse.ts imports only protocol types', () => {
    const protocolPath = join(repoRoot, 'src/agent/protocol.ts');
    expect(rels).toContain('src/agent/protocol.ts');
    const protocol = parseSource(protocolPath);
    const runtimeExports: string[] = [];
    for (const stmt of protocol.statements) {
      if (ts.isImportDeclaration(stmt) && !isImportDeclarationTypeOnly(stmt)) {
        runtimeExports.push('runtime import in protocol.ts');
      }
      if (ts.isFunctionDeclaration(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        runtimeExports.push('exported function');
      }
      if (ts.isVariableStatement(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        runtimeExports.push('exported variable');
      }
      if (ts.isClassDeclaration(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        runtimeExports.push('exported class');
      }
      if (ts.isEnumDeclaration(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        runtimeExports.push('exported enum');
      }
      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        runtimeExports.push('export default');
      }
      if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
        if (!stmt.exportClause || ts.isNamespaceExport(stmt.exportClause)) {
          runtimeExports.push('export declaration');
        } else if (ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            if (!el.isTypeOnly) {
              runtimeExports.push(`export ${el.name.text}`);
            }
          }
        }
      }
    }
    expect(runtimeExports).toEqual([]);

    const parsePath = join(repoRoot, 'src/agent/cards/parse.ts');
    const parseRefs = collectImportRefs(parseSource(parsePath), parsePath);
    for (const ref of parseRefs) {
      expect(ref.resolved).toBe('src/agent/protocol');
      expect(ref.typeOnly).toBe(true);
    }
  });
});
