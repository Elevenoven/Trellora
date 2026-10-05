/** 独立文件合同；库内编辑仍使用 notes:*，不扩大笔记库路径权限。 */
export const EXTERNAL_TEXT_MAX_BYTES = 20 * 1024 * 1024;
export const EXTERNAL_MARKDOWN_RENDER_MAX_BYTES = 2 * 1024 * 1024;
export type DocumentEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'gbk' | 'gb18030';
export interface DocumentFormat { encoding: DocumentEncoding; bom: 'none' | 'utf8' | 'utf16le' | 'utf16be'; lineEnding: 'lf' | 'crlf' | 'cr' | 'mixed' | 'none' }
export interface DocumentDiskVersion { diskHash: string; byteLength: number; mtimeMs: number }
export interface DocumentCapabilities { canEdit: boolean; canSaveInPlace: boolean; canSaveAs: boolean; canJoinLibrary: boolean; canUseWysiwyg: boolean; canPreviewMarkdown: boolean; canUseDocumentAi: boolean; canUseLibraryFeatures: false; canWriteLocalAssets: boolean }
export interface DocumentSnapshot {
  documentSessionId: string;
  source: { kind: 'external' };
  displayPath: string;
  fileKind: 'markdown' | 'text';
  content: string;
  format: DocumentFormat;
  diskVersion: DocumentDiskVersion;
  draftRevision: number;
  persistedRevision: number;
  capabilities: DocumentCapabilities;
}
export interface DocumentOpenRequest { requestId: string; displayPath: string }
export type DocumentOpenResult =
  | { status: 'opened'; snapshot: DocumentSnapshot }
  | { status: 'library'; libraryPath: string; filePath: string }
  | { status: 'encoding-required'; message: string };
export interface DocumentDraftRequest { documentSessionId: string; draftRevision: number; content: string }
export interface DocumentDraftResult { recoveryState: 'current' | 'degraded'; recoveryMessage?: string }
export interface DocumentSaveRequest extends DocumentDraftRequest { requestId: string; expectedDiskHash: string; formatOverride?: Partial<DocumentFormat> }
export type DocumentSaveResult =
  | { status: 'committed' | 'unchanged'; requestId: string; documentSessionId: string; committedDraftRevision: number; snapshot: DocumentSnapshot; committedContent?: string; referenceReplacements?: Record<string, string>; recoveryMessage?: string; index: { kind: 'not-applicable' } }
  | { status: 'conflict' | 'failed'; requestId: string; documentSessionId: string; code: string; message: string; retryable: boolean };
export interface DocumentCloseRequest { documentSessionId: string; draftRevision: number; reason: 'saved' | 'discard' | 'transferred'; transferToken?: string }
export interface DocumentCloseResult { closed: true; recoveryMessage?: string }
export interface DocumentJoinRequest { documentSessionId: string; draftRevision: number; requestId: string; libraryPath: string }
export interface DocumentJoinResult { path: string; libraryPath: string; draftRevision: number; transferToken: string; indexState: 'pending' | 'current' | 'degraded' }
export interface DocumentRecovery { recoveryId: string; displayPath: string; updatedAt: string; draftRevision: number; diskHash: string }
export interface DocumentRecent { displayPath: string; openedAt: string }
export interface DocumentResourcePreview { urls: Record<string, string>; issues: string[]; draftRevision: number }
