import { createHash } from 'node:crypto';
import type {
  SelectionContextReceipt,
  SelectionEditFactSourceKind,
  SelectionEvidenceItem,
} from './selectionEditTypes';

export interface SelectionEditMaterialCandidate {
  documentId: string;
  ordinal: number;
  title: string;
  sourceContentHash: string;
  queryTerms: readonly string[];
  retrievalMethod: 'knowledge_search' | 'grep_chunks';
  score?: number;
  goalIds: readonly string[];
}

export interface SelectionEditWebCandidate {
  url: string;
  title: string;
  source: string;
  queryTerms: readonly string[];
  goalIds: readonly string[];
}

export interface SelectionEditCurrentNoteCandidate {
  snapshotId: string;
  contentHash: string;
  blockId: string;
  title: string;
  headingPath: readonly string[];
  lineFrom: number;
  lineTo: number;
  queryTerms: readonly string[];
  goalIds: readonly string[];
  score?: number;
}

export interface SelectionEditLibraryNoteCandidate {
  noteId: string;
  snapshotId: string;
  contentHash: string;
  title: string;
  relativePath: string;
  queryTerms: readonly string[];
  goalIds: readonly string[];
  score?: number;
}

export interface SelectionEditLibraryBlockCandidate {
  noteId: string;
  snapshotId: string;
  contentHash: string;
  blockId: string;
  title: string;
  headingPath: readonly string[];
  lineFrom: number;
  lineTo: number;
  queryTerms: readonly string[];
  goalIds: readonly string[];
  score?: number;
}

/**
 * Task-local selection-edit ledger. Retrieval candidates remain separate from
 * verified evidence: only a bounded material deep read or a successful web
 * fetch can add a SelectionEvidenceItem.
 */
export class SelectionEditEvidenceSession {
  private readonly candidates = new Map<string, SelectionContextReceipt['candidates'][number]>();
  private readonly materialCandidates = new Map<string, SelectionEditMaterialCandidate>();
  private readonly webCandidates = new Map<string, SelectionEditWebCandidate>();
  private readonly currentNoteCandidates = new Map<string, SelectionEditCurrentNoteCandidate>();
  private readonly libraryNoteCandidates = new Map<string, SelectionEditLibraryNoteCandidate>();
  private readonly libraryBlockCandidates = new Map<string, SelectionEditLibraryBlockCandidate>();
  private readonly evidence = new Map<string, SelectionEvidenceItem>();
  private readonly planned: SelectionContextReceipt['planned'] = [];
  private readonly skipped: SelectionContextReceipt['skipped'] = [];

  constructor(private readonly maxEvidenceCharacters = 9_000) {
    if (!Number.isSafeInteger(maxEvidenceCharacters) || maxEvidenceCharacters < 1) {
      throw new Error('选择编辑证据容量无效。');
    }
  }

  get evidenceCharacters(): number {
    return [...this.evidence.values()].reduce((total, item) => total + item.content.length, 0);
  }

  get remainingEvidenceCharacters(): number {
    return Math.max(0, this.maxEvidenceCharacters - this.evidenceCharacters);
  }

  plan(sourceKind: SelectionEditFactSourceKind, reason: string): void {
    if (!this.planned.some((item) => item.sourceKind === sourceKind && item.reason === reason)) {
      this.planned.push({ sourceKind, reason });
    }
  }

  skip(sourceKind: SelectionEditFactSourceKind, reason: string): void {
    this.skipped.push({ sourceKind, reason });
  }

