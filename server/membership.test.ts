import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as members from './members.ts';
import {
  accessDecision,
  cacheSizeForTest,
  clearMembershipCache,
  lookupMemberForTest,
} from './membership.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function listProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listProductionTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function productionSources(): string[] {
  const roots = [
    join(repoRoot, 'server'),
    join(repoRoot, 'api'),
    join(repoRoot, 'scripts'),
  ];
  return roots.flatMap((root) => listProductionTsFiles(root));
}

function relPath(abs: string): string {
  return relative(repoRoot, abs).replace(/\\/g, '/');
}

function countWordOccurrences(text: string, word: string): number {
  const re = new RegExp(`\\b${word}\\b`, 'g');
  return [...text.matchAll(re)].length;
}

const PRODUCTION_SCAN_MUST_INCLUDE = [
  'api/chat.ts',
  'api/import.ts',
  'server/membership.ts',
  'server/session.ts',
  'server/auth.ts',
  'scripts/server.ts',
] as const;

function expectProductionScanReady(sources: string[]): string[] {
  expect(sources.length).toBeGreaterThan(0);
  const rels = sources.map(relPath);
  for (const must of PRODUCTION_SCAN_MUST_INCLUDE) {
    expect(rels, `production scan missing ${must}`).toContain(must);
  }
  return rels;
}

describe('accessDecision', () => {
  const activeMember: members.MemberRecord = {
    sub: 'm-sub',
    status: 'active',
    approvedAt: 1,
    approvedBy: 'owner',
  };

  it('denies when ALLOWED_EMAILS is blank and there is no member', () => {
    expect(
      accessDecision({
        email: 'a@example.com',
        emailVerified: true,
        allowedRaw: '',
        member: null,
      }),
    ).toBe('denied');
  });

  it('denies when ALLOWED_EMAILS is whitespace only and there is no member', () => {
    expect(
      accessDecision({
        email: 'a@example.com',
        emailVerified: true,
        allowedRaw: '  ,  ',
        member: null,
      }),
    ).toBe('denied');
  });

  it('denies unverified email even with active member', () => {
    expect(
      accessDecision({
        email: 'a@example.com',
        emailVerified: false,
        allowedRaw: 'owner@example.com',
        member: activeMember,
      }),
    ).toBe('denied');
  });

  it('denies blank email for non-owner', () => {
    expect(
      accessDecision({
        email: '',
        emailVerified: true,
        allowedRaw: 'owner@example.com',
        member: null,
      }),
    ).toBe('denied');
  });

  it('denies revoked member', () => {
    expect(
      accessDecision({
        email: 'a@example.com',
        emailVerified: true,
        allowedRaw: 'owner@example.com',
        member: { ...activeMember, status: 'revoked' },
      }),
    ).toBe('denied');
  });

  it('denies non-owner with null member', () => {
    expect(
      accessDecision({
        email: 'a@example.com',
        emailVerified: true,
        allowedRaw: 'owner@example.com',
        member: null,
      }),
    ).toBe('denied');
  });

  it('owner with null member', () => {
    expect(
      accessDecision({
        email: 'owner@example.com',
        emailVerified: true,
        allowedRaw: 'owner@example.com',
        member: null,
      }),
    ).toBe('owner');
  });

  it('member when parser output is active', () => {
    expect(
      accessDecision({
        email: 'a@example.com',
        emailVerified: true,
        allowedRaw: 'owner@example.com',
        member: activeMember,
      }),
    ).toBe('member');
  });
});

