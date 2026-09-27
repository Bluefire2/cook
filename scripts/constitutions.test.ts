import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_SCALARS = ['name', 'description', 'status'] as const;

type ParsedFrontmatter = {
  name: string;
  description: string;
  status: string;
  scope: string[];
};

type FrontmatterResult = { fields: ParsedFrontmatter } | { errors: string[] };

type IndexEntry = {
  name: string;
  path: string;
  description: string;
};

type ConstitutionFile = {
  file: string;
  text: string;
};

const INDEX_LINE = /^- \*\*(.+)\*\* \(`([^`]+)`\): (.*)$/;

function parseFrontmatter(text: string): FrontmatterResult {
  const errors: string[] = [];
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { errors: ['frontmatter must start with ---'] };
  }

  const lines = normalized.split('\n');
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { errors: ['frontmatter is missing a closing ---'] };

  const scalars = new Map<string, string>();
  const scope: string[] = [];
  let inScope = false;
  let sawScope = false;

  for (const line of lines.slice(1, close)) {
    if (line === '') continue;

    if (inScope && line.startsWith('  - ')) {
      const item = line.slice(4).trim();
      if (item.length === 0) errors.push('empty scope item');
      else scope.push(item);
      continue;
    }

    inScope = false;

    const scalar = /^([A-Za-z][A-Za-z0-9]*): (.*)$/.exec(line);
    const bare = /^([A-Za-z][A-Za-z0-9]*):\s*$/.exec(line);
    if (!scalar && !bare) {
      errors.push(`unexpected frontmatter line: ${line}`);
      continue;
    }

    const key = (scalar ?? bare)?.[1];
    if (!key) continue;

    if (key === 'scope') {
      if (sawScope) errors.push('duplicate scope');
      if (scalar && scalar[2].trim().length > 0) errors.push('scope must be a list');
      sawScope = true;
      inScope = true;
      continue;
    }

    const value = scalar?.[2] ?? '';
    if (value.trim().length === 0) continue;
    if (scalars.has(key)) errors.push(`duplicate ${key}`);
    else scalars.set(key, value);
  }

  for (const key of REQUIRED_SCALARS) {
    if (!scalars.has(key)) errors.push(`missing ${key}`);
  }
  if (!sawScope) errors.push('missing scope');

  const description = scalars.get('description');
  if (description !== undefined && description.length > 300) {
    errors.push('description is longer than 300 characters');
  }

  const status = scalars.get('status');
  if (status !== undefined && status !== 'draft' && status !== 'ratified') {
    errors.push('invalid status');
  }

  if (sawScope && scope.length === 0 && !errors.includes('missing scope')) {
    errors.push('scope is empty');
  }

  if (errors.length > 0) return { errors };

  return {
    fields: {
      name: scalars.get('name') ?? '',
      description: description ?? '',
      status: status ?? '',
      scope,
    },
  };
}

function featureConstitutionsSection(agentsMd: string): string | null {
  const normalized = agentsMd.replace(/\r\n/g, '\n');
  const match = /^## Feature constitutions[ \t]*$/m.exec(normalized);
  if (!match || match.index === undefined) return null;
  const rest = normalized.slice(match.index + match[0].length);
  const next = /^## /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function parseIndex(section: string): { entries: IndexEntry[]; errors: string[]; noneYet: boolean } {
  const entries: IndexEntry[] = [];
  const errors: string[] = [];
  let noneYet = false;

  for (const line of section.split('\n')) {
    if (line.trim() === 'None yet.') {
      noneYet = true;
      continue;
    }
    if (!line.startsWith('- **')) continue;
    const match = INDEX_LINE.exec(line);
    if (!match) {
      errors.push(`unparseable index line: ${line}`);
      continue;
    }
    const name = match[1];
    const path = match[2];
    const description = match[3];
    if (name === undefined || path === undefined || description === undefined) continue;
    entries.push({ name, path, description });
  }

  return { entries, errors, noneYet };
}

function constitutionDrift(input: { constitutions: ConstitutionFile[]; agentsMd: string }): string[] {
  const section = featureConstitutionsSection(input.agentsMd);
  if (section === null) return ['AGENTS.md is missing the ## Feature constitutions section'];

  const index = parseIndex(section);
  const errors = [...index.errors];
  const files = new Set(input.constitutions.map((doc) => doc.file));
  const parsed = new Map<string, ParsedFrontmatter>();

  for (const doc of input.constitutions) {
    const result = parseFrontmatter(doc.text);
    if ('errors' in result) {
      for (const error of result.errors) errors.push(`${doc.file}: ${error}`);
      continue;
    }
    parsed.set(doc.file, result.fields);
  }

  const indexed = new Set<string>();
  for (const entry of index.entries) {
    if (!files.has(entry.path)) {
      errors.push(`index line points to missing file ${entry.path}`);
      continue;
    }
    indexed.add(entry.path);
    const fields = parsed.get(entry.path);
    if (!fields) continue;
    if (entry.name !== fields.name) {
      errors.push(`${entry.path}: index name does not match frontmatter`);
    }
    if (entry.description !== fields.description) {
      errors.push(`${entry.path}: index description does not match frontmatter`);
    }
  }

  for (const file of files) {
    if (!indexed.has(file)) errors.push(`${file}: constitution has no index line`);
  }

  if (files.size === 0 && index.entries.length === 0 && !index.noneYet) {
    errors.push('index must say "None yet." when there are no constitutions');
  }

  return errors;
}

function listConstitutions(): ConstitutionFile[] {
  const dir = join(repoRoot, 'docs', 'constitutions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      file: `docs/constitutions/${name}`,
      text: readFileSync(join(dir, name), 'utf8'),
    }));
}

const VALID = `---
name: Sync toast
description: A toast when a sync moves data. Read before changing SyncToast and sync().
status: draft
scope:
  - src/components/SyncToast.tsx
  - src/lib/syncEngine.ts (emit path)
