export type AgentRole = 'user' | 'assistant';

export interface AgentWireCard {
  type: string;
  v: number;
  id: string;
  data: unknown;
}

export interface AgentWireMessage {
  role: AgentRole;
  content: string;
  cards?: AgentWireCard[];
}

export type AgentServerEvent =
  | { t: 'text'; step: number; d: string }
  | { t: 'interim'; step: number }
  | { t: 'tool'; name: string; phase: 'start' | 'end'; ok?: boolean }
  | { t: 'card'; card: AgentWireCard }
  | { t: 'error'; message: string }
  | { t: 'done' };
