import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  featureRequestPost,
  readFeatureRequest,
  resetFeatureRequestRateLimitForTest,
  type FeatureRequestDeps,
} from './featureRequest.ts';

const UUID = '00000000-0000-4000-8000-000000000000';
const NOW = 1_700_000_000_000;
const CTX = { authorizedSub: 'sub-1' };

function fakeDeps() {
  const create = vi.fn<FeatureRequestDeps['create']>(async () => {});
  const deps: FeatureRequestDeps = { create, now: () => NOW };
  return { deps, create };
}

function request(body: unknown, rawBody?: string): Request {
  return new Request('http://localhost/api/feature-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  resetFeatureRequestRateLimitForTest();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function loggedLines(): string[] {
  return vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
}

describe('readFeatureRequest', () => {
  it('rejects a body that is not an object', () => {
    expect(readFeatureRequest(null)).toStrictEqual({ kind: 'bad' });
    expect(readFeatureRequest([])).toStrictEqual({ kind: 'bad' });
    expect(readFeatureRequest('x')).toStrictEqual({ kind: 'bad' });
  });

  it('rejects a bad id and missing or blank text', () => {
    expect(readFeatureRequest({ id: 'a/b', text: 'x' })).toStrictEqual({ kind: 'bad' });
    expect(readFeatureRequest({ text: 'x' })).toStrictEqual({ kind: 'bad' });
    expect(readFeatureRequest({ id: UUID })).toStrictEqual({ kind: 'bad' });
    expect(readFeatureRequest({ id: UUID, text: 5 })).toStrictEqual({ kind: 'bad' });
    expect(readFeatureRequest({ id: UUID, text: '   ' })).toStrictEqual({ kind: 'bad' });
  });

  it('reads a full suggestion', () => {
    expect(
      readFeatureRequest({
        id: UUID,
        text: '  Meal plans  ',
        contactOk: true,
        from: 'settings',
        locale: 'uk',
        standalone: true,
      }),
    ).toStrictEqual({
      kind: 'ok',
      id: UUID,
      fields: { text: 'Meal plans', contactOk: true, from: 'settings', locale: 'uk', standalone: true },
    });
  });

  it('drops malformed optional fields', () => {
    expect(
      readFeatureRequest({
        id: UUID,
        text: 'x',
        contactOk: 'yes',
        from: 'header',
        locale: 'xx-nope',
        standalone: 1,
        sub: 'evil',
        email: 'a@b.c',
      }),
    ).toStrictEqual({ kind: 'ok', id: UUID, fields: { text: 'x', contactOk: false } });
  });

  it('caps the text at 4000', () => {
    const read = readFeatureRequest({ id: UUID, text: 'a'.repeat(5000) });
    expect(read.kind === 'ok' && read.fields.text.length).toBe(4000);
  });
});

describe('featureRequestPost', () => {
  it('stores a suggestion under the session sub for a year', async () => {
    const { deps, create } = fakeDeps();
    const response = await featureRequestPost(
      request({ id: UUID, text: 'Meal plans', contactOk: true, from: 'library', sub: 'evil' }),
      CTX,
      deps,
    );
    expect(response.status).toBe(204);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(UUID, {
      v: 1,
      sub: 'sub-1',
      createdAt: NOW,
      expireAt: new Date(NOW + 365 * 86_400_000),
      text: 'Meal plans',
      contactOk: true,
      from: 'library',
    });
  });

  it('rejects a body over 16 KiB', async () => {
    const { deps } = fakeDeps();
    const response = await featureRequestPost(request(undefined, 'x'.repeat(16 * 1024 + 1)), CTX, deps);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'feature-request-too-large' });
  });

  it('rejects bad JSON and empty text', async () => {
    const { deps, create } = fakeDeps();
    const broken = await featureRequestPost(request(undefined, '{'), CTX, deps);
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ code: 'feature-request-bad-request' });
    const empty = await featureRequestPost(request({ id: UUID, text: ' ' }), CTX, deps);
    expect(empty.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('treats ALREADY_EXISTS as success', async () => {
    const { deps, create } = fakeDeps();
    create.mockRejectedValueOnce(Object.assign(new Error('6 ALREADY_EXISTS: x'), { code: 6 }));
    const response = await featureRequestPost(request({ id: UUID, text: 'x' }), CTX, deps);
    expect(response.status).toBe(204);
  });

  it('answers 503 on a store failure and logs only its code', async () => {
    const { deps, create } = fakeDeps();
    create.mockRejectedValueOnce(Object.assign(new Error('14 UNAVAILABLE: secret text'), { code: 14 }));
    const response = await featureRequestPost(request({ id: UUID, text: 'x' }), CTX, deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({ error: 'Store unavailable' });
    const [line] = loggedLines();
    expect(JSON.parse(line)).toMatchObject({ errorCode: 14, status: 503 });
    expect(line).not.toContain('secret text');
  });

  it('rethrows anything unexpected without its message', async () => {
    const { deps } = fakeDeps();
    const req = new Request('http://localhost/api/feature-request', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error('secret text'));
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const err = await featureRequestPost(req, CTX, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith('Feature request failed:')).toBe(true);
    expect((err as Error).message).not.toContain('secret text');
    expect(JSON.parse(loggedLines()[0])).toMatchObject({ status: 500 });
  });

  it('rate-limits each sub to 5 an hour', async () => {
    const { deps } = fakeDeps();
    const post = (sub: string) =>
      featureRequestPost(
        request({ id: crypto.randomUUID(), text: 'x' }),
        { authorizedSub: sub },
        deps,
      );
    for (let i = 0; i < 5; i++) {
      expect((await post('sub-1')).status).toBe(204);
    }
    const limited = await post('sub-1');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'feature-request-rate-limited' });
    expect((await post('sub-2')).status).toBe(204);
  });

  it('logs one line with no text', async () => {
    const { deps } = fakeDeps();
    await featureRequestPost(
      request({ id: UUID, text: 'my private idea', contactOk: true, from: 'settings', locale: 'en' }),
      CTX,
      deps,
    );
    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('private idea');
    const { ms, ...rest } = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(typeof ms).toBe('number');
    expect(rest).toStrictEqual({
      event: 'feature_request',
      sub: 'sub-1',
      from: 'settings',
      chars: 15,
      contactOk: true,
      status: 204,
    });
  });
});
