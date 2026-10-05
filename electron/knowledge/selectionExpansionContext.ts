import { createHash } from 'node:crypto';
import { countFullNoteCharacters, EXPANSION_FULL_NOTE_CHARACTERS } from '../../shared/selectionExpansionPolicy';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot';
import type { SelectionContextReceipt, SelectionEvidenceItem } from './selectionEditTypes';
import { resolveAiModelDescriptor } from './aiModelCapabilities';
import type { AiProviderConfig } from './aiTypes';

export type SelectionExpansionMode = 'legacy' | 'adaptive';

/** Expansion owns this switch and threshold; QA and other edits keep their policy. */
export function resolveSelectionExpansionMode(value = process.env.MENGHAN_SELECTION_EXPANSION_CONTEXT_MODE): SelectionExpansionMode {
  return value === 'legacy' ? 'legacy' : 'adaptive';
}

export function isExpansionFullNoteEvidence(item: SelectionEvidenceItem): boolean {
  return item.sourceKind === 'current-note' && item.evidenceId.startsWith('expansion-full-note-');
}

/** Keep optional provider thinking from consuming the measured body output reserve. */
export function resolveExpansionThinkingMode(config: AiProviderConfig, model: string): 'simple' | undefined {
  const dialect = resolveAiModelDescriptor(config, model).thinkingDialect;
  return dialect === 'deepseek' || dialect === 'qwen' ? 'simple' : undefined;
}

/** Full-note admission reads the immutable main-process snapshot without tool caps. */
export function collectExpansionSnapshotContext(snapshot: CurrentNoteSnapshot, goalIds: string[]): {
  evidence: SelectionEvidenceItem[]; receipt: SelectionContextReceipt;
} {
  const characters = countFullNoteCharacters(snapshot.markdown);
  const included = characters <= EXPANSION_FULL_NOTE_CHARACTERS;
  const locator = `当前笔记 / L1-L${snapshot.lineCount}`;
  return {
    evidence: included ? [{
      evidenceId: `expansion-full-note-${snapshot.contentHash.slice(0, 24)}`, sourceKind: 'current-note', title: snapshot.title,
      locator, content: snapshot.markdown, sourceContentHash: snapshot.contentHash,
      textHash: createHash('sha256').update(snapshot.markdown).digest('hex'), goalIds, readVerified: true,
    }] : [],
    receipt: {
      contextMode: included ? 'full-note' : 'related-original', fullNoteCharacters: characters,
      includedCharacters: included ? characters : 0, fullNoteIncluded: included,
      planned: [{ sourceKind: 'current-note', reason: included ? '按扩写阈值纳入当前笔记全文。' : '通过 ReAct 定位并深读当前笔记相关原文。' }],
      used: included ? [{ sourceKind: 'current-note', title: snapshot.title, locator, characterCount: characters }] : [],
      skipped: [], candidates: [], conflicts: [], personalization: { requested: false, applied: false, itemCount: 0 },
      fullNoteMode: 'not-requested',
    },
  };
}