  recordMaterialCandidate(input: SelectionEditMaterialCandidate): void {
    const candidateId = `materials:${input.documentId}:${input.ordinal}`;
    const existing = this.materialCandidates.get(candidateId);
    if (existing) {
      this.materialCandidates.set(candidateId, {
        ...existing,
        queryTerms: unique([...existing.queryTerms, ...input.queryTerms]),
        goalIds: unique([...existing.goalIds, ...input.goalIds]),
        retrievalMethod: existing.retrievalMethod === input.retrievalMethod ? existing.retrievalMethod : 'knowledge_search',
        score: Math.max(existing.score ?? 0, input.score ?? 0),
      });
      const receipt = this.candidates.get(candidateId);
      if (receipt) {
        receipt.queryTerms = unique([...receipt.queryTerms, ...input.queryTerms]);
        receipt.retrievalMethod = unique([receipt.retrievalMethod, input.retrievalMethod]).join(' + ');
        receipt.score = Math.max(receipt.score ?? 0, input.score ?? 0);
      }
      return;
    }
    this.materialCandidates.set(candidateId, { ...input, queryTerms: unique(input.queryTerms), goalIds: unique(input.goalIds) });
    this.candidates.set(candidateId, {
      candidateId,
      sourceKind: 'materials',
      title: input.title,
      locator: `资料库 / ${input.title} / 父块 ${input.ordinal}`,
      queryTerms: unique(input.queryTerms),
      retrievalMethod: input.retrievalMethod,
      readState: 'candidate',
      ...(input.score === undefined ? {} : { score: input.score }),
      sourceContentHash: input.sourceContentHash,
    });
  }

  materialCandidate(documentId: string, ordinal: number): SelectionEditMaterialCandidate | undefined {
    return this.materialCandidates.get(`materials:${documentId}:${ordinal}`);
  }

  recordWebCandidate(input: SelectionEditWebCandidate): void {
    const candidateId = `web:${hashText(input.url).slice(0, 24)}`;
    const existing = this.webCandidates.get(input.url);
    if (existing) {
      this.webCandidates.set(input.url, {
        ...existing,
        title: input.title || existing.title,
        queryTerms: unique([...existing.queryTerms, ...input.queryTerms]),
        goalIds: unique([...existing.goalIds, ...input.goalIds]),
      });
      const receipt = this.candidates.get(candidateId);
      if (receipt) receipt.queryTerms = unique([...receipt.queryTerms, ...input.queryTerms]);
      return;
    }
    this.webCandidates.set(input.url, { ...input, queryTerms: unique(input.queryTerms), goalIds: unique(input.goalIds) });
    this.candidates.set(candidateId, {
      candidateId,
      sourceKind: 'web',
      title: input.title,
      locator: `网页 / ${safeHostname(input.url)}`,
      queryTerms: unique(input.queryTerms),
      retrievalMethod: 'web_search（摘要仅用于定位）',
      readState: 'candidate',
      pageVerified: false,
    });
  }

  webCandidate(url: string): SelectionEditWebCandidate | undefined {
    return this.webCandidates.get(url);
  }

  recordCurrentNoteCandidate(input: SelectionEditCurrentNoteCandidate): void {
    const candidateId = currentNoteCandidateId(input.snapshotId, input.blockId);
    const existing = this.currentNoteCandidates.get(candidateId);
    if (existing) {
      this.currentNoteCandidates.set(candidateId, {
        ...existing,
        queryTerms: unique([...existing.queryTerms, ...input.queryTerms]),
        goalIds: unique([...existing.goalIds, ...input.goalIds]),
        score: Math.max(existing.score ?? 0, input.score ?? 0),
      });
      const receipt = this.candidates.get(candidateId);
      if (receipt) {
        receipt.queryTerms = unique([...receipt.queryTerms, ...input.queryTerms]);
        receipt.score = Math.max(receipt.score ?? 0, input.score ?? 0);
      }
      return;
    }
    this.currentNoteCandidates.set(candidateId, copyCurrentNoteCandidate(input));
    this.candidates.set(candidateId, {
      candidateId,
      sourceKind: 'current-note',
      title: input.title,
      locator: `当前笔记 / L${input.lineFrom}-L${input.lineTo}`,
      queryTerms: unique(input.queryTerms),
      retrievalMethod: 'search_note（候选仅用于定位）',
      readState: 'candidate',
      ...(input.score === undefined ? {} : { score: input.score }),
      sourceContentHash: input.contentHash,
    });
  }

  currentNoteCandidateForRange(snapshotId: string, lineFrom: number, lineTo: number): SelectionEditCurrentNoteCandidate | undefined {
    return [...this.currentNoteCandidates.values()].find((candidate) => candidate.snapshotId === snapshotId
      && candidate.lineFrom <= lineFrom && candidate.lineTo >= lineTo);
  }

