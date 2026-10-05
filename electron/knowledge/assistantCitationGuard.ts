import { createHash } from 'node:crypto';

import type {
  AssistantCitationValidation,
  AssistantEvidenceCitation,
} from './assistantTurnTypes';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot';
import { readMarkdownLineRange } from './currentNoteStructure';

function hashSourceRange(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/** Re-check an old assistant citation before the renderer scrolls to it. */
export function validateAssistantCitationAgainstSnapshot(
  citation: AssistantEvidenceCitation,
  snapshot: CurrentNoteSnapshot,
): AssistantCitationValidation {
  if (snapshot.contentHash !== citation.contentHash) {
    return {
      status: 'stale',
      message: '笔记内容已更新，此引用已过期；请重新提问后再定位。',
    };
  }

  if (citation.lineFrom > snapshot.lineCount || citation.lineTo > snapshot.lineCount) {
    return {
      status: 'stale',
      message: '引用位置已不在当前笔记范围内，无法定位。',
    };
  }

  const sourceRange = readMarkdownLineRange(
    snapshot.markdown,
    snapshot.lineOffsets,
    citation.lineFrom,
    citation.lineTo,
  );
  if (!sourceRange || hashSourceRange(sourceRange) !== citation.quoteHash) {
    return {
      status: 'stale',
      message: '引用原文已变化，无法定位到可靠位置；请重新提问。',
    };
  }

  return { status: 'valid' };
}
