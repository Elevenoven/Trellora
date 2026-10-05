import { isSensitiveProfileContent } from '../userProfileExtractor';
import type { UserProfileContextSnapshot, UserProfileItem } from '../userProfileTypes';

const MAX_PERSONALIZATION_ITEMS = 8;
const MAX_PERSONALIZATION_VALUE_CHARS = 160;
const PERSONALIZATION_CATEGORIES = new Set<UserProfileItem['category']>([
  'communication',
  'professional',
  'expertise',
  'technical-environment',
]);

export interface SelectionEditPersonalizationRuntime {
  snapshot: UserProfileContextSnapshot;
}

export interface SelectionEditPersonalization {
  /** Model-visible data is kept separate from factual evidence and citations. */
  items: Array<{ fieldLabel: string; valueText: string }>;
  receipt: {
    requested: boolean;
    applied: boolean;
    itemCount: number;
    reason?: string;
  };
}

/**
 * Produces a deliberately narrow, untrusted preference channel. It never
 * reads conversation history, long-term memory retrieval, or profile evidence;
 * only active, non-sensitive profile items intended for style/terminology are
 * projected. The caller must still place the output outside Evidence Ledger.
 */
export function collectSelectionEditPersonalization(
  runtime: SelectionEditPersonalizationRuntime | undefined,
): SelectionEditPersonalization {
  if (!runtime) return emptyPersonalization('个性化资料未准备就绪。');
  const { settings } = runtime.snapshot;
  if (!settings.useInQaContext || !settings.allowKnowledgeBase) {
    return emptyPersonalization('个性化资料未在知识库编辑场景中获授权。');
  }
  const items = runtime.snapshot.items
    .filter((item) => item.status === 'active')
    .filter((item) => PERSONALIZATION_CATEGORIES.has(item.category))
    .filter((item) => !isSensitiveProfileContent(`${item.fieldLabel} ${item.valueText}`))
    .sort((first, second) => Number(second.userLocked) - Number(first.userLocked)
      || first.fieldLabel.localeCompare(second.fieldLabel, 'zh-CN')
      || first.itemId.localeCompare(second.itemId))
    .slice(0, MAX_PERSONALIZATION_ITEMS)
    .map((item) => ({
      fieldLabel: normalizePreferenceText(item.fieldLabel),
      valueText: normalizePreferenceText(item.valueText).slice(0, MAX_PERSONALIZATION_VALUE_CHARS),
    }))
    .filter((item) => item.fieldLabel && item.valueText);
  if (items.length === 0) return emptyPersonalization('没有可用于写作风格或术语的非敏感个性化资料。');
  return {
    items,
    receipt: { requested: true, applied: true, itemCount: items.length },
  };
}

function emptyPersonalization(reason: string): SelectionEditPersonalization {
  return {
    items: [],
    receipt: { requested: true, applied: false, itemCount: 0, reason },
  };
}

function normalizePreferenceText(value: string): string {
  return [...value.normalize('NFKC')]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 127 || codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13 ? ' ' : character;
    })
    .join('')
    .trim();
}
