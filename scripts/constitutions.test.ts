import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONSTITUTIONS_DIR = 'docs/constitutions';
const INDEX_HEADING = '## Feature constitutions';
const STATUSES = ['draft', 'ratified'] as const;

interface Frontmatter {
  name: string;
  description: string;
  status: (typeof STATUSES)[number];
  scope: string[];
}

type FrontmatterResult =
  | { ok: true; frontmatter: Frontmatter }
  | { ok: false; errors: string[] };

interface IndexEntry {
  name: string;
  path: string;
  description: string;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Only the constitution format: a leading `---` block of `key: value` lines,
 * where `scope:` is followed by `  - item` lines. Not a YAML parser.
 */
function parseFrontmatter(text: string): FrontmatterResult {
  const lines = normalizeNewlines(text).split('\n');
  if (lines[0] !== '---') {
    return { ok: false, errors: ['missing leading --- frontmatter block'] };
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    return { ok: false, errors: ['frontmatter block is not closed with ---'] };
  }

  const errors: string[] = [];
  const fields = new Map<string, string>();
  const scope: string[] = [];
  let inScope = false;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') {
      continue;
    }
    const item = /^ {2}- (.+)$/.exec(line);
    if (item) {
      if (inScope) {
        scope.push(item[1].trim());
      } else {
        errors.push(`list item outside scope: ${line}`);
      }
      continue;
    }
    const pair = /^([A-Za-z][\w-]*):(?: (.*))?$/.exec(line);
    if (!pair) {
      errors.push(`unrecognized frontmatter line: ${line}`);
      inScope = false;
      continue;
    }
    const key = pair[1];
    const value = (pair[2] ?? '').trim();
    if (fields.has(key) || (key === 'scope' && inScope)) {
      errors.push(`duplicate key: ${key}`);
    }
    inScope = key === 'scope' && value === '';
    if (key === 'scope' && value !== '') {
      errors.push('scope must be a list of "  - item" lines');
    }
    fields.set(key, value);
  }

  for (const key of ['name', 'description', 'status'] as const) {
    if (!fields.get(key)) {
      errors.push(`missing ${key}`);
    }
  }
  if (!fields.has('scope')) {
    errors.push('missing scope');
  } else if (scope.length === 0) {
    errors.push('scope is empty');
  }
  const status = fields.get('status');
  if (status && !(STATUSES as readonly string[]).includes(status)) {
    errors.push(`status must be draft or ratified, got ${status}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    frontmatter: {
      name: fields.get('name') as string,
      description: fields.get('description') as string,
      status: status as Frontmatter['status'],
      scope,
    },
  };
}

function parseIndex(agentsMd: string): { entries: IndexEntry[]; errors: string[] } {
  const lines = normalizeNewlines(agentsMd).split('\n');
  const start = lines.indexOf(INDEX_HEADING);
  if (start === -1) {
    return { entries: [], errors: [`AGENTS.md has no "${INDEX_HEADING}" section`] };
  }
  const entries: IndexEntry[] = [];
  const errors: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) {
      break;
    }
    if (!line.startsWith('- **')) {
      continue;
    }
    const match = /^- \*\*(.+?)\*\* \(`([^`]+)`\): (.+)$/.exec(line);
    if (!match) {
      errors.push(`malformed index line: ${line}`);
      continue;
    }
    entries.push({ name: match[1], path: match[2], description: match[3] });
  }
  return { entries, errors };
}

function checkIndex(
  constitutions: ReadonlyMap<string, Frontmatter>,
  entries: IndexEntry[],
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      errors.push(`duplicate index line for ${entry.path}`);
    }
    seen.add(entry.path);
    const frontmatter = constitutions.get(entry.path);
    if (!frontmatter) {
      errors.push(`index line points to a missing constitution: ${entry.path}`);
      continue;
    }
    if (entry.name !== frontmatter.name) {
      errors.push(
        `${entry.path}: index name ${JSON.stringify(entry.name)} does not match frontmatter ${JSON.stringify(frontmatter.name)}`,
      );
    }
    if (entry.description !== frontmatter.description) {
      errors.push(`${entry.path}: index description does not match frontmatter description`);
    }
  }
  for (const path of constitutions.keys()) {
    if (!seen.has(path)) {
      errors.push(`${path} has no index line in AGENTS.md`);
    }
  }
  return errors;
}

