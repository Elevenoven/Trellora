export interface AssistantTurnLifecycleMessage {
  id: string;
  state: 'pending' | 'streaming' | 'complete' | 'error' | 'cancelled';
  statusMessage?: string;
}

/** Settles a renderer-owned turn before its asynchronous cancel event returns. */
export function markAssistantTurnCancelled<T extends AssistantTurnLifecycleMessage>(
  messages: readonly T[],
  requestId: string,
): T[] {
  return messages.map((message) => message.id === requestId
    && (message.state === 'pending' || message.state === 'streaming')
    ? { ...message, state: 'cancelled', statusMessage: undefined }
    : message) as T[];
}
