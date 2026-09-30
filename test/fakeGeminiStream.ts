/**
 * Fake `GenerateFn` for harness tests. Returns real `GenerateContentResponse`
 * instances so stream chunk getters match production SDK behavior.
 */
import {
  FinishReason,
  GenerateContentResponse,
  type GenerateContentParameters,
  type Part,
} from '@google/genai';
import type { GenerateFn } from '../server/agent/harness/google.ts';

export function chunkResponse(parts: Part[], finishReason?: FinishReason): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.candidates = [
    {
      content: { role: 'model', parts },
      finishReason,
    },
  ];
  return response;
}

export function textChunk(text: string): GenerateContentResponse {
  return chunkResponse([{ text }]);
}

export function callChunk(
  name: string,
  args: Record<string, unknown>,
  id?: string,
): GenerateContentResponse {
  return chunkResponse([{ functionCall: { name, args, id } }]);
}

export function fakeGenerateStream(
  steps: GenerateContentResponse[][],
): { generate: GenerateFn; calls: GenerateContentParameters[] } {
  const calls: GenerateContentParameters[] = [];
  let stepIndex = 0;

  const generate: GenerateFn = async (params) => {
    calls.push(params);
    const chunks = steps[stepIndex] ?? [];
    stepIndex += 1;
    async function* stream() {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    return stream();
  };

  return { generate, calls };
}
