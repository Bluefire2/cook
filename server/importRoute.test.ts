import type { Content } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeImportDeps } from '../test/fakeGemini.ts';
import {
  IMPORT_IMAGE_TYPES,
  importPost,
  MAX_IMPORT_BODY_BYTES,
  MAX_IMPORT_IMAGE_BYTES,
  MAX_IMPORT_IMAGES,
} from './importRoute.ts';
import {
  IMPORT_BAD_LANGUAGE_CODE,
  IMPORT_BAD_LANGUAGE_ERROR,
  type RecipeImportDeps,
} from './recipeImport.ts';
import * as recipeImport from './recipeImport.ts';
import { TRANSLATE_FAILED, type TranslateInput, type TranslateOutcome } from './translate.ts';

const RECIPE = {
  title: 'Tomato soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'tomatoes', quantity: 6 }] }],
  steps: [{ text: 'Simmer.' }],
  tags: ['soup'],
};

const PAGE = '<html><body><main><p>Simmer the tomatoes.</p></main></body></html>';

interface PostOptions {
  /** Sent as is instead of `JSON.stringify(body)`. */
  rawBody?: string;
  headers?: Record<string, string>;
  /** Replaces the fake built from `reply`. */
  deps?: RecipeImportDeps;
  translator?: (input: TranslateInput) => Promise<TranslateOutcome>;
}

async function post(
  body: unknown,
  reply: string | undefined = JSON.stringify(RECIPE),
  options: PostOptions = {},
) {
  const { deps, calls } = fakeImportDeps(reply, options.translator);
  const req = new Request('http://localhost/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.rawBody ?? JSON.stringify(body),
  });
  const response = await importPost(req, { authorizedSub: 'sub-1' }, options.deps ?? deps);
  return { status: response.status, body: (await response.json()) as unknown, calls };
}

function prefixTranslator(detectedLang: string | null) {
  return (input: TranslateInput): Promise<TranslateOutcome> =>
    Promise.resolve({
      ok: true,
      detectedLang,
      segments: input.segments.map((segment) => ({
        id: segment.id,
        text: `UK ${segment.text}`,
      })),
    });
}

