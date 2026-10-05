export interface WorkspaceDataChange {
  source?: string;
  target?: string;
  waitUntil: (task: Promise<void>) => void;
}

export function relocateWorkspacePath(value: string | null, source?: string, target?: string): string | null {
  if (!value || !source || !target) return value;
  const normalized = value.replaceAll('\\', '/'), root = source.replaceAll('\\', '/');
  if (normalized.toLowerCase() === root.toLowerCase()) return target;
  return normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? `${target}${value.slice(source.length)}` : value;
}

/** Mounted pages register their refresh synchronously; the migration dialog awaits all of them before unlocking. */
export async function notifyWorkspaceDataChanged(source?: string, target?: string): Promise<void> {
  const tasks: Promise<void>[] = [];
  window.dispatchEvent(new CustomEvent<WorkspaceDataChange>('workspace-data-changed', { detail: { source, target, waitUntil: task => tasks.push(task) } }));
  await Promise.all(tasks);
}
