import { describe, expect, it } from 'vitest';
import { toolResultBytes, truncateToolResult, unwrapTaggedJson, wrapTaggedJson } from './taggedJson.ts';

describe('wrapTaggedJson', () => {
  it('escapes a closing tag with a space after the slash', () => {
    const value = { title: 'a </ library_data> b </LIBRARY_DATA> c </library_data > d' };
    const wrapped = wrapTaggedJson('library_data', value);
    const inner = wrapped.slice('<library_data>\n'.length, -'\n</library_data>'.length);
    expect(inner).not.toMatch(/<\s*\/\s*library_data/i);
    expect(JSON.parse(inner)).toEqual(value);
    expect(unwrapTaggedJson(wrapped)?.value).toEqual(value);
  });

  it('keeps the JSON valid for a closing tag with a space before the slash', () => {
    const value = { title: 'a < /library_data> b <  /LIBRARY_DATA> c' };
    const wrapped = wrapTaggedJson('library_data', value);
    const inner = wrapped.slice('<library_data>\n'.length, -'\n</library_data>'.length);
    expect(inner).not.toMatch(/<\s*\/\s*library_data/i);
    expect(JSON.parse(inner)).toEqual(value);
    expect(unwrapTaggedJson(wrapped)?.value).toEqual(value);
  });
});

describe('truncateToolResult', () => {
  it('returns an error when nothing can be dropped', () => {
    const result = truncateToolResult({ output: { data: 'x'.repeat(100) } }, 10);
    expect(result).toEqual({ error: 'result too large' });
  });

  it('drops trailing recipes and leaves a nested ingredient list intact', () => {
    const heavy = {
      id: '1',
      ingredients: Array.from({ length: 20 }, (_, i) => `ing${i}-${'x'.repeat(30)}`),
    };
    const light = { id: '2', ingredients: ['salt'] };
    const kept = { recipes: [heavy], truncated: true };
    const limit = toolResultBytes({
      output: wrapTaggedJson('library_data', kept),
    });
    const result = truncateToolResult(
      { output: wrapTaggedJson('library_data', { recipes: [heavy, light] }) },
      limit,
    );
    expect('output' in result).toBe(true);
    if (!('output' in result) || typeof result.output !== 'string') {
      return;
    }
    expect(toolResultBytes(result)).toBeLessThanOrEqual(limit);
    expect(unwrapTaggedJson(result.output)?.value).toEqual(kept);
  });
});
