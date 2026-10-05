import { randomUUID } from 'node:crypto';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot';
import { readMarkdownLineRange } from './currentNoteStructure';

/** Opaque task-local cursors page through exact original lines, including a long single line. */
export function createExpansionRangeReader(snapshot: CurrentNoteSnapshot) {
  const cursors = new Map<string, { requestedFrom: number; requestedTo: number; line: number; offset: number }>();
  return (lineFrom: number, lineTo: number, cursor: unknown, maxChars: number) => {
    const state = cursor === undefined ? { requestedFrom: lineFrom, requestedTo: lineTo, line: lineFrom, offset: 0 }
      : typeof cursor === 'string' ? cursors.get(cursor) : undefined;
    if (!state || state.requestedFrom !== lineFrom || state.requestedTo !== lineTo) throw new Error('深读 cursor 必须来自相同行范围的上一页。');
    let text = '';
    let line = state.line;
    let offset = state.offset;
    let lastLine = line;
    const firstOffset = offset;
    while (line <= lineTo && line - state.line < 48 && text.length < maxChars) {
      const sourceLine = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, line, line);
      const separator = text && offset === 0 ? (snapshot.markdown[(snapshot.lineOffsets[line - 1] ?? 0) - 2] === '\r' ? '\r\n' : '\n') : '';
      const available = maxChars - text.length - separator.length;
      if (available < 1) break;
      let end = Math.min(sourceLine.length, offset + available);
      if (end < sourceLine.length && /[\uD800-\uDBFF]/u.test(sourceLine[end - 1] ?? '')) end -= 1;
      if (end <= offset && sourceLine.length) break;
      text += separator + sourceLine.slice(offset, end);
      lastLine = line;
      if (end < sourceLine.length) { offset = end; break; }
      line += 1;
      offset = 0;
    }
    const remaining = line <= lineTo;
    let nextCursor: string | undefined;
    if (remaining && text.length) {
      nextCursor = `expansion-read-${randomUUID()}`;
      cursors.set(nextCursor, { ...state, line, offset });
    }
    return {
      text, lineFrom: state.line, lineTo: lastLine, contentOffset: firstOffset,
      blockIds: snapshot.blocks.filter((block) => block.lineFrom <= lastLine && block.lineTo >= state.line).map((block) => block.blockId),
      headingPath: snapshot.blocks.find((block) => block.lineFrom <= state.line && block.lineTo >= state.line)?.headingPath ?? [],
      ...(nextCursor ? { nextCursor } : {}),
    };
  };
}
