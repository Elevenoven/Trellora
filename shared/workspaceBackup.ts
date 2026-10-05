export interface BackupRoot { id: string; sourcePath: string; label: string; kind: 'workspace' | 'library'; workspaceRelativePath?: string }
export interface BackupRegistration { kind: 'note' | 'materials'; rootId: string; relativePath: string; sourcePath?: string; alias: string; icon?: string; origin?: 'created' | 'upgraded' }
export interface BackupFile { rootId: string; relativePath: string; size: number; sha256: string; databaseVersion?: number }
export interface BackupManifest {
  schemaVersion: 1; appVersion: string; createdAt: string; backupId: string; kind: 'manual' | 'daily';
  roots: BackupRoot[]; registrations: BackupRegistration[];
  sourceScope: { workspaceId: string; principalId: string }; sourceWorkspacePath?: string;
  files: BackupFile[]; directories: Array<{ rootId: string; relativePath: string }>; omitted: string[];
}
export interface BackupSource { path: string; alias: string; kind: 'note' | 'materials'; internal: boolean; exists: boolean }
export interface BackupConfiguration { enabled: boolean; targetDirectory: string; externalLibraries: string[]; lastSuccessfulAt?: string; lastSuccessfulPath?: string; lastDailyDate?: string; lastError?: string }
export interface BackupStatus { operationId?: string; phase: 'idle' | 'preparing' | 'capturing' | 'packing' | 'validating' | 'restoring' | 'completed' | 'failed'; message: string; completed: number; total: number; outputPath?: string; configuration: BackupConfiguration; workspacePath: string; sources: BackupSource[] }
export interface RestorePreview { operationId: string; manifest: BackupManifest; targetDirectory: string; targets: Array<{ rootId: string; sourcePath: string; targetPath: string }>; warnings: string[] }
export interface RestoreStatus { operationId: string; phase: 'validating' | 'restoring' | 'completed' | 'failed'; message: string; completed: number; total: number; workspacePath: string; targetDirectory: string; warnings: string[] }
export interface RestoredConnectionHints { aiModelSettings?: { profiles: Array<{ id: string; label: string; config: { model?: string; endpoint?: string } }> }; modelHub?: { providers: Array<{ id?: string; label?: string; endpoint?: string }> }; parsing?: { mineruEndpoint?: string } }
