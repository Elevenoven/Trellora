import type { AssistantConversationMessage } from './assistantTurnTypes';
import type { CurrentNoteEvidenceRecord } from './currentNoteEvidenceLedger';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot';
import { tokenizeCurrentNoteText } from './currentNoteStructure';

export type CurrentNoteMemoryConversationZone = 'conversation-summary' | 'conversation-hot';

/**
 * Repository-owned metadata travels with the ordinary conversation message so
 * existing callers remain source-compatible while the Context Adapter can
 * preserve summary/Turn identity. Renderer-provided messages have no metadata
 * and are treated as hot, turn-local history.
 */
export interface CurrentNoteMemoryConversationMessage extends AssistantConversationMessage {
  memory: {
    zone: CurrentNoteMemoryConversationZone;
    sourceId: string;
    sourceVersion: string;
    contentHash: string;
    turnId?: string;
    turnSeq?: number;
  };
}

export function createCurrentNoteMemoryConversationMessage(
  message: AssistantConversationMessage,
  memory: CurrentNoteMemoryConversationMessage['memory'],
): CurrentNoteMemoryConversationMessage {
  if (!message.content.trim()) throw new Error('Current Note 记忆消息内容不能为空。');
  if (!memory.sourceId.trim() || !memory.sourceVersion.trim() || !memory.contentHash.trim()) {
    throw new Error('Current Note 记忆消息来源不完整。');
  }
  if (memory.turnSeq !== undefined && (!Number.isSafeInteger(memory.turnSeq) || memory.turnSeq < 1)) {
    throw new Error('Current Note 记忆消息 turnSeq 无效。');
  }
  return {
    role: message.role,
    content: message.content,
    memory: { ...memory },
  };
}

export function isCurrentNoteMemoryConversationMessage(
  message: AssistantConversationMessage,
): message is CurrentNoteMemoryConversationMessage {
  const candidate = message as Partial<CurrentNoteMemoryConversationMessage>;
  return Boolean(candidate.memory
    && (candidate.memory.zone === 'conversation-summary' || candidate.memory.zone === 'conversation-hot')
    && typeof candidate.memory.sourceId === 'string'
    && typeof candidate.memory.sourceVersion === 'string'
    && typeof candidate.memory.contentHash === 'string');
}

export interface NoteConversationMemoryEntry {
  contentHash: string;
  questionTerms: string[];
  evidence: CurrentNoteEvidenceRecord[];
  answer: string;
  completeness: 'complete' | 'partial' | 'not-found';
}

/**
 * P3 keeps evidence only for the active Electron window and never writes it to
 * disk. P4 replaces this adapter with an explicitly scoped SQLite repository.
 */
export class NoteConversationMemory {
  private readonly entries = new Map<string, NoteConversationMemoryEntry[]>();

  findCovered(scopeKey: string, snapshot: CurrentNoteSnapshot, question: string): NoteConversationMemoryEntry | undefined {
    const terms = meaningfulTerms(question);
    if (!terms.length) return undefined;
    const candidates = this.entries.get(scopeKey) ?? [];
    for (const entry of [...candidates].reverse()) {
      if (entry.contentHash !== snapshot.contentHash || entry.completeness !== 'complete' || entry.evidence.length === 0) continue;
      const knownTerms = new Set(entry.questionTerms);
      if (terms.every((term) => knownTerms.has(term))) return copyEntry(entry);
    }
    return undefined;
  }

  remember(scopeKey: string, entry: NoteConversationMemoryEntry): void {
    const current = this.entries.get(scopeKey) ?? [];
    const next = [...current.filter((candidate) => candidate.contentHash === entry.contentHash), copyEntry(entry)].slice(-12);
    this.entries.set(scopeKey, next);
  }

  clearScope(scopeKey: string): void {
    this.entries.delete(scopeKey);
  }
}

export class MemoryCoverageJudge {
  constructor(private readonly memory: NoteConversationMemory) {}

  findCovered(scopeKey: string, snapshot: CurrentNoteSnapshot, question: string): NoteConversationMemoryEntry | undefined {
    return this.memory.findCovered(scopeKey, snapshot, question);
  }
}

export function createMemoryEntry(input: {
  snapshot: CurrentNoteSnapshot;
  question: string;
  evidence: CurrentNoteEvidenceRecord[];
  answer: string;
  completeness: 'complete' | 'partial' | 'not-found';
}): NoteConversationMemoryEntry {
  return {
    contentHash: input.snapshot.contentHash,
    questionTerms: meaningfulTerms(input.question),
    evidence: input.evidence.map(copyEvidence),
    answer: input.answer,
    completeness: input.completeness,
  };
}

function meaningfulTerms(value: string): string[] {
  return [...new Set(tokenizeCurrentNoteText(value).filter((term) => term.length >= 2))].slice(0, 24);
}

function copyEntry(entry: NoteConversationMemoryEntry): NoteConversationMemoryEntry {
  return { ...entry, questionTerms: [...entry.questionTerms], evidence: entry.evidence.map(copyEvidence) };
}

function copyEvidence(record: CurrentNoteEvidenceRecord): CurrentNoteEvidenceRecord {
  return { ...record, blockIds: [...record.blockIds], headingPath: [...record.headingPath], matchedTerms: [...record.matchedTerms], supports: [...record.supports] };
}
