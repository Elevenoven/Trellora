export type DocumentAiAction = 'rewrite' | 'translate' | 'summary' | 'question';
export interface DocumentAiSelection { from: number; to: number; text: string }
export interface DocumentAiApplyRequest { receiptId: string; documentSessionId: string; draftRevision: number; selection?: DocumentAiSelection }
export interface DocumentAiRequest { documentSessionId: string; draftRevision: number; requestId: string; action: DocumentAiAction; selection?: DocumentAiSelection; question?: string; targetLanguage?: 'zh-CN' | 'en'; libraryPath?: string }
export interface DocumentAiResult { receiptId: string; documentSessionId: string; draftRevision: number; contentHash: string; action: DocumentAiAction; selection?: DocumentAiSelection; text: string; scope: 'selection' | 'document'; supplementLibrary?: string; inputTokensEstimate: number }
