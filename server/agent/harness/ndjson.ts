import type { AgentEvent } from './types.ts';

export function encodeAgentEvent(event: AgentEvent): string {
  return `${JSON.stringify(event)}\n`;
}
