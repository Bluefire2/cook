import { toolResultBytes, truncateToolResult } from './taggedJson.ts';
import {
  ASSISTANT_UNAVAILABLE_CODE,
  ASSISTANT_UNAVAILABLE_MESSAGE,
  type AgentEvent,
  type AgentRunSummary,
  type CardSpec,
  type ModelStepStream,
  type StartAgentOptions,
  type StartAgentResult,
  type ToolResult,
  type ToolSpec,
} from './types.ts';

function duplicateNameError(tools: ToolSpec<unknown>[], cards: CardSpec<unknown, unknown>[]): void {
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) {
      throw new Error(`duplicate tool name: ${t.name}`);
    }
    seen.add(t.name);
  }
  for (const c of cards) {
    if (seen.has(c.toolName)) {
      throw new Error(`duplicate tool name: ${c.toolName}`);
    }
    seen.add(c.toolName);
  }
}

function unavailableEvent(): AgentEvent {
  return {
    t: 'error',
    code: ASSISTANT_UNAVAILABLE_CODE,
    message: ASSISTANT_UNAVAILABLE_MESSAGE,
  };
}

async function executeCall<Ctx>(
  call: { id?: string; name: string; args: Record<string, unknown> },
  opts: {
    toolByName: Map<string, ToolSpec<Ctx>>;
    cardByName: Map<string, CardSpec<Ctx, unknown>>;
    ctx: Ctx;
    signal: AbortSignal;
    emit: (event: AgentEvent) => void;
  },
): Promise<ToolResult> {
  const { toolByName, cardByName, ctx, signal, emit } = opts;
  const card = cardByName.get(call.name);
  if (card) {
    const normalized = card.normalize(call.args, ctx);
    if (!normalized.ok) {
      return { error: normalized.error };
    }
    const id = crypto.randomUUID();
    emit({
      t: 'card',
      card: { type: card.type, v: card.version, id, data: normalized.data },
    });
    return { output: { shown: true } };
  }
  const tool = toolByName.get(call.name);
  if (!tool) {
    return { error: 'unknown tool' };
  }
  if (signal.aborted) {
    return { error: 'tool failed' };
  }
  try {
    return await tool.run(call.args, ctx, signal);
  } catch {
    return { error: 'tool failed' };
  }
}

async function runCallsInOrder<Ctx>(
  calls: { id?: string; name: string; args: Record<string, unknown> }[],
  opts: {
    toolByName: Map<string, ToolSpec<Ctx>>;
    cardByName: Map<string, CardSpec<Ctx, unknown>>;
    ctx: Ctx;
    signal: AbortSignal;
    emit: (event: AgentEvent) => void;
    limits: {
      maxCallsPerStep: number;
      maxCallsPerRequest: number;
      maxResultBytes: number;
      toolConcurrency: number;
    };
    state: {
      callsThisStep: number;
      executedCallsThisRequest: number;
      cumulativeResultBytes: number;
    };
  },
): Promise<{ responses: { id?: string; name: string; result: ToolResult }[]; aborted: boolean }> {
  const responses: { id?: string; name: string; result: ToolResult }[] = [];
  const { emit, signal, limits, state } = opts;

  type Job = {
    index: number;
    call: (typeof calls)[0];
    limitSkip: boolean;
  };

  const jobs: Job[] = calls.map((call, index) => {
    const overStep = state.callsThisStep >= limits.maxCallsPerStep;
    const overRequest = state.executedCallsThisRequest >= limits.maxCallsPerRequest;
    const limitSkip = overStep || overRequest;
    if (!limitSkip) {
      state.callsThisStep += 1;
      state.executedCallsThisRequest += 1;
    }
    return { index, call, limitSkip };
  });

  const results: ToolResult[] = new Array(calls.length);
  let nextToSchedule = 0;
  let inFlight = 0;
  let aborted = false;

  await new Promise<void>((resolve) => {
    const trySchedule = () => {
      while (!aborted && inFlight < limits.toolConcurrency && nextToSchedule < jobs.length) {
        const job = jobs[nextToSchedule]!;
        nextToSchedule += 1;
        inFlight += 1;
        void runOne(job);
      }
      if (inFlight === 0 && (nextToSchedule >= jobs.length || aborted)) {
        resolve();
      }
    };

    const runOne = async (job: Job) => {
      if (signal.aborted) {
        aborted = true;
        results[job.index] = { error: 'tool failed' };
        inFlight -= 1;
        trySchedule();
        return;
      }
      emit({ t: 'tool', name: job.call.name, phase: 'start' });
      let result: ToolResult;
      if (job.limitSkip) {
        result = { error: 'limit' };
        emit({ t: 'tool', name: job.call.name, phase: 'end', ok: false });
      } else {
        result = truncateToolResult(await executeCall(job.call, opts), limits.maxResultBytes);
        state.cumulativeResultBytes += toolResultBytes(result);
        const ok = !('error' in result);
        emit({ t: 'tool', name: job.call.name, phase: 'end', ok });
      }
      results[job.index] = result;
      inFlight -= 1;
      trySchedule();
    };

    trySchedule();
  });

  for (let i = 0; i < calls.length; i += 1) {
    responses.push({
      id: calls[i]!.id,
      name: calls[i]!.name,
      result: results[i] ?? { error: 'tool failed' },
    });
  }
  return { responses, aborted };
}

async function consumeStream(
  stream: ModelStepStream,
  step: number,
  emit: (event: AgentEvent) => void,
): Promise<{
  calls: { id?: string; name: string; args: Record<string, unknown> }[];
  hadText: boolean;
}> {
  const calls: { id?: string; name: string; args: Record<string, unknown> }[] = [];
  let hadText = false;
  for await (const ev of stream.events) {
    if (ev.kind === 'text') {
      hadText = true;
      emit({ t: 'text', step, d: ev.d });
    } else {
      calls.push({ id: ev.id, name: ev.name, args: ev.args });
    }
  }
  return { calls, hadText };
}