function constitutionPaths(): string[] {
  const dir = join(repoRoot, CONSTITUTIONS_DIR);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `${CONSTITUTIONS_DIR}/${name}`);
}

const VALID_FRONTMATTER = `---
name: Example
description: What it is. Read before changing it.
status: draft
scope:
  - src/example.ts
  - server/store.ts (example part)
---

# Example constitution
`;

describe('parseFrontmatter', () => {
  it('parses name, description, status, and scope', () => {
    expect(parseFrontmatter(VALID_FRONTMATTER)).toEqual({
      ok: true,
      frontmatter: {
        name: 'Example',
        description: 'What it is. Read before changing it.',
        status: 'draft',
        scope: ['src/example.ts', 'server/store.ts (example part)'],
      },
    });
  });

  it('accepts CRLF line endings', () => {
    expect(parseFrontmatter(VALID_FRONTMATTER.replace(/\n/g, '\r\n')).ok).toBe(true);
  });

  it('reports a missing description', () => {
    const result = parseFrontmatter(
      VALID_FRONTMATTER.replace('description: What it is. Read before changing it.\n', ''),
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toContain('missing description');
  });

  it('reports an invalid status and an empty scope', () => {
    const result = parseFrontmatter(`---
name: Example
description: D.
status: final
scope:
---
`);
    expect(result.ok ? [] : result.errors).toEqual([
      'scope is empty',
      'status must be draft or ratified, got final',
    ]);
  });

  it('reports a file without frontmatter', () => {
    expect(parseFrontmatter('# Title\n').ok).toBe(false);
  });
});

describe('checkIndex', () => {
  const frontmatter: Frontmatter = {
    name: 'Example',
    description: 'What it is. Read before changing it.',
    status: 'draft',
    scope: ['src/example.ts'],
  };
  const path = 'docs/constitutions/example.md';

  function agentsWith(indexBody: string): string {
    return `# AGENTS.md\n\n${INDEX_HEADING}\n\nIntro.\n\n${indexBody}\n\n## Plans\n\n- **Not** (\`x.md\`): outside the section.\n`;
  }

  it('passes with zero constitutions and "None yet."', () => {
    const { entries, errors } = parseIndex(agentsWith('None yet.'));
    expect(errors).toEqual([]);
    expect(checkIndex(new Map(), entries)).toEqual([]);
  });

  it('passes when the index line matches the frontmatter', () => {
    const { entries } = parseIndex(
      agentsWith(`- **Example** (\`${path}\`): What it is. Read before changing it.`),
    );
    expect(checkIndex(new Map([[path, frontmatter]]), entries)).toEqual([]);
  });

  it('reports a one-character description mismatch', () => {
    const { entries } = parseIndex(
      agentsWith(`- **Example** (\`${path}\`): What it is. Read before changing it!`),
    );
    expect(checkIndex(new Map([[path, frontmatter]]), entries)).toEqual([
      `${path}: index description does not match frontmatter description`,
    ]);
  });

  it('reports a constitution with no index line and a line pointing to a missing file', () => {
    const { entries } = parseIndex(
      agentsWith('- **Gone** (`docs/constitutions/gone.md`): Deleted.'),
    );
    expect(checkIndex(new Map([[path, frontmatter]]), entries)).toEqual([
      'index line points to a missing constitution: docs/constitutions/gone.md',
      `${path} has no index line in AGENTS.md`,
    ]);
  });

  it('reports a malformed index line', () => {
    expect(parseIndex(agentsWith('- **Example** docs/constitutions/example.md')).errors).toHaveLength(1);
  });
});

describe('docs/constitutions and the AGENTS.md index', () => {
  const paths = constitutionPaths();
  const constitutions = new Map<string, Frontmatter>();
  const frontmatterErrors: string[] = [];
  for (const path of paths) {
    const result = parseFrontmatter(readFileSync(join(repoRoot, path), 'utf8'));
    if (result.ok) {
      constitutions.set(path, result.frontmatter);
    } else {
      frontmatterErrors.push(...result.errors.map((error) => `${path}: ${error}`));
    }
  }

  it('every constitution has valid frontmatter', () => {
    expect(frontmatterErrors).toEqual([]);
  });

  it('every constitution has a matching index line and every line has a file', () => {
    const { entries, errors } = parseIndex(readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8'));
    expect(errors).toEqual([]);
    expect(checkIndex(constitutions, entries)).toEqual([]);
  });
});
