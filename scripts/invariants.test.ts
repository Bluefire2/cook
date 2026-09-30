import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Rules from AGENTS.md that a grep can check. Each failure message names the
// rule so the fix is to follow it, not to loosen the check.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
}

function filesUnder(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const child = join(abs, name);
      if (statSync(child).isDirectory()) {
        walk(child);
      } else if (extensions.some((ext) => name.endsWith(ext))) {
        out.push(relative(repoRoot, child).replace(/\\/g, '/'));
      }
    }
  };
  walk(join(repoRoot, dir));
  return out.sort();
}

function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
}

/** Non-comment lines of a file matching `pattern`, as `path:line: text`. */
function matchingLines(path: string, pattern: RegExp, commentPrefix = '//'): string[] {
  return read(path)
    .split('\n')
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      return !trimmed.startsWith(commentPrefix) && !trimmed.startsWith('*') && pattern.test(text);
    })
    .map(({ text, line }) => `${path}:${line}: ${text.trim()}`);
}

describe('api/ (Vercel copies)', () => {
  it('api/*.ts handlers import no sibling or parent modules', () => {
    // AGENTS.md: api/chat.ts "cannot import siblings"; Vercel bundles each file alone.
    const relativeImport = /(?:\bfrom\s+|\bimport\s*\(?\s*)['"]\.\.?\//;
    const offenders = filesUnder('api', ['.ts'])
      .filter((path) => !isTestFile(path))
      .flatMap((path) => matchingLines(path, relativeImport));
    expect(offenders).toEqual([]);
  });
});

describe('client architecture', () => {
  it('screens and components never call fetch', () => {
    // AGENTS.md: syncEngine and remote (and the *Api modules) own fetch; screens must not.
    const offenders = ['src/screens', 'src/components']
      .flatMap((dir) => filesUnder(dir, ['.ts', '.tsx']))
      .flatMap((path) => matchingLines(path, /\bfetch\s*\(/));
    expect(offenders).toEqual([]);
  });

  it('no VITE_-prefixed variable outside the non-secret allowlist', () => {
    // Vite inlines VITE_* into the client bundle. Never give a secret that prefix.
    // A new non-secret build-time variable goes in this list, on purpose.
    const ALLOWED_VITE_VARS = new Set<string>([]);
    const files = [
      ...filesUnder('src', ['.ts', '.tsx']),
      'index.html',
      'vite.config.ts',
      '.env.example',
    ];
    const found = files.flatMap((path) =>
      [...read(path).matchAll(/\bVITE_[A-Z0-9_]+/g)]
        .map((match) => match[0])
        .filter((name) => !ALLOWED_VITE_VARS.has(name))
        .map((name) => `${path}: ${name}`),
    );
    expect(found).toEqual([]);
  });
});

describe('server', () => {
  it('never uses Response.redirect', () => {
    // AGENTS.md: Response.redirect() has immutable headers, so Set-Cookie on the
    // OAuth callback would be dropped. Build a Response with a Location header.
    const offenders = ['server', 'api', 'scripts']
      .flatMap((dir) => filesUnder(dir, ['.ts']))
      .filter((path) => !isTestFile(path))
      .flatMap((path) => matchingLines(path, /\bResponse\.redirect\s*\(/));
    expect(offenders).toEqual([]);
  });
});

describe('deploy', () => {
  it('deploy.sh never passes --set-env-vars', () => {
    // AGENTS.md: ALLOWED_EMAILS is comma-separated; --env-vars-file only.
    expect(matchingLines('scripts/deploy.sh', /--set-env-vars/, '#')).toEqual([]);
  });

  it('the Deploy workflow runs only on workflow_dispatch', () => {
    // AGENTS.md: deploy.yml is workflow_dispatch only; do not add a push trigger.
    const lines = read('.github/workflows/deploy.yml').split('\n');
    const start = lines.findIndex((line) => /^on:\s*$/.test(line));
    expect(start, 'deploy.yml needs a block-style `on:` key').toBeGreaterThanOrEqual(0);
    const triggers: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break;
      const key = /^ {2}([A-Za-z_]+):/.exec(line);
      if (key) triggers.push(key[1]);
    }
    expect(triggers).toEqual(['workflow_dispatch']);
  });

  it('package.json name stays "cook"', () => {
    expect((JSON.parse(read('package.json')) as { name: string }).name).toBe('cook');
  });
});

describe('AGENTS.md plan table', () => {
  it('every docs/plans path in AGENTS.md exists', () => {
    const referenced = [
      ...new Set([...read('AGENTS.md').matchAll(/docs\/plans\/[\w.-]+\.md/g)].map((m) => m[0])),
    ].sort();
    const missing = referenced.filter((path) => !existsSync(join(repoRoot, path)));
    expect(missing).toEqual([]);
  });
});

describe('extension/', () => {
  const manifest = JSON.parse(read('extension/manifest.json')) as {
    manifest_version: number;
    background?: { service_worker?: string };
    action?: { default_popup?: string; default_icon?: Record<string, string> };
    icons?: Record<string, string>;
  };

  it('is a Manifest V3 extension', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('every file the manifest references exists', () => {
    const referencedFiles = [
      manifest.background?.service_worker,
      manifest.action?.default_popup,
      ...Object.values(manifest.action?.default_icon ?? {}),
      ...Object.values(manifest.icons ?? {}),
    ].filter((path): path is string => typeof path === 'string');
    expect(referencedFiles.length).toBeGreaterThan(0);
    const missing = referencedFiles.filter((path) => !existsSync(join(repoRoot, 'extension', path)));
    expect(missing).toEqual([]);
  });

  it('every script parses', () => {
    // extension/ is plain JS outside tsc; this is its only syntax check.
    const failures = filesUnder('extension', ['.js']).flatMap((path) => {
      const result = spawnSync(process.execPath, ['--check', join(repoRoot, path)], {
        encoding: 'utf8',
      });
      return result.status === 0 ? [] : [`${path}: ${result.stderr.trim()}`];
    });
    expect(failures).toEqual([]);
  });
});
