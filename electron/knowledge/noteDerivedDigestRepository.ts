import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AssistantMemoryDatabase } from './assistantMemoryDatabase';
import { AssistantMemoryRepository, type AssistantNoteIdentityInput, type AssistantNoteScope } from './assistantMemoryRepository';

export const SECTION_DIGEST_VERSION = 1;

export interface DigestSourceRef {
  blockId: string;
  lineFrom: number;
  lineTo: number;
  textHash: string;
}

export interface SectionDigestKeyPoint {
  text: string;
  sourceRefs: DigestSourceRef[];
}

/**
 * The JSON stored in assistant_section_digests. It contains derived text and
 * note coordinates only; conversation data deliberately has no representation
 * in this contract.
 */
export interface SectionDigestPayload {
  summary: string;
  keyPoints: SectionDigestKeyPoint[];
}

export interface StoredSectionDigest extends SectionDigestPayload {
  digestId: string;
  noteContentHash: string;
  sectionId: string;
  sectionHash: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  providerFingerprint: string;
  model: string;
  digestVersion: number;
  status: 'complete' | 'partial';
}

export interface NoteDerivedDigestLookup extends AssistantNoteIdentityInput {
  sectionHash: string;
  providerFingerprint: string;
  model: string;
  digestVersion?: number;
}

export interface NoteDerivedDigestWrite extends AssistantNoteIdentityInput {
  sectionId: string;
  sectionHash: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  providerFingerprint: string;
  model: string;
  digestVersion?: number;
  status: 'complete' | 'partial';
  digest: SectionDigestPayload;
}

export class SectionDigestPurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SectionDigestPurityError';
  }
}

/**
 * Guards the only shared assistant-memory data. The caller supplies a
 * deterministic source range, then this guard checks the derived JSON has no
 * route for question, answer, preference, session, turn, or evidence state.
 */
export class SectionDigestPurityGuard {
  assertWrite(input: NoteDerivedDigestWrite): void {
    assertDigestCoordinate(input);
    assertDigestPayload(input.digest, input);
  }

  assertStoredDigest(value: StoredSectionDigest): void {
    assertDigestCoordinate(value);
    assertDigestPayload({ summary: value.summary, keyPoints: value.keyPoints }, value);
  }
}

/**
 * A deliberately independent writer for note-derived cache rows. It never
 * accepts an AssistantSessionScope and therefore cannot join or persist a
 * conversation accidentally.
 */
export class NoteDerivedDigestRepository {
  private readonly purityGuard = new SectionDigestPurityGuard();

  constructor(
    private readonly databaseOwner: AssistantMemoryDatabase,
    private readonly memoryRepository: AssistantMemoryRepository,
    private readonly libraryPath: string,
  ) {}

  findReusable(input: NoteDerivedDigestLookup): StoredSectionDigest | undefined {
    const noteScope = this.memoryRepository.resolveNoteScope(input);
    const row = this.database().prepare(`
      SELECT digest_id, note_content_hash, section_id, section_hash, heading_path_json,
        line_from, line_to, provider_fingerprint, model, digest_version, digest_json, status
      FROM assistant_section_digests
      WHERE note_id = ? AND section_hash = ? AND provider_fingerprint = ? AND model = ?
        AND digest_version = ? AND status = 'complete'
      LIMIT 1
    `).get(noteScope.noteId, input.sectionHash, input.providerFingerprint, input.model, input.digestVersion ?? SECTION_DIGEST_VERSION) as DigestRow | undefined;
    return row ? this.toStoredDigest(row) : undefined;
  }