  recordLibraryNoteCandidate(input: SelectionEditLibraryNoteCandidate): void {
    const candidateId = libraryNoteCandidateId(input.noteId);
    const existing = this.libraryNoteCandidates.get(candidateId);
    if (existing) {
      this.libraryNoteCandidates.set(candidateId, {
        ...existing,
        queryTerms: unique([...existing.queryTerms, ...input.queryTerms]),
        goalIds: unique([...existing.goalIds, ...input.goalIds]),
        score: Math.max(existing.score ?? 0, input.score ?? 0),
      });
      const receipt = this.candidates.get(candidateId);
      if (receipt) {
        receipt.queryTerms = unique([...receipt.queryTerms, ...input.queryTerms]);
        receipt.score = Math.max(receipt.score ?? 0, input.score ?? 0);
      }
      return;
    }
    this.libraryNoteCandidates.set(candidateId, copyLibraryNoteCandidate(input));
    this.candidates.set(candidateId, {
      candidateId,
      sourceKind: 'note-library',
      title: input.title,
      locator: `笔记库 / ${input.relativePath}`,
      queryTerms: unique(input.queryTerms),
      retrievalMethod: 'search_note_library（候选仅用于定位）',
      readState: 'candidate',
      ...(input.score === undefined ? {} : { score: input.score }),
      sourceContentHash: input.contentHash,
    });
  }

  libraryNoteCandidate(noteId: string): SelectionEditLibraryNoteCandidate | undefined {
    return this.libraryNoteCandidates.get(libraryNoteCandidateId(noteId));
  }

  recordLibraryBlockCandidate(input: SelectionEditLibraryBlockCandidate): void {
    if (!this.libraryNoteCandidate(input.noteId)) throw new Error('同库块候选必须来自本轮笔记候选。');
    const candidateId = libraryBlockCandidateId(input.noteId, input.blockId);
    const existing = this.libraryBlockCandidates.get(candidateId);
    if (existing) {
      this.libraryBlockCandidates.set(candidateId, {
        ...existing,
        queryTerms: unique([...existing.queryTerms, ...input.queryTerms]),
        goalIds: unique([...existing.goalIds, ...input.goalIds]),
        score: Math.max(existing.score ?? 0, input.score ?? 0),
      });
      const receipt = this.candidates.get(candidateId);
      if (receipt) {
        receipt.queryTerms = unique([...receipt.queryTerms, ...input.queryTerms]);
        receipt.score = Math.max(receipt.score ?? 0, input.score ?? 0);
      }
      return;
    }
    this.libraryBlockCandidates.set(candidateId, copyLibraryBlockCandidate(input));
    this.candidates.set(candidateId, {
      candidateId,
      sourceKind: 'note-library',
      title: input.title,
      locator: `笔记库 / ${input.title} / L${input.lineFrom}-L${input.lineTo}`,
      queryTerms: unique(input.queryTerms),
      retrievalMethod: 'search_library_note_blocks（候选仅用于定位）',
      readState: 'candidate',
      ...(input.score === undefined ? {} : { score: input.score }),
      sourceContentHash: input.contentHash,
    });
  }

  libraryBlockCandidateForRange(noteId: string, lineFrom: number, lineTo: number): SelectionEditLibraryBlockCandidate | undefined {
    return [...this.libraryBlockCandidates.values()].find((candidate) => candidate.noteId === noteId
      && candidate.lineFrom <= lineFrom && candidate.lineTo >= lineTo);
  }

  registerMaterialEvidence(input: {
    documentId: string;
    ordinal: number;
    title: string;
    sourceContentHash: string;
    content: string;
  }): { item: SelectionEvidenceItem; added: boolean } {
    const candidate = this.materialCandidate(input.documentId, input.ordinal);
    if (!candidate) throw new Error('资料深读目标不在本轮检索候选中。');
    const evidenceId = `evidence-${hashText(`${input.documentId}\u0000${input.ordinal}\u0000${input.sourceContentHash}\u0000${input.content}`).slice(0, 24)}`;
    const existing = this.evidence.get(evidenceId);
    if (!existing) this.assertEvidenceCapacity(input.content, evidenceId);
    this.markCandidateRead(`materials:${input.documentId}:${input.ordinal}`, `资料库 / ${input.title} / 父块 ${input.ordinal}`, true);
    if (existing) return { item: existing, added: false };
    const item: SelectionEvidenceItem = {
      evidenceId,
      sourceKind: 'materials',
      title: input.title,
      locator: `资料库 / ${input.title} / 父块 ${input.ordinal}`,
      content: input.content,
      sourceContentHash: input.sourceContentHash,
      textHash: hashText(input.content),
      goalIds: [...candidate.goalIds],
      readVerified: true,
      pageVerified: true,
    };
    this.evidence.set(evidenceId, item);
    return { item, added: true };
  }