export function startAgent<Ctx>(opts: StartAgentOptions<Ctx>): Promise<StartAgentResult> {
  try {
    duplicateNameError(opts.tools, opts.cards);
  } catch (err) {
    return Promise.reject(err);
  }

  const toolByName = new Map(opts.tools.map((t) => [t.name, t]));
  const cardByName = new Map(opts.cards.map((c) => [c.toolName, c]));

  const allTools = [
    ...opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    ...opts.cards.map((c) => ({
      name: c.toolName,
      description: c.description,
      parameters: c.parameters,
    })),
  ];

  let firstStream: ModelStepStream;
  const forceFirstStep = opts.limits.maxSteps === 1;
  const firstStepPromise = opts.model
    .step({
      systemInstruction: opts.systemInstruction,
      messages: opts.messages,
      priorTurns: [],
      tools: allTools,
      forceText: forceFirstStep,
      maxOutputTokens: opts.limits.maxOutputTokens,
      signal: opts.signal,
    })
    .then((s) => {
      firstStream = s;
    });

  return firstStepPromise.then(() => {
    const LIMIT_NOTE =
      'You have reached the tool limit. Answer now from the information you already have. Do not call tools.';

    return {
      run(emit: (event: AgentEvent) => void): Promise<AgentRunSummary> {
        const summary: AgentRunSummary = {
          steps: 0,
          calls: 0,
          resultBytes: 0,
          finish: 'text',
        };
        // Stop or the deadline can abort a model stream mid-read, which
        // throws. That is an abort, not a failure.
        return runLoop(emit, summary).catch((err: unknown) => {
          if (opts.signal.aborted) {
            return finishOnAbort(emit, summary);
          }
          throw err;
        });
      },
    };

    function isDeadlineAbort(signal: AbortSignal): boolean {
      const reason: unknown = signal.reason;
      return (
        typeof reason === 'object' &&
        reason !== null &&
        'name' in reason &&
        (reason as { name: unknown }).name === 'TimeoutError'
      );
    }

    function finishOnAbort(
      emit: (event: AgentEvent) => void,
      summary: AgentRunSummary,
    ): AgentRunSummary {
      if (isDeadlineAbort(opts.signal)) {
        emit(unavailableEvent());
        emit({ t: 'done' });
        summary.finish = 'error';
        return summary;
      }
      summary.finish = 'aborted';
      return summary;
    }

    async function runLoop(
      emit: (event: AgentEvent) => void,
      summary: AgentRunSummary,
    ): Promise<AgentRunSummary> {
      const priorTurns: import('./types.ts').OpaqueTurn[] = [];
      let step = 1;
      let forceNext = false;
      let extraUserNote: string | undefined;
      let stream: ModelStepStream = firstStream!;

      while (step <= opts.limits.maxSteps) {
        if (opts.signal.aborted) {
          summary.steps = step;
          return finishOnAbort(emit, summary);
        }

        summary.steps = step;
        const forceText = forceNext || step === opts.limits.maxSteps;
        forceNext = false;
        const noteThisStep = extraUserNote;
        extraUserNote = undefined;

        if (step > 1) {
          stream = await opts.model.step({
            systemInstruction: opts.systemInstruction,
            messages: opts.messages,
            priorTurns,
            tools: allTools,
            forceText,
            maxOutputTokens: opts.limits.maxOutputTokens,
            signal: opts.signal,
            extraUserNote: noteThisStep,
          });
        }

        const { calls, hadText } = await consumeStream(stream, step, emit);

        if (stream.blocked()) {
          emit(unavailableEvent());
          emit({ t: 'done' });
          summary.finish = 'error';
          return summary;
        }

        if (calls.length === 0) {
          if (!hadText) {
            emit(unavailableEvent());
            emit({ t: 'done' });
            summary.finish = 'error';
            return summary;
          }
          emit({ t: 'done' });
          summary.finish = 'text';
          return summary;
        }

        if (forceText) {
          emit(unavailableEvent());
          emit({ t: 'done' });
          summary.finish = 'error';
          return summary;
        }

        emit({ t: 'interim', step });

        const callsThisStepAtStart = 0;
        const state = {
          callsThisStep: callsThisStepAtStart,
          executedCallsThisRequest: summary.calls,
          cumulativeResultBytes: summary.resultBytes,
        };

        const { responses, aborted } = await runCallsInOrder(calls, {
          toolByName,
          cardByName,
          ctx: opts.ctx,
          signal: opts.signal,
          emit,
          limits: {
            maxCallsPerStep: opts.limits.maxCallsPerStep,
            maxCallsPerRequest: opts.limits.maxCallsPerRequest,
            maxResultBytes: opts.limits.maxResultBytes,
            toolConcurrency: opts.limits.toolConcurrency,
          },
          state,
        });

        summary.calls = state.executedCallsThisRequest;
        summary.resultBytes = state.cumulativeResultBytes;

        if (aborted || opts.signal.aborted) {
          return finishOnAbort(emit, summary);
        }

        const turn = await stream.continueWith(responses);
        priorTurns.push(turn);

        if (
          state.cumulativeResultBytes > opts.limits.maxCumulativeResultBytes ||
          summary.calls >= opts.limits.maxCallsPerRequest
        ) {
          forceNext = true;
          extraUserNote = LIMIT_NOTE;
        }

        step += 1;
      }

      emit(unavailableEvent());
      emit({ t: 'done' });
      summary.finish = 'error';
      return summary;
    }
  });
}
