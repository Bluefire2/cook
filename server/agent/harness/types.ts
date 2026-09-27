export type ToolParameters =
  | {
      type: 'object';
      description?: string;
      properties: Record<string, ToolParameters>;
      required?: string[];
    }
  | { type: 'array'; description?: string; items: ToolParameters; maxItems?: number }
  | { type: 'string'; description?: string; enum?: string[] }
  | { type: 'number' | 'integer' | 'boolean'; description?: string };

export interface AgentMessage {
  role: 'user' | 'assistant';
  text: string;
}

export type ToolResult = { output: unknown } | { error: string };

export interface ToolSpec<Ctx> {
  name: string;
  description: string;
  parameters: ToolParameters;
  run(args: unknown, ctx: Ctx, signal: AbortSignal): Promise<ToolResult>;
}

export interface CardSpec<Ctx, T = unknown> {
  type: string;
  version: number;
  toolName: string;
  description: string;
  parameters: ToolParameters;
  rule: string;
  normalize(args: unknown, ctx: Ctx): { ok: true; data: T } | { ok: false; error: string };
  historyText(data: T): string;
}

export type AgentEvent =
  | { t: 'text'; step: number; d: string }
  | { t: 'interim'; step: number }
  | { t: 'tool'; name: string; phase: 'start' | 'end'; ok?: boolean }
  | { t: 'card'; card: { type: string; v: number; id: string; data: unknown } }
  | { t: 'error'; message: string }
  | { t: 'done' };

export interface AgentLimits {
  maxSteps: number;
  maxCallsPerStep: number;
  maxCallsPerRequest: number;
  maxResultBytes: number;
  maxCumulativeResultBytes: number;
  toolConcurrency: number;
  maxOutputTokens: number;
}

/** Opaque per-step turn; only the ModelClient that created it may read it. */
export type OpaqueTurn = { readonly brand: 'opaque-turn' };

export interface ModelStepRequest {
  systemInstruction: string;
  messages: AgentMessage[];
  priorTurns: OpaqueTurn[];
  tools: { name: string; description: string; parameters: ToolParameters }[];
  forceText: boolean;
  maxOutputTokens: number;
  signal: AbortSignal;
  /** Appended as a final user text content after replaying prior turns (tool-limit nudge). */
  extraUserNote?: string;
}

export type ModelStepEvent =
  | { kind: 'text'; d: string }
  | { kind: 'call'; id?: string; name: string; args: Record<string, unknown> };

export interface ModelStepStream {
  events: AsyncIterable<ModelStepEvent>;
  continueWith(
    responses: { id?: string; name: string; result: ToolResult }[],
  ): Promise<OpaqueTurn>;
  blocked(): boolean;
}

export interface ModelClient {
  step(request: ModelStepRequest): Promise<ModelStepStream>;
}

export interface AgentRunSummary {
  steps: number;
  calls: number;
  resultBytes: number;
  finish: 'text' | 'error' | 'aborted';
}

export type StartAgentOptions<Ctx> = {
  model: ModelClient;
  systemInstruction: string;
  messages: AgentMessage[];
  tools: ToolSpec<Ctx>[];
  cards: CardSpec<Ctx, unknown>[];
  ctx: Ctx;
  limits: AgentLimits;
  signal: AbortSignal;
};

export type StartAgentResult = {
  run(emit: (event: AgentEvent) => void): Promise<AgentRunSummary>;
};
