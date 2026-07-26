import type Anthropic from '@anthropic-ai/sdk';

/**
 * JSON schema matching the app's Recipe type (src/lib/types.ts), minus
 * id/timestamps. Shared by the import extraction tool and the chat
 * update_recipe tool. (Underscore prefix keeps this out of Vercel routing.)
 */
export const RECIPE_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string', description: 'One or two sentences.' },
    servings: { type: 'number' },
    prepMinutes: { type: 'number' },
    cookMinutes: { type: 'number' },
    ingredientSections: {
      type: 'array',
      description:
        'Use a single unnamed section unless the recipe clearly has component groups like "Sauce" and "Dough".',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                quantity: { type: 'number', description: 'e.g. 0.5 for ½' },
                unit: { type: 'string', description: 'e.g. g, tbsp, cup' },
                item: { type: 'string', description: 'The ingredient itself' },
                note: { type: 'string', description: 'e.g. "thinly sliced"' },
              },
              required: ['item'],
            },
          },
        },
        required: ['items'],
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '2-4 short lowercase tags like "pasta", "weeknight".',
    },
    notes: { type: 'string', description: 'Tips or variations worth keeping.' },
  },
  required: ['title', 'servings', 'ingredientSections', 'steps', 'tags'],
};