function image(mediaType: string, magic: readonly number[], n: number) {
  const bytes = Buffer.alloc(n);
  Buffer.from(magic).copy(bytes);
  return { mediaType, base64: bytes.toString('base64') };
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_MAGIC = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')];

const jpeg = (n = 64) => image('image/jpeg', JPEG_MAGIC, n);
const png = (n = 64) => image('image/png', PNG_MAGIC, n);
const webp = (n = 64) => image('image/webp', WEBP_MAGIC, n);

function sentParts(calls: { contents: unknown }[]) {
  return (calls[0].contents as Content[])[0].parts ?? [];
}

function rejectingDeps(message: string): RecipeImportDeps {
  return {
    model: 'test-model',
    ai: { models: { generateContent: () => Promise.reject(new Error(message)) } },
    translator: () => Promise.resolve({ ok: false, code: TRANSLATE_FAILED }),
  };
}

function serve(response: Response) {
  const fetchMock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/import', () => {
  it('returns the normalized recipe for pasted text, without sourceUrl', async () => {
    const result = await post(
      { text: '  Tomato soup: simmer.  ' },
      JSON.stringify({ ...RECIPE, servings: 0, photoId: 'x' }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ recipe: { ...RECIPE, servings: 1 } });
    expect(result.calls[0].contents).toContain('Tomato soup: simmer.');
  });

  it('returns the normalized recipe and sourceUrl for a URL', async () => {
    serve(new Response(PAGE));
    const result = await post({ url: 'https://example.com/soup' });
    expect(result).toMatchObject({
      status: 200,
      body: { recipe: { ...RECIPE, sourceUrl: 'https://example.com/soup' } },
    });
    expect(result.calls[0].contents).toContain('Simmer the tomatoes.');
  });

  it('prefers the URL when both are given', async () => {
    serve(new Response(PAGE));
    const result = await post({ url: 'https://example.com/soup', text: 'Other text' });
    expect(result.calls[0].contents).not.toContain('Other text');
  });

  it('rejects a request with nothing to import', async () => {
    for (const body of [{}, { text: '' }, { text: '   ' }]) {
      const result = await post(body);
      expect(result).toMatchObject({
        status: 400,
        body: { error: 'Provide a URL, recipe text, or photos.', code: 'import-empty' },
      });
      expect(result.calls).toHaveLength(0);
    }
  });

  it('rejects a page with no readable text like an empty request', async () => {
    serve(new Response('<html><body><script>x()</script></body></html>'));
    const result = await post({ url: 'https://example.com/soup' });
    expect(result).toMatchObject({
      status: 400,
      body: { error: 'Provide a URL, recipe text, or photos.', code: 'import-empty' },
    });
    expect(result.calls).toHaveLength(0);
  });

  it('maps fetch failures to 422 with the existing copy', async () => {
    expect(await post({ url: 'soup' })).toMatchObject({
      status: 422,
      body: { error: 'That does not look like a web address.', code: 'import-bad-url' },
    });
    expect(await post({ url: 'ftp://example.com/soup' })).toMatchObject({
      status: 422,
      body: { error: 'Only http and https URLs are supported.', code: 'import-bad-scheme' },
    });

    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    expect(await post({ url: 'https://example.com/soup' })).toMatchObject({
      status: 422,
      body: { error: 'Could not reach that URL.', code: 'import-unreachable' },
    });

    serve(new Response('challenge', { status: 403 }));
    expect(await post({ url: 'https://example.com/soup' })).toMatchObject({
      status: 422,
      body: {
        error: 'The site refused the request (403). Try pasting the recipe text instead.',
        code: 'import-refused',
        status: 403,
      },
    });
  });

  it('maps model outcomes to the existing statuses', async () => {
    expect(await post({ text: 'a poem' }, JSON.stringify({ title: 'NOT_A_RECIPE' }))).toMatchObject({
      status: 422,
      body: { error: "Couldn't find a recipe in that content.", code: 'import-no-recipe' },
    });
    expect(await post({ text: 'soup' }, 'not json')).toMatchObject({
      status: 502,
      body: { error: 'Extraction failed — no structured result.', code: 'import-extract-failed' },
    });
    expect(await post({ text: 'soup' }, JSON.stringify({ servings: 2 }))).toMatchObject({
      status: 502,
      body: { error: 'Extraction produced an unusable recipe.', code: 'import-unusable' },
    });
  });

  it('rejects an unsupported translateTo', async () => {
    for (const translateTo of ['fr', 'zh', '']) {
      const result = await post({ text: 'Tomato soup', translateTo });
      expect(result, translateTo).toMatchObject({
        status: 400,
        body: { error: IMPORT_BAD_LANGUAGE_ERROR, code: IMPORT_BAD_LANGUAGE_CODE },
      });
      expect(result.calls).toHaveLength(0);
    }
  });

  it('forwards translateTo and serializes the translation', async () => {
    const source = vi.spyOn(recipeImport, 'importFromSource');
    const html = vi.spyOn(recipeImport, 'importFromHtml');
    const italian = { ...RECIPE, lang: 'it' };
    const ukrainian = {
      title: 'UK Tomato soup',
      servings: 4,
      ingredientSections: [{ items: [{ item: 'UK tomatoes', quantity: 6 }] }],
      steps: [{ text: 'UK Simmer.' }],
      tags: ['soup'],
      lang: 'uk',
    };
    try {
      const text = await post(
        { text: 'Tomato soup', translateTo: 'ua' },
        JSON.stringify(italian),
        { translator: prefixTranslator('it') },
      );
      expect(text.status).toBe(200);
      expect(text.body).toEqual({
        recipe: italian,
        translation: { lang: 'uk', recipe: ukrainian },
      });
      expect(source).toHaveBeenCalledWith('Tomato soup', expect.anything(), 'uk');

      serve(new Response(PAGE));
      const url = await post(
        { url: 'https://example.com/soup', translateTo: 'uk' },
        JSON.stringify(italian),
        { translator: prefixTranslator('it') },
      );
      expect(url.status).toBe(200);
      expect(url.body).toEqual({
        recipe: { ...italian, sourceUrl: 'https://example.com/soup' },
        translation: {
          lang: 'uk',
          recipe: { ...ukrainian, sourceUrl: 'https://example.com/soup' },
        },
      });
      expect(html).toHaveBeenCalledWith(expect.any(String), expect.anything(), 'uk');
    } finally {
      source.mockRestore();
      html.mockRestore();
    }
  });

  it('serializes a translation failure without failing the import', async () => {
    const result = await post({ text: 'Tomato soup', translateTo: 'uk' }, JSON.stringify({
      ...RECIPE,
      lang: 'it',
    }), { translator: () => Promise.resolve({ ok: false, code: TRANSLATE_FAILED }) });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      recipe: { ...RECIPE, lang: 'it' },
      translationFailed: true,
    });
  });
});

