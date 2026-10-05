export const MEMORY_ROUTES = Object.freeze([
  'chat',
  'knowledge-base',
  'current-note-direct',
  'current-note-react',
] as const);

export type MemoryRoute = (typeof MEMORY_ROUTES)[number];

/**
 * Explicit rollback flags for projections that remain active before WK-M9.
 * New WeKnora-aligned services must not silently reuse these projections.
 */
export const LEGACY_MEMORY_FLAGS = Object.freeze({
  qaSummaryProjection: true,
  qaConversationCheckpointProjection: true,
  currentNoteRollingSummaryProjection: true,
  currentNoteDirectHistoryProjection: true,
  userProfileProjection: true,
} as const);

export const LEGACY_MEMORY_SHADOW_BASELINE = Object.freeze({
  chat: Object.freeze({
    storage: 'qa-memory.db',
    recentHistory: 'hot-6',
    summary: 'batch-3-summary-800',
    longSpan: 'l2-9-l3-27',
  }),
  'knowledge-base': Object.freeze({
    storage: 'qa-memory.db',
    recentHistory: 'hot-6',
    summary: 'batch-3-summary-800',
    longSpan: 'l2-9-l3-27',
  }),
  'current-note-direct': Object.freeze({
    storage: 'assistant-memory.db',
    recentHistory: 'last-6-messages',
    summary: 'rolling-summary',
    maximumCharacters: 4_000,
  }),
  'current-note-react': Object.freeze({
    storage: 'assistant-memory.db',
    recentHistory: 'hot-3',
    summary: 'rolling-summary',
    maximumCharacters: null,
  }),
} as const satisfies Record<MemoryRoute, Readonly<Record<string, string | number | null>>>);

