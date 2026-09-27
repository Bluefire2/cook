import { describe, expect, it } from 'vitest';
import { defaultAgentLimits } from './limits.ts';
import { encodeAgentEvent } from './ndjson.ts';
import { googleModel } from './google.ts';
import { startAgent } from './run.ts';
import type { AgentEvent, CardSpec, ToolSpec } from './types.ts';
import {
  callChunk,
  chunkResponse,
  fakeGenerateStream,
  textChunk,
} from '../../../test/fakeGeminiStream.ts';

type Ctx = { value: string };

function collectEvents(run: (emit: (e: AgentEvent) => void) => Promise<unknown>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  return run((e) => events.push(e)).then(() => events);
}

function responseForTool(
  apiCalls: { contents?: unknown }[],
  stepIndex: number,
  toolName: string,
): unknown {
  const contents = apiCalls[stepIndex]!.contents as {
    parts?: { functionResponse?: { name?: string; response?: unknown } }[];
  }[];
  for (const c of contents) {
    for (const p of c.parts ?? []) {
      if (p.functionResponse?.name === toolName) {
        return p.functionResponse.response;
      }
    }
  }
  return undefined;
}

function allFnResponses(apiCalls: { contents?: unknown }[], stepIndex: number): unknown[] {
  const contents = apiCalls[stepIndex]!.contents as {
    parts?: { functionResponse?: { response?: unknown } }[];
  }[];
  return contents
    .flatMap((c) => c.parts ?? [])
    .map((p) => p.functionResponse?.response)
    .filter((r) => r !== undefined);
}

function modelFromSteps(steps: Parameters<typeof fakeGenerateStream>[0]) {
  const { generate, calls } = fakeGenerateStream(steps);
  return { client: googleModel({ apiKey: 'k', model: 'm', generate }), calls };
}

describe('encodeAgentEvent', () => {
  it('returns one compact JSON line', () => {
    expect(encodeAgentEvent({ t: 'done' })).toBe('{"t":"done"}\n');
  });
});

