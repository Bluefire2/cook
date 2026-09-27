/**
 * Test double for `RecipeImportDeps`. Returns a real `GenerateContentResponse`
 * so `.text` is the SDK's own getter, not a hand-written stand-in.
 *
 * `fakeImportDeps` repeats one reply on every call. `fakeImportDepsReplies`
 * returns each reply once, in order: call *n* is reply *n*, an `Error` entry
 * rejects with that error, and a call past the end rejects.
 *
 * Lives outside `server/` because the Dockerfile copies `server/` into the
 * runtime image and `server/membership.test.ts` scans every non-test file
 * there as production code.
 */
import { GenerateContentResponse, type GenerateContentParameters } from '@google/genai';
import type { RecipeImportDeps } from '../server/recipeImport.ts';

function contentResponse(reply: string | undefined): GenerateContentResponse {
  const response = new GenerateContentResponse();
  if (reply !== undefined) {
    response.candidates = [{ content: { role: 'model', parts: [{ text: reply }] } }];
  }
  return response;
}

export function fakeImportDeps(reply: string | undefined): {
  deps: RecipeImportDeps;
  calls: GenerateContentParameters[];
} {
  const calls: GenerateContentParameters[] = [];
  const deps: RecipeImportDeps = {
    model: 'test-model',
    ai: {
      models: {
        generateContent: (params) => {
          calls.push(params);
          return Promise.resolve(contentResponse(reply));
        },
      },
    },
  };
  return { deps, calls };
}

export function fakeImportDepsReplies(
  replies: readonly (string | undefined | Error)[],
): { deps: RecipeImportDeps; calls: GenerateContentParameters[] } {
  const calls: GenerateContentParameters[] = [];
  const deps: RecipeImportDeps = {
    model: 'test-model',
    ai: {
      models: {
        generateContent: (params) => {
          const n = calls.length;
          calls.push(params);
          if (n >= replies.length) {
            return Promise.reject(new Error(`fakeImportDepsReplies: unexpected call ${n}`));
          }
          const reply = replies[n];
          if (reply instanceof Error) return Promise.reject(reply);
          return Promise.resolve(contentResponse(reply));
        },
      },
    },
  };
  return { deps, calls };
}
