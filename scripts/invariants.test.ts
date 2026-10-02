import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DELETION_ORDER,
  ACCOUNT_DELETION_STEPS,
  FIRESTORE_COLLECTIONS,
  personalTopLevelCollections,
} from '../server/accountDeletion.ts';
import { STORE_KINDS } from '../server/sync.ts';

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

describe('client state (docs/constitutions/client-state.md)', () => {
  const LIBRARY_MEMORY = 'src/lib/libraryMemory.ts';

  /** Top-level function bodies of a file, keyed by function name. */
  function topLevelFunctions(path: string): Map<string, string> {
    const out = new Map<string, string>();
    const chunks = read(path).split(/^(?=(?:export )?(?:async )?function \w+)/m);
    for (const chunk of chunks) {
      const name = /^(?:export )?(?:async )?function (\w+)/.exec(chunk)?.[1];
      if (name) {
        out.set(name, chunk);
      }
    }
    return out;
  }

  it('libraryMemory never mutates a published map in place', () => {
    // Principle 2: a write copies the maps it changes; published maps stay untouched.
    const offenders = matchingLines(
      LIBRARY_MEMORY,
      /\bsnapshot\.[A-Za-z]+\.(?:set|delete|add|clear)\(/,
    );
    expect(offenders).toEqual([]);
  });

  it('libraryMemory copies every map only for rollback', () => {
    // Principle 2: cloneMaps is for captureSnapshot/restoreSnapshot; ordinary
    // writes copy only the maps they change.
    const callers = [...topLevelFunctions(LIBRARY_MEMORY)]
      .filter(([name, body]) => name !== 'cloneMaps' && /\bcloneMaps\(/.test(body))
      .map(([name]) => name)
      .sort();
    expect(callers).toEqual(['captureSnapshot', 'restoreSnapshot']);
  });

  it('only useLibrary.ts subscribes React to libraryMemory', () => {
    // Principles 3–4: other modules read the library through useLibrarySlice/useLibrarySelect.
    // Flags a useSyncExternalStore call whose subscribe argument was imported
    // from libraryMemory. A module may import other libraryMemory helpers and
    // still subscribe React to its own store.
    const libraryImport =
      /import\s*\{([^}]*)\}\s*from\s*['"](?:\.\.?\/)+(?:lib\/)?libraryMemory['"]/g;
    const offenders = filesUnder('src', ['.ts', '.tsx'])
      .filter((path) => !isTestFile(path) && path !== 'src/lib/useLibrary.ts')
      .flatMap((path) => {
        const text = read(path);
        const imported = new Set(
          [...text.matchAll(libraryImport)].flatMap((match) =>
            match[1]
              .split(',')
              .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop() ?? '')
              .filter((name) => name !== ''),
          ),
        );
        return [...text.matchAll(/\buseSyncExternalStore\(\s*(\w+)/g)]
          .filter((call) => imported.has(call[1]))
          .map((call) => `${path}: useSyncExternalStore(${call[1]}, …)`);
      });
    expect(offenders).toEqual([]);
  });

  it('useLibrarySelect takes a named selector from librarySelectors.ts', () => {
    // Principles 3–4: an inline selector escapes the stability test in
    // librarySelectors.test.ts; a fresh object from one re-renders forever.
    const offenders = filesUnder('src', ['.ts', '.tsx'])
      .filter((path) => !isTestFile(path) && path !== 'src/lib/useLibrary.ts')
      .flatMap((path) =>
        matchingLines(path, /\buseLibrarySelect\(\s*(?:\(|function\b|async\b|\w+\s*=>)/),
      );
    expect(offenders).toEqual([]);
  });

  it('a component that reads sharing or access during render subscribes to that map', () => {
    // Principle 5: recipeStore/collectionStore isShared/access/sharedBy read the
    // origin maps, which only the list hooks subscribe to. A read beside
    // useRecipe alone would go stale when a pull changes access.
    const rules = [
      { read: /\brecipeStore\.(?:isShared|access|sharedBy)\(/, hook: /\buseRecipes\(/ },
      { read: /\bcollectionStore\.(?:isShared|access|sharedBy)\(/, hook: /\buseCollections\(/ },
    ];
    const offenders = ['src/screens', 'src/components', 'src/agent']
      .flatMap((dir) => filesUnder(dir, ['.ts', '.tsx']))
      .filter((path) => !isTestFile(path))
      .flatMap((path) => {
        const text = read(path);
        return rules
          .filter((rule) => rule.read.test(text) && !rule.hook.test(text))
          .map((rule) => `${path}: ${rule.read.source} without ${rule.hook.source}`);
      });
    expect(offenders).toEqual([]);
  });

  it('stores and hooks never force a render with a counter', () => {
    // Principle 3: React reads module stores through useSyncExternalStore, not a bumped counter.
    const counterBump = /\b(?:set\w*|tick)\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\s*\+\s*1\s*\)/;
    const offenders = ['src/lib', 'src/agent']
      .flatMap((dir) => filesUnder(dir, ['.ts', '.tsx']))
      .filter((path) => !isTestFile(path))
      .flatMap((path) => matchingLines(path, counterBump));
    expect(offenders).toEqual([]);
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

describe('auth surfaces (Auth and Public MCP in AGENTS.md)', () => {
  const productionTs = () =>
    ['server', 'api', 'scripts']
      .flatMap((dir) => filesUnder(dir, ['.ts']))
      .filter((path) => !isTestFile(path));

  it('header-session auth stays extension-only', () => {
    // The X-Sous-Session exception is POST /api/extension/import alone; session.ts
    // defines readHeaderSession and membership.ts wraps it.
    const users = productionTs()
      .filter((path) => matchingLines(path, /\b(?:readHeaderSession|requireHeaderMember)\b/).length > 0)
      .sort();
    expect(users).toEqual(['server/extensionImport.ts', 'server/membership.ts', 'server/session.ts']);
  });

  it('under server/mcp/, only the consent pages and the Settings routes touch cookies or sessions', () => {
    // /mcp and /oauth/token read a bearer or a form body, never a cookie.
    const offenders = productionTs()
      .filter((path) => path.startsWith('server/mcp/'))
      .filter((path) => path !== 'server/mcp/oauth/authorize.ts' && path !== 'server/mcp/grantsHttp.ts')
      .flatMap((path) => matchingLines(path, /\b(?:readSession|readCookie|requireMember)\b/));
    expect(offenders).toEqual([]);
  });
});

describe('account deletion covers every collection (server/accountDeletion.ts)', () => {
  it('every Firestore collection the code uses is classified in FIRESTORE_COLLECTIONS', () => {
    // /privacy promises a deletion request removes all of a member's data. A
    // collection nobody classified is one the deletion script never visits.
    const files = ['server', 'api', 'scripts']
      .flatMap((dir) => filesUnder(dir, ['.ts']))
      .filter((path) => !isTestFile(path));
    const constants = new Map<string, string>();
    for (const path of files) {
      for (const match of read(path).matchAll(/(?:export )?const (\w+) = (['"`])([^'"`$]+)\2;/g)) {
        constants.set(match[1], match[3]);
      }
    }
    // An argument that is neither a plain string nor a known constant (a
    // template with a substitution, a variable) is an offender, so the check
    // fails closed; exempt one below only when its type already pins it.
    const offenders: string[] = [];
    for (const path of files) {
      for (const match of read(path).matchAll(/\.collection(?:Group)?\(([^)]*)\)/g)) {
        const arg = match[1].trim();
        // store.ts colRef(uid, kind): a StoreKind, checked below.
        if (path === 'server/store.ts' && arg === 'kind') continue;
        // accountDeletion.ts takes the name as a PersonalTopLevel, typed against the registry.
        if (path === 'server/accountDeletion.ts' && arg === 'collection') continue;
        const name = /^(['"`])[^'"`$]+\1$/.test(arg) ? arg.slice(1, -1) : constants.get(arg);
        if (name === undefined || !Object.hasOwn(FIRESTORE_COLLECTIONS, name)) {
          offenders.push(`${path}: .collection(${arg})`);
        }
      }
    }
    expect(offenders).toEqual([]);
    for (const kind of STORE_KINDS) {
      expect(FIRESTORE_COLLECTIONS[kind]).toMatchObject({ scope: 'nested', parent: 'users/{sub}' });
    }
  });

  it('runs a step for each personal top-level collection, once, with users last', () => {
    expect([...ACCOUNT_DELETION_ORDER].sort()).toEqual(personalTopLevelCollections().sort());
    expect(Object.keys(ACCOUNT_DELETION_STEPS).sort()).toEqual(personalTopLevelCollections().sort());
    expect(ACCOUNT_DELETION_ORDER.at(-1)).toBe('users');
    expect(ACCOUNT_DELETION_ORDER[0]).toBe('incomingShares');
  });

  it('the README deletion procedure runs scripts/delete-account-data.ts and deletes the photos', () => {
    const readme = read('README.md');
    const start = readme.indexOf('**Manual deletion procedure (operator)');
    const end = readme.indexOf('There is **no automated purge job**', start);
    expect(start).toBeGreaterThan(-1);
    const procedure = readme.slice(start, end);
    expect(procedure).toContain('scripts/delete-account-data.ts');
    expect(procedure).toContain('gcloud storage rm --recursive');
    expect(existsSync(join(repoRoot, 'scripts/delete-account-data.ts'))).toBe(true);
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

  it('package.json name is "sous"', () => {
    expect((JSON.parse(read('package.json')) as { name: string }).name).toBe('sous');
  });
});

/** Full docs/plans/*.md links, plus bare `name.md` links in the plans section. */
function planPathsIn(agentsMd: string): string[] {
  const full = [...agentsMd.matchAll(/docs\/plans\/([\w.-]+\.md)/g)].map((m) => `docs/plans/${m[1]}`);
  const lines = agentsMd.split('\n');
  const start = lines.findIndex((line) => line.startsWith('## Plans'));
  const section: string[] = [];
  if (start !== -1) {
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith('## ')) break;
      section.push(line);
    }
  }
  const bare = [...section.join('\n').matchAll(/`([\w.-]+\.md)`/g)].map((m) => `docs/plans/${m[1]}`);
  return [...new Set([...full, ...bare])].sort();
}

describe('AGENTS.md plan table', () => {
  it('counts bare filenames in the plans section as docs/plans paths', () => {
    const sample = [
      'See `docs/plans/elsewhere.md`.',
      '## Plans (source of truth for unfinished work)',
      '| `docs/plans/full.md`, `bare-name.md` |',
      '## Tests and verification',
      'Ignore `not-a-plan.md`.',
    ].join('\n');
    expect(planPathsIn(sample)).toEqual([
      'docs/plans/bare-name.md',
      'docs/plans/elsewhere.md',
      'docs/plans/full.md',
    ]);
  });

  it('every docs/plans path in AGENTS.md exists', () => {
    const missing = planPathsIn(read('AGENTS.md')).filter((path) => !existsSync(join(repoRoot, path)));
    expect(missing).toEqual([]);
  });
});

/** Static `from './x'`, `import './x'`, and `import('./x')`. Skips comments. */
function relativeImportSpecifiers(text: string): string[] {
  const specifier = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)['"](\.\.?\/[^'"]+)['"]/g;
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .flatMap((line) => [...line.matchAll(specifier)].map((match) => match[1]));
}

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

  it('reads static relative imports from non-comment lines', () => {
    const text = [
      "import { grabPageSource } from './extract-page.js';",
      "import './side.js';",
      "const loaded = import('./dyn.js');",
      'import.meta.url;',
      "// from './comment.js'",
      "export { a } from '../lib/a.js';",
    ].join('\n');
    expect(relativeImportSpecifiers(text)).toEqual([
      './extract-page.js',
      './side.js',
      './dyn.js',
      '../lib/a.js',
    ]);
  });

  it('every relative import resolves to a file', () => {
    // node --check parses syntax and does not resolve specifiers.
    const missing = filesUnder('extension', ['.js']).flatMap((path) =>
      relativeImportSpecifiers(read(path)).flatMap((spec) => {
        const resolved = join(repoRoot, dirname(path), spec);
        return existsSync(resolved) ? [] : [`${path}: ${spec}`];
      }),
    );
    expect(missing).toEqual([]);
  });
});