---

# Sync toast constitution
`;

function agentsWithIndex(description: string): string {
  return [
    '## Feature constitutions',
    '',
    `- **Sync toast** (\`docs/constitutions/sync-toast.md\`): ${description}`,
    '',
    '## Plans',
    '',
  ].join('\n');
}

describe('parseFrontmatter', () => {
  it('reports a missing description', () => {
    const result = parseFrontmatter(`---
name: Sync toast
status: draft
scope:
  - src/components/SyncToast.tsx
---
`);
    expect('errors' in result).toBe(true);
    if ('errors' in result) expect(result.errors).toContain('missing description');
  });

  it('reports a description longer than 300 characters', () => {
    const result = parseFrontmatter(`---
name: Sync toast
description: ${'a'.repeat(301)}
status: draft
scope:
  - src/components/SyncToast.tsx
---
`);
    expect('errors' in result).toBe(true);
    if ('errors' in result) expect(result.errors).toContain('description is longer than 300 characters');
  });

  it('reports an invalid status and an empty scope', () => {
    const result = parseFrontmatter(`---
name: Sync toast
description: A toast. Read before changing SyncToast.
status: proposed
scope:
---
`);
    expect('errors' in result).toBe(true);
    if ('errors' in result) {
      expect(result.errors).toContain('invalid status');
      expect(result.errors).toContain('scope is empty');
    }
  });
});

describe('constitution index drift', () => {
  it('passes when there are zero constitutions and the index says "None yet."', () => {
    const errors = constitutionDrift({
      constitutions: [],
      agentsMd: ['## Feature constitutions', '', 'None yet.', '', '## Plans', ''].join('\n'),
    });
    expect(errors).toEqual([]);
  });

  it('reports a one-character description mismatch', () => {
    const parsed = parseFrontmatter(VALID);
    if ('errors' in parsed) throw new Error(parsed.errors.join('\n'));

    expect(
      constitutionDrift({
        constitutions: [{ file: 'docs/constitutions/sync-toast.md', text: VALID }],
        agentsMd: agentsWithIndex(parsed.fields.description),
      }),
    ).toEqual([]);

    const shifted = `${parsed.fields.description.slice(0, -1)}X`;
    const errors = constitutionDrift({
      constitutions: [{ file: 'docs/constitutions/sync-toast.md', text: VALID }],
      agentsMd: agentsWithIndex(shifted),
    });
    expect(errors).toContain(
      'docs/constitutions/sync-toast.md: index description does not match frontmatter',
    );
  });

  it('reports a constitution with no index line', () => {
    const errors = constitutionDrift({
      constitutions: [{ file: 'docs/constitutions/sync-toast.md', text: VALID }],
      agentsMd: ['## Feature constitutions', '', 'None yet.', '', '## Plans', ''].join('\n'),
    });
    expect(errors).toContain('docs/constitutions/sync-toast.md: constitution has no index line');
  });

  it('reports an index line that points at a missing file', () => {
    const errors = constitutionDrift({
      constitutions: [],
      agentsMd: agentsWithIndex('A toast when a sync moves data. Read before changing SyncToast and sync().'),
    });
    expect(errors).toContain('index line points to missing file docs/constitutions/sync-toast.md');
  });

  it('matches the constitutions in this repo', () => {
    const errors = constitutionDrift({
      constitutions: listConstitutions(),
      agentsMd: readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8'),
    });
    expect(errors).toEqual([]);
  });
});
