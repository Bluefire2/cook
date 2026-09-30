import type { AgentLimits } from './types.ts';

export function defaultAgentLimits(): AgentLimits {
  return {
    maxSteps: 6,
    maxCallsPerStep: 8,
    maxCallsPerRequest: 16,
    maxResultBytes: 24_000,
    maxCumulativeResultBytes: 150_000,
    toolConcurrency: 4,
    maxOutputTokens: 4096,
  };
}
