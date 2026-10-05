import fs from 'fs';
import path from 'path';
import { getFileTypeInfo, isLikelyTextBuffer } from './fileTypes';
import { randomUUID } from 'node:crypto';
import { decodeTextBuffer } from './textFile';
import { assertExistingDirectory, assertInsideDirectory, getUniquePath } from './pathGuards';

export interface ImportTextFilesOptions {
  libraryPath: string;
  sourcePaths: string[];
  targetDirectoryPath?: string | null;
}

export interface ImportedTextFile {
  sourcePath: string;
  targetPath: string;
  name: string;
  kind: 'markdown' | 'text';
  extension: string;
}

/** Preflight the whole batch; publish complete files exclusively and undo this batch on failure. */
export function importTextFilesToLibrary(options: ImportTextFilesOptions): ImportedTextFile[] {
  const libraryPath = assertExistingDirectory(options.libraryPath);
  const targetDirectory = resolveTargetDirectory(libraryPath, options.targetDirectoryPath);

  const prepared = options.sourcePaths.map((sourcePath) => {
    const resolvedSourcePath = path.resolve(sourcePath);
    if (!fs.existsSync(resolvedSourcePath) || !fs.statSync(resolvedSourcePath).isFile()) {
      throw new Error(`找不到要导入的文件：${sourcePath}`);
    }

    const typeInfo = getFileTypeInfo(resolvedSourcePath);
    if (!typeInfo) {
      throw new Error(`不支持的文本文件：${path.basename(sourcePath)}`);
    }

    const buffer = fs.readFileSync(resolvedSourcePath);
    if (!isLikelyTextBuffer(buffer)) {
      throw new Error(`文件不是可识别的纯文本：${path.basename(sourcePath)}`);
    }

    const content = decodeTextBuffer(buffer);
    return { sourcePath: resolvedSourcePath, content, typeInfo };
  });
  const created: Array<{ path: string; dev: number; ino: number }> = [];
  const temporary: string[] = [];
  let result: ImportedTextFile[] = [];
  let failure: Error | undefined;
  try {
    const staged = prepared.map((file) => {
      assertInsideDirectory(targetDirectory, libraryPath);
      const stagingPath = path.join(targetDirectory, `.trellora-import-${randomUUID()}.tmp`);
      const handle = fs.openSync(stagingPath, 'wx');
      temporary.push(stagingPath);
      try { fs.writeFileSync(handle, file.content, 'utf8'); fs.fsyncSync(handle); }
      finally { fs.closeSync(handle); }
      return { ...file, stagingPath };
    });
    result = staged.map((file) => {
      assertInsideDirectory(targetDirectory, libraryPath);
      const targetPath = getUniquePath(targetDirectory, path.basename(file.sourcePath));
      fs.linkSync(file.stagingPath, targetPath);
      const stat = fs.lstatSync(file.stagingPath);
      created.push({ path: targetPath, dev: stat.dev, ino: stat.ino });
      fs.unlinkSync(file.stagingPath);
      return { sourcePath: file.sourcePath, targetPath, name: path.basename(targetPath), kind: file.typeInfo.kind, extension: file.typeInfo.extension };
    });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    for (const file of created.reverse()) {
      try {
        assertInsideDirectory(file.path, libraryPath);
        const stat = fs.lstatSync(file.path);
        if (stat.dev === file.dev && stat.ino === file.ino && !stat.isSymbolicLink()) fs.unlinkSync(file.path);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') failure = new Error(`${failure.message}；新增文件清理失败：${file.path}`, { cause: cleanupError });
      }
    }
  } finally {
    for (const file of temporary) {
      try { assertInsideDirectory(file, libraryPath); fs.unlinkSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure ??= error instanceof Error ? error : new Error(String(error)); }
    }
  }
  if (failure) throw failure;
  return result;
}

function resolveTargetDirectory(libraryPath: string, targetDirectoryPath?: string | null): string {
  const targetDirectory = targetDirectoryPath
    ? assertInsideDirectory(targetDirectoryPath, libraryPath, '目标文件夹必须位于当前笔记库内。')
    : libraryPath;
  return assertExistingDirectory(targetDirectory);
}