  registerWebEvidence(input: {
    url: string;
    title: string;
    verifiedContentHash: string;
    content: string;
  }): { item: SelectionEvidenceItem; added: boolean } {
    const candidate = this.webCandidate(input.url);
    if (!candidate) throw new Error('网页抓取地址不在本轮 web_search 白名单中。');
    const evidenceId = `evidence-web-${hashText(`${input.url}\u0000${input.verifiedContentHash}`).slice(0, 24)}`;
    const candidateId = `web:${hashText(input.url).slice(0, 24)}`;
    const existing = this.evidence.get(evidenceId);
    if (!existing) this.assertEvidenceCapacity(input.content, evidenceId);
    this.markCandidateRead(candidateId, `网页 / ${safeHostname(input.url)}`, true);
    if (existing) return { item: existing, added: false };
    const item: SelectionEvidenceItem = {
      evidenceId,
      sourceKind: 'web',
      title: input.title,
      locator: `网页 / ${safeHostname(input.url)}`,
      content: input.content,
      sourceContentHash: input.verifiedContentHash,
      textHash: hashText(input.content),
      goalIds: [...candidate.goalIds],
      readVerified: true,
      pageVerified: true,
    };
    this.evidence.set(evidenceId, item);
    return { item, added: true };
  }

  registerCurrentNoteEvidence(input: {
    snapshotId: string;
    contentHash: string;
    title: string;
    headingPath: readonly string[];
    lineFrom: number;
    lineTo: number;
    text: string;
    contentOffset?: number;
  }): { item: SelectionEvidenceItem; added: boolean } {
    const candidate = this.currentNoteCandidateForRange(input.snapshotId, input.lineFrom, input.lineTo);
    if (!candidate || candidate.contentHash !== input.contentHash) {
      throw new Error('当前笔记深读目标不属于本轮稳定候选。');
    }
    const evidenceId = `evidence-current-${hashText(`${input.snapshotId}\u0000${input.lineFrom}\u0000${input.lineTo}\u0000${input.contentOffset ?? ''}\u0000${input.text}`).slice(0, 24)}`;
    const candidateId = currentNoteCandidateId(candidate.snapshotId, candidate.blockId);
    const existing = this.evidence.get(evidenceId);
    if (existing) return { item: existing, added: false };
    this.assertEvidenceCapacity(input.text, evidenceId);
    this.markCandidateRead(candidateId, `当前笔记 / L${input.lineFrom}-L${input.lineTo}`, true);
    const item: SelectionEvidenceItem = {
      evidenceId,
      sourceKind: 'current-note',
      title: input.title,
      locator: `当前笔记 / L${input.lineFrom}-L${input.lineTo}${input.contentOffset === undefined ? '' : ` / 起始字符 ${input.contentOffset + 1}`}`,
      headingPath: [...input.headingPath],
      content: input.text,
      sourceContentHash: input.contentHash,
      textHash: hashText(input.text),
      goalIds: [...candidate.goalIds],
      readVerified: true,
      pageVerified: true,
    };
    this.evidence.set(evidenceId, item);
    return { item, added: true };
  }

