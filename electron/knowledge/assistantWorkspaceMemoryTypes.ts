import type { AssistantTurnResult } from './assistantTurnTypes';

export interface AssistantWorkspaceSessionSummary {
  sessionId: string;
  title: string;
  pinned: boolean;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantWorkspaceMemoryPage<T> {
  items: T[];
  nextCursor?: number;
}

export type AssistantWorkspaceTurnStatus = 'pending' | 'complete' | 'cancelled' | 'error' | 'interrupted';

export interface AssistantWorkspaceStoredTurn {
  turnId: string;
  turnSeq: number;
  userText: string;
  assistantText?: string;
  scopeLabel: string;
  status: AssistantWorkspaceTurnStatus;
  result?: AssistantTurnResult;
  createdAt: string;
  finishedAt?: string;
}

export interface AssistantWorkspaceSessionDetail {
  session: AssistantWorkspaceSessionSummary;
  turns: AssistantWorkspaceStoredTurn[];
}
