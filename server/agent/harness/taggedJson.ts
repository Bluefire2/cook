import type { ToolResult } from './types.ts';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * JSON inside a delimiter tag. A value that contains the closing tag is
 * escaped so it cannot end the wrapper early; JSON.parse restores the text.
 */
export function wrapTaggedJson(tag: string, value: unknown): string {
  const closer = new RegExp(`<(\\s*/\\s*${escapeRegExp(tag)}\\s*>)`, 'gi');
  const json = JSON.stringify(value).replace(closer, '<\\$1');
  return `<${tag}>\n${json}\n</${tag}>`;
}

export function unwrapTaggedJson(text: string): { tag: string; value: unknown } | null {
  const match = /^<([A-Za-z0-9_]+)>\n([\s\S]*)\n<\/\1>\s*$/.exec(text);
  if (!match) {
    return null;
  }
  try {
    return { tag: match[1]!, value: JSON.parse(match[2]!) };
  } catch {
    return null;
  }
}

/** A string output is measured as sent, not re-encoded as JSON. */
export function toolResultBytes(result: ToolResult): number {
  const payload =
    'output' in result && typeof result.output === 'string'
      ? result.output
      : JSON.stringify(result);
  return new TextEncoder().encode(payload).length;
}

function dropLastOfLongestTopLevelArray(value: unknown): unknown | null {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return null;
    }
    return value.slice(0, -1);
  }
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  let bestKey: string | null = null;
  let bestLen = 0;
  for (const [key, child] of Object.entries(record)) {
    if (Array.isArray(child) && child.length > bestLen) {
      bestKey = key;
      bestLen = child.length;
    }
  }
  if (bestKey === null) {
    return null;
  }
  const arr = record[bestKey] as unknown[];
  return { ...record, [bestKey]: arr.slice(0, -1) };
}

function withTruncated(value: unknown): unknown | null {
  if (Array.isArray(value)) {
    return { items: value, truncated: true };
  }
  if (value !== null && typeof value === 'object') {
    return { ...(value as Record<string, unknown>), truncated: true };
  }
  return null;
}

function shrinkToFit(value: unknown, fits: (candidate: unknown) => boolean): unknown | null {
  let current = value;
  for (;;) {
    const next = dropLastOfLongestTopLevelArray(current);
    if (next === null) {
      return null;
    }
    current = next;
    const flagged = withTruncated(current);
    if (flagged !== null && fits(flagged)) {
      return flagged;
    }
  }
}

/**
 * Drop trailing items from the longest top-level array until the result fits.
 * Nested arrays (a long ingredient list) are left intact. Sets `truncated`.
 */
export function truncateToolResult(result: ToolResult, maxBytes: number): ToolResult {
  if ('error' in result || toolResultBytes(result) <= maxBytes) {
    return result;
  }

  if (typeof result.output === 'string') {
    const unwrapped = unwrapTaggedJson(result.output);
    if (!unwrapped) {
      return { error: 'result too large' };
    }
    const shrunk = shrinkToFit(unwrapped.value, (value) => {
      const wrapped = wrapTaggedJson(unwrapped.tag, value);
      return toolResultBytes({ output: wrapped }) <= maxBytes;
    });
    if (shrunk === null) {
      return { error: 'result too large' };
    }
    return { output: wrapTaggedJson(unwrapped.tag, shrunk) };
  }

  const shrunk = shrinkToFit(result.output, (value) => toolResultBytes({ output: value }) <= maxBytes);
  if (shrunk === null) {
    return { error: 'result too large' };
  }
  return { output: shrunk };
}
