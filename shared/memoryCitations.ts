import type { MemoryKind, MemoryOrigin } from '../electron/knowledge/memory/memoryConstants';

/** Stored with the answer, independently of the live memory item's lifecycle. */
export interface MemoryCitationMetadata {
  itemId: string;
  reference: number;
  topic?: string;
  origin?: MemoryOrigin;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
}

export interface MemoryCitationSnapshot extends Partial<Omit<MemoryCitationMetadata, 'itemId'>> {
  itemId: string;
  kind: MemoryKind;
  contentSnapshot: string;
  usedAt?: string;
}

export interface MemoryCitationSource {
  status: 'available' | 'manual' | 'unavailable';
  userText?: string;
  createdAt?: string;
}

/** Old answers have no registered numbering; never infer it from their array order. */
export function readMemoryCitationMetadata(metadataJson: string | undefined, itemId: string): Partial<MemoryCitationMetadata> {
  try {
    const metadata: unknown = JSON.parse(metadataJson || '{}');
    if (!metadata || typeof metadata !== 'object' || !('memoryCitations' in metadata) || !Array.isArray(metadata.memoryCitations)) return {};
    const entry: unknown = metadata.memoryCitations.find((value: unknown) => value && typeof value === 'object' && 'itemId' in value && value.itemId === itemId);
    if (!entry || typeof entry !== 'object' || !('reference' in entry) || !Number.isSafeInteger(entry.reference) || Number(entry.reference) < 1) return {};
    const optionalText = (key: string) => key in entry && typeof (entry as Record<string, unknown>)[key] === 'string' ? (entry as Record<string, string>)[key] : undefined;
    const origin = optionalText('origin');
    return {
      reference: Number(entry.reference),
      ...(optionalText('topic') ? { topic: optionalText('topic') } : {}),
      ...(origin === 'manual' || origin === 'explicit' || origin === 'extracted' ? { origin } : {}),
      sourceSessionId: optionalText('sourceSessionId') ?? null,
      sourceMessageId: optionalText('sourceMessageId') ?? null,
    };
  } catch {
    return {};
  }
}
