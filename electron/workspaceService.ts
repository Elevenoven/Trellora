import fs from 'node:fs';
import path from 'node:path';
import { getLibraryMetaDirectory } from './treeOrder';

const workspaceSystemDirectoryName = '.menghan-workspace';

export interface SystemWorkspaceValidationResult {
  path: string;
  systemDirectory: string;
}

export interface WorkspaceValidationResult {
  path: string;
  metaDirectory: string;
}

export function validateSystemWorkspaceDirectory(workspacePath: string): SystemWorkspaceValidationResult {
  const resolvedPath = path.resolve(workspacePath);

  try {
    fs.mkdirSync(resolvedPath, { recursive: true });
    fs.accessSync(resolvedPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`工作区必须可读写：${resolvedPath}`);
  }

  const systemDirectory = path.join(resolvedPath, workspaceSystemDirectoryName);
  try {
    fs.mkdirSync(systemDirectory, { recursive: true });
    fs.accessSync(systemDirectory, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`无法在工作区中创建系统文件目录：${systemDirectory}`);
  }

  return { path: resolvedPath, systemDirectory };
}

export function validateWorkspaceDirectory(workspacePath: string): WorkspaceValidationResult {
  const resolvedPath = path.resolve(workspacePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`选择的笔记库不存在：${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`选择的位置不是文件夹：${resolvedPath}`);
  }

  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`选择的笔记库必须可读写：${resolvedPath}`);
  }

  const metaDirectory = getLibraryMetaDirectory(resolvedPath);
  try {
    fs.mkdirSync(metaDirectory, { recursive: true });
    fs.accessSync(metaDirectory, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`无法在该笔记库中创建系统元数据目录：${metaDirectory}`);
  }

  return { path: resolvedPath, metaDirectory };
}
