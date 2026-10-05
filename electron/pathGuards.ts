import fs from 'fs';
import path from 'path';

const invalidEntryNameCharacters = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);

/** Check both spelling and real ancestors, including destinations not created yet. */
export function assertInsideDirectory(candidatePath: string, parentPath: string, message = '路径必须位于当前笔记库内。'): string {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedParent = path.resolve(parentPath);
  if (!isInside(resolvedCandidate, resolvedParent) || !isInside(resolveRealAncestors(resolvedCandidate), resolveRealAncestors(resolvedParent))) throw new Error(message);
  let current = resolvedParent;
  for (const part of path.relative(resolvedParent, resolvedCandidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${message} 路径包含符号链接或 junction。`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return resolvedCandidate;
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** lstat detects dangling links; missing descendants inherit the closest real parent. */
export function resolveRealAncestors(candidate: string): string {
  let current = candidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(current);
      return path.join(fs.realpathSync(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling link must fail closed instead of being treated as a new path.
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('路径包含无法解析的链接。'); }
      catch (checkError) { if ((checkError as NodeJS.ErrnoException).code !== 'ENOENT') throw checkError; }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function sanitizeEntryName(entryName: string): string {
  const sanitized = [...entryName]
    .filter((character) => !invalidEntryNameCharacters.has(character) && character.charCodeAt(0) >= 32)
    .join('')
    .trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('文件或文件夹名称无效。');
  }
  return sanitized;
}

export function assertExistingDirectory(directoryPath: string): string {
  const resolvedPath = path.resolve(directoryPath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
    throw new Error('目标文件夹不存在。');
  }
  return resolvedPath;
}

export function getUniquePath(directoryPath: string, fileName: string): string {
  const parsed = path.parse(fileName);
  let candidateName = fileName;
  let candidatePath = path.join(directoryPath, candidateName);
  let counter = 1;

  while (fs.existsSync(candidatePath)) {
    candidateName = `${parsed.name} ${counter}${parsed.ext}`;
    candidatePath = path.join(directoryPath, candidateName);
    counter++;
  }

  return candidatePath;
}
