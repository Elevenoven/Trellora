import { randomUUID } from 'node:crypto';
import type { AssistantSessionScope } from './assistantMemoryTypes';

const sessionIdPattern = /^assistant-session-[0-9a-f-]{36}$/u;

export class AssistantSessionScopeError extends Error {
  readonly code = 'ASSISTANT_SESSION_SCOPE_MISMATCH';

  constructor() {
    super('当前会话不可用，请新建或重新选择会话。');
  }
}

export function createAssistantSessionId(): string {
  return `assistant-session-${randomUUID()}`;
}

export function assertAssistantSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !sessionIdPattern.test(value)) throw new AssistantSessionScopeError();
}

/**
 * A renderer can only use the session it opened in this window.  The registry
 * is deliberately process-local: it is authorization state, not user memory.
 */
export class AssistantSessionScopeRegistry {
  private readonly owners = new Map<string, number>();

  authorize(scope: AssistantSessionScope, webContentsId: number): void {
    const key = `${scope.libraryId}\u0000${scope.noteId}\u0000${scope.sessionId}`;
    const owner = this.owners.get(key);
    if (owner !== undefined && owner !== webContentsId) throw new AssistantSessionScopeError();
    this.owners.set(key, webContentsId);
  }

  releaseWindow(webContentsId: number): void {
    for (const [key, owner] of this.owners) {
      if (owner === webContentsId) this.owners.delete(key);
    }
  }
}
