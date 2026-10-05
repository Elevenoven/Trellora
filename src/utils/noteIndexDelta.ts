import type { FileNode } from '../electron';
import type { NoteIndexChanged } from '../../shared/noteSave';

/** Copy only tree branches touched by a delta; retain the rest of the renderer tree. */
export function applyNoteIndexDelta(files: FileNode[], delta: NoteIndexChanged): FileNode[] {
  const key = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  let next = files;
  const remove = (nodes: FileNode[], target: string): FileNode[] => nodes.filter((node) => key(node.path) !== key(target))
    .map((node) => node.children ? { ...node, children: remove(node.children, target) } : node);
  for (const change of delta.changes) if (change.kind === 'unlink' || change.kind === 'unlinkDir') next = remove(next, change.path);
  for (const addition of delta.nodes) {
    const node: FileNode = { ...addition, kind: addition.kind as FileNode['kind'], ...(addition.isDirectory ? { children: [] } : {}) };
    const parent = key(addition.path).split('/').slice(0, -1).join('/');
    const insert = (nodes: FileNode[], directory: string): FileNode[] => {
      if (key(directory) === parent) {
        const exists = nodes.some((entry) => key(entry.path) === key(node.path));
        return exists ? nodes.map((entry) => key(entry.path) === key(node.path) ? { ...entry, ...node, ...(entry.children ? { children: entry.children } : {}) } : entry)
          : [...nodes, node].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
      }
      return nodes.map((entry) => entry.children ? { ...entry, children: insert(entry.children, entry.path) } : entry);
    };
    next = insert(next, delta.libraryPath);
  }
  for (const [directory, paths] of Object.entries(delta.orders ?? {})) {
    const positions = new Map(paths.map((value, index) => [key(value), index]));
    const reorder = (nodes: FileNode[], parent: string): FileNode[] => key(parent) === key(directory)
      ? [...nodes].sort((a, b) => (positions.get(key(a.path)) ?? Infinity) - (positions.get(key(b.path)) ?? Infinity))
      : nodes.map((entry) => entry.children ? { ...entry, children: reorder(entry.children, entry.path) } : entry);
    next = reorder(next, delta.libraryPath);
  }
  return next;
}
