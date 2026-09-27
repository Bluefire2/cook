import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Load .env.local so the evals get GEMINI_API_KEY and CHAT_MODEL, the same
// env dev:api reads. Do not log values.
const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf('=');
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (key === '' || process.env[key] !== undefined) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// Opt-in live Gemini evals. Not picked up by `npm test` (default include is
// **/*.{test,spec}.ts). Requires GEMINI_API_KEY; see npm run test:import.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['evals/**/*.eval.ts'],
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
