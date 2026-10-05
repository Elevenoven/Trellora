import type { SelectionEditAction, SelectionEditContextScope } from '../../electron/knowledge/selectionEditTypes';
import type { SelectionSnapshot } from './selectionActions';

/**
 * Renderer-only launcher state. Since SE-7 the regular launcher uses the
 * unified `selection-edit:*` IPC; the expansion workspace remains a dedicated
 * evidence UI over the same coordinator.
 */
export interface SelectionEditLauncherSession {
  snapshot: SelectionSnapshot;
  action: SelectionEditAction;
  contextScope: SelectionEditContextScope;
  targetLanguage: string;
  instruction: string;
}

export function createSelectionEditLauncherSession(snapshot: SelectionSnapshot): SelectionEditLauncherSession {
  return {
    snapshot,
    action: 'polish',
    contextScope: 'auto',
    targetLanguage: '中文',
    instruction: '',
  };
}