describe('membership cache', () => {
  const sub = 'cache-sub';
  const active: members.MemberRecord = {
    sub,
    status: 'active',
    approvedAt: 100,
    approvedBy: 'owner',
  };

  beforeEach(() => {
    clearMembershipCache(sub);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads Firestore once for two lookups within 60s', async () => {
    const spy = vi.spyOn(members, 'readMember').mockResolvedValue(active);
    const t0 = 1_000_000;
    await lookupMemberForTest(sub, t0);
    await lookupMemberForTest(sub, t0 + 30_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-reads after 60s', async () => {
    const spy = vi.spyOn(members, 'readMember').mockResolvedValue(active);
    const t0 = 1_000_000;
    await lookupMemberForTest(sub, t0);
    await lookupMemberForTest(sub, t0 + 60_001);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('admits revoked member until TTL then re-reads revoked status', async () => {
    vi.spyOn(members, 'readMember')
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce({ ...active, status: 'revoked' });
    const t0 = 2_000_000;
    expect((await lookupMemberForTest(sub, t0))?.status).toBe('active');
    expect((await lookupMemberForTest(sub, t0 + 1_000))?.status).toBe('active');
    expect((await lookupMemberForTest(sub, t0 + 60_001))?.status).toBe('revoked');
  });

  it('re-reads immediately after approval when nothing negative was cached', async () => {
    vi.spyOn(members, 'readMember')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(active);
    const t0 = 3_000_000;
    expect(await lookupMemberForTest(sub, t0)).toBeNull();
    expect(cacheSizeForTest()).toBe(0);
    const second = await lookupMemberForTest(sub, t0 + 1);
    expect(second?.status).toBe('active');
  });

  it('accessAllows returns unknown on throw without caching', async () => {
    const { accessAllows } = await import('./membership.ts');
    const spy = vi
      .spyOn(members, 'readMember')
      .mockRejectedValueOnce(new Error('firestore down'))
      .mockResolvedValueOnce(active);
    expect(
      await accessAllows({ sub, email: 'm@example.com', emailVerified: true }),
    ).toBe('unknown');
    expect(cacheSizeForTest()).toBe(0);
    expect(await accessAllows({ sub, email: 'm@example.com', emailVerified: true })).toBe(
      'member',
    );
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('architecture lock', () => {
  it('assertion 1: readSession referenced only in session, membership, auth', () => {
    const sources = productionSources();
    expectProductionScanReady(sources);
    const allowed = new Set(['server/session.ts', 'server/membership.ts', 'server/auth.ts']);
    for (const must of allowed) {
      const text = readFileSync(join(repoRoot, must), 'utf8');
      expect(/\breadSession\b/.test(text), `${must} must reference readSession`).toBe(true);
    }
    for (const file of sources) {
      const rel = relPath(file);
      const text = readFileSync(file, 'utf8');
      if (!/\breadSession\b/.test(text)) {
        continue;
      }
      expect(allowed.has(rel), `readSession in unexpected file ${rel}`).toBe(true);
    }
  });

  it('assertion 3: api chat/import have no @google-cloud', () => {
    const sources = productionSources();
    expectProductionScanReady(sources);
    for (const rel of ['api/chat.ts', 'api/import.ts'] as const) {
      const text = readFileSync(join(repoRoot, rel), 'utf8');
      expect(text.includes('@google-cloud'), rel).toBe(false);
    }
  });

  it('assertion 4: x-sous-user appears nowhere in production sources', () => {
    const sources = productionSources();
    expectProductionScanReady(sources);
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(text.includes('x-sous-user'), relPath(file)).toBe(false);
    }
  });

  it('assertion 2: sessionFrom appears nowhere in production sources', () => {
    const sources = productionSources();
    expectProductionScanReady(sources);
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(/\bsessionFrom\b/.test(text), relPath(file)).toBe(false);
    }
  });

  it('assertion 5: chat/import handlers wrapped with withMembership', () => {
    const sources = productionSources();
    expectProductionScanReady(sources);
    const serverTs = readFileSync(join(repoRoot, 'scripts/server.ts'), 'utf8');
    expect(serverTs.includes('withMembership(chatPost)')).toBe(true);
    expect(serverTs.includes('withMembership(importPost)')).toBe(true);
    expect(serverTs.includes('handler: chatPost')).toBe(false);
    expect(serverTs.includes('handler: importPost')).toBe(false);
  });

  it('assertion 6: authorizedSub in exactly three files with fixed counts', () => {
    const sources = productionSources();
    expectProductionScanReady(sources);
    const expectedCounts: Record<string, number> = {
      'api/chat.ts': 5,
      'api/import.ts': 5,
      'server/membership.ts': 2,
    };
    const allowed = new Set(Object.keys(expectedCounts));
    const found = new Map<string, number>();

    for (const file of sources) {
      const rel = relPath(file);
      const count = countWordOccurrences(readFileSync(file, 'utf8'), 'authorizedSub');
      if (count === 0) {
        continue;
      }
      expect(allowed.has(rel), `authorizedSub in unexpected file ${rel}`).toBe(true);
      found.set(rel, count);
    }

    for (const [rel, expected] of Object.entries(expectedCounts)) {
      expect(found.get(rel), `${rel} must contain authorizedSub`).toBe(expected);
    }
    expect(found.size).toBe(allowed.size);
  });
});
