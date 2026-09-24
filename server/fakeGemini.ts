/**
 * Test double for `RecipeImportDeps`. Returns a real `GenerateContentResponse`
 * so `.text` is the SDK's own getter, not a hand-written stand-in.
 */
import { GenerateContentResponse, type GenerateContentParameters } from '@google/genai';
import type { RecipeImportDeps } from './recipeImport.ts';

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
          const response = new GenerateContentResponse();
          if (reply !== undefined) {
            response.candidates = [{ content: { role: 'model', parts: [{ text: reply }] } }];
          }
          return Promise.resolve(response);
        },
      },
    },
  };
  return { deps, calls };
}
