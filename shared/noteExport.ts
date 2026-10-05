export type NoteExportFormat = 'md' | 'html' | 'pdf';

/** 导出当前编辑内容；sourcePath 仅用于保护原笔记，不由导出器写入。 */
export interface NoteExportRequest {
  format: NoteExportFormat;
  defaultName: string;
  content: string;
  sourcePath: string;
}