  save(input: NoteDerivedDigestWrite): StoredSectionDigest {
    this.purityGuard.assertWrite(input);
    const noteScope = this.memoryRepository.resolveNoteScope(input);
    const digestVersion = input.digestVersion ?? SECTION_DIGEST_VERSION;
    const createdAt = new Date().toISOString();
    const database = this.database();
    database.transaction(() => {
      // A modified range receives a new hash. Mark prior versions of this
      // deterministic section stale without invalidating unchanged sections.
      database.prepare(`
        UPDATE assistant_section_digests
        SET status = 'stale'
        WHERE note_id = ? AND section_id = ? AND section_hash <> ? AND status <> 'stale'
      `).run(noteScope.noteId, input.sectionId, input.sectionHash);
      database.prepare(`
        INSERT INTO assistant_section_digests (
          digest_id, note_id, note_content_hash, section_id, section_hash,
          heading_path_json, line_from, line_to, provider_fingerprint, model,
          digest_version, scope, digest_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'note-derived', ?, ?, ?)
        ON CONFLICT(note_id, section_hash, provider_fingerprint, model, digest_version) DO UPDATE SET
          note_content_hash = excluded.note_content_hash,
          section_id = excluded.section_id,
          heading_path_json = excluded.heading_path_json,
          line_from = excluded.line_from,
          line_to = excluded.line_to,
          digest_json = excluded.digest_json,
          status = excluded.status,
          created_at = excluded.created_at
      `).run(
        `assistant-digest-${randomUUID()}`,
        noteScope.noteId,
        input.contentHash,
        input.sectionId,
        input.sectionHash,
        JSON.stringify(input.headingPath),
        input.lineFrom,
        input.lineTo,
        input.providerFingerprint,
        input.model,
        digestVersion,
        JSON.stringify(input.digest),
        input.status,
        createdAt,
      );
    })();
    return {
      digestId: this.getDigestId(noteScope, input.sectionHash, input.providerFingerprint, input.model, digestVersion),
      noteContentHash: input.contentHash,
      sectionId: input.sectionId,
      sectionHash: input.sectionHash,
      headingPath: [...input.headingPath],
      lineFrom: input.lineFrom,
      lineTo: input.lineTo,
      providerFingerprint: input.providerFingerprint,
      model: input.model,
      digestVersion,
      status: input.status,
      ...cloneDigestPayload(input.digest),
    };
  }

  deleteForNote(input: AssistantNoteIdentityInput): number {
    const noteScope = this.memoryRepository.resolveNoteScope(input);
    return this.database().prepare('DELETE FROM assistant_section_digests WHERE note_id = ?').run(noteScope.noteId).changes;
  }

  private getDigestId(noteScope: AssistantNoteScope, sectionHash: string, providerFingerprint: string, model: string, digestVersion: number): string {
    const row = this.database().prepare(`
      SELECT digest_id FROM assistant_section_digests
      WHERE note_id = ? AND section_hash = ? AND provider_fingerprint = ? AND model = ? AND digest_version = ?
    `).get(noteScope.noteId, sectionHash, providerFingerprint, model, digestVersion) as { digest_id: string } | undefined;
    if (!row) throw new Error('章节摘要写入后无法读取。');
    return row.digest_id;
  }

  private toStoredDigest(row: DigestRow): StoredSectionDigest {
    const parsed = parseDigestPayload(row.digest_json);
    const result: StoredSectionDigest = {
      digestId: row.digest_id,
      noteContentHash: row.note_content_hash,
      sectionId: row.section_id,
      sectionHash: row.section_hash,
      headingPath: parseHeadingPath(row.heading_path_json),
      lineFrom: row.line_from,
      lineTo: row.line_to,
      providerFingerprint: row.provider_fingerprint,
      model: row.model,
      digestVersion: row.digest_version,
      status: row.status === 'partial' ? 'partial' : 'complete',
      ...parsed,
    };
    this.purityGuard.assertStoredDigest(result);
    return result;
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.libraryPath);
  }
}

interface DigestRow {
  digest_id: string;
  note_content_hash: string;
  section_id: string;
  section_hash: string;
  heading_path_json: string;
  line_from: number;
  line_to: number;
  provider_fingerprint: string;
  model: string;
  digest_version: number;
  digest_json: string;
  status: 'complete' | 'partial' | 'stale';
}

