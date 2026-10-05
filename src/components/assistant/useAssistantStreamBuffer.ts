import { useCallback, useEffect, useRef } from 'react';

export const assistantStreamRenderPolicy = {
  frameIntervalMs: 32,
  backlogDrainMs: 200,
  minimumCharsPerFrame: 12,
  maximumCharsPerFrame: 48,
} as const;

export type AssistantStreamPart = 'content' | 'thinking';

export interface AssistantStreamFlush {
  requestId: string;
  contentDelta: string;
  thinkingDelta: string;
}

interface PendingAssistantStream {
  requestId: string | null;
  content: string;
  thinking: string;
}

function takeTextPrefix(value: string, requestedLength: number): [prefix: string, remainder: string] {
  let end = Math.min(value.length, requestedLength);
  if (end > 0 && end < value.length) {
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
  }
  return [value.slice(0, end), value.slice(end)];
}

function getFrameCharacterCount(length: number): number {
  if (length <= 0) return 0;
  const drainCount = Math.ceil(
    length * assistantStreamRenderPolicy.frameIntervalMs / assistantStreamRenderPolicy.backlogDrainMs,
  );
  return Math.min(
    length,
    assistantStreamRenderPolicy.maximumCharsPerFrame,
    Math.max(assistantStreamRenderPolicy.minimumCharsPerFrame, drainCount),
  );
}

export function takeAssistantStreamFrame(pending: Pick<PendingAssistantStream, 'content' | 'thinking'>): {
  flush: Pick<AssistantStreamFlush, 'contentDelta' | 'thinkingDelta'>;
  remaining: Pick<PendingAssistantStream, 'content' | 'thinking'>;
} {
  const [contentDelta, content] = takeTextPrefix(pending.content, getFrameCharacterCount(pending.content.length));
  const [thinkingDelta, thinking] = takeTextPrefix(pending.thinking, getFrameCharacterCount(pending.thinking.length));
  return {
    flush: { contentDelta, thinkingDelta },
    remaining: { content, thinking },
  };
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

export function useAssistantStreamBuffer(onFlush: (flush: AssistantStreamFlush) => void): {
  enqueue: (requestId: string, part: AssistantStreamPart, text: string) => void;
  flush: (requestId: string) => void;
  reset: (requestId?: string | null) => void;
} {
  const onFlushRef = useRef(onFlush);
  const pendingRef = useRef<PendingAssistantStream>({ requestId: null, content: '', thinking: '' });
  const animationFrameRef = useRef<number | null>(null);
  const lastFlushAtRef = useRef(0);
  const hasFlushedRef = useRef(false);
  const flushFrameRef = useRef<(requestId: string, flushAll: boolean) => void>(() => undefined);

  useEffect(() => {
    onFlushRef.current = onFlush;
  }, [onFlush]);

  const cancelScheduledFlush = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const scheduleFlush = useCallback((requestId: string) => {
    if (animationFrameRef.current !== null) return;
    const waitForCadence = () => {
      animationFrameRef.current = window.requestAnimationFrame(() => {
        if (now() - lastFlushAtRef.current < assistantStreamRenderPolicy.frameIntervalMs) {
          waitForCadence();
          return;
        }
        animationFrameRef.current = null;
        flushFrameRef.current(requestId, false);
      });
    };
    waitForCadence();
  }, []);

  const flush = useCallback((requestId: string, flushAll = true) => {
    const pending = pendingRef.current;
    if (pending.requestId !== requestId) return;
    cancelScheduledFlush();

    const next = flushAll
      ? {
          flush: { contentDelta: pending.content, thinkingDelta: pending.thinking },
          remaining: { content: '', thinking: '' },
        }
      : takeAssistantStreamFrame(pending);
    pendingRef.current = { requestId, ...next.remaining };
    if (next.flush.contentDelta || next.flush.thinkingDelta) {
      onFlushRef.current({ requestId, ...next.flush });
      lastFlushAtRef.current = now();
      hasFlushedRef.current = true;
    }
    if (next.remaining.content || next.remaining.thinking) scheduleFlush(requestId);
  }, [cancelScheduledFlush, scheduleFlush]);

  useEffect(() => {
    flushFrameRef.current = flush;
  }, [flush]);

  const reset = useCallback((requestId: string | null = null) => {
    cancelScheduledFlush();
    pendingRef.current = { requestId, content: '', thinking: '' };
    lastFlushAtRef.current = 0;
    hasFlushedRef.current = false;
  }, [cancelScheduledFlush]);

  const enqueue = useCallback((requestId: string, part: AssistantStreamPart, text: string) => {
    if (!text) return;
    const pending = pendingRef.current;
    if (pending.requestId && pending.requestId !== requestId) flush(pending.requestId);
    if (pendingRef.current.requestId !== requestId) {
      pendingRef.current = { requestId, content: '', thinking: '' };
      hasFlushedRef.current = false;
    }
    pendingRef.current[part] += text;
    // 首个增量决定用户看到的是“正在输出”还是一个空白气泡。它直接提交；
    // 后续增量再按固定帧率排空，避免 Markdown 每个 token 都重绘。
    if (!hasFlushedRef.current) {
      flush(requestId, false);
      return;
    }
    scheduleFlush(requestId);
  }, [flush, scheduleFlush]);

  const flushAll = useCallback((requestId: string) => flush(requestId, true), [flush]);

  useEffect(() => () => cancelScheduledFlush(), [cancelScheduledFlush]);

  return { enqueue, flush: flushAll, reset };
}