  registerLibraryEvidence(input: {
    noteId: string;
    snapshotId: string;
    contentHash: string;
    title: string;
    relativePath: string;
    headingPath: readonly string[];
    lineFrom: number;
    lineTo: number;
    text: string;
  }): { item: SelectionEvidenceItem; added: boolean } {
    const noteCandidate = this.libraryNoteCandidate(input.noteId);
    const blockCandidate = this.libraryBlockCandidateForRange(input.noteId, input.lineFrom, input.lineTo);
    if (!noteCandidate || !blockCandidate || noteCandidate.snapshotId !== input.snapshotId
      || blockCandidate.snapshotId !== input.snapshotId || noteCandidate.contentHash !== input.contentHash
      || blockCandidate.contentHash !== input.contentHash) {
      throw new Error('同库深读目标不属于本轮稳定候选。');
    }
    const evidenceId = `evidence-library-${hashText(`${input.noteId}\u0000${input.snapshotId}\u0000${input.lineFrom}\u0000${input.lineTo}\u0000${input.text}`).slice(0, 24)}`;
    const existing = this.evidence.get(evidenceId);
    if (existing) return { item: existing, added: false };
    this.assertEvidenceCapacity(input.text, evidenceId);
    this.markCandidateRead(libraryNoteCandidateId(input.noteId), `笔记库 / ${input.relativePath}`, true);
    this.markCandidateRead(libraryBlockCandidateId(blockCandidate.noteId, blockCandidate.blockId), `笔记库 / ${input.relativePath} / L${input.lineFrom}-L${input.lineTo}`, true);
    const item: SelectionEvidenceItem = {
      evidenceId,
      sourceKind: 'note-library',
      title: input.title,
      locator: `笔记库 / ${input.relativePath} / L${input.lineFrom}-L${input.lineTo}`,
      headingPath: [...input.headingPath],
      content: input.text,
      sourceContentHash: input.contentHash,
      textHash: hashText(input.text),
      goalIds: [...blockCandidate.goalIds],
      readVerified: true,
      pageVerified: true,
    };
    this.evidence.set(evidenceId, item);
    return { item, added: true };
  }

  markCandidateSkipped(candidateId: string, reason: string): void {
    const candidate = this.candidates.get(candidateId);
    if (!candidate || candidate.readState === 'deep-read') return;
    candidate.readState = 'skipped';
    candidate.reason = reason;
  }

  evidenceItems(): SelectionEvidenceItem[] {
    return [...this.evidence.values()];
  }

  receipt(): Pick<SelectionContextReceipt, 'planned' | 'used' | 'skipped' | 'candidates' | 'conflicts'> {
    for (const candidate of this.candidates.values()) {
      if (candidate.readState === 'candidate') {
        candidate.readState = 'skipped';
        candidate.reason = '候选未完成本轮受限深读或网页全文核验，不能作为事实证据。';
      }
    }
    const evidence = this.evidenceItems();
    return {
      planned: [...this.planned],
      used: evidence.map((item) => ({ sourceKind: item.sourceKind, title: item.title, locator: item.locator, characterCount: item.content.length })),
      skipped: [...this.skipped],
      candidates: [...this.candidates.values()].map((item) => ({ ...item, queryTerms: [...item.queryTerms] })),
      conflicts: [],
    };
  }

  private markCandidateRead(candidateId: string, locator: string, pageVerified: boolean): void {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) return;
    candidate.readState = 'deep-read';
    candidate.locator = locator;
    if (candidate.sourceKind === 'web') candidate.pageVerified = pageVerified;
  }

  private assertEvidenceCapacity(content: string, evidenceId: string): void {
    const existing = this.evidence.get(evidenceId);
    if (existing) return;
    if (content.length + this.evidenceCharacters > this.maxEvidenceCharacters) {
      throw new Error('本轮选择编辑的原文证据已达到总量上限。');
    }
  }
}

function currentNoteCandidateId(snapshotId: string, blockId: string): string {
  return `current-note:${snapshotId}:${blockId}`;
}

function libraryNoteCandidateId(noteId: string): string {
  return `note-library:${noteId}`;
}

function libraryBlockCandidateId(noteId: string, blockId: string): string {
  return `note-library:${noteId}:${blockId}`;
}

function copyCurrentNoteCandidate(candidate: SelectionEditCurrentNoteCandidate): SelectionEditCurrentNoteCandidate {
  return { ...candidate, headingPath: [...candidate.headingPath], queryTerms: [...candidate.queryTerms], goalIds: [...candidate.goalIds] };
}

function copyLibraryNoteCandidate(candidate: SelectionEditLibraryNoteCandidate): SelectionEditLibraryNoteCandidate {
  return { ...candidate, queryTerms: [...candidate.queryTerms], goalIds: [...candidate.goalIds] };
}

function copyLibraryBlockCandidate(candidate: SelectionEditLibraryBlockCandidate): SelectionEditLibraryBlockCandidate {
  return { ...candidate, headingPath: [...candidate.headingPath], queryTerms: [...candidate.queryTerms], goalIds: [...candidate.goalIds] };
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '受限地址';
  }
}
