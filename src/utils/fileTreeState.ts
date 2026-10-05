import type { FileNode } from '../electron';

export function collectDirectoryPaths(nodes: FileNode[]): string[] {
  return nodes.flatMap((node) => node.isDirectory
    ? [node.path, ...collectDirectoryPaths(node.children ?? [])]
    : []);
}

export function getAncestorFolderPaths(nodes: FileNode[], targetPath: string): string[] {
  for (const node of nodes) {
    if (node.path === targetPath) return [];
    if (!node.isDirectory) continue;
    const nested = getAncestorFolderPaths(node.children ?? [], targetPath);
    if (nested.length > 0 || containsPath(node.children ?? [], targetPath)) return [node.path, ...nested];
  }
  return [];
}

export function reconcileCollapsedFolderPaths(nodes: FileNode[], collapsedFolderPaths: Iterable<string>): string[] {
  const valid = new Set(collectDirectoryPaths(nodes));
  return [...new Set(collapsedFolderPaths)].filter((folderPath) => valid.has(folderPath));
}

export function collapseAllFolders(nodes: FileNode[]): string[] {
  return collectDirectoryPaths(nodes);
}

export function collapseExceptCurrentPath(nodes: FileNode[], currentPath: string | null): string[] {
  const ancestors = new Set(currentPath ? getAncestorFolderPaths(nodes, currentPath) : []);
  return collectDirectoryPaths(nodes).filter((folderPath) => !ancestors.has(folderPath));
}

function containsPath(nodes: FileNode[], targetPath: string): boolean {
  return nodes.some((node) => node.path === targetPath || (node.isDirectory && containsPath(node.children ?? [], targetPath)));
}
