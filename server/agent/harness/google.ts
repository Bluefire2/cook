import {
  FinishReason,
  FunctionCallingConfigMode,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
  type Schema,
  Type,
  GoogleGenAI,
} from '@google/genai';
import type {
  AgentMessage,
  ModelClient,
  ModelStepEvent,
  ModelStepRequest,
  ModelStepStream,
  OpaqueTurn,
  ToolParameters,
  ToolResult,
} from './types.ts';

type GoogleOpaqueTurn = OpaqueTurn & {
  modelContent: Content;
  responseContent: Content;
};

export type GenerateFn = (
  params: GenerateContentParameters,
) => Promise<AsyncIterable<GenerateContentResponse>>;

export function toolParametersToSchema(params: ToolParameters): Schema {
  switch (params.type) {
    case 'object': {
      const properties: Record<string, Schema> = {};
      for (const [key, value] of Object.entries(params.properties)) {
        properties[key] = toolParametersToSchema(value);
      }
      return {
        type: Type.OBJECT,
        description: params.description,
        properties,
        required: params.required,
      };
    }
    case 'array':
      return {
        type: Type.ARRAY,
        description: params.description,
        items: toolParametersToSchema(params.items),
        maxItems: params.maxItems !== undefined ? String(params.maxItems) : undefined,
      };
    case 'string':
      return {
        type: Type.STRING,
        description: params.description,
        enum: params.enum,
      };
    case 'number':
      return { type: Type.NUMBER, description: params.description };
    case 'integer':
      return { type: Type.INTEGER, description: params.description };
    case 'boolean':
      return { type: Type.BOOLEAN, description: params.description };
  }
}

function agentMessagesToContents(messages: AgentMessage[]): Content[] {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.text }],
  }));
}

function isGoogleTurn(turn: OpaqueTurn): turn is GoogleOpaqueTurn {
  return turn.brand === 'opaque-turn';
}

function replayTurns(priorTurns: OpaqueTurn[]): Content[] {
  const out: Content[] = [];
  for (const turn of priorTurns) {
    if (!isGoogleTurn(turn)) {
      throw new Error('OpaqueTurn was not created by googleModel');
    }
    out.push(turn.modelContent);
    out.push(turn.responseContent);
  }
  return out;
}

function buildContents(request: ModelStepRequest): Content[] {
  const contents = [...agentMessagesToContents(request.messages), ...replayTurns(request.priorTurns)];
  if (request.extraUserNote) {
    contents.push({ role: 'user', parts: [{ text: request.extraUserNote }] });
  }
  return contents;
}

const BLOCKED_FINISH_REASONS = new Set<FinishReason>([
  FinishReason.SAFETY,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.RECITATION,
]);

function toolResultToResponse(result: ToolResult): Record<string, unknown> {
  if ('error' in result) {
    return { error: result.error };
  }
  return { output: result.output };
}

function clonePart(part: Part): Part {
  return structuredClone(part);
}

export function googleModel(opts: {
  apiKey: string;
  model: string;
  generate?: GenerateFn;
}): ModelClient {
  const generate: GenerateFn =
    opts.generate ??
    ((params) =>
      new GoogleGenAI({ apiKey: opts.apiKey }).models.generateContentStream(params));

  return {
    async step(request: ModelStepRequest): Promise<ModelStepStream> {
      const contents = buildContents(request);
      const streamPromise = generate({
        model: opts.model,
        contents,
        config: {
          abortSignal: request.signal,
          systemInstruction: request.systemInstruction,
          maxOutputTokens: request.maxOutputTokens,
          tools: [
            {
              functionDeclarations: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: toolParametersToSchema(t.parameters),
              })),
            },
          ],
          toolConfig: {
            functionCallingConfig: request.forceText
              ? { mode: FunctionCallingConfigMode.NONE }
              : {},
          },
        },
      });

      const iterable = await streamPromise;

      const bufferedParts: Part[] = [];
      let finishReason: FinishReason | undefined;
      let promptBlocked = false;
      let sawText = false;
      let sawCalls = false;
      const yieldedCallKeys = new Set<string>();
      let streamDone = false;

      async function* eventGenerator(): AsyncGenerator<ModelStepEvent> {
        for await (const chunk of iterable) {
          if (chunk.promptFeedback?.blockReason) {
            promptBlocked = true;
          }
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason) {
            finishReason = candidate.finishReason;
          }
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              bufferedParts.push(clonePart(part));
              if (part.functionCall?.name) {
                sawCalls = true;
                const fc = part.functionCall;
                const key = fc.id ?? `${fc.name}:${yieldedCallKeys.size}`;
                if (!yieldedCallKeys.has(key)) {
                  yieldedCallKeys.add(key);
                  yield {
                    kind: 'call',
                    id: fc.id,
                    name: fc.name ?? '',
                    args: fc.args ?? {},
                  };
                }
              }
              if (part.text && !part.thought) {
                sawText = true;
              }
            }
          }
          // `chunk.text` is this chunk's new text, matching api/chat.ts.
          const chunkText = chunk.text;
          if (chunkText && chunkText.length > 0) {
            sawText = true;
            yield { kind: 'text', d: chunkText };
          }
        }
        streamDone = true;
      }

      const events = eventGenerator();

      return {
        events,
        blocked(): boolean {
          if (!streamDone) {
            throw new Error('blocked() before stream finished');
          }
          if (promptBlocked) {
            return true;
          }
          if (finishReason && BLOCKED_FINISH_REASONS.has(finishReason)) {
            return true;
          }
          if (!sawText && !sawCalls) {
            return true;
          }
          return false;
        },
        async continueWith(
          responses: { id?: string; name: string; result: ToolResult }[],
        ): Promise<OpaqueTurn> {
          if (!streamDone) {
            throw new Error('continueWith before stream finished');
          }
          const modelContent: Content = {
            role: 'model',
            parts: bufferedParts.map(clonePart),
          };
          const responseContent: Content = {
            role: 'user',
            parts: responses.map((r) => ({
              functionResponse: {
                id: r.id,
                name: r.name,
                response: toolResultToResponse(r.result),
              },
            })),
          };
          const turn: GoogleOpaqueTurn = {
            brand: 'opaque-turn',
            modelContent,
            responseContent,
          };
          return turn;
        },
      };
    },
  };
}