describe('startAgent', () => {
  const baseMessages = [{ role: 'user' as const, text: 'hi' }];
  const ctx: Ctx = { value: 'c' };

  it('rejects duplicate tool names before opening the stream', async () => {
    const tools: ToolSpec<Ctx>[] = [
      {
        name: 'dup',
        description: 'a',
        parameters: { type: 'object', properties: {} },
        run: async () => ({ output: {} }),
      },
      {
        name: 'dup',
        description: 'b',
        parameters: { type: 'object', properties: {} },
        run: async () => ({ output: {} }),
      },
    ];
    await expect(
      startAgent({
        model: googleModel({
          apiKey: 'k',
          model: 'm',
          generate: async () => {
            throw new Error('should not run');
          },
        }),
        systemInstruction: 'sys',
        messages: baseMessages,
        tools,
        cards: [],
        ctx,
        limits: defaultAgentLimits(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/duplicate tool name/);
  });

  it('rejects when the first generateContentStream open fails', async () => {
    await expect(
      startAgent({
        model: googleModel({
          apiKey: 'k',
          model: 'm',
          generate: async () => {
            throw new Error('network');
          },
        }),
        systemInstruction: 'sys',
        messages: baseMessages,
        tools: [],
        cards: [],
        ctx,
        limits: defaultAgentLimits(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('network');
  });

  it('streams text only then done with one model step', async () => {
    const { client } = modelFromSteps([[textChunk('Hello')]]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools: [],
      cards: [],
      ctx,
      limits: defaultAgentLimits(),
      signal: new AbortController().signal,
    });
    const events = await collectEvents(agent.run);
    expect(events).toEqual([
      { t: 'text', step: 1, d: 'Hello' },
      { t: 'done' },
    ]);
  });

  it('runs one tool round and echoes function responses on the second call', async () => {
    const tools: ToolSpec<Ctx>[] = [
      {
        name: 'lookup',
        description: 'd',
        parameters: { type: 'object', properties: { id: { type: 'string' } } },
        run: async (args) => ({ output: args }),
      },
    ];
    const { client, calls } = modelFromSteps([
      [callChunk('lookup', { id: '1' }, 'call-1')],
      [textChunk('Found it')],
    ]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools,
      cards: [],
      ctx,
      limits: defaultAgentLimits(),
      signal: new AbortController().signal,
    });
    const events = await collectEvents(agent.run);
    expect(events.some((e) => e.t === 'tool' && e.name === 'lookup' && e.phase === 'end' && e.ok)).toBe(
      true,
    );
    expect(events).toContainEqual({ t: 'text', step: 2, d: 'Found it' });
    expect(calls).toHaveLength(2);
    const secondContents = calls[1]!.contents as {
      parts?: { functionResponse?: { id?: string; name?: string; response?: unknown } }[];
    }[];
    const fnPart = secondContents.find((c) =>
      c.parts?.some((p) => p.functionResponse?.name === 'lookup'),
    );
    expect(fnPart?.parts?.[0]?.functionResponse?.id).toBe('call-1');
  });

  it('emits interim after text and calls in the same step', async () => {
    const tools: ToolSpec<Ctx>[] = [
      {
        name: 't',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        run: async () => ({ output: {} }),
      },
    ];
    const { client } = modelFromSteps([
      [chunkResponse([{ text: 'Draft' }, { functionCall: { name: 't', args: {} } }])],
      [textChunk('Final')],
    ]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools,
      cards: [],
      ctx,
      limits: defaultAgentLimits(),
      signal: new AbortController().signal,
    });
    const events = await collectEvents(agent.run);
    const textIdx = events.findIndex((e) => e.t === 'text' && e.step === 1);
    const interimIdx = events.findIndex((e) => e.t === 'interim' && e.step === 1);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(interimIdx).toBeGreaterThan(textIdx);
  });

  it('keeps parallel tool responses in call order with ids', async () => {
    const tools: ToolSpec<Ctx>[] = [
      {
        name: 'slow',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        run: async (_args, _ctx, signal) => {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 30);
            signal.addEventListener('abort', () => {
              clearTimeout(t);
              resolve();
            });
          });
          return { output: { which: 'slow' } };
        },
      },
      {
        name: 'fast',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        run: async () => ({ output: { which: 'fast' } }),
      },
    ];
    const { client, calls } = modelFromSteps([
      [
        callChunk('slow', {}, 'id-slow'),
        callChunk('fast', {}, 'id-fast'),
      ],
      [textChunk('ok')],
    ]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools,
      cards: [],
      ctx,
      limits: defaultAgentLimits(),
      signal: new AbortController().signal,
    });
    await collectEvents(agent.run);
    const responses =
      (calls[1]!.contents as { parts?: { functionResponse?: { id?: string; name: string } }[] }[])
        .flatMap((c) => c.parts ?? [])
        .map((p) => p.functionResponse)
        .filter(Boolean);
    expect(responses.map((r) => r!.id)).toEqual(['id-slow', 'id-fast']);
    expect(responses.map((r) => r!.name)).toEqual(['slow', 'fast']);
  });

  it('preserves thoughtSignature parts on the next request', async () => {
    const tools: ToolSpec<Ctx>[] = [
      {
        name: 't',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        run: async () => ({ output: {} }),
      },
    ];
    const { client, calls } = modelFromSteps([
      [
        chunkResponse([
          { thoughtSignature: 'abc', thought: true },
          { functionCall: { name: 't', args: {} } },
        ]),
      ],
      [textChunk('done')],
    ]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools,
      cards: [],
      ctx,
      limits: defaultAgentLimits(),
      signal: new AbortController().signal,
    });
    await collectEvents(agent.run);
    const modelTurn = (
      calls[1]!.contents as { role?: string; parts?: { thoughtSignature?: string; thought?: boolean }[] }[]
    ).find(
      (c) => c.role === 'model',
    );
    expect(modelTurn?.parts?.[0]).toMatchObject({ thoughtSignature: 'abc', thought: true });
  });

  it('returns unknown tool errors without throwing', async () => {
    const { client, calls } = modelFromSteps([
      [callChunk('missing', { x: 1 })],
      [textChunk('ok')],
    ]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools: [],
      cards: [],
      ctx,
      limits: defaultAgentLimits(),
      signal: new AbortController().signal,
    });
    await collectEvents(agent.run);
    expect(responseForTool(calls, 1, 'missing')).toEqual({ error: 'unknown tool' });
  });

  it('maps throwing tools to tool failed', async () => {
    const tools: ToolSpec<Ctx>[] = [
      {
        name: 'boom',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        run: async () => {
          throw new Error('secret');
        },
      },
    ];
    const { client, calls } = modelFromSteps([
      [callChunk('boom', {})],
      [textChunk('ok')],
    ]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools,
      cards: [],
      ctx,
      limits: defaultAgentLimits(),
      signal: new AbortController().signal,
    });
    await collectEvents(agent.run);
    expect(responseForTool(calls, 1, 'boom')).toEqual({ error: 'tool failed' });
  });

  it('emits card events and returns shown:true to the model', async () => {
    const cards: CardSpec<Ctx, { title: string }>[] = [
      {
        type: 'shopping_list',
        version: 1,
        toolName: 'show_list',
        description: 'd',
        parameters: { type: 'object', properties: { title: { type: 'string' } } },
        rule: 'r',
        normalize: (args) => {
          const a = args as { title?: string };
          if (!a.title) return { ok: false, error: 'need title' };
          return { ok: true, data: { title: a.title } };
        },
        historyText: () => '',
      },
    ];
    const { client, calls } = modelFromSteps([
      [callChunk('show_list', { title: 'Groceries' })],
      [textChunk('Here')],
    ]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools: [],
      cards,
      ctx,
      limits: defaultAgentLimits(),
      signal: new AbortController().signal,
    });
    const events = await collectEvents(agent.run);
    expect(events.some((e) => e.t === 'card' && e.card.type === 'shopping_list')).toBe(true);
    expect(responseForTool(calls, 1, 'show_list')).toEqual({ output: { shown: true } });
  });

  it('does not emit card when normalize fails', async () => {
    const cards: CardSpec<Ctx, unknown>[] = [
      {
        type: 'shopping_list',
        version: 1,
        toolName: 'show_list',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        rule: 'r',
        normalize: () => ({ ok: false, error: 'bad args' }),
        historyText: () => '',
      },
    ];
    const { client, calls } = modelFromSteps([
      [callChunk('show_list', {})],
      [textChunk('retry')],
    ]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools: [],
      cards,
      ctx,
      limits: defaultAgentLimits(),
      signal: new AbortController().signal,
    });
    const events = await collectEvents(agent.run);
    expect(events.some((e) => e.t === 'card')).toBe(false);
    expect(responseForTool(calls, 1, 'show_list')).toEqual({ error: 'bad args' });
  });

  it('limits the 9th call in one step', async () => {
    const tools: ToolSpec<Ctx>[] = [
      {
        name: 'many',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        run: async () => ({ output: {} }),
      },
    ];
    const callsInStep = Array.from({ length: 9 }, () => callChunk('many', {}));
    const { client, calls } = modelFromSteps([callsInStep, [textChunk('ok')]]);
    let executed = 0;
    const origRun = tools[0]!.run;
    tools[0]!.run = async (...args) => {
      executed += 1;
      return origRun(...args);
    };
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools,
      cards: [],
      ctx,
      limits: defaultAgentLimits(),
      signal: new AbortController().signal,
    });
    await collectEvents(agent.run);
    expect(executed).toBe(8);
    const responses = allFnResponses(calls, 1);
    expect(responses[8]).toEqual({ error: 'limit' });
  });

  it('forces forceText on the next step after request call cap', async () => {
    const limits = { ...defaultAgentLimits(), maxCallsPerRequest: 1, maxSteps: 4 };
    const tools: ToolSpec<Ctx>[] = [
      {
        name: 't',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        run: async () => ({ output: {} }),
      },
    ];
    const { client, calls } = modelFromSteps([
      [callChunk('t', {})],
      [textChunk('final')],
    ]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools,
      cards: [],
      ctx,
      limits,
      signal: new AbortController().signal,
    });
    await collectEvents(agent.run);
    expect(calls[1]!.config?.toolConfig?.functionCallingConfig?.mode).toBe('NONE');
    expect(
      (calls[1]!.contents as { parts?: { text?: string }[] }[]).some((c) =>
        c.parts?.[0]?.text?.includes('tool limit'),
      ),
    ).toBe(true);
  });

  it('replaces oversized tool results', async () => {
    const limits = { ...defaultAgentLimits(), maxResultBytes: 10 };
    const tools: ToolSpec<Ctx>[] = [
      {
        name: 'big',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        run: async () => ({ output: { data: 'x'.repeat(100) } }),
      },
    ];
    const { client, calls } = modelFromSteps([
      [callChunk('big', {})],
      [textChunk('ok')],
    ]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools,
      cards: [],
      ctx,
      limits,
      signal: new AbortController().signal,
    });
    await collectEvents(agent.run);
    expect(responseForTool(calls, 1, 'big')).toEqual({ error: 'result too large' });
  });

  it('errors on forced final step that still returns calls', async () => {
    const limits = { ...defaultAgentLimits(), maxSteps: 1 };
    const tools: ToolSpec<Ctx>[] = [
      {
        name: 't',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        run: async () => ({ output: {} }),
      },
    ];
    const { client } = modelFromSteps([[callChunk('t', {})]]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools,
      cards: [],
      ctx,
      limits,
      signal: new AbortController().signal,
    });
    const events = await collectEvents(agent.run);
    expect(events).toContainEqual({
      t: 'error',
      message: "The assistant couldn't answer that.",
    });
    expect(events.at(-1)).toEqual({ t: 'done' });
  });

  it('emits canned error on empty model response', async () => {
    const { client } = modelFromSteps([[chunkResponse([])]]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools: [],
      cards: [],
      ctx,
      limits: defaultAgentLimits(),
      signal: new AbortController().signal,
    });
    const events = await collectEvents(agent.run);
    expect(events).toContainEqual({
      t: 'error',
      message: "The assistant couldn't answer that.",
    });
    expect(events.at(-1)).toEqual({ t: 'done' });
  });

  it('finishes aborted when signal aborts during tool execution', async () => {
    const ac = new AbortController();
    const tools: ToolSpec<Ctx>[] = [
      {
        name: 'wait',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        run: async (_a, _c, signal) => {
          if (signal.aborted) {
            return { output: {} };
          }
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { output: {} };
        },
      },
    ];
    const { client } = modelFromSteps([
      [callChunk('wait', {}), callChunk('wait', {})],
      [textChunk('never')],
    ]);
    const agent = await startAgent({
      model: client,
      systemInstruction: 'sys',
      messages: baseMessages,
      tools,
      cards: [],
      ctx,
      limits: defaultAgentLimits(),
      signal: ac.signal,
    });
    const summary = await agent.run((e) => {
      if (e.t === 'tool' && e.phase === 'start') {
        ac.abort();
      }
    });
    expect(summary.finish).toBe('aborted');
  });
});