describe('POST /api/import with photos', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('locks the constitution numbers', () => {
    expect(MAX_IMPORT_IMAGES).toBe(4);
    expect(MAX_IMPORT_IMAGE_BYTES).toBe(3 * 1024 * 1024);
    expect(MAX_IMPORT_BODY_BYTES).toBe(12 * 1024 * 1024);
    expect([...IMPORT_IMAGE_TYPES].sort()).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('imports from photos without sourceUrl', async () => {
    const images = [jpeg(), png()];
    const result = await post({ images }, JSON.stringify({ ...RECIPE, servings: 0 }));
    expect(result.status).toBe(200);
    const recipe = (result.body as { recipe: Record<string, unknown> }).recipe;
    expect(recipe).toEqual({ ...RECIPE, servings: 1 });
    expect('sourceUrl' in recipe).toBe(false);
    const parts = sentParts(result.calls);
    expect(parts).toHaveLength(3);
    expect(parts.slice(0, 2)).toEqual(
      images.map((i) => ({ inlineData: { mimeType: i.mediaType, data: i.base64 } })),
    );
    expect(typeof parts[2].text).toBe('string');
  });

  it('passes text as notes alongside photos', async () => {
    const result = await post({ images: [jpeg()], text: "Nan's pie" });
    expect(result.status).toBe(200);
    const parts = sentParts(result.calls);
    expect(parts[parts.length - 1].text).toContain("Nan's pie");
  });

  it('prefers the URL and ignores photos', async () => {
    serve(new Response(PAGE));
    const images = Array.from({ length: 5 }, () => jpeg());
    const result = await post({ url: 'https://example.com/soup', images });
    expect(result.status).toBe(200);
    expect(typeof result.calls[0].contents).toBe('string');
    expect(result.calls[0].contents).toContain('Simmer the tomatoes.');
  });

  it('treats an empty images array as absent', async () => {
    const withText = await post({ images: [], text: 'soup' });
    expect(withText.status).toBe(200);
    expect(typeof withText.calls[0].contents).toBe('string');

    expect(await post({ images: [] })).toMatchObject({
      status: 400,
      body: { error: 'Provide a URL, recipe text, or photos.' },
    });
  });

  it('rejects more than 4 photos', async () => {
    const valid = await post({ images: Array.from({ length: 5 }, () => jpeg()) });
    expect(valid).toMatchObject({ status: 400, body: { error: 'Up to 4 photos.' } });
    expect(valid.calls).toHaveLength(0);

    const gifs = Array.from({ length: 5 }, () => ({ ...jpeg(), mediaType: 'image/gif' }));
    const wrongType = await post({ images: gifs });
    expect(wrongType).toMatchObject({ status: 400, body: { error: 'Up to 4 photos.' } });
    expect(wrongType.calls).toHaveLength(0);
  });

  it('rejects other image types', async () => {
    for (const mediaType of ['image/gif', 'image/heic', 'application/pdf']) {
      const result = await post({ images: [{ ...jpeg(), mediaType }] });
      expect(result, mediaType).toMatchObject({
        status: 400,
        body: { error: 'Photos must be JPEG, PNG, or WebP.' },
      });
      expect(result.calls).toHaveLength(0);
    }

    const upper = await post({ images: [{ ...jpeg(), mediaType: 'IMAGE/JPEG' }] });
    expect(upper.status).toBe(200);
    expect(sentParts(upper.calls)[0].inlineData?.mimeType).toBe('image/jpeg');
  });

  it('rejects photos it cannot read', async () => {
    const cases: [string, unknown][] = [
      ['a string', 'x'],
      ['an object', {}],
      ['a null element', [null]],
      ['no base64', [{ mediaType: 'image/jpeg' }]],
      ['numeric base64', [{ mediaType: 'image/jpeg', base64: 7 }]],
      ['empty base64', [{ mediaType: 'image/jpeg', base64: '' }]],
      ['a data URL', [{ mediaType: 'image/jpeg', base64: `data:image/jpeg;base64,${jpeg().base64}` }]],
      ['base64url', [{ mediaType: 'image/jpeg', base64: jpeg().base64.replace(/\//g, '_') }]],
      ['PNG bytes labelled JPEG', [{ ...png(), mediaType: 'image/jpeg' }]],
      ['too short for WebP', [{ mediaType: 'image/webp', base64: '/9j/' }]],
    ];
    for (const [label, images] of cases) {
      const result = await post({ images });
      expect(result, label).toMatchObject({
        status: 400,
        body: { error: "Those photos couldn't be read." },
      });
      expect(result.calls, label).toHaveLength(0);
    }
  });

  it('accepts WebP by its magic bytes', async () => {
    expect((await post({ images: [webp()] })).status).toBe(200);
  });

  it('caps each photo at 3 MB decoded', async () => {
    const atCap = await post({ images: [jpeg(MAX_IMPORT_IMAGE_BYTES)] });
    expect(atCap.status).toBe(200);

    const over = await post({ images: [jpeg(MAX_IMPORT_IMAGE_BYTES + 1)] });
    expect(over).toMatchObject({ status: 413, body: { error: 'Those photos are too large.' } });
    expect(over.calls).toHaveLength(0);
  });

  it('accepts four typical photos', async () => {
    const result = await post({ images: Array.from({ length: 4 }, () => jpeg(2 * 1024 * 1024)) });
    expect(result.status).toBe(200);
    expect(sentParts(result.calls).filter((part) => part.inlineData)).toHaveLength(4);
  });

  it('rejects four photos at the per-photo cap by body size', async () => {
    const result = await post({
      images: Array.from({ length: 4 }, () => jpeg(MAX_IMPORT_IMAGE_BYTES)),
    });
    expect(result).toMatchObject({
      status: 413,
      body: { error: "That's too large to import — try fewer photos." },
    });
    expect(result.calls).toHaveLength(0);
  });

  it('caps the request body at 12 MB', async () => {
    const declared = await post(undefined, undefined, {
      rawBody: '{}',
      headers: { 'Content-Length': String(MAX_IMPORT_BODY_BYTES + 1) },
    });
    expect(declared).toMatchObject({
      status: 413,
      body: { error: "That's too large to import — try fewer photos." },
    });
    expect(declared.calls).toHaveLength(0);

    const rawBody = JSON.stringify({ text: 'x'.repeat(MAX_IMPORT_BODY_BYTES) });
    expect(rawBody.length).toBeGreaterThan(MAX_IMPORT_BODY_BYTES);
    const streamed = await post(undefined, undefined, { rawBody });
    expect(streamed).toMatchObject({
      status: 413,
      body: { error: "That's too large to import — try fewer photos." },
    });
    expect(streamed.calls).toHaveLength(0);
  });

  it('rejects a body that is not JSON', async () => {
    for (const rawBody of ['not json', '', '[]', '"x"']) {
      const result = await post(undefined, undefined, { rawBody });
      expect(result, JSON.stringify(rawBody)).toMatchObject({
        status: 400,
        body: { error: 'Bad request' },
      });
      expect(result.calls).toHaveLength(0);
    }
  });

  it('maps photo outcomes to photo copy', async () => {
    const images = [jpeg()];
    expect(await post({ images }, JSON.stringify({ title: 'NOT_A_RECIPE' }))).toMatchObject({
      status: 422,
      body: { error: "Couldn't find a recipe in those photos." },
    });
    expect(await post({ images }, 'not json')).toMatchObject({
      status: 502,
      body: { error: 'Extraction failed — no structured result.' },
    });
    expect(await post({ images }, JSON.stringify({ servings: 2 }))).toMatchObject({
      status: 502,
      body: { error: 'Extraction produced an unusable recipe.' },
    });
  });

  it('reports a Gemini failure on photos as 502', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await post({ images: [jpeg()] }, undefined, {
      deps: rejectingDeps('upstream down'),
    });
    expect(result).toMatchObject({
      status: 502,
      body: { error: "Couldn't read those photos — try again." },
    });
  });

  it('never logs photo data', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bytes = Buffer.alloc(4096);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256;
    Buffer.from(JPEG_MAGIC).copy(bytes);
    const photo = { mediaType: 'image/jpeg', base64: bytes.toString('base64') };
    const secret = 'SECRET-UPSTREAM-DETAIL';

    const logged = () =>
      [...log.mock.calls, ...error.mock.calls]
        .flat()
        .map((arg) => (typeof arg === 'string' ? arg : `${String(arg)} ${JSON.stringify(arg)}`));
    const expectNoPhotoData = () => {
      for (const text of logged()) {
        expect(text).not.toContain(secret);
        for (let i = 0; i + 16 <= photo.base64.length; i++) {
          if (text.includes(photo.base64.slice(i, i + 16))) {
            throw new Error(`logged a slice of the photo at ${i}`);
          }
        }
      }
    };

    expect((await post({ images: [photo] })).status).toBe(200);
    expect(log.mock.calls.filter(([m]) => /^import images count=1 bytes=\d+$/.test(String(m)))).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
    expectNoPhotoData();

    log.mockClear();
    const failed = await post({ images: [photo] }, undefined, { deps: rejectingDeps(secret) });
    expect(failed.status).toBe(502);
    expect(log.mock.calls.filter(([m]) => /^import images count=1 bytes=\d+$/.test(String(m)))).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toHaveLength(1);
    expect(String(error.mock.calls[0][0])).toMatch(/^import images failed count=1 bytes=\d+$/);
    expectNoPhotoData();
  });
});
