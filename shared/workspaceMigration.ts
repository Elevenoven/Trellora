export interface WorkspaceMigrationLibrary {
  path: string;
  alias: string;
  kind: 'note' | 'materials';
  internal: boolean;
}

export interface WorkspaceMigrationPreview {
  operationId: string;
  sourcePath: string;
  targetPath: string;
  fileCount: number;
  totalBytes: number;
  libraries: WorkspaceMigrationLibrary[];
}

export type WorkspaceMigrationPhase = 'idle' | 'preparing' | 'copying' | 'mapping'
  | 'validating' | 'switching' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface WorkspaceMigrationStatus {
  operationId?: string;
  phase: WorkspaceMigrationPhase;
  message: string;
  progress: number;
  completedBytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
  currentFile?: string;
  sourcePath?: string;
  targetPath?: string;
  canCancel: boolean;
}

export interface WorkspaceMigrationState {
  status: WorkspaceMigrationStatus;
  pending: WorkspaceMigrationPreview | null;
}