function assertDigestCoordinate(input: {
  sectionId: string;
  sectionHash: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  providerFingerprint: string;
  model: string;
  digestVersion?: number;
}): void {
  if (!input.sectionId.trim() || !isHash(input.sectionHash) || !Array.isArray(input.headingPath)
    || input.headingPath.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 300)
    || !Number.isInteger(input.lineFrom) || !Number.isInteger(input.lineTo) || input.lineFrom < 1 || input.lineTo < input.lineFrom
    || !input.providerFingerprint.trim() || !input.model.trim() || (input.digestVersion !== undefined && (!Number.isInteger(input.digestVersion) || input.digestVersion < 1))) {
    throw new SectionDigestPurityError('章节摘要坐标无效，已拒绝写入共享缓存。');
  }
}

function assertDigestPayload(payload: SectionDigestPayload, coordinate: { lineFrom: number; lineTo: number }): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some((key) => key !== 'summary' && key !== 'keyPoints')
    || typeof payload.summary !== 'string' || !payload.summary.trim() || payload.summary.length > 4_000
    || !Array.isArray(payload.keyPoints) || payload.keyPoints.length > 24) {
    throw new SectionDigestPurityError('章节摘要内容不符合纯笔记缓存格式。');
  }
  for (const keyPoint of payload.keyPoints) {
    if (!keyPoint || typeof keyPoint !== 'object' || Array.isArray(keyPoint)
      || Object.keys(keyPoint).some((key) => key !== 'text' && key !== 'sourceRefs')
      || typeof keyPoint.text !== 'string' || !keyPoint.text.trim() || keyPoint.text.length > 800
      || !Array.isArray(keyPoint.sourceRefs) || keyPoint.sourceRefs.length < 1 || keyPoint.sourceRefs.length > 8) {
      throw new SectionDigestPurityError('章节摘要关键观点格式无效。');
    }
    for (const sourceRef of keyPoint.sourceRefs) {
      if (!sourceRef || typeof sourceRef !== 'object' || Array.isArray(sourceRef)
        || Object.keys(sourceRef).some((key) => key !== 'blockId' && key !== 'lineFrom' && key !== 'lineTo' && key !== 'textHash')
        || typeof sourceRef.blockId !== 'string' || !sourceRef.blockId.startsWith('section-')
        || !Number.isInteger(sourceRef.lineFrom) || !Number.isInteger(sourceRef.lineTo)
        || sourceRef.lineFrom < coordinate.lineFrom || sourceRef.lineTo > coordinate.lineTo || sourceRef.lineTo < sourceRef.lineFrom
        || !isHash(sourceRef.textHash)) {
        throw new SectionDigestPurityError('章节摘要来源定位无效。');
      }
    }
  }
  assertNoConversationFields(payload);
}

function assertNoConversationFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/question|answer|preference|rolling|session|turn|evidence/iu.test(key)) {
      throw new SectionDigestPurityError('章节摘要不得包含会话、问题、回答或证据标识。');
    }
    if (typeof entry === 'string' && /(?:assistant[-_](?:session|turn|evidence)|sessionId|turnId|evidenceId)/iu.test(entry)) {
      throw new SectionDigestPurityError('章节摘要不得包含会话或证据标识。');
    }
    if (Array.isArray(entry)) entry.forEach(assertNoConversationFields);
    else if (entry && typeof entry === 'object') assertNoConversationFields(entry);
  }
}

function parseDigestPayload(value: string): SectionDigestPayload {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
    return parsed as SectionDigestPayload;
  } catch {
    throw new SectionDigestPurityError('章节摘要缓存数据损坏。');
  }
}

function parseHeadingPath(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) throw new Error('not-array');
    return parsed;
  } catch {
    throw new SectionDigestPurityError('章节摘要标题路径损坏。');
  }
}

function cloneDigestPayload(value: SectionDigestPayload): SectionDigestPayload {
  return {
    summary: value.summary.trim(),
    keyPoints: value.keyPoints.map((point) => ({
      text: point.text.trim(),
      sourceRefs: point.sourceRefs.map((ref) => ({ ...ref })),
    })),
  };
}

export function createSectionDigestSourceRef(input: { sectionId: string; lineFrom: number; lineTo: number; text: string }): DigestSourceRef {
  return {
    blockId: `section-${input.sectionId}`,
    lineFrom: input.lineFrom,
    lineTo: input.lineTo,
    textHash: sha256(input.text),
  };
}

function isHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
