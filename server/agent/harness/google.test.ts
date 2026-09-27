import { describe, expect, it } from 'vitest';
import { FunctionCallingConfigMode, Type } from '@google/genai';
import { googleModel, toolParametersToSchema } from './google.ts';
import { fakeGenerateStream, textChunk } from '../../../test/fakeGeminiStream.ts';
import type { AgentMessage } from './types.ts';

describe('toolParametersToSchema', () => {
  it('maps object, array, string enum, and number', () => {
    const schema = toolParametersToSchema({
      type: 'object',
      description: 'root',
      properties: {
        q: { type: 'string', enum: ['a', 'b'] },
        n: { type: 'number', description: 'num' },
        tags: {
          type: 'array',
          maxItems: 3,
          items: { type: 'integer' },
        },
      },
      required: ['q'],
    });
    expect(schema.type).toBe(Type.OBJECT);
    expect(schema.description).toBe('root');
    expect(schema.required).toEqual(['q']);
    expect(schema.properties?.q?.type).toBe(Type.STRING);
    expect(schema.properties?.q?.enum).toEqual(['a', 'b']);
    expect(schema.properties?.n?.type).toBe(Type.NUMBER);
    expect(schema.properties?.tags?.type).toBe(Type.ARRAY);
    expect(schema.properties?.tags?.maxItems).toBe('3');
    expect(schema.properties?.tags?.items?.type).toBe(Type.INTEGER);
  });
});

describe('googleModel adapter request mapping', () => {
  it('maps AgentMessage roles and passes tool declarations', async () => {
    const { generate, calls } = fakeGenerateStream([[textChunk('hi')]]);
    const client = googleModel({ apiKey: 'k', model: 'm', generate });
    const messages: AgentMessage[] = [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'there' },
    ];
    const stream = await client.step({
      systemInstruction: 'sys',
      messages,
      priorTurns: [],
      tools: [
        {
          name: 'search',
          description: 'find',
          parameters: { type: 'object', properties: {} },
        },
      ],
      forceText: false,
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    });
    for await (const _ of stream.events) {
      /* drain */
    }
    expect(calls).toHaveLength(1);
    const contents = calls[0]!.contents as { role?: string; parts?: { text?: string }[] }[];
    expect(contents[0]?.role).toBe('user');
    expect(contents[0]?.parts?.[0]?.text).toBe('hello');
    expect(contents[1]?.role).toBe('model');
    expect(contents[1]?.parts?.[0]?.text).toBe('there');
    const toolUnion = calls[0]!.config?.tools?.[0] as
      | { functionDeclarations?: { name?: string; parameters?: { type?: Type } }[] }
      | undefined;
    const decl = toolUnion?.functionDeclarations?.[0];
    expect(decl?.name).toBe('search');
    expect(decl?.parameters?.type).toBe(Type.OBJECT);
  });

  it('sets functionCallingConfig NONE when forceText', async () => {
    const { generate, calls } = fakeGenerateStream([[textChunk('done')]]);
    const client = googleModel({ apiKey: 'k', model: 'm', generate });
    const stream = await client.step({
      systemInstruction: 'sys',
      messages: [{ role: 'user', text: 'x' }],
      priorTurns: [],
      tools: [
        {
          name: 't',
          description: 'd',
          parameters: { type: 'object', properties: {} },
        },
      ],
      forceText: true,
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    });
    for await (const _ of stream.events) {
      /* drain */
    }
    expect(calls[0]!.config?.toolConfig?.functionCallingConfig?.mode).toBe(
      FunctionCallingConfigMode.NONE,
    );
  });
});
