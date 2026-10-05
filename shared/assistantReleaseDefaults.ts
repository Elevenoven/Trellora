/** 发行版统一管理工程模式；长期记忆四入口已切 canonical，内部环境变量保留回滚能力。 */
export const ASSISTANT_RELEASE_DEFAULTS = Object.freeze({
  assistantPlanMode: 'current-note',
  adaptiveContextMode: 'observe',
  assistantContextRuntimeMode: 'observe',
  assistantContextRuntimeChatMode: 'inherit',
  assistantContextRuntimeKnowledgeBaseMode: 'inherit',
  assistantContextRuntimeCurrentNoteDirectMode: 'inherit',
  assistantContextRuntimeCurrentNoteReactMode: 'inherit',
  assistantMemoryProjectionMode: 'canonical',
  assistantMemoryProjectionChatMode: 'inherit',
  assistantMemoryProjectionKnowledgeBaseMode: 'inherit',
  assistantMemoryProjectionCurrentNoteDirectMode: 'inherit',
  assistantMemoryProjectionCurrentNoteReactMode: 'inherit',
} as const);
